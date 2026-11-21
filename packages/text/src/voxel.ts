import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, inView, rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  cos,
  cross,
  dot,
  float,
  floor,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BoxGeometry,
  BufferAttribute,
  DynamicDrawUsage,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  Vector4,
} from 'three/webgpu'
import { emOf, glyphs, pixels, TIER } from './points'
import { fonts, type Raster, raster, unsupported } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Style = 'cubes' | 'bricks' | 'pixels'
type Trigger = 'view' | 'scroll' | 'hover'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  cell: number
  depth: number
  drop: number
  duration: number
  stagger: number
  bounce: number
  radius: number
  delay: number
  threshold: number
  studs: boolean
  seed: number
}

/** Most cubes at the high tier; past it the grid widens. */
export const MAX_CUBES = 9000
/** Share of a cell the ink must cover for it to take a cube. */
const CUT = 0.42
/** Share of `duration` a cube may start late, at random. */
export const JITTER = 0.3
/** Share of `duration` spent falling; the rest is the bounce. */
const HIT = 0.6
/** Lower rows start earlier by this many em of the wave per em of height, so the heading builds up. */
const ROWS = 0.6
/** Each line of a heading starts this many em of the wave after the one above it. */
const LINES = 0.5
/** Seconds the built heading holds before it flattens into the text. */
export const HOLD = 0.2
/** Seconds the cubes take to flatten and cross-fade into the text. */
export const FLAT = 0.5
/** Seconds a heading seen as DOM takes to rise into voxels. */
const RISE = 0.6
/** Height of the first hop at bounce 1, cells. */
const HOP = 1.3
/** Scroll trigger: the share of the scroll around the middle where the heading holds. */
const HOLD_AT: readonly [number, number] = [0.42, 0.58]
/** Scroll trigger: the share of the way out spent turning the text back into cubes. */
const UNDO = 0.15
/** Hover: lift at the pointer as a share of `radius`, the dip of the ring around it, the lean. */
const LIFT = 0.5
const RING = 0.16
const LEAN = 0.42
/** Hover springs per second: stiffness at the pointer and the damping ratio (a little wobble). */
const STIFF = 210
const ZETA = 0.38
/** Key light, world axes (y up, z toward the viewer): from the upper left and the front. */
const LIGHT = [-0.42, 0.55, 0.72] as const
/** Diffuse share of the key; the ambient makes a face toward the viewer show its own color. */
const DIFFUSE = 0.62
/** Per style: gap between cubes and bevel width, as shares of a cell. */
const GAP: Record<Style, number> = { cubes: 0.1, bricks: 0, pixels: 0 }
const BEVEL: Record<Style, number> = { cubes: 0.2, bricks: 0.13, pixels: 0 }

const HOME = 'vxHome'
const INK = 'vxInk'
const NEAR = 'vxNear'
const FROM = 'vxFrom'
const SPIN = 'vxSpin'
const LIFTED = 'vxLift'

/** Cubes on a grid over the glyphs of a raster. */
export interface Voxels {
  readonly count: number
  /** Per cube: centre x, y in box px (y down), width in cells, and its place in the build wave, em. */
  readonly at: Float32Array
  /** Per cube: linear r, g, b of the text there, and a random 0..1. */
  readonly color: Float32Array
  /** Per cube: share of the cells beside it that hold cubes, left, right, above, below. */
  readonly near: Float32Array
  /** Per cube: where it starts as a share of `drop` (box px axes, z toward the viewer), a random 0..1. */
  readonly from: Float32Array
  /** Per cube: a unit axis it tumbles around and the angle it starts turned by, radians. */
  readonly spin: Float32Array
  /** Grid step in box px: `cell`, or wider to fit the cap. */
  readonly cell: number
  /** Left edge of the cubes, box px: where the wave starts. */
  readonly left: number
  /** Widest wave of the build past a cube's own column, em: rows and lines. */
  readonly extra: number
  /** The wave of the right-most column, em. */
  readonly wave: number
  /** Median font size, px: the unit of the wave. */
  readonly em: number
}

export interface VoxelOptions {
  /** Grid step in box px; widened until the cubes fit `max`. */
  readonly cell: number
  readonly max: number
  /** Pairs neighbours of a row into bricks two cells wide, in a running bond. */
  readonly bricks: boolean
  readonly seed: number
}

const EMPTY: Voxels = {
  count: 0,
  at: new Float32Array(4),
  color: new Float32Array(4),
  near: new Float32Array(4),
  from: new Float32Array(4),
  spin: new Float32Array(4),
  cell: 1,
  left: 0,
  extra: 0,
  wave: 0,
  em: 16,
}

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

