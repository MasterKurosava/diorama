import type { AppCore, Off } from '../kernel/types'

const KEYFRAMES = 'dio-stage-scroll'
/** Scroll covered by the follow animation, px. Past it the canvas stays put. */
const RANGE = 1_000_000
let sheet: CSSStyleSheet | undefined

/** Starts following a canvas; `hold` keeps it still while a predicate is true. */
export interface Follow {
  (canvas: HTMLCanvasElement): void
  hold(held: () => boolean): Off
}

/**
 * Lets a fixed canvas follow page scroll on the compositor. A scroll timeline applies
 * `translateY(-scroll)` in every compositor frame, and each Diorama frame adds back, through
 * `translate`, the scroll it drew at. Between frames the canvas moves with the page by the
 * scroll the frame has not seen yet.
 *
 * Content that stands still on screen (a pinned sticky stage) would ride that scroll and jump
 * back when the frame lands, so while any `hold` predicate is true the canvas drops the
 * animation and stays fixed to the viewport, and frames draw at scroll 0. Predicates run in
 * `afterRender`, after the frame's layout reads, and the animation and the offset switch in
 * that same frame. Needs a DOM.
 */
export function followScroll(app: Pick<AppCore, 'system'>): Follow {
  const root = document.documentElement
  const holds = new Set<() => boolean>()
  let followed: { canvas: HTMLCanvasElement; computed: CSSStyleDeclaration } | undefined
  /** The site's styles keep the animation. */
  let animated = false
  /** The page scroll this frame draws at. */
  let drawnAt = 0
  /** A hold has dropped the animation. */
  let held = false
  /** The offset last written to `translate`. */
  let written = 0
  app.system(
    'layout',
    () => {
      if (!followed) return
      adoptKeyframes()
      // A stylesheet that drops the animation (`animation: none !important`) turns following
      // off. While held the computed name is the hold's own `none`, so the last reading stays.
      if (!held) {
        const { animationName, animationTimeline } = followed.computed
        animated = animationName === KEYFRAMES && animationTimeline?.startsWith('scroll(') !== false
      }
      // The timeline is clamped to the scroll range, rubber-band overscroll is not.
      const max = root.scrollHeight - root.clientHeight
      drawnAt = animated ? Math.max(0, Math.min(window.scrollY, max, RANGE)) : 0
    },
    { name: 'stage' },
  )
  app.system(
    'afterRender',
    () => {
      if (!followed) return
      let hold = false
      if (animated) {
        for (const predicate of holds) if (predicate()) hold = true
      }
      if (hold !== held) {
        held = hold
        followed.canvas.style.animationName = hold ? 'none' : KEYFRAMES
      }
      const offset = hold ? 0 : drawnAt
      if (offset === written) return
      written = offset
      followed.canvas.style.translate = offset ? `0px ${offset}px` : ''
    },
    { name: 'stage' },
  )
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
  return follow
}

/** Adopts the keyframes, again if a site reassigns `document.adoptedStyleSheets`. */
function adoptKeyframes(): void {
  if (!sheet) {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(`@keyframes ${KEYFRAMES} { to { transform: translateY(-${RANGE}px) } }`)
  }
  const sheets = document.adoptedStyleSheets
  if (!sheets.includes(sheet)) document.adoptedStyleSheets = [...sheets, sheet]
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
