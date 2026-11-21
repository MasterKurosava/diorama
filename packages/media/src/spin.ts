import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { boxRing } from './focus'
import { frames } from './frames'

type Params = {
  frames: string
  atlas: string
  grid: readonly [number, number]
  count: 'auto'
  density: number
  resolution: number
  rows: number
  frame: number
  row: number
  by: ChoiceParam<'drag' | 'hover' | 'manual'>
  sensitivity: number
  spin: number
  inertia: number
  loop: boolean
  reverse: boolean
  blend: boolean
  hint: boolean
  cache: number
  fps: number
}

/** What the frame policy reads, by the phase's signal. */
interface Motion {
  /** Dragging, coasting or settling on a frame: full rate. */
  fast: boolean
  /** Turning by itself or hinting: at most `fps`. */
  slow: boolean
}
const motions = new WeakMap<AbortSignal, Motion>()

/** The hint turns a twelfth of a turn and back in this time, s. */
const HINT = 1.2
/** Velocity is measured over the pointer's last moves within this time, ms. */
const WINDOW = 80
/** A release slower than this many frames a second does not coast. */
const STOP = 0.5

/** A coast after a flick, eased out from the frame shown at release onto a whole frame. */
interface Coast {
  readonly from: number
  readonly to: number
  /** Its length, s. */
  readonly length: number
  /** 0..1 of the way. */
  t: number
}

const mod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor

/**
 * Where a turn shows: frame `pos` (fractional, unbounded with `loop`) of a row of `per` frames,
 * as the two frames to mix and the share of the second. Without `loop` the ends hold.
 */
export function pick(
  pos: number,
  per: number,
  loop: boolean,
  blend: boolean,
): [lo: number, hi: number, t: number] {
  const at = loop ? mod(pos, per) : Math.min(per - 1, Math.max(0, pos))
  if (!blend) {
    const nearest = Math.round(at)
    const frame = loop ? nearest % per : nearest
    return [frame, frame, 0]
  }
  const lower = Math.floor(at)
  const share = at - lower
  const upper = loop ? (lower + 1) % per : Math.min(lower + 1, per - 1)
  return [lower, upper, share]
}

/**
 * A product turned by drag through photos taken around it; each turn shows a whole frame unless
 * `blend` mixes neighbours, and with `inertia` a flick coasts on. Frames load coarse to fine like
 * `sequence`; without WebGL the poster stays.
 */
