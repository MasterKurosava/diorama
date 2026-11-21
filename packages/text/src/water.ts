import type { ChoiceParam, Effect, EffectContext, QualityTier } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, dither, fresnel, rng } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  refract,
  sin,
  smoothstep,
  sqrt,
  sRGBTransferEOTF,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  type Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NoBlending,
  type Node,
  NodeMaterial,
  PlaneGeometry,
  QuadMesh,
  RenderTarget,
  RGBAFormat,
  type Texture,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { alphaOf, atlas, backdrop, linear } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'
import { blur, coverage, distance } from './sdf'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
export type Style = 'pool' | 'rain' | 'ice'
type Trigger = 'loop' | 'hover'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  depth: number
  caustics: number
  ripples: number
  rain: number
  damping: number
  tint: number
}
type RGB = readonly [number, number, number]

/** Simulation steps a second, at most per frame, and drops one step takes. */
export const STEPS = 60
const MAX_STEPS = 4
const DROPS = 6
/** Frames a second while the water moves. */
const FPS = 30
/** Below this wave height (cells) the water counts as calm and the simulation is cleared. */
export const CALM = 0.002
/** Most drops waiting for the simulation; older ones go first. */
const QUEUE = 48
/** Melt the pointer leaves (1 is clear water; the rest is held before refreezing), and its loss a second. */
const HOLD = 1.6
const REFREEZE = 0.45
/** Cells per em of the simulation grid by quality, and its longest side. */
const CELLS: Readonly<Record<QualityTier, number>> = { low: 12, medium: 16, high: 21 }
const MAX_CELLS = 384
/** Cells along the edge of a pool without walls that swallow the waves reaching them. */
const SPONGE = 4
/** Seconds a tap keeps a hovered shower or swell going on touch screens. */
const TAP = 1.6
/** Refraction index of water. */
const ETA = 1 / 1.333

/** One wave of the swell: wavelength (em), direction (rad, box axes), focusing strength, phase. */
export interface Wave {
  readonly length: number
  readonly angle: number
  readonly strength: number
  readonly phase: number
}
/**
 * The swell under every style: five waves from different directions whose crests focus light
 * into the net of caustics. Their strength is the share of the focal distance their curvature
 * reaches, so the net looks the same at any font size.
 */
export const SWELL: readonly Wave[] = [
  { length: 0.95, angle: 0.35, strength: 1.05, phase: 0 },
  { length: 0.74, angle: 1.45, strength: 0.95, phase: 1.3 },
  { length: 0.58, angle: -0.62, strength: 0.9, phase: 2.1 },
  { length: 0.46, angle: 2.4, strength: 0.8, phase: 4 },
  { length: 0.37, angle: -1.95, strength: 0.7, phase: 5.2 },
]

/** The water of a style, in linear RGB. */
interface Look {
  /** Light lost per unit of `tint`, red first: red goes first under water. */
  readonly absorb: RGB
  /** Light the water scatters back toward the viewer. */
  readonly scatter: RGB
  /** The sky the surface reflects, a window over the pool and the sun's glints. */
  readonly sky: RGB
  readonly window: number
  readonly sun: number
  /** Strength of the swell and how fast it moves. */
  readonly swell: number
  readonly pace: number
  /** Share of the caustics: thin under clouds and frost. */
  readonly light: number
}

const LOOKS: Readonly<Record<Style, Look>> = {
  pool: {
    absorb: [0.62, 0.17, 0.11],
    scatter: [0.02, 0.33, 0.44],
    sky: [0.5, 0.66, 0.85],
    window: 6,
    sun: 36,
    swell: 1,
    pace: 1,
    light: 1,
  },
  rain: {
    absorb: [0.42, 0.27, 0.2],
    scatter: [0.1, 0.17, 0.23],
    sky: [0.62, 0.67, 0.74],
    window: 7,
    sun: 0,
    swell: 0.4,
    pace: 0.6,
    light: 0.75,
  },
  ice: {
    absorb: [0.1, 0.05, 0.03],
    scatter: [0.2, 0.3, 0.36],
    sky: [0.72, 0.84, 0.96],
    window: 5,
    sun: 26,
    swell: 0.55,
    pace: 0,
    light: 0.22,
  },
}
/** Caustic light, a little warm, and the frost on ice. */
const SUN: RGB = [1, 0.97, 0.9]
const FROST: RGB = [0.82, 0.9, 0.96]

/** The grid of the simulation over a domain of `width` by `height` px: cells across, down and the cell size. */
export function grid(
  width: number,
  height: number,
  em: number,
  quality: QualityTier,
): { cols: number; rows: number; cell: number } {
  const longest = Math.max(1, width, height)
  const cell = Math.max(2, em / (CELLS[quality] ?? CELLS.high), longest / MAX_CELLS)
  return {
    cols: Math.max(4, Math.ceil(width / cell)),
    rows: Math.max(4, Math.ceil(height / cell)),
    cell,
  }
}

/** Per-step factor that leaves waves `exp(-rate)` of their height after a second. */
export const decay = (damping: number): number =>
  Math.exp(-(0.3 + 3.4 * Math.min(1, Math.max(0, damping))) / STEPS)

/** A drop on the water in cells, y up: its place, radius and height (negative digs a crater). */
export interface Drop {
  readonly x: number
  readonly y: number
  readonly radius: number
  readonly strength: number
}

/**
 * The drops waiting for the simulation and a bound on how high the waves still are, so frames
 * stop once the water is calm.
 */
