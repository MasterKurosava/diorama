import type { AppCore, Off } from '../kernel/types'

const KEYFRAMES = 'dio-stage-scroll'
/** Scroll covered by the follow animation, px. Past it the canvas stays put. */
const RANGE = 1_000_000
/** Spans that moved less than this, px, keep their keyframes. */
const SPAN_TOLERANCE = 0.5
let sheet: CSSStyleSheet | undefined
let instances = 0

/** A span of page scroll, px from the top, over which content on screen stands still. */
export type ScrollSpan = readonly [start: number, end: number]

/** Starts following a canvas; `hold` keeps it still while a predicate is true. */
export interface Follow {
  (canvas: HTMLCanvasElement): void
  hold(held: () => boolean): Off
  pin(spans: () => readonly ScrollSpan[]): Off
}

/**
 * Lets a fixed canvas follow page scroll on the compositor. A scroll timeline applies
 * `translateY(-scroll)` in every compositor frame, and each Diorama frame adds back, through
 * `translate`, the scroll it drew at. Between frames the canvas moves with the page by the
 * scroll the frame has not seen yet.
 *
 * Content that stands still on screen would ride that scroll and jump back when the frame lands.
 * `pin` spans (a pinned sticky stage) go into the keyframes: the timeline stops moving the canvas
 * inside them, so it stops and starts on the compositor where CSS sticky does, between frames.
 * A `hold` predicate (content fixed to the viewport) drops the animation while true, and frames
 * draw at scroll 0. Both are read in `afterRender`, after the frame's layout reads, and the
 * animation and the offset switch in that same frame. Needs a DOM.
 */
export function followScroll(app: Pick<AppCore, 'system' | 'onDispose'>): Follow {
  const root = document.documentElement
  const holds = new Set<() => boolean>()
  const pins = new Set<() => readonly ScrollSpan[]>()
  const id = ++instances
  let followed: { canvas: HTMLCanvasElement; computed: CSSStyleDeclaration } | undefined
  /** The site's styles keep the animation. */
  let animated = false
  /** The page scroll this frame draws at. */
  let drawnAt = 0
  /** A hold has dropped the animation. */
  let held = false
  /** The offset last written to `translate`. */
  let written = 0
  /** The spans in the keyframes and the animation name that carries them. */
  let spans: ScrollSpan[] = []
  let name = KEYFRAMES
  let version = 0
  let own: CSSStyleSheet | undefined
  app.system(
    'layout',
    () => {
      if (!followed) return
      adoptKeyframes(own)
      // A stylesheet that drops the animation (`animation: none !important`) turns following
      // off. While held the computed name is the hold's own `none`, so the last reading stays.
      if (!held) {
        const { animationName, animationTimeline } = followed.computed
        animated =
          animationName.startsWith(KEYFRAMES) && animationTimeline?.startsWith('scroll(') !== false
      }
      // The timeline is clamped to the scroll range, rubber-band overscroll is not. The range
      // ends one visible viewport short of the bottom; on phones that grows as the toolbar hides.
      const viewport = window.visualViewport?.height ?? root.clientHeight
      const max = root.scrollHeight - Math.max(viewport, 0)
      drawnAt = animated ? Math.max(0, Math.min(window.scrollY, max, RANGE)) : 0
    },
    { name: 'stage' },
  )
  app.system(
    'afterRender',
    () => {
      if (!followed) return
      const { canvas } = followed
      let hold = false
      if (animated) {
        for (const predicate of holds) if (predicate()) hold = true
      }
      if (animated && !hold) {
        const next = collect(pins)
        if (!sameSpans(next, spans)) {
          spans = next
          if (spans.length) {
            // A new name restarts the animation on the new keyframes in every engine.
            name = `${KEYFRAMES}-${id}-${++version % 2}`
            own ??= new CSSStyleSheet()
            own.replaceSync(pinnedKeyframes(name, spans))
            adoptKeyframes(own)
          } else {
            name = KEYFRAMES
          }
        }
      }
      const wanted = hold ? 'none' : name
      if (held !== hold || canvas.style.animationName !== wanted)
        canvas.style.animationName = wanted
      held = hold
      const offset = hold ? 0 : drawnAt - covered(spans, drawnAt)
      if (offset === written) return
      written = offset
      canvas.style.translate = offset ? `0px ${offset}px` : ''
    },
    { name: 'stage' },
  )
  app.onDispose(() => {
    if (own) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== own)
  })
  const follow = ((canvas) => {
    const computed = startAnimation(canvas)
    if (computed) followed = { canvas, computed }
  }) as Follow
  follow.hold = (predicate) => {
    // Its own entry, so one predicate held twice needs both offs.
    const entry = (): boolean => predicate()
    holds.add(entry)
    return () => void holds.delete(entry)
  }
  follow.pin = (source) => {
    const entry = (): readonly ScrollSpan[] => source()
    pins.add(entry)
    return () => void pins.delete(entry)
  }
  return follow
}

