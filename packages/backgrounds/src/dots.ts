import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  clamp,
  dFdx,
  dFdy,
  exp,
  float,
  floor,
  length,
  max,
  min,
  mix,
  select,
  smoothstep,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import { Color, type Node, Vector2 } from 'three/webgpu'
import { checkTarget } from './target'

type Params = {
  style: ChoiceParam<'dots' | 'plus' | 'squares'>
  mode: ChoiceParam<'grow' | 'push' | 'glow'>
  gap: number
  dot: number
  color: ColorParam
  accent: ColorParam
  radius: number
  strength: number
  speed: number
  fade: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Grow: how much larger a mark gets under the pointer at strength 1. */
const GROW = 2.2
/** Push: farthest a mark moves at strength 1, in gaps. The 3 × 3 cells around a pixel hold it. */
const PUSH = 0.9
/** Glow: halo radius in gaps. */
const HALO = 0.25
/** Seconds the lens takes to settle on the pointer and to fade out after it leaves. */
const SOFT = 0.12
/** Drift direction: left and up, a little steeper than the diagonal. */
const DRIFT = new Vector2(-0.8, -0.6)
/** Frames a second while the grid drifts. */
const FPS = 30

/**
 * A grid of dots, plus marks or squares that answers the pointer: marks near it grow, get pushed
 * aside or glow in the accent color, and settle back when it leaves. Optional slow drift and an
 * edge fade. At rest it matches a CSS dot pattern of the same gap.
 */
const dots: Effect<Params> = defineEffect({
  name: 'dots',
  params: {
    style: oneOf('dots', 'plus', 'squares'),
    mode: oneOf('grow', 'push', 'glow'),
    gap: 24,
    dot: 2,
    color: color('#a3acb9'),
    accent: color('#5b6cff'),
    radius: 140,
    strength: 0.6,
    speed: 0,
    fade: 0,
  },
  animate: { fps: (ctx) => (ctx.params.speed > 0 ? FPS : 0) },
  quality: { low: { speed: 0 } },
  setup(ctx: EffectContext<Params>) {
    const { params, surface, u } = ctx
    if (DEV) checkTarget(ctx, 'dots')
    // Lens centre in CSS px from the box's top left, and its strength 0..1.
    const lens = uniform(new Vector2(-1e4, -1e4))
    const lensStrength = uniform(0)
    // Drift offset in CSS px, wrapped to one gap.
    const driftOffset = uniform(new Vector2())
    // Pointer moves draw frames only where a pointer can hover.
    const hovers = globalThis.matchMedia?.('(hover: hover)').matches ?? true
    // The copy hides the element, its background colour too: the grid draws over it instead.
    const [paper, opaque] = backgroundOf(ctx.element)
    const paperColor = uniform(new Color(paper))

    surface.color((_, { box, radius: cornerMask }) => {
      const size = u.size as unknown as Node<'vec2'>
      // CSS px from the top left, like a CSS background pattern.
      const point = vec2(box.x.mul(size.x), float(1).sub(box.y).mul(size.y))
      const pixel = max(abs(dFdx(point.x)).add(abs(dFdy(point.x))), 1e-4)
      const gap = max(u.gap, 2)
      const halfDot = max(u.dot, 0.5).mul(0.5)
      const reach = max(u.radius, 1)
      const cell = floor(point.add(driftOffset).div(gap))
      const home = cell.add(0.5).mul(gap).sub(driftOffset)
      /** Signed distance in px from the mark of half size `half` at `local`. */
      const markDistance = (local: Node<'vec2'>, half: Node<'float'>): Node<'float'> => {
        const folded = abs(local)
        if (params.style === 'squares') return max(folded.x, folded.y).sub(half)
        if (params.style === 'plus') {
          const barHalfWidth = half.mul(0.5)
          const arm = half.mul(4)
          const bar = (x: Node<'float'>, y: Node<'float'>) => max(x.sub(arm), y.sub(barHalfWidth))
          return min(bar(folded.x, folded.y), bar(folded.y, folded.x))
        }
        return length(local).sub(half)
      }
      /** Pointer influence 0..1 on a mark centred at `center`: smoothstep falloff over `radius`. */
      const influence = (center: Node<'vec2'>): Node<'float'> => {
        const t = clamp(float(1).sub(length(center.sub(lens)).div(reach)), 0, 1)
        return t
          .mul(t)
          .mul(float(3).sub(t.mul(2)))
          .mul(lensStrength)
      }
      /** Antialiased coverage of a signed distance. */
      const coverage = (distance: Node<'float'>) => clamp(float(0.5).sub(distance.div(pixel)), 0, 1)

      let alpha: Node<'float'>
      let tint: Node<'float'>
      if (params.mode === 'push') {
        // A pushed mark can leave its cell, so the neighbours are drawn too.
        alpha = float(0)
        tint = float(0)
        for (let y = -1; y <= 1; y++)
          for (let x = -1; x <= 1; x++) {
            const center = home.add(vec2(x, y).mul(gap))
            const away = center.sub(lens)
            const force = influence(center)
            const moved = center.add(
              away.div(max(length(away), 1e-3)).mul(force.mul(gap).mul(PUSH)),
            )
            const markAlpha = coverage(markDistance(point.sub(moved), halfDot))
            tint = select(markAlpha.greaterThan(alpha), force, tint)
            alpha = max(alpha, markAlpha)
          }
      } else {
        const force = influence(home)
        const local = point.sub(home)
        const grown = params.mode === 'grow' ? halfDot.mul(force.mul(GROW).add(1)) : halfDot
        // Marks never grow into their neighbours.
        const half = min(grown, gap.mul(params.style === 'plus' ? 0.11 : 0.45))
        alpha = coverage(markDistance(local, half))
        tint = force
        if (params.mode === 'glow') {
          const halo = length(local).div(gap.mul(HALO))
          alpha = max(alpha, exp(halo.mul(halo).negate()).mul(force).mul(0.55))
        }
      }
      // Edge fade: none at 0, gone from the middle of each edge at 1.
      const fromCenter = length(box.sub(0.5).mul(2))
      const edge = float(1).sub(
        smoothstep(mix(1.42, 0.25, u.fade), mix(1.42, 1, u.fade).add(1e-3), fromCenter),
      )
      // The marks over the element's own background colour, premultiplied by hand.
      const ink = alpha.mul(edge)
      const outAlpha = ink.add(float(opaque).mul(float(1).sub(ink)))
      const rgb = mix(u.color, u.accent, tint)
        .mul(ink)
        .add(paperColor.mul(opaque).mul(float(1).sub(ink)))
        .div(max(outAlpha, 1e-4))
      return vec4(rgb, outAlpha.mul(cornerMask))
    })

    let presence = 0
    let pointerX = 0
    let pointerY = 0
    const lensAt = lens.value as Vector2
    const offset = driftOffset.value as Vector2
    return (input: EffectInput) => {
      const still = input.reducedMotion
      if (params.speed > 0 && !still) {
        const step = params.speed * input.delta
        const gap = Math.max(params.gap, 2)
        offset.x = (offset.x + DRIFT.x * step) % gap
        offset.y = (offset.y + DRIFT.y * step) % gap
      }
      // strength or radius 0 never reads the pointer: reading it makes every move draw a frame.
      const over = hovers && !still && params.strength > 0 && params.radius > 0 && input.over
      if (over) {
        const pointer = input.pointer
        pointerX = pointer.x * input.width
        pointerY = (1 - pointer.y) * input.height
        // The lens jumps in where the pointer enters and follows it softly after that.
        if (presence < 0.01) lensAt.set(pointerX, pointerY)
        else {
          lensAt.x = damp(lensAt.x, pointerX, SOFT * 0.5, input.delta)
          lensAt.y = damp(lensAt.y, pointerY, SOFT * 0.5, input.delta)
          if ((lensAt.x - pointerX) ** 2 + (lensAt.y - pointerY) ** 2 < 0.01)
            lensAt.set(pointerX, pointerY)
        }
      }
      const target = over ? 1 : 0
      presence = damp(presence, target, SOFT, input.delta, 1e-3)
      lensStrength.value = presence * Math.max(0, params.strength)
      // Settling after the pointer stops or leaves: one more frame until it rests.
      const following = over && (lensAt.x !== pointerX || lensAt.y !== pointerY)
      if (presence !== target || following) ctx.invalidate()
    }
  },
})
export default dots

/** The element's computed background colour as hex and its alpha; transparent is alpha 0. */
function backgroundOf(element: Element): [string, number] {
  const value = getComputedStyle(element).backgroundColor
  const parts =
    /\(([^)]*)\)/
      .exec(value)?.[1]
      ?.split(/[\s,/]+/)
      .filter(Boolean) ?? []
  const alpha =
    parts.length > 3
      ? Number.parseFloat(parts[3] as string)
      : value && value !== 'transparent'
        ? 1
        : 0
  const hex = alpha > 0 ? cssColor(value) : undefined
  return hex ? [hex, Number.isFinite(alpha) ? Math.min(1, alpha) : 1] : ['#000000', 0]
}
