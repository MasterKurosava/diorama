import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, inView, roundedBox } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  attribute,
  float,
  min,
  positionGeometry,
  select,
  uniform,
  varying,
  vec2,
  vec3,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
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
import {
  cellValue,
  escapeHtml,
  NUMBER,
  PALETTE,
  parseNumber,
  rowsOf,
  SHOWN,
  tooltip,
} from './table'

export { PALETTE, parseNumber }

type Style = 'bar' | 'column' | 'line' | 'area'
type Params = {
  style: ChoiceParam<Style>
  colors: string
  duration: number
  stagger: number
  grid: boolean
  labels: boolean
  max: 'auto'
}

/** One column of the table, or the values of a `<dl>`. */
export interface Series {
  readonly name: string
  readonly values: readonly number[]
  /** The cells as written, for the tooltip. */
  readonly texts: readonly string[]
}
/** What the chart shows: categories down the rows and a series per value column. */
export interface ChartData {
  readonly categories: readonly string[]
  readonly series: readonly Series[]
  /** A currency sign or another short prefix every value shares, for the axis. */
  readonly prefix: string
  /** `%` and the like when every value has it, for the axis. */
  readonly suffix: string
}

/** The prefix and suffix around the number of a cell, without signs and k/M/B suffixes. */
const affixes = (text: string): [string, string] => {
  const joined = text.trim().replace(/(\d)[\s   '](?=\d)/g, '$1')
  const match = NUMBER.exec(joined)
  if (!match) return ['', '']
  const after = joined
    .slice(match.index + match[0].length)
    .replace(/^\s*(bn|mn|tn|[kmbt])(?![a-z])/i, '')
  return [joined.slice(0, match.index).replace(/[-+(\s−]/g, ''), after.replace(/[)\s]/g, '')]
}

/** Categories and series of a `<table>` (first column labels, header row names) or a `<dl>`. */
export function readChart(element: Element): ChartData {
  const categories: string[] = []
  const columns: { name: string; values: number[]; texts: string[] }[] = []
  /** The text of every cell that holds a number, for the shared prefix and suffix. */
  const numbers: string[] = []
  const put = (column: number, name: string, row: number, cell: Element): void => {
    columns[column] ??= { name, values: [], texts: [] }
    const series = columns[column]
    const [value, text] = cellValue(cell)
    series.values[row] = value
    series.texts[row] = text
    if (!Number.isNaN(value)) numbers.push(text)
  }
  if (element instanceof HTMLTableElement) {
    const { head, body } = rowsOf(element)
    const names = head ? [...head.cells].map((c) => (c.textContent ?? '').trim()) : []
    for (const row of body) {
      const cells = [...row.cells]
      const at = categories.length
      categories.push((cells[0]?.textContent ?? '').trim())
      cells.slice(1).forEach((cell, i) => {
        put(i, names[i + 1] ?? '', at, cell)
      })
    }
  } else {
    let column = 0
    for (const child of element.children) {
      if (child.tagName === 'DT') {
        categories.push((child.textContent ?? '').trim())
        column = 0
      } else if (child.tagName === 'DD' && categories.length)
        put(column++, '', categories.length - 1, child)
    }
  }
  const series = columns
    .filter((c) => c?.values.some((v) => !Number.isNaN(v)))
    .map((c) => ({
      name: c.name,
      values: categories.map((_, i) => c.values[i] ?? Number.NaN),
      texts: categories.map((_, i) => c.texts[i] ?? ''),
    }))
  const pairs = numbers.map(affixes)
  const shared = (side: 0 | 1): string => {
    const first = pairs[0]?.[side] ?? ''
    return pairs.every((pair) => pair[side] === first) ? first : ''
  }
  const prefix = shared(0)
  const suffix = shared(1)
  return {
    categories,
    series,
    prefix: prefix.length <= 3 ? prefix : '',
    suffix: /^[%‰°]$/.test(suffix) ? suffix : '',
  }
}

/** A round step near a fifth of `span`: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(span: number, count = 5): number {
  const raw = span / count || 1
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return power * (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10)
}

/** Bounds and ticks of the value axis: from 0, or below it for negative values. */
export function scaleOf(
  values: readonly number[],
  top = 0,
): { lo: number; hi: number; ticks: number[] } {
  const finite = values.filter(Number.isFinite)
  const dataHi = Math.max(0, ...finite)
  const dataLo = Math.min(0, ...finite)
  const step = niceStep((top > 0 ? top : dataHi) - dataLo)
  const hi = top > 0 ? top : Math.ceil(dataHi / step) * step || step
  const lo = Math.floor(dataLo / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step)
  return { lo, hi, ticks }
}

/** A box in element px: x from the left, y from the top. */
interface Plot {
  left: number
  top: number
  width: number
  height: number
}

/** Share of a category's band its bars fill together. */
const GROUP = 0.72
/** Largest corner radius of a bar's free end, px. */
const BAR_RADIUS = 4
/** How far marks outside the hovered category fade. */
const DIM = 0.55

/**
 * A `<table>` or `<dl>` drawn as an animated bar, column, line or area chart that grows in when it
 * scrolls into view; the markup stays for screen readers and shows without WebGL.
 */
const chart: Effect<Params> = defineEffect({
  name: 'chart',
  params: {
    style: oneOf('bar', 'column', 'line', 'area'),
    colors: '',
    duration: 1,
    stagger: 0.06,
    grid: true,
    labels: true,
    max: 'auto',
  },
  on: 'table, dl',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { signal, params } = ctx
    const element = ctx.element as HTMLElement
    const style = params.style
    const across = style === 'bar'
    const lines = style === 'line' || style === 'area'
    const data = readChart(element)
    const colors = (
      params.colors.trim() ? params.colors.split(/[\s,]+(?![^(]*\))/).filter(Boolean) : PALETTE
    ).map((c) => new Color(cssColor(c) ?? '#888888'))
    const colorOf = (i: number): Color => colors[i % colors.length] as Color
    const values = data.series.flatMap((s) => s.values)
    const categoryCount = data.categories.length
    const seriesCount = data.series.length

    const root = new Group()
    ctx.place(root, { fit: 'none', replace: true })

    // Text and gridlines: a canvas the size of the box, drawn again when the box or a switch changes.
    const canvas = document.createElement('canvas')
    const map = new CanvasTexture(canvas)
    map.colorSpace = SRGBColorSpace
    map.minFilter = map.magFilter = LinearFilter
    map.generateMipmaps = false
    ctx.onDispose(() => map.dispose())
    const paper = new MeshBasicNodeMaterial({ map, transparent: true, depthWrite: false })
    const sheet = new Mesh(new PlaneGeometry(1, 1), paper)
    root.add(sheet)

    // Time since the chart came into view; marks grow from the baseline in order.
    const clock = uniform(0)
    const length = uniform(Math.max(params.duration, 1e-3))
    // The hovered category, -1 for none, and how far the hover has faded in.
    const hot = uniform(-1)
    const focus = uniform(0)
    /** 0..1 with a cubic ease out, `delay` s after the clock started. */
    const grown = (delay: Node<'float'>): Node<'float'> =>
      clock.sub(delay).div(length).clamp(0, 1).oneMinus().pow(3).oneMinus() as Node<'float'>
    /** Opacity of a mark of category `category`: the others fade while one is hovered. */
    const dim = (category: Node<'float'>): Node<'float'> => {
      const other = abs(category.sub(hot)).greaterThan(0.5).and(hot.greaterThanEqual(0))
      return float(1).sub(focus.mul(DIM).mul(select(other, 1, 0)))
    }

    // Bars: instanced quads with a rounded free end, square at the baseline.
    const barMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    const rect = attribute('rect', 'vec4')
    const grow = attribute('grow', 'vec3')
    const barCategory = attribute('cat', 'float')
    const barDelay = attribute('delay', 'float')
    const growth = grown(barDelay)
    // The axis it grows along (0 x, 1 y), the baseline on that axis, and the sign of the value.
    const horizontal = grow.x.lessThan(0.5)
    const baseline = grow.y
    const full = rect.xy.add(positionGeometry.xy.mul(rect.zw))
    const flat = vec2(select(horizontal, baseline, full.x), select(horizontal, full.y, baseline))
    barMaterial.positionNode = vec3(flat.add(full.sub(flat).mul(growth)), 0)
    // Distance to a rounded box stretched past the baseline by its radius: only the free end rounds.
    const size = vec2(
      select(horizontal, rect.z.mul(growth), rect.z),
      select(horizontal, rect.w, rect.w.mul(growth)),
    )
    const radius = min(float(BAR_RADIUS), min(size.x, size.y).mul(0.5))
    const local = varying(
      positionGeometry.xy
        .mul(size)
        .add(
          vec2(
            select(horizontal, radius.mul(grow.z).mul(0.5), 0),
            select(horizontal, 0, radius.mul(grow.z).mul(0.5)),
          ),
        ),
    )
    const half = varying(
      size
        .mul(0.5)
        .add(vec2(select(horizontal, radius.mul(0.5), 0), select(horizontal, 0, radius.mul(0.5)))),
    )
    const cornerRadius = varying(radius)
    const distance = roundedBox(local, half, cornerRadius)
    barMaterial.colorNode = attribute('tint', 'vec3')
    barMaterial.opacityNode = distance
      .negate()
      .add(0.5)
      .clamp(0, 1)
      .mul(dim(barCategory))
      .mul(ctx.u.opacity)
    const bars = new Mesh(new InstancedBufferGeometry(), barMaterial)
    bars.frustumCulled = false
    if (!lines) root.add(bars)

    // Lines and areas: strips of constant width revealed left to right.
    const along = attribute('along', 'float')
    const delay = attribute('delay', 'float')
    const lineMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    const width = uniform(1)
    lineMaterial.positionNode = vec3(
      positionGeometry.xy.add(
        attribute('miter', 'vec2').mul(attribute('side', 'float')).mul(width),
      ),
      0.2,
    )
    lineMaterial.colorNode = attribute('tint', 'vec3')
    // A line is never dimmed by halves: the guide and the dots mark the hovered category.
    lineMaterial.opacityNode = select(along.lessThanEqual(grown(delay)), 1, 0).mul(ctx.u.opacity)
    const lineMesh = new Mesh(new BufferGeometry(), lineMaterial)
    lineMesh.frustumCulled = false
    const areaMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    areaMaterial.colorNode = attribute('tint', 'vec3')
    areaMaterial.opacityNode = select(along.lessThanEqual(grown(delay)), 1, 0)
      .mul(attribute('fade', 'float').mul(0.22).add(0.04))
      .mul(ctx.u.opacity)
    const areaMesh = new Mesh(new BufferGeometry(), areaMaterial)
    areaMesh.frustumCulled = false
    // Dots of the hovered category on lines, and the guide under them.
    const dotMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    const dotCategory = attribute('cat', 'float')
    const lit = focus.mul(select(abs(dotCategory.sub(hot)).lessThan(0.5), 1, 0))
    dotMaterial.positionNode = vec3(
      attribute('center', 'vec2').add(positionGeometry.xy.mul(lit.mul(5))),
      0.4,
    )
    dotMaterial.colorNode = attribute('tint', 'vec3')
    dotMaterial.opacityNode = select(positionGeometry.xy.length().lessThan(1), 1, 0).mul(
      ctx.u.opacity,
    )
    const dots = new Mesh(new InstancedBufferGeometry(), dotMaterial)
    dots.frustumCulled = false
    const guideMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    const ink = uniform(new Color('#888888'))
    guideMaterial.colorNode = ink
    guideMaterial.opacityNode = focus.mul(0.35).mul(ctx.u.opacity)
    const guide = new Mesh(new PlaneGeometry(1, 1), guideMaterial)
    if (style === 'area') root.add(areaMesh)
    if (lines) root.add(lineMesh, dots, guide)

    // Layout in element px, worked out again when the box or a switch changes.
    let plot: Plot = { left: 0, top: 0, width: 0, height: 0 }
    // 'auto' picks a round top from the values.
    const maxValue = params.max === 'auto' ? 0 : params.max
    let scale = scaleOf(values, maxValue)
    let font = 13
    let family = 'system-ui, sans-serif'
    /** Share of the value axis a value sits at, 0 at the bottom of the scale. */
    const toValue = (v: number): number => (v - scale.lo) / (scale.hi - scale.lo || 1)
    const compact = new Intl.NumberFormat(document.documentElement.lang || undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    })
    const tickLabel = (v: number): string =>
      `${v < 0 ? '-' : ''}${data.prefix}${compact.format(Math.abs(v))}${data.suffix}`

    /** Font, ink and the plot box, leaving room for the labels. */
    const measure = (w: number, h: number): void => {
      const computed = getComputedStyle(element)
      font = Math.max(10, Math.min(16, (Number.parseFloat(computed.fontSize) || 15) * 0.85))
      family = computed.fontFamily || family
      ink.value.set(cssColor(computed.color) ?? '#888888')
      const context = canvas.getContext('2d')
      const textWidth = (text: string): number => {
        if (!context) return text.length * font * 0.55
        context.font = `${font}px ${family}`
        return context.measureText(text).width
      }
      scale = scaleOf(values, maxValue)
      const show = params.labels
      if (across) {
        const labelWidth = show
          ? Math.min(w * 0.4, Math.max(0, ...data.categories.map(textWidth)) + 12)
          : 0
        const valueWidth = show
          ? Math.max(0, ...data.series.flatMap((s) => s.texts.map(textWidth))) + 8
          : 0
        plot = {
          left: labelWidth,
          top: 2,
          width: Math.max(1, w - labelWidth - valueWidth - 2),
          height: Math.max(1, h - 4),
        }
      } else {
        const tickWidth = show
          ? Math.max(...scale.ticks.map((t) => textWidth(tickLabel(t)))) + 10
          : 0
        const bottom = show ? font * 2 : 2
        const top = show ? font * 0.7 : 2
        plot = {
          left: tickWidth,
          top,
          width: Math.max(1, w - tickWidth - 4),
          height: Math.max(1, h - top - bottom),
        }
      }
    }

    /** Gridlines, the axis and the labels into the canvas behind the marks. */
    const draw = (w: number, h: number): void => {
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const canvasWidth = Math.max(1, Math.round(w * ratio))
      const canvasHeight = Math.max(1, Math.round(h * ratio))
      // A texture keeps its storage size: a new size needs new storage.
      if (canvasWidth !== canvas.width || canvasHeight !== canvas.height) map.dispose()
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      const context = canvas.getContext('2d')
      sheet.scale.set(w, h, 1)
      map.needsUpdate = true
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, w, h)
      const color = getComputedStyle(element).color || '#666'
      context.font = `${font}px ${family}`
      context.fillStyle = color
      context.strokeStyle = color
      context.lineWidth = 1
      const line = (x0: number, y0: number, x1: number, y1: number, alpha: number): void => {
        context.globalAlpha = alpha
        context.beginPath()
        context.moveTo(x0, y0)
        context.lineTo(x1, y1)
        context.stroke()
      }
      // Onto the middle of a device pixel, so a 1 px line stays sharp.
      const snap = (v: number): number => Math.round(v * ratio) / ratio + 0.5 / ratio
      const { left, top, width, height } = plot
      if (across) {
        const zeroX = snap(left + toValue(0) * width)
        if (params.grid)
          for (const t of scale.ticks) {
            const x = snap(left + toValue(t) * width)
            if (t !== 0) line(x, top, x, top + height, 0.12)
          }
        line(zeroX, top, zeroX, top + height, 0.45)
        if (params.labels) {
          context.globalAlpha = 0.85
          context.textBaseline = 'middle'
          context.textAlign = 'right'
          const band = height / Math.max(1, categoryCount)
          data.categories.forEach((c, i) => {
            context.fillText(c, left - 10, top + band * (i + 0.5), Math.max(10, left - 12))
          })
          // Each bar's value at its free end, in text ink: direct labels instead of an axis.
          context.globalAlpha = 0.7
          const group = band * GROUP
          const each = group / Math.max(1, seriesCount)
          data.series.forEach((s, j) => {
            s.values.forEach((v, i) => {
              if (Number.isNaN(v)) return
              const y = top + band * i + (band - group) / 2 + each * (j + 0.5)
              const end = left + toValue(v) * width
              context.textAlign = v < 0 ? 'right' : 'left'
              const text = s.texts[i] ?? ''
              const x = end + (v < 0 ? -6 : 6)
              // Gridlines stop short of the value instead of striking through it.
              const textWidth = context.measureText(text).width
              context.clearRect(
                v < 0 ? x - textWidth - 3 : x - 3,
                y - font * 0.65,
                textWidth + 6,
                font * 1.3,
              )
              context.fillText(text, x, y)
            })
          })
        }
      } else {
        context.textBaseline = 'middle'
        context.textAlign = 'right'
        for (const t of scale.ticks) {
          const y = snap(top + (1 - toValue(t)) * height)
          if (params.grid || t === 0) line(left, y, left + width, y, t === 0 ? 0.45 : 0.12)
          if (params.labels) {
            context.globalAlpha = 0.7
            context.fillText(tickLabel(t), left - 8, y)
          }
        }
        if (params.labels && categoryCount) {
          context.globalAlpha = 0.85
          context.textBaseline = 'top'
          // Every nth label when they would collide.
          const room = width / categoryCount
          const widest = Math.max(...data.categories.map((c) => context.measureText(c).width)) + 8
          const every = Math.max(
            1,
            Math.ceil(widest / Math.max(1, lines ? width / Math.max(1, categoryCount - 1) : room)),
          )
          data.categories.forEach((c, i) => {
            if (i % every) return
            const x = xOf(i)
            const half = context.measureText(c).width / 2
            context.textAlign = 'center'
            context.fillText(c, Math.min(w - half, Math.max(half, x)), top + height + font * 0.55)
          })
        }
      }
      context.globalAlpha = 1
    }

    /** Centre of a category on the x axis, element px. */
    const xOf = (i: number): number =>
      lines
        ? plot.left + (categoryCount > 1 ? (i / (categoryCount - 1)) * plot.width : plot.width / 2)
        : plot.left + (plot.width / Math.max(1, categoryCount)) * (i + 0.5)

    /** Marks in world px, centre of the box at 0,0, y up. */
    const build = (w: number, h: number): void => {
      const worldX = (x: number): number => x - w / 2
      const worldY = (y: number): number => h / 2 - y
      const { left, top, width, height } = plot
      const stagger = Math.max(0, params.stagger)
      if (!lines) {
        const band = (across ? height : width) / Math.max(1, categoryCount)
        const group = band * GROUP
        const gap = seriesCount > 1 ? 2 : 0
        const each = (group - gap * (seriesCount - 1)) / Math.max(1, seriesCount)
        const rects: number[] = []
        const grows: number[] = []
        const tints: number[] = []
        const categories: number[] = []
        const delays: number[] = []
        data.series.forEach((s, j) => {
          s.values.forEach((v, i) => {
            if (Number.isNaN(v)) return
            const start = band * i + (band - group) / 2 + (each + gap) * j
            const from = toValue(0)
            const to = toValue(v)
            if (across) {
              const x0 = left + from * width
              const x1 = left + to * width
              const y = top + start + each / 2
              rects.push(worldX((x0 + x1) / 2), worldY(y), Math.max(Math.abs(x1 - x0), 0.5), each)
              grows.push(0, worldX(x0), Math.sign(v) || 1)
            } else {
              const y0 = top + (1 - from) * height
              const y1 = top + (1 - to) * height
              const x = left + start + each / 2
              rects.push(worldX(x), worldY((y0 + y1) / 2), each, Math.max(Math.abs(y1 - y0), 0.5))
              grows.push(1, worldY(y0), Math.sign(v) || 1)
            }
            const color = colorOf(j)
            tints.push(color.r, color.g, color.b)
            categories.push(i)
            delays.push(i * stagger + j * stagger * 0.5)
          })
        })
        const quad = new PlaneGeometry(1, 1)
        const geometry = new InstancedBufferGeometry()
        geometry.setIndex(quad.getIndex())
        geometry.setAttribute('position', quad.getAttribute('position'))
        geometry.setAttribute('rect', new InstancedBufferAttribute(new Float32Array(rects), 4))
        geometry.setAttribute('grow', new InstancedBufferAttribute(new Float32Array(grows), 3))
        geometry.setAttribute('tint', new InstancedBufferAttribute(new Float32Array(tints), 3))
        geometry.setAttribute('cat', new InstancedBufferAttribute(new Float32Array(categories), 1))
        geometry.setAttribute('delay', new InstancedBufferAttribute(new Float32Array(delays), 1))
        geometry.instanceCount = categories.length
        bars.geometry.dispose()
        bars.geometry = geometry
        return
      }
      // Lines: one strip per run of numbers, a miter at each joint; areas down to the baseline.
      const line = {
        position: [] as number[],
        normal: [] as number[],
        side: [] as number[],
        along: [] as number[],
        tint: [] as number[],
        cat: [] as number[],
        delay: [] as number[],
        index: [] as number[],
      }
      const area = {
        position: [] as number[],
        along: [] as number[],
        tint: [] as number[],
        fade: [] as number[],
        delay: [] as number[],
        index: [] as number[],
      }
      const centers: number[] = []
      const dotTints: number[] = []
      const dotCategories: number[] = []
      const baselineY = worldY(top + (1 - toValue(0)) * height)
      data.series.forEach((s, j) => {
        const color = colorOf(j)
        const points = s.values.map((v, i) =>
          Number.isNaN(v)
            ? undefined
            : { x: worldX(xOf(i)), y: worldY(top + (1 - toValue(v)) * height), i },
        )
        // A gap in the values breaks the line into runs.
        const runs: { x: number; y: number; i: number }[][] = []
        let run: { x: number; y: number; i: number }[] = []
        for (const point of points) {
          if (point) run.push(point)
          else if (run.length) {
            runs.push(run)
            run = []
          }
        }
        if (run.length) runs.push(run)
        for (const runPoints of runs) {
          for (const [n, point] of runPoints.entries()) {
            centers.push(point.x, point.y)
            dotTints.push(color.r, color.g, color.b)
            dotCategories.push(point.i)
            const previous = runPoints[n - 1] ?? point
            const next = runPoints[n + 1] ?? point
            /** The unit normal of the segment from `a` to `b`, to its left. */
            const normalOf = (
              a: { x: number; y: number },
              b: { x: number; y: number },
            ): [number, number] => {
              const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
              return [-(b.y - a.y) / length, (b.x - a.x) / length]
            }
            const before = normalOf(previous, point)
            const after = normalOf(point, next)
            const last = n === runPoints.length - 1
            // The miter: the two normals' bisector, lengthened so the strip keeps its width.
            const [miterX, miterY] =
              n === 0 ? after : last ? before : [before[0] + after[0], before[1] + after[1]]
            const miterLength = Math.hypot(miterX, miterY) || 1
            const reference = last ? before : after
            const cosine =
              runPoints.length < 2
                ? 1
                : Math.max(
                    0.35,
                    (miterX / miterLength) * reference[0] + (miterY / miterLength) * reference[1],
                  )
            const progress = (point.x + w / 2 - left) / (width || 1)
            const lineVertex = line.position.length / 3
            for (const side of [-1, 1]) {
              line.position.push(point.x, point.y, 0)
              line.normal.push(miterX / miterLength / cosine, miterY / miterLength / cosine)
              line.side.push(side)
              line.along.push(progress)
              line.tint.push(color.r, color.g, color.b)
              line.cat.push(point.i)
              line.delay.push(j * stagger * 3)
            }
            const areaVertex = area.position.length / 3
            area.position.push(point.x, point.y, 0, point.x, baselineY, 0)
            area.along.push(progress, progress)
            area.tint.push(color.r, color.g, color.b, color.r, color.g, color.b)
            area.fade.push(1, 0)
            area.delay.push(j * stagger * 3, j * stagger * 3)
            if (n > 0) {
              const v = lineVertex
              const a = areaVertex
              line.index.push(v - 2, v - 1, v, v - 1, v + 1, v)
              area.index.push(a - 2, a - 1, a, a - 1, a + 1, a)
            }
          }
        }
      })
      const geometry = (
        attributes: Record<string, [number[], number]>,
        index: number[],
      ): BufferGeometry => {
        const strip = new BufferGeometry()
        for (const [name, [list, size]] of Object.entries(attributes))
          strip.setAttribute(name, new BufferAttribute(new Float32Array(list), size))
        strip.setIndex(index)
        return strip
      }
      lineMesh.geometry.dispose()
      lineMesh.geometry = geometry(
        {
          position: [line.position, 3],
          miter: [line.normal, 2],
          side: [line.side, 1],
          along: [line.along, 1],
          tint: [line.tint, 3],
          cat: [line.cat, 1],
          delay: [line.delay, 1],
        },
        line.index,
      )
      areaMesh.geometry.dispose()
      areaMesh.geometry = geometry(
        {
          position: [area.position, 3],
          along: [area.along, 1],
          tint: [area.tint, 3],
          fade: [area.fade, 1],
          delay: [area.delay, 1],
        },
        area.index,
      )
      const disc = new PlaneGeometry(2, 2)
      const dotGeometry = new InstancedBufferGeometry()
      dotGeometry.setIndex(disc.getIndex())
      dotGeometry.setAttribute('position', disc.getAttribute('position'))
      dotGeometry.setAttribute('center', new InstancedBufferAttribute(new Float32Array(centers), 2))
      dotGeometry.setAttribute('tint', new InstancedBufferAttribute(new Float32Array(dotTints), 3))
      dotGeometry.setAttribute(
        'cat',
        new InstancedBufferAttribute(new Float32Array(dotCategories), 1),
      )
      dotGeometry.instanceCount = dotCategories.length
      dots.geometry.dispose()
      dots.geometry = dotGeometry
      guide.scale.set(1, height, 1)
      guide.position.set(0, h / 2 - top - height / 2, 0.1)
    }

    // The tooltip: DOM outside the hidden table, so it shows over the chart.
    const tip = tooltip(ctx.onDispose)
    /** The hovered category, -1 for none. */
    let target = -1
    const show = (i: number, x: number, y: number): void => {
      if (i !== target) {
        target = i
        ctx.invalidate()
      }
      if (i < 0) {
        tip.hide()
        return
      }
      tip.show(
        `<b>${escapeHtml(data.categories[i] ?? '')}</b>` +
          data.series
            .map((s, j) =>
              Number.isNaN(s.values[i] as number)
                ? ''
                : `<div><i style="background:#${colorOf(j).getHexString()}"></i>${escapeHtml(s.name)}<span>${escapeHtml(s.texts[i] ?? '')}</span></div>`,
            )
            .join(''),
        x,
        y,
      )
    }
    /** The category under the pointer, for the tooltip. */
    const pick = (e: PointerEvent): void => {
      const box = element.getBoundingClientRect()
      const x = e.clientX - box.left
      const y = e.clientY - box.top
      const { left, top, width, height } = plot
      let i = -1
      if (categoryCount && y >= top - 4 && y <= top + height + font * 2) {
        if (across) i = Math.floor(((y - top) / height) * categoryCount)
        else if (x >= left - 4 && x <= left + width + 4)
          i = lines
            ? Math.round(categoryCount > 1 ? ((x - left) / width) * (categoryCount - 1) : 0)
            : Math.floor(((x - left) / width) * categoryCount)
      }
      show(i >= 0 && i < categoryCount ? i : -1, e.clientX, e.clientY)
    }
    element.addEventListener('pointermove', pick, { signal })
    element.addEventListener('pointerdown', (e) => e.pointerType !== 'mouse' && pick(e), {
      signal,
    })
    element.addEventListener('pointerleave', () => show(-1, 0, 0), { signal })
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!element.contains(e.target as Element | null)) show(-1, 0, 0)
      },
      { signal },
    )
    window.addEventListener('scroll', () => target >= 0 && show(-1, 0, 0), {
      signal,
      passive: true,
    })

    /** Seconds since the chart started growing, undefined before it came into view. */
    let started: number | undefined
    let layoutKey = ''
    if (DEV && (!categoryCount || !seriesCount))
      ctx.app.log.warn('chart found no numbers in its table or list', element)
    // Geometry before the first compile, from the box as laid out now.
    const startWidth = Math.max(1, ctx.input.width)
    const startHeight = Math.max(1, ctx.input.height)
    measure(startWidth, startHeight)
    draw(startWidth, startHeight)
    build(startWidth, startHeight)

    return (input): boolean => {
      const w = input.width
      const h = input.height
      const key = `${w}x${h} ${params.grid} ${params.labels} ${params.max} ${params.stagger}`
      if (key !== layoutKey && w > 0 && h > 0) {
        layoutKey = key
        measure(w, h)
        draw(w, h)
        build(w, h)
      }
      length.value = Math.max(params.duration, 1e-3)
      // Grows once, when a third of it is above the bottom tenth of the viewport.
      if (started === undefined && inView(input.y, h, ctx.app.stage.height.peek(), SHOWN))
        started = 0
      const end =
        params.duration + Math.max(0, params.stagger) * (categoryCount + seriesCount * 3) + 0.1
      if (started !== undefined && started < end)
        started = input.reducedMotion ? end : started + Math.min(input.delta, 0.1)
      clock.value = started ?? 0
      if (target >= 0) hot.value = target
      const want = target >= 0 ? 1 : 0
      const current = focus.value as number
      focus.value = input.reducedMotion
        ? want
        : Math.abs(current - want) < 0.01
          ? want
          : damp(current, want, 0.06, input.delta)
      if (focus.value === 0) hot.value = -1
      if (lines && target >= 0) guide.position.x = xOf(target) - w / 2
      return (started !== undefined && started < end) || focus.value !== want
    }
  },
})
export default chart
