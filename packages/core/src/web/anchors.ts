import { definePlugin } from '../kernel/plugin'
import type { Plugin } from '../kernel/types'
import { noop } from '../kernel/util'
import { onBodySwap } from './body'

/** An element's box, kept in sync with the page in the `layout` stage. */
export interface Anchor {
  /** The tracked element. */
  readonly element: Element
  /** Viewport position and size, CSS px. */
  readonly x: number
  /** Viewport y, CSS px. */
  readonly y: number
  /** Width, CSS px. */
  readonly width: number
  /** Height, CSS px. */
  readonly height: number
  /** Overlaps the viewport. */
  readonly visible: boolean
  /**
   * 0 as the top enters at the bottom of the viewport, 1 as the bottom leaves at the top.
   * Measured along `scroll.state.axis`, so a horizontal source runs it from right to left.
   */
  readonly progress: number
  /**
   * Progress of a section pinned with CSS sticky. 0 while its top is below the viewport top,
   * 1 once it has scrolled `height - viewport height` past it. A section no taller than the
   * viewport switches from 0 to 1 as its top passes the viewport top.
   */
  readonly pin: number
  /** Counts re-measures after layout changes. Per-frame live reads don't bump it. */
  readonly version: number
  /** Stops tracking. Pass the anchor to `app.onDispose` to tie it to a scope. */
  dispose(): void
}

/** Options of `anchors.track`. */
export interface TrackOptions {
  /**
   * Re-read the box every frame while near the viewport, to follow transforms and inline
   * `position: fixed`. Elements inside sticky or fixed ancestors are live by themselves.
   */
  readonly live?: boolean
}

/** The `anchors` service: element boxes kept in sync with the page. */
export interface AnchorsApi {
  /** Starts tracking an element. The anchor updates in the `layout` stage. */
  track(element: Element, options?: TrackOptions): Anchor
  /** Re-measures every anchor after a layout change the observers cannot see. */
  refresh(): void
}

/** The anchor object itself, with the cached page geometry behind it. */
interface Entry {
  element: Element
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  progress: number
  pin: number
  version: number
  /** Position relative to the document, measured with the DOM. */
  pageX: number
  pageY: number
  /** `track` asked for `live`. */
  manual: boolean
  /** Re-read every frame while near the viewport: manual, or inside sticky or fixed. */
  live: boolean
  /** Page band a sticky element moves within along the axis. Unbounded when fixed, else empty. */
  start: number
  end: number
  dispose(): void
}

/** How far ahead of the viewport, in viewport sizes, a live anchor is still re-read. */
const NEAR_AHEAD = 2

/**
 * What moves an element without a layout change: the box its outermost sticky ancestor moves
 * within, `fixed` for a fixed ancestor, or `null`. `positions` caches computed styles per pass.
 */
const stickyContainer = (
  element: Element,
  positions: Map<Element, string>,
): Element | 'fixed' | null => {
  let within: Element | null = null
  for (let node: Element | null = element; node; node = node.parentElement) {
    let position = positions.get(node)
    if (position === undefined) {
      position = getComputedStyle(node).position
      positions.set(node, position)
    }
    if (position === 'fixed') return 'fixed'
    if (position === 'sticky') within = node.parentElement
  }
  return within
}

/** A page band near the viewport along the scroll axis, at scroll offset `at`. Behind the
 * viewport it counts as near for one viewport size. */
const isNear = (start: number, end: number, at: number, size: number): boolean =>
  start - at < NEAR_AHEAD * size && end - at > -size

/**
 * Layout is read only when something may have moved (resize, observed size changes,
 * fonts). Each frame just offsets the cached page boxes by the scroll position. Live anchors
 * near the viewport are re-read every frame, since sticky, fixed and transformed boxes move
 * without a layout change.
 */