/** Ink coverage and alpha-weighted linear colour per cell of `cell` box px over the raster frame. */
function cover(image: ImageData, scale: number, cell: number) {
  const { data, width, height } = image
  const step = cell * scale
  const cols = Math.max(1, Math.ceil(width / step))
  const rows = Math.max(1, Math.ceil(height / step))
  const sums = new Float64Array(cols * rows * 4)
  let peak = 0
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y + 0.5) / step) * cols
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const alpha = data[offset + 3] as number
      if (!alpha) continue
      if (alpha > peak) peak = alpha
      const cell = (row + Math.floor((x + 0.5) / step)) * 4
      sums[cell] = (sums[cell] as number) + alpha
      sums[cell + 1] =
        (sums[cell + 1] as number) + (LINEAR[data[offset] as number] as number) * alpha
      sums[cell + 2] =
        (sums[cell + 2] as number) + (LINEAR[data[offset + 1] as number] as number) * alpha
      sums[cell + 3] =
        (sums[cell + 3] as number) + (LINEAR[data[offset + 2] as number] as number) * alpha
    }
  }
  const on = new Uint8Array(cols * rows)
  let count = 0
  const full = peak * step * step
  if (full > 0)
    for (let i = 0; i < on.length; i++) {
      if ((sums[i * 4] as number) >= full * CUT) {
        on[i] = 1
        count++
      }
    }
  return { cols, rows, sums, on, count }
}

/**
 * Cubes where the ink covers enough of a grid cell, coloured by the ink under them. The grid
 * widens until they fit `max`. With `bricks`, neighbours in a row pair up into bricks, the pairs
 * shifted by a cell on every other row like a wall. Each cube gets its place in the build wave:
 * left to right, lower rows a little earlier, each line a little after the one above.
 */
export function voxels(
  layout: Raster,
  image: ImageData | undefined,
  options: VoxelOptions,
): Voxels {
  if (!image || !layout.quads.length) return EMPTY
  const [frameX, frameY, frameWidth] = layout.frame
  const scale = image.width / frameWidth
  let cell = Math.max(options.cell, 1)
  let grid = cover(image, scale, cell)
  for (let i = 0; i < 6 && grid.count > options.max; i++) {
    cell *= Math.sqrt(grid.count / options.max) * 1.03
    grid = cover(image, scale, cell)
  }
  const { cols, rows, sums, on } = grid
  if (!grid.count) return EMPTY
  const em = emOf(layout)
  const isOn = (c: number, row: number): number =>
    c < 0 || row < 0 || c >= cols || row >= rows ? 0 : (on[row * cols + c] as number)

  // Lines from the bands of the pieces, top to bottom.
  const bands: [number, number][] = []
  for (const q of layout.quads)
    if (!bands.some(([top]) => Math.abs(top - q.y) < 0.5)) bands.push([q.y, q.y + q.height])
  bands.sort((a, b) => a[0] - b[0])
  const lineOf = (y: number): number => {
    let best = 0
    let gap = Number.POSITIVE_INFINITY
    bands.forEach(([top, bottom], i) => {
      const distance = y < top ? top - y : y > bottom ? y - bottom : 0
      if (distance < gap) {
        gap = distance
        best = i
      }
    })
    return best
  }

  type Cube = { c: number; row: number; w: number }
  const cubes: Cube[] = []
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < cols; c++) {
      if (!isOn(c, row)) continue
      const pair = options.bricks && (c - (row % 2)) % 2 === 0 && c >= row % 2 && isOn(c + 1, row)
      cubes.push({ c, row, w: pair ? 2 : 1 })
      if (pair) c++
    }
  }
  const count = cubes.length
  const at = new Float32Array(count * 4)
  const color = new Float32Array(count * 4)
  const near = new Float32Array(count * 4)
  const from = new Float32Array(count * 4)
  const spin = new Float32Array(count * 4)
  const random = rng(options.seed)
  let left = Number.POSITIVE_INFINITY
  for (const q of cubes) left = Math.min(left, frameX + q.c * cell)
  let extra = 0
  let wave = 0
  cubes.forEach((q, i) => {
    const x = frameX + (q.c + q.w / 2) * cell
    const y = frameY + (q.row + 0.5) * cell
    const line = lineOf(y)
    const bottom = (bands[line] as [number, number])[1]
    const column = (x - left) / em
    const lift = (ROWS * Math.max(0, bottom - y)) / em + LINES * line
    extra = Math.max(extra, lift)
    wave = Math.max(wave, column)
    at.set([x, y, q.w, column + lift], i * 4)
    let alpha = 0
    let red = 0
    let green = 0
    let blue = 0
    for (let k = 0; k < q.w; k++) {
      const offset = (q.row * cols + q.c + k) * 4
      alpha += sums[offset] as number
      red += sums[offset + 1] as number
      green += sums[offset + 2] as number
      blue += sums[offset + 3] as number
    }
    color.set([red / alpha, green / alpha, blue / alpha, random()], i * 4)
    let above = 0
    let below = 0
    for (let k = 0; k < q.w; k++) {
      above += isOn(q.c + k, q.row - 1)
      below += isOn(q.c + k, q.row + 1)
    }
    near.set([isOn(q.c - 1, q.row), isOn(q.c + q.w, q.row), above / q.w, below / q.w], i * 4)
    // Above and behind the page, a little to either side.
    const roll = random()
    from.set([(random() - 0.5) * 0.3, -(0.8 + 0.4 * roll), -(0.5 + 0.9 * random()), roll], i * 4)
    // A random axis on the sphere, and one to two and a half half-turns around it.
    const z = random() * 2 - 1
    const angle = random() * Math.PI * 2
    const ring = Math.sqrt(1 - z * z)
    const turn = (1 + 1.5 * random()) * Math.PI * (random() < 0.5 ? -1 : 1)
    spin.set([ring * Math.cos(angle), ring * Math.sin(angle), z, turn], i * 4)
  })
  return { count: count, at, color, near, from, spin, cell, left, extra, wave, em }
}

