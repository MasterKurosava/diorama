import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { ease, entering, inView, noise } from '@dioramajs/effects/kit'
import {
  atan,
  clamp,
  floor,
  max,
  min,
  mix,
  PI,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node, Texture } from 'three/webgpu'

type V2 = Node<'vec2'>
type F = Node<'float'>
type Params = {
  style: ChoiceParam<'wipe' | 'fade' | 'blinds' | 'iris'>
  trigger: ChoiceParam<'view' | 'scroll'>
  direction: ChoiceParam<'up' | 'down' | 'left' | 'right'>
  duration: number
  delay: number
  threshold: number
  zoom: number
  softness: number
  seed: number
}

/** Bands of `blinds`: one per this many px across the wipe, at least 3. */
const BAND = 160
/** How far `fade` drifts in along the direction, px. */
const DRIFT = 40

/**
 * The image wipes in with a noisy edge (or fades, opens in bands or from the centre) and settles
 * from a slight zoom as it enters the viewport.
 */
const reveal: Effect<Params> = defineEffect({
  name: 'reveal',
  params: {
    style: oneOf('wipe', 'fade', 'blinds', 'iris'),
    trigger: oneOf('view', 'scroll'),
    direction: oneOf('up', 'down', 'left', 'right'),
    duration: 1.2,
    delay: 0,
    threshold: 0.2,
    zoom: 1.12,
    softness: 0.12,
    seed: 1,
  },
  rebuild: ['seed'],
  media: true,
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { surface, u, params, element, app, signal } = ctx
    const { stage } = app
    // 0 hidden, 1 shown: the eased reveal, written on the CPU.
    const amount = uniform(0)
    const { direction, style } = params
    const vertical = direction === 'up' || direction === 'down'
    // How far a point lies along the wipe (0 where it starts) and across it.
    const along = (at: V2) => {
      const coord = vertical ? at.y : at.x
      return direction === 'up' || direction === 'right' ? coord : coord.oneMinus()
    }
    const across = (at: V2) => (vertical ? at.x : at.y)
    const travel = vertical
      ? vec2(0, direction === 'up' ? 1 : -1)
      : vec2(direction === 'right' ? 1 : -1, 0)
    // Leaving closes the wipe again, entering opens it.
    const opened = min(amount, smoothstep(0, 1, u.presence))
    const edge = max(u.softness, 1e-3)
    const size = u.size as unknown as V2
    // The uneven rim of the wipe and the iris: a noise tile read along the edge. Its second
    // coordinate follows the reveal, so the rim changes shape as the edge moves.
    const grain = style === 'wipe' || style === 'iris' ? noise(ctx, { seed: params.seed }) : null
    const rim = (at: F): F =>
      texture(grain as Texture, vec2(at, opened.mul(0.3)))
        .r.sub(0.5)
        .mul(edge)
    // An edge of `edge` sweeping `at` from before 0 to past 1 as `progress` goes 0 to 1, moved
    // by `offset`; 0 and 1 are exact.
    const sweep = (at: F, progress: F, offset: F | number) => {
      const reach = mix(edge.mul(-0.5), edge.mul(1.5).add(1), progress)
      return smoothstep(0, edge.mul(0.4), reach.sub(at).add(offset))
    }
    // 1 where the image shows.
    const shown = (at: V2): F => {
      if (style === 'fade') return opened
      if (style === 'blinds') {
        // Each band opens along the wipe, half a reveal after the one before it.
        const count = max(floor((vertical ? size.x : size.y).div(BAND)), 3)
        const band = clamp(floor(across(at).mul(count)), 0, count.sub(1))
        const bandProgress = clamp(opened.mul(1.5).sub(band.div(count.sub(1)).mul(0.5)), 0, 1)
        return sweep(along(at), bandProgress, 0)
      }
      if (style === 'iris') {
        // A circle from the centre to the corners, its rim uneven around it.
        const fromCentre = at.sub(0.5).mul(size)
        const radius = fromCentre.length().div(size.length().mul(0.5).max(1))
        const angle = atan(fromCentre.y, fromCentre.x).div(PI.mul(2))
        return sweep(radius, opened, rim(angle))
      }
      return sweep(along(at), opened, rim(across(at)))
    }
    // Below 1 is no zoom, like 1, so 0 turns it off.
    const zoom = max(u.zoom, 1)
    surface.uv((uv) => {
      const zoomed = uv
        .sub(0.5)
        .div(mix(zoom, 1, opened))
        .add(0.5)
      if (style !== 'wipe' && style !== 'blinds') return zoomed
      // Inside the band the picture trails the wipe by up to 2% of the box.
      return zoomed.sub(travel.mul(shown(uv).oneMinus().mul(0.02)))
    })
    // The fade drifts the whole copy in along the direction, settling in place.
    if (style === 'fade') {
      surface.position((p) => {
        const drift = travel.mul(opened.oneMinus().mul(DRIFT)).div(size.max(1))
        return p.sub(vec3(drift, 0))
      })
    }
    surface.color((color, { box }) => vec4(color.rgb, color.a.mul(shown(box))))

    const onScreen = (): boolean => {
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < stage.height.peek() &&
        rect.left < stage.width.peek()
      )
    }
    // Whatever was on screen before the copy took over has been seen as DOM: it stays shown
    // instead of vanishing and wiping in again. Until the instance runs, that includes an image
    // scrolled into view while the engine compiles.
    let seen = onScreen()
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })
    amount.value = seen ? 1 : 0

    // `trigger: 'scroll'`, scrubbed from `threshold` of the box in view to the box centred in
    // the viewport.
    const scrub = (input: EffectInput): void => {
      const viewportHeight = stage.height.peek()
      const progress = entering(input.progress, input.height, viewportHeight, params.threshold)
      // The first screen stays shown until scrolling would have shown it anyway.
      if (seen && progress < 1) return
      seen = false
      amount.value = progress
    }

    // `trigger: 'view'`, played once `threshold` of the box is in view. -1 until it starts.
    let elapsed = -1
    let playing = false
    const play = (input: EffectInput): void => {
      if (seen || amount.value === 1) return
      if (elapsed < 0) {
        // Counted above the bottom tenth of the viewport: an image peeking in at the edge has
        // not been looked at yet.
        if (!inView(input.y, input.height, stage.height.peek(), params.threshold)) return
        elapsed = 0
        playing = true
      } else elapsed += input.delta
      const progress = (elapsed - params.delay) / Math.max(params.duration, 1e-3)
      amount.value = ease('expoOut', progress)
      if (progress >= 1) {
        amount.value = 1
        playing = false
      }
    }

    return (input): boolean => {
      if (params.trigger === 'scroll') scrub(input)
      else {
        if (seen) amount.value = 1
        play(input)
      }
      return playing
    }
  },
})
export default reveal
