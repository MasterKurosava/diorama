import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, entering, inView, roundedBox } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  asin,
  attribute,
  cos,
  dot,
  float,
  floor,
  fwidth,
  length,
  log2,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { sheet as drawSheet, fillOf, fontAt, letters, linear, type Sheet, sampler } from './cells'
import { fonts, type Quad, type Raster, raster, unsupported } from './raster'

type Style = 'odometer' | 'slot' | 'flip'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<'view' | 'scroll'>
  duration: number
  from: number
  stagger: number
  delay: number
  threshold: number
}
type F = Node<'float'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

// Reading and writing the number

/** A number as the text writes it: where it sits, its value, separators and grouping. */
export interface Written {
  /** Offsets of its first digit and past its last in the text. */
  readonly start: number
  readonly end: number
  readonly value: number
  readonly decimals: number
  /** Group separator as written, '' for none. */
  readonly group: string
  /** Decimal separator as written, '' for none. */
  readonly point: string
  /** Digits in the last integer group, and in the groups before it (2 in Indian grouping). */
  readonly primary: number
  readonly secondary: number
  /** Integer digits as written: more than 1 only with leading zeros, as in 007. */
  readonly width: number
}

/** Characters that may separate groups of digits or the decimals. */
const SEPARATORS = new Set([',', '.', ' ', '\u00a0', '\u202f', '\u2009', "'", '\u2019'])
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
/** Digits a double holds exactly. */
const PRECISION = 15

/**
 * The decimal separator of `lang`, '.' when it is unknown. The page's language decides, never the
 * visitor's: without one, 12,480 is twelve thousand.
 */
function decimalOf(lang: string | undefined): string {
  try {
    const parts = new Intl.NumberFormat(lang || 'en').formatToParts(1.5)
    return parts.find((p) => p.type === 'decimal')?.value ?? '.'
  } catch {
    return '.'
  }
}

/**
 * The first number in `text`, read as written: `12,480`, `99.9`, `4,2` or `1.204.500` in German,
 * `1 204 500`, `12,34,567`. A lone point or comma before exactly three digits groups them unless
 * it is the decimal separator of `lang`. Undefined without digits or past 15 of them.
 */
export function parse(text: string, lang?: string): Written | undefined {
  const first = text.search(/[0-9]/)
  if (first < 0) return undefined
  const runs: string[] = []
  const separators: string[] = []
  let cursor = first
  for (;;) {
    let end = cursor
    while (isDigit(text[end])) end++
    runs.push(text.slice(cursor, end))
    const sep = text[end] as string
    if (!SEPARATORS.has(sep) || !isDigit(text[end + 1])) break
    separators.push(sep)
    cursor = end + 1
  }
  // The last separator is the decimal point: a point or comma that does not also group.
  let point = ''
  const last = separators.at(-1)
  if (last === '.' || last === ',') {
    const before = separators.slice(0, -1)
    if (before.includes(last)) point = ''
    else if (before.length || (runs.at(-1) as string).length !== 3) point = last
    else point = last === decimalOf(lang) ? last : ''
  }
  const intRuns = point ? runs.slice(0, -1) : runs
  const groups = point ? separators.slice(0, -1) : separators
  const fraction = point ? (runs.at(-1) as string) : ''
  const group = groups[0] ?? ''
  const tail = intRuns.slice(1)
  const secondary = tail.length > 1 ? (tail[0] as string).length : 3
  const grouped =
    groups.every((g) => g === group) &&
    (secondary === 2 || secondary === 3) &&
    tail.slice(0, -1).every((r) => r.length === secondary) &&
    (!tail.length ||
      ((tail.at(-1) as string).length === 3 && (intRuns[0] as string).length <= secondary))
  // Runs that do not group like a number ('in 2024 12 people') leave the first run alone.
  const digits = grouped ? intRuns.join('') : (runs[0] as string)
  const decimals = grouped ? fraction.length : 0
  if (digits.length + decimals > PRECISION) return undefined
  const end = grouped
    ? first + intRuns.join(group).length + (point ? 1 + fraction.length : 0)
    : first + digits.length
  return {
    start: first,
    end,
    value: Number(decimals ? `${digits}.${fraction}` : digits),
    decimals,
    group: grouped ? group : '',
    point: decimals ? point : '',
    primary: 3,
    secondary: grouped ? secondary : 3,
    width: digits.length > 1 && digits[0] === '0' ? digits.length : 1,
  }
}

/** `value` written the way `w` is: its separators, grouping, decimals and leading zeros. */
export function format(value: number, w: Written): string {
  const scale = 10 ** w.decimals
  const units = Math.round(Math.max(0, value) * scale)
  const int = String(Math.floor(units / scale)).padStart(w.width, '0')
  let out = int
  if (w.group) {
    const parts: string[] = []
    let rest = int
    let size = w.primary
    while (rest.length > size) {
      parts.unshift(rest.slice(-size))
      rest = rest.slice(0, -size)
      size = w.secondary
    }
    parts.unshift(rest)
    out = parts.join(w.group)
  }
  return w.decimals ? `${out}${w.point}${String(units % scale).padStart(w.decimals, '0')}` : out
}

// Motion, in digits of each column and seconds since the start

/**
 * Odometer drums for `units` (the value in its smallest decimal): drum 0 turns with the value,
 * each drum above turns only while the one below goes from 9 to 0. One more drum than `n`.
 */
export function wheels(units: number, n: number): number[] {
  const positions = [Math.max(0, units)]
  for (let drum = 1; drum <= n; drum++) {
    const below = positions[drum - 1] as number
    const turn = below - 10 * Math.floor(below / 10)
    positions.push(Math.floor(below / 10) + Math.max(0, turn - 9))
  }
  return positions
}

