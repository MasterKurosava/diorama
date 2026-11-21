import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, inView, mixOklab, roundedBox } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  attribute,
  float,
  length,
  max,
  min,
  mix,
  positionGeometry,
  select,
  uniform,
  varying,
  vec3,
} from 'three/tsl'
import {
  CanvasTexture,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three/webgpu'
import { cellValue, escapeHtml, rowsOf, SHOWN, tooltip } from './table'

type Params = {
  mode: ChoiceParam<'grid' | 'calendar'>
  style: ChoiceParam<'tile' | 'dot'>
  motion: ChoiceParam<'sweep' | 'fade'>
  colors: string
  steps: number
  max: 'auto'
  gap: number
  radius: number
  labels: boolean
  legend: boolean
  dim: number
  duration: number
  stagger: number
}
type Float = Node<'float'>

/** Most cells one heatmap draws: ten years of days. */
export const MAX_CELLS = 3660
/** Milliseconds in a day. */
const DAY = 864e5

/** One value at a row and a column. */
export interface HeatCell {
  readonly row: number
  readonly column: number
  /** NaN for an empty cell. */
  readonly value: number
  /** The cell as written, for the tooltip. */
  readonly text: string
  /** What the tooltip calls the cell: the row and column, or the date. */
  readonly title: string
  readonly note: string
}
/** What the heatmap shows. */
export interface HeatData {
  readonly rows: readonly string[]
  readonly columns: readonly string[]
  readonly cells: readonly HeatCell[]
  /** The first column of each month, for the labels of a calendar. */
  readonly months: readonly { readonly column: number; readonly label: string }[]
}

const words = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** A matrix: the header row names the columns, the first cell of each row names the row. */
export function readGrid(element: Element): HeatData {
  const cells: HeatCell[] = []
  const rows: string[] = []
  let columns: string[] = []
  if (element instanceof HTMLTableElement) {
    const { head, body } = rowsOf(element)
    columns = head ? [...head.cells].slice(1).map((c) => words(c.textContent ?? '')) : []
    for (const tr of body) {
      const [first, ...rest] = [...tr.cells]
      const row = rows.length
      rows.push(words(first?.textContent ?? ''))
      rest.forEach((cell, column) => {
        if (cells.length >= MAX_CELLS) return
        const [value, text] = cellValue(cell)
        cells.push({
          row,
          column,
          value,
          text,
          title: rows[row] ?? '',
          note: columns[column] ?? '',
        })
      })
    }
    const widest = Math.max(0, ...cells.map((c) => c.column + 1))
    while (columns.length < widest) columns.push('')
    columns.length = widest
  }
  return { rows, columns, cells, months: [] }
}

/** Days since 1970-01-01 of a date in a cell: `<time datetime>`, `data-dio-date` or the text. */
export function dayOf(cell: Element): number {
  const time = cell.matches('time[datetime]') ? cell : cell.querySelector('time[datetime]')
  const text =
    time?.getAttribute('datetime') ?? cell.getAttribute('data-dio-date') ?? cell.textContent ?? ''
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text)
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) / DAY
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) return Number.NaN
  const date = new Date(parsed)
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY
}

/** The first day of the week where the page's language is spoken: 0 Sunday, 1 Monday. */
export function weekStart(lang: string): number {
  try {
    const locale = new Intl.Locale(lang || 'en-GB') as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const info = locale.getWeekInfo?.() ?? locale.weekInfo
    if (info?.firstDay) return info.firstDay % 7
  } catch {}
  return /^en-(US|CA)|^(ja|ko|zh-TW|he|pt-BR)/.test(lang) ? 0 : 1
}

/**
 * A calendar from dated values: rows of a `<table>` (date, value), a `<dl>` of `<dt>` dates and
 * `<dd>` values, or list items with a `<time>` and `data-dio-value`. A column per week, a row per
 * weekday; days without a value are empty cells.
 */
