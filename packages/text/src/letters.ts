// The letters of an element's text drawn one by one into the cells of an atlas, with a relief map
// of their bevels: each letter carries all of its ink and its own shape however far it moves from
// its neighbours. Used by keycaps, magnet, orbit and physics; runs only in their chunks.
import type { EffectContext, ParamSpec } from '@dioramajs/effects'
import { DEV } from '@dioramajs/effects/kit'
import {
  apply,
  fonts,
  type Glyph,
  lines,
  MAX_SIDE,
  MAX_UNITS,
  measure,
  metrics,
  type Run,
  unsupported,
} from './raster'

/**
 * Scripts whose letters join or reorder: one fillText per letter would draw their isolated
 * forms, so a whole word is one piece.
 */
const JOINED = /[؀-ࣿऀ-෿ༀ-࿿က-႟ក-៿᠀-᢯ﭐ-﷿ﹰ-﻿]/

/** One letter, or one word of a joined script, in its own cell. */
export interface Piece {
  /** The cell in box px, y down: the ink and a margin for a blurred shadow. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** The cell's corner in the atlas, atlas px. */
  readonly u: number
  readonly v: number
  /** Centre x of the DOM box, box px. */
  readonly cx: number
  /** Width of the DOM box, px. */
  readonly span: number
  /** Baseline y in box px and the font size in px. */
  readonly base: number
  readonly em: number
  /** The visual line. */
  readonly line: number
}

/** The drawn letters and where they are. */
export interface Atlas {
  readonly canvas: HTMLCanvasElement
  /** Device px per atlas px. */
  readonly scale: number
  /** The atlas in atlas px. */
  readonly size: readonly [number, number]
  readonly pieces: readonly Piece[]
  /** Box width the text was laid out at. */
  readonly width: number
}

interface Draft {
  readonly run: Run
  readonly glyphs: Glyph[]
  readonly text: string
  /** Where fillText draws it, box px. */
  readonly at: number
  x: number
  y: number
  width: number
  height: number
  u: number
  v: number
}

/** Margin around the ink of a cell, px: room for the shadow's blur, and mip levels never mix letters. */
export const margin = (em: number): number => Math.ceil(em * 0.16) + 2

/** Delay before drawing again after a change, ms; while the DOM shows, up to this idle timeout. */
const REDO_DELAY = 150
const REDO_IDLE_TIMEOUT = 1000

/**
 * Lays the element's text out from the DOM and draws each letter into its own cell, at `ratio`
 * device px per CSS px, at most MAX_SIDE device px a side. 'many' past MAX_UNITS letters;
 * undefined without a 2D canvas.
 */
export function atlas(element: Element, ratio: number): Atlas | 'many' | undefined {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const box = element.getBoundingClientRect()
  const runs = measure(element, box)
  metrics(ctx, runs)
  lines(runs)
  if (runs.reduce((n, r) => n + r.glyphs.length, 0) > MAX_UNITS) return 'many'

  const drafts: Draft[] = []
  for (const run of runs) {
    apply(ctx, run.style)
    // A letter drawn alone: its spacing is already in where the DOM put it.
    ctx.letterSpacing = '0px'
    const rtl = run.style.direction === 'rtl'
    const groups: Glyph[][] = []
    for (const glyph of run.glyphs) {
      const last = groups.at(-1)
      const prev = last?.at(-1)
      if (last && prev?.word === glyph.word && JOINED.test(glyph.text + prev.text)) last.push(glyph)
      else groups.push([glyph])
    }
    const pad = margin(run.em)
    for (const glyphs of groups) {
      const text = glyphs.map((glyph) => glyph.text).join('')
      const first = glyphs[0] as Glyph
      const at = rtl ? first.right : first.left
      const inkBox = ctx.measureText(text)
      // The ink, from the canvas metrics: past the DOM box for italics and tight tracking.
      const left = Math.floor(Math.min(at - inkBox.actualBoundingBoxLeft, first.left)) - pad
      const right =
        Math.ceil(
          Math.max(at + inkBox.actualBoundingBoxRight, ...glyphs.map((glyph) => glyph.right)),
        ) + pad
      const top = Math.floor(run.base - inkBox.actualBoundingBoxAscent) - pad
      const bottom = Math.ceil(run.base + inkBox.actualBoundingBoxDescent) + pad
      drafts.push({
        run,
        glyphs,
        text,
        at,
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
        u: 0,
        v: 0,
      })
    }
  }

  // Shelves of cells in reading order, about square. The margins of neighbours keep them apart.
  const area = drafts.reduce((n, draft) => n + draft.width * draft.height, 0)
  const shelf = Math.max(1, ...drafts.map((draft) => draft.width), Math.ceil(Math.sqrt(area) * 1.2))
  let x = 0
  let y = 0
  let row = 0
  for (const draft of drafts) {
    if (x + draft.width > shelf) {
      x = 0
      y += row
      row = 0
    }
    draft.u = x
    draft.v = y
    x += draft.width
    row = Math.max(row, draft.height)
  }
  const atlasWidth = shelf
  const atlasHeight = Math.max(1, y + row)
  const scale = Math.min(ratio, MAX_SIDE / Math.max(atlasWidth, atlasHeight))
  canvas.width = Math.max(1, Math.ceil(atlasWidth * scale))
  canvas.height = Math.max(1, Math.ceil(atlasHeight * scale))
  // Setting the size resets the state.
  for (const draft of drafts) {
    ctx.setTransform(scale, 0, 0, scale, (draft.u - draft.x) * scale, (draft.v - draft.y) * scale)
    apply(ctx, draft.run.style)
    ctx.letterSpacing = '0px'
    ctx.save()
    ctx.beginPath()
    ctx.rect(draft.x, draft.y, draft.width, draft.height)
    ctx.clip()
    ctx.fillText(draft.text, draft.at, draft.run.base)
    ctx.restore()
  }
  const pieces = drafts.map((draft): Piece => {
    const left = Math.min(...draft.glyphs.map((g) => g.left))
    const right = Math.max(...draft.glyphs.map((g) => g.right))
    return {
      x: draft.x,
      y: draft.y,
      width: draft.width,
      height: draft.height,
      u: draft.u,
      v: draft.v,
      cx: (left + right) / 2,
      span: right - left,
      base: draft.run.base,
      em: draft.run.em,
      line: draft.run.line,
    }
  })
  return {
    canvas,
    scale,
    size: [canvas.width / scale, canvas.height / scale],
    pieces,
    width: box.width,
  }
}