/** backOut, `over` the overshoot strength: a slope of over + 3 at the start. */
const backOut = (u: number, over: number): number => {
  const w = Math.min(1, Math.max(0, u)) - 1
  return 1 + (over + 1) * w ** 3 + over * w ** 2
}

/** Units the odometer settles over: its last drum runs past its digit and back by a fifth. */
const SETTLE = 6

/**
 * The odometer's value in units at `t` of `time` seconds: quartOut, then the last SETTLE units
 * on a backOut whose slope matches it, so the drums slow down, overshoot and settle.
 */
export function odometer(from: number, to: number, time: number, t: number): number {
  if (t <= 0) return from
  if (t >= time) return to
  const range = to - from
  const u = t / time
  const far = Math.abs(range)
  if (far <= SETTLE) return from + range * backOut(u, 1)
  const turn = 1 - (SETTLE / far) ** 0.25
  if (u < turn) return from + range * (1 - (1 - u) ** 4)
  return to - Math.sign(range) * SETTLE * (1 - backOut((u - turn) / (1 - turn), 1))
}

/** Overshoot of a slot reel as it lands. */
const OVER = 2.6
/** Digits a second of a reel at full spin. */
const SPIN = 22

/** The phases of a reel that lands `land` seconds after it starts. */
function phases(land: number): { settle: number; run: number; rise: number; turns: number } {
  const settle = Math.min(0.55, land * 0.45)
  const run = land - settle
  const rise = Math.min(0.2, run * 0.5)
  return { settle, run, rise, turns: run - rise / 2 + settle / (OVER + 3) }
}

/**
 * A slot reel from digit `from` to `to` landing `land` seconds after it starts: its position in
 * digits at `t`, whole turns included. It spins up, runs, slows down and overshoots as it lands.
 */
export function reel(from: number, to: number, land: number, t: number): number {
  const step = (((to - from) % 10) + 10) % 10
  if (land < 0.05) return t > 0 ? from + step : from
  const { settle, run, rise, turns } = phases(land)
  const spins = Math.max(1, Math.round((SPIN * turns - step) / 10))
  if (t <= 0) return from
  if (t >= land) return from + step + 10 * spins
  // The speed that lands on the digit; the settle starts at it (backOut' at 0 is OVER + 3).
  const speed = (step + 10 * spins) / turns
  const spin = (s: number): number =>
    s < rise ? (speed * s * s) / (2 * rise) : speed * (s - rise / 2)
  if (t < run) return from + spin(t)
  return from + spin(run) + ((speed * settle) / (OVER + 3)) * backOut((t - run) / settle, OVER)
}

/** Seconds a flap takes to land with its bounce. */
const LANDING = 0.42

/** Flap angle 0..π over one flip, falling faster as it goes. */
const fall = (u: number): number => Math.PI * Math.min(1, Math.max(0, u)) ** 1.6

/** The last flip: a fall, then a bounce that dies out. */
function land(u: number): number {
  if (u < 0.5) return Math.PI * (Math.max(0, u) / 0.5) ** 1.8
  const v = Math.min(1, (u - 0.5) / 0.5)
  return Math.PI - 0.34 * Math.abs(Math.sin(2 * Math.PI * v)) * (1 - v) ** 1.6
}

/**
 * A flip card from digit `from` (-1 blank) to `to`, landing `time` seconds after it starts: the
 * digits on its two faces and the angle of the falling flap at `t`, 0 at rest.
 */
export function flips(from: number, to: number, time: number, t: number): [number, number, number] {
  const start = Math.max(0, from)
  const step = (((to - start) % 10) + 10) % 10
  const first = Math.max(0.05, time - LANDING)
  // About nine flips a second before the last one, at least one.
  const count = Math.max(1, step + 10 * Math.max(step ? 0 : 1, Math.round((9 * first - step) / 10)))
  const face = (i: number): number => (i <= 0 ? from : (start + i) % 10)
  if (t <= 0) return [from, from, 0]
  if (t >= time) return [to, to, 0]
  if (count > 1 && t < first) {
    // Flips slow down towards the last one.
    const at = (count - 1) * (1 - (1 - t / first) ** 2)
    const i = Math.floor(at)
    return [face(i), face(i + 1), fall(at - i)]
  }
  return [face(count - 1), to, land((t - first) / (time - first))]
}

/** Seconds the drums or cards take to fold back into the text after they land. */
const RETRACT = 0.6
/** Part of it they take to unroll: the rest shows the flat digits, the same as the text. */
const UNROLL = 0.7

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * How far a drum or card stands out of the page at `t`, 0 flat: it rises at the trigger and
 * unrolls after it lands at `land`, flat before the text takes over, so the hand-off shows nothing.
 */
export const fold = (t: number, land: number): number =>
  Math.min(smooth(0, 0.22, t), 1 - smooth(land, land + RETRACT * UNROLL, t))

/** Seconds from the trigger until the number has landed and folded back into the text. */
export function span(
  p: { readonly duration: number; readonly stagger: number; readonly delay: number },
  style: Style,
  digits: number,
): number {
  const later = style === 'odometer' ? 0 : Math.max(0, digits - 1) * p.stagger
  return p.delay + Math.max(p.duration, 0.05) + later + RETRACT
}

// Layout

/** What the effect draws for an element: its raster, number and the quads around it. */
interface Plan {
  readonly raster: Raster
  readonly written: Written
  readonly sheet: Sheet
  /** Letters outside the number (column -1) and separators inside it (the column on their left). */
  readonly flat: readonly { readonly quad: Quad; readonly column: number; readonly glyph: number }[]
  /** Digits of the number with their column, 0 the last. */
  readonly digits: readonly { readonly quad: Quad; readonly column: number }[]
  readonly base: number
  readonly em: number
  readonly spacing: number
  /** Ink centre of the digits, box px. */
  readonly middle: number
  /** Half the ink height of the digits. */
  readonly ink: number
  /** The text colour and what is behind the element. */
  readonly fill: string
  readonly paper: string
  /** Centre of the number, box px. */
  readonly centre: readonly [number, number]
  /** Runs of digits with nothing between them, left and right: a slot window frames each. */
  readonly runs: readonly (readonly [number, number])[]
}

