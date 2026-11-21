import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import {
  clamp,
  exp,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import { DataTexture, type Node, type Texture } from 'three/webgpu'
import { BASE, type Base, color, type F, screen, show, tint, type V2 } from './screen'

type Params = Base & {
  style: ChoiceParam<'panel' | 'strips'>
  direction: ChoiceParam<'up' | 'down' | 'left' | 'right'>
  count: number
  color: ColorParam
  accent: string
  image: string
  curve: number
  shade: number
}

/** The last strip starts this share of a half after the first. */
const STAGGER = 0.45
/** The accent panel leads the curtain in, and trails it out, by this share of a half. */
const LEAD = 0.22
/** Bow of the moving edge at `curve` 1, a share of the way. */
const BOW = 0.14
/** Reach of the shadow the moving edge casts on the page, CSS px. */
const SHADOW = 36
/** Darkness of the shadow at `shade` 1. */
const SHADOW_DARKNESS = 0.35
/** Edges travel this many px past both ends of the way, so no sliver shows at rest. */
const OVERSHOOT = 2

/**
 * A curtain sweeps over the old page and on, off the new one: one panel or strips one after
 * another, an optional accent panel ahead of it, a colour or a picture, its edge bowing as it
 * moves and casting a soft shadow.
 */
const curtain: Effect<Params> = defineEffect({
  name: 'cover-curtain',
  params: {
    ...BASE,
    style: oneOf('panel', 'strips'),
    direction: oneOf('up', 'down', 'left', 'right'),
    count: 5,
    color: color('#0e0e10'),
    accent: '',
    image: '',
    curve: 0.4,
    shade: 0.4,
  },
  presence: 'custom',
  async setup(ctx: EffectContext<Params>) {
    const { u, params, app, signal } = ctx
    const view = screen(ctx)
    const { uv, size } = view
    const { direction } = params
    const vertical = direction === 'up' || direction === 'down'
    // Along the way (0 where the curtain comes in) and across it, viewport UV.
    const along = (
      direction === 'up'
        ? uv.y.oneMinus()
        : direction === 'down'
          ? uv.y
          : direction === 'left'
            ? uv.x.oneMinus()
            : uv.x
    ) as F
    const across = (vertical ? uv.x : uv.y) as F
    const travel = vec2(
      direction === 'left' ? -1 : direction === 'right' ? 1 : 0,
      direction === 'up' ? -1 : direction === 'down' ? 1 : 0,
    )
    const way = (vertical ? size.y : size.x) as F

    const strips = params.style === 'strips'
    const count = max(floor(u.count), 1)
    const lane = strips ? fract(across.mul(count)) : across
    const lag = strips
      ? (clamp(floor(across.mul(count)), 0, count.sub(1))
          .div(max(count.sub(1), 1))
          .mul(STAGGER) as F)
      : float(0)
    const accent = tint(params.accent)
    if (params.accent.trim() && !accent)
      app.log.warn(`cover curtain: accent "${params.accent}" is not a colour`)
    const lead = accent ? LEAD : 0
    const span = 1 + (strips ? STAGGER : 0) + lead
    const position = u.position as F
    const closing = clamp(position, 0, 1)
    const opening = clamp(position.sub(1), 0, 1)
    // A panel's place, 0..2 like `position`, from its delays in and out.
    const place = (inLag: F | number, outLag: F | number): F =>
      smoothstep(0, 1, clamp(closing.mul(span).sub(lag).sub(inLag), 0, 1)).add(
        smoothstep(0, 1, clamp(opening.mul(span).sub(lag).sub(outLag), 0, 1)),
      ) as F
    // A panel's edges bow while they move, most in the middle of the lane.
    const bump = lane.mul(lane.oneMinus()).mul(4)
    // Narrow strips bow less, or they read as tongues.
    const bow = clamp(u.curve, 0, 1)
      .mul(strips ? BOW / 3 : BOW)
      .mul(bump)
    const past = float(OVERSHOOT).div(max(way, 1))
    const reach = (at: F): F => at.mul(past.mul(2).add(1)).sub(past) as F
    // Signed distance to a panel at place `at`, px, positive on it.
    const panel = (at: F): F => {
      const head = reach(at).add(bow.mul(sin(clamp(at, 0, 1).mul(Math.PI))))
      const tail = reach(at.sub(1) as F).add(bow.mul(sin(clamp(at.sub(1), 0, 1).mul(Math.PI))))
      return min(head.sub(along), along.sub(tail)).mul(way) as F
    }
    const main = place(lead, 0)
    const mainDistance = panel(main)
    const mainAlpha = clamp(mainDistance.add(0.5), 0, 1)

    // The picture rides with the curtain, cropped to fill the viewport.
    let cloth: Node<'vec3'> = u.color.rgb
    const url = params.image.trim()
    if (url) {
      const blank = new DataTexture(new Uint8Array(4), 1, 1)
      blank.needsUpdate = true
      ctx.onDispose(() => blank.dispose())
      const map = texture(blank as Texture)
      const loaded = uniform(0)
      const ratio = uniform(1)
      // Viewport aspect over picture aspect: the share of the picture each axis shows.
      const fill = size.x.div(size.y).div(ratio)
      const at = uv.sub(travel.mul(main.sub(1)))
      const fit = vec2(at.x, at.y.oneMinus())
        .sub(0.5)
        .mul(vec2(min(fill, 1), min(fill.reciprocal(), 1)))
        .add(0.5)
      cloth = mix(cloth, map.sample(fit as V2).rgb, loaded) as Node<'vec3'>
      ctx.texture(url).then(
        (picture) => {
          if (signal.aborted) return
          const image = picture.image as { width?: number; height?: number } | undefined
          ratio.value = (image?.width ?? 1) / (image?.height || 1)
          map.value = picture
          loaded.value = 1
          ctx.invalidate()
        },
        () => app.log.warn(`cover curtain: could not load "${url}", the curtain is its colour`),
      )
    }

    let rgb: Node<'vec3'> = cloth
    let alpha: F = mainAlpha
    // The outermost panel moves first and last: its edge casts the shadow.
    let front = mainDistance
    let moving = main
    if (accent) {
      const second = place(0, lead)
      const accentDistance = panel(second)
      const accentAlpha = clamp(accentDistance.add(0.5), 0, 1)
      rgb = mix(uniform(accent), cloth, mainAlpha) as Node<'vec3'>
      alpha = max(mainAlpha, accentAlpha) as F
      front = max(mainDistance, accentDistance) as F
      moving = second
    }
    const motion = sin(clamp(moving, 0, 1).mul(Math.PI)).add(
      sin(clamp(moving.sub(1), 0, 1).mul(Math.PI)),
    )
    const shadow = exp(max(front.negate(), 0).div(-SHADOW))
      .mul(clamp(u.shade, 0, 1).mul(SHADOW_DARKNESS))
      .mul(motion)
      .mul(alpha.oneMinus())
    const out = alpha.add(shadow)
    return show(ctx, view, vec4(rgb.mul(alpha).div(max(out, 1e-4)), clamp(out, 0, 1)))
  },
})
export default curtain
