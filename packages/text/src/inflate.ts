import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, dither, inView } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  attribute,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
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
  sRGBTransferEOTF,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  CanvasTexture,
  Color,
  DataTexture,
  DataUtils,
  DoubleSide,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  RGBAFormat,
  type Texture,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { fonts, MAX_SIDE, type Quad, type Raster, raster, unsupported } from './raster'
import { blur, coverage, distance, refine } from './sdf'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Style = 'balloon' | 'soft' | 'jelly'
type Trigger = 'view' | 'hover' | 'always'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  color: string
  depth: number
  gloss: number
  squish: number
  tilt: number
  duration: number
  stagger: number
  delay: number
  threshold: number
}

/** Field around the text for the shadow, em. */
const PAD_EM = 0.3
/** Most field texels at 2 and at 1 device px per CSS px. */
const MAX_TEXELS = [600_000, 1_600_000] as const
/** Grid cells across a letter's quad, CSS px. */
const CELL = 3
/** Depth of the dent under a hovering pointer, of a press. */
const HOVER_DENT = 0.35
/** Seconds a hovered label takes to go flat again. */
const DEFLATE = 0.32
/** Seconds a returning pointer takes to puff a deflating label back up. */
const REFILL = 0.18
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before building again after a change, ms. */
const REDO_DELAY = 150
/** Texels written between pauses while packing the field. */
const PAUSE_EVERY = 262144

// Attribute names become WGSL and GLSL identifiers: no keyword of either has a capital letter
// after the first.
const BOX = 'puffBox'
const INFO = 'puffInfo'

/** The puffed letters of a raster: the distance to their edge and how round each part is. */
export interface Puff {
  /**
   * Per texel, half floats: the signed distance to the glyph edge in CSS px (positive inside),
   * the height of the round profile at depth 1 in CSS px, the turn of the nearest letter, and
   * that height as a share of the profile's radius (0 at the edge, 1 on the ridge).
   */
  readonly data: Uint16Array
  readonly width: number
  readonly height: number
  /** The field in box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  /** Largest font size, px. */
  readonly em: number
}

/** Lets the page breathe between long steps of a build. */
export type Pause = () => Promise<void>

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/** A pause that yields to the page once 12 ms of work have passed since the last one. */
function breather(): Pause {
  let since = now()
  return async () => {
    if (now() - since < 12) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    since = now()
  }
}

interface Level {
  /** Signed distance at cell centres, CSS px, positive inside. */
  readonly values: Float32Array
  readonly cols: number
  readonly rows: number
  /** Cell size, CSS px. */
  readonly cell: number
}

/** The level at half the resolution: each cell the mean of four. */
function halve(level: Level): Level {
  const halfCols = Math.ceil(level.cols / 2)
  const halfRows = Math.ceil(level.rows / 2)
  const merged = new Float32Array(halfCols * halfRows)
  for (let y = 0; y < halfRows; y++) {
    const rowA = 2 * y * level.cols
    const rowB = Math.min(2 * y + 1, level.rows - 1) * level.cols
    for (let x = 0; x < halfCols; x++) {
      const x0 = 2 * x
      const x1 = Math.min(2 * x + 1, level.cols - 1)
      merged[y * halfCols + x] =
        ((level.values[rowA + x0] as number) +
          (level.values[rowA + x1] as number) +
          (level.values[rowB + x0] as number) +
          (level.values[rowB + x1] as number)) /
        4
    }
  }
  return { values: merged, cols: halfCols, rows: halfRows, cell: level.cell * 2 }
}

/**
 * The five-point Laplacian of the cells inside, red cells first: per cell the weights of its four
 * neighbours and of the load. A neighbour outside is the edge at the distance the field puts it
 * (Shortley and Weller), so the membrane follows the glyph edge between cells.
 */
function stencil(level: Level): { cells: Int32Array; coef: Float32Array } {
  const { values: dist, cols, rows, cell } = level
  let count = 0
  for (let y = 1; y < rows - 1; y++)
    for (let x = 1; x < cols - 1; x++) if ((dist[y * cols + x] as number) > 0) count++
  const cells = new Int32Array(count)
  let index = 0
  for (const parity of [0, 1])
    for (let y = 1; y < rows - 1; y++)
      for (let x = 1 + ((y + parity) % 2); x < cols - 1; x += 2)
        if ((dist[y * cols + x] as number) > 0) cells[index++] = y * cols + x
  const coef = new Float32Array(count * 5)
  const arm = (inside: number, neighbour: number): number =>
    neighbour > 0 ? cell : cell * Math.min(1, Math.max(0.05, inside / (inside - neighbour)))
  for (index = 0; index < count; index++) {
    const i = cells[index] as number
    const distHere = dist[i] as number
    const distRight = dist[i + 1] as number
    const distLeft = dist[i - 1] as number
    const distDown = dist[i + cols] as number
    const distUp = dist[i - cols] as number
    const armRight = arm(distHere, distRight)
    const armLeft = arm(distHere, distLeft)
    const armDown = arm(distHere, distDown)
    const armUp = arm(distHere, distUp)
    const ax = 2 / (armLeft + armRight)
    const ay = 2 / (armUp + armDown)
    const weightRight = ax / armRight
    const weightLeft = ax / armLeft
    const weightDown = ay / armDown
    const weightUp = ay / armUp
    const norm = 1 / (weightRight + weightLeft + weightDown + weightUp)
    const base = index * 5
    coef[base] = distRight > 0 ? weightRight * norm : 0
    coef[base + 1] = distLeft > 0 ? weightLeft * norm : 0
    coef[base + 2] = distDown > 0 ? weightDown * norm : 0
    coef[base + 3] = distUp > 0 ? weightUp * norm : 0
    coef[base + 4] = norm
  }
  return { cells, coef }
}