/** The first background colour behind `element` that covers, white when none does. */
function paperOf(element: Element): string {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const value = getComputedStyle(at).backgroundColor
    const parts =
      /\(([^)]*)\)/
        .exec(value)?.[1]
        ?.split(/[\s,/]+/)
        .filter(Boolean) ?? []
    const alpha =
      parts.length > 3
        ? Number.parseFloat(parts[3] as string)
        : value && value !== 'transparent'
          ? 1
          : 0
    if (alpha > 0.5) return cssColor(value) ?? '#ffffff'
  }
  return '#ffffff'
}

/** Lays the plan out from a raster; a reason when the element holds no number to count. */
function planOf(element: Element, layout: Raster, ratio: number): Plan | string {
  const found = letters(element)
  if (found.length !== layout.quads.length) return 'its letters could not be matched'
  const lang = element.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang
  const written = parse(element.textContent ?? '', lang || undefined)
  if (!written) return 'no number in its text'
  const flat: { quad: Quad; column: number; glyph: number }[] = []
  const inside: { quad: Quad; char: string; parent: Element }[] = []
  found.forEach((letter, i) => {
    const quad = layout.quads[i] as Quad
    if (letter.index >= written.start && letter.index < written.end)
      inside.push({ quad, char: letter.text, parent: letter.parent })
    else flat.push({ quad, column: -1, glyph: -1 })
  })
  const digitQuads = inside.filter((g) => isDigit(g.char))
  const head = digitQuads[0]
  if (!head) return 'no number in its text'
  const digits = digitQuads.map((g, i) => ({ quad: g.quad, column: digitQuads.length - 1 - i }))
  const glyphs = [...'0123456789']
  let column = digitQuads.length
  for (const g of inside) {
    if (isDigit(g.char)) column--
    else {
      if (!glyphs.includes(g.char)) glyphs.push(g.char)
      flat.push({ quad: g.quad, column, glyph: glyphs.indexOf(g.char) })
    }
  }
  const style = getComputedStyle(head.parent)
  const fill = fillOf(style)
  const sheet = drawSheet(style, glyphs, head.quad.em, ratio, fill)
  if (!sheet) return 'no 2D canvas'
  const em = head.quad.em
  const base = head.quad.base
  const left = Math.min(...digitQuads.map((d) => d.quad.x))
  const right = Math.max(...digitQuads.map((d) => d.quad.x + d.quad.width))
  const middle = base - ((sheet.top - sheet.bottom) * em) / 2
  return {
    raster: layout,
    written,
    sheet,
    flat,
    digits,
    base,
    em,
    spacing: Number.parseFloat(style.letterSpacing) || 0,
    middle,
    ink: ((sheet.top + sheet.bottom) * em) / 2,
    fill: cssColor(fill) ?? '#000000',
    paper: paperOf(element),
    centre: [(left + right) / 2, middle],
    runs: runsOf(digitQuads.map((d) => d.quad)),
  }
}

/** Digits side by side, as left and right edges: a separator or a space between them splits a run. */
function runsOf(quads: readonly Quad[]): [number, number][] {
  const out: [number, number][] = []
  for (const quad of [...quads].sort((a, b) => a.x - b.x)) {
    const last = out.at(-1)
    if (last && Math.abs(quad.x - last[1]) < 0.5) last[1] = quad.x + quad.width
    else out.push([quad.x, quad.x + quad.width])
  }
  return out
}

// Drawing

/** Rows of the drum and card strips: more keep the curve smooth. */
const ROWS = 24
/** Taps along a turning drum, for its motion blur, and the most blur in digits. */
const TAPS = 10
/** Most blur in digits: past about a third of a digit the strokes smear into streaks. */
const BLUR = 0.32

/** Blur of a drum that turns `speed` digits a frame: a fast one shows a sharp digit, not a streak. */
export const blurOf = (speed: number): number => Math.min(BLUR, speed * 0.9)
/** Perspective of the drums and cards, in font sizes, like CSS perspective on the number. */
const PERSPECTIVE = 7

/** Instanced geometry: a strip of `rows` quads, and these vec4 attributes. */
function strips(rows: number, names: readonly string[], count: number): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  const positions: number[] = []
  for (let row = 0; row <= rows; row++)
    positions.push(-0.5, row / rows - 0.5, 0, 0.5, row / rows - 0.5, 0)
  const index: number[] = []
  for (let row = 0; row < rows; row++)
    index.push(row * 2, row * 2 + 1, row * 2 + 2, row * 2 + 2, row * 2 + 1, row * 2 + 3)
  geometry.setIndex(index)
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  for (const name of names)
    geometry.setAttribute(
      name,
      new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4),
    )
  geometry.instanceCount = count
  return geometry
}

const digitOf = (units: number, c: number): number => Math.floor(units / 10 ** c) % 10
/** Whether column `c` of `units` is a zero before the first digit. */
const leading = (units: number, c: number): boolean => c > 0 && Math.floor(units / 10 ** c) === 0