/** All spans, clipped to the animation range, sorted, overlaps merged. */
function collect(pins: Set<() => readonly ScrollSpan[]>): ScrollSpan[] {
  const all: [number, number][] = []
  for (const source of pins) {
    for (const [start, end] of source()) {
      const from = Math.max(0, start)
      const to = Math.min(RANGE, end)
      if (to > from) all.push([from, to])
    }
  }
  all.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of all) {
    const last = merged.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push(span)
  }
  return merged
}

const sameSpans = (a: readonly ScrollSpan[], b: readonly ScrollSpan[]): boolean =>
  a.length === b.length &&
  a.every(([start, end], i) => {
    const [from, to] = b[i] as ScrollSpan
    return Math.abs(start - from) < SPAN_TOLERANCE && Math.abs(end - to) < SPAN_TOLERANCE
  })

/** Scroll below `at` that falls inside the spans. */
function covered(spans: readonly ScrollSpan[], at: number): number {
  let sum = 0
  for (const [start, end] of spans) sum += Math.max(0, Math.min(at, end) - start)
  return sum
}

/** Keyframes that move by the scroll outside the spans and stand still inside them. */
function pinnedKeyframes(name: string, spans: readonly ScrollSpan[]): string {
  const frame = (at: number, by: number): string =>
    `${((at / RANGE) * 100).toFixed(6)}%{transform:translateY(${-by}px)}`
  const frames = [frame(0, 0)]
  let still = 0
  for (const [start, end] of spans) {
    frames.push(frame(start, start - still))
    still += end - start
    frames.push(frame(end, end - still))
  }
  frames.push(frame(RANGE, RANGE - still))
  return `@keyframes ${name}{${frames.join('')}}`
}

/** Adopts the keyframes, again if a site reassigns `document.adoptedStyleSheets`. */
function adoptKeyframes(own?: CSSStyleSheet): void {
  if (!sheet) {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(`@keyframes ${KEYFRAMES} { to { transform: translateY(-${RANGE}px) } }`)
  }
  const sheets = document.adoptedStyleSheets
  const missing = [sheet, own].filter((s): s is CSSStyleSheet => !!s && !sheets.includes(s))
  if (missing.length) document.adoptedStyleSheets = [...sheets, ...missing]
}

/** Starts the scroll-timeline animation on `canvas`. `undefined` if the engine lacks it. */
function startAnimation(canvas: HTMLCanvasElement): CSSStyleDeclaration | undefined {
  // Engines with scroll timelines (Chrome 115, Safari 26) all have constructable stylesheets.
  if (typeof CSS === 'undefined' || !CSS.supports?.('animation-timeline: scroll(root y)')) return
  adoptKeyframes()
  canvas.style.cssText +=
    `animation:${KEYFRAMES} linear both;` +
    `animation-timeline:scroll(root y);animation-range:0px ${RANGE}px`
  return getComputedStyle(canvas)
}
