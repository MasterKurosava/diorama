// For counter: the letters behind the quads of `raster(element, 'letter')`, a sheet of glyphs in
// the element's font, and texture reads that survive a raster swap.
import { max, sRGBTransferEOTF, texture } from 'three/tsl'
import { CanvasTexture, type Node, type Texture } from 'three/webgpu'
import { fontOf } from './raster'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const wordSegments = new Intl.Segmenter(undefined, { granularity: 'word' })
const SPACE = /^\s+$/
const LETTER = /[\p{L}\p{N}]/u

/** One visible letter, in the order raster() lists its quads. */
export interface Letter {
  /** As drawn: text-transform applied. */
  readonly text: string
  /** Offset of the letter in the element's textContent. */
  readonly index: number
  /** The element its text node sits in. */
  readonly parent: Element
}

/** The visible letters of `element`, one per quad of `raster(element, 'letter')`. */
export function letters(element: Element): Letter[] {
  const found: Letter[] = []
  const range = document.createRange()
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const base = offset
    offset += text.data.length
    const parent = text.parentElement
    if (!text.data.trim() || !parent) continue
    const style = getComputedStyle(parent)
    if (style.visibility === 'hidden') continue
    const transform = style.textTransform
    const lang = parent.closest('[lang]')?.getAttribute('lang') || undefined
    for (const piece of wordSegments.segment(text.data)) {
      if (SPACE.test(piece.segment)) continue
      let first = true
      for (const grapheme of graphemes.segment(piece.segment)) {
        const start = piece.index + grapheme.index
        range.setStart(text, start)
        range.setEnd(text, start + grapheme.segment.length)
        if (![...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) continue
        const capital = first && LETTER.test(grapheme.segment)
        if (capital) first = false
        const upper = transform === 'uppercase' || (transform === 'capitalize' && capital)
        const value = upper
          ? grapheme.segment.toLocaleUpperCase(lang)
          : transform === 'lowercase'
            ? grapheme.segment.toLocaleLowerCase(lang)
            : grapheme.segment
        found.push({ text: value, index: base + start, parent })
      }
    }
  }
  range.detach?.()
  return found
}

/** The font of `style` at `size` px, with the alias family when the style needs one. */
export const fontAt = (style: CSSStyleDeclaration, size: number): string =>
  fontOf({
    fontStyle: style.fontStyle,
    fontStretch: style.fontStretch,
    fontWeight: style.fontWeight,
    fontSize: `${size}px`,
    fontFamily: style.fontFamily,
  } as CSSStyleDeclaration)

/** The fill of text in `style`, as the canvas takes it. */
export const fillOf = (style: CSSStyleDeclaration): string =>
  style.getPropertyValue('-webkit-text-fill-color') || style.color

/** Glyphs drawn once in a grid, each centred in its cell on a shared baseline. */
export interface Sheet {
  readonly canvas: HTMLCanvasElement
  readonly count: number
  readonly cols: number
  /** Cell width and height, baseline from the cell top, font size: device px. */
  readonly cell: readonly [number, number, number, number]
  /** Advance of each glyph over the font size. */
  readonly widths: readonly number[]
  /** Highest ink above and lowest below the baseline of any glyph, over the font size. */
  readonly top: number
  readonly bottom: number
}

/** Longest side of a sheet in device px. */
const SIDE = 2048

/** Draws `glyphs` in the font of `style` at `em` px times `ratio`, filled with `fill`. */
export function sheet(
  style: CSSStyleDeclaration,
  glyphs: readonly string[],
  em: number,
  ratio: number,
  fill: string,
): Sheet | undefined {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  let size = Math.max(4, em * ratio)
  let cols = 1
  let cell: [number, number, number, number] = [1, 1, 0, size]
  let widths: number[] = []
  let top = 0.7
  let bottom = 0
  // A sheet past SIDE draws again at 0.7 of the size, a few times at most.
  for (let attempt = 0; attempt < 6; attempt++) {
    ctx.font = fontAt(style, size)
    const reference = ctx.measureText('Mg')
    const ascent = reference.fontBoundingBoxAscent || size * 0.8
    const descent = reference.fontBoundingBoxDescent || size * 0.2
    const metrics = glyphs.map((g) => ctx.measureText(g))
    widths = metrics.map((g) => g.width / size)
    top = Math.max(0, ...metrics.map((g) => g.actualBoundingBoxAscent / size))
    bottom = Math.max(0, ...metrics.map((g) => g.actualBoundingBoxDescent / size))
    const widest = Math.max(...widths, 0.3) * size
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
  ctx.fillStyle = fill
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  glyphs.forEach((g, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    ctx.fillText(g, (col + 0.5) * cell[0], row * cell[1] + cell[2])
  })
  return { canvas, count: glyphs.length, cols, cell, widths, top, bottom }
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  // Premultiplied, so mip levels and filtering do not darken edges.
  map.premultiplyAlpha = true
  return map
}

/** Texture reads of one canvas; `set` swaps the texture under all of them. */
export interface Sampler {
  /** A read at `uv`, at mip `level` when given (for UVs that jump inside a triangle). */
  read(uv: Node<'vec2'>, level?: Node<'float'>): Node<'vec4'>
  set(canvas: HTMLCanvasElement): void
  dispose(): void
}

export function sampler(canvas: HTMLCanvasElement): Sampler {
  let current: Texture = canvasTexture(canvas)
  const nodes: { value: Texture }[] = []
  return {
    read: (uv, level) => {
      const node = level ? texture(current, uv, level) : texture(current, uv)
      nodes.push(node as unknown as { value: Texture })
      return node as unknown as Node<'vec4'>
    },
    set: (next) => {
      const old = current
      current = canvasTexture(next)
      for (const read of nodes) read.value = current
      old.dispose()
    },
    dispose: () => current.dispose(),
  }
}

/** A premultiplied sRGB sample as linear colour and alpha. */
export function linear(c: Node<'vec4'>): { rgb: Node<'vec3'>; a: Node<'float'> } {
  return { rgb: sRGBTransferEOTF(c.rgb.div(max(c.a, 1e-4))) as Node<'vec3'>, a: c.a }
}