const spin: Effect<Params> = defineEffect({
  name: 'spin',
  params: {
    frames: '',
    atlas: '',
    grid: [1, 1],
    count: 'auto',
    density: 1,
    resolution: 1600,
    rows: 1,
    frame: 0,
    row: 0,
    by: oneOf('drag', 'hover', 'manual'),
    sensitivity: 1,
    spin: 0,
    inertia: 0,
    loop: true,
    reverse: false,
    blend: false,
    hint: true,
    cache: 8,
    fps: 30,
  },
  rebuild: ['grid', 'count', 'density', 'resolution', 'rows'],
  media: true,
  quality: {
    low: { density: 0.5, cache: 4, resolution: 960 },
    medium: { cache: 6, resolution: 1280 },
  },
  // Drag and coasting at full rate (an infinite rate asks for the next frame), turning by itself
  // and the hint at most `fps`, nothing at rest.
  animate: {
    fps: (ctx) => {
      const motion = motions.get(ctx.signal)
      return motion?.fast ? Number.POSITIVE_INFINITY : motion?.slow ? ctx.params.fps : 0
    },
  },
  async setup(ctx: EffectContext<Params>) {
    const { signal, app } = ctx
    const params = ctx.params
    const el = ctx.element as HTMLElement
    const rows = Math.max(1, Math.round(params.rows))
    // Frames run row after row: windows and nearest frames wrap inside a row.
    const perRow = (total: number): number => Math.max(1, Math.floor(total / rows))
    const player = await frames(ctx, { passes: [8, 4, 2, 1], counted: 4, period: perRow })
    if (!player) return
    /** Frames in a row: one full turn. */
    const span = perRow(player.n)
    const last = Math.max(0, Math.min(rows, Math.ceil(player.n / span)) - 1)
    const reduced = (): boolean => app.stage.reducedMotion.peek()

    /** The frame shown in the row, fractional while turning. */
    let pos = params.frame
    let row = Math.min(last, Math.max(0, Math.round(params.row)))
    /** The values this effect wrote last, to tell the site's writes from its own. */
    let wrote = { frame: params.frame, row: params.row }
    let coast: Coast | undefined
    let dir = 1
    /** Easing to a whole frame after a turn ends, with blend. */
    let settling = false
    /** The first touch ends `spin` and the hint for good. */
    let touched = false
    let hint: { from: number; t: number } | undefined
    // manual: only keys, the params and spin turn it, so there is nothing to hint at.
    const by = params.by
    let hinted = !params.hint || by === 'manual'
    let hintReady = false

    const outline = boxRing(ctx, el)
    ctx.place(outline.mesh)

    /** Frames a pixel of horizontal drag moves by. */
    const rate = (): number =>
      ((params.reverse ? -1 : 1) * params.sensitivity * span) / Math.max(1, ctx.input.width)
    const clampPos = (at: number): number =>
      params.loop ? at : Math.min(span - 1, Math.max(0, at))
    /**
     * The coast of a release at `speed` frames a second: as far as inertia carries it, rounded to
     * a whole frame. It starts on the frame on screen, so letting go shows no jump.
     */
    const glide = (speed: number): Coast | undefined => {
      const from = params.blend ? pos : Math.round(pos)
      const to = clampPos(Math.round(from + speed * params.inertia))
      if (to === from) return undefined
      // A cubic ease-out leaves at 3 × distance / length: the release speed, in at most 3 × inertia.
      const length = Math.min(3 * params.inertia, (3 * Math.abs(to - from)) / Math.abs(speed))
      return { from, to, length, t: 0 }
    }

    // The hint waits for the frames it shows, so it never stutters through coarse ones.
    const reach = Math.max(1, Math.ceil(span / 12))
    const near = Array.from(
      { length: reach },
      (_, i) => row * span + mod(Math.round(pos) + i + 1, span),
    )
    void player.loaded(...near).then(() => {
      hintReady = true
      if (!hinted && !reduced()) ctx.invalidate()
    })

    const touch = (): void => {
      touched = true
      hint = undefined
      hinted = true
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler as (event: Event) => void, { signal })
    const action = (): string => getComputedStyle(el).touchAction || 'auto'

    type Grab = {
      id: number
      x: number
      y: number
      from: number
      row: number
      tilt: boolean
      samples: { t: number; pos: number }[]
    }
    let grab: Grab | undefined
    /** hover: where the pointer came over the box and the turn then. */
    let anchor: { x: number; y: number; from: number; row: number } | undefined
    listen('pointerdown', (e) => {
      if (e.button !== 0 || grab || by === 'manual') return
      const finger = e.pointerType !== 'mouse'
      // hover turns a mouse without a press; a finger or a pen drags as usual.
      if (by === 'hover' && !finger) return
      const touchAction = action()
      // A finger turns only where the site gave the gesture to the page.
      const turnable =
        touchAction === 'none' || (touchAction.includes('pan-y') && !touchAction.includes('pan-x'))
      if (finger && !turnable) return
      touch()
      settling = false
      coast = undefined
      grab = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        from: pos,
        row,
        tilt: rows > 1 && (!finger || touchAction === 'none'),
        samples: [{ t: e.timeStamp, pos }],
      }
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
      // No native drag of the poster, no text selection.
      if (!finger) e.preventDefault()
      ctx.invalidate()
    })
    listen('pointermove', (e) => {
      if (by === 'hover' && e.pointerType === 'mouse' && !grab) {
        if (!anchor) {
          anchor = { x: e.clientX, y: e.clientY, from: pos, row }
          return
        }
        touch()
        coast = undefined
        settling = false
        pos = clampPos(anchor.from + (e.clientX - anchor.x) * rate())
        if (rows > 1) {
          const rowPx = Math.max(1, ctx.input.height) / rows
          row = Math.min(last, Math.max(0, anchor.row + Math.round((anchor.y - e.clientY) / rowPx)))
        }
        ctx.invalidate()
        return
      }
      if (e.pointerId !== grab?.id) return
      pos = clampPos(grab.from + (e.clientX - grab.x) * rate())
      if (grab.tilt) {
        const rowPx = Math.max(1, ctx.input.height) / rows
        row = Math.min(last, Math.max(0, grab.row + Math.round((grab.y - e.clientY) / rowPx)))
      }
      grab.samples.push({ t: e.timeStamp, pos })
      while (grab.samples.length > 2 && e.timeStamp - (grab.samples[1]?.t ?? 0) > WINDOW) {
        grab.samples.shift()
      }
      ctx.invalidate()
    })
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== grab?.id) return
      const first = grab.samples[0]
      const end = grab.samples.at(-1)
      let speed = 0
      // Held still before letting go, cancelled by a scroll, or no motion wanted: no coasting.
      if (first && end && e.type === 'pointerup' && !reduced() && params.inertia > 0) {
        const recent = e.timeStamp - end.t <= WINDOW
        const seconds = (end.t - first.t) / 1000
        if (recent && seconds > 0) speed = (end.pos - first.pos) / seconds
        speed = Math.max(-span * 3, Math.min(span * 3, speed))
      }
      grab = undefined
      coast = Math.abs(speed) >= STOP ? glide(speed) : undefined
      settling = params.blend && !coast
      ctx.invalidate()
    }
    listen('pointerup', release)
    listen('pointercancel', release)
    if (by === 'hover') {
      // Leaving the box ends the turn: with blend it settles on a whole frame.
      listen('pointerleave', (e) => {
        if (e.pointerType !== 'mouse' || !anchor) return
        anchor = undefined
        settling = params.blend
        ctx.invalidate()
      })
    }
    listen('dragstart', (e) => e.preventDefault())
    listen('keydown', (e) => {
      if (!el.hasAttribute('tabindex') || e.altKey || e.ctrlKey || e.metaKey) return
      // A frame, or 10°, whichever is more.
      const step = Math.max(1, Math.round(span / 36)) * (params.reverse ? -1 : 1)
      const across = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      const up = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0
      if (!across && !up && e.key !== 'Home') return
      e.preventDefault()
      touch()
      coast = undefined
      settling = false
      if (e.key === 'Home') {
        pos = player.poster % span
        row = Math.min(last, Math.floor(player.poster / span))
      } else {
        pos = clampPos(Math.round(pos) + across * step)
        row = Math.min(last, Math.max(0, row + up))
      }
      ctx.invalidate()
    })

    const motion: Motion = { fast: false, slow: false }
    motions.set(signal, motion)
    ctx.onDispose(() => motions.delete(signal))

    return (input) => {
      const still = input.reducedMotion
      const dt = Math.min(input.delta, 0.1)
      // The site moved the turn: go there.
      if (params.frame !== wrote.frame || params.row !== wrote.row) {
        if (params.frame !== wrote.frame) pos = clampPos(params.frame)
        if (params.row !== wrote.row) row = Math.min(last, Math.max(0, Math.round(params.row)))
        coast = undefined
        settling = false
        hint = undefined
        // Taken: without this a write the effect keeps as is pulls every later frame back here.
        wrote = { frame: params.frame, row: params.row }
      }
      const before = pos
      let turning = false
      if (!grab) {
        if (coast) {
          // Eased out over its own length; reduced motion lands at once.
          coast.t = still ? 1 : Math.min(1, coast.t + dt / coast.length)
          pos = coast.from + (coast.to - coast.from) * (1 - (1 - coast.t) ** 3)
          if (coast.t === 1) coast = undefined
        } else if (!still && !touched && params.spin) {
          // Turning by itself until the first touch; without loop, up to the end frame.
          pos = clampPos(pos + (params.spin / 360) * span * dt * (params.reverse ? -1 : 1))
          turning = pos !== before
        } else if (hint) {
          hint.t = Math.min(1, hint.t + dt / HINT)
          pos = hint.from + reach * Math.sin(Math.PI * hint.t) * (params.reverse ? -1 : 1)
          if (hint.t === 1) {
            pos = hint.from
            hint = undefined
          }
        } else if (!hinted && hintReady && !still && !params.spin) {
          hinted = true
          hint = { from: pos, t: 0 }
        }
        if (settling) {
          const goal = Math.round(pos)
          pos = still ? goal : damp(pos, goal, 0.06, dt, 1e-3)
          if (pos === goal) settling = false
        }
      }
      if (pos !== before) dir = Math.sign(pos - before)
      // Keep the turn small once no pointer follows it.
      if (params.loop && !grab && !coast && !hint) pos = mod(pos, span)

      // A coast crossfades too: whole frames would step ever slower as it eases out.
      const [from, to, share] = pick(pos, span, params.loop, params.blend || coast !== undefined)
      player.show(row * span + from, row * span + to, share, dir)
      const [whole] = pick(pos, span, params.loop, false)
      const frame = params.blend ? (params.loop ? mod(pos, span) : clampPos(pos)) : whole
      // One write a frame, only of a change: the site reads the turn in `handle.params`. Not
      // while turning by itself: a write requests a frame and would lift the `fps` cap.
      if (!turning && !hint && (frame !== params.frame || row !== params.row)) {
        ctx.set({ frame, row })
        wrote = { frame, row }
      }
      outline.update()

      motion.fast = grab !== undefined || coast !== undefined || settling
      motion.slow = turning || hint !== undefined
    }
  },
})
export default spin
