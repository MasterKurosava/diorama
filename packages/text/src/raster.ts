// The text of an element drawn into a canvas the way the browser laid it out, with the boxes of
// its letters, words or lines. Shared by the effects of the module; runs only in their chunks.
import { alias, aliasOf, widthKeyword } from './alias'

/** What moves as one. */
export type By = 'letter' | 'word' | 'line'

/** One piece of a unit on one line, in box px (y down). A word broken over two lines has two. */
export interface Quad {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Baseline y, the axis the unit tilts around. */
  readonly base: number
  /** Font size in px. */
  readonly em: number
  /** Reading order of the unit; the pieces of one unit share it. */
  readonly order: number
  /** The graphemes of the piece as drawn; empty for a line. */
  readonly text: string
}

/** The drawn text and where its units are. */
export interface Raster {
  readonly canvas: HTMLCanvasElement
  /** The canvas in box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  readonly quads: readonly Quad[]
  /** Number of units. */
  readonly units: number
  /** The unit used: coarser than asked when there were more than MAX_UNITS. */
  readonly by: By
  /** Box width the text was laid out at. */
  readonly width: number
}

/** Past this many units the next coarser unit is used. */
export const MAX_UNITS = 1500
/** Longest canvas side in device px by default; larger text is rastered at a lower ratio. */
export const MAX_SIDE = 2048

export interface Glyph {
  /** As drawn: text-transform applied. */
  readonly text: string
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly word: number
}

/** Glyphs of one text node that sit side by side on one line, drawn with one fillText. */
export interface Run {
  readonly style: CSSStyleDeclaration
  readonly glyphs: Glyph[]
  base: number
  em: number
  inkTop: number
  inkBottom: number
  left: number
  right: number
  /** Ink past the glyph boxes at the ends. */
  padLeft: number
  padRight: number
  /** The canvas lays the run out as wide as the DOM; if not, each glyph is drawn at its box. */
  whole: boolean
  line: number
}

export interface Line {
  readonly base: number
  readonly runs: Run[]
  em: number
  top: number
  bottom: number
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const words = new Intl.Segmenter(undefined, { granularity: 'word' })

/** Text nodes with something visible, in document order. */
function* texts(element: Element): Generator<Text> {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).data.trim() && node.parentElement) yield node as Text
  }
}

const SPACE = /^\s+$/
const LETTER = /[\p{L}\p{N}]/u
const DIGIT = /^\p{N}/u

/** CSS font shorthand of the page font, or of an alias family that pins its width and settings. */
function shorthand(style: CSSStyleDeclaration, family?: string): string {
  const keyword = family ? '' : widthKeyword(style.fontStretch)
  // The canvas takes `oblique` without an angle only.
  const slant = style.fontStyle?.startsWith('oblique') ? 'oblique' : style.fontStyle || 'normal'
  return `${slant} ${keyword ? `${keyword} ` : ''}${style.fontWeight || '400'} ${style.fontSize} ${family ?? style.fontFamily}`
}

/** CSS font shorthand for the canvas: with the alias `fonts` loaded, if the style needs one. */
export const fontOf = (style: CSSStyleDeclaration): string => shorthand(style, aliasOf(style))

export function apply(ctx: CanvasRenderingContext2D, style: CSSStyleDeclaration): void {
  const spacing = style.letterSpacing
  const rtl = style.direction === 'rtl'
  // Browsers without letterSpacing or fontVariantCaps lay the run out narrower: see `whole`.
  Object.assign(ctx, {
    font: fontOf(style),
    fontKerning: style.fontKerning || 'auto',
    fontVariantCaps: style.fontVariantCaps || 'normal',
    letterSpacing: !spacing || spacing === 'normal' ? '0px' : spacing,
    fillStyle: style.getPropertyValue('-webkit-text-fill-color') || style.color,
    direction: rtl ? 'rtl' : 'ltr',
    textAlign: rtl ? 'right' : 'left',
    textBaseline: 'alphabetic',
  })
}

