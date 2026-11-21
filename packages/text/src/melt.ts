import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, fresnel, inView, rng } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  Fn,
  float,
  fwidth,
  If,
  int,
  Loop,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DataUtils,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  RGBAFormat,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { fonts, MAX_SIDE, type Raster, raster, unsupported } from './raster'
import { blur, coverage, distance, refine } from './sdf'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Style = 'drip' | 'wax' | 'chrome'
type Trigger = 'hover' | 'scroll' | 'view' | 'loop'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  strength: number
  drips: number
  speed: number
  gloss: number
  color: string
  seed: number
}

/** Drips the shader holds at most. */
export const MAX_DRIPS = 40
/** Most texels of the distance field. */
const MAX_TEXELS = 900_000
/** How far below the last baseline drops fall before they are gone, em; the quad reaches past it. */
const FALL = 2.1
const REACH = 2.5
/** Seconds of a full melt at speed 1: under the pointer, in view, and the loop's first melt. */
const HEAT = 0.8
const COOL = 1.7
const MELT = 2.6
const INTRO = 1.8
/** Share of a drip's run after which a releasing drip lets its drop go. */
const RELEASE = 0.72
/** Share of the box in view (above the bottom tenth) before trigger view melts. */
const SHOWN = 0.5
/** Scroll: the box centre (viewport heights from the top) where melting starts, and its span. */
const START = 0.62
const SPAN = 0.45
/** Seconds a tap keeps the spot under the finger hot. */
const TAP = 1.4
/** Frames a second of the loop. */
const LOOP_FPS = 30

/** How a style melts and shines. Lengths in em of the font size. */
export interface Look {
  /** Share of a letter's height its top sinks by at full melt. */
  readonly sag: number
  /** How much fatter the foot of a letter gets. */
  readonly swell: number
  /** Blur that rounds the corners of the liquid shape, and how far the letters take it. */
  readonly soft: number
  readonly round: number
  /** Radius of the round profile of the liquid's edge, and the span its slope is taken over. */
  readonly radius: number
  readonly smooth: number
  /** Length of the drips and the radius of their streams; bulb per stream radius. */
  readonly drip: number
  readonly width: number
  readonly bulb: number
  /** Thickness and reach of the pool at the foot of the letters (wax). */
  readonly pool: number
}

const LOOKS: Readonly<Record<Style, Look>> = {
  drip: {
    sag: 0.05,
    swell: 0.012,
    soft: 0.03,
    round: 0.5,
    radius: 0.07,
    smooth: 0.022,
    drip: 1,
    width: 0.05,
    bulb: 1.55,
    pool: 0,
  },
  wax: {
    sag: 0.18,
    swell: 0.04,
    soft: 0.045,
    round: 0.8,
    radius: 0.14,
    smooth: 0.035,
    drip: 0.5,
    width: 0.075,
    bulb: 1.3,
    pool: 1,
  },
  chrome: {
    sag: 0.13,
    swell: 0.03,
    soft: 0.06,
    round: 0.85,
    radius: 0.3,
    smooth: 0.05,
    drip: 0.75,
    width: 0.07,
    bulb: 1.7,
    pool: 0,
  },
}

/** The key light, toward it from the letters: up, left and in front. */
const KEY: readonly [number, number, number] = [-0.42, 0.62, 0.66]

/** Phases with the liquid moving: frames a second for the policy. */
const pacing = new WeakMap<AbortSignal, () => number>()
/**
 * Where an element's last melt was, so a rebuild with the same look (a quality tier change) picks
 * it up instead of playing it again.
 */
const kept = new WeakMap<Element, { key: string; since: number; clock: number }>()