export class Pond {
  readonly queue: Drop[] = []
  /** Upper bound of the wave height in cells. */
  level = 0
  add(drop: Drop): void {
    if (this.queue.length >= QUEUE) this.queue.shift()
    this.queue.push(drop)
    this.level += Math.abs(drop.strength)
  }
  /** The drops of the next step. */
  take(): Drop[] {
    return this.queue.splice(0, DROPS)
  }
  /** `steps` simulation steps damped by `factor` each. */
  settle(factor: number, steps: number): void {
    this.level *= factor ** steps
  }
  get calm(): boolean {
    return this.level < CALM && !this.queue.length
  }
  clear(): void {
    this.queue.length = 0
    this.level = 0
  }
}

/** Smooth value noise on the integer lattice, 0..1. */
function valueNoise(seed: number): (x: number, y: number) => number {
  const at = (ix: number, iy: number): number => {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  return (x, y) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = at(ix, iy)
    const b = at(ix + 1, iy)
    const c = at(ix, iy + 1)
    const d = at(ix + 1, iy + 1)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
}

/**
 * The ice over a domain of `width` by `height` texels with `em` texels to the em, rows top
 * down, RGBA bytes: red the cracks, green the frost (thick at the edges, in patches and along
 * the cracks), blue the cracks blurred, for the light they bend.
 */
export function iceMap(width: number, height: number, em: number, seed = 1): Uint8Array {
  const columns = Math.max(1, Math.round(width))
  const rows = Math.max(1, Math.round(height))
  const crack = new Float32Array(columns * rows)
  const random = rng(seed)
  const line = (x0: number, y0: number, x1: number, y1: number, width: number, bright: number) => {
    const pad = width + 1
    const dx = x1 - x0
    const dy = y1 - y0
    const len = dx * dx + dy * dy || 1
    for (
      let y = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
      y <= Math.min(rows - 1, Math.ceil(Math.max(y0, y1) + pad));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
        x <= Math.min(columns - 1, Math.ceil(Math.max(x0, x1) + pad));
        x++
      ) {
        const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len))
        const d = Math.hypot(x0 + t * dx - x, y0 + t * dy - y)
        const v = Math.min(1, Math.max(0, width / 2 + 0.5 - d)) * bright
        const i = y * columns + x
        if (v > (crack[i] as number)) crack[i] = v
      }
  }
  // Long cracks that kink as they run and branch now and then.
  const count = Math.round(Math.min(16, Math.max(3, ((columns * rows) / (em * em)) * 0.3)))
  const walk = (
    x: number,
    y: number,
    heading: number,
    length: number,
    width: number,
    bright: number,
    depth: number,
  ): void => {
    const step = Math.max(2, em * 0.11)
    for (let run = 0; run < length; run += step) {
      heading += (random() - 0.5) * 0.5
      const nx = x + Math.cos(heading) * step
      const ny = y + Math.sin(heading) * step
      line(x, y, nx, ny, width, bright)
      x = nx
      y = ny
      if (x < -em || y < -em || x > columns + em || y > rows + em) return
      if (depth < 2 && random() < 0.07) {
        const side = random() < 0.5 ? -1 : 1
        walk(
          x,
          y,
          heading + side * (0.5 + random() * 0.7),
          (length - run) * (0.3 + random() * 0.3),
          width * 0.75,
          bright * 0.8,
          depth + 1,
        )
      }
    }
  }
  for (let i = 0; i < count; i++)
    walk(
      random() * columns,
      random() * rows,
      random() * Math.PI * 2,
      em * (1.2 + random() * 2.6),
      0.9 + random() * 0.8,
      0.55 + random() * 0.45,
      0,
    )
  const soft = blur(crack, columns, rows, Math.max(1.2, em * 0.035))
  const noise = valueNoise(seed)
  const out = new Uint8Array(columns * rows * 4)
  const edge = em * 1.1
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x
      // Patches: a few octaves; feathers: ridged fine noise; thicker toward the edges.
      const u = x / em
      const v = y / em
      const patch =
        noise(u * 1.1, v * 1.1) * 0.55 +
        noise(u * 2.3 + 7, v * 2.3) * 0.3 +
        noise(u * 5, v * 5 + 3) * 0.15
      const feather = 1 - Math.abs(2 * noise(u * 9 + 11, v * 9) - 1)
      const near = Math.min(x, y, columns - 1 - x, rows - 1 - y)
      const rim = 1 - Math.min(1, near / edge)
      const s = soft[i] as number
      const frost = Math.min(
        1,
        Math.max(0, (patch - 0.5) * 1.6) * 0.6 + rim * rim * 0.8 + feather ** 3 * 0.12 + s * 0.7,
      )
      out[i * 4] = Math.round((crack[i] as number) * 255)
      out[i * 4 + 1] = Math.round(frost * 255)
      out[i * 4 + 2] = Math.round(Math.min(1, s * 2.5) * 255)
      out[i * 4 + 3] = 255
    }
  return out
}

/** Ems the water reaches past the glyphs, at least and at most, along its wandering shore. */
export const SHORE: readonly [number, number] = [0.14, 0.42]

/**
 * The puddle around the text in a `width` by `height` box: a signed distance to its shore in
 * px, negative in the water, rows top down, `scale` texels per px. The shore wanders between
 * SHORE ems past the glyphs and rounds off where it meets the box, so nothing marks the box.
 */