export function readCalendar(
  element: Element,
  lang = '',
  start: number = weekStart(lang),
): HeatData {
  const found: { day: number; value: number; text: string }[] = []
  const put = (dayCell: Element | undefined, valueCell: Element | undefined): void => {
    if (!dayCell || !valueCell) return
    const day = dayOf(dayCell)
    if (Number.isNaN(day)) return
    const [value, text] = cellValue(valueCell)
    found.push({ day, value, text })
  }
  if (element instanceof HTMLTableElement)
    for (const tr of rowsOf(element).body) put(tr.cells[0], tr.cells[1])
  else if (element.localName === 'dl') {
    let date: Element | undefined
    for (const child of element.children) {
      if (child.localName === 'dt') date = child
      else if (child.localName === 'dd') put(date, child)
    }
  } else for (const li of element.querySelectorAll('li')) put(li, li)
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(lang || undefined, { ...options, timeZone: 'UTC' })
  const weekday = format({ weekday: 'short' })
  const long = format({ dateStyle: 'medium' })
  const month = format({ month: 'short' })
  const rows = Array.from({ length: 7 }, (_, r) =>
    // 1970-01-04 was a Sunday.
    weekday.format(new Date((3 + start + r) * DAY)),
  )
  if (!found.length) return { rows, columns: [], cells: [], months: [] }
  const first = Math.min(...found.map((f) => f.day))
  const last = Math.min(Math.max(...found.map((f) => f.day)), first + MAX_CELLS - 7)
  const rowOf = (day: number): number => (((day + 4 - start) % 7) + 7) % 7
  const origin = first - rowOf(first)
  const byDay = new Map(found.map((f) => [f.day, f]))
  const cells: HeatCell[] = []
  const months: { column: number; label: string }[] = []
  for (let day = first; day <= last; day++) {
    const entry = byDay.get(day)
    const column = Math.floor((day - origin) / 7)
    const date = new Date(day * DAY)
    if (day === first || date.getUTCDate() === 1) {
      const label = month.format(date)
      const prev = months[months.length - 1]
      // A month that starts late in the first week gives its label to the next one.
      if (prev && column - prev.column < 2) prev.label = label
      else
        months.push({
          column: day === first && date.getUTCDate() > 21 ? column + 1 : column,
          label,
        })
    }
    cells.push({
      row: rowOf(day),
      column,
      value: entry?.value ?? Number.NaN,
      text: entry?.text ?? '',
      title: long.format(date),
      note: '',
    })
  }
  const columns = Array.from({ length: Math.floor((last - origin) / 7) + 1 }, () => '')
  return { rows, columns, cells, months }
}

/** A color at `t` 0..1 along stops, blended in OKLab so the steps look even. */
export function ramp(stops: readonly Color[], t: number, out: Color = new Color()): Color {
  if (!stops.length) return out.set(0x888888)
  if (stops.length === 1) return out.copy(stops[0] as Color)
  const position = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(position))
  return mixOklab(stops[i] as Color, stops[i + 1] as Color, position - i, out)
}

// One hue light to dark for amounts; red below 0 and blue above it around a gray, as a fall and a
// rise read on business pages.
// The end near the page recedes into it; dark pages get their own steps.
const RAMPS = {
  light: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'],
  dark: ['#104281', '#1c5cab', '#3987e5', '#86b6ef', '#cde2fb'],
  splitLight: ['#b8341f', '#ec9a85', '#f0efec', '#86b6ef', '#1c5cab'],
  splitDark: ['#f3b5a6', '#d9543f', '#383835', '#3987e5', '#9ec5f4'],
}

/**
 * Where a value sits on the color scale, 0..1. Amounts run from 0 (an empty cell) to `top`;
 * values on both sides of 0 run from -top to top with 0 in the middle. `steps` > 0 snaps to
 * that many even bins, as a legend can name them.
 */
export function shade(value: number, top: number, split: boolean, steps: number): number {
  const t = split ? 0.5 + value / (2 * (top || 1)) : value / (top || 1)
  const clamped = Math.min(1, Math.max(0, t))
  if (steps < 1) return clamped
  const n = Math.round(steps)
  const bin = Math.min(n - 1, Math.floor(clamped * n))
  return n > 1 ? bin / (n - 1) : 1
}

/** A box in element px. */
interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * A `<table>` drawn as a heatmap: a matrix of rows and columns, or a calendar of days like a
 * contributions chart, colored on an even scale, that sweeps in when it scrolls into view. The
 * pointer over a cell shows its value as written; the table stays for screen readers.
 */
