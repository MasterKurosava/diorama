import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { between, damp, ease, roundedBox } from '@dioramajs/effects/kit'
import {
  abs,
  clamp,
  dot,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { type Node, Vector2 } from 'three/webgpu'
import { focusRing } from './focus'
import { framing } from './slots'

type F = Node<'float'>
type V2 = Node<'vec2'>
type Params = {
  position: number
  by: ChoiceParam<'drag' | 'hover' | 'scroll' | 'manual'>
  direction: ChoiceParam<'x' | 'y'>
  mode: ChoiceParam<'split' | 'lens' | 'fade'>
  radius: number
  softness: number
  thickness: number
  color: ColorParam
  handle: boolean
  start: number
  end: number
  hint: boolean
  items: string
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Time the line takes to cover ~63% of the way to its goal, s. */
const EASE = 0.06
/** The hint: one swing of 0.08 of the box each way and back, s. */
const HINT = 1.2
const SWING = 0.08
/** Radius of the handle, px. */
const KNOB = 22
/** Reach of the soft shadow under the line and the handle, px, and its strongest alpha. */
const SHADOW = 10
const DARK = 0.28
/** Gap between the handle or the lens ring and the focus ring, px. */
const GAP = 2
/** Pointer travel that still counts as a tap, px. */
const TAP = 10

/** Elements whose hint has played or whose visitor moved the line first: it plays once. */
const hinted = new WeakSet<Element>()
/** Elements already told they have no range input. */
const noted = new WeakSet<Element>()

const unit = (value: number): number => Math.min(1, Math.max(0, value))
const parseOr = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Coverage of the band [-half, half] by a pixel `aa` wide centred `d` from its middle. */
const band = (d: F, half: F, aa: F): F =>
  clamp(
    min(d.add(aa.mul(0.5)), half)
      .sub(max(d.sub(aa.mul(0.5)), half.negate()))
      .div(aa),
    0,
    1,
  )
/** Coverage of a shape at signed distance `d` (negative inside), a pixel `aa` wide. */
const fill = (d: F, aa: F): F => clamp(d.div(aa).negate().add(0.5), 0, 1)

/**
 * Before and after: two images of a container in one box, split by a line the visitor drags,
 * hovers or scrolls, or seen through a lens. The site's range input stays the keyboard control.
 */
const compare: Effect<Params> = defineEffect({
  name: 'compare',
  params: {
    position: 0.5,
    by: oneOf('drag', 'hover', 'scroll', 'manual'),
    direction: oneOf('x', 'y'),
    mode: oneOf('split', 'lens', 'fade'),
    radius: 120,
    softness: 0,
    thickness: 2,
    color: color('#ffffff'),
    handle: true,
    start: 0.2,
    end: 0.8,
    hint: true,
    items: 'img',
  },
  on: ':not(img, video, canvas)',
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u } = ctx
    const el = ctx.element as HTMLElement
    const images = [...el.querySelectorAll(params.items)].filter(
      (node): node is HTMLImageElement => node.localName === 'img',
    )
    const [first, second] = images
    if (!first || !second) {
      app.log.warn(
        `compare: needs two images matching "${params.items}", the container stays as it is`,
        el,
      )
      return
    }
    const range = el.querySelector<HTMLInputElement>('input[type="range"]')
    if (!range && !noted.has(el)) {
      noted.add(el)
      app.log.warn('compare: add an <input type="range"> for keyboard and screen readers', el)
    }
    const source = (img: HTMLImageElement): string => img.currentSrc || img.src
    const [firstTexture, secondTexture] = await Promise.all([
      ctx.texture(source(first)),
      ctx.texture(source(second)),
    ])
    if (signal.aborted) return
    const firstFit = ctx.fit(firstTexture, framing(first))
    const secondFit = ctx.fit(secondTexture, framing(second))

    const by = params.by
    const vertical = params.direction === 'y'
    const lens = params.mode === 'lens'
    const fade = params.mode === 'fade'
    const ring = range ? focusRing(ctx, range) : undefined
    // The handle's or the lens's centre in box px, y up.
    const centre = uniform(new Vector2())
    ctx.surface.color((_, { uv, radius }) => {
      const at = centre as unknown as V2
      const point = uv.mul(u.size)
      const fromCentre = point.sub(at)
      const pick = (fit: typeof firstFit): Node<'vec4'> => {
        const color = fit.sample(uv)
        return vec4(color.rgb, color.a.mul(fit.mask(uv)))
      }
      // Pushes the edge of a part that is turned off far away, so it casts no shade.
      const away = (on: Node<'float'>): F => float(1).sub(on).mul(1e4) as unknown as F
      const hasLine = step(1e-3, u.thickness)
      const half = u.thickness.mul(0.5) as unknown as F
      let mask: F
      // Signed px from the lit edge of the line or lens ring, and the cover of line, ring, arrows.
      let edge: F
      let drawn: F
      let knob: F
      if (fade) {
        // A crossfade by the position: the line at the start shows the second image, at the end
        // the first, as the split would. No line, no handle; the ring goes just inside the box.
        const share = vertical ? at.y.div(u.size.y) : at.x.div(u.size.x).oneMinus()
        mask = clamp(share, 0, 1) as unknown as F
        edge = float(1e4) as unknown as F
        drawn = float(0) as unknown as F
        const inside = roundedBox(point.sub(u.size.mul(0.5)), u.size.mul(0.5) as V2, 0).negate()
        knob = (ring ? ring.offset.add(ring.width).add(GAP).sub(inside) : inside) as unknown as F
      } else if (lens) {
        const distance = length(fromCentre) as unknown as F
        const aa = max(fwidth(distance), 1e-4) as unknown as F
        const soft = max(u.softness, aa.mul(0.5))
        mask = smoothstep(
          u.radius.sub(soft),
          u.radius.add(soft),
          distance,
        ).oneMinus() as unknown as F
        const fromRing = distance.sub(u.radius) as unknown as F
        edge = abs(fromRing).sub(half).add(away(hasLine)) as unknown as F
        drawn = band(fromRing, half, aa).mul(hasLine) as unknown as F
        knob = fromRing.sub(half).sub(GAP) as unknown as F
      } else {
        // Before the line is negative: left of it, or above it for direction y.
        const fromLine = (vertical ? at.y.sub(point.y) : point.x.sub(at.x)) as unknown as F
        const aa = max(fwidth(fromLine), 1e-4) as unknown as F
        const soft = max(u.softness, aa.mul(0.5))
        mask = smoothstep(soft.negate(), soft, fromLine) as unknown as F
        const distance = length(fromCentre) as unknown as F
        const ringHalf = max(u.thickness, 2).mul(0.5) as unknown as F
        const inside = fill(distance.sub(KNOB), aa).mul(u.handle)
        // Two chevrons pointing along the axis, from one segment mirrored both ways.
        const folded = abs(vertical ? vec2(fromCentre.y, fromCentre.x) : fromCentre)
        const tip = vec2(12, 0)
        const arm = vec2(-4, 5)
        const onArm = clamp(dot(folded.sub(tip), arm).div(dot(arm, arm)), 0, 1)
        const chevron = length(folded.sub(tip).sub(arm.mul(onArm))).sub(1) as unknown as F
        const line = band(fromLine, half, aa).mul(hasLine, inside.oneMinus())
        const handle = max(band(distance.sub(KNOB), ringHalf, aa), fill(chevron, aa)).mul(u.handle)
        drawn = max(line, handle) as unknown as F
        edge = min(
          abs(fromLine).sub(half).add(away(hasLine)),
          distance.sub(ringHalf.add(KNOB)).add(away(u.handle)),
        ) as unknown as F
        knob = distance.sub(ringHalf.add(KNOB + GAP)) as unknown as F
      }
      const base = mix(pick(firstFit), pick(secondFit), mask)
      // A soft shade around the line and handle keeps a light line visible on light pictures; it
      // is black for light colours and white for dark ones.
      const light = step(0.25, dot(u.color.rgb, vec3(0.2126, 0.7152, 0.0722)))
      const shade = mix(vec3(1), vec3(0), light)
      const fall = clamp(edge.div(SHADOW), 0, 1).oneMinus()
      const shadeAmount = fall.mul(fall, DARK)
      let rgb = mix(base.rgb, shade, shadeAmount)
      let alpha = base.a.add(shadeAmount.mul(base.a.oneMinus()))
      rgb = mix(rgb, u.color, drawn)
      alpha = alpha.add(drawn.mul(alpha.oneMinus()))
      if (ring) {
        const ringCover = ring.alpha(knob)
        rgb = mix(rgb, ring.color, ringCover)
        alpha = alpha.add(ringCover.mul(alpha.oneMinus()))
      }
      return vec4(rgb, alpha.mul(radius))
    })

    const hints = by === 'drag' || by === 'hover'
    // The line along the box (0 at the start of `direction`) and the lens across it, shown and aimed.
    let shown = -1
    let across = 0.5
    let aimAcross = 0.5
    // The hint's clock and its offset, drawn on top of the eased line.
    let clock = -1
    let swing = 0
    /** The visitor moved the line: no hint from now on, and one under way stops where it is. */
    const touched = (): void => {
      hinted.add(el)
      if (clock < 0 || clock >= HINT) return
      clock = HINT
      shown += swing
      swing = 0
    }
    // The value last written to the range or read from the param, so a site write is noticed.
    let synced = Number.NaN
    let firing = false
    const sync = (share: number, fire: boolean): void => {
      synced = share
      if (!range) return
      const low = parseOr(range.min, 0)
      const high = parseOr(range.max, 100)
      const was = range.value
      range.value = String(low + share * (high - low))
      if (!fire || range.value === was) return
      firing = true
      try {
        range.dispatchEvent(new Event('input', { bubbles: true }))
      } finally {
        firing = false
      }
    }
    /** The pointer as [along, across] the line's axis, each a share of the box. */
    const point = (e: PointerEvent): [number, number] => {
      const rect = el.getBoundingClientRect()
      const x = unit((e.clientX - rect.left) / (rect.width || 1))
      const y = unit((e.clientY - rect.top) / (rect.height || 1))
      return vertical ? [y, x] : [x, y]
    }
    const move = (e: PointerEvent): void => {
      const [alongShare, acrossShare] = point(e)
      touched()
      if (lens) aimAcross = acrossShare
      ctx.set({ position: alongShare })
      sync(alongShare, true)
    }
    /** Dragging on touch needs the site to keep pans along the axis from the page. */
    const ownsPan = (): boolean =>
      !(vertical ? /auto|manipulation|pan-y/ : /auto|manipulation|pan-x/).test(
        getComputedStyle(el).touchAction || 'auto',
      )
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler, { signal })
    if (hints) {
      let dragging: number | undefined
      let tap: { x: number; y: number; id: number } | undefined
      listen('pointerdown', (e) => {
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
        touched()
        if (e.pointerType === 'touch' && !ownsPan()) {
          tap = { x: e.clientX, y: e.clientY, id: e.pointerId }
          return
        }
        dragging = e.pointerId
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // A pointer the browser no longer knows: the drag follows moves over the box only.
        }
        move(e)
      })
      listen('pointermove', (e) => {
        if (dragging === e.pointerId) move(e)
        else if (by === 'hover' && dragging === undefined && e.pointerType !== 'touch') move(e)
      })
      const end = (e: PointerEvent): void => {
        if (dragging === e.pointerId) dragging = undefined
      }
      listen('pointerup', (e) => {
        if (tap?.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TAP) {
          move(e)
        }
        tap = undefined
        end(e)
      })
      listen('pointercancel', (e) => {
        tap = undefined
        end(e)
      })
      listen('lostpointercapture', end)
      // Pressing on a picture would start the browser's own image drag or a text selection.
      const hold = (e: Event): void => {
        if (dragging !== undefined) e.preventDefault()
      }
      listen('dragstart', hold)
      listen('selectstart', hold)
    }
    if (range) {
      range.addEventListener(
        'input',
        () => {
          if (firing) return
          // The scroll owns the line: the range shows where it is.
          if (by === 'scroll') return sync(synced, false)
          const low = parseOr(range.min, 0)
          const high = parseOr(range.max, 100)
          const share = unit((parseOr(range.value, low) - low) / (high - low || 1))
          touched()
          aimAcross = 0.5
          synced = share
          ctx.set({ position: share })
        },
        { signal },
      )
    }

    /** Starts the hint once half the box is on screen, and moves it on by a frame. */
    const hint = (input: EffectInput): void => {
      if (clock < 0 && hints && params.hint && !input.reducedMotion && !hinted.has(el)) {
        const viewportHeight = app.stage.height.peek()
        const seen = Math.min(input.y + input.height, viewportHeight) - Math.max(input.y, 0)
        if (input.visible && seen / Math.min(input.height, viewportHeight || 1) >= 0.5) {
          hinted.add(el)
          clock = 0
        }
      } else if (clock >= 0 && clock < HINT) {
        clock = input.reducedMotion ? HINT : clock + input.delta
      }
    }

    return (input): boolean => {
      const delta = input.delta
      const reduced = input.reducedMotion
      const target =
        by === 'scroll'
          ? 1 - between(ctx.section().pin, params.start, params.end)
          : unit(params.position)
      // A write of the site, the scroll or a tween: the range follows without an input event.
      if (target !== synced) sync(target, false)
      hint(input)
      const hinting = clock >= 0 && clock < HINT
      swing = hinting ? SWING * Math.sin(2 * Math.PI * ease('cubicInOut', clock / HINT)) : 0
      if (shown < 0 || reduced || delta <= 0) {
        shown = target
        across = aimAcross
      } else {
        shown = damp(shown, target, EASE, delta)
        across = damp(across, aimAcross, EASE, delta)
      }
      const { width, height } = input
      // Settled within a hundredth of a pixel: exact, and no more frames.
      const close = Math.abs(shown - target) * Math.max(width, height) < 0.01
      const level = Math.abs(across - aimAcross) * Math.max(width, height) < 0.01
      if (close) shown = target
      if (level) across = aimAcross
      const at = unit(shown + swing)
      const lensAcross = lens ? across : 0.5
      ;(centre.value as Vector2).set(
        vertical ? lensAcross * width : at * width,
        vertical ? (1 - at) * height : (1 - lensAcross) * height,
      )
      return !(close && level && !hinting)
    }
  },
})
export default compare