// Instance attributes, each a vec4, box px.
// Flat letters: box (x, y, width, height); source (raster x, sheet glyph or -1 for the raster,
// shown, 0); font (baseline, em, half advance, 0).
const FLAT = ['flatBox', 'flatSource', 'flatFont']
// Drums: box (left, right, middle, radius); face (wheel position, half advance, blank, blur);
// state (fold, window half height, reach, angle per digit); text (baseline, em, seams, 0).
const DRUM = ['drumBox', 'drumFace', 'drumState', 'drumText']
// Slot windows: box (left, right, middle, half height); look (fold, em, 0, 0).
const FRAME = ['frameBox', 'frameLook']
// Card halves and flaps: tile (left, right, hinge, height); text (half advance, baseline, em,
// kind: 0 top, 1 bottom, 2 flap); face (digit or -1, flap angle, fold, opacity).
const CARD = ['cardTile', 'cardText', 'cardFace']

/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before rastering again after a change, ms; while the DOM shows, up to this idle timeout. */
const REDO_DELAY = 150
const REDO_IDLE_TIMEOUT = 1000

/**
 * A number counts up to its value when it comes into view, on real 3D mechanics: digits on
 * odometer drums, on deep slot reels behind a window, or on flip cards. The drums and cards fold
 * back into the text when they land: the DOM text never changes, and at rest it is the element.
 */
