import { definePlugin } from '../kernel/plugin'
import type { Off, Plugin } from '../kernel/types'
import { noop } from '../kernel/util'
import { onBodySwap } from './body'
import { velocityTracker } from './motion'

/** Scroll axis: `x` for horizontal, `y` for vertical. */
export type ScrollAxis = 'x' | 'y'

/** Live scroll state, updated in place in the `input` stage. */
export interface ScrollState {
  /** Document scroll offset, CSS px. */
  readonly x: number
  /** Vertical document scroll offset, CSS px. */
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
  /** Vertical offset this frame, CSS px. */
  y: number
  /** Continuous position along the axis for velocity. An infinite scroller doesn't wrap it. */
  travel: number
}

/** Where `scroll` takes the offset from. Without one, window scroll events are cached. */
export interface ScrollSource {
  /** Label for logs. */
  readonly name: string
  /** Axis of `progress`, `velocity`, `direction`. Default 'y'. */
  readonly axis?: ScrollAxis
  /** Called once per frame at the start of the `scroll` system. Reads only, never writes the DOM. */
  read(out: ScrollSample): void
  /** Scrollable range along the axis, CSS px. Default: the measured document range. */
  limit?(): number
}

/** The `scroll` service. */
export interface ScrollApi {
  /** Scroll state, updated in place every frame. */
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

/** Tracks page scroll, its velocity and progress. Built in. */
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
    // The active source threw last frame. Errors are reported once per streak.
    let failing = false
    const switched = (): void => {
      resync = true
      failing = false
      app.invalidate()
    }
    const source = (added: ScrollSource): Off => {
      sources.push(added)
      switched()
      return () => {
        const index = sources.indexOf(added)
        if (index < 0) return
        sources.splice(index, 1)
        switched()
      }
    }

    /** Fills `sample` from the active source, or from native offsets if it throws. */
    const readSource = (active: ScrollSource): number | undefined => {
      sample.x = x
      sample.y = y
      sample.travel = lastTravel
      try {
        active.read(sample)
        const limit = active.limit?.()
        sample.x = finite(sample.x, x)
        sample.y = finite(sample.y, y)
        sample.travel = finite(sample.travel, lastTravel)
        // A recovering source may be in another domain than the native fallback.
        if (failing) resync = true
        failing = false
        return limit
      } catch (error) {
        if (!failing) app.report(error, `scroll:${active.name}`)
        failing = true
        sample.x = x
        sample.y = y
        sample.travel = lastTravel
        return undefined
      }
    }

    app.system(
      'input',
      (time) => {
        const active = sources.at(-1)
        let limit: number | undefined
        if (active) {
          limit = readSource(active)
        } else {
          sample.x = x
          sample.y = y
          sample.travel = y
        }
        const axis = active?.axis ?? 'y'
        const moved = sample.travel - lastTravel
        // A jump (restore, #hash, scrollTo immediate) or a wake after idle is no motion.
        if (resync || time.resumed) resync = false
        else if (Math.abs(moved) > (axis === 'x' ? innerWidth : innerHeight)) resync = false
        else track.update(moved, time)
        lastTravel = sample.travel
        let range = axis === 'x' ? rangeX : rangeY
        if (Number.isFinite(limit) && (limit as number) > 0) range = limit as number
        const offset = axis === 'x' ? sample.x : sample.y
        state.axis = axis
        state.x = sample.x
        state.y = sample.y
        state.progress = range > 0 ? Math.min(1, Math.max(0, offset / range)) : 0
      },
      { name: 'scroll' },
    )
    return { state, measure, source }
  },
})