/** Applies text-transform to one grapheme; `first` is the first letter of a word. */
function cased(text: string, transform: string, first: boolean, lang: string | undefined): string {
  if (transform === 'uppercase' || (transform === 'capitalize' && first))
    return text.toLocaleUpperCase(lang)
  if (transform === 'lowercase') return text.toLocaleLowerCase(lang)
  return text
}

/**
 * What the canvas cannot draw like the browser: on such an element the text stays DOM. Undefined
 * when everything is supported.
 */
export function unsupported(element: Element): string | undefined {
  const seen = new Set<Element>()
  const styles: CSSStyleDeclaration[] = []
  const add = (el: Element | null): void => {
    // background-clip is not inherited: check every element between the text and the target.
    for (let at = el; at && !seen.has(at); at = at === element ? null : at.parentElement) {
      seen.add(at)
      styles.push(getComputedStyle(at))
    }
  }
  add(element)
  for (const node of texts(element)) add(node.parentElement)
  for (const s of styles) {
    if (s.backgroundClip === 'text' || s.getPropertyValue('-webkit-background-clip') === 'text')
      return 'background-clip: text'
    if (s.textShadow && s.textShadow !== 'none') return 'text-shadow'
    if (Number.parseFloat(s.getPropertyValue('-webkit-text-stroke-width')) > 0)
      return '-webkit-text-stroke'
    if (s.writingMode && s.writingMode !== 'horizontal-tb') return `writing-mode: ${s.writingMode}`
  }
  return undefined
}

/**
 * Loads every font the text uses, and the alias of each style the canvas font cannot express. The
 * canvas does not wait for a font: it quietly draws with the fallback, so the raster waits instead.
 * Resolves to what cannot be drawn (a width, axes or features of a font the page loads from no
 * readable @font-face): the text stays DOM then.
 */
export async function fonts(element: Element): Promise<string | undefined> {
  const set = document.fonts as FontFaceSet | undefined
  const wanted = new Map<string, Set<string>>()
  const aliases: Promise<string | undefined>[] = []
  for (const node of texts(element)) {
    const style = getComputedStyle(node.parentElement as Element)
    const font = shorthand(style)
    const chars = wanted.get(font) ?? new Set<string>()
    for (const c of node.data) chars.add(c)
    wanted.set(font, chars)
    // Cased both ways: text-transform draws characters the source does not have.
    const { data } = node
    aliases.push(alias(style, data + data.toLocaleUpperCase() + data.toLocaleLowerCase()))
  }
  const [reasons] = await Promise.all([
    Promise.all(aliases),
    set?.load &&
      Promise.all(
        [...wanted].map(([font, chars]) => set.load(font, [...chars].join('')).catch(() => [])),
      ),
  ])
  return reasons.find(Boolean)
}

/** The element's visible glyphs with their boxes, grouped into runs. */
export function measure(element: Element, box: DOMRect): Run[] {
  const runs: Run[] = []
  const range = document.createRange()
  let word = -1
  // Whitespace or the start came last: the next piece starts a word.
  let gap = true
  // The last glyph of the previous text node: a word goes on into the next node only beside it.
  let before: Glyph | undefined
  let capital = false
  for (const node of texts(element)) {
    const parent = node.parentElement as Element
    const style = getComputedStyle(parent)
    if (style.visibility === 'hidden') continue
    const transform = style.textTransform
    const lang = parent.closest('[lang]')?.getAttribute('lang') || undefined
    const rtl = style.direction === 'rtl'
    let run: Run | undefined
    let wordLike = false
    let fresh = true
    for (const piece of words.segment(node.data)) {
      if (SPACE.test(piece.segment)) {
        gap = true
        run = undefined
        continue
      }
      // Punctuation joins its word; word-like pieces side by side (CJK) are words of their own.
      let starts = gap || (piece.isWordLike === true && wordLike)
      gap = false
      wordLike = piece.isWordLike === true
      for (const g of graphemes.segment(piece.segment)) {
        const start = piece.index + g.index
        range.setStart(node, start)
        range.setEnd(node, start + g.segment.length)
        const rect = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0)
        if (!rect) continue
        const left = rect.left - box.left
        const right = rect.right - box.left
        // `<b>Sil</b>ence` is one word; `one<br>two` and text around an inline image are not.
        if (fresh && !starts && before) {
          const beside = Math.abs(rtl ? before.left - right : left - before.right) < 0.5
          if (!beside || rect.top - box.top >= before.bottom || rect.bottom - box.top <= before.top)
            starts = true
        }
        fresh = false
        if (starts || word < 0) {
          word++
          capital = true
        }
        // capitalize: the first letter or digit of a word, a digit taking the turn unchanged.
        const unit = capital && LETTER.test(g.segment)
        if (unit) capital = false
        const glyph: Glyph = {
          text: cased(g.segment, transform, unit && !DIGIT.test(g.segment), lang),
          left,
          right,
          top: rect.top - box.top,
          bottom: rect.bottom - box.top,
          word,
        }
        starts = false
        before = glyph
        const prev = run?.glyphs.at(-1)
        const beside =
          prev &&
          Math.abs(glyph.top - prev.top) < 0.5 &&
          Math.abs(glyph.bottom - prev.bottom) < 0.5 &&
          Math.abs(rtl ? prev.left - glyph.right : glyph.left - prev.right) < 0.5
        if (!run || !beside) {
          // The metrics come in `metrics`.
          run = { style, glyphs: [] } as unknown as Run
          runs.push(run)
        }
        run.glyphs.push(glyph)
      }
    }
  }
  range.detach()
  return runs
}

