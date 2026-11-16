import { definePlugin } from '../kernel/plugin'
import type { Off, Plugin } from '../kernel/types'
import { noop } from '../kernel/util'
import { onBodySwap } from './body'
import { velocityTracker } from './motion'

export type ScrollAxis = 'x' | 'y'

/** Live scroll state, updated in place in the `input` stage. */
export interface ScrollState {
  /** Document scroll offset, CSS px. */
  readonly x: number
  readonly y: number
  /**
   * Smoothed velocity along `axis`, px/s, positive while scrolling down (or right). Reading it
   * while it decays keeps frames coming.
   */
  readonly velocity: number
  /** 1 down, -1 up, 0 at rest. */
  readonly direction: -1 | 0 | 1
  /** 0..1 through the scrollable range along `axis`. */
  readonly progress: number
  /** Axis of `progress`, `velocity` and `direction`. The active source's, or 'y' without one. */
  readonly axis: ScrollAxis
}

/** One frame's reading of a scroll source, filled in place. */
export interface ScrollSample {
  /** Document scroll offset this frame, CSS px, as the page shows it. */
  x: number
  y: number
  /** Continuous position along the axis for velocity. An infinite scroller doesn't wrap it. */
  travel: number
}

/** Where `scroll` takes the offset from. Without one, window scroll events are cached. */
export interface ScrollSource {
  readonly name: string
  /** Axis of `progress`, `velocity`, `direction`. Default 'y'. */
  readonly axis?: ScrollAxis
  /** Called once per frame at the start of the `scroll` system. Reads only, never writes the DOM. */
  read(out: ScrollSample): void
  /** Scrollable range along the axis, CSS px. Default: the measured document range. */
  limit?(): number
}

export interface ScrollApi {
  readonly state: ScrollState
  /** Re-reads the scrollable range after a layout change the observers cannot see. */
  measure(): void
  /**
   * Reads offsets from `source` from the next frame on. The newest source wins and Off restores
   * the previous one. The switch frame keeps the previous velocity, so there is no spike.
   */
  source(source: ScrollSource): Off
}

const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

export const scroll: Plugin<'scroll'> = /*#__PURE__*/ definePlugin({
  name: 'scroll',
  setup(app): ScrollApi {
    const track = velocityTracker(app)
    const state = {
      x: 0,
      y: 0,
      get velocity() {
        return track.value
      },
      get direction() {
        return Math.sign(track.value) as -1 | 0 | 1
      },
      progress: 0,
      axis: 'y' as ScrollAxis,
    }
    if (typeof window === 'undefined') return { state, measure: noop, source: () => noop }

    const root = document.documentElement
    let x = window.scrollX
    let y = window.scrollY
    let rangeX = 0
    let rangeY = 0
    state.x = x
    state.y = y
    // Scroll events only record the offset. The frame turns it into state.
    const listen = { signal: app.abortSignal, passive: true }
    window.addEventListener(
      'scroll',
      () => {
        x = window.scrollX
        y = window.scrollY
        app.invalidate()
      },
      listen,
    )
    const measure = (): void => {
      rangeX = Math.max(0, root.scrollWidth - root.clientWidth)
      rangeY = Math.max(0, root.scrollHeight - root.clientHeight)
      app.invalidate()
    }
    measure()
    window.addEventListener('resize', measure, listen)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(document.body)
    if (observer) app.onDispose(() => observer.disconnect())
    onBodySwap(app, (body, previous) => {
      observer?.unobserve(previous)
      observer?.observe(body)
      measure()
    })

    const sources: ScrollSource[] = []
    const sample = { x: 0, y: 0, travel: 0 }
    let lastTravel = y
    // The first frame, and the one after a resync, re-base travel without feeding velocity.
    let resync = true
    let failing = false
    const switched = (): void => {
      resync = true
      failing = false
      app.invalidate()
    }
    const source = (src: ScrollSource): Off => {
      sources.push(src)
      switched()
      return () => {
        const index = sources.indexOf(src)
        if (index < 0) return
        sources.splice(index, 1)
        switched()
      }
    }

    app.system(
      'input',
      (t) => {
        const src = sources.at(-1)
        let sx = x
        let sy = y
        let travel = y
        let limit: number | undefined
        if (src) {
          sample.x = x
          sample.y = y
          sample.travel = lastTravel
          try {
            src.read(sample)
            limit = src.limit?.()
            sx = finite(sample.x, x)
            sy = finite(sample.y, y)
            travel = finite(sample.travel, lastTravel)
            // A recovering source may be in another domain than the native fallback.
            if (failing) resync = true
            failing = false
          } catch (error) {
            // Report once per streak of failures and fall back to native offsets.
            if (!failing) app.report(error, `scroll:${src.name}`)
            failing = true
            travel = lastTravel
          }
        }
        const axis = src?.axis ?? 'y'
        const d = travel - lastTravel
        // A jump (restore, #hash, scrollTo immediate) or a wake after idle is no motion.
        if (resync || t.resumed || Math.abs(d) > (axis === 'x' ? innerWidth : innerHeight))
          resync = false
        else track.update(d, t)
        lastTravel = travel
        const range =
          Number.isFinite(limit) && (limit as number) > 0
            ? (limit as number)
            : axis === 'x'
              ? rangeX
              : rangeY
        state.axis = axis
        state.x = sx
        state.y = sy
        state.progress = range > 0 ? Math.min(1, Math.max(0, (axis === 'x' ? sx : sy) / range)) : 0
      },
      { name: 'scroll' },
    )
    return { state, measure, source }
  },
})