/** Red-black over-relaxation of the membrane `u` on its stencil. */
async function relax(
  u: Float32Array,
  cols: number,
  system: { cells: Int32Array; coef: Float32Array },
  omega: number,
  sweeps: number,
  pause: Pause,
): Promise<void> {
  const { cells, coef } = system
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let index = 0; index < cells.length; index++) {
      const i = cells[index] as number
      const base = index * 5
      const target =
        (coef[base] as number) * (u[i + 1] as number) +
        (coef[base + 1] as number) * (u[i - 1] as number) +
        (coef[base + 2] as number) * (u[i + cols] as number) +
        (coef[base + 3] as number) * (u[i - cols] as number) +
        (coef[base + 4] as number)
      u[i] = (u[i] as number) + omega * (target - (u[i] as number))
    }
    await pause()
  }
}

/** Bilinear read of a w by h grid at cell coordinates x, y (cell centres at integers). */
function bilinear(grid: Float32Array, cols: number, rows: number, x: number, y: number): number {
  const clampedX = Math.min(cols - 1, Math.max(0, x))
  const clampedY = Math.min(rows - 1, Math.max(0, y))
  const x0 = Math.floor(clampedX)
  const y0 = Math.floor(clampedY)
  const x1 = Math.min(cols - 1, x0 + 1)
  const y1 = Math.min(rows - 1, y0 + 1)
  const fx = clampedX - x0
  const fy = clampedY - y0
  const top = (grid[y0 * cols + x0] as number) * (1 - fx) + (grid[y0 * cols + x1] as number) * fx
  const bottom = (grid[y1 * cols + x0] as number) * (1 - fx) + (grid[y1 * cols + x1] as number) * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * The radius of the round profile over a signed distance field `dist` (CSS px, positive inside,
 * `cols` by `rows` cells of `cell` px), written d below. The letters are inflated like a membrane under pressure: `u` solves
 * Poisson's equation, zero on the glyph edge, coarse to fine. Where a stroke of half-width a is
 * straight, u = d (2a - d) / 2, so the radius u / d + d / 2 is a, and the height
 * sqrt(d (2a - d)) is a round tube; a dot becomes a dome and a joint bulges. Cells outside get the
 * radius of the edge next to them.
 */
export async function membrane(
  dist: Float32Array,
  cols: number,
  rows: number,
  cell: number,
  pause: Pause = async () => {},
): Promise<Float32Array> {
  const levels: Level[] = [{ values: dist, cols, rows, cell }]
  let deepest = 0
  for (const value of dist) if (value > deepest) deepest = value
  // Coarser levels until a stroke is a few cells across.
  while (levels.length < 6) {
    const top = levels.at(-1) as Level
    if (top.cell * 4 > deepest || top.cols < 8 || top.rows < 8) break
    levels.push(halve(top))
  }
  let u: Float32Array | undefined
  for (let depth = levels.length - 1; depth >= 0; depth--) {
    const level = levels[depth] as Level
    const next = new Float32Array(level.cols * level.rows)
    if (u) {
      // From the level above: its cell centres sit half a cell in from ours.
      const up = levels[depth + 1] as Level
      for (let y = 0; y < level.rows; y++)
        for (let x = 0; x < level.cols; x++) {
          const i = y * level.cols + x
          if ((level.values[i] as number) > 0)
            next[i] = bilinear(u, up.cols, up.rows, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5)
        }
    }
    u = next
    await pause()
    const system = stencil(level)
    let top = 0
    for (const value of level.values) if (value > top) top = value
    // The coarsest level starts from nothing and needs sweeps in proportion to its width.
    const sweeps =
      depth === levels.length - 1
        ? Math.min(400, Math.max(24, Math.ceil((6 * top) / level.cell)))
        : 18
    await relax(u, level.cols, system, depth === levels.length - 1 ? 1.85 : 1.5, sweeps, pause)
  }
  const field = u as Float32Array
  // The radius where the distance is known well enough, then smoothed and spread to the edge.
  const radius = new Float32Array(cols * rows)
  const known = new Float32Array(cols * rows)
  for (let i = 0; i < radius.length; i++) {
    const di = dist[i] as number
    if (di >= 1.25 * cell) {
      radius[i] = (field[i] as number) / di + di / 2
      known[i] = 1
    }
  }
  await pause()
  const spread = blur(radius, cols, rows, 2)
  const weight = blur(known, cols, rows, 2)
  for (let i = 0; i < radius.length; i++) {
    const share = weight[i] as number
    // A hairline with no cell deep enough: its own depth.
    radius[i] =
      share > 0.02 ? (spread[i] as number) / share : Math.max(0, dist[i] as number, cell * 0.5)
  }
  return radius
}

/** For each texel row, the turn of the nearest letter piece at each column. */
function labels(
  quads: readonly Quad[],
  frame: readonly [number, number, number, number],
  scale: number,
  cols: number,
  rows: number,
): Float32Array {
  const turns = new Float32Array(cols * rows)
  if (!quads.length) return turns
  const lines = new Map<string, Quad[]>()
  for (const quad of quads) {
    const key = `${quad.y.toFixed(2)} ${quad.height.toFixed(2)}`
    const line = lines.get(key) ?? []
    line.push(quad)
    lines.set(key, line)
  }
  const bands = [...lines.values()].map((line) => line.sort((current, next) => current.x - next.x))
  for (let y = 0; y < rows; y++) {
    const rowY = frame[1] + (y + 0.5) / scale
    let line = bands[0] as Quad[]
    let best = Number.POSITIVE_INFINITY
    for (const band of bands) {
      const quad = band[0] as Quad
      const gap = Math.max(quad.y - rowY, rowY - (quad.y + quad.height), 0)
      if (gap < best) {
        best = gap
        line = band
      }
    }
    let piece = 0
    for (let x = 0; x < cols; x++) {
      const colX = frame[0] + (x + 0.5) / scale
      // The pieces of a line are in order: move on while the next one is nearer.
      while (piece < line.length - 1) {
        const current = line[piece] as Quad
        const next = line[piece + 1] as Quad
        const distCurrent = Math.max(current.x - colX, colX - (current.x + current.width), 0)
        const distNext = Math.max(next.x - colX, colX - (next.x + next.width), 0)
        if (distNext < distCurrent || (distNext === distCurrent && colX >= next.x)) piece++
        else break
      }
      turns[y * cols + x] = (line[piece] as Quad).order
    }
  }
  return turns
}

/**
 * Builds the puffed letters of a raster: a distance field over the raster's frame and a margin
 * for the shadow, the round profile's radius from an inflated membrane, and the nearest letter.
 */
export async function puff(
  layout: Raster,
  ratio: number,
  pause: Pause = breather(),
): Promise<Puff> {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const em = Math.max(1, ...layout.quads.map((line) => line.em))
  // The raster's own scale, as raster() chose it.
  const rasterScale = Math.min(ratio, MAX_SIDE / Math.max(frameWidth, frameHeight))
  const pad = Math.ceil(em * PAD_EM) + 2
  const most = MAX_TEXELS[ratio >= 2 ? 1 : 0]
  let scale = rasterScale
  while (scale > 0.25 && (frameWidth + 2 * pad) * (frameHeight + 2 * pad) * scale * scale > most)
    scale *= 0.85
  const margin = Math.ceil(pad * scale)
  const canvasWidth = layout.canvas.width
  const canvasHeight = layout.canvas.height
  let cols: number
  let rows: number
  let alpha: Float32Array
  if (scale === rasterScale) {
    // Texel for texel, the raster at a whole texel's offset.
    cols = canvasWidth + 2 * margin
    rows = canvasHeight + 2 * margin
    alpha = new Float32Array(cols * rows)
    const ink = coverage(layout.canvas, canvasWidth, canvasHeight)
    for (let y = 0; y < canvasHeight; y++)
      alpha.set(ink.subarray(y * canvasWidth, (y + 1) * canvasWidth), (y + margin) * cols + margin)
  } else {
    cols = Math.ceil(canvasWidth * (scale / rasterScale)) + 2 * margin
    rows = Math.ceil(canvasHeight * (scale / rasterScale)) + 2 * margin
    const canvas = document.createElement('canvas')
    canvas.width = cols
    canvas.height = rows
    canvas
      .getContext('2d')
      ?.drawImage(
        layout.canvas,
        margin,
        margin,
        canvasWidth * (scale / rasterScale),
        canvasHeight * (scale / rasterScale),
      )
    alpha = coverage(canvas, cols, rows)
  }
  const frame = [
    frameX - margin / scale,
    frameY - margin / scale,
    cols / scale,
    rows / scale,
  ] as const
  await pause()
  const sdf = distance(alpha, cols, rows)
  await pause()
  refine(alpha, cols, rows, sdf, 4)
  const far = pad * 2 + em
  for (let i = 0; i < sdf.length; i++)
    sdf[i] = Math.max(-far, Math.min(far, -(sdf[i] as number) / scale))
  await pause()

  // The membrane on cells of about one CSS px.
  const stride = scale > 1 ? 2 : 1
  const base: Level =
    stride === 2
      ? halve({ values: sdf, cols, rows, cell: 1 / scale })
      : { values: sdf, cols, rows, cell: 1 / scale }
  const radius = await membrane(base.values, base.cols, base.rows, base.cell, pause)
  const turn = labels(layout.quads, frame, scale, cols, rows)
  await pause()

  // The height of a round profile of depth 1, softened by a texel or so: the distance field's
  // steps would streak the normals.
  const lift = new Float32Array(cols * rows)
  const thick = new Float32Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    const gridY = (y + 0.5) / stride - 0.5
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const radiusHere =
        stride === 1
          ? (radius[i] as number)
          : bilinear(radius, base.cols, base.rows, (x + 0.5) / stride - 0.5, gridY)
      const depth = Math.min(radiusHere, Math.max(0, sdf[i] as number))
      const rise = Math.sqrt(Math.max(0, depth * (2 * radiusHere - depth)))
      lift[i] = rise
      thick[i] = radiusHere > 1e-3 ? rise / radiusHere : 0
    }
  }
  await pause()
  const soft = blur(lift, cols, rows, Math.max(1.2, 0.85 * scale))
  await pause()
  const data = new Uint16Array(cols * rows * 4)
  const toHalf = DataUtils.toHalfFloat
  for (let i = 0; i < lift.length; i++) {
    const texel = i * 4
    data[texel] = toHalf(sdf[i] as number)
    data[texel + 1] = toHalf(soft[i] as number)
    data[texel + 2] = toHalf(turn[i] as number)
    data[texel + 3] = toHalf(thick[i] as number)
    if (i % PAUSE_EVERY === PAUSE_EVERY - 1) await pause()
  }
  return { data, width: cols, height: rows, frame, em }
}