/** A relief of flat letters, while the real one is not drawn yet. */
export function flat(): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = 1
  out.height = 1
  const ctx = out.getContext('2d')
  if (ctx) {
    ctx.fillStyle = 'rgb(128, 128, 0)'
    ctx.fillRect(0, 0, 1, 1)
  }
  return out
}

/**
 * The bevel of every letter as a picture the size of the atlas: the surface normal in red and
 * green (0.5 is flat), the height in blue. A chamfer distance in from the edge of the ink, `bevel`
 * atlas px wide, rounded over. Flat where the pixels cannot be read.
 */
export function relief(drawn: Atlas, bevel: number): HTMLCanvasElement {
  const { width: cols, height: rows } = drawn.canvas
  const out = document.createElement('canvas')
  const ctx = out.getContext('2d')
  const source = drawn.canvas.getContext('2d')?.getImageData(0, 0, cols, rows).data
  const image = ctx?.createImageData?.(cols, rows)
  if (!ctx || !image || !source || source.length < cols * rows * 4 || cols < 3 || rows < 3)
    return flat()
  out.width = cols
  out.height = rows
  // Distances past the bevel do not matter: they stop there. The outermost pixels are margin.
  const width = Math.max(1, bevel * drawn.scale)
  const cap = width + 2
  const dist = new Float32Array(cols * rows)
  for (let i = 0; i < cols * rows; i++) dist[i] = (source[i * 4 + 3] as number) >= 128 ? cap : 0
  const diagonal = Math.SQRT2
  for (let y = 1; y < rows - 1; y++)
    for (let x = 1, i = y * cols + 1; x < cols - 1; x++, i++) {
      const current = dist[i] as number
      if (!current) continue
      const left = (dist[i - 1] as number) + 1
      const up = (dist[i - cols] as number) + 1
      const upLeft = (dist[i - cols - 1] as number) + diagonal
      const upRight = (dist[i - cols + 1] as number) + diagonal
      dist[i] = Math.min(current, left, up, upLeft, upRight)
    }
  for (let y = rows - 2; y > 0; y--)
    for (let x = cols - 2, i = y * cols + cols - 2; x > 0; x--, i--) {
      const current = dist[i] as number
      if (!current) continue
      const right = (dist[i + 1] as number) + 1
      const down = (dist[i + cols] as number) + 1
      const downRight = (dist[i + cols + 1] as number) + diagonal
      const downLeft = (dist[i + cols - 1] as number) + diagonal
      dist[i] = Math.min(current, right, down, downRight, downLeft)
    }
  const heights = new Float32Array(cols * rows)
  for (let i = 0; i < cols * rows; i++) {
    // Half a pixel in at the edge of the ink, by its coverage.
    const inset = ((dist[i] as number) - 0.5 + (source[i * 4 + 3] as number) / 510) / width
    const ramp = Math.min(1, Math.max(0, inset))
    heights[i] = ramp * (2 - ramp)
  }
  // The bevel rises about 0.7 of its width.
  const slopeScale = width * 0.35
  const pixels = image.data
  pixels.fill(128)
  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i - 1] = 0
    pixels[i] = 255
  }
  for (let y = 1; y < rows - 1; y++)
    for (let x = 1, i = y * cols + 1; x < cols - 1; x++, i++) {
      const here = heights[i] as number
      const gx = (heights[i + 1] as number) - (heights[i - 1] as number)
      const gy = (heights[i + cols] as number) - (heights[i - cols] as number)
      if (!gx && !gy && !here) continue
      // y down in the canvas, y up in the normal.
      const normalX = -gx * slopeScale
      const normalY = gy * slopeScale
      const normalLength = Math.sqrt(normalX * normalX + normalY * normalY + 1)
      const texel = i * 4
      pixels[texel] = Math.round((normalX / normalLength) * 127.5 + 127.5)
      pixels[texel + 1] = Math.round((normalY / normalLength) * 127.5 + 127.5)
      pixels[texel + 2] = Math.round(here * 255)
    }
  ctx.putImageData(image, 0, 0)
  return out
}

