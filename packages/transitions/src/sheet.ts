import type { PluginApp, StageApi } from '@dioramajs/core'

// Numbers in use by apps on the page. A duplicate view-transition-name aborts the transition.
const numbers = new Set<number>()

const rules = (id: number): string =>
  `canvas[data-dio-vt="${id}"]{view-transition-name:dio-stage-${id}}` +
  `::view-transition-group(dio-stage-${id}){animation:none}` +
  `::view-transition-old(dio-stage-${id}){animation:none;opacity:0}` +
  `::view-transition-new(dio-stage-${id}){animation:none;opacity:1}`

/**
 * Gives the canvas its own group in browser view transitions, with the old snapshot hidden and
 * the live canvas shown. Applied only once `render` runs, because reading `stage.canvas` earlier
 * would create a canvas on every page.
 */
export function stageSheet(app: PluginApp<{ readonly stage: StageApi }>): void {
  /** This app's number, 0 until the sheet is applied. */
  let number = 0
  let canvas: HTMLCanvasElement | undefined
  let sheet: CSSStyleSheet | undefined
  const apply = (): void => {
    if (number || !app.has('render') || typeof CSSStyleSheet !== 'function') return
    canvas = app.stage.canvas
    // Its own group would draw a canvas that sits behind the page over it, so leave it unnamed.
    if (!canvas || Number(getComputedStyle(canvas).zIndex) < 0) return
    while (numbers.has(++number));
    numbers.add(number)
    canvas.setAttribute('data-dio-vt', String(number))
    sheet = new CSSStyleSheet()
    sheet.replaceSync(rules(number))
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  }
  apply()
  app.on('plugin:status', ({ name, status }) => {
    if (name === 'render' && status === 'running') apply()
  })
  app.onDispose(() => {
    if (!number) return
    numbers.delete(number)
    canvas?.removeAttribute('data-dio-vt')
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((other) => other !== sheet)
  })
}
