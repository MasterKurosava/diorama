// A sheet of single glyphs drawn once in the element's font and colour, and texture reads of it.
// Shared by the effects that draw letters other than the ones laid out: scramble and split-flap.
import { max, sRGBTransferEOTF, texture } from 'three/tsl'
import { CanvasTexture, type Node, type Texture } from 'three/webgpu'
import { fontOf } from './raster'

/** Longest side of the glyph sheet in device px. */
const SIDE = 2048

/** The element's font at `size` px. */
export const fontAt = (style: CSSStyleDeclaration, size: number): string =>
  fontOf({
    fontStyle: style.fontStyle,
    fontStretch: style.fontStretch,
    fontWeight: style.fontWeight,
    fontSize: `${size}px`,
    fontFamily: style.fontFamily,
  } as CSSStyleDeclaration)

/** The glyphs drawn once in a grid, each centred in its cell. */
export interface Sheet {
  readonly canvas: HTMLCanvasElement
  readonly count: number
  readonly cols: number
  /** Cell width and height, baseline from the cell top, font size: device px. */
  readonly cell: readonly [number, number, number, number]
  /** Advance of each glyph, device px. */
  readonly widths: readonly number[]
  /** Mean advance of the glyphs, device px. */
  readonly mean: number
}

/** Draws `glyphs` in the font and colour of `element` at `em` CSS px, `ratio` device px per px. */
export function sheet(
  element: Element,
  glyphs: readonly string[],
  em: number,
  ratio: number,
): Sheet | undefined {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const style = getComputedStyle(element)
  let size = Math.max(4, em * ratio)
  let cols = 1
  let cell: [number, number, number, number] = [1, 1, 0, size]
  let widths: number[] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    ctx.font = fontAt(style, size)
    const reference = ctx.measureText('Mg')
    const ascent = reference.fontBoundingBoxAscent || size * 0.8
    const descent = reference.fontBoundingBoxDescent || size * 0.2
    widths = glyphs.map((glyph) => ctx.measureText(glyph).width)
    const widest = Math.max(...widths, size * 0.3)
    const pad = Math.ceil(size * 0.15)
    cell = [Math.ceil(widest + pad * 2), Math.ceil(ascent + descent + pad * 2), pad + ascent, size]
    cols = Math.max(1, Math.min(glyphs.length, Math.floor(SIDE / cell[0])))
    if (Math.ceil(glyphs.length / cols) * cell[1] <= SIDE) break
    size *= 0.7
  }
  canvas.width = cols * cell[0]
  canvas.height = Math.max(1, Math.ceil(glyphs.length / cols)) * cell[1]
  // Setting the size resets the state.
  ctx.font = fontAt(style, size)
  ctx.fillStyle = style.getPropertyValue('-webkit-text-fill-color') || style.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  glyphs.forEach((glyph, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    ctx.fillText(glyph, (col + 0.5) * cell[0], row * cell[1] + cell[2])
  })
  const mean = widths.reduce((a, b) => a + b, 0) / Math.max(1, widths.length) || size * 0.6
  return { canvas, count: glyphs.length, cols, cell, widths, mean }
}

function canvasTexture(canvas: HTMLCanvasElement, anisotropy: number): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  map.anisotropy = anisotropy
  return map
}

/**
 * Texture reads of one canvas; `set` swaps the texture under all of them. `anisotropy` keeps a
 * read whose footprint is long one way sharp the other way.
 */
export function sampler(
  canvas: HTMLCanvasElement,
  anisotropy = 1,
): {
  read: (uv: Node<'vec2'>) => Node<'vec4'>
  set: (canvas: HTMLCanvasElement) => void
  dispose: () => void
} {
  let current: Texture = canvasTexture(canvas, anisotropy)
  const nodes: { value: Texture }[] = []
  return {
    read: (uv) => {
      const node = texture(current, uv)
      nodes.push(node as unknown as { value: Texture })
      return node as unknown as Node<'vec4'>
    },
    set: (next) => {
      const old = current
      current = canvasTexture(next, anisotropy)
      for (const node of nodes) node.value = current
      old.dispose()
    },
    dispose: () => current.dispose(),
  }
}

/** A premultiplied sRGB sample as linear colour and alpha. */
export function linear(sample: Node<'vec4'>): { rgb: Node<'vec3'>; a: Node<'float'> } {
  return { rgb: sRGBTransferEOTF(sample.rgb.div(max(sample.a, 1e-4))) as Node<'vec3'>, a: sample.a }
}