const heatmap: Effect<Params> = defineEffect({
  name: 'heatmap',
  params: {
    mode: oneOf('grid', 'calendar'),
    style: oneOf('tile', 'dot'),
    motion: oneOf('sweep', 'fade'),
    colors: '',
    steps: 5,
    max: 'auto',
    gap: 2,
    radius: 2,
    labels: true,
    legend: true,
    dim: 0.35,
    duration: 0.5,
    stagger: 0.02,
  },
  on: 'table, dl, ul, ol',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { signal, u, params } = ctx
    const element = ctx.element as HTMLElement
    const calendar = params.mode === 'calendar'
    const dots = params.style === 'dot'
    const lang = element.closest('[lang]')?.getAttribute('lang') ?? ''
    const data = calendar ? readCalendar(element, lang) : readGrid(element)
    const cells = data.cells
    const rowCount = data.rows.length
    const columnCount = data.columns.length
    const filled = cells.filter((c) => !Number.isNaN(c.value))
    if (DEV && !filled.length)
      ctx.app.log.warn('heatmap found no numbers in its table or list', element)
    const values = filled.map((c) => c.value)
    const split = values.some((v) => v < 0) && values.some((v) => v > 0)
    /** The cell with the highest value for 1, the lowest for -1. */
    const extreme = (sign: 1 | -1): HeatCell | undefined =>
      filled.reduce<HeatCell | undefined>(
        (best, c) => (!best || sign * c.value > sign * best.value ? c : best),
        undefined,
      )
    // 'auto' takes the largest value.
    const fixed = params.max === 'auto' ? 0 : params.max
    const topOf = (): number =>
      fixed > 0 ? fixed : Math.max(1e-9, ...values.map((v) => (split ? Math.abs(v) : v)))
    const empty = (c: HeatCell): boolean => Number.isNaN(c.value) || (!split && c.value <= 0)

    const root = new Group()
    ctx.place(root, { fit: 'none', replace: true })

    const clock = uniform(0)
    const span = uniform(Math.max(params.duration, 1e-3))
    // The hovered cell, its row and column, -1 for none, and how far the hover has faded in.
    const hot = uniform(-1)
    const hotRow = uniform(-1)
    const hotColumn = uniform(-1)
    const focus = uniform(0)
    const ink = uniform(new Color('#888888'))
    /** 0..1 with a cubic ease out, `delay` s after the clock started. */
    const grown = (delay: Float): Float =>
      clock.sub(delay).div(span).clamp(0, 1).oneMinus().pow(3).oneMinus() as unknown as Float

    // Cells: instanced quads, a rounded tile or a dot sized by the value; the lit one gets a ring.
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    const rect = attribute('rect', 'vec4')
    const cellAt = attribute('cell', 'vec2')
    const growth = grown(attribute('delay', 'float') as unknown as Float)
    const scale = params.motion === 'sweep' ? growth.mul(0.6).add(0.4) : float(1)
    const half = rect.zw.mul(0.5)
    // Px from the cell's centre; the quad reaches 4 px past the cell for the ring.
    const local = varying(positionGeometry.xy.mul(half.add(4)))
    material.positionNode = vec3(rect.xy.add(local.mul(scale)), 0)
    const side = min(half.x, half.y)
    const fill = attribute('fill', 'float')
    let distance: Float
    if (dots) distance = length(local).sub(side.mul(fill)) as unknown as Float
    else {
      distance = roundedBox(local, half, min(u.radius, side) as unknown as Float)
    }
    const inside = float(0.5).sub(distance.mul(scale)).clamp(0, 1)
    const outer = dots ? length(local).sub(side) : distance
    const isHot = select(abs(attribute('index', 'float').sub(hot)).lessThan(0.5), 1, 0).mul(focus)
    // A ring 2 px outside the lit cell.
    const ring = float(0.75)
      .sub(abs(outer.sub(2)))
      .add(0.5)
      .clamp(0, 1)
      .mul(isHot)
    // The lit cell's row and column dim less than the rest: a crosshair to read along.
    const crosshair = select(
      abs(cellAt.x.sub(hotRow))
        .lessThan(0.5)
        .or(abs(cellAt.y.sub(hotColumn)).lessThan(0.5)),
      0.4,
      1,
    )
    const fade = float(1).sub(focus.mul(u.dim).mul(crosshair).mul(isHot.oneMinus()).clamp(0, 1))
    material.colorNode = mix(ink, attribute('tint', 'vec3'), inside)
    material.opacityNode = max(inside.mul(attribute('alpha', 'float')).mul(fade), ring)
      .mul(growth)
      .mul(u.opacity)
    const mesh = new Mesh(new InstancedBufferGeometry(), material)
    mesh.frustumCulled = false
    root.add(mesh)

    // Labels and the legend: a canvas the size of the box.
    const canvas = document.createElement('canvas')
    const map = new CanvasTexture(canvas)
    map.colorSpace = SRGBColorSpace
    map.minFilter = map.magFilter = LinearFilter
    map.generateMipmaps = false
    ctx.onDispose(() => map.dispose())
    const paper = new MeshBasicNodeMaterial({ map, transparent: true, depthWrite: false })
    const sheet = new Mesh(new PlaneGeometry(1, 1), paper)
    sheet.position.z = 0.1
    root.add(sheet)

    let plot: Rect = { left: 0, top: 0, width: 1, height: 1 }
    let cellWidth = 1
    let cellHeight = 1
    let font = 13
    let family = 'system-ui, sans-serif'
    let stops: Color[] = []
    let width = 1
    let height = 1
    const custom = params.colors.trim()
      ? params.colors
          .split(/[\s,]+(?![^(]*\))/)
          .filter(Boolean)
          .map((c) => new Color(cssColor(c) ?? '#888888'))
      : undefined
    const measureText = (context: CanvasRenderingContext2D | null, text: string): number => {
      if (!context) return text.length * font * 0.55
      context.font = `${font}px ${family}`
      return context.measureText(text).width
    }

    /** Font, ink, colour stops and the plot box, leaving room for the labels and the legend. */
    const measure = (w: number, h: number): void => {
      const computed = getComputedStyle(element)
      font = Math.max(10, Math.min(14, (Number.parseFloat(computed.fontSize) || 15) * 0.8))
      family = computed.fontFamily || family
      const text = new Color(cssColor(computed.color) ?? '#888888')
      ink.value.copy(text)
      // Light text means a dark page.
      const darkPage = 0.2126 * text.r + 0.7152 * text.g + 0.0722 * text.b > 0.3
      stops =
        custom ??
        RAMPS[split ? (darkPage ? 'splitDark' : 'splitLight') : darkPage ? 'dark' : 'light'].map(
          (c) => new Color(c),
        )
      const context = canvas.getContext('2d')
      const left = params.labels
        ? Math.min(w * 0.3, Math.max(0, ...data.rows.map((r) => measureText(context, r))) + 8)
        : 0
      const top =
        params.labels && (calendar ? data.months.length : data.columns.some(Boolean))
          ? font * 1.6
          : 0
      const bottom = params.legend && filled.length ? font * 2.2 : 0
      plot = {
        left,
        top,
        width: Math.max(1, w - left),
        height: Math.max(1, h - top - bottom),
      }
      cellWidth = plot.width / Math.max(1, columnCount)
      cellHeight = plot.height / Math.max(1, rowCount)
      // Calendar days are square, from the left like a contributions chart.
      if (calendar) cellWidth = cellHeight = Math.min(cellWidth, cellHeight)
      width = w
      height = h
    }

    const tint = new Color()
    /** Cell instances in world px, centre of the box at 0,0, y up. */
    const build = (): void => {
      const worldX = (x: number): number => x - width / 2
      const worldY = (y: number): number => height / 2 - y
      const n = cells.length
      const rects = new Float32Array(n * 4)
      const tints = new Float32Array(n * 3)
      const alphas = new Float32Array(n)
      const fills = new Float32Array(n)
      const delays = new Float32Array(n)
      const places = new Float32Array(n * 2)
      const top = topOf()
      const gap = Math.max(0, params.gap)
      const stagger = params.motion === 'sweep' ? Math.max(0, params.stagger) : 0
      cells.forEach((cell, i) => {
        const x = plot.left + cellWidth * (cell.column + 0.5)
        const y = plot.top + cellHeight * (cell.row + 0.5)
        rects.set(
          [worldX(x), worldY(y), Math.max(1, cellWidth - gap), Math.max(1, cellHeight - gap)],
          i * 4,
        )
        const off = empty(cell)
        if (off) tint.copy(ink.value)
        else ramp(stops, shade(cell.value, top, split, params.steps), tint)
        tints.set([tint.r, tint.g, tint.b], i * 3)
        alphas[i] = off ? (Number.isNaN(cell.value) && calendar ? 0.05 : 0.08) : 1
        const amount = split ? Math.abs(cell.value) / top : cell.value / top
        // A dot's radius: its area follows the value.
        fills[i] = off ? 0.25 : Math.max(0.2, Math.sqrt(Math.min(1, amount)))
        delays[i] = (cell.row + cell.column) * stagger
        places.set([cell.row, cell.column], i * 2)
      })
      const quad = new PlaneGeometry(2, 2)
      const geometry = new InstancedBufferGeometry()
      geometry.setIndex(quad.getIndex())
      geometry.setAttribute('position', quad.getAttribute('position'))
      geometry.setAttribute('rect', new InstancedBufferAttribute(rects, 4))
      geometry.setAttribute('tint', new InstancedBufferAttribute(tints, 3))
      geometry.setAttribute('alpha', new InstancedBufferAttribute(alphas, 1))
      geometry.setAttribute('fill', new InstancedBufferAttribute(fills, 1))
      geometry.setAttribute('delay', new InstancedBufferAttribute(delays, 1))
      geometry.setAttribute('cell', new InstancedBufferAttribute(places, 2))
      geometry.setAttribute(
        'index',
        new InstancedBufferAttribute(
          Float32Array.from(delays, (_, i) => i),
          1,
        ),
      )
      geometry.instanceCount = n
      mesh.geometry.dispose()
      mesh.geometry = geometry
    }

    const compact = new Intl.NumberFormat(lang || undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    })
    /** The row and column labels and the legend into the canvas over the cells. */
    const draw = (): void => {
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const canvasWidth = Math.max(1, Math.round(width * ratio))
      const canvasHeight = Math.max(1, Math.round(height * ratio))
      // A texture keeps its storage size: a new size needs new storage.
      if (canvasWidth !== canvas.width || canvasHeight !== canvas.height) map.dispose()
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      sheet.scale.set(width, height, 1)
      map.needsUpdate = true
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      context.font = `${font}px ${family}`
      context.fillStyle = getComputedStyle(element).color || '#666'
      if (params.labels) {
        context.globalAlpha = 0.75
        context.textBaseline = 'middle'
        context.textAlign = 'right'
        // Every other weekday or row when they would crowd.
        const every = cellHeight < font * 1.15 ? 2 : 1
        data.rows.forEach((r, i) => {
          if (calendar ? i % 2 === 0 && every > 1 : i % every) return
          context.fillText(
            r,
            plot.left - 8,
            plot.top + cellHeight * (i + 0.5),
            Math.max(10, plot.left - 8),
          )
        })
        context.textBaseline = 'alphabetic'
        context.textAlign = calendar ? 'left' : 'center'
        const y = plot.top - font * 0.55
        if (calendar) {
          for (const month of data.months)
            context.fillText(month.label, plot.left + cellWidth * month.column, y)
        } else {
          const widest = Math.max(0, ...data.columns.map((c) => context.measureText(c).width)) + 6
          const step = Math.max(1, Math.ceil(widest / cellWidth))
          data.columns.forEach((c, i) => {
            if (!(i % step)) context.fillText(c, plot.left + cellWidth * (i + 0.5), y)
          })
        }
      }
      const lowest = extreme(-1)
      const highest = extreme(1)
      if (params.legend && lowest && highest) {
        // The scale under the cells on the right: lowest value, the bins or a ramp, highest value.
        const n = params.steps >= 1 ? Math.round(params.steps) : 24
        const size = Math.round(font * 0.9)
        const bar = params.steps >= 1 ? n * (size + 2) : 120
        const lowText = split && fixed > 0 ? compact.format(-fixed) : split ? lowest.text : '0'
        const highText = fixed > 0 ? compact.format(fixed) : highest.text
        const y = height - size - 2
        const right = calendar ? Math.min(width, plot.left + cellWidth * columnCount) : width
        context.textBaseline = 'middle'
        context.globalAlpha = 0.75
        context.textAlign = 'left'
        const highWidth = context.measureText(highText).width
        const highX = right - highWidth
        const barX = highX - 6 - bar
        context.fillText(highText, highX, y + size / 2)
        context.textAlign = 'right'
        context.fillText(lowText, barX - 6, y + size / 2)
        context.globalAlpha = 1
        for (let i = 0; i < n; i++) {
          const t = n > 1 ? i / (n - 1) : 1
          ramp(stops, t, tint)
          context.fillStyle = `#${tint.getHexString()}`
          if (params.steps >= 1) context.fillRect(barX + i * (size + 2), y, size, size)
          else context.fillRect(barX + (bar / n) * i, y, bar / n + 0.5, size)
        }
      }
      context.globalAlpha = 1
    }

    // Hover and touch: the cell under the pointer and its tooltip.
    const tip = tooltip(ctx.onDispose)
    const index = new Map(cells.map((c, i) => [`${c.row} ${c.column}`, i]))
    /** The hovered cell, -1 for none. */
    let target = -1
    const pick = (e: PointerEvent): void => {
      const box = element.getBoundingClientRect()
      const column = Math.floor((e.clientX - box.left - plot.left) / cellWidth)
      const row = Math.floor((e.clientY - box.top - plot.top) / cellHeight)
      const i = index.get(`${row} ${column}`) ?? -1
      if (i !== target) {
        target = i
        ctx.invalidate()
      }
      const cell = cells[i]
      if (!cell) {
        tip.hide()
        return
      }
      const title = cell.note ? `${cell.title} · ${cell.note}` : cell.title
      tip.show(
        `<b>${escapeHtml(title)}</b>${cell.text ? `<div>${escapeHtml(cell.text)}</div>` : ''}`,
        e.clientX,
        e.clientY,
      )
    }
    const clear = (): void => {
      if (target >= 0) {
        target = -1
        ctx.invalidate()
      }
      tip.hide()
    }
    element.addEventListener('pointermove', pick, { signal })
    element.addEventListener('pointerdown', (e) => e.pointerType !== 'mouse' && pick(e), {
      signal,
    })
    element.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && clear(), {
      signal,
    })
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!element.contains(e.target as Element | null)) clear()
      },
      { signal },
    )
    window.addEventListener('scroll', () => target >= 0 && clear(), { signal, passive: true })

    /** Seconds since the cells started to come in, undefined before they came into view. */
    let started: number | undefined
    let layoutKey = ''
    measure(Math.max(1, ctx.input.width), Math.max(1, ctx.input.height))
    build()
    draw()

    return (input): boolean => {
      const w = input.width
      const h = input.height
      const key = `${w}x${h} ${params.gap} ${params.steps} ${params.max} ${params.labels} ${params.legend} ${params.stagger}`
      if (key !== layoutKey && w > 0 && h > 0) {
        layoutKey = key
        measure(w, h)
        build()
        draw()
      }
      span.value = Math.max(params.duration, 1e-3)
      if (started === undefined && inView(input.y, h, ctx.app.stage.height.peek(), SHOWN))
        started = 0
      const farthest = cells.reduce((m, c) => Math.max(m, c.row + c.column), 0)
      const sweep = params.motion === 'sweep' ? Math.max(0, params.stagger) * farthest : 0
      const end = params.duration + sweep + 0.05
      if (started !== undefined && started < end)
        started = input.reducedMotion ? end : started + Math.min(input.delta, 0.1)
      clock.value = started ?? 0
      const cell = cells[target]
      if (cell) {
        hot.value = target
        hotRow.value = cell.row
        hotColumn.value = cell.column
      }
      const want = cell ? 1 : 0
      const current = focus.value as number
      focus.value = input.reducedMotion
        ? want
        : Math.abs(current - want) < 0.01
          ? want
          : damp(current, want, 0.06, input.delta)
      if (focus.value === 0) hot.value = hotRow.value = hotColumn.value = -1
      return (started !== undefined && started < end) || focus.value !== want
    }
  },
})
export default heatmap