/** Seconds from the trigger until the last cube has landed, and with `handoff` until the text shows. */
export const span = (
  p: { readonly duration: number; readonly stagger: number; readonly delay: number },
  v: Pick<Voxels, 'wave' | 'extra'>,
  handoff: boolean,
): number =>
  Math.max(0, p.delay) +
  Math.max(0, p.stagger) * (v.wave + v.extra) +
  Math.max(p.duration, 1e-3) * (1 + JITTER) +
  (handoff ? HOLD + FLAT : 0)

/** A unit box per cube: the instance attributes are `count` items of their item size. */
function boxes(
  count: number,
  attributes: Readonly<Record<string, readonly [Float32Array, number]>>,
  dynamic: readonly string[],
): InstancedBufferGeometry {
  const box = new BoxGeometry(1, 1, 1)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(box.getIndex())
  geometry.setAttribute('position', box.getAttribute('position'))
  geometry.setAttribute('normal', box.getAttribute('normal'))
  for (const [name, [data, size]] of Object.entries(attributes)) {
    const attr = new InstancedBufferAttribute(data, size)
    if (dynamic.includes(name)) attr.setUsage(DynamicDrawUsage)
    geometry.setAttribute(name, attr)
  }
  geometry.instanceCount = count
  return geometry
}

/** v turned by `angle` around the unit `axis` (Rodrigues). */
function rotate(v: V3, axis: V3, angle: F): V3 {
  const c = cos(angle)
  return v
    .mul(c)
    .add(cross(axis, v).mul(sin(angle)))
    .add(axis.mul(dot(axis, v).mul(c.oneMinus()))) as V3
}

/**
 * The heading built from small lit 3D cubes, one instanced draw of boxes coloured by the text
 * under each grid cell. On view they tumble in from above and behind the page in a wave, land with
 * a hop and a squash, and flatten into the real text; the pixels style keeps them. Cubes under the
 * pointer pop out toward the viewer on springs. Once on view, scrubbed by scroll, or as voxels
 * for the pointer only.
 */
