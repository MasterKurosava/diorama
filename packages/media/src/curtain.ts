import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { between, damp, ease, noise } from '@dioramajs/effects/kit'
import {
  abs,
  clamp,
  cos,
  floor,
  fract,
  hash,
  max,
  min,
  mix,
  PI,
  sign,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { framing } from './slots'

type F = Node<'float'>
type V2 = Node<'vec2'>
type Params = {
  style: ChoiceParam<'strips' | 'split' | 'liquid'>
  by: ChoiceParam<'view' | 'pin' | 'manual'>
  direction: ChoiceParam<'auto' | 'up' | 'down' | 'left' | 'right'>
  position: number
  start: number
  end: number
  out: number
  count: number
  color: ColorParam
  src: string
  zoom: number
  shade: number
  ease: number
  seed: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** How far past the box the edge starts and ends, box units: room for its shadow. */
const PAST = 0.1
/** Width of the shadow the curtain casts on the picture, box units. */
const SHADOW = 0.07
/** Strips open one after another: the last starts this share of the way after the first. */
const STAGGER = 0.6
/** Height of the liquid edge's waves at mid-way, box units. */
const WAVE = 0.06

/** The opening of each element's curtain, 0 shut to 1 open. */
const openings = new WeakMap<Element, { value: number }>()
/** How far an element's curtain is open, for tests. */
export const openingOf = (el: Element): number | undefined => openings.get(el)?.value

const unit = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * A cover picture behind a curtain that opens with scroll, both ways: strips that slide away one
 * after another, two halves that part from the centre, or a liquid edge that drains past it. The
 * curtain is a colour or a second picture, and casts a soft shadow on the picture as it goes.
 */
const curtain: Effect<Params> = defineEffect({
  name: 'curtain',
  params: {
    style: oneOf('strips', 'split', 'liquid'),
    by: oneOf('view', 'pin', 'manual'),
    direction: oneOf('auto', 'up', 'down', 'left', 'right'),
    position: 0,
    start: 0.15,
    end: 0.85,
    out: 1,
    count: 5,
    color: color('#0b0b0c'),
    src: '',
    zoom: 1.1,
    shade: 0.5,
    ease: 0,
    seed: 1,
  },
  rebuild: ['seed'],
  media: true,
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { surface, u, params, app, signal } = ctx
    const el = ctx.element as HTMLElement
    const style = params.style
    // auto: a stage curtain parts sideways, the others lift.
    const direction =
      params.direction === 'auto' ? (style === 'split' ? 'left' : 'up') : params.direction
    const vertical = direction === 'up' || direction === 'down'
    // 0 closed, 1 open: the eased opening, written on the CPU.
    const opening = uniform(0)
    openings.set(el, opening as unknown as { value: number })
    // Leaving a page closes the curtain again, entering opens it up to where scroll has it.
    const opened = min(opening, smoothstep(0, 1, u.presence))
    const size = u.size as unknown as V2
    // 0 where the edge starts, 1 where it ends, and the other axis.
    const alongOf = (at: V2): F => {
      const coord = vertical ? at.y : at.x
      return (direction === 'up' || direction === 'right' ? coord : coord.oneMinus()) as F
    }
    const acrossOf = (at: V2): F => (vertical ? at.x : at.y) as F
    // Box UV per unit of travel along the edge's way.
    const travel = vertical
      ? vec2(0, direction === 'up' ? 1 : -1)
      : vec2(direction === 'right' ? 1 : -1, 0)
    const count = max(floor(u.count), 1)
    // The edge from before 0 to past 1 as `progress` goes from 0 to 1.
    const reach = (progress: F): F => mix(-PAST, 1 + PAST, progress) as F
    // Half a pixel either side of the edge, box units along it.
    const soft = max(size.y, size.x).max(1).reciprocal().mul(1.5) as F
    const grain = style === 'liquid' ? noise(ctx, { seed: params.seed }) : undefined

    /**
     * The curtain at box UV: signed distance to its edge (positive on the curtain, box units),
     * where the curtain's own content comes from, a shading factor for it and how much light it
     * catches: shade that only darkened would not show on a dark curtain.
     */
    const shape = (at: V2): { d: F; from: V2; tone: F; lift: F } => {
      if (style === 'split') {
        // Halves part from the seam across the way: left and right open sideways.
        const coord = vertical ? at.y : at.x
        const side = sign(coord.sub(0.5))
        const fromSeam = abs(coord.sub(0.5)).mul(2) as F
        const edge = reach(opened)
        const dist = fromSeam.sub(edge).mul(0.5) as F
        // Each half carries its content outward, gathering in folds as it shrinks.
        const moved = edge.add(PAST).mul(0.5).mul(side)
        const from = (vertical ? at.sub(vec2(0, moved)) : at.sub(vec2(moved, 0))) as V2
        const local = clamp(fromSeam.sub(edge).div(max(edge.oneMinus(), 1e-3)), 0, 1)
        const folds = cos(local.mul(count).mul(Math.PI * 2))
          .mul(0.5)
          .add(0.5)
        const tone = folds.mul(u.shade).mul(0.3).oneMinus() as F
        // Light on the crests of the folds and on the leading edge of each half.
        const crest = folds.oneMinus().pow(3).mul(0.1)
        const rim = smoothstep(0.012, 0, dist).mul(0.14)
        return { d: dist, from, tone, lift: crest.add(rim).mul(u.shade) as F }
      }
      const alongEdge = alongOf(at)
      const across = acrossOf(at)
      if (style === 'liquid') {
        // A wavy edge, flat when shut and when open, its waves moving as it goes.
        const lift = sin(opened.mul(Math.PI)).mul(WAVE)
        const ripple = texture(
          grain as never,
          vec2(across.mul(count).mul(0.2), opened.mul(0.6)),
        ).r.sub(0.5)
        const wave = sin(across.mul(count).mul(PI).add(opened.mul(5)))
          .mul(0.4)
          .add(ripple.mul(1.2))
        const edge = reach(opened).add(lift.mul(wave))
        // A light rim on the curtain side of the edge.
        const dist = alongEdge.sub(edge) as F
        const rim = smoothstep(0, 0.025, dist).oneMinus().mul(u.shade).mul(0.25)
        return { d: dist, from: at, tone: rim.add(1) as F, lift: rim.mul(0.6) as F }
      }
      // Strips across the way, each sliding off with its content a little after the one before.
      const strip = clamp(floor(across.mul(count)), 0, count.sub(1))
      const lag = strip.div(max(count.sub(1), 1)).mul(STAGGER)
      const progress = clamp(opened.mul(1 + STAGGER).sub(lag), 0, 1) as F
      const edge = reach(ease3(progress))
      const from = at.sub(travel.mul(edge.add(PAST))) as V2
      const dist = alongEdge.sub(edge) as F
      // Panels rather than one block: each strip a shade apart, a dark seam between them and
      // light on the edge that leads.
      const inStrip = fract(across.mul(count))
      const seam = smoothstep(0, soft.mul(2.5).mul(count), min(inStrip, inStrip.oneMinus()))
      const tone = mix(0.55, 1, seam).sub(hash(strip.add(params.seed * 17)).mul(0.08)) as F
      const rim = smoothstep(0.014, 0, dist).mul(0.16)
      const sheen = hash(strip.add(params.seed * 31)).mul(0.03)
      return { d: dist, from, tone, lift: rim.add(sheen).mul(u.shade).mul(seam) as F }
    }

    // The second picture, the element's own until it comes in, so no recompile.
    const url = params.src.trim()
    const cover = url ? ctx.fit(ctx.map, framing(el)) : undefined
    const loaded = uniform(0)
    if (cover) {
      ctx.texture(url).then(
        (picture) => {
          if (signal.aborted) return
          cover.set(picture, framing(el))
          loaded.value = 1
          ctx.invalidate()
        },
        () => app.log.warn(`curtain: could not load "${url}", the curtain is its color`, el),
      )
    }

    // Below 1 is no zoom, like 1, so 0 turns it off.
    const zoom = max(u.zoom, 1)
    surface.uv((uv) =>
      uv
        .sub(0.5)
        .div(mix(zoom, 1, opened))
        .add(0.5),
    )
    surface.color((color, { box, radius }) => {
      const { d: dist, from, tone, lift } = shape(box)
      const on = smoothstep(soft.negate(), soft, dist)
      // The shadow falls on the picture just past the edge, and goes with the curtain.
      const shadow = smoothstep(0, SHADOW, dist.negate()).oneMinus().mul(u.shade).mul(0.45)
      const picture = color.rgb.mul(shadow.oneMinus())
      let cloth = u.color.rgb
      if (cover) {
        const shown = cover.sample(clamp(from, 0, 1) as V2)
        cloth = mix(cloth, shown.rgb, loaded.mul(shown.a).mul(cover.mask(from)))
      }
      const shaded = mix(cloth.mul(tone), vec3(1), lift.clamp(0, 1))
      const rgb = mix(picture, shaded, on)
      return vec4(rgb, mix(color.a, radius, on))
    })

    const by = params.by
    // The opening shown; -1 before the first frame, which jumps to its goal.
    let shown = -1
    return (input): boolean => {
      let scrolled = 0
      if (by !== 'manual') {
        // view: 0 as the top enters at the bottom, 1 once the box is centred in the viewport.
        const viewportHeight = app.stage.height.peek()
        const progress =
          by === 'pin'
            ? ctx.section().pin
            : unit((viewportHeight - input.y) / ((viewportHeight + input.height) / 2 || 1))
        scrolled = Math.min(
          between(progress, params.start, params.end),
          1 - (params.out < 1 ? between(progress, params.out, 1) : 0),
        )
      }
      const goal = Math.max(unit(params.position), ease('cubicInOut', scrolled))
      shown = shown < 0 ? goal : damp(shown, goal, params.ease, input.delta, 1e-4)
      opening.value = shown
      return shown !== goal
    }
  },
})
export default curtain

/** Smoothstep on 0..1, the ease of one strip or half. */
function ease3(t: F): F {
  return t.mul(t).mul(t.mul(-2).add(3)) as F
}