export const anchors: Plugin<'anchors'> = /*#__PURE__*/ definePlugin({
  name: 'anchors',
  dependencies: ['stage', 'scroll'],
  setup(app): AnchorsApi {
    const { stage, scroll } = app
    const entries = new Set<Entry>()
    // Boxes must be read from the DOM before the next frame uses them.
    let stale = true
    let horizontal = false
    /** Scroll offset along the axis in the last frame. */
    let lastAlong = 0
    const refresh = (): void => {
      stale = true
      app.invalidate()
    }

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh)
    // Entries of one element share its observation. The last one to go ends it.
    const counts = new Map<Element, number>()
    const observe = (element: Element): void => {
      const count = counts.get(element) ?? 0
      counts.set(element, count + 1)
      if (!count) observer?.observe(element)
    }
    const unobserve = (element: Element): void => {
      const count = (counts.get(element) ?? 1) - 1
      if (count) counts.set(element, count)
      else if (counts.delete(element)) observer?.unobserve(element)
    }
    if (typeof document !== 'undefined') {
      observe(document.body)
      window.addEventListener('resize', refresh, { signal: app.abortSignal })
      document.fonts?.ready.then(refresh, noop)
      onBodySwap(app, (body, previous) => {
        unobserve(previous)
        observe(body)
        refresh()
      })
    }
    app.onDispose(() => {
      observer?.disconnect()
      counts.clear()
      entries.clear()
    })

    const readBox = (entry: Entry, scrollX: number, scrollY: number): void => {
      const box = entry.element.getBoundingClientRect()
      entry.pageX = box.left + scrollX
      entry.pageY = box.top + scrollY
      entry.width = box.width
      entry.height = box.height
    }

    app.system(
      'layout',
      () => {
        const { x: scrollX, y: scrollY, axis } = scroll.state
        const width = stage.width.peek()
        const height = stage.height.peek()
        // Progress, pin and nearness run along the scroll axis, so a horizontal source measures
        // by width. Sticky bands are stored along it too, so a new axis re-measures.
        if (horizontal !== (axis === 'x')) {
          horizontal = !horizontal
          stale = true
        }
        const along = horizontal ? scrollX : scrollY
        const size = horizontal ? width : height
        // Reads only in this pass, so layout is forced at most once.
        const positions = stale ? new Map<Element, string>() : undefined
        // Cached boxes cannot be trusted to say what is near after a jump.
        const jumped = Math.abs(along - lastAlong) > size
        stale = false
        lastAlong = along
        for (const entry of entries) {
          if (positions) {
            // Full measure after a layout change: the box and what moves it.
            readBox(entry, scrollX, scrollY)
            entry.version++
            const container = stickyContainer(entry.element, positions)
            const band =
              container && container !== 'fixed' ? container.getBoundingClientRect() : undefined
            entry.live = entry.manual || container !== null
            // A fixed element is near everywhere, one that is not sticky only by its own box.
            const unbounded = container ? Infinity : -Infinity
            entry.start = band ? (horizontal ? band.left : band.top) + along : -unbounded
            entry.end = band ? (horizontal ? band.right : band.bottom) + along : unbounded
          } else if (entry.live) {
            const start = horizontal ? entry.pageX : entry.pageY
            const end = start + (horizontal ? entry.width : entry.height)
            if (
              jumped ||
              isNear(entry.start, entry.end, along, size) ||
              isNear(start, end, along, size)
            ) {
              readBox(entry, scrollX, scrollY)
            }
          }
          // Viewport box, visibility, progress and pin from the cached page box.
          entry.x = entry.pageX - scrollX
          entry.y = entry.pageY - scrollY
          entry.visible =
            entry.width > 0 &&
            entry.x < width &&
            entry.x + entry.width > 0 &&
            entry.y < height &&
            entry.y + entry.height > 0
          const at = horizontal ? entry.x : entry.y
          const length = horizontal ? entry.width : entry.height
          entry.progress = Math.min(1, Math.max(0, (size - at) / (size + length || 1)))
          const travel = length - size
          entry.pin = travel > 0 ? Math.min(1, Math.max(0, -at / travel)) : at <= 0 ? 1 : 0
        }
      },
      { name: 'anchors' },
    )

    return {
      refresh,
      track(element, options) {
        const manual = options?.live === true
        const entry: Entry = {
          element,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          visible: false,
          progress: 0,
          pin: 0,
          version: 0,
          pageX: 0,
          pageY: 0,
          manual,
          live: manual,
          start: Infinity,
          end: -Infinity,
          dispose() {
            if (entries.delete(entry)) unobserve(element)
          },
        }
        entries.add(entry)
        observe(element)
        refresh()
        return entry
      },
    }
  },
})
