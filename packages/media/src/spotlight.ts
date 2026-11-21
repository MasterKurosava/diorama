import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { approach, chase, ease, follow, spiralBlur } from '@dioramajs/effects/kit'
import { length, max, mix, smoothstep, uniform, vec4 } from 'three/tsl'
import { type Node, Vector4 } from 'three/webgpu'
import { framing } from './slots'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V4 = Node<'vec4'>
type Params = {
  style: ChoiceParam<'light' | 'reveal' | 'blur'>
  radius: number
  softness: number
  dim: number
  color: ColorParam
  blur: number
  rest: number
  ease: number
  duration: number
  src: string
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Share of the radius the light opens from when it comes on. */
const OPEN = 0.7
/** Taps of the blur outside the light, on a golden-angle spiral. */
const TAPS = 16
/** The light stops following once it is this close to the pointer, px. */
const NEAR = 0.05

/**
 * A flashlight over a photo: the image darkens, blurs or turns into a second picture everywhere
 * except a soft circle at the pointer, which follows a finger while it is pressed.
 */
const spotlight: Effect<Params> = defineEffect({
  name: 'spotlight',
  params: {
    style: oneOf('light', 'reveal', 'blur'),
    radius: 140,
    softness: 0.5,
    dim: 0.8,
    color: color('#000000'),
    blur: 12,
    rest: 0,
    ease: 0.08,
    duration: 0.3,
    src: '',
  },
  media: true,
  quality: { low: { blur: 8 } },
  setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u } = ctx
    const el = ctx.element as HTMLElement
    const style = params.style
    // reveal: the second picture, the element's own until it comes in, so no recompile.
    const under = style === 'reveal' ? ctx.fit(ctx.map, framing(el)) : undefined
    if (under) {
      const url = params.src.trim()
      if (!url) app.log.warn('spotlight: style reveal needs data-dio-src, a second image', el)
      else {
        ctx.texture(url).then(
          (texture) => {
            if (signal.aborted) return
            under.set(texture, framing(el))
            ctx.invalidate()
          },
          () => app.log.warn(`spotlight: could not load "${url}"`, el),
        )
      }
    }
    // (light centre px with y up, how far it is on 0..1, how dark the rest is 0..1).
    const look = uniform(new Vector4())
    const lookNode = look as unknown as V4
    const on = lookNode.z
    ctx.surface.color((color, { uv, sample }) => {
      const point = uv.mul(u.size)
      const distance = length(point.sub(lookNode.xy)) as unknown as F
      // The light opens from OPEN of its radius as it comes on.
      const radius = u.radius.mul(on.mul(1 - OPEN).add(OPEN))
      const inner = radius.mul(u.softness.clamp(0, 1).oneMinus())
      const lit = smoothstep(inner, max(radius, inner.add(1e-3)), distance)
        .oneMinus()
        .mul(on) as unknown as F
      const shade = lookNode.w.mul(lit.oneMinus()) as unknown as F
      let rgb = color.rgb
      if (style === 'blur') {
        // Only the difference from the picture is added, so effects before it still show.
        const blurred = spiralBlur(sample, uv, u.blur.div(u.size) as unknown as V2, TAPS)
        const soft = blurred.rgb.sub(sample(uv).rgb)
        rgb = rgb.add(soft.mul(shade))
      }
      rgb = mix(rgb, u.color.rgb, u.dim.clamp(0, 1).mul(shade))
      if (under) {
        const below = under.sample(uv)
        const belowAlpha = below.a.mul(under.mask(uv))
        return vec4(mix(rgb, below.rgb, lit), mix(color.a, belowAlpha, lit))
      }
      return vec4(rgb, color.a)
    })

    const at = { x: 0, y: 0 }
    let snap = true
    let active = 0
    // Touch: the light follows the finger while it is pressed, and goes when it lifts.
    const pointer = follow(ctx, {
      enter() {
        snap = true
      },
    })

    return (input): boolean => {
      const dt = input.delta
      const still = input.reducedMotion
      // A page transition takes the copy as it is, without the light.
      const wanted = pointer.over && input.presence >= 1
      const jump = snap || still || dt <= 0 || active <= 0
      snap = false
      const following = chase(at, pointer.box(input), jump ? 0 : params.ease, dt, NEAR)
      const goal = wanted ? 1 : 0
      const span = Math.max(params.duration, 1e-3)
      active = still || input.presence < 1 ? goal : approach(active, goal, dt / span)
      const eased = still ? active : ease('cubicInOut', active)
      const rest = Math.min(1, Math.max(0, params.rest))
      ;(look.value as Vector4).set(at.x, at.y, eased, rest + (1 - rest) * eased)
      return following || active !== goal
    }
  },
})
export default spotlight
