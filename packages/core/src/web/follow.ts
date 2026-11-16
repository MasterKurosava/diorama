import type { AppCore } from '../kernel/types'

const FOLLOW = 'dio-stage-scroll'
/** Scroll covered by the follow animation, px. Past it the canvas stays put. */
const RANGE = 1_000_000
let sheet: CSSStyleSheet | undefined

/** Adopts the keyframes, again if a site reassigns `document.adoptedStyleSheets`. */
function adopt(): void {
  if (!sheet) {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(`@keyframes ${FOLLOW} { to { transform: translateY(-${RANGE}px) } }`)
  }
  const sheets = document.adoptedStyleSheets
  if (!sheets.includes(sheet)) document.adoptedStyleSheets = [...sheets, sheet]
}

/** Starts the scroll-timeline animation on `canvas`. `undefined` if the engine lacks it. */
function animate(canvas: HTMLCanvasElement): CSSStyleDeclaration | undefined {
  // Engines with scroll timelines (Chrome 115, Safari 26) all have constructable stylesheets.
  if (typeof CSS === 'undefined' || !CSS.supports?.('animation-timeline: scroll(root y)')) return
  adopt()
  canvas.style.cssText +=
    `animation:${FOLLOW} linear both;` +
    `animation-timeline:scroll(root y);animation-range:0px ${RANGE}px`
  return getComputedStyle(canvas)
}

/**
 * Lets a fixed canvas follow page scroll on the compositor. A scroll timeline applies
 * `translateY(-scroll)` in every compositor frame, and each Diorama frame adds back, through
 * `translate`, the scroll it drew at. Between frames the canvas moves with the page by the
 * scroll the frame has not seen yet. Returns a function that starts following a canvas.
 * Needs a DOM.
 */
export function followScroll(app: Pick<AppCore, 'system'>): (canvas: HTMLCanvasElement) => void {
  const root = document.documentElement
  // `drawnAt` is the page scroll this frame draws at, `written` the one last put in `translate`.
  let followed: { canvas: HTMLCanvasElement; computed: CSSStyleDeclaration } | undefined
  let drawnAt = 0
  let written = 0
  app.system(
    'layout',
    () => {
      if (!followed) return
      adopt()
      // A stylesheet that drops the animation (`animation: none !important`) turns following off.
      const { animationName, animationTimeline } = followed.computed
      const on = animationName === FOLLOW && animationTimeline?.startsWith('scroll(') !== false
      // The timeline is clamped to the scroll range, rubber-band overscroll is not.
      const max = root.scrollHeight - root.clientHeight
      drawnAt = on ? Math.max(0, Math.min(window.scrollY, max, RANGE)) : 0
    },
    { name: 'stage' },
  )
  app.system(
    'afterRender',
    () => {
      if (!followed || drawnAt === written) return
      written = drawnAt
      followed.canvas.style.translate = drawnAt ? `0px ${drawnAt}px` : ''
    },
    { name: 'stage' },
  )
  return (canvas) => {
    const computed = animate(canvas)
    if (computed) followed = { canvas, computed }
  }
}