/** The field as a linearly filtered half-float texture; its first row is the top. */
function fieldTexture(field: Puff): DataTexture {
  const map = new DataTexture(field.data, field.width, field.height, RGBAFormat, HalfFloatType)
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
function inkTexture(layout: Raster): CanvasTexture {
  const map = new CanvasTexture(layout.canvas)
  map.premultiplyAlpha = true
  return map
}

/** One instanced grid per piece: its box, its turn and the point it leans around. */
function shape(layout: Raster): InstancedBufferGeometry {
  const widest = Math.max(1, ...layout.quads.map((quad) => quad.width))
  const tallest = Math.max(1, ...layout.quads.map((quad) => quad.height))
  const nx = Math.min(96, Math.max(6, Math.round(widest / CELL)))
  const ny = Math.min(96, Math.max(8, Math.round(tallest / CELL)))
  const geometry = new InstancedBufferGeometry()
  const corners = new Float32Array((nx + 1) * (ny + 1) * 3)
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) corners.set([i / nx, j / ny, 0], (j * (nx + 1) + i) * 3)
  const index: number[] = []
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i
      const b = a + nx + 1
      index.push(a, b, a + 1, a + 1, b, b + 1)
    }
  geometry.setIndex(index)
  geometry.setAttribute('position', new BufferAttribute(corners, 3))
  const count = Math.max(1, layout.quads.length)
  const box = new Float32Array(count * 4)
  const info = new Float32Array(count * 4)
  layout.quads.forEach((quad, i) => {
    box.set([quad.x, quad.y, quad.width, quad.height], i * 4)
    info.set([quad.order, quad.x + quad.width / 2, quad.base - quad.em * 0.35, quad.em], i * 4)
  })
  geometry.setAttribute(BOX, new InstancedBufferAttribute(box, 4))
  geometry.setAttribute(INFO, new InstancedBufferAttribute(info, 4))
  geometry.instanceCount = layout.quads.length
  return geometry
}