/** The fill the canvas draws with, as `apply` reads it. */
export const fillOf = (style: CSSStyleDeclaration): string =>
  style.getPropertyValue('-webkit-text-fill-color') || style.color

/** Every text node of the element is filled with the element's own colour. */
export function monochrome(element: Element): boolean {
  const own = fillOf(getComputedStyle(element))
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!(node as Text).data.trim() || !parent || parent === element) continue
    if (fillOf(getComputedStyle(parent)) !== own) return false
  }
  return true
}

/** Why the canvas cannot draw the element's text like the browser, after its fonts load. */
const blocked = async (element: Element): Promise<string | undefined> =>
  unsupported(element) ?? (await fonts(element))

const warn = <P extends ParamSpec>(ctx: EffectContext<P>, reason: string): void => {
  if (DEV) ctx.app.log.warn(`${ctx.name}: ${reason}, the text stays as it is`, ctx.element)
}

/**
 * The element's letters drawn, or undefined when the canvas cannot draw them like the browser or
 * there are too many: the text then stays DOM, with a note in development.
 */
export async function prepare<P extends ParamSpec>(
  ctx: EffectContext<P>,
  ratio: number,
): Promise<Atlas | undefined> {
  const { element, signal } = ctx
  const reason = await blocked(element)
  const drawn = reason ? undefined : atlas(element, ratio)
  if (signal.aborted) return undefined
  if (!drawn || drawn === 'many') {
    if (reason) warn(ctx, `${reason} cannot be drawn`)
    else if (drawn === 'many') warn(ctx, `more than ${MAX_UNITS} letters`)
    ctx.showDom(true)
    return undefined
  }
  return drawn
}

/**
 * Draws the letters again when the text, its fonts or its width change: at once while they move,
 * when the page is idle while the DOM shows (`idle`). `use` gets the new atlas, or undefined while
 * the text cannot be drawn like the browser, which the effect shows as DOM.
 */
export function follow<P extends ParamSpec>(
  ctx: EffectContext<P>,
  ratio: number,
  width: () => number,
  idle: () => boolean,
  use: (next: Atlas | undefined) => void,
): void {
  const { element, signal } = ctx
  let cancel: (() => void) | undefined
  let stuck = false
  const redo = async (): Promise<void> => {
    cancel = undefined
    const reason = await blocked(element)
    if (signal.aborted) return
    const next = reason ? undefined : atlas(element, ratio)
    const why = reason ? `${reason} cannot be drawn` : next === 'many' ? 'too many letters' : ''
    if (why && !stuck) warn(ctx, why)
    stuck = !!why
    if (why) use(undefined)
    else if (next && next !== 'many') use(next)
    ctx.invalidate()
  }
  const schedule = (): void => {
    cancel?.()
    if (idle() && typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(() => void redo(), { timeout: REDO_IDLE_TIMEOUT })
      cancel = () => cancelIdleCallback(id)
    } else {
      const id = setTimeout(() => void redo(), REDO_DELAY)
      cancel = () => clearTimeout(id)
    }
  }
  ctx.onDispose(() => cancel?.())
  const text = new MutationObserver(schedule)
  text.observe(element, { characterData: true, childList: true, subtree: true })
  ctx.onDispose(() => text.disconnect())
  const resize = new ResizeObserver(() => {
    if (Math.abs(element.getBoundingClientRect().width - width()) > 0.5) schedule()
  })
  resize.observe(element)
  ctx.onDispose(() => resize.disconnect())
  document.fonts?.addEventListener('loadingdone', schedule, { signal })
}