export function puddle(
  r: Raster,
  width: number,
  height: number,
  em: number,
  seed = 3,
): { data: Float32Array; width: number; height: number; scale: number } {
  const scale = Math.min(1, 10 / Math.max(em, 1), 512 / Math.max(width, height, 1))
  const fieldWidth = Math.max(2, Math.ceil(width * scale))
  const fieldHeight = Math.max(2, Math.ceil(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = fieldWidth
  canvas.height = fieldHeight
  const [frameX, frameY, frameWidth, frameHeight] = r.frame
  canvas
    .getContext('2d')
    ?.drawImage(r.canvas, frameX * scale, frameY * scale, frameWidth * scale, frameHeight * scale)
  const field = distance(coverage(canvas, fieldWidth, fieldHeight), fieldWidth, fieldHeight)
  const noise = valueNoise(seed)
  const [near, far] = SHORE
  const k = em * 0.18
  const data = new Float32Array(fieldWidth * fieldHeight)
  for (let y = 0; y < fieldHeight; y++)
    for (let x = 0; x < fieldWidth; x++) {
      const i = y * fieldWidth + x
      const boxX = (x + 0.5) / scale
      const boxY = (y + 0.5) / scale
      const n =
        noise(boxX / em + 0.3, boxY / em) * 0.7 +
        noise((boxX / em) * 2.3, (boxY / em) * 2.3 + 5) * 0.3
      const glyphs = Math.min(4096, (field[i] as number) / scale)
      const a = glyphs - em * (near + (far - near) * n)
      // Kept a little inside the box, the two joined by a smooth maximum: rounded, not cut.
      const b = em * 0.06 - Math.min(boxX, boxY, width - boxX, height - boxY)
      const t = Math.max(k - Math.abs(a - b), 0) / k
      data[i] = Math.max(a, b) + t * t * k * 0.25
    }
  return { data, width: fieldWidth, height: fieldHeight, scale }
}

/** Phases whose water still moves, so the frame policy keeps drawing. */
const pacing = new WeakMap<AbortSignal, () => number>()

/**
 * The heading lies under water: a surface simulated on the GPU bends the letters and the page
 * beneath, focuses light into dancing caustics on them and reflects the sky, with a tint that
 * deepens the farther the light goes. The pointer drags ripples and clicks drop them; rain rings
 * out on its own; ice stays still under frost and cracks until the pointer melts a clear patch.
 */
const water: Effect<Params> = defineEffect({
  name: 'water',
  params: {
    style: oneOf('pool', 'rain', 'ice'),
    trigger: oneOf('loop', 'hover'),
    depth: 1,
    caustics: 1,
    ripples: 1,
    rain: 6,
    damping: 0.5,
    tint: 0.5,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal, render } = ctx
    const el = element as HTMLElement
    const style = params.style
    const trigger = params.trigger
    const look = LOOKS[style]
    const tier = ctx.quality
    const ratio = tier === 'low' ? 1 : 2
    const own = getComputedStyle(element)
    const image =
      own.backgroundImage && own.backgroundImage !== 'none' ? 'a background image' : undefined
    const reason = unsupported(element) ?? image ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`water: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }

    // The floor: the element's own background, a pool with walls; else the page behind it, the
    // water thinning out toward the edges; over a picture only the letters and the light are
    // drawn. Nothing is drawn past the box, where the water would cover the text around it.
    const bgAlpha = alphaOf(own.backgroundColor || 'transparent')
    const walled = bgAlpha > 0.01
    const behind = walled ? undefined : backdrop(element)
    const floorCss = walled ? cssColor(own.backgroundColor) : behind ? behind.color : '#ffffff'
    const floorColor: Color = linear(floorCss ?? '#ffffff')
    const opaque = walled ? Math.min(1, bgAlpha) : floorCss ? 1 : 0

    const emOf = (r: Raster): number => Math.max(1, ...r.quads.map((q) => q.em))
    const box = { width: el.offsetWidth || 1, height: el.offsetHeight || 1 }
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      box.width = Math.max(1, rect.width)
      box.height = Math.max(1, rect.height)
    }
    measure()

    // The simulation: height, velocity and melt per cell in two targets that take turns.
    const gpuSim =
      typeof (render.renderer as { setRenderTarget?: unknown }).setRenderTarget === 'function'
    let em = emOf(layout)
    let size = grid(box.width, box.height, em, tier)
    const target = (): RenderTarget =>
      new RenderTarget(size.cols, size.rows, {
        type: HalfFloatType,
        format: RGBAFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
      })
    let targets: [RenderTarget, RenderTarget] = [target(), target()]
    ctx.onDispose(() => {
      for (const t of targets) t.dispose()
    })

    const cells = uniform(new Vector2(size.cols, size.rows))
    const keep = uniform(decay(params.damping))
    const reset = uniform(0)
    const drops = Array.from({ length: DROPS }, () => uniform(new Vector4(0, 0, 1, 0)))
    // The pointer's melt: cells x, y, radius and amount a step.
    const melter = uniform(new Vector4(0, 0, 1, 0))
    const thaw = uniform(style === 'ice' ? REFREEZE / STEPS : 0)

    const step = (read: Texture): NodeMaterial => {
      const material = new NodeMaterial()
      material.blending = NoBlending
      material.depthTest = false
      material.depthWrite = false
      const src = texture(read)
      const at = uv()
      const texelSize = vec2(1, 1).div(cells as unknown as V2)
      const centre = src.sample(at) as unknown as V4
      const left = src.sample(at.sub(vec2(texelSize.x, 0))) as unknown as V4
      const right = src.sample(at.add(vec2(texelSize.x, 0))) as unknown as V4
      const down = src.sample(at.sub(vec2(0, texelSize.y))) as unknown as V4
      const up = src.sample(at.add(vec2(0, texelSize.y))) as unknown as V4
      const cellAt = at.mul(cells as unknown as V2)
      const n = cells as unknown as V2
      // A sponge along the edge of a pool without walls swallows the waves that reach it.
      const edge = min(min(cellAt.x, n.x.sub(cellAt.x)), min(cellAt.y, n.y.sub(cellAt.y)))
      const k = walled
        ? (keep as unknown as F)
        : mix(0.8, 1, smoothstep(0, SPONGE, edge)).mul(keep as unknown as F)
      // Melt spreads a little, the pointer adds to it and it freezes back.
      const melterNode = melter as unknown as V4
      let melt: F = mix(centre.z, left.z.add(right.z, down.z, up.z).mul(0.25), 0.1) as F
      melt = melt.add(
        smoothstep(melterNode.z, melterNode.z.mul(0.35), length(cellAt.sub(melterNode.xy))).mul(
          melterNode.w,
        ),
      ) as F
      melt = clamp(melt.sub(thaw as unknown as F), 0, HOLD) as F
      const free = style === 'ice' ? clamp(melt, 0, 1) : (1 as unknown as F)
      // Nine points, so rings stay round down to a few cells.
      const corners = src
        .sample(at.add(texelSize))
        .x.add(
          src.sample(at.sub(texelSize)).x,
          src.sample(at.add(vec2(texelSize.x, texelSize.y.negate()))).x,
          src.sample(at.add(vec2(texelSize.x.negate(), texelSize.y))).x,
        )
      const average = left.x.add(right.x, down.x, up.x).mul(0.2).add(corners.mul(0.05))
      const velocity = centre.y.add(average.sub(centre.x).mul(2)).mul(k).mul(free)
      let height: F = centre.x.add(velocity).mul(k) as F
      for (const drop of drops) {
        const dropNode = drop as unknown as V4
        const q = cellAt.sub(dropNode.xy).div(dropNode.z)
        const distanceSquared = dot(q, q)
        // Zero in sum: a crater with a rim, or a bump with a trough, and no water added.
        height = height.add(
          distanceSquared
            .mul(-0.5)
            .add(1)
            .mul(exp(distanceSquared.mul(-0.5)))
            .mul(dropNode.w)
            .mul(free),
        ) as F
      }
      const out = vec4(height, velocity, melt, 1)
      material.fragmentNode = (reset as unknown as F).greaterThan(0.5).select(vec4(0), out)
      return material
    }
    const quads = [new QuadMesh(step(targets[0].texture)), new QuadMesh(step(targets[1].texture))]
    ctx.onDispose(() => {
      for (const q of quads) (q.material as NodeMaterial).dispose()
    })

    // The surface.
    const sim = texture(targets[0].texture)
    sim.mergeable = false
    const letters = texture(atlas(layout.canvas))
    letters.mergeable = false
    const frame = uniform(new Vector4(...layout.frame))
    const emU = uniform(em)
    const cellPx = uniform(new Vector2(box.width / size.cols, box.height / size.rows))
    const clock = uniform(0)
    const floorU = uniform(floorColor)
    const opaqueU = uniform(opaque)
    const iceTexture = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    iceTexture.minFilter = LinearFilter
    iceTexture.magFilter = LinearFilter
    iceTexture.needsUpdate = true
    const ice = texture(iceTexture)
    ice.mergeable = false
    const makeIce = (): void => {
      if (style !== 'ice') return
      const boxWidth = box.width
      const boxHeight = box.height
      const scale = Math.min(1, 1024 / Math.max(boxWidth, boxHeight))
      const cellsWide = Math.max(1, Math.round(boxWidth * scale))
      const cellsHigh = Math.max(1, Math.round(boxHeight * scale))
      const map = new DataTexture(iceMap(cellsWide, cellsHigh, em * scale, 7), cellsWide, cellsHigh)
      map.minFilter = LinearFilter
      map.magFilter = LinearFilter
      map.needsUpdate = true
      const old = ice.value as Texture
      ice.value = map
      old.dispose()
    }
    makeIce()
    // Without walls the water lies in a puddle around the text: its shore as a distance field.
    const shoreTexture = new DataTexture(new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType)
    const shore = texture(shoreTexture)
    shore.mergeable = false
    const makeShore = (): void => {
      if (walled) return
      const made = puddle(layout as Raster, box.width, box.height, em)
      const data = new Uint16Array(made.width * made.height * 4)
      for (let i = 0; i < made.data.length; i++)
        data[i * 4] = DataUtils.toHalfFloat(made.data[i] as number)
      const map = new DataTexture(data, made.width, made.height, RGBAFormat, HalfFloatType)
      map.minFilter = LinearFilter
      map.magFilter = LinearFilter
      map.needsUpdate = true
      const old = shore.value as Texture
      shore.value = map
      old.dispose()
    }
    makeShore()
    ctx.onDispose(() => {
      ;(letters.value as Texture).dispose()
      ;(ice.value as Texture).dispose()
      ;(shore.value as Texture).dispose()
    })

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const half = (u.size as unknown as V2).mul(0.5)
    const span = u.size as unknown as V2
    const corner = positionGeometry.xy as unknown as V2
    material.positionNode = vec3(corner.x.mul(span.x), corner.y.mul(span.y), 0)
    // Box px, y down.
    const point = varying(
      vec2(corner.x.mul(span.x).add(half.x), half.y.sub(corner.y.mul(span.y))),
    ) as unknown as V2
    const simUV = uv() as unknown as V2
    const cellSize = cellPx as unknown as V2
    const emNode = emU as unknown as F
    const inward = min(min(point.x, u.size.x.sub(point.x)), min(point.y, u.size.y.sub(point.y)))
    // Without walls the water is a puddle with a wandering shore: px to it, negative inside.
    const shoreAt = (o: V2): F =>
      (shore.sample(point.add(o).div(u.size as unknown as V2)) as unknown as V4).x as F
    const shoreDistance = walled ? (emNode.negate() as unknown as F) : shoreAt(vec2(0, 0))
    const edgeSoftness = max(fwidth(shoreDistance), 0.6)
    const wet = walled
      ? (1 as unknown as F)
      : (smoothstep(edgeSoftness, edgeSoftness.negate(), shoreDistance) as unknown as F)

    // Heights of the simulation in cells, its slope (px of rise a px) and curvature (1/px), y down.
    const stepX = vec2(1, 0).div(cells as unknown as V2)
    const stepY = vec2(0, 1).div(cells as unknown as V2)
    const hAt = (o: V2): F => (sim.sample(simUV.add(o)) as unknown as V4).x
    const height = hAt(vec2(0, 0))
    const heightLeft = hAt(stepX.negate())
    const heightRight = hAt(stepX)
    const heightAbove = hAt(stepY)
    const heightBelow = hAt(stepY.negate())
    let slopeX: F = heightRight.sub(heightLeft).mul(0.5) as F
    let slopeY: F = heightBelow.sub(heightAbove).mul(0.5) as F
    let hxx: F = heightRight.add(heightLeft).sub(height.mul(2)).div(cellSize.x) as F
    let hyy: F = heightBelow.add(heightAbove).sub(height.mul(2)).div(cellSize.y) as F
    let hxy: F = hAt(stepX.add(stepY.negate()))
      .sub(hAt(stepX.add(stepY)))
      .sub(hAt(stepX.negate().sub(stepY)))
      .add(hAt(stepX.negate().add(stepY)))
      .div(cellSize.x.mul(cellSize.y).mul(4)) as F

    // The swell, analytic: its slope and curvature add to the simulation's.
    const focus = emNode.mul(2.2)
    const q = point.div(emNode)
    for (const wave of SWELL) {
      const k = (2 * Math.PI) / wave.length
      const dx = Math.cos(wave.angle)
      const dy = Math.sin(wave.angle)
      const omega = (2.2 / Math.sqrt(wave.length)) * look.pace
      const phase = q.x
        .mul(dx * k)
        .add(q.y.mul(dy * k))
        .sub((clock as unknown as F).mul(omega))
        .add(wave.phase)
      // Curvature amplitude a k² is `strength` over the focal distance; slope a k follows.
      const curve = focus.reciprocal().mul(wave.strength * look.swell)
      const slope = curve.mul(emNode).div(k)
      const cosPhase = cos(phase)
      const sinPhase = sin(phase)
      slopeX = slopeX.add(slope.mul(cosPhase).mul(dx)) as F
      slopeY = slopeY.add(slope.mul(cosPhase).mul(dy)) as F
      const bend = curve.mul(sinPhase).negate()
      hxx = hxx.add(bend.mul(dx * dx)) as F
      hyy = hyy.add(bend.mul(dy * dy)) as F
      hxy = hxy.add(bend.mul(dx * dy)) as F
    }

    // At the shore the surface curls down to the page and catches the sky in a thin bright
    // line; only its reflection takes the curl, so letters far off never show in it.
    const lip = emNode.mul(0.035)
    let curl: F = float(0)
    let cx: F = float(0)
    let cy: F = float(0)
    if (!walled) {
      const shoreSlopeX = shoreAt(vec2(1.5, 0)).sub(shoreAt(vec2(-1.5, 0)))
      const shoreSlopeY = shoreAt(vec2(0, 1.5)).sub(shoreAt(vec2(0, -1.5)))
      const out = vec2(shoreSlopeX, shoreSlopeY).div(
        max(length(vec2(shoreSlopeX, shoreSlopeY)), 1e-4),
      )
      curl = exp(shoreDistance.add(lip).div(lip).pow(2).negate()).mul(wet) as F
      cx = out.x.mul(curl).mul(-0.55) as F
      cy = out.y.mul(curl).mul(-0.55) as F
    }

    // Ice: frost, cracks and the melt the pointer leaves.
    const iceAt = (o: V2): V4 =>
      ice.sample(vec2(simUV.x, simUV.y.oneMinus()).add(o)) as unknown as V4
    let melted: F = 1 as unknown as F
    let frost: F = 0 as unknown as F
    let crack: F = 0 as unknown as F
    let crackEdge: F = 0 as unknown as F
    let crackBend: V2 = vec2(0, 0)
    if (style === 'ice') {
      melted = clamp((sim.sample(simUV) as unknown as V4).z, 0, 1) as F
      const frozen = melted.oneMinus()
      const here = iceAt(vec2(0, 0))
      const texel = vec2(1, 1).div(span).mul(1.5)
      const iceSlopeX = iceAt(vec2(texel.x, 0)).z.sub(iceAt(vec2(texel.x.negate(), 0)).z)
      const iceSlopeY = iceAt(vec2(0, texel.y)).z.sub(iceAt(vec2(0, texel.y.negate())).z)
      crackBend = vec2(iceSlopeX, iceSlopeY).mul(frozen) as unknown as V2
      // A slushy rim where the melt meets the ice.
      const rim = smoothstep(0.15, 0.45, melted).mul(smoothstep(0.85, 0.5, melted))
      frost = clamp(here.y.mul(frozen).add(rim.mul(0.55)), 0, 1) as F
      crack = here.x.mul(frozen) as F
      crackEdge = iceAt(texel.mul(0.8)).x.mul(frozen) as F
      // Frozen, the surface is still: only the melt carries the simulation's waves.
      slopeX = slopeX.mul(mix(0.6, 1, melted)) as F
      slopeY = slopeY.mul(mix(0.6, 1, melted)) as F
    }

    // Box px to world: y up.
    const view = normalize(positionWorld.sub(cameraPosition)) as unknown as V3
    // Half the page camera's slant: reflections move with the page without sweeping across it.
    const look2 = normalize(mix(vec3(0, 0, -1), view, 0.4)) as unknown as V3
    const normal = normalize(vec3(slopeX.negate(), slopeY, 1)) as unknown as V3
    const refractNormal = walled
      ? normal
      : (normalize(vec3(slopeX.add(cx).negate(), slopeY.add(cy), 1)) as unknown as V3)
    const flat = vec3(0, 0, 1)
    // Where the eye's ray meets the floor: the slant of the page camera over the depth of the
    // water, and the bend of the waves over a longer lever, so the letters waver more than shift.
    const bent = refract(view, normal, ETA) as unknown as V3
    const straight = refract(view, flat, ETA) as unknown as V3
    const lean = straight.xy.div(straight.z.negate().max(0.2))
    const wobble = bent.xy.div(bent.z.negate().max(0.2)).sub(lean)
    const shiftW = lean
      .mul(emNode.mul(0.15))
      .add(wobble.mul(emNode.mul(1.1)))
      .mul(u.depth.max(0), wet)
    const shift = vec2(shiftW.x, shiftW.y.negate()).add(crackBend.mul(emNode.mul(0.5)))
    const floorAt = point.add(shift)

    // The letters on the floor, blurred under frost.
    const frameNode = frame as unknown as V4
    const lettersUV = vec2(
      floorAt.x.sub(frameNode.x).div(frameNode.z),
      floorAt.y.sub(frameNode.y).div(frameNode.w).oneMinus(),
    )
    const inside = smoothstep(0, 0.002, lettersUV.x)
      .mul(smoothstep(1, 0.998, lettersUV.x))
      .mul(smoothstep(0, 0.002, lettersUV.y))
      .mul(smoothstep(1, 0.998, lettersUV.y))
    const lod = style === 'ice' ? frost.mul(1.2).add(melted.oneMinus().mul(0.2)) : undefined
    const ink = (lod
      ? letters.sample(lettersUV).level(lod)
      : letters.sample(lettersUV)) as unknown as V4
    const inkAlpha = ink.a.mul(inside)
    const inkRGB = sRGBTransferEOTF(ink.rgb.div(max(ink.a, 1e-4)) as never) as unknown as V3

    // Caustics: the sun's rays bent by the surface land focused where the surface curves up.
    // Their density is one over the area a patch of surface spreads its light on.
    const focusX = focus.mul(hxx).add(1)
    const focusY = focus.mul(hyy).add(1)
    const fxy = focus.mul(hxy)
    const det = focusX.mul(focusY).sub(fxy.mul(fxy))
    const soft = max(fwidth(det).mul(0.7), 0.07)
    const density = min(sqrt(det.mul(det).add(soft.mul(soft))).reciprocal(), 9)
    const shallow = walled ? float(1) : smoothstep(0, emNode.mul(0.3), shoreDistance.negate())
    const strength = u.caustics
      .max(0)
      .mul(look.light, wet, shallow.mul(0.6).add(0.4))
      .mul(mix(1, 0.5, frost))
    // Pool walls shade the floor along their foot.
    const foot = walled ? mix(0.8, 1, smoothstep(0, emNode.mul(0.22), inward)) : (1 as unknown as F)
    const light = density.min(5).mul(0.45).sub(0.34).mul(strength).add(1).max(0.2).mul(foot)

    // What lies under the water, premultiplied: the letters over the floor.
    const opaqueNode = opaqueU as unknown as F
    const floorRGB = floorU as unknown as V3
    const underA = opaqueNode.add(inkAlpha.mul(opaqueNode.oneMinus()))
    const under = floorRGB.mul(opaqueNode).mul(inkAlpha.oneMinus()).add(inkRGB.mul(inkAlpha))
    // Water takes light along the way, red first, and scatters its own color back.
    // Shallow toward the shore, so the color deepens toward the text and fades into the page.
    const tint = u.tint.max(0).mul(wet, shallow.mul(0.7).add(0.3))
    const transmit = exp(vec3(...look.absorb).mul(tint.mul(-1.6))) as unknown as V3
    const pageLuma = dot(floorRGB, vec3(0.2126, 0.7152, 0.0722))
    const scatter = vec3(...look.scatter).mul(
      mix(0.5, clamp(sqrt(pageLuma).mul(1.1), 0.08, 1), opaqueNode),
    )
    const glow = vec3(...SUN).mul(density.sub(1).max(0).mul(strength))
    const floorLuma = dot(under, vec3(0.2126, 0.7152, 0.0722))
    let rgb: V3 = under
      .mul(light)
      .mul(transmit)
      .add(scatter.mul(transmit.oneMinus()).mul(underA))
      // Dark floors show the caustics as light in the water itself.
      .add(glow.mul(0.035).mul(underA).mul(floorLuma.mul(3).oneMinus().max(0.15))) as V3
    let alpha: F = underA as F
    // Over a picture: a veil of water and the caustics as light of their own.
    const veil = tint.mul(0.3).min(0.6).mul(opaqueNode.oneMinus())
    rgb = rgb.add(scatter.mul(veil).mul(alpha.oneMinus())) as V3
    alpha = alpha.add(veil.mul(alpha.oneMinus())) as F
    const shine = density.sub(1).max(0).mul(strength).mul(0.1).min(0.5).mul(opaqueNode.oneMinus())
    rgb = rgb.mul(shine.oneMinus()).add(vec3(...SUN).mul(shine)) as V3
    alpha = alpha.add(shine.mul(alpha.oneMinus())) as F

    // The frost and the cracks lie on the surface, over the water.
    if (style === 'ice') {
      // Thinner over the letters, so the ink keeps its color through the ice.
      const white = frost.mul(mix(0.7, 0.32, inkAlpha))
      rgb = rgb.mul(white.oneMinus()).add(vec3(...FROST).mul(white)) as V3
      alpha = alpha.add(white.mul(alpha.oneMinus())) as F
      rgb = rgb.mul(crackEdge.mul(0.5).oneMinus()) as V3
      const line = crack.mul(0.95)
      rgb = rgb.mul(line.oneMinus()).add(vec3(0.95, 0.98, 1).mul(line)) as V3
      alpha = alpha.add(line.mul(alpha.oneMinus())) as F
    }

    // The sky in the surface: brighter toward a window over the pool, and the sun's glints, by
    // Fresnel's share at that slant.
    const reflected = reflect(look2, refractNormal) as unknown as V3
    const win = normalize(vec3(-0.46, 0.52, 0.72))
    const sunDir = normalize(vec3(-0.16, 0.2, 0.966))
    const sky = vec3(...look.sky)
    const toWindow = dot(reflected, win)
    // The curl at the shore shows the sky, not the hard edge of the window.
    const env = sky
      .mul(smoothstep(0.55, 1, reflected.z).mul(0.5).add(0.5))
      .add(
        vec3(1, 0.98, 0.95).mul(
          smoothstep(0.86, 0.9, toWindow).mul(look.window).mul(curl.oneMinus()),
        ),
      )
      .add(vec3(1, 0.98, 0.95).mul(exp(toWindow.sub(1).mul(9)).mul(look.window * 0.06)))
    const cosV = clamp(dot(refractNormal, look2.negate()), 0, 1)
    const reflectance = fresnel(cosV, 0.02).mul(wet)
    rgb = rgb.mul(reflectance.oneMinus()).add(env.mul(reflectance)) as V3
    alpha = alpha.add(reflectance.mul(alpha.oneMinus())) as F
    if (look.sun > 0) {
      let sparkle: F = pow(max(dot(reflected, sunDir), 0), 1600).mul(look.sun) as F
      if (style === 'ice') {
        // Frost crystals, each a tiny mirror at its own angle, glitter as the page moves.
        const cell = floor(point.div(2.5)).add(4096)
        const id = cell.x.add(cell.y.mul(8192))
        const facet = normalize(
          normal.add(vec3(hash(id).sub(0.5), hash(id.add(1)).sub(0.5), 0).mul(0.5)),
        )
        const glint = pow(max(dot(reflect(look2, facet), sunDir), 0), 400)
          .mul(smoothstep(0.82, 0.86, hash(id.add(2))))
          .mul(smoothstep(0.6, 0.2, fract(point.div(2.5)).sub(0.5).length()))
        sparkle = sparkle.add(glint.mul(frost).mul(30)) as F
      }
      const lit = sparkle.mul(0.02).min(1)
      rgb = rgb.add(vec3(1, 0.98, 0.92).mul(sparkle.mul(0.02))) as V3
      alpha = alpha.add(lit.mul(alpha.oneMinus())) as F
    }

    const boxUV = vec2(point.x.div(u.size.x), point.y.div(u.size.y).oneMinus())
    const inset = vec2(0.5, 0.5).div(max(u.size as unknown as V2, vec2(1, 1)))
    const mask = walled ? ctx.mask(boxUV) : ctx.mask(clamp(boxUV, inset, inset.oneMinus()))
    // Past the shore only the letters are drawn, as they are.
    const finalAlpha = clamp(alpha, 0, 1).mul(walled ? 1 : max(wet, inkAlpha))
    material.colorNode = vec4(rgb.div(max(alpha, 1e-4)).add(dither()), finalAlpha.mul(mask))

    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.frustumCulled = false
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const pond = new Pond()
    let read = 0
    let fresh = true
    let dirty = false
    /** Clears both targets: still water. */
    const clear = (): void => {
      if (!gpuSim) return
      const renderer = render.renderer
      const before = renderer.getRenderTarget()
      reset.value = 1
      for (let i = 0; i < 2; i++) {
        renderer.setRenderTarget(targets[1 - i] as RenderTarget)
        ;(quads[i] as QuadMesh).render(renderer as never)
      }
      reset.value = 0
      renderer.setRenderTarget(before)
      read = 0
      sim.value = targets[0].texture
    }
    /** Runs `count` steps, each with the drops it takes from the pond. */
    const run = (count: number): void => {
      if (!gpuSim) {
        for (let i = 0; i < count; i++) pond.take()
        return
      }
      if (!count) return
      const renderer = render.renderer
      const before = renderer.getRenderTarget()
      for (let i = 0; i < count; i++) {
        const batch = pond.take()
        for (const [j, drop] of drops.entries()) {
          const d = batch[j]
          ;(drop.value as Vector4).set(
            d?.x ?? 0,
            d?.y ?? 0,
            Math.max(0.5, d?.radius ?? 1),
            d?.strength ?? 0,
          )
        }
        renderer.setRenderTarget(targets[1 - read] as RenderTarget)
        ;(quads[read] as QuadMesh).render(renderer as never)
        read = 1 - read
        // The pointer melts on the first step of a frame only.
        ;(melter.value as Vector4).w = 0
      }
      renderer.setRenderTarget(before)
      sim.value = (targets[read] as RenderTarget).texture
    }

    const resize = (): void => {
      em = emOf(layout as Raster)
      const next = grid(box.width, box.height, em, tier)
      emU.value = em
      if (next.cols !== size.cols || next.rows !== size.rows) {
        size = next
        const old = targets
        targets = [target(), target()]
        for (const t of old) t.dispose()
        for (const q of quads) (q.material as NodeMaterial).dispose()
        ;(quads[0] as QuadMesh).material = step(targets[0].texture)
        ;(quads[1] as QuadMesh).material = step(targets[1].texture)
        ;(cells.value as Vector2).set(size.cols, size.rows)
        pond.clear()
        fresh = true
      }
      ;(cellPx.value as Vector2).set(box.width / size.cols, box.height / size.rows)
      makeIce()
      makeShore()
    }
    // Build again when the text, its fonts or its box change.
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (!next?.quads.length) return
      const old = letters.value as Texture
      letters.value = atlas(next.canvas)
      old.dispose()
      ;(frame.value as Vector4).set(...next.frame)
      layout = next
      measure()
      resize()
      ctx.invalidate()
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void redo(), 150)
    }
    ctx.onDispose(() => clearTimeout(timer))
    const text = new MutationObserver(schedule)
    text.observe(element, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => text.disconnect())
    const sizes = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      if (Math.abs(rect.width - box.width) > 0.5 || Math.abs(rect.height - box.height) > 0.5)
        schedule()
    })
    sizes.observe(element)
    ctx.onDispose(() => sizes.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    /** Box px to cells, y up. */
    const toCells = (x: number, y: number): [number, number] => [
      (x / box.width) * size.cols,
      (1 - y / box.height) * size.rows,
    ]
    const cellOf = (): number => box.width / size.cols

    // A click or a tap drops a stone; on ice it melts a patch first.
    let mouse = false
    let tapped = -1
    const clicks: [number, number][] = []
    addEventListener(
      'pointermove',
      (e) => {
        mouse = e.pointerType !== 'touch'
      },
      { signal, passive: true },
    )
    el.addEventListener(
      'pointerdown',
      (e) => {
        mouse = e.pointerType !== 'touch'
        const rect = element.getBoundingClientRect()
        clicks.push([e.clientX - rect.left, e.clientY - rect.top])
        if (!mouse) tapped = 0
        ctx.invalidate()
      },
      { signal, passive: true },
    )

    let rate = 0
    pacing.set(signal, () => rate)
    let last: [number, number] | undefined
    let rainDue = 0
    let stepDue = 0
    let swellSpeed = 0
    let time = 0
    let melt = 0
    const random = rng(11)
    let shown: boolean | undefined
    const show = (value: boolean): void => {
      if (shown === value) return
      shown = value
      ctx.showDom(value)
    }

    return (input) => {
      const live = ctx.params
      const dt = Math.min(Math.max(input.delta, 0), 0.1)
      const reduced = input.reducedMotion
      const strength = reduced ? 0 : Math.max(0, live.ripples)
      const cell = cellOf()
      if (fresh) {
        fresh = false
        clear()
      }
      if (tapped >= 0) {
        tapped += dt
        if (tapped > TAP) tapped = -1
      }
      const hovered = !reduced && ((mouse && input.over) || tapped >= 0)

      // The pointer drags a wake; on ice it melts the patch under it.
      const at: [number, number] = [
        input.pointer.x * input.width,
        (1 - input.pointer.y) * input.height,
      ]
      if (mouse && input.over && strength > 0) {
        if (style === 'ice') {
          const [cx, cy] = toCells(...at)
          ;(melter.value as Vector4).set(cx, cy, (em * 0.6) / cell, 0.22)
          melt = HOLD
        }
        if (last) {
          const dx = at[0] - last[0]
          const dy = at[1] - last[1]
          const dist = Math.hypot(dx, dy)
          const speed = dist / Math.max(dt, 1 / 120)
          const spacing = cell * 1.3
          const count = Math.min(12, Math.floor(dist / spacing))
          const lift = 0.16 * strength * Math.min(1, Math.max(0.15, speed / (em * 6)))
          for (let i = 1; i <= count; i++) {
            const [cx, cy] = toCells(last[0] + (dx * i) / count, last[1] + (dy * i) / count)
            pond.add({ x: cx, y: cy, radius: 1.9, strength: lift })
          }
          if (count) last = at
        } else last = at
      } else last = undefined
      for (const [x, y] of clicks.splice(0)) {
        if (!strength) continue
        const [cx, cy] = toCells(x, y)
        if (style === 'ice') {
          ;(melter.value as Vector4).set(cx, cy, (em * 0.9) / cell, 0.5)
          melt = HOLD
        }
        pond.add({ x: cx, y: cy, radius: 2.6, strength: -0.9 * strength })
      }

      // Rain: all the time, or while hovered.
      const raining =
        style === 'rain' && !reduced && live.rain > 0 && (trigger === 'loop' || hovered)
      if (raining) {
        rainDue += dt * Math.min(60, live.rain)
        while (rainDue >= 1) {
          rainDue -= 1
          const [cx, cy] = toCells(random() * box.width, random() * box.height)
          pond.add({
            x: cx,
            y: cy,
            radius: 1.7 + random() * 0.6,
            strength: -(0.3 + random() * 0.45),
          })
        }
      } else rainDue = 0

      // The swell moves all the time, or while hovered; it eases to a stop and holds its shape.
      const swellTo = reduced || look.pace === 0 ? 0 : trigger === 'loop' || hovered ? 1 : 0
      swellSpeed = reduced
        ? 0
        : damp(swellSpeed, swellTo, swellTo > swellSpeed ? 0.6 : 0.9, dt, 0.01)
      time += dt * swellSpeed
      clock.value = time

      // The simulation runs while anything moves in it.
      const factor = decay(live.damping)
      keep.value = factor
      const busy = !pond.calm || melt > 0
      if (busy) {
        dirty = true
        stepDue += dt * STEPS
        const steps = Math.min(MAX_STEPS, Math.floor(stepDue))
        stepDue = Math.min(stepDue - steps, 1)
        run(steps)
        pond.settle(factor, steps)
        melt = Math.max(0, melt - (steps * REFREEZE) / STEPS)
      } else {
        stepDue = 0
        if (dirty) {
          dirty = false
          clear()
        }
      }
      if (reduced && dirty) {
        pond.clear()
        melt = 0
        dirty = false
        clear()
      }

      const moving = busy || swellSpeed > 0 || raining
      rate = moving ? FPS : 0
      // Calm, clear and without caustics the copy is the DOM text: hand it back.
      const plain = style !== 'ice' && live.tint <= 0 && live.caustics <= 0
      show(plain && !moving && input.presence >= 1)
    }
  },
})
export default water
