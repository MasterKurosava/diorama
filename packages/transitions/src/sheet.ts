import type { PluginApp, StageApi } from '@diorama/core'

// Numbers in use by apps on the page. A duplicate view-transition-name aborts the transition.
const numbers = new Set<number>()

const rules = (n: number): string =>
  `canvas[data-dio-vt="${n}"]{view-transition-name:dio-stage-${n}}` +
  `::view-transition-group(dio-stage-${n}){animation:none}` +
  `::view-transition-old(dio-stage-${n}){animation:none;opacity:0}` +
  `::view-transition-new(dio-stage-${n}){animation:none;opacity:1}`

/**
 * Gives the canvas its own group in browser view transitions, with the old snapshot hidden and
 * the live canvas shown. Applied only once `render` runs, because reading `stage.canvas` earlier
 * would create a canvas on every page.
 */
export function stageSheet(app: PluginApp<{ readonly stage: StageApi }>): void {
  let n = 0
  let canvas: HTMLCanvasElement | undefined
  let sheet: CSSStyleSheet | undefined
  const apply = (): void => {
    if (n || !app.has('render') || typeof CSSStyleSheet !== 'function') return
    canvas = app.stage.canvas
    // Its own group would draw a canvas that sits behind the page over it, so leave it unnamed.
    if (!canvas || Number(getComputedStyle(canvas).zIndex) < 0) return
    while (numbers.has(++n));
    numbers.add(n)
    canvas.setAttribute('data-dio-vt', String(n))
    sheet = new CSSStyleSheet()
    sheet.replaceSync(rules(n))
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  }
  apply()
  app.on('plugin:status', ({ name, status }) => {
    if (name === 'render' && status === 'running') apply()
  })
  app.onDispose(() => {
    if (!n) return
    numbers.delete(n)
    canvas?.removeAttribute('data-dio-vt')
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet)
  })
}