/** A CSS color as `#rrggbb`: var() and currentColor are read from the element. */
function colorOf(value: string, element: Element): string | undefined {
  const style = getComputedStyle(element)
  let word = value.trim()
  for (let depth = 0; depth < 8; depth++) {
    const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/is.exec(word)
    if (!varMatch) break
    word = style.getPropertyValue(varMatch[1] as string).trim() || (varMatch[2] ?? '').trim()
  }
  if (!word || word.toLowerCase() === 'currentcolor') {
    const fill = style.getPropertyValue('-webkit-text-fill-color')
    word = fill && !/^(transparent|rgba\(.*,\s*0\))$/.test(fill) ? fill : style.color
  }
  return cssColor(word)
}

/** A damped spring toward `goal`; true while it moves. */
function spring(
  state: { x: number; v: number },
  goal: number,
  stiffness: number,
  damping: number,
  dt: number,
): boolean {
  // Small steps keep a stiff spring stable on a slow frame.
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
  const stepTime = dt / steps
  for (let i = 0; i < steps; i++) {
    state.v += (stiffness * (goal - state.x) - damping * state.v) * stepTime
    state.x += state.v * stepTime
  }
  if (Math.abs(goal - state.x) < 1e-3 && Math.abs(state.v) < 1e-3) {
    state.x = goal
    state.v = 0
    return false
  }
  return true
}

const unit = (v: readonly number[]): [number, number, number] => {
  const norm = Math.hypot(...v) || 1
  return [(v[0] as number) / norm, (v[1] as number) / norm, (v[2] as number) / norm]
}
/** The key light from the upper left, a fill from the lower right, world space (y up). */
const KEY = unit([-0.5, 0.62, 0.6])
const FILL = unit([0.68, -0.32, 0.66])
/** The softbox the gloss reflects, and a small kicker light low on the right. */
const SOFTBOX = unit([-0.42, 0.5, 0.76])
const KICK = unit([0.62, -0.42, 0.66])
/** The shadow falls away from the key light: down and right in box px (y down). */
const CAST = (() => {
  const norm = Math.hypot(KEY[0], KEY[1])
  return [-KEY[0] / norm, KEY[1] / norm] as const
})()

/** Look of each style: wrap of the diffuse light, base darkening, light through the skin. */
interface Look {
  /** Wrap of the diffuse light, and the weights of the ambient, key and fill light. */
  readonly wrap: number
  readonly light: readonly [number, number, number]
  /** Darkening where the letter meets the page, light through the skin, shadow strength. */
  readonly ao: number
  readonly skin: number
  readonly shadow: number
}
const LOOKS: Record<Style, Look> = {
  balloon: { wrap: 0.35, light: [0.25, 0.65, 0.25], ao: 0.86, skin: 0.35, shadow: 1 },
  soft: { wrap: 0.45, light: [0.12, 0.85, 0.2], ao: 0.72, skin: 0.15, shadow: 0.9 },
  jelly: { wrap: 0.45, light: [0.3, 0.6, 0.3], ao: 0.95, skin: 0.9, shadow: 0.8 },
}