const voxel: Effect<Params> = defineEffect({
  name: 'voxel',
  params: {
    style: oneOf('cubes', 'bricks', 'pixels'),
    trigger: oneOf('view', 'scroll', 'hover'),
    cell: 8,
    depth: 1,
    drop: 240,
    duration: 0.9,
    stagger: 0.1,
    bounce: 1,
    radius: 120,
    delay: 0,
    threshold: 0.2,
    studs: true,
    seed: 1,
  },
  rebuild: ['cell', 'seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  reducedMotion: 'static',
  // Cubes fall in from above the box and pop out toward the viewer.
  bleed: 400,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const style = params.style
    const trigger = params.trigger
    const hover = trigger === 'hover'
    // The voxels stay at rest instead of handing back to the text.
    const keep = style === 'pixels' || hover
    const onScreen = (): boolean => {
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < stage.height.peek() &&
        rect.left < stage.width.peek()
      )
    }
    // As in assemble: text the visitor has seen as DOM stays; veiled text has not been seen.
    const veiled = (): boolean =>
      trigger !== 'scroll' && element.getAttribute('data-dio-state') === 'entering'
    let seen = onScreen() && !veiled()
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const warn = (reason: string): void => {
      if (DEV) app.log.warn(`voxel: ${reason}, the text stays as it is`, element)
    }
    const ratio = ctx.quality === 'low' ? 1 : 2
    const cap = Math.round(MAX_CUBES * TIER[ctx.quality])
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()
    const pick = (r: Raster): Voxels =>
      voxels(r, pixels(r), {
        cell: params.cell,
        max: cap,
        bricks: style === 'bricks',
        seed: params.seed,
      })
    let grid = layout ? pick(layout) : undefined
    if (!layout || !grid?.count) {
      if (reason) warn(`${reason} cannot be drawn`)
      ctx.showDom(true)
      return
    }

    // Seconds since the trigger and when it ends; `solid` shows the text over flat cubes, for a
    // heading seen as DOM that rises into voxels; `collapse` drops them as a scrubbed one leaves.
    const t = uniform(-1)
    const end = uniform(1)
    const solid = uniform(0)
    const collapse = uniform(0)
    const studs = uniform(1)
    const cellU = uniform(grid.cell)
    const leftU = uniform(grid.left)
    const extraU = uniform(grid.extra)
    const waveU = uniform(Math.max(grid.wave + grid.extra, 1e-3))
    const emU = uniform(grid.em)
    const depth = ctx.render.camera.position.z || 1000
    const frame = uniform(new Vector4(...layout.frame))
    const half = u.size.mul(0.5) as unknown as V2
    const now = min(t, u.presence.mul(end)) as F
    const dur = max(u.duration, 1e-3)
    // When the column at box x has every cube landed, plus the hold: then it flattens.
    const ready = (x: F): F =>
      u.delay
        .add(u.stagger.mul(x.sub(leftU).div(emU).add(extraU)))
        .add(dur.mul(1 + JITTER))
        .add(HOLD) as F

    const home = attribute(HOME, 'vec4') as unknown as V4
    const inkOf = attribute(INK, 'vec4') as unknown as V4
    const nearOf = attribute(NEAR, 'vec4') as unknown as V4
    const fromOf = attribute(FROM, 'vec4') as unknown as V4
    const spinOf = attribute(SPIN, 'vec4') as unknown as V4
    const lift = (keep ? attribute(LIFTED, 'vec3') : vec3(0, 0, 0)) as unknown as V3
    const randomA = inkOf.w
    const randomB = fromOf.w

    // The build: a fall with gravity from above and behind, a hop and a smaller one, then still.
    const begin = u.delay.add(u.stagger.mul(home.w)).add(randomA.mul(JITTER).mul(dur))
    const progress = now.sub(begin).div(dur).clamp(0, 1)
    const falling = progress.div(HIT).clamp(0, 1)
    const settling = progress
      .sub(HIT)
      .div(1 - HIT)
      .clamp(0, 1)
    const fall = falling.mul(falling)
    const firstHop = settling.div(0.5).clamp(0, 1)
    const secondHop = settling.sub(0.5).div(0.28).clamp(0, 1)
    const bounce = max(u.bounce, 0)
    const hop = firstHop
      .mul(firstHop.oneMinus())
      .mul(4)
      .add(secondHop.mul(secondHop.oneMinus()).mul(4 * 0.3))
      .mul(bounce)
      .mul(cellU)
      .mul(HOP)
    // Squashed flat on each landing, less on the second.
    const squash = sin(settling.div(0.14).clamp(0, 1).mul(Math.PI))
      .mul(0.3)
      .add(sin(settling.sub(0.5).div(0.1).clamp(0, 1).mul(Math.PI)).mul(0.12))
      .mul(min(bounce, 1.5))
    // A scrubbed heading leaving: cubes drop down and toward the viewer in the same wave.
    const collapsed = collapse
      .mul(1.6)
      .sub(home.w.div(waveU).mul(0.45))
      .sub(randomA.mul(0.15))
      .clamp(0, 1)
    const away = fromOf.xyz.normalize()
    const drop = max(u.drop, 0)
    const offset = fromOf.xyz
      .mul(drop.mul(fall.oneMinus()))
      .add(away.mul(hop))
      .add(
        vec3(fromOf.x.mul(0.8), float(1.3), randomB.mul(0.6).add(0.3)).mul(
          drop.mul(collapsed.mul(collapsed)),
        ),
      )
    // Tumbling until it lands, a wobble through the bounce, tumbling again when it drops.
    const turn = spinOf.w
      .mul(falling.oneMinus().mul(falling.oneMinus()))
      .add(
        sin(settling.mul(9.5))
          .mul(settling.oneMinus().mul(settling.oneMinus()))
          .mul(0.2)
          .mul(bounce),
      )
      .add(spinOf.w.mul(collapsed).mul(0.7))

    // Flattening into the text and fading out once a column is ready.
    let flat: F
    let gone: F
    if (keep) {
      flat = solid as unknown as F
      gone = solid as unknown as F
    } else {
      const at = ready(home.x)
      flat = max(smoothstep(at, at.add(FLAT * 0.5), now), solid) as F
      gone = max(smoothstep(at.add(FLAT * 0.4), at.add(FLAT * 0.85), now), solid) as F
    }
    const thick = max(u.depth, 0).mul(cellU).mul(flat.oneMinus()).max(0.02)
    // Flush neighbours overlap by a hair, so no crack between them shows their sides.
    const gap = cellU.mul(GAP[style]).mul(flat.oneMinus()).sub(0.3)
    const size = vec3(home.z.mul(cellU).sub(gap), cellU.sub(gap), thick) as V3
    const grow = smoothstep(0, 0.16, falling).mul(smoothstep(0.75, 1, collapsed).oneMinus())
    const shape = vec3(squash.mul(0.5).add(1), squash.oneMinus(), squash.mul(0.5).add(1)).mul(grow)
    const local = positionGeometry.mul(size) as V3
    // Hover: up toward the viewer and leaning out of the bump; the lean in box px (y down).
    const leanAngle = length(lift.yz)
    const leanAxis = normalize(vec3(lift.z, lift.y, 0).add(vec3(1e-6, 0, 0))) as V3
    const spinAxis = spinOf.xyz as V3
    const turnBy = (v: V3): V3 => rotate(rotate(v, spinAxis, turn), leanAxis, leanAngle)
    const vertex = turnBy(local.mul(shape) as V3)
    let centre = vec3(
      home.x.add(offset.x).sub(half.x),
      half.y.sub(home.y.add(offset.y)),
      offset.z.sub(thick.mul(0.5)).add(lift.x),
    ) as V3
    if (keep) {
      // Lifted along the line to the camera, so a cube looms where it is instead of sliding
      // away from the middle of the screen.
      const world = modelWorldMatrix.mul(vec4(centre.xy, 0, 1)).xy
      centre = centre.sub(vec3(world.mul(lift.x.div(depth)), 0)) as V3
    }
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: FrontSide,
    })
    material.forceSinglePass = true
    material.positionNode = centre.add(vertex)

    // Shading: the face's own frame turned with the cube, a bevel that bends the normal toward
    // the edges, grooves and shadowed sides where neighbours sit, studs on toy bricks.
    const axisX = varying(turnBy(vec3(1, 0, 0) as V3)) as V3
    const axisY = varying(turnBy(vec3(0, 1, 0) as V3)) as V3
    const axisZ = varying(turnBy(vec3(0, 0, 1) as V3)) as V3
    const point = varying(local) as V3
    const halfSize = varying(size.mul(0.5)) as V3
    const localNormal = varying(normalGeometry) as V3
    const vNear = varying(nearOf) as V4
    // Neighbours shade only once landed, and less as a cube lifts away from them.
    const landed = smoothstep(HIT * 0.9, 1, progress)
      .mul(collapsed.oneMinus())
      .mul(abs(lift.x).div(cellU.mul(1.2)).clamp(0, 1).oneMinus())
    const vLanded = varying(landed) as F
    const vFlat = varying(flat) as F
    const vCells = varying(home.z) as F
    const q = point.div(max(halfSize, vec3(1e-3, 1e-3, 1e-3))) as V3
    const across = vec3(1, 1, 1).sub(abs(localNormal)) as V3
    const bevelWidth = cellU
      .mul(BEVEL[style])
      .div(max(halfSize, vec3(1e-3, 1e-3, 1e-3)))
      .clamp(1e-3, 0.95) as unknown as V3
    // Pixels have no bevel: their edges stay crisp.
    const edge = (
      BEVEL[style]
        ? smoothstep(vec3(1, 1, 1).sub(bevelWidth), vec3(1, 1, 1), abs(q)).mul(across)
        : vec3(0, 0, 0)
    ) as V3
    const smooth = vFlat.oneMinus()
    let bend = sign(q).mul(edge).mul(1.3).mul(smooth) as V3
    const front = smoothstep(0.5, 0.9, localNormal.z)
    // Neighbours beside the nearest edges, and beside a side face.
    const nearX = select(q.x.greaterThan(0), vNear.y, vNear.x)
    const nearY = select(q.y.greaterThan(0), vNear.z, vNear.w)
    const facing = max(
      max(localNormal.x, 0).mul(vNear.y),
      max(localNormal.x.negate(), 0).mul(vNear.x),
      max(localNormal.y, 0).mul(vNear.z),
      max(localNormal.y.negate(), 0).mul(vNear.w),
    )
    const crowd = vNear.x.add(vNear.y).add(vNear.z).add(vNear.w).mul(0.25)
    const side = front.oneMinus().mul(smoothstep(0.5, 0.9, localNormal.z.negate()).oneMinus())
    // Grooves between neighbours on the front; sides darker by the neighbour there, by the
    // neighbour count, and toward the page.
    let occlusion = float(1)
      .sub(edge.x.mul(nearX).add(edge.y.mul(nearY)).mul(front).mul(0.35))
      .sub(facing.mul(side).mul(0.5))
      .sub(crowd.mul(side).mul(0.12))
      .sub(q.z.oneMinus().mul(0.5).mul(side).mul(0.25))
    occlusion = mix(float(1), occlusion.max(0.2), vLanded.mul(smooth)) as F
    let extraLight: F = float(0)
    if (style === 'pixels') {
      // A faint seam where two voxels meet, so the face reads as voxels and not one block.
      const edgeX = smoothstep(halfSize.x.sub(1.1), halfSize.x.sub(0.3), abs(point.x)).mul(nearX)
      const edgeY = smoothstep(halfSize.y.sub(1.1), halfSize.y.sub(0.3), abs(point.y)).mul(nearY)
      occlusion = occlusion.mul(
        float(1).sub(max(edgeX, edgeY).mul(front).mul(vLanded).mul(smooth).mul(0.14)),
      ) as F
    }
    if (style === 'bricks') {
      // Mortar: a dark groove along the edges a neighbour shares.
      const groove = cellU.mul(0.07)
      const grooveX = smoothstep(
        halfSize.x.sub(groove),
        halfSize.x.sub(groove.mul(0.2)),
        abs(point.x),
      ).mul(nearX)
      const grooveY = smoothstep(
        halfSize.y.sub(groove),
        halfSize.y.sub(groove.mul(0.2)),
        abs(point.y),
      ).mul(nearY)
      occlusion = occlusion.mul(
        float(1).sub(max(grooveX, grooveY).mul(front).mul(vLanded).mul(smooth).mul(0.55)),
      ) as F
      // Studs, one per cell: a raised disc with a lit rim and a shadow to the lower right.
      const pitch = halfSize.x.mul(2).div(max(vCells, 1))
      const studX = floor(point.x.add(halfSize.x).div(pitch)).add(0.5).mul(pitch).sub(halfSize.x)
      const fromStud = vec2(point.x.sub(studX), point.y) as V2
      const studRadius = min(cellU.mul(0.3), halfSize.y.mul(0.62))
      const dist = length(fromStud)
      const on = studs.mul(front).mul(smooth)
      const inside = smoothstep(studRadius.sub(0.5), studRadius.add(0.5), dist).oneMinus().mul(on)
      const rim = smoothstep(studRadius.mul(0.68), studRadius, dist).mul(inside)
      const radial = fromStud.div(max(dist, 1e-3))
      bend = bend.add(vec3(radial.mul(rim).mul(1.4), 0)) as V3
      const shade = length(fromStud.sub(vec2(studRadius.mul(0.28), studRadius.mul(-0.28))))
      const cast = smoothstep(studRadius.mul(0.9), studRadius.mul(1.2), shade)
        .oneMinus()
        .mul(inside.oneMinus())
        .mul(on)
      occlusion = occlusion.mul(float(1).sub(cast.mul(0.3))) as F
      extraLight = inside.mul(0.05) as F
    }
    const nLocal = normalize(localNormal.add(bend)) as V3
    const normal = normalize(
      axisX.mul(nLocal.x).add(axisY.mul(nLocal.y)).add(axisZ.mul(nLocal.z)),
    ) as V3
    const light = vec3(...LIGHT).normalize() as V3
    const lightZ = LIGHT[2] / Math.hypot(...LIGHT)
    const ambient = 1 - DIFFUSE * lightZ
    const diffuse = max(dot(normal, light), 0)
    const lit = diffuse.mul(DIFFUSE).add(ambient).add(extraLight)
    const halfway = light.add(vec3(0, 0, 1)).normalize()
    const gloss = style === 'pixels' ? 0 : style === 'bricks' ? 0.5 : 0.35
    const spec = pow(max(dot(normal, halfway), 0), 60)
      .mul(gloss)
      .mul(smooth)
    // A pale sheen on lit faces turned from the viewer, so dark text keeps its shape.
    const sheen = diffuse.mul(normal.z.oneMinus().clamp(0, 1)).mul(0.16)
    const rgb = varying(inkOf.xyz).mul(lit).mul(occlusion).add(spec.add(sheen))
    const uv = vec2(home.x.div(half.x.mul(2)), home.y.div(half.y.mul(2)).oneMinus()).clamp(0, 1)
    const alpha = varying(gone.oneMinus().mul(ctx.mask(uv as V2))) as F
    material.colorNode = vec4(rgb, alpha)

    const letters = glyphs(
      layout,
      half,
      frame,
      ({ at }) => {
        if (keep) return solid as unknown as F
        const at0 = ready(at.x)
        return max(smoothstep(at0.add(FLAT * 0.2), at0.add(FLAT * 0.65), now), solid) as F
      },
      (uv) => ctx.mask(uv),
    )
    letters.mesh.renderOrder = 2

    // Voxels that stay cast soft shadows on the page and on the cubes below as they lift: a
    // blurred square per cube on the page plane, away from the key light, hidden by the lifted
    // cubes through the depth test.
    let shadow: Mesh | undefined
    if (keep) {
      const height = max(lift.x, 0)
      const blur = height.mul(0.3).add(0.75)
      const reach = vec2(-LIGHT[0], LIGHT[1]).mul(0.45 / LIGHT[2])
      const spot = home.xy.add(reach.mul(height)) as V2
      const extent = vec2(home.z.mul(cellU), cellU).mul(0.5) as V2
      const corner = positionGeometry.xy.mul(extent.add(blur).mul(2)) as V2
      const look = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: true,
        depthWrite: false,
      })
      look.positionNode = vec3(
        spot.x.add(corner.x).sub(half.x),
        half.y.sub(spot.y).add(corner.y),
        0.5,
      )
      const cornerV = varying(corner) as V2
      const extentV = varying(extent) as V2
      const blurV = varying(blur) as F
      const box = max(abs(cornerV.x).sub(extentV.x), abs(cornerV.y).sub(extentV.y))
      const soft = smoothstep(blurV.negate(), blurV, box).oneMinus()
      const strength = varying(
        height.div(cellU.mul(2.5)).clamp(0, 1).mul(solid.oneMinus()).mul(0.42),
      ) as F
      look.colorNode = vec4(0, 0, 0, soft.mul(strength).mul(alpha))
      shadow = new Mesh(undefined, look)
      shadow.frustumCulled = false
      shadow.renderOrder = 1
    }
    /** The shadow quads share the cubes' instance attributes. */
    const shade = (from: InstancedBufferGeometry): void => {
      if (!shadow) return
      const geometry = new InstancedBufferGeometry()
      geometry.setIndex([0, 2, 1, 2, 3, 1])
      geometry.setAttribute(
        'position',
        new BufferAttribute(
          new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]),
          3,
        ),
      )
      for (const name of [HOME, LIFTED]) geometry.setAttribute(name, from.getAttribute(name))
      geometry.instanceCount = from.instanceCount
      const old = shadow.geometry
      shadow.geometry = geometry
      old?.dispose()
    }
    const build = (next: Voxels): InstancedBufferGeometry => {
      const attributes: Record<string, readonly [Float32Array, number]> = {
        [HOME]: [next.at, 4],
        [INK]: [next.color, 4],
        [NEAR]: [next.near, 4],
        [FROM]: [next.from, 4],
        [SPIN]: [next.spin, 4],
      }
      if (keep) attributes[LIFTED] = [new Float32Array(Math.max(1, next.count) * 3), 3]
      return boxes(next.count, attributes, [LIFTED])
    }
    const cubes = new Mesh(build(grid), material)
    cubes.frustumCulled = false
    shade(cubes.geometry as InstancedBufferGeometry)
    const group = new Group()
    group.add(cubes, letters.mesh)
    if (shadow) group.add(shadow)
    ctx.onDispose(() => letters.dispose())
    // Placed before any showDom, which hides the replace object.
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()

    // Hover springs per cube: lift and lean x, y, with their speeds.
    let offsets = new Float32Array(grid.count * 3)
    let velocity = new Float32Array(grid.count * 3)
    const use = (next: Raster, made: Voxels): void => {
      layout = next
      grid = made
      const old = cubes.geometry
      cubes.geometry = build(made)
      shade(cubes.geometry as InstancedBufferGeometry)
      old.dispose()
      letters.use(next)
      frame.value.set(...next.frame)
      cellU.value = made.cell
      leftU.value = made.left
      extraU.value = made.extra
      waveU.value = Math.max(made.wave + made.extra, 1e-3)
      emU.value = made.em
      offsets = new Float32Array(made.count * 3)
      velocity = new Float32Array(made.count * 3)
    }
    const total = (): number => span(ctx.params, grid as Voxels, !keep)

    let dom = false
    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }
    end.value = total()
    t.value = seen ? end.value : -1
    if (seen && !keep) show(true)

    // Raster again when the text, its fonts or its width change, like assemble.
    let cancel: (() => void) | undefined
    let stuck: string | undefined
    // Cubes move, so the update asks for frames.
    let playing = false
    const redo = async (): Promise<void> => {
      cancel = undefined
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(`${why} cannot be drawn`)
      stuck = why
      if (why) {
        playing = false
        ctx.invalidate()
        return
      }
      const next = raster(element, 'letter', ratio)
      const made = next && pick(next)
      if (!next || !made?.count) return
      use(next, made)
      end.value = total()
      ctx.invalidate()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(() => void redo(), { timeout: 1000 })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(() => void redo(), 150)
        cancel = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => cancel?.())
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

    // The pointer in viewport px: a mouse anywhere on the page, a finger while it presses on the
    // text. Only voxels that stay react to it.
    const pointer = { x: 0, y: 0, on: false, touch: -1 }
    let near = { x: 0, y: 0, width: 0, height: 0 }
    if (keep) {
      const wake = (): void => {
        const reach = Math.max(ctx.params.radius, 0) * 1.4 + 8
        const { x, y } = pointer
        if (
          x > near.x - reach &&
          x < near.x + near.width + reach &&
          y > near.y - reach &&
          y < near.y + near.height + reach
        ) {
          playing = true
          ctx.invalidate()
        }
      }
      const move = (e: PointerEvent): void => {
        if (e.pointerType === 'touch' && e.pointerId !== pointer.touch) return
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.on = true
        wake()
      }
      const leave = (e: PointerEvent): void => {
        if (e.pointerType === 'touch' && e.pointerId !== pointer.touch) return
        pointer.touch = -1
        if (!pointer.on) return
        pointer.on = false
        playing = true
        ctx.invalidate()
      }
      addEventListener('pointermove', move, { passive: true, signal })
      element.addEventListener(
        'pointerdown',
        (e) => {
          const down = e as PointerEvent
          if (down.pointerType !== 'touch') return
          pointer.touch = down.pointerId
          move(down)
        },
        { passive: true, signal },
      )
      addEventListener('pointerup', leave, { passive: true, signal })
      addEventListener('pointercancel', leave, { passive: true, signal })
      document.documentElement.addEventListener(
        'pointerleave',
        (e) => (e as PointerEvent).pointerType !== 'touch' && leave(e as PointerEvent),
        { signal },
      )
      addEventListener('blur', () => leave(new PointerEvent('pointerup')), { signal })
    }

    /**
     * Steps the hover springs: cubes under the pointer pop out toward the viewer and lean out of
     * the bump, a shallow ring around it dips into the page, and the far ones answer later, so
     * the bump spreads like a ripple. True while any cube is away from its target or moving.
     */
    const spring = (input: { x: number; y: number }, delta: number, active: boolean): boolean => {
      const count = grid?.count ?? 0
      const at = grid?.at
      if (!count || !at) return false
      const radius = Math.max(ctx.params.radius, 0)
      const pointerX = pointer.x - input.x
      const pointerY = pointer.y - input.y
      const on = active && pointer.on && radius > 0
      const dt = Math.min(Math.max(delta, 0), 1 / 20)
      const steps = Math.max(1, Math.ceil(dt * 120))
      const step = dt / steps
      const reach2 = (radius * 1.5) ** 2
      let moving = false
      let dirty = false
      const target = [0, 0, 0]
      for (let i = 0; i < count; i++) {
        const offset = i * 3
        target[0] = target[1] = target[2] = 0
        let stiff = STIFF
        if (on) {
          const dx = (at[i * 4] as number) - pointerX
          const dy = (at[i * 4 + 1] as number) - pointerY
          const distanceSquared = dx * dx + dy * dy
          if (distanceSquared < reach2) {
            const distance = Math.sqrt(distanceSquared) + 1e-3
            const reach = distance / radius
            const bump = reach < 1 ? (1 - reach * reach) ** 2 : 0
            const ring = Math.exp(-(((reach - 1.05) / 0.22) ** 2))
            target[0] = radius * LIFT * (bump - RING * ring)
            const slope = reach < 1 ? 4 * reach * (1 - reach * reach) * LIFT : 0
            const angle = Math.atan(slope) * LEAN
            target[1] = (dx / distance) * angle
            target[2] = (dy / distance) * angle
            // Softer further out: the outer cubes answer later.
            stiff = STIFF * (1.2 - 0.55 * Math.min(reach, 1.5))
          }
        }
        let still = true
        for (let c = 0; c < 3; c++)
          still &&=
            Math.abs((target[c] as number) - (offsets[offset + c] as number)) <
              (c ? 0.002 : 0.03) && Math.abs(velocity[offset + c] as number) < (c ? 0.01 : 0.08)
        if (still) {
          for (let c = 0; c < 3; c++) {
            if (offsets[offset + c] === target[c] && velocity[offset + c] === 0) continue
            offsets[offset + c] = target[c] as number
            velocity[offset + c] = 0
            dirty = true
          }
          continue
        }
        const damp = 2 * ZETA * Math.sqrt(stiff)
        for (let c = 0; c < 3; c++) {
          let x = offsets[offset + c] as number
          let speed = velocity[offset + c] as number
          const goal = target[c] as number
          for (let st = 0; st < steps; st++) {
            speed += (stiff * (goal - x) - damp * speed) * step
            x += speed * step
          }
          offsets[offset + c] = x
          velocity[offset + c] = speed
        }
        moving = true
        dirty = true
      }
      if (dirty) {
        const attr = cubes.geometry.getAttribute(LIFTED) as InstancedBufferAttribute
        ;(attr.array as Float32Array).set(offsets)
        attr.needsUpdate = true
      }
      return moving
    }
    /** Puts every cube back in the plane at once. */
    const still = (): void => {
      if (!keep || offsets.every((v) => v === 0)) return
      offsets.fill(0)
      velocity.fill(0)
      const attr = cubes.geometry.getAttribute(LIFTED) as InstancedBufferAttribute
      ;(attr.array as Float32Array).fill(0)
      attr.needsUpdate = true
    }

    // Seconds since the view trigger fired, -1 before it; the rise of a heading seen as
    // DOM into voxels that stay.
    let elapsed = -1
    let rise = seen && keep ? 0 : -1
    if (rise >= 0) playing = true
    return (input): boolean => {
      if (stuck) {
        show(true)
        return playing
      }
      const { y, height, progress, presence } = input
      near = input
      const live = ctx.params
      studs.value = live.studs ? 1 : 0
      const last = total()
      end.value = last
      if (input.reducedMotion) {
        // The text as it is; pixels stay as still voxels.
        playing = false
        still()
        t.value = last
        solid.value = 0
        collapse.value = 0
        rise = -1
        show(style !== 'pixels')
        return false
      }
      const viewport = stage.height.peek()
      let time: number
      let leaving = 0
      if (trigger === 'scroll') {
        // Builds from `threshold` of the box in view to just before the middle, holds, turns
        // back into cubes and drops them on the way to the top.
        const from = (live.threshold * height) / (viewport + height || 1)
        const gather = Math.min(1, Math.max(0, (progress - from) / (HOLD_AT[0] - from || 1)))
        const scatter = Math.min(
          1,
          Math.max(0, (progress - HOLD_AT[1]) / (1 - from - HOLD_AT[1] || 1)),
        )
        if (seen && gather < 1) time = last
        else {
          seen = false
          time = gather * last
        }
        if (scatter > 0) {
          const undo = keep ? 0 : UNDO
          if (undo) time = Math.min(time, last - (HOLD + FLAT) * Math.min(1, scatter / undo))
          leaving = Math.min(1, Math.max(0, (scatter - undo) / (1 - undo)))
        }
      } else if (hover) time = last
      else {
        if (!seen && elapsed < 0) {
          // Counted above the bottom tenth of the viewport, like `reveal`.
          if (inView(y, height, viewport, live.threshold)) {
            elapsed = 0
            playing = true
          }
        } else if (elapsed >= 0 && elapsed < last) elapsed += input.delta
        time = seen ? last : Math.max(elapsed, 0)
      }
      t.value = Math.min(time, last)
      collapse.value = leaving
      let busy = trigger === 'view' && elapsed >= 0 && elapsed < last
      if (rise >= 0) {
        rise += input.delta
        solid.value = Math.max(0, 1 - rise / RISE)
        if (rise >= RISE) rise = -1
        else busy = true
      } else solid.value = 0
      const built = time >= last && leaving === 0
      if (!keep) {
        playing = busy
        show(built && presence >= 1)
        return busy
      }
      if (spring(input, input.delta, built && presence >= 1)) busy = true
      playing = busy
      show(false)
      return busy
    }
  },
})
export default voxel