/** A CSS color as `#rrggbb`: var() and currentColor are read from the element. */
function colorOf(value: string, element: Element): string | undefined {
  const style = getComputedStyle(element)
  let word = value.trim()
  for (let depth = 0; depth < 8; depth++) {
    const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/is.exec(word)
    if (!variable) break
    word = style.getPropertyValue(variable[1] as string).trim() || (variable[2] ?? '').trim()
  }
  if (!word || word.toLowerCase() === 'currentcolor') {
    const fill = style.getPropertyValue('-webkit-text-fill-color')
    word = fill && !/^(transparent|rgba\(.*,\s*0\))$/.test(fill) ? fill : style.color
  }
  return cssColor(word)
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** One line of text: its baseline, font size, the band of the box it owns and its ends, box px. */
export interface Line {
  readonly base: number
  readonly em: number
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/** The lines of a raster top down, each owning the box down to halfway to the next one. */
export function linesOf(layout: Raster): Line[] {
  const found: { base: number; em: number; y0: number; y1: number; x0: number; x1: number }[] = []
  for (const q of [...layout.quads].sort((a, b) => a.base - b.base)) {
    const last = found[found.length - 1]
    if (last && Math.abs(last.base - q.base) < 0.5) {
      last.em = Math.max(last.em, q.em)
      last.y0 = Math.min(last.y0, q.y)
      last.y1 = Math.max(last.y1, q.y + q.height)
      last.x0 = Math.min(last.x0, q.x)
      last.x1 = Math.max(last.x1, q.x + q.width)
    } else
      found.push({
        base: q.base,
        em: q.em,
        y0: q.y,
        y1: q.y + q.height,
        x0: q.x,
        x1: q.x + q.width,
      })
  }
  return found.map((l, i) => {
    const prev = found[i - 1]
    const next = found[i + 1]
    return {
      base: l.base,
      em: l.em,
      top: prev ? (prev.y1 + l.y0) / 2 : Number.NEGATIVE_INFINITY,
      bottom: next ? (l.y1 + next.y0) / 2 : Number.POSITIVE_INFINITY,
      left: l.x0,
      right: l.x1,
    }
  })
}

/** The line that owns box y. */
const lineAt = (lines: readonly Line[], y: number): Line | undefined =>
  lines.find((l) => y < l.bottom) ?? lines[lines.length - 1]

/** A stretch of the underside of the letters near a baseline, where liquid runs off. */
export interface Edge {
  /** Box x of the first column; the columns are 1 px apart. */
  readonly left: number
  /** Box y of the edge in each column. */
  readonly ys: Float32Array
  readonly em: number
}

/**
 * The undersides of the glyphs that liquid can run off: per line and column the lowest edge of the
 * ink, kept where it reaches down to the baseline or below (feet of stems, bottoms of bowls,
 * descenders), in runs without jumps. `field` is the signed distance in texels (negative inside),
 * `scale` texels per px over `frame`.
 */
export function edges(
  field: Float32Array,
  w: number,
  h: number,
  scale: number,
  frame: readonly [number, number, number, number],
  lines: readonly Line[],
): Edge[] {
  const [frameX, frameY] = frame
  const out: Edge[] = []
  for (const line of lines) {
    const firstRow = Math.max(
      0,
      Math.floor((Math.max(line.top, line.base - line.em * 1.2) - frameY) * scale),
    )
    const lastRow = Math.min(
      h - 1,
      Math.ceil((Math.min(line.bottom, line.base + line.em * 0.6) - frameY) * scale),
    )
    const lowest = line.base - line.em * 0.12
    let run: number[] = []
    let left = 0
    const close = (): void => {
      if (run.length >= Math.max(2, line.em * 0.04))
        out.push({ left, ys: Float32Array.from(run), em: line.em })
      run = []
    }
    const lastX = Math.min(line.right, frameX + w / scale - 1)
    for (let x = Math.ceil(Math.max(line.left, frameX)); x < lastX; x++) {
      const column = Math.min(w - 1, Math.max(0, Math.floor((x + 0.5 - frameX) * scale)))
      let y = Number.NaN
      for (let row = lastRow; row >= firstRow; row--) {
        const inside = field[row * w + column] as number
        if (inside < 0) {
          y = frameY + (row + 0.5 + Math.min(1, -inside)) / scale
          break
        }
      }
      const deep = y >= lowest
      const prev = run[run.length - 1]
      if (!deep || (prev !== undefined && Math.abs(y - prev) > line.em * 0.2)) close()
      if (!deep) continue
      if (!run.length) left = x
      run.push(y)
    }
    close()
  }
  return out
}

/** One drip: where it hangs from and how it runs. Lengths in box px unless said otherwise. */
export interface Drip {
  /** Middle of the stream and the edge it runs off. */
  readonly x: number
  readonly y: number
  /** Radius of the stream and of the bulb at its end. */
  readonly r: number
  readonly rb: number
  /** Full length at strength 1, em. */
  readonly length: number
  /** Melt 0..1 it starts at. */
  readonly start: number
  /** It lets its drop go before it is done. */
  readonly release: boolean
  /** Seconds of one drop in the loop, and where in it the drip starts, 0..1. */
  readonly period: number
  readonly phase: number
  readonly em: number
}

/**
 * Up to `count` drips spread along the edges, about evenly with a seeded jitter: the stream fits
 * its edge, two never touch.
 */
export function place(list: readonly Edge[], count: number, seed: number, look: Look): Drip[] {
  const random = rng(Math.round(seed) * 7919 + 17)
  const total = list.reduce((s, e) => s + e.ys.length, 0)
  const out: Drip[] = []
  const drips = Math.min(MAX_DRIPS, Math.max(0, Math.round(count)))
  if (!total || !drips) return out
  for (let i = 0; i < drips; i++) {
    let at = ((i + 0.15 + random() * 0.7) / drips) * total
    const [kr, kl, kb, ks, kq, kp, kf] = [
      random(),
      random(),
      random(),
      random(),
      random(),
      random(),
      random(),
    ]
    let edge = list[0] as Edge
    for (const e of list) {
      edge = e
      if (at < e.ys.length) break
      at -= e.ys.length
    }
    const cols = edge.ys.length
    const radius = Math.min(edge.em * look.width * (0.7 + 0.6 * kr), cols * 0.32)
    if (radius < 0.75) continue
    const minColumn = Math.min(cols - 1, Math.ceil(radius))
    const maxColumn = Math.max(minColumn, cols - 1 - Math.ceil(radius))
    const col = Math.round(Math.min(maxColumn, Math.max(minColumn, at)))
    const x = edge.left + col + 0.5
    const y = edge.ys[col] as number
    if (
      out.some((d) => Math.abs(d.x - x) < (d.r + radius) * 1.5 && Math.abs(d.y - y) < edge.em * 0.5)
    )
      continue
    out.push({
      x,
      y,
      r: radius,
      rb: radius * look.bulb * (0.9 + 0.25 * kb),
      length: 0.3 + 1.2 * kl ** 1.5,
      start: ks * 0.45,
      release: kq < 0.5 && kl > 0.3,
      period: 3.2 + kp * 3.6,
      phase: kf,
      em: edge.em,
    })
  }
  return out
}

/** The liquid's shape over the raster's frame and a margin around it. */
interface Pool {
  /**
   * Per texel, half floats: the signed distance to the glyph edge and to its rounded shape in px
   * (negative inside), the baseline of the texel's line less the texel's y, and its font size.
   */
  readonly data: Uint16Array
  readonly width: number
  readonly height: number
  /** The field in box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  readonly lines: readonly Line[]
  readonly edges: readonly Edge[]
  /** Largest font size, px. */
  readonly em: number
}

const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Builds the distance fields of the text and of its rounded shape, and finds the undersides. */
async function pour(layout: Raster, look: Look, ratio: number): Promise<Pool> {
  const lines = linesOf(layout)
  const em = Math.max(1, ...layout.quads.map((q) => q.em))
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const rasterScale = Math.min(ratio, MAX_SIDE / Math.max(frameWidth, frameHeight))
  const canvasWidth = layout.canvas.width / rasterScale
  const canvasHeight = layout.canvas.height / rasterScale
  const margin = Math.ceil(em * 0.6) + 4
  const fieldWidth = canvasWidth + 2 * margin
  const fieldHeight = canvasHeight + 2 * margin
  const scale = Math.min(
    1.5,
    ratio,
    MAX_SIDE / Math.max(fieldWidth, fieldHeight),
    Math.sqrt(MAX_TEXELS / Math.max(1, fieldWidth * fieldHeight)),
  )
  const texelsWide = Math.max(1, Math.ceil(fieldWidth * scale))
  const texelsHigh = Math.max(1, Math.ceil(fieldHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = texelsWide
  canvas.height = texelsHigh
  canvas
    .getContext('2d')
    ?.drawImage(
      layout.canvas,
      margin * scale,
      margin * scale,
      canvasWidth * scale,
      canvasHeight * scale,
    )
  const alpha = coverage(canvas, texelsWide, texelsHigh)
  const sharp = distance(alpha, texelsWide, texelsHigh)
  refine(alpha, texelsWide, texelsHigh, sharp)
  await breathe()
  // The rounded shape: the coverage blurred, then cut at half again with a ramp about a texel wide.
  const sigma = look.soft * em * scale
  const soft = blur(alpha, texelsWide, texelsHigh, sigma)
  const k = Math.max(1, sigma * Math.sqrt(2 * Math.PI))
  for (let i = 0; i < soft.length; i++) soft[i] = clamp01(0.5 + ((soft[i] as number) - 0.5) * k)
  const round = distance(soft, texelsWide, texelsHigh)
  refine(soft, texelsWide, texelsHigh, round)
  await breathe()
  const frame: [number, number, number, number] = [
    frameX - margin,
    frameY - margin,
    texelsWide / scale,
    texelsHigh / scale,
  ]
  const data = new Uint16Array(texelsWide * texelsHigh * 4)
  const half = DataUtils.toHalfFloat
  const cap = (v: number): number => Math.max(-4096, Math.min(4096, v / scale))
  for (let y = 0; y < texelsHigh; y++) {
    const at = frame[1] + (y + 0.5) / scale
    const line = lineAt(lines, at)
    const base = half(line ? line.base - at : 0)
    const size = half(line?.em ?? em)
    for (let x = 0; x < texelsWide; x++) {
      const i = y * texelsWide + x
      data[i * 4] = half(cap(sharp[i] as number))
      data[i * 4 + 1] = half(cap(round[i] as number))
      data[i * 4 + 2] = base
      data[i * 4 + 3] = size
    }
  }
  return {
    data,
    width: texelsWide,
    height: texelsHigh,
    frame,
    lines,
    edges: edges(sharp, texelsWide, texelsHigh, scale, frame, lines),
    em,
  }
}

function halfTexture(data: Uint16Array, w: number, h: number): DataTexture {
  const map = new DataTexture(data, w, h, RGBAFormat, HalfFloatType)
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/** How hot the text is under and around the pointer: a coarse grid over the drawn quad. */
class Heat {
  readonly values: Float32Array
  readonly data: Uint16Array
  readonly map: DataTexture
  constructor(
    readonly w: number,
    readonly h: number,
    readonly frame: readonly [number, number, number, number],
  ) {
    this.values = new Float32Array(w * h)
    this.data = new Uint16Array(w * h * 4)
    this.map = halfTexture(this.data, w, h)
  }
  /** Bilinear heat at box px. */
  at(x: number, y: number): number {
    const [frameX, frameY, frameWidth, frameHeight] = this.frame
    const gridX = Math.min(this.w - 1, Math.max(0, ((x - frameX) / frameWidth) * this.w - 0.5))
    const gridY = Math.min(this.h - 1, Math.max(0, ((y - frameY) / frameHeight) * this.h - 0.5))
    const x0 = Math.floor(gridX)
    const y0 = Math.floor(gridY)
    const x1 = Math.min(this.w - 1, x0 + 1)
    const y1 = Math.min(this.h - 1, y0 + 1)
    const fractionX = gridX - x0
    const fractionY = gridY - y0
    const values = this.values
    const top =
      (values[y0 * this.w + x0] as number) * (1 - fractionX) +
      (values[y0 * this.w + x1] as number) * fractionX
    const low =
      (values[y1 * this.w + x0] as number) * (1 - fractionX) +
      (values[y1 * this.w + x1] as number) * fractionX
    return top * (1 - fractionY) + low * fractionY
  }
  max(): number {
    let m = 0
    for (const v of this.values) m = Math.max(m, v)
    return m
  }
  upload(): void {
    for (let i = 0; i < this.values.length; i++)
      this.data[i * 4] = DataUtils.toHalfFloat(this.values[i] as number)
    this.map.needsUpdate = true
  }
}

/**
 * Letters melt like hot wax, paint or liquid metal: the shape of the glyphs sags, rounds off and
 * runs down in glossy drips that stretch, neck and let their drops fall, lit as a 3D liquid with
 * sharp highlights, studio reflections and a soft shadow on the page. The text stays in the DOM.
 */
const melt: Effect<Params> = defineEffect({
  name: 'melt',
  params: {
    style: oneOf('drip', 'wax', 'chrome'),
    trigger: oneOf('hover', 'scroll', 'view', 'loop'),
    strength: 1,
    drips: 12,
    speed: 1,
    gloss: 1,
    color: '',
    seed: 1,
  },
  rebuild: ['drips', 'seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  // Drips and drops run below the box.
  bleed: 320,
  quality: { low: { drips: 8 } },
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const ratio = ctx.quality === 'low' ? 1 : 2
    const style = params.style
    const trigger = params.trigger
    const look = LOOKS[style]
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`melt: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    let pool = await pour(layout, look, ratio)
    if (signal.aborted) return
    let drips = place(pool.edges, params.drips, params.seed, look)

    const hex = params.color.trim() ? colorOf(params.color, element) : undefined
    if (!hex && params.color.trim() && DEV)
      app.log.warn(`melt: "${params.color}" is not a color, using the text color`, element)
    const ink = new Color(hex ?? colorOf('', element) ?? '#888888')
    const tint = uniform(ink)

    // The quad: the field and room below it for the drips and the falling drops.
    const quadOf = (pool: Pool): [number, number, number, number] => {
      const [x, y, w, h] = pool.frame
      const last = pool.lines[pool.lines.length - 1]
      const bottom = Math.max(y + h, (last?.base ?? y + h) + pool.em * REACH)
      return [x, y, w, bottom - y]
    }
    const quad = uniform(new Vector4(...quadOf(pool)))
    const field = uniform(new Vector4(...pool.frame))
    // Box y past which drops are gone.
    const end = uniform(0)
    const melted = uniform(0)
    const count = uniform(0, 'int')
    const dripA = uniformArray(
      Array.from({ length: MAX_DRIPS }, () => new Vector4()),
      'vec4',
    )
    const dripB = uniformArray(
      Array.from({ length: MAX_DRIPS }, () => new Vector4()),
      'vec4',
    )
    const cell = (p: Pool): number => Math.max(4, p.em * 0.22)
    const heatOf = (pool: Pool): Heat => {
      const q = quadOf(pool)
      return new Heat(
        Math.max(2, Math.ceil(q[2] / cell(pool))),
        Math.max(2, Math.ceil(q[3] / cell(pool))),
        q,
      )
    }
    let heat = heatOf(pool)
    const fieldMap = texture(halfTexture(pool.data, pool.width, pool.height))
    const heatMap = texture(heat.map)

    const corner = positionGeometry.xy
    const quadX = quad.x.add(corner.x.mul(quad.z))
    const quadY = quad.y.add(corner.y.mul(quad.w))
    const half = u.size.mul(0.5)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    material.positionNode = vec3(quadX.sub(half.x), half.y.sub(quadY), 0)
    const pointV = varying(vec2(quadX, quadY)) as unknown as V2

    const rnd = rng(Math.round(params.seed) * 31 + 5)
    const phase = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28]
    const smin = (a: F, b: F, k: F): F => {
      const softness = max(k, 1e-3)
      const t = clamp(b.sub(a).div(softness).mul(0.5).add(0.5), 0, 1)
      return mix(b, a, t).sub(softness.mul(t).mul(t.oneMinus())) as unknown as F
    }

    material.colorNode = Fn(() => {
      const point = pointV
      const pixel = max(max(fwidth(point.x), fwidth(point.y)), 1e-3)
      const uvAt = (q: V2): V2 =>
        vec2(q.x.sub(field.x).div(field.z), q.y.sub(field.y).div(field.w)) as unknown as V2
      // The line here: its baseline and font size, from the nearest row inside the field.
      const rowY = clamp(point.y, field.y.add(1), field.y.add(field.w).sub(1))
      const rowX = clamp(point.x, field.x.add(1), field.x.add(field.z).sub(1))
      const row = fieldMap.sample(uvAt(vec2(rowX, rowY) as unknown as V2)).level(float(0))
      const base = rowY.add(row.z).toVar()
      const em = max(row.w, 1).toVar()
      // How melted it is here: the trigger's melt, uneven along the line, or the pointer's heat.
      const hot = heatMap
        .sample(vec2(point.x.sub(quad.x).div(quad.z), point.y.sub(quad.y).div(quad.w)))
        .level(float(0)).x
      const xInEm = point.x.div(em)
      const vary = sin(xInEm.mul(1.31).add(phase[0] as number))
        .mul(0.6)
        .add(sin(xInEm.mul(0.57).add(phase[1] as number)).mul(0.4))
        .mul(0.28)
        .add(0.72)
      const level = max(melted.mul(vary), hot).clamp(0, 1).toVar()
      const wet = smoothstep(0, 0.35, max(melted, hot)).toVar()
      const amount = clamp(u.strength, 0, 2)
      const sag = clamp(level.mul(amount).mul(look.sag), 0, 0.8)
      const rounding = level.mul(look.round)
      const swell = level.mul(amount).mul(look.swell).mul(em)
      const time = u.time

      // The letters, sunk toward the baseline, rounded and fattened at the foot.
      const letters = (q: V2): F => {
        const above = base.sub(q.y)
        const sagged = smoothstep(em.mul(-0.2), em.mul(0.25), above).mul(sag)
        const src = vec2(q.x, base.sub(above.div(sagged.oneMinus())))
        const fieldSample = fieldMap.sample(uvAt(src as unknown as V2)).level(float(0))
        let distance = mix(fieldSample.x, fieldSample.y, rounding).sub(
          swell.mul(exp(max(above, 0).div(em.mul(0.3)).negate())),
        ) as unknown as F
        if (look.pool > 0) {
          // Wax pools at the foot: a slab along the baseline under the stems, joined to them.
          const foot = fieldMap
            .sample(uvAt(vec2(q.x, base.sub(em.mul(0.05))) as unknown as V2))
            .level(float(0)).x
          // Uneven along the line, so it reads as poured and not as a ledge.
          const lump = sin(
            q.x
              .div(em)
              .mul(2.3)
              .add(phase[2] as number),
          )
            .mul(0.5)
            .add(
              sin(
                q.x
                  .div(em)
                  .mul(5.1)
                  .add(phase[0] as number),
              ).mul(0.25),
            )
            .add(0.75)
          const t = level
            .mul(amount)
            .mul(em)
            .mul(0.04 * look.pool)
            .mul(lump)
          const slab = max(
            foot.sub(
              level
                .mul(amount)
                .mul(em)
                .mul(0.08 * look.pool)
                .mul(lump),
            ),
            abs(q.y.sub(base.add(t.mul(0.5)))).sub(t),
          )
          distance = smin(distance, slab as unknown as F, em.mul(0.09))
        }
        if (style === 'chrome') {
          // Liquid metal trembles at its edge.
          const wobble = sin(q.x.div(em).mul(9).add(time.mul(2.2)))
            .mul(sin(q.y.div(em).mul(7).sub(time.mul(1.7))))
            .mul(level)
            .mul(em)
            .mul(0.008)
          distance = distance.add(wobble) as unknown as F
        }
        return distance
      }
      // The letters joined with the drips: a stream that widens to a bulb, and its falling drop.
      const liquid = (q: V2): F => {
        const out = letters(q).toVar()
        Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }) => {
          const a = dripA.element(i) as unknown as V4
          const b = dripB.element(i) as unknown as V4
          const dx = abs(q.x.sub(a.x))
          If(dx.lessThan(max(b.x, b.z).mul(3).add(b.w).add(2)), () => {
            // Uneven capsule: radius b.x at the tip (a.w), a.z at the top (a.y).
            const h = max(a.w.sub(a.y), 0.01)
            const lp = vec2(dx, a.w.sub(q.y))
            const k1 = clamp(b.x.sub(a.z).div(h), -0.98, 0.98)
            const k2 = sqrt(k1.mul(k1).oneMinus())
            const along = dot(lp, vec2(k1.negate(), k2))
            const stream = select(
              along.lessThan(0),
              length(lp).sub(b.x),
              select(
                along.greaterThan(k2.mul(h)),
                length(lp.sub(vec2(0, h))).sub(a.z),
                dot(lp, vec2(k2, k1)).sub(b.x),
              ),
            ) as unknown as F
            // A falling drop stretches a little.
            const stretch = clamp(b.y.sub(a.w).div(b.z.mul(3).add(1)), 0, 1)
              .mul(0.3)
              .add(1)
            const drop = select(
              b.z.greaterThan(0),
              length(vec2(dx, q.y.sub(b.y).div(stretch))).sub(b.z),
              float(1e4),
            ) as unknown as F
            const one = smin(stream, drop, b.z.mul(0.9).add(0.5) as unknown as F)
            out.assign(smin(out as unknown as F, one, b.w as unknown as F))
          })
        })
        return out as unknown as F
      }

      const surface = liquid(point).toVar()
      // The slope across a few px: smooth over the ridge in the middle of a stroke, where the
      // distance turns, so the liquid is round there and not creased.
      const e = max(pixel, em.mul(look.smooth))
      const at = (x: number, y: number): F =>
        liquid(point.add(vec2(e.mul(x), e.mul(y))) as unknown as V2)
      const gradX = at(1, 0).sub(at(-1, 0)).div(e.mul(2))
      const gradY = at(0, 1).sub(at(0, -1)).div(e.mul(2))
      // The shadow: the liquid's shape shifted away from the key light, soft by its height.
      const lift = em.mul(0.075).mul(wet)
      const shade = liquid(point.sub(vec2(-KEY[0], KEY[1]).mul(lift)) as unknown as V2)

      // A round profile over `radius` from the edge in: its slope gives the normal.
      const radius = em.mul(look.radius).mul(wet.mul(0.6).add(0.4))
      const depthShare = clamp(surface.negate().div(radius), 0, 1)
      const slope = min(
        depthShare
          .oneMinus()
          .div(sqrt(max(depthShare.mul(2).sub(depthShare.mul(depthShare)), 0.0025))),
        6,
      )
      const grad = vec2(gradX, gradY)
      const slopeDir = grad.div(max(length(grad), 1))
      let normal: V3 = normalize(
        vec3(slopeDir.x.mul(slope), slopeDir.y.mul(slope).negate(), 1),
      ) as unknown as V3
      if (style === 'chrome') {
        // Ripples run over the metal.
        const wave1 = cos(dot(point, vec2(0.8, 0.6)).div(em).mul(15).sub(time.mul(3.1)))
        const wave2 = cos(dot(point, vec2(-0.5, 0.86)).div(em).mul(11).sub(time.mul(2.3)))
        const ripple = vec2(wave1.mul(0.8).sub(wave2.mul(0.5)), wave1.mul(0.6).add(wave2.mul(0.86)))
          .mul(level)
          .mul(0.06)
          .mul(depthShare)
        normal = normalize(normal.add(vec3(ripple, 0))) as unknown as V3
      }
      normal = normalize(mix(vec3(0, 0, 1), normal, wet)) as unknown as V3
      const view = normalize(cameraPosition.sub(positionWorld))
      const facingView = clamp(dot(normal, view), 0, 1)
      const reflected = reflect(view.negate(), normal) as unknown as V3
      const key = normalize(vec3(...KEY))
      const facingKey = dot(normal, key)
      const facingHalfway = max(dot(normal, normalize(key.add(view))), 0)
      const gloss = clamp(u.gloss, 0, 2)

      // A small photo studio to reflect: sky over a horizon, a dark floor, a softbox overhead and
      // strips at the sides; turned so a face toward the viewer sees the sky just over the horizon.
      const studio = (dir: V3, soft: number, dark = 0): V3 => {
        const rise = dir.y.add(dir.z.mul(0.32))
        const up = mix(vec3(0.95, 0.97, 1), vec3(0.16, 0.22, 0.36), smoothstep(0.05, 0.85, rise))
        // A dark floor with a soft white card low in front.
        const below = rise.negate()
        const down = mix(
          vec3(0.01, 0.01, 0.014),
          vec3(0.16, 0.15, 0.15),
          smoothstep(0.1, 0.9, below),
        ).add(exp(below.sub(0.42).div(0.1).pow(2).mul(-0.5)).mul(0.55))
        // The room behind the viewer, dim for paint and wax: a face toward the viewer keeps its color.
        const sky = mix(down, up, smoothstep(-soft, soft, rise)).mul(
          smoothstep(0.7, 0.97, dir.z).mul(-dark).add(1),
        )
        const ax = abs(dir.x)
        const box = smoothstep(0.38, 0.42, rise)
          .mul(smoothstep(0.68, 0.64, rise))
          .mul(smoothstep(0.62, 0.5, ax))
        const strip = smoothstep(0.5, 0.55, ax)
          .mul(smoothstep(0.76, 0.71, ax))
          .mul(smoothstep(-0.3, 0.05, rise))
        return sky.add(box.mul(1.6)).add(strip.mul(0.8)) as unknown as V3
      }
      // Only the bright parts of the studio show in a clear coat, so the color stays rich.
      const bright = (c: V3): V3 => max(c.sub(0.4), vec3(0)).mul(1.6) as unknown as V3
      const albedo = tint as unknown as V3
      let lit: V3
      let alpha: F = clamp(surface.negate().div(pixel).add(0.5), 0, 1) as unknown as F
      let castColor: V3 = albedo.mul(0.02) as unknown as V3
      let castStrength = 0.36
      if (style === 'chrome') {
        // Mercury: a mirror whose own color barely tints it, white at grazing angles.
        const baseReflectance = mix(
          vec3(0.9, 0.92, 0.95),
          albedo.div(max(max(albedo.x, albedo.y), max(albedo.z, 0.05))),
          0.25,
        )
        const reflectance = mix(baseReflectance, vec3(1), pow(facingView.oneMinus(), 5))
        const spec = pow(facingHalfway, 400).mul(3).add(pow(facingHalfway, 60).mul(0.2))
        lit = studio(reflected, 0.01).mul(reflectance).add(spec.mul(gloss)) as unknown as V3
        lit = mix(albedo.mul(0.4), lit, clamp(gloss.mul(0.5).add(0.5), 0, 1)) as unknown as V3
        castColor = vec3(0.02, 0.02, 0.025) as unknown as V3
      } else if (style === 'wax') {
        // Warm translucent wax: deep where thick, glowing where thin, soft light and a wet sheen.
        const thick = smoothstep(0, 1, depthShare)
        const wrap = clamp(facingKey.add(0.8).div(1.8), 0, 1).div((KEY[2] + 0.8) / 1.8)
        const deep = pow(max(albedo, vec3(0.002)), vec3(thick.mul(1.1).add(1)))
        const body = mix(albedo, deep, 0.6).mul(wrap.mul(0.7).add(0.3))
        // Light scattered through the thin parts comes out warm and saturated, brightest on the side
        // away from the key light.
        const peak = max(max(albedo.x, albedo.y), max(albedo.z, 0.05))
        const warm = albedo
          .div(peak)
          .mul(vec3(1, 0.62, 0.3))
          .mul(peak.mul(0.6).add(0.55))
        const thin = pow(thick.oneMinus(), 1.4).mul(facingKey.negate().max(0).mul(0.45).add(0.55))
        const reflectance = pow(facingView.oneMinus(), 5).mul(0.5).add(0.02)
        const spec = pow(facingHalfway, 18).mul(0.08).add(pow(facingHalfway, 150).mul(0.8))
        lit = mix(body, warm, thin.mul(0.7).clamp(0, 1))
          .add(warm.mul(thin).mul(0.25))
          .add(
            bright(studio(reflected, 0.08, 0.85))
              .mul(reflectance)
              .add(spec)
              .mul(gloss),
          ) as unknown as V3
        // Thin rims let the page through, tinted.
        alpha = alpha.mul(mix(float(1), thick.mul(0.16).add(0.84), wet)) as unknown as F
        castColor = albedo.mul(0.4) as unknown as V3
        castStrength = 0.28
      } else {
        // Glossy paint: its color lit by the key, under a clear coat that mirrors the studio.
        const flat = 0.4 + 0.75 * KEY[2]
        const diffuse = albedo.mul(float(0.4).add(max(facingKey, 0).mul(0.75)).div(flat))
        const reflectance = fresnel(facingView, 0.04).mul(gloss.min(1))
        const spec = pow(facingHalfway, 240).mul(2.6).add(pow(facingHalfway, 32).mul(0.08))
        lit = diffuse
          .mul(reflectance.oneMinus())
          .add(bright(studio(reflected, 0.03, 0.85)).mul(reflectance))
          .add(spec.mul(gloss)) as unknown as V3
      }
      lit = mix(albedo, lit, wet) as unknown as V3

      // The letters over their shadow, premultiplied until the end; drops fade out as they fall.
      const cast = smoothstep(em.mul(0.09), em.mul(-0.04), shade).mul(castStrength).mul(wet)
      const under = cast.mul(alpha.oneMinus())
      const total = alpha.add(under)
      const out = lit.mul(alpha).add(castColor.mul(under)).div(max(total, 1e-4)).add(dither())
      const gone = smoothstep(end, end.sub(em.mul(0.6)), point.y)
      // Masked at the nearest point half a pixel inside the box, so drips below it are not cut.
      const boxUV = vec2(point.x.div(u.size.x), point.y.div(u.size.y).oneMinus())
      const inset = vec2(0.5, 0.5).div(max(u.size, vec2(1, 1)))
      return vec4(
        out,
        clamp(total.mul(gone), 0, 1).mul(ctx.mask(clamp(boxUV, inset, inset.oneMinus()))),
      )
    })() as unknown as V4

    const geometry = new BufferGeometry()
    geometry.setIndex([0, 2, 1, 2, 3, 1])
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
    )
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    ctx.onDispose(() => {
      ;(fieldMap.value as Texture).dispose()
      ;(heatMap.value as Texture).dispose()
    })
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const use = (next: Raster, made: Pool): void => {
      layout = next
      pool = made
      drips = place(made.edges, ctx.params.drips, ctx.params.seed, look)
      const oldField = fieldMap.value as Texture
      fieldMap.value = halfTexture(made.data, made.width, made.height)
      oldField.dispose()
      const oldHeat = heat
      heat = heatOf(made)
      heatMap.value = heat.map
      oldHeat.map.dispose()
      field.value.set(...made.frame)
      quad.value.set(...quadOf(made))
      ctx.invalidate()
    }
    // Build again when the text, its fonts or its width change.
    let timer: ReturnType<typeof setTimeout> | undefined
    let building = 0
    const redo = async (): Promise<void> => {
      timer = undefined
      const ticket = ++building
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (!next?.quads.length) return
      const made = await pour(next, look, ratio)
      if (signal.aborted || ticket !== building) return
      use(next, made)
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void redo(), 150)
    }
    ctx.onDispose(() => clearTimeout(timer))
    const text = new MutationObserver(schedule)
    text.observe(element, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => text.disconnect())
    const resize = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width
      if (Math.abs(width - (layout?.width ?? width)) > 0.5) schedule()
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // Hover: the pointer heats the letters near it; focus melts them all; a tap heats its spot.
    const target = (el.closest('a, button') as HTMLElement | null) ?? el
    let mouse: { x: number; y: number } | undefined
    let focused = false
    let tap: { x: number; y: number; left: number } | undefined
    const last = { x: 0, y: 0, width: 0, height: 0 }
    const near = (x: number, y: number): boolean => {
      const m = pool.em
      return (
        x > last.x - m &&
        x < last.x + last.width + m &&
        y > last.y - m &&
        y < last.y + last.height + m
      )
    }
    if (trigger === 'hover') {
      const opts = { signal }
      const passive = { signal, passive: true }
      addEventListener(
        'pointermove',
        (e) => {
          if (e.pointerType === 'touch') return
          const was = mouse && near(mouse.x, mouse.y)
          mouse = { x: e.clientX, y: e.clientY }
          if (was || near(mouse.x, mouse.y)) ctx.invalidate()
        },
        passive,
      )
      target.addEventListener(
        'pointerdown',
        (e) => {
          if (e.pointerType !== 'touch') return
          tap = { x: e.clientX, y: e.clientY, left: TAP }
          ctx.invalidate()
        },
        passive,
      )
      const gone = (): void => {
        mouse = undefined
        ctx.invalidate()
      }
      document.documentElement.addEventListener('pointerleave', gone, opts)
      addEventListener('blur', gone, opts)
      target.addEventListener(
        'focusin',
        () => {
          focused = true
          ctx.invalidate()
        },
        opts,
      )
      target.addEventListener(
        'focusout',
        (e) => {
          if (target.contains(e.relatedTarget as Element | null)) return
          focused = false
          ctx.invalidate()
        },
        opts,
      )
    }

    let dom = false
    let drawn = false
    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }
    // Hover and scroll start as DOM text; view and loop draw the liquid from their first frame.
    if (trigger === 'hover' || trigger === 'scroll') show(true)
    let rate = 0
    pacing.set(signal, () => rate)
    // Seconds of melt since the trigger (view, loop), -1 before; the loop's clock.
    let since = -1
    let clock = 0
    const key = `${style} ${trigger}`
    const prior = kept.get(element)
    if (prior?.key === key) ({ since, clock } = prior)
    // Scroll: the box centre where melting starts, in viewport heights from the top.
    let first: number | undefined

    /** The drips at a melt: their streams and drops into the uniforms. */
    const flow = (meltAt: (d: Drip) => number, loop: boolean): void => {
      const amount = Math.max(0, Math.min(2, ctx.params.strength))
      const last = pool.lines[pool.lines.length - 1]
      const floor = (last?.base ?? 0) + pool.em * FALL
      end.value = floor
      let n = 0
      for (const d of drips) {
        const progress = clamp01((meltAt(d) - d.start) / (1 - d.start))
        const room = Math.max(0, floor - d.y - d.rb * 2.5)
        const full = Math.min(room, d.length * look.drip * amount * d.em)
        if (progress <= 0 || full < 0.5) continue
        const rTop = d.r * smooth(0, 0.2, progress)
        let len = full * smooth(0, 1, progress)
        let rTip = rTop + (d.rb - rTop) * smooth(0, 0.5, progress)
        let yDrop = 0
        let rDrop = 0
        const fallTo = floor + d.rb * 3 - d.y
        if (loop) {
          // One drop a period: the stream grows to full, the drop lets go and falls, the stream
          // pulls back to a stub and grows again.
          const phase = (((d.phase + clock / d.period) % 1) + 1) % 1
          const grow = 0.72
          const intro = smooth(0, 1, progress)
          if (phase < grow) {
            const growth = smooth(0, grow, phase)
            len = full * (0.45 + 0.55 * growth) * intro
            rTip = rTop + (d.rb - rTop) * growth
          } else {
            const tau = (phase - grow) / (1 - grow)
            len = full * (1 - 0.55 * smooth(0, 0.5, tau)) * intro
            rTip = d.rb + (rTop - d.rb) * smooth(0, 0.3, tau)
            yDrop = d.y + full * intro + (fallTo - full * intro) * tau * tau
            rDrop = d.rb * intro
          }
        } else if (d.release && progress > RELEASE) {
          const tau = (progress - RELEASE) / (1 - RELEASE)
          const tip = full * smooth(0, 1, progress)
          len = tip * (1 - 0.4 * smooth(0, 0.6, tau))
          rTip = d.rb + (d.r * 0.85 - d.rb) * smooth(0, 0.35, tau)
          yDrop = d.y + tip + (fallTo - tip) * tau * tau
          rDrop = d.rb
        }
        const top = d.y - rTop * 0.6
        ;(dripA.array[n] as Vector4).set(d.x, top, rTop, top + Math.max(len, 0.01))
        ;(dripB.array[n] as Vector4).set(rTip, yDrop, rDrop, rTop * 1.6 + 0.01)
        n++
      }
      count.value = n
    }

    return (input) => {
      const live = ctx.params
      const reduced = input.reducedMotion
      const dt = Math.min(Math.max(input.delta, 0), 0.1)
      const speed = Math.max(0, live.speed)
      last.x = input.x
      last.y = input.y
      last.width = input.width
      last.height = input.height
      let moving = false
      let m = 0
      let hot = 0

      if (trigger === 'hover') {
        if (reduced) {
          heat.values.fill(0)
        } else {
          // Each cell warms toward the heat of the pointer near it and cools when it leaves; cells
          // below the text take the heat of the letters above them.
          const at = mouse && { x: mouse.x - input.x, y: mouse.y - input.y }
          if (tap) {
            tap.left -= dt
            if (tap.left <= 0) tap = undefined
          }
          const finger = tap && { x: tap.x - input.x, y: tap.y - input.y }
          const pointer = at ?? finger
          const lines = pool.lines
          const top = Math.max(pool.frame[1], (lines[0]?.base ?? 0) - pool.em)
          const bottom = (lines[lines.length - 1]?.base ?? 0) + pool.em * 0.2
          const radiusX = pool.em * 1.3
          const radiusY = pool.em * 1.1
          const [heatX, heatY, heatWidth, heatHeight] = heat.frame
          const up = (dt * speed) / HEAT
          const down = (dt * speed) / COOL
          let changed = false
          for (let y = 0; y < heat.h; y++) {
            const cellY = Math.min(bottom, Math.max(top, heatY + ((y + 0.5) / heat.h) * heatHeight))
            for (let x = 0; x < heat.w; x++) {
              const i = y * heat.w + x
              let want = focused ? 1 : 0
              if (pointer) {
                const cellX = heatX + ((x + 0.5) / heat.w) * heatWidth
                const k = Math.exp(
                  -(((cellX - pointer.x) / radiusX) ** 2) - ((cellY - pointer.y) / radiusY) ** 2,
                )
                if (k > 0.02) want = Math.max(want, Math.min(1, k * 1.25))
              }
              const heatValue = heat.values[i] as number
              const next = Math.fround(
                want > heatValue
                  ? Math.min(want, heatValue + up)
                  : Math.max(want, heatValue - down),
              )
              if (Math.abs(next - heatValue) > 1e-6) {
                heat.values[i] = next < 1e-3 && want === 0 ? 0 : next
                changed = true
              }
            }
          }
          if (changed) heat.upload()
          moving = changed || !!tap
        }
        hot = heat.max()
      } else if (trigger === 'scroll') {
        if (!reduced) {
          const viewport = stage.height.peek() || 1
          const centre = (input.y + input.height / 2) / viewport
          // Text on screen as the page opens starts solid where it is; the rest from START.
          first ??=
            (typeof scrollY === 'number' ? scrollY : 0) < 1 ? Math.min(START, centre) : START
          m = clamp01((first - centre) / SPAN)
        }
      } else if (trigger === 'view') {
        if (reduced) m = 1
        else {
          if (since < 0) {
            if (inView(input.y, input.height, stage.height.peek(), SHOWN)) since = 0
          } else since += dt * speed
          m = since < 0 ? 0 : speed > 0 ? Math.sin((Math.min(1, since / MELT) * Math.PI) / 2) : 1
          moving = since >= 0 && m < 1
        }
      } else if (reduced) m = 1
      else {
        since = Math.max(0, since) + dt * speed
        clock += dt * speed
        m = Math.min(1, since / INTRO)
        moving = speed > 0
      }

      const on = Math.max(m, hot) > 2e-3
      show(!on)
      // The copy takes the picture over on the frame after the one it is first drawn in.
      if (on && !drawn) {
        drawn = true
        setTimeout(() => signal.aborted || ctx.invalidate(), 0)
      } else if (!on) drawn = false
      melted.value = m
      if (on) {
        if (trigger === 'hover') flow((d) => heat.at(d.x, d.y - d.em * 0.3), false)
        else flow(() => m, trigger === 'loop' && !reduced)
      }
      rate = !moving || reduced ? 0 : trigger === 'loop' ? LOOP_FPS : 60
      kept.set(element, { key, since, clock })
    }
  },
})
export default melt