/**
 * Letters puff up into soft, round 3D shapes, like balloons or clay, lit by a studio light with
 * a glossy highlight and a soft shadow on the page. They inflate one after another when they come
 * into view, dent where the pointer presses, spring back with a wobble and lean toward it.
 */
const inflate: Effect<Params> = defineEffect({
  name: 'inflate',
  params: {
    style: oneOf('balloon', 'soft', 'jelly'),
    trigger: oneOf('view', 'hover', 'always'),
    color: '',
    depth: 1,
    gloss: 0.7,
    squish: 1,
    tilt: 10,
    duration: 1.1,
    stagger: 0.06,
    delay: 0,
    threshold: 0.3,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The shadow reaches past the box.
  bleed: 80,
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`inflate: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    let made = await puff(layout, ratio)
    if (signal.aborted) return
    const style = params.style
    const trigger = params.trigger
    const look = LOOKS[style]

    const hex = params.color.trim() ? colorOf(params.color, element) : undefined
    if (!hex && params.color.trim() && DEV)
      app.log.warn(`inflate: "${params.color}" is not a color, using the text color`, element)
    const own = uniform(hex ? 1 : 0)
    const tint = uniform(new Color(hex ?? colorOf('', element) ?? '#888888'))
    const shadowTint = uniform(new Color(colorOf('', element) ?? '#000000'))
    if (hex) shadowTint.value.set(hex)

    // The field and the raster in box px; the canvas covers its frame at the raster's scale.
    const field = uniform(new Vector4(...made.frame))
    const step = uniform(new Vector4(made.frame[2] / made.width, made.frame[3] / made.height, 0, 0))
    const rasterScaleOf = (source: Raster): number =>
      Math.min(ratio, MAX_SIDE / Math.max(source.frame[2], source.frame[3]))
    const inkFrame = (source: Raster): [number, number, number, number] => [
      source.frame[0],
      source.frame[1],
      source.canvas.width / rasterScaleOf(source),
      source.canvas.height / rasterScaleOf(source),
    ]
    const frame = uniform(new Vector4(...inkFrame(layout)))
    const em = uniform(made.em)
    // Seconds since the letters started to inflate (-1 before), how inflated a hovered label is.
    const clock = uniform(-1)
    const hold = uniform(1)
    // The pointer in box px and how deep it presses; how far the letters lean, 0..1.
    const press = uniform(new Vector3(-1e4, -1e4, 0))
    const lean = uniform(0)

    const textures: { node: { value: Texture }; make: (p: Puff, r: Raster) => Texture }[] = []
    const sample = (make: (p: Puff, r: Raster) => Texture, uv: V2, level = false): V4 => {
      const read = texture(make(made, layout as Raster), uv)
      textures.push({ node: read as unknown as { value: Texture }, make })
      return (level ? read.level(float(0)) : read) as unknown as V4
    }
    const fieldOf = (puffed: Puff): Texture => fieldTexture(puffed)
    const fieldAt = (puffed: V2): V2 =>
      vec2(puffed.x.sub(field.x).div(field.z), puffed.y.sub(field.y).div(field.w)) as unknown as V2

    // How inflated letter `order` is: a spring that overshoots, then the hover and the page.
    const presence = smoothstep(0, 1, u.presence) as unknown as F
    const grow = (order: F): F => {
      const progress = clock
        .sub(u.delay)
        .sub(order.mul(u.stagger))
        .div(max(u.duration, 1e-3))
        .clamp(0, 1)
      const wobble = exp(progress.mul(-6.5))
        .mul(cos(progress.mul(11)))
        .oneMinus()
      const held = hold.mul(hold).mul(hold.mul(-2).add(3))
      return select(progress.greaterThanEqual(1), float(1), wobble)
        .mul(held)
        .mul(presence) as unknown as F
    }
    // The round profile at a field sample: height in CSS px, and 0..1 of its own radius.
    const profile = (texel: V4): { height: F; share: F } => ({
      height: texel.y as unknown as F,
      share: texel.w as unknown as F,
    })
    // The dent where the pointer presses, with the skin it pushes aside rising around it.
    const dentAt = (point: V2): F => {
      const radius = em.mul(0.2)
      const dist = length(point.sub(press.xy))
      const bell = exp(dist.div(radius).pow(2).negate())
      const ring = exp(dist.sub(radius.mul(1.6)).div(radius.mul(0.6)).pow(2).negate())
      return clamp(
        press.z.mul(u.squish).mul(bell.mul(0.85).sub(ring.mul(0.22))),
        -0.6,
        0.92,
      ).oneMinus() as unknown as F
    }
    const heightAt = (texel: V4, point: V2, inflated: F): F =>
      profile(texel).height.mul(max(u.depth, 0)).mul(inflated).mul(dentAt(point)) as unknown as F

    // The letters: a grid per piece, raised by the profile and leaning around its middle.
    const box = attribute(BOX, 'vec4') as unknown as V4
    const info = attribute(INFO, 'vec4') as unknown as V4
    const corner = positionGeometry.xy
    const gridX = box.x.add(corner.x.mul(box.z))
    const gridY = box.y.add(corner.y.mul(box.w))
    const point = vec2(gridX, gridY) as unknown as V2
    const inflated = grow(info.x)
    const lifted = heightAt(sample(fieldOf, fieldAt(point), true), point, inflated)
    const centre = vec2(info.y, info.z) as unknown as V2
    const away = centre.sub(press.xy)
    const dist = length(away)
    const awayDir = away.div(max(dist, 1e-3))
    const reach = exp(dist.div(info.w.mul(1.3)).pow(2).negate()).mul(
      smoothstep(0, info.w.mul(0.3), dist),
    )
    const angle = u.tilt
      .mul(Math.PI / 180)
      .mul(lean)
      .mul(reach)
      .mul(min(inflated, 1))
    // The side toward the pointer sinks: around the axis across the way to it (world, y up).
    const axis = vec3(awayDir.y.negate(), awayDir.x.negate(), 0) as unknown as V3
    const turn = (v: V3, around: V3, by: F): V3 =>
      v
        .mul(cos(by))
        .add(cross(around, v).mul(sin(by)))
        .add(around.mul(dot(around, v).mul(cos(by).oneMinus()))) as unknown as V3
    // A slight swell while the letter overshoots.
    const swell = inflated.sub(1).mul(inflated).mul(0.07).add(1)
    const local = vec3(
      gridX.sub(info.y).mul(swell),
      info.z.sub(gridY).mul(swell),
      lifted,
    ) as unknown as V3
    const half = u.size.mul(0.5)
    const letters = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: DoubleSide,
    })
    letters.alphaTest = 0.01
    letters.positionNode = vec3(info.y.sub(half.x), half.y.sub(info.z), 0).add(
      turn(local, axis, angle),
    )

    const vPoint = varying(point)
    const vInflated = varying(inflated)
    const vTurn = varying(vec4(axis, angle))
    // The slope by central differences one texel apart; the normal turns with the letter.
    const texelX = step.x
    const texelY = step.y
    const fieldHere = sample(fieldOf, fieldAt(vPoint))
    const heightOffset = (dx: F | number, dy: F | number): F => {
      const q = vPoint.add(vec2(dx, dy)) as unknown as V2
      return heightAt(sample(fieldOf, fieldAt(q)), q, vInflated)
    }
    const slopeX = heightOffset(texelX, 0).sub(heightOffset(texelX.negate(), 0)).div(texelX.mul(2))
    const slopeY = heightOffset(0, texelY).sub(heightOffset(0, texelY.negate())).div(texelY.mul(2))
    const normal = turn(
      normalize(vec3(slopeX.negate(), slopeY, 1)) as unknown as V3,
      normalize(vTurn.xyz.add(vec3(0, 0, 1e-6))) as unknown as V3,
      vTurn.w,
    )
    const inkUV = varying(
      vec2(point.x.sub(frame.x).div(frame.z), point.y.sub(frame.y).div(frame.w).oneMinus()),
    )
    const ink = texture(inkTexture(layout), inkUV)
    textures.push({
      node: ink as unknown as { value: Texture },
      make: (_, source) => inkTexture(source),
    })
    const albedo = mix(
      sRGBTransferEOTF(ink.rgb.div(max(ink.a, 1e-4))) as unknown as V3,
      tint as unknown as V3,
      own,
    ) as unknown as V3
    const curved = min(vInflated, 1)

    // Studio light: a wrapped key and fill, normalized so a flat letter shows its own color.
    const wrapped = (c: F, wrap: number): F =>
      clamp(c.add(wrap).div(1 + wrap), 0, 1) as unknown as F
    const [ambient, key, fill] = look.light
    const flat =
      ambient +
      key * Math.min(1, (KEY[2] + look.wrap) / (1 + look.wrap)) +
      fill * Math.min(1, (FILL[2] + look.wrap) / (1 + look.wrap))
    const shade = float(ambient)
      .add(wrapped(dot(normal, vec3(...KEY)), look.wrap).mul(key))
      .add(wrapped(dot(normal, vec3(...FILL)), look.wrap).mul(fill))
      .div(flat)
    // Shadowed parts turn deeper and more saturated, as light scatters inside the skin.
    const body = albedo.mul(
      pow(vec3(shade, shade, shade), mix(vec3(1), vec3(1.75), albedo.oneMinus())),
    )
    const { share: thick } = profile(fieldHere)
    const ao = mix(float(1), mix(float(look.ao), float(1), smoothstep(0, 0.6, thick)), curved)
    const rim = normal.z.oneMinus()
    const fromKey = normalize(vec2(-KEY[0], -KEY[1]))
    const back = clamp(dot(normalize(normal.xy.add(vec2(1e-5, 0))), fromKey), 0, 1)
    const skin = albedo
      .mul(
        back
          .mul(rim)
          .mul(rim)
          .mul(look.skin * 1.6),
      )
      .mul(curved)
    const view = normalize(cameraPosition.sub(positionWorld))
    const reflected = reflect(view.negate(), normal)
    const toBox = dot(reflected, vec3(...SOFTBOX))
    const fresnel = pow(clamp(dot(normal, view), 0, 1).oneMinus(), 4)
    const gloss = clamp(u.gloss, 0, 1.5)
    let spec: F
    let env: F
    if (style === 'soft') {
      spec = pow(max(toBox, 0), 4).mul(0.16).mul(gloss) as unknown as F
      env = fresnel.mul(0.2) as unknown as F
    } else {
      const window = smoothstep(0.972, 0.996, toBox)
      const sheen = pow(max(toBox, 0), 10)
      const kick = smoothstep(0.986, 0.998, dot(reflected, vec3(...KICK)))
      spec = window
        .add(sheen.mul(0.28))
        .add(kick.mul(style === 'jelly' ? 0.5 : 0.35))
        .mul(gloss) as unknown as F
      env = fresnel.mul(gloss).mul(0.45) as unknown as F
    }
    spec = spec.mul(curved) as unknown as F
    env = env.mul(curved) as unknown as F
    let surface: V3 = body.mul(ao) as unknown as V3
    let alpha: F = ink.a as unknown as F
    if (style === 'jelly') {
      // Thick parts absorb more: a deeper color in the middle; thin parts let the light through,
      // clear and bright, and the page shows through them.
      const absorb = thick.mul(1.3)
      const deep = albedo.mul(pow(albedo, vec3(absorb, absorb, absorb))).mul(shade)
      const glow = albedo.mul(thick.oneMinus().mul(0.45))
      surface = mix(surface, deep.add(glow), curved.mul(0.85)) as unknown as V3
      const clear = mix(float(0.42), float(0.9), pow(thick, 0.8))
        .add(fresnel.mul(0.35))
        .add(spec)
        .clamp(0, 1)
      alpha = alpha.mul(mix(float(1), clear, curved)) as unknown as F
    }
    const sheenColor = mix(albedo, vec3(1), 0.65)
    const lit = surface
      .add(skin)
      .add(vec3(spec, spec, spec))
      .add(sheenColor.mul(env))
    const boxMask = (point: V2): F =>
      // A px inside the box: ink past it (descenders under a tight line-height) is not cut, and
      // the mask's own edge is soft.
      ctx.mask(
        vec2(
          clamp(point.x, 1, u.size.x.sub(1)).div(u.size.x),
          clamp(point.y, 1, u.size.y.sub(1)).div(u.size.y).oneMinus(),
        ),
      ) as unknown as F
    const fade = clamp(u.presence.mul(2), 0, 1)
    letters.colorNode = vec4(lit, alpha.mul(fade).mul(boxMask(vPoint)))

    // The shadow on the page: a tight contact shadow and a soft one away from the key light,
    // from the distance field shifted; tinted by the letters' color.
    const shadowMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const shadowPoint = vec2(
      field.x.add(positionGeometry.x.mul(field.z)),
      field.y.add(positionGeometry.y.mul(field.w)),
    )
    shadowMaterial.positionNode = vec3(shadowPoint.x.sub(half.x), half.y.sub(shadowPoint.y), 0)
    const vShadowPoint = varying(shadowPoint) as unknown as V2
    const cast = vec2(...CAST)
    const height = min(max(u.depth, 0), 2).mul(em).mul(0.07)
    const near = sample(fieldOf, fieldAt(vShadowPoint.sub(cast.mul(height.mul(0.22)))))
    const wide = sample(fieldOf, fieldAt(vShadowPoint.sub(cast.mul(height.mul(0.8)))))
    const here = sample(fieldOf, fieldAt(vShadowPoint))
    const contact = smoothstep(height.mul(-0.4), height.mul(0.12), near.x)
    const soft = smoothstep(height.mul(-1.5), height.mul(0.4), wide.x)
    const shadowGrow = min(grow(here.z), 1)
    const under = style === 'jelly' ? smoothstep(-0.5, 0.5, here.x).mul(0.5).oneMinus() : float(1)
    const shadowA = contact
      .mul(0.38)
      .add(soft.mul(0.2))
      .mul(shadowGrow)
      .mul(look.shadow)
      .mul(under)
      .mul(fade)
    shadowMaterial.colorNode = vec4(
      (shadowTint as unknown as V3).mul(style === 'jelly' ? 0.55 : 0.18),
      shadowA.add(dither().mul(shadowGrow)).clamp(0, 1).mul(boxMask(vShadowPoint)),
    )

    const quad = new InstancedBufferGeometry()
    quad.setIndex([0, 2, 1, 2, 3, 1])
    quad.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
    )
    quad.instanceCount = 1
    const group = new Group()
    const shadowMesh = new Mesh(quad, shadowMaterial)
    const letterMesh = new Mesh(shape(layout), letters)
    shadowMesh.frustumCulled = false
    letterMesh.frustumCulled = false
    letterMesh.renderOrder = 1
    group.add(shadowMesh, letterMesh)
    ctx.onDispose(() => {
      for (const entry of textures) entry.node.value.dispose()
      quad.dispose()
    })
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    const use = (next: Raster, puffed: Puff): void => {
      layout = next
      made = puffed
      for (const entry of textures) {
        const old = entry.node.value
        entry.node.value = entry.make(puffed, next)
        old.dispose()
      }
      const old = letterMesh.geometry
      letterMesh.geometry = shape(next)
      old.dispose()
      field.value.set(...puffed.frame)
      step.value.set(puffed.frame[2] / puffed.width, puffed.frame[3] / puffed.height, 0, 0)
      frame.value.set(...inkFrame(next))
      em.value = puffed.em
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
      const next = raster(element, 'letter', ratio)
      if (!next?.quads.length) return
      const puffed = await puff(next, ratio)
      if (signal.aborted || ticket !== building) return
      use(next, puffed)
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void redo(), REDO_DELAY)
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

    // The pointer: a mouse over the box dents and tilts the letters, a press dents them deeper;
    // a finger presses while it is down. In hover, the element or the link it sits in inflates.
    const target = (el.closest('a, button') as HTMLElement | null) ?? el
    let mouse: { x: number; y: number } | undefined
    let pressed = false
    let focused = false
    let tapped = false
    const last = { x: 0, y: 0, width: 0, height: 0 }
    const nearBox = (x: number, y: number): boolean => {
      const margin = made.em * 0.6
      return (
        x > last.x - margin &&
        x < last.x + last.width + margin &&
        y > last.y - margin &&
        y < last.y + last.height + margin
      )
    }
    const opts = { signal }
    const passive = { signal, passive: true }
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'touch' && !pressed) return
        const was = mouse && nearBox(mouse.x, mouse.y)
        mouse = { x: e.clientX, y: e.clientY }
        if (was || nearBox(mouse.x, mouse.y)) ctx.invalidate()
      },
      passive,
    )
    target.addEventListener(
      'pointerdown',
      (e) => {
        pressed = true
        mouse = { x: e.clientX, y: e.clientY }
        if (e.pointerType === 'touch' && trigger === 'hover') tapped = !tapped
        ctx.invalidate()
      },
      passive,
    )
    const release = (e: PointerEvent): void => {
      if (!pressed) return
      pressed = false
      if (e.pointerType === 'touch') mouse = undefined
      ctx.invalidate()
    }
    addEventListener('pointerup', release, passive)
    addEventListener('pointercancel', release, passive)
    const gone = (): void => {
      mouse = undefined
      pressed = false
      ctx.invalidate()
    }
    document.documentElement.addEventListener('pointerleave', gone, opts)
    addEventListener('blur', gone, opts)
    if (trigger === 'hover') {
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
    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }
    // Seconds since the letters started to inflate, -1 before; hover's 0..1.
    let since = -1
    let held = trigger === 'hover' ? 0 : 1
    if (trigger === 'hover') show(true)
    const dent = { x: 0, v: 0 }
    const tilt = { x: 0, v: 0 }
    let aimed = false
    let aimX = 0
    let aimY = 0

    return (input): boolean => {
      const p = ctx.params
      const dt = Math.min(Math.max(input.delta, 0), 0.1)
      const reduced = input.reducedMotion
      last.x = input.x
      last.y = input.y
      last.width = input.width
      last.height = input.height
      const units = Math.max(1, layout?.units ?? 1)
      const total = p.delay + (units - 1) * Math.max(p.stagger, 0) + Math.max(p.duration, 1e-3)
      const over =
        !!mouse &&
        mouse.x >= input.x &&
        mouse.x <= input.x + input.width &&
        mouse.y >= input.y &&
        mouse.y <= input.y + input.height
      let busy = false

      if (trigger === 'always' || (reduced && trigger === 'view')) since = total
      else if (trigger === 'view') {
        if (since < 0) {
          // Counted above the bottom tenth of the viewport, like `reveal`.
          if (inView(input.y, input.height, stage.height.peek(), p.threshold)) since = 0
        } else since = Math.min(total, since + dt)
        busy ||= since >= 0 && since < total
      } else {
        const want = over || focused || tapped || pressed
        if (reduced) {
          held = want ? 1 : 0
          since = want ? total : -1
        } else if (want) {
          if (held <= 0) since = 0
          else since = Math.min(total, since + dt)
          held = Math.min(1, held + dt / REFILL)
          busy ||= since < total || held < 1
        } else if (held > 0) {
          since = Math.min(total, since + dt)
          held = Math.max(0, held - dt / DEFLATE)
          if (held <= 0) since = -1
          busy = true
        }
        if (want && held <= 0 && !reduced) held = 1e-3
      }
      const flatNow = trigger === 'hover' && held <= 0
      show(flatNow)
      clock.value = since
      hold.value = held

      // The dent and the lean follow the pointer on springs that overshoot, so they wobble.
      if (reduced || flatNow) {
        dent.x = 0
        dent.v = 0
        tilt.x = 0
        tilt.v = 0
      } else {
        const touching = over || pressed
        if (touching && mouse) {
          const targetX = mouse.x - input.x
          const targetY = mouse.y - input.y
          if (!aimed) {
            aimX = targetX
            aimY = targetY
            aimed = true
          }
          aimX = damp(aimX, targetX, 0.05, dt)
          aimY = damp(aimY, targetY, 0.05, dt)
          if (Math.abs(aimX - targetX) > 0.05 || Math.abs(aimY - targetY) > 0.05) busy = true
          else {
            aimX = targetX
            aimY = targetY
          }
        }
        busy = spring(dent, pressed ? 1 : over ? HOVER_DENT : 0, 260, 11, dt) || busy
        busy = spring(tilt, touching ? 1 : 0, 140, 10, dt) || busy
        if (!touching && dent.x === 0 && tilt.x === 0) aimed = false
      }
      press.value.set(aimX, aimY, dent.x)
      lean.value = tilt.x
      return busy && !reduced
    }
  },
})
export default inflate
