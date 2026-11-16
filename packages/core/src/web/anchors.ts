import { definePlugin } from '../kernel/plugin'
import type { Plugin } from '../kernel/types'
import { noop } from '../kernel/util'
import { onBodySwap } from './body'

/** An element's box, kept in sync with the page in the `layout` stage. */
export interface Anchor {
  readonly element: Element
  /** Viewport position and size, CSS px. */
  readonly x: number
  readonly y: number
  readonly width: number
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

export interface TrackOptions {
  /**
   * Re-read the box every frame while near the viewport, to follow transforms and inline
   * `position: fixed`. Elements inside sticky or fixed ancestors are live by themselves.
   */
  readonly live?: boolean
}

export interface AnchorsApi {
  track(element: Element, options?: TrackOptions): Anchor
  /** Re-measures every anchor after a layout change the observers cannot see. */
  refresh(): void
}

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
  manual: boolean
  live: boolean
  /** Page band a sticky element moves within along the axis. Unbounded when fixed, else empty. */
  start: number
  end: number
  dispose(): void
}

/** The box a sticky element moves within (outermost sticky), `fixed`, or nothing. */
const holder = (element: Element, positions: Map<Element, string>): Element | 'fixed' | null => {
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

/** A page band near the viewport along the scroll axis, at scroll offset `at`. */
const near = (start: number, end: number, at: number, size: number): boolean =>
  start - at < 2 * size && end - at > -size

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
    let stale = true
    let horizontal = false
    let last = 0
    const refresh = (): void => {
      stale = true
      app.invalidate()
    }

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh)
    // Entries of one element share its observation. The last one to go ends it.
    const counts = new Map<Element, number>()
    const observe = (el: Element): void => {
      const count = counts.get(el) ?? 0
      counts.set(el, count + 1)
      if (!count) observer?.observe(el)
    }
    const unobserve = (el: Element): void => {
      const count = (counts.get(el) ?? 1) - 1
      if (count) counts.set(el, count)
      else if (counts.delete(el)) observer?.unobserve(el)
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

    const read = (e: Entry, sx: number, sy: number): void => {
      const box = e.element.getBoundingClientRect()
      e.pageX = box.left + sx
      e.pageY = box.top + sy
      e.width = box.width
      e.height = box.height
    }

    app.system(
      'layout',
      () => {
        const { x: sx, y: sy, axis } = scroll.state
        const width = stage.width.peek()
        const height = stage.height.peek()
        // Progress, pin and nearness run along the scroll axis, so a horizontal source measures
        // by width. Sticky bands are stored along it too, so a new axis re-measures.
        if (horizontal !== (axis === 'x')) {
          horizontal = !horizontal
          stale = true
        }
        const s = horizontal ? sx : sy
        const size = horizontal ? width : height
        // Reads only in this pass, so layout is forced at most once.
        const positions = stale ? new Map<Element, string>() : undefined
        // Cached boxes cannot be trusted to say what is near after a jump.
        const jumped = Math.abs(s - last) > size
        stale = false
        last = s
        for (const e of entries) {
          if (positions) {
            read(e, sx, sy)
            e.version++
            const by = holder(e.element, positions)
            const band = by && by !== 'fixed' ? by.getBoundingClientRect() : undefined
            e.live = e.manual || by !== null
            e.start = band ? (horizontal ? band.left : band.top) + s : by ? -Infinity : Infinity
            e.end = band ? (horizontal ? band.right : band.bottom) + s : by ? Infinity : -Infinity
          } else if (e.live) {
            const page = horizontal ? e.pageX : e.pageY
            const end = page + (horizontal ? e.width : e.height)
            if (jumped || near(e.start, e.end, s, size) || near(page, end, s, size)) read(e, sx, sy)
          }
          e.x = e.pageX - sx
          e.y = e.pageY - sy
          e.visible =
            e.width > 0 && e.x < width && e.x + e.width > 0 && e.y < height && e.y + e.height > 0
          const at = horizontal ? e.x : e.y
          const length = horizontal ? e.width : e.height
          e.progress = Math.min(1, Math.max(0, (size - at) / (size + length || 1)))
          const travel = length - size
          e.pin = travel > 0 ? Math.min(1, Math.max(0, -at / travel)) : at <= 0 ? 1 : 0
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
