// Colors of the lit text effects: the alpha of a CSS color, the page color behind an element, and
// the raster as a texture. Runs only in their chunks.
import { cssColor } from '@dioramajs/render'
import { CanvasTexture, Color } from 'three/webgpu'

/** Alpha of a computed CSS color: the fourth comma value or the value after a slash, else 1. */
export function alphaOf(value: string): number {
  if (value === 'transparent') return 0
  // Only a fourth component is alpha: rgb(255, 212, 0) is opaque, not "alpha 0".
  const match =
    /\/\s*([\d.]+)(%?)\s*\)$/.exec(value) ??
    /^[a-z]+\(\s*[^,()]+,[^,()]+,[^,()]+,\s*([\d.]+)(%?)\s*\)$/i.exec(value)
  if (!match || /^#/.test(value)) return 1
  const amount = Number.parseFloat(match[1] as string)
  return match[2] ? amount / 100 : amount
}

/** The element that paints the page behind another, and its color if it is a solid one. */
export interface Backdrop {
  readonly element: Element
  /** `#rrggbb`, undefined for a background image. */
  readonly color: string | undefined
}

/**
 * What the page paints behind the element: the closest ancestor (or the element itself) with a
 * background color or image. Undefined when nothing paints one.
 */
export function backdrop(element: Element): Backdrop | undefined {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const style = getComputedStyle(at)
    if (style.backgroundImage && style.backgroundImage !== 'none')
      return { element: at, color: undefined }
    const background = style.backgroundColor
    if (background && alphaOf(background) >= 0.5)
      return { element: at, color: cssColor(background) }
  }
  return undefined
}

/** Linear sRGB of a CSS color, three's working space. */
export const linear = (css: string): Color => new Color(cssColor(css) ?? '#000000')

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
export function atlas(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  return map
}

/** A CSS angle in degrees (0 up, 90 right) as a unit vector in box px, y down. */
export const direction = (deg: number): [number, number] => {
  const radians = (deg * Math.PI) / 180
  return [Math.sin(radians), -Math.cos(radians)]
}