const counter: Effect<Params> = defineEffect({
  name: 'counter',
  params: {
    style: oneOf('odometer', 'slot', 'flip'),
    trigger: oneOf('view', 'scroll'),
    duration: 2,
    from: 0,
    stagger: 0.12,
    delay: 0,
    threshold: 0.3,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal, render } = ctx
    const { stage } = app
    const style = params.style
    const scrubbed = params.trigger === 'scroll'
    const onScreen = (): boolean => {
      const r = element.getBoundingClientRect()
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < stage.height.peek() &&
        r.left < stage.width.peek()
      )
    }
    // As in text-reveal: a number the visitor has seen as DOM stays; a veiled one has not been seen.
    const veiled = (): boolean => !scrubbed && element.getAttribute('data-dio-state') === 'entering'
    let seen = onScreen() && !veiled()
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    const reason = unsupported(element) ?? (await fonts(element))
    const layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()
    const fallback = (why: string): void => {
      if (DEV) app.log.warn(`counter: ${why}, the text stays as it is`, element)
      ctx.showDom(true)
    }
    if (layout?.by !== 'letter') {
      if (reason) fallback(`${reason} cannot be drawn`)
      else if (layout) fallback('more than 1500 letters')
      else ctx.showDom(true)
      return
    }
    const load = async (r: Raster): Promise<Plan | string> => {
      await document.fonts
        ?.load?.(fontAt(getComputedStyle(element), 16), '0123456789')
        .catch(() => [])
      return planOf(element, r, ratio)
    }
    const first = await load(layout)
    if (signal.aborted) return
    if (typeof first === 'string') {
      fallback(first)
      return
    }
    let plan = first

    const frame = uniform(new Vector4(...plan.raster.frame))
    const cell = uniform(new Vector4(...plan.sheet.cell))
    const grid = uniform(
      new Vector3(plan.sheet.cols, plan.sheet.canvas.width, plan.sheet.canvas.height),
    )
    const ink = uniform(new Color(plan.fill))
    const body = uniform(new Color())
    // The number's centre in the box (px, y up from the box centre) and in the world.
    const focus = uniform(new Vector4())
    const distance = uniform(render.camera.position.z || 1000)
    const perspective = uniform(plan.em * PERSPECTIVE)
    const half = u.size.mul(0.5)
    const letterMap = sampler(plan.raster.canvas)
    const sheetMap = sampler(plan.sheet.canvas)
    // Drums reach past the box: the mask is read a little inside it, where its edge is whole.
    const inset = vec2(1.5, 1.5).div(u.size)
    const clip = (px: F, py: F): F =>
      ctx.mask(
        varying(vec2(px.div(u.size.x), py.div(u.size.y).oneMinus())).clamp(inset, inset.oneMinus()),
      )

    /** Where to draw a point at box px x, y (down) and depth z, seen in front of the number. */
    const place = (x: F, y: F, z: F): V3 => {
      const centred = vec3(x.sub(half.x).sub(focus.x), half.y.sub(y).sub(focus.y), z)
      const deep = centred.z.mul(distance).div(perspective)
      const onScreen = centred.xy.sub(focus.zw.mul(deep).div(distance))
      return vec3(onScreen.add(focus.xy), deep) as unknown as V3
    }
    const material = (): MeshBasicNodeMaterial =>
      new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      })
    const corner = positionGeometry.xy.add(0.5)
    const attrs = (names: readonly string[]): V4[] =>
      names.map((n) => attribute(n, 'vec4') as unknown as V4)

    /**
     * The sheet read of the digit that holds wheel position `position` at `x`: digit k fills the
     * positions [k - 0.5, k + 0.5), unrolled `pitch` px a digit around the ink centre. Several taps blur it.
     */
    const wheel = (
      position: F,
      x: F,
      left: F,
      centre: F,
      middle: F,
      pitch: F,
      base: F,
      em: F,
      blank: F,
      blur: F,
      taps = TAPS,
      wrap = true,
    ): V4 => {
      const sheetToBox = em.div(cell.w)
      const cellWidth = cell.x.mul(sheetToBox)
      const cellHeight = cell.y.mul(sheetToBox)
      const baseline = cell.z.mul(sheetToBox)
      const glyphU = x.sub(left.add(centre).sub(cellWidth.mul(0.5))).div(cellWidth)
      const across = select(
        glyphU.greaterThanEqual(0).and(glyphU.lessThanEqual(1)),
        float(1),
        float(0),
      )
      // UVs jump between digits inside a quad, so the mip level comes from the glyph scale.
      const level = log2(max(cell.w.div(em).mul(fwidth(x)), 1))
      let sum: V4 = vec4(0, 0, 0, 0)
      // Taps spread over the blur from a per-pixel offset, so they blend instead of ghosting.
      const jitter = dither().mul(255).add(0.5)
      for (let i = 0; i < taps; i++) {
        const tap = position.add(blur.mul(jitter.add(i).div(taps).sub(0.5)))
        const nearest = floor(tap.add(0.5))
        const y = middle.add(tap.sub(nearest).mul(pitch))
        const glyphV = y.sub(base.sub(baseline)).div(cellHeight)
        const digit = wrap ? nearest.sub(floor(nearest.div(10)).mul(10)) : nearest
        const shown = select(
          blank.greaterThan(0.5).and(abs(nearest).lessThan(0.5)),
          float(0),
          select(glyphV.greaterThanEqual(0).and(glyphV.lessThanEqual(1)), float(1), float(0)),
        )
        const col = digit.sub(floor(digit.div(grid.x)).mul(grid.x))
        const row = floor(digit.div(grid.x))
        const uv = vec2(
          col.add(glyphU.clamp(0, 1)).mul(cell.x).div(grid.y),
          row.add(glyphV.clamp(0, 1)).mul(cell.y).div(grid.z).oneMinus(),
        )
        sum = sum.add(sheetMap.read(uv, level).mul(across.mul(shown))) as V4
      }
      return sum.div(taps) as V4
    }
    /** A glyph over a lit body: straight colour and alpha. */
    const over = (glyph: V4, shade: F, gloss: F, cover: F): V4 => {
      const glyphColor = linear(glyph)
      const alpha = glyphColor.a.add(cover.mul(glyphColor.a.oneMinus()))
      const rgb = glyphColor.rgb
        .mul(glyphColor.a)
        .add(body.mul(cover.mul(glyphColor.a.oneMinus())))
        .div(max(alpha, 1e-4))
        .mul(shade)
        .add(gloss)
      return vec4(rgb, alpha) as unknown as V4
    }
    // Light from above and in front of the viewer, and its half vector for the sheen.
    const lightDir = normalize(vec3(0, 0.55, 1))
    const halfDir = normalize(lightDir.add(vec3(0, 0, 1)))

    // Letters around the number stay flat, from the raster. Separators come from the sheet:
    // a kerned point sits under the arm of a 7, and its quad in the raster holds the arm too.
    const flat = material()
    {
      const [box, source, font] = attrs(FLAT) as [V4, V4, V4]
      const px = box.x.add(corner.x.mul(box.z))
      const py = box.y.add(corner.y.oneMinus().mul(box.w))
      flat.positionNode = vec3(px.sub(half.x), half.y.sub(py), 0)
      const vx = varying(px)
      const vy = varying(py)
      const vBox = varying(box)
      const vSource = varying(source)
      const vFont = varying(font)
      const rasterX = vx.sub(vBox.x).add(vSource.x)
      const fromRaster = letterMap.read(
        vec2(rasterX.sub(frame.x).div(frame.z), vy.sub(frame.y).div(frame.w).oneMinus()),
      )
      const fromSheet = wheel(
        max(vSource.y, 0),
        vx,
        vBox.x,
        vFont.z,
        vy,
        float(1),
        vFont.x,
        vFont.y,
        float(0),
        float(0),
        1,
        false,
      )
      const colour = linear(select(vSource.y.lessThan(-0.5), fromRaster, fromSheet) as V4)
      flat.colorNode = vec4(colour.rgb, colour.a.mul(vSource.z).mul(clip(px, py)))
    }

    // Drums and reels: a horizontal cylinder per digit, its front at the page, unrolling flat as
    // it folds back into the text.
    const drums = material()
    {
      const [box, face, state, text] = attrs(DRUM) as [V4, V4, V4, V4]
      const fold = state.x
      const radius = box.w
      const reach = asin(min(state.z.div(radius), 0.999)).add(0.05)
      const phi = corner.y.mul(2).sub(1).mul(reach)
      const x = mix(box.x, box.y, corner.x)
      const up = mix(radius.mul(phi), radius.mul(sin(phi)), fold)
      const z = radius.mul(cos(phi).sub(1)).mul(fold)
      drums.positionNode = place(x, box.z.sub(up), z)
      const vx = varying(x)
      const vPhi = varying(phi)
      const vy = varying(box.z.sub(up))
      const vBox = varying(box)
      const vFace = varying(face)
      const vState = varying(state)
      const vText = varying(text)
      const vFold = vState.x
      // The digit under each point: the drum turned to `value` brings digit k to angle (value - k) α.
      const position = vFace.x.sub(vPhi.div(vState.w))
      const glyph = wheel(
        position,
        vx,
        vBox.x,
        vFace.y,
        vBox.z,
        vBox.w.mul(vState.w),
        vText.x,
        vText.y,
        vFace.z,
        vFace.w,
      )
      const normal = normalize(vec3(0, sin(vPhi).mul(vFold), mix(float(1), cos(vPhi), vFold)))
      const lit = max(dot(normal, lightDir), 0).div(lightDir.z)
      const curve = cos(vPhi).mul(cos(vPhi))
      const shade = mix(
        float(1),
        min(pow(lit, 2.2).mul(0.78).add(0.22), 1.15).mul(mix(float(1), curve, 0.7)),
        vFold,
      )
      // Seams between flush drums.
      const side = min(vx.sub(vBox.x), vBox.y.sub(vx))
      const seam = mix(
        float(1),
        smoothstep(0, max(vText.y.mul(0.025), 1), side)
          .mul(0.45)
          .add(0.55),
        vFold.mul(vText.z),
      )
      const gloss = pow(max(dot(normal, halfDir), 0), 40)
        .mul(0.12)
        .mul(vFold)
      // The housing shades the drum where it turns out of the window.
      const fromMiddle = abs(vy.sub(vBox.z))
      const housing = mix(
        float(1),
        smoothstep(vState.z, vState.z.mul(0.45), fromMiddle).mul(0.8).add(0.2),
        vFold,
      )
      const litGlyph = over(glyph, shade.mul(seam).mul(housing), gloss, vFold)
      // The window: the digit's own band at rest, the drum's reach while it turns.
      const reachY = mix(vState.y, vState.z, vFold)
      const inside = float(1).sub(smoothstep(reachY.sub(1.5), reachY.add(0.5), fromMiddle))
      drums.colorNode = vec4(litGlyph.xyz, litGlyph.w.mul(inside).mul(clip(vx, vy)))
    }

    // Slot windows: a bezel over each reel with an inner shadow, like a cabinet's glass.
    const frames = material()
    {
      const [box, look] = attrs(FRAME) as [V4, V4]
      const margin = look.y.mul(0.16)
      const x = mix(box.x.sub(margin), box.y.add(margin), corner.x)
      const y = mix(box.z.add(box.w).add(margin), box.z.sub(box.w).sub(margin), corner.y)
      frames.positionNode = vec3(x.sub(half.x), half.y.sub(y), 0)
      const vx = varying(x)
      const vy = varying(y)
      const vBox = varying(box)
      const vLook = varying(look)
      const em = vLook.y
      const size = vec2(vBox.y.sub(vBox.x).mul(0.5), vBox.w)
      const local = vec2(vx.sub(vBox.x.add(vBox.y).mul(0.5)), vy.sub(vBox.z))
      const cornerRadius = em.mul(0.12)
      const edgeDistance = roundedBox(local, size, cornerRadius)
      const ring = max(em.mul(0.045), 1.5)
      const rim = smoothstep(-0.75, 0.75, edgeDistance).mul(
        float(1).sub(smoothstep(ring.sub(0.75), ring.add(0.75), edgeDistance)),
      )
      const lower = vy.sub(vBox.z.sub(vBox.w)).div(vBox.w.mul(2)).clamp(0, 1)
      const rimColor = mix(ink, body, mix(float(0.15), float(0.55), lower.oneMinus()))
      const toEdge = vBox.w.sub(abs(local.y))
      const inner = float(1)
        .sub(smoothstep(0, vBox.w.mul(0.55), toEdge))
        .mul(0.5)
        .mul(select(edgeDistance.lessThan(0), float(1), float(0)))
      const drop = float(1)
        .sub(smoothstep(ring, ring.add(em.mul(0.14)), edgeDistance))
        .mul(0.18)
        .mul(select(edgeDistance.greaterThan(ring), float(1), float(0)))
      const alpha = max(rim, max(inner, drop))
      const rgb = mix(vec3(0, 0, 0), rimColor, rim.div(max(alpha, 1e-4)))
      frames.colorNode = vec4(rgb, alpha.mul(vLook.x).mul(clip(vx, vy)))
    }

    // Flip cards: two halves and a flap that falls about the hinge towards the viewer.
    const cards = material()
    {
      const [tile, text, face] = attrs(CARD) as [V4, V4, V4]
      const kind = text.w
      const isFlap = kind.greaterThan(1.5)
      const isBottom = kind.greaterThan(0.5).and(kind.lessThan(1.5))
      const theta = face.y
      const angle = select(isFlap, theta, select(isBottom, float(Math.PI), float(0)))
      const x = mix(tile.x, tile.y, corner.x)
      const fromHinge = corner.y.mul(tile.w)
      cards.positionNode = place(
        x,
        tile.z.sub(fromHinge.mul(cos(angle))),
        fromHinge.mul(sin(angle)),
      )
      const back = theta.greaterThan(Math.PI / 2)
      const direction = select(
        isFlap,
        select(back, float(1), float(-1)),
        select(isBottom, float(1), float(-1)),
      )
      const vx = varying(x)
      const vFromHinge = varying(fromHinge)
      const vy = varying(tile.z.add(direction.mul(fromHinge)))
      const vTile = varying(tile)
      const vText = varying(text)
      const vFace = varying(face)
      const vKind = vText.w
      const vTheta = vFace.y
      const fold = vFace.z
      // The face as a wheel that does not turn: its digit at its baseline, or nothing.
      const glyph = wheel(
        max(vFace.x, 0),
        vx,
        vTile.x,
        vText.x,
        vy,
        float(1),
        vText.y,
        vText.z,
        float(0),
        float(0),
        1,
      )
      const shown = select(vFace.x.lessThan(-0.5), float(0), float(1))
      const fFlap = vKind.greaterThan(1.5)
      const fBottom = vKind.greaterThan(0.5).and(vKind.lessThan(1.5))
      const along = vFromHinge.div(max(vTile.w, 1e-3))
      const near = smoothstep(0, 0.22, along)
      const upper = mix(float(0.82), float(1), near).mul(along.mul(0.05).add(1))
      const lower = mix(float(0.7), float(0.88), near).mul(along.mul(-0.06).add(1))
      const turn = sin(vTheta)
      const shade = select(
        fFlap,
        select(
          vTheta.greaterThan(Math.PI / 2),
          lower.mul(turn.mul(-0.55).add(1)),
          upper.mul(turn.mul(-0.6).add(1)),
        ),
        select(fBottom, lower.sub(turn.mul(0.5).mul(along.oneMinus())), upper),
      )
      const radius = min(vText.z.mul(0.12), vTile.y.sub(vTile.x).mul(0.25))
      const dxCorner = max(max(vTile.x.add(radius).sub(vx), vx.sub(vTile.y.sub(radius))), 0)
      const dyCorner = max(vFromHinge.sub(vTile.w.sub(radius)), 0)
      const corners = float(0.5)
        .sub(length(vec2(dxCorner, dyCorner)).sub(radius))
        .clamp(0, 1)
      const hair = mix(float(0.2), float(1), smoothstep(0.2, 1.1, vFromHinge))
      const lit = mix(float(1), shade.mul(hair), fold)
      const card = over(glyph.mul(shown) as V4, lit, float(0), fold.mul(corners))
      cards.colorNode = vec4(card.xyz, card.w.mul(vFace.w).mul(clip(vx, vy)))
    }

    const group = new Group()
    const columns = (): number => plan.digits.length
    const meshes = {
      flat: new Mesh(strips(1, FLAT, plan.flat.length), flat),
      drums: new Mesh(strips(ROWS, DRUM, style === 'flip' ? 0 : columns()), drums),
      frames: new Mesh(strips(1, FRAME, style === 'slot' ? plan.runs.length : 0), frames),
      cards: new Mesh(strips(ROWS, CARD, style === 'flip' ? columns() * 3 : 0), cards),
    }
    // Only the parts of the style join the scene, so only they compile and draw.
    const parts = [
      meshes.flat,
      ...(style === 'flip' ? [meshes.cards] : [meshes.drums]),
      ...(style === 'slot' ? [meshes.frames] : []),
    ]
    parts.forEach((mesh, order) => {
      mesh.frustumCulled = false
      mesh.renderOrder = order
      group.add(mesh)
    })
    ctx.onDispose(() => {
      letterMap.dispose()
      sheetMap.dispose()
    })
    ctx.place(group, { fit: 'none', replace: true })

    const total = (): number => span(ctx.params, style, columns())
    const colours = (): void => {
      ink.value.set(plan.fill)
      // A drum a shade off the page, a card a little more.
      const towardInk = style === 'flip' ? 0.13 : style === 'slot' ? 0.05 : 0.09
      body.value.set(new Color(plan.paper).lerp(new Color(plan.fill), towardInk))
    }
    colours()

    let drawnAt = Number.NaN
    /** Writes every instance for the clock, seconds since the trigger. */
    const draw = (clock: number): void => {
      if (clock === drawnAt) return
      drawnAt = clock
      const p = ctx.params
      const t = clock - p.delay
      const time = Math.max(p.duration, 0.05)
      const scale = 10 ** plan.written.decimals
      const count = columns()
      const cap = 10 ** (count - plan.written.decimals) - 1 / scale
      const fromUnits = Math.round(
        Math.min(cap, Math.max(0, Number.isFinite(p.from) ? p.from : 0)) * scale,
      )
      const toUnits = Math.round(plan.written.value * scale)
      const { em } = plan
      const blankable = (c: number): boolean => c - plan.written.decimals >= plan.written.width
      const landOf = (c: number): number => time + (style === 'odometer' ? 0 : c * p.stagger)
      const foldOf = (c: number): number => fold(t, landOf(c))

      // Positions of every column now and a frame ago, for the blur.
      const positionsAt = (s: number): number[] =>
        style === 'odometer'
          ? wheels(odometer(fromUnits, toUnits, time, s), count)
          : Array.from({ length: count + 1 }, (_, c) =>
              c === count ? 0 : reel(digitOf(fromUnits, c), digitOf(toUnits, c), landOf(c), s),
            )
      const now = positionsAt(t)
      const before = positionsAt(t - 1 / 60)
      const blankOf = (c: number): boolean =>
        blankable(c) &&
        (style === 'odometer'
          ? (now[c + 1] as number) <= 0
          : leading(fromUnits, c) && (now[c] as number) < 1)
      /** How much of a column's digit shows: a leading blank turns in as it leaves 0. */
      const shownOf = (c: number): number => {
        if (c < 0 || !blankable(c)) return 1
        if (style === 'flip') return leading(fromUnits, c) && t <= 0 ? 0 : 1
        if (style === 'odometer' && (now[c + 1] as number) > 0) return 1
        if (style !== 'odometer' && !leading(fromUnits, c)) return 1
        return Math.min(1, Math.max(0, now[c] as number))
      }

      const write = (
        mesh: Mesh,
        names: readonly string[],
        rows: readonly (readonly number[])[][],
      ) => {
        const geometry = mesh.geometry as InstancedBufferGeometry
        names.forEach((name, a) => {
          const attr = geometry.getAttribute(name) as InstancedBufferAttribute
          const out = attr.array as Float32Array
          rows.forEach((row, i) => {
            out.set(row[a] as readonly number[], i * 4)
          })
          attr.needsUpdate = true
        })
      }
      write(
        meshes.flat,
        FLAT,
        plan.flat.map(({ quad, column, glyph }) => [
          [quad.x, quad.y, quad.width, quad.height],
          [quad.x, glyph, shownOf(column), 0],
          [quad.base, quad.em, (quad.width - plan.spacing) / 2, 0],
        ]),
      )
      const inkHalf = plan.ink
      const pad = em * 0.06
      if (style === 'flip') {
        const tiles = plan.digits.map(({ quad, column: c }) => {
          const from = leading(fromUnits, c) && blankable(c) ? -1 : digitOf(fromUnits, c)
          const [current, next, theta] = flips(from, digitOf(toUnits, c), landOf(c), t)
          const gap = Math.max(1, em * 0.05)
          const centre = quad.x + (quad.width - plan.spacing) / 2
          const halfWidth = Math.max(1, (quad.width - gap) / 2)
          const tile = [centre - halfWidth, centre + halfWidth, plan.middle, inkHalf + em * 0.2]
          return {
            tile,
            base: plan.base,
            centre: centre - (centre - halfWidth),
            current,
            next,
            theta,
            fold: foldOf(c),
          }
        })
        const idle = (card: (typeof tiles)[number]) =>
          card.current === card.next && card.theta === 0
        const rows: (readonly number[])[][] = []
        for (const card of tiles) {
          const top = idle(card)
            ? 1
            : smooth(0.08 * Math.PI, 0.6 * Math.PI, card.theta) * (1 - card.fold) + card.fold
          const bottom = idle(card)
            ? 1
            : (1 - smooth(0.55 * Math.PI, 0.97 * Math.PI, card.theta)) * (1 - card.fold) + card.fold
          rows.push([
            card.tile,
            [card.centre, card.base, em, 0],
            [card.next, card.theta, card.fold, top],
          ])
          rows.push([
            card.tile,
            [card.centre, card.base, em, 1],
            [card.current, card.theta, card.fold, bottom],
          ])
        }
        for (const card of tiles)
          rows.push([
            card.tile,
            [card.centre, card.base, em, 2],
            [
              card.theta < Math.PI / 2 ? card.current : card.next,
              card.theta,
              card.fold,
              idle(card) ? 0 : 1,
            ],
          ])
        write(meshes.cards, CARD, rows)
      } else {
        const faces = style === 'slot' ? 20 : 10
        const pitch = inkHalf * 2 + em * (style === 'slot' ? 0.3 : 0.2)
        const angle = (2 * Math.PI) / faces
        const radius = pitch / angle
        // About 0.63 em above and below the digits: neighbours peek in, the line box mostly holds it.
        const reach = style === 'slot' ? pitch * 0.62 : radius * 0.43
        const rows = plan.digits.map(({ quad, column: c }) => {
          const pos = now[c] as number
          const speed = Math.abs(pos - (before[c] as number))
          const blank = blankOf(c)
          // A blank drum keeps its position from 0, so step 0 is the blank; others wrap at 10.
          const value = blank ? pos : pos - 10 * Math.floor(pos / 10)
          return [
            [quad.x, quad.x + quad.width, plan.middle, radius],
            [value, (quad.width - plan.spacing) / 2, blank ? 1 : 0, blurOf(speed)],
            [foldOf(c), inkHalf + pad, reach, angle],
            [plan.base, em, 1, 0],
          ]
        })
        write(meshes.drums, DRUM, rows)
        if (style === 'slot')
          write(
            meshes.frames,
            FRAME,
            // A window stays while any reel in it turns.
            plan.runs.map(([left, right]) => [
              [left, right, plan.middle, reach],
              [
                Math.max(
                  0,
                  ...plan.digits
                    .filter(({ quad }) => quad.x >= left - 0.5 && quad.x < right)
                    .map(({ column }) => foldOf(column)),
                ),
                em,
                0,
                0,
              ],
            ]),
          )
      }
    }

    const use = (next: Plan): void => {
      plan = next
      const swap = (mesh: Mesh, rows: number, names: readonly string[], count: number) => {
        const old = mesh.geometry
        mesh.geometry = strips(rows, names, count)
        old.dispose()
      }
      swap(meshes.flat, 1, FLAT, next.flat.length)
      swap(meshes.drums, ROWS, DRUM, style === 'flip' ? 0 : columns())
      swap(meshes.frames, 1, FRAME, style === 'slot' ? next.runs.length : 0)
      swap(meshes.cards, ROWS, CARD, style === 'flip' ? columns() * 3 : 0)
      letterMap.set(next.raster.canvas)
      sheetMap.set(next.sheet.canvas)
      frame.value.set(...next.raster.frame)
      cell.value.set(...next.sheet.cell)
      grid.value.set(next.sheet.cols, next.sheet.canvas.width, next.sheet.canvas.height)
      perspective.value = next.em * PERSPECTIVE
      colours()
      drawnAt = Number.NaN
    }

    let dom = false
    const show = (value: boolean): void => {
      if (dom === value) return
      dom = value
      ctx.showDom(value)
    }
    draw(seen ? total() : 0)
    await ctx.compile(group)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()
    if (seen) show(true)

    // Raster again when the text, its fonts or its width change, like text-reveal.
    let cancel: (() => void) | undefined
    const redo = async (): Promise<void> => {
      cancel = undefined
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'letter', ratio)
      if (next?.by !== 'letter') return
      const built = await load(next)
      if (signal.aborted || typeof built === 'string') return
      use(built)
      ctx.invalidate()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
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
      const width = element.getBoundingClientRect().width
      if (Math.abs(width - plan.raster.width) > 0.5) schedule()
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // Seconds since the trigger, -1 before it.
    let elapsed = -1
    let fresh = false
    let playing = false
    const world = new Vector2()
    return (input): boolean => {
      const { x, y, width, height, progress, presence } = input
      const p = ctx.params
      const last = total()
      const vh = stage.height.peek()
      let time: number
      if (scrubbed) {
        // From `threshold` of the box in view to the box centred in the viewport, both ways.
        const entered = entering(progress, height, vh, p.threshold)
        if (seen && entered < 1) time = last
        else {
          seen = false
          time = p.delay + entered * (last - p.delay)
        }
      } else {
        if (!seen && elapsed < 0) {
          // Counted above the bottom tenth of the viewport, like `reveal`.
          if (inView(y, height, vh, p.threshold)) {
            elapsed = 0
            fresh = true
            playing = true
          }
        } else if (elapsed >= 0 && elapsed < last) {
          if (fresh) fresh = false
          else elapsed += input.delta
        }
        time = seen ? last : Math.max(elapsed, 0)
        if (time >= last) playing = false
      }
      // The perspective looks at the number from in front of its centre.
      const [midX, midY] = plan.centre
      const worldCentre = render.toWorld(x + midX, y + midY, world)
      focus.value.set(midX - width / 2, height / 2 - midY, worldCentre.x, worldCentre.y)
      distance.value = render.camera.position.z || 1000
      // A page transition plays the count through presence.
      draw(Math.min(time, last, presence * last))
      show(time >= last && presence >= 1)
      return playing
    }
  },
})
export default counter
