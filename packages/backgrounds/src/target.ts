// Dev notes shared by the background effects that draw over their whole box.
import type { EffectContext } from '@dioramajs/effects'

/** Elements and canvases already noted, so each note shows once. */
const noted = new WeakSet<object>()

/** The copy hides the element's children, and a canvas over the page covers content over the box. */
export function checkTarget(
  ctx: Pick<EffectContext, 'element' | 'app' | 'render'>,
  name: string,
): void {
  const { element, app } = ctx
  if ((element.children.length || element.textContent?.trim()) && !noted.has(element)) {
    noted.add(element)
    app.log.warn(
      `EFFECT_TARGET: ${name} hides the element and everything in it: put it on an empty element behind the content`,
      element,
    )
  }
  const canvas = ctx.render.renderer.domElement
  if (canvas?.isConnected && !noted.has(canvas)) {
    noted.add(canvas)
    if (!(Number.parseFloat(getComputedStyle(canvas).zIndex) < 0)) {
      app.log.warn(
        `${name}: the canvas is over the page, so content over the element is covered: start({ canvas: 'behind' })`,
        element,
      )
    }
  }
}