/** Baseline, ink and ends of each run from the canvas metrics. */
export function metrics(ctx: CanvasRenderingContext2D, runs: readonly Run[]): void {
  for (const run of runs) {
    apply(ctx, run.style)
    const glyphs = run.glyphs
    const first = glyphs[0] as Glyph
    const text = glyphs.map((g) => g.text).join('')
    const measured = ctx.measureText(text)
    run.left = Math.min(...glyphs.map((g) => g.left))
    run.right = Math.max(...glyphs.map((g) => g.right))
    // The DOM box of a glyph is the font's ascent plus descent, each rounded to a pixel.
    const height = first.bottom - first.top
    const ascent = measured.fontBoundingBoxAscent
    const descent = measured.fontBoundingBoxDescent
    const rounded = Math.abs(Math.round(ascent) + Math.round(descent) - height) < 0.01
    run.base =
      first.top + (rounded ? Math.round(ascent) : (height * ascent) / (ascent + descent || 1))
    run.em = Number.parseFloat(run.style.fontSize) || height
    run.inkTop = run.base - measured.actualBoundingBoxAscent
    run.inkBottom = run.base + measured.actualBoundingBoxDescent
    const start = run.style.direction === 'rtl' ? first.right : first.left
    run.padLeft = Math.max(0, run.left - (start - measured.actualBoundingBoxLeft))
    run.padRight = Math.max(0, start + measured.actualBoundingBoxRight - run.right)
    // Within half a px or 1% of the DOM width, the canvas lays the run out like the browser.
    const span = run.right - run.left
    run.whole = Math.abs(measured.width - span) <= Math.max(0.5, span * 0.01)
  }
}

/** Visual lines in reading order, each with a band that holds its ink and no other line's. */
export function lines(runs: readonly Run[]): Line[] {
  const found: Line[] = []
  for (const run of runs) {
    let line = found.at(-1)
    // A baseline half an em away is another line; sub and sup stay on theirs.
    if (!line || Math.abs(run.base - line.base) > run.em * 0.5) {
      line = { base: run.base, runs: [], em: 0, top: run.inkTop, bottom: run.inkBottom }
      found.push(line)
    }
    run.line = found.length - 1
    line.runs.push(run)
    line.em = Math.max(line.em, run.em)
    line.top = Math.min(line.top, run.inkTop)
    line.bottom = Math.max(line.bottom, run.inkBottom)
  }
  for (const line of found) {
    line.top -= 1
    line.bottom += 1
  }
  // Tight leading: neighbours split the overlap halfway.
  for (let i = 1; i < found.length; i++) {
    const above = found[i - 1] as Line
    const below = found[i] as Line
    if (below.base > above.base && above.bottom > below.top) {
      const middle = (above.bottom + below.top) / 2
      above.bottom = middle
      below.top = middle
    }
  }
  return found
}

/** The pieces of every unit. */
function quads(runs: readonly Run[], found: readonly Line[], by: By): Quad[] {
  const out: Quad[] = []
  if (by === 'line') {
    found.forEach((line, order) => {
      const left = Math.min(...line.runs.map((r) => r.left - r.padLeft))
      const right = Math.max(...line.runs.map((r) => r.right + r.padRight))
      const { top, bottom, base, em } = line
      out.push({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        base,
        em,
        order,
        text: '',
      })
    })
    return out
  }
  const orders = new Map<number, number>()
  let letter = 0
  for (const run of runs) {
    const { top, bottom } = found[run.line] as Line
    let piece: { x0: number; x1: number; order: number; text: string } | undefined
    const close = (): void => {
      if (!piece) return
      // Ink past the ends of the run belongs to the pieces there.
      const x0 = piece.x0 - (piece.x0 <= run.left + 0.5 ? run.padLeft : 0)
      const x1 = piece.x1 + (piece.x1 >= run.right - 0.5 ? run.padRight : 0)
      out.push({
        x: x0,
        y: top,
        width: x1 - x0,
        height: bottom - top,
        base: run.base,
        em: run.em,
        order: piece.order,
        text: piece.text,
      })
    }
    for (const g of run.glyphs) {
      let order: number
      if (by === 'letter') order = letter++
      else {
        order = orders.get(g.word) ?? orders.size
        orders.set(g.word, order)
      }
      if (piece?.order === order) {
        piece.x0 = Math.min(piece.x0, g.left)
        piece.x1 = Math.max(piece.x1, g.right)
        piece.text += g.text
      } else {
        close()
        piece = { x0: g.left, x1: g.right, order, text: g.text }
      }
    }
    close()
  }
  return out
}

/**
 * Lays the element's text out from the DOM and draws it into a canvas at `ratio` device px per CSS
 * px, at most `maxSide` device px a side (larger text is rastered at a lower ratio). Undefined
 * without a 2D canvas.
 */
export function raster(
  element: Element,
  want: By,
  ratio: number,
  maxSide: number = MAX_SIDE,
): Raster | undefined {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const box = element.getBoundingClientRect()
  const runs = measure(element, box)
  metrics(ctx, runs)
  const found = lines(runs)
  let by = want
  const letters = runs.reduce((n, r) => n + r.glyphs.length, 0)
  if (by === 'letter' && letters > MAX_UNITS) by = 'word'
  const wordCount = new Set(runs.flatMap((r) => r.glyphs.map((g) => g.word))).size
  if (by === 'word' && wordCount > MAX_UNITS) by = 'line'
  const list = quads(runs, found, by)
  const units = list.reduce((n, q) => Math.max(n, q.order + 1), 0)

  // The canvas covers every piece with two pixels to spare for the mip levels.
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const q of list) {
    x0 = Math.min(x0, q.x)
    y0 = Math.min(y0, q.y)
    x1 = Math.max(x1, q.x + q.width)
    y1 = Math.max(y1, q.y + q.height)
  }
  if (!list.length) [x0, y0, x1, y1] = [0, 0, 1, 1]
  x0 = Math.floor(x0) - 2
  y0 = Math.floor(y0) - 2
  const width = Math.ceil(x1) + 2 - x0
  const height = Math.ceil(y1) + 2 - y0
  const scale = Math.min(ratio, maxSide / Math.max(width, height))
  canvas.width = Math.max(1, Math.ceil(width * scale))
  canvas.height = Math.max(1, Math.ceil(height * scale))
  ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale)
  for (const run of runs) {
    apply(ctx, run.style)
    const rtl = run.style.direction === 'rtl'
    const first = run.glyphs[0] as Glyph
    // A whole run keeps kerning, ligatures and joined scripts as the browser shaped them.
    if (run.whole)
      ctx.fillText(run.glyphs.map((g) => g.text).join(''), rtl ? first.right : first.left, run.base)
    else for (const g of run.glyphs) ctx.fillText(g.text, rtl ? g.right : g.left, run.base)
  }
  return { canvas, frame: [x0, y0, width, height], quads: list, units, by, width: box.width }
}
