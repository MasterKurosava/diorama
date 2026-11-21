import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, inView, rng } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  attribute,
  clamp,
  dot,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  sqrt,
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
  DynamicDrawUsage,
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
import { blur, coverage, distance, gradient, write } from './sdf'

type Style = 'tube' | 'outline'
type Trigger = 'view' | 'hover' | 'always'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  color: string
  glow: number
  strength: number
  depth: number
  shadow: number
  tilt: number
  flicker: number
  broken: number
  seed: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/** Color of a sign whose text color cannot be read. */
const FALLBACK = '#ff3fa4'
/** Flicker frames a second; the turn-on, the tilt and the light play at full rate. */
const FLICKER_FPS = 30
/** Share of the box in view (above the bottom tenth) before the sign turns on. */
const SHOWN = 0.35
/** Seconds a letter takes to go dark when the pointer leaves. */
const DARKEN = 0.16
/** How fast the light and the tilt follow the pointer, 1/s. */
const FOLLOW = 9
const DEG = Math.PI / 180

// Attribute names become WGSL and GLSL identifiers: no keyword of either has a capital letter
// after the first.
const CORE = 'neonCore'
const HALO = 'neonHalo'
const CELL = 'neonCell'
const LIGHT = 'neonLight'

/** The letters of the sign drawn once: distance field, light atlas and one instance per piece. */
export interface Sign {
  /**
   * Half floats, rows bottom up, per pixel: signed distance to the glyph edge in px (negative
   * inside), the unit direction away from the edge (x right, y down) and 0.
   */
  readonly field: { readonly data: Uint16Array; readonly width: number; readonly height: number }
  /** The field in box px: x, y, width, height. */
  readonly fieldFrame: readonly [number, number, number, number]
  /**
   * Per piece, square-rooted: the tubes blurred tight (bloom and shadow) in red, the light they
   * throw on the wall near them in green and far in blue.
   */
  readonly atlas: HTMLCanvasElement
  /** Per piece, box px: the tube's quad. */
  readonly cores: Float32Array
  /** Per piece, box px: the quad of its light on the wall. */
  readonly halos: Float32Array
  /** Per piece: its cell in the atlas, u0, v top, u1, v bottom. */
  readonly cells: Float32Array
  /** Per piece: its unit in reading order. */
  readonly keys: readonly number[]
  /** Radius of the tube's round section, px: half a stroke, or the outline tube. */
  readonly radius: number
  /** px the bloom reaches past a tube. */
  readonly bloom: number
  /** Largest font size, px. */
  readonly em: number
  /** Glow radius it was built for, px. */
  readonly glow: number
}

const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255)

/** Radius of the outline tube at font size `em`, px. */
export const outlineRadius = (em: number): number => Math.min(9, Math.max(1.25, em * 0.03))

interface Yielder {
  yield(): Promise<void>
}
let resumed = Number.NEGATIVE_INFINITY

/**
 * A point between steps of a build: resolves at once while the task is young, otherwise after
 * `scheduler.yield()`, so the build does not block input as one long task. Without
 * `scheduler.yield` (Safari, test DOMs) it never waits.
 */
function breathe(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Partial<Yielder> }).scheduler
  if (typeof scheduler?.yield !== 'function' || performance.now() - resumed < 8)
    return Promise.resolve()
  return scheduler.yield().then(() => {
    resumed = performance.now()
  })
}

/**
 * Builds the sign from a raster of the text: a distance field of the glyphs with its direction
 * (the tubes' normals come from it), the shape of each piece's tube and its light blurred at three
 * radii into an atlas cell of its own, so every letter lights up alone. Yields to the browser
 * between steps.
 */
export async function build(
  layout: Raster,
  style: Style,
  glowEm: number,
  ratio: number,
): Promise<Sign> {
  const [fx0, fy0, fw0, fh0] = layout.frame
  const em = Math.max(1, ...layout.quads.map((q) => q.em))
  const margin = 2
  // Two field px per CSS px for text up to 100 px, fewer for larger (at least 1.5), half at low
  // quality, at most MAX_SIDE a side.
  const scale = Math.min(
    Math.max(1.5, Math.min(2, 200 / em)) * (ratio / 2),
    MAX_SIDE / Math.max(fw0 + 2 * margin, fh0 + 2 * margin),
  )
  const fieldWidth = Math.max(1, Math.ceil((fw0 + 2 * margin) * scale))
  const fieldHeight = Math.max(1, Math.ceil((fh0 + 2 * margin) * scale))
  const fieldFrame = [fx0 - margin, fy0 - margin, fieldWidth / scale, fieldHeight / scale] as const
  const glyphs = document.createElement('canvas')
  glyphs.width = fieldWidth
  glyphs.height = fieldHeight
  // The raster's own scale, as raster() chose it.
  const rasterScale = layout.canvas.width / Math.max(1e-6, fw0)
  glyphs
    .getContext('2d')
    ?.drawImage(
      layout.canvas,
      margin * scale,
      margin * scale,
      (layout.canvas.width / rasterScale) * scale,
      (layout.canvas.height / rasterScale) * scale,
    )
  const alpha = coverage(glyphs, fieldWidth, fieldHeight)
  await breathe()
  const sdf = distance(alpha, fieldWidth, fieldHeight)
  await breathe()
  // Distance in CSS px; the stroke radius from the mean depth inside (a bar of width 2w has w/2).
  let depthSum = 0
  let inside = 0
  for (let i = 0; i < sdf.length; i++) {
    const distance = (sdf[i] as number) / scale
    sdf[i] = distance
    if ((alpha[i] as number) >= 0.5) {
      depthSum -= distance
      inside++
    }
  }
  const stroke = inside ? (2 * depthSum) / inside : em * 0.06
  const radius = style === 'tube' ? Math.min(em * 0.2, Math.max(0.75, stroke)) : outlineRadius(em)
  // What glows: the glyph, or a tube inside its edge.
  const shape = new Float32Array(fieldWidth * fieldHeight)
  for (let i = 0; i < sdf.length; i++) {
    const distance = sdf[i] as number
    shape[i] =
      style === 'tube'
        ? (alpha[i] as number)
        : Math.min(1, Math.max(0, (radius - Math.abs(distance + radius)) * scale + 0.5))
  }
  const normal = gradient(sdf, fieldWidth, fieldHeight)
  await breathe()
  // Half floats keep the round profile of the tubes smooth where 8 bits would band.
  const data = new Uint16Array(fieldWidth * fieldHeight * 4)
  for (let y = 0; y < fieldHeight; y++)
    for (let x = 0; x < fieldWidth; x++) {
      const i = y * fieldWidth + x
      const texel = ((fieldHeight - 1 - y) * fieldWidth + x) * 4
      data[texel] = DataUtils.toHalfFloat(Math.max(-1e3, Math.min(1e3, sdf[i] as number)))
      data[texel + 1] = DataUtils.toHalfFloat(normal[i * 2] as number)
      data[texel + 2] = DataUtils.toHalfFloat(normal[i * 2 + 1] as number)
    }
  const field = { data, width: fieldWidth, height: fieldHeight }
  await breathe()

  const count = layout.quads.length
  const cores = new Float32Array(Math.max(1, count) * 4)
  const halos = new Float32Array(Math.max(1, count) * 4)
  const cells = new Float32Array(Math.max(1, count) * 4)
  const glow = Math.max(0, glowEm) * em
  // Bloom and shadow, the light on the wall near the tubes, and the wide glow.
  const tight = Math.max(0.6, em * 0.04)
  const near = Math.max(0.8, em * 0.12)
  const wide = Math.max(1, glow * 0.5)
  const extent = Math.ceil(3 * Math.max(wide, near)) + 2
  let haloScale = Math.min(scale, Math.max(0.1, 1.8 / tight))
  const rects = layout.quads.map((q: Quad) => [q.x, q.y, q.width, q.height] as const)
  // Keeps the atlas within 4096 by 2048 px of cells: very long text gets a coarser light.
  const area = (k: number): number =>
    rects.reduce((s, c) => s + (c[2] + 2 * extent) * k * ((c[3] + 2 * extent) * k), 0)
  while (haloScale > 0.05 && area(haloScale) > 4096 * 2048) haloScale *= 0.75
  const blurred: { w: number; h: number; c: Float32Array[] }[] = []
  const peak = [1e-6, 1e-6, 1e-6]
  for (const [i, [x, y, w, h]] of rects.entries()) {
    await breathe()
    cores.set([x, y, w, h], i * 4)
    const cellWidth = Math.ceil((w + 2 * extent) * haloScale) + 2
    const cellHeight = Math.ceil((h + 2 * extent) * haloScale) + 2
    // The cell's first pixel starts one cell px before the light's quad.
    const haloX = x - extent - 1 / haloScale
    const haloY = y - extent - 1 / haloScale
    halos.set([haloX, haloY, cellWidth / haloScale, cellHeight / haloScale], i * 4)
    const cover = new Float32Array(cellWidth * cellHeight)
    const k = (haloScale / scale) ** 2
    const x0 = Math.max(0, Math.floor((x - fieldFrame[0]) * scale))
    const x1 = Math.min(fieldWidth, Math.ceil((x + w - fieldFrame[0]) * scale))
    const y0 = Math.max(0, Math.floor((y - fieldFrame[1]) * scale))
    const y1 = Math.min(fieldHeight, Math.ceil((y + h - fieldFrame[1]) * scale))
    for (let py = y0; py < y1; py++) {
      const boxY = fieldFrame[1] + (py + 0.5) / scale
      if (boxY < y || boxY > y + h) continue
      const cellY = Math.floor((boxY - haloY) * haloScale)
      for (let px = x0; px < x1; px++) {
        const boxX = fieldFrame[0] + (px + 0.5) / scale
        if (boxX < x || boxX > x + w) continue
        const v = shape[py * fieldWidth + px] as number
        if (v > 0) {
          const at = cellY * cellWidth + Math.floor((boxX - haloX) * haloScale)
          cover[at] = (cover[at] as number) + v * k
        }
      }
    }
    const c = [tight, near, wide].map((sigma) =>
      blur(cover, cellWidth, cellHeight, sigma * haloScale),
    )
    c.forEach((channel, j) => {
      for (const v of channel) if (v > (peak[j] as number)) peak[j] = v
    })
    blurred.push({ w: cellWidth, h: cellHeight, c })
  }
  // Cells on shelves, a px apart, at most 2048 px wide.
  const widest = Math.max(1, ...blurred.map((b) => b.w))
  const atlasWidth = Math.max(
    widest,
    Math.min(
      2048,
      blurred.reduce((s, b) => s + b.w + 1, 0),
    ),
  )
  const spots: [number, number][] = []
  let cursorX = 0
  let cursorY = 0
  let shelf = 0
  for (const b of blurred) {
    if (cursorX + b.w > atlasWidth) {
      cursorX = 0
      cursorY += shelf + 1
      shelf = 0
    }
    spots.push([cursorX, cursorY])
    cursorX += b.w + 1
    shelf = Math.max(shelf, b.h)
  }
  const atlasHeight = Math.max(1, cursorY + shelf)
  const atlas = document.createElement('canvas')
  write(atlas, atlasWidth, atlasHeight, (px) => {
    for (let i = 3; i < px.length; i += 4) px[i] = 255
    blurred.forEach((b, i) => {
      const [spotX, spotY] = spots[i] as [number, number]
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w; x++) {
          const at = ((spotY + y) * atlasWidth + spotX + x) * 4
          for (let j = 0; j < 3; j++)
            px[at + j] = byte(
              Math.sqrt(((b.c[j] as Float32Array)[y * b.w + x] as number) / (peak[j] as number)),
            )
        }
    })
  })
  blurred.forEach((b, i) => {
    const [spotX, spotY] = spots[i] as [number, number]
    cells.set(
      [
        spotX / atlasWidth,
        1 - spotY / atlasHeight,
        (spotX + b.w) / atlasWidth,
        1 - (spotY + b.h) / atlasHeight,
      ],
      i * 4,
    )
  })
  return {
    field,
    fieldFrame,
    atlas,
    cores,
    halos,
    cells,
    keys: layout.quads.map((q) => q.order),
    radius,
    bloom: Math.ceil(3 * tight) + 1,
    em,
    glow,
  }
}

/** A uniform random number in [0, 1) for the seed and two counters: the same on every load. */
function chance(seed: number, a: number, b: number): number {
  const base = Math.round(seed) * 73856093
  return rng((base ^ Math.imul(a + 1, 19349663) ^ Math.imul(b + 1, 83492791)) >>> 0)()
}

/**
 * Brightness 0..1 of a tube `t` seconds after its turn to light, and whether it is steady: it
 * stutters on with a few flashes, holds, and warms up to full. `fast` is the short version of a
 * sign switched on by hand.
 */
export function ignite(seed: number, unit: number, time: number, fast: boolean): [number, boolean] {
  if (time < 0) return [0, false]
  const flashes = (fast ? 1 : 2) + Math.floor(chance(seed, unit, 1) * (fast ? 2 : 3))
  // One tube in five struggles before it catches.
  const stubborn = !fast && chance(seed, unit, 2) < 0.2
  let at = 0
  for (let k = 0; k < flashes; k++) {
    const on = (fast ? 0.025 : 0.035) + chance(seed, unit, 10 + k) * (fast ? 0.03 : 0.07)
    const off =
      (fast ? 0.03 : 0.045) +
      chance(seed, unit, 20 + k) * (fast ? 0.05 : 0.11) +
      (stubborn && k === flashes - 1 ? 0.35 : 0)
    if (time < at + on) return [0.45 + 0.5 * chance(seed, unit, 30 + k), false]
    at += on
    if (time < at + off) return [0, false]
    at += off
  }
  const warm = fast ? 0.25 : 0.6
  const k = Math.min(1, (time - at) / warm)
  return [0.72 + 0.28 * k * k * (3 - 2 * k), k >= 1]
}

/** A tube that flickers now and then: steady, a stutter, sometimes dead for a moment. */
interface Stream {
  /** 0 steady, 1 stutter, 2 dead. */
  kind: number
  start: number
  end: number
  /** Count of phases, for the hash. */
  count: number
}

/**
 * Advances a flicker stream to `now` (s). `rate` 0..1 is how restless it is; `broken` streams
 * stutter often and die for a while, the others only buzz now and then.
 */
function advance(
  s: Stream,
  now: number,
  seed: number,
  id: number,
  rate: number,
  broken: boolean,
): void {
  if (now - s.end > 20) {
    s.kind = 0
    s.end = now + chance(seed, id, s.count++) * 2
  }
  while (now >= s.end) {
    const roll = chance(seed, id, s.count++ + 1000)
    s.start = s.end
    if (s.kind !== 0) {
      s.kind = 0
      s.end = s.start + (broken ? 0.4 + 2.6 * roll : ((0.5 + roll) * 1.6) / Math.max(rate, 0.05))
    } else {
      s.kind = broken && chance(seed, id, s.count + 2000) < 0.3 ? 2 : 1
      s.end =
        s.start +
        (broken ? (s.kind === 2 ? 0.3 + 1.6 * roll : 0.25 + 0.9 * roll) : 0.08 + 0.3 * roll)
    }
  }
}

/** Brightness factor of a stream now: 1 when steady. */
function dip(
  s: Stream,
  now: number,
  seed: number,
  id: number,
  rate: number,
  broken: boolean,
): number {
  if (s.kind === 0) return 1
  if (s.kind === 2) return 0.03
  const step = Math.floor((now - s.start) * FLICKER_FPS)
  const roll = chance(seed, id * 64 + (s.count & 63), step + 5000)
  if (broken) return roll < 0.5 ? 0.03 : 0.55 + 0.45 * chance(seed, id, step + 7000)
  if (roll < 0.15 * rate) return 0.15
  return 1 - Math.min(0.85, rate * (0.15 + 0.6 * chance(seed, id, step + 9000)))
}

/** Units that keep flickering: `share` of `count`, at least one, picked by the seed. */
export function brokenUnits(count: number, share: number, seed: number): Set<number> {
  if (share <= 0 || count === 0) return new Set()
  const order = Array.from({ length: count }, (_, i) => i)
  const random = rng(Math.round(seed) * 7 + 3)
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j] as number, order[i] as number]
  }
  return new Set(order.slice(0, Math.max(1, Math.round(Math.min(1, share) * count))))
}

/** sRGB channel 0..255 to linear. */
const linear = (v: number): number => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * Lightness 0..1 of the wall behind the element: the first background color at least half
 * opaque on it or an ancestor, white (the page's default) without one.
 */
export function wallTone(element: Element): number {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)(%?))?/.exec(
      getComputedStyle(at).backgroundColor ?? '',
    )
    if (!match) continue
    const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1)
    if (alpha < 0.5) continue
    const [r, g, b] = [match[1], match[2], match[3]].map((v) => linear(Number(v))) as [
      number,
      number,
      number,
    ]
    return Math.sqrt(0.2126 * r + 0.7152 * g + 0.0722 * b)
  }
  return 1
}

/** Frames a second each phase asks for. */
const pacing = new WeakMap<AbortSignal, () => number>()

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

function canvasTexture(canvas: HTMLCanvasElement, premultiplied: boolean): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = premultiplied
  if (!premultiplied) {
    // Data, not a picture: no mip levels to average distances across the edge.
    map.generateMipmaps = false
    map.minFilter = LinearFilter
    map.magFilter = LinearFilter
  }
  return map
}

function fieldTexture(sign: Sign): DataTexture {
  const { data, width, height } = sign.field
  const map = new DataTexture(data, width, height, RGBAFormat, HalfFloatType)
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.needsUpdate = true
  return map
}

/** One instanced quad per piece, with the brightness of its unit. */
function shape(sign: Sign): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  const count = sign.keys.length
  geometry.setAttribute(CORE, new InstancedBufferAttribute(sign.cores, 4))
  geometry.setAttribute(HALO, new InstancedBufferAttribute(sign.halos, 4))
  geometry.setAttribute(CELL, new InstancedBufferAttribute(sign.cells, 4))
  const light = new InstancedBufferAttribute(new Float32Array(Math.max(1, count)), 1)
  light.setUsage(DynamicDrawUsage)
  geometry.setAttribute(LIGHT, light)
  geometry.instanceCount = count
  return geometry
}

/** Moves `value` toward `goal` by the share of the way `k`, snapping when close. */
const follow = (value: number, goal: number, k: number, snap: number): number =>
  Math.abs(goal - value) < snap ? goal : value + (goal - value) * k

/**
 * A heading becomes a neon sign mounted in front of the wall: round glass tubes in the shape of
 * its letters, lit from inside with a highlight along each, a soft colored light thrown on the
 * wall around them, and their shadow on it. The tubes stutter on one by one as the sign comes
 * into view and buzz now and then; the light that casts the shadow follows the scroll and the
 * pointer, and the sign turns a little toward the pointer. The text stays in the DOM.
 */
const neon: Effect<Params> = defineEffect({
  name: 'neon',
  params: {
    style: oneOf('tube', 'outline'),
    trigger: oneOf('view', 'hover', 'always'),
    color: '',
    glow: 0.5,
    strength: 1,
    depth: 0.12,
    shadow: 0.6,
    tilt: 5,
    flicker: 0.3,
    broken: 0,
    seed: 1,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The light on the wall reaches past the box.
  bleed: 200,
  presence: 'custom',
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const ratio = ctx.quality === 'low' ? 1 : 2
    // The sign draws its own light: a text-shadow on the element (a CSS fallback) is fine.
    const css = unsupported(element)
    const reason = (css === 'text-shadow' ? undefined : css) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`neon: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    const style = params.style
    const trigger = params.trigger
    let sign = await build(layout, style, ctx.params.glow, ratio)
    if (signal.aborted) return

    let hex = colorOf(params.color, element)
    if (!hex && params.color.trim()) {
      if (DEV) app.log.warn(`neon: "${params.color}" is not a color, using the text color`, element)
      hex = colorOf('', element)
    }
    const tint = uniform(new Color(hex ?? FALLBACK))
    const field = uniform(new Vector4(...sign.fieldFrame))
    const frame = uniform(new Vector4(...layout.frame))
    const radius = uniform(sign.radius)
    const bloomPad = uniform(sign.bloom)
    const glowing = uniform(sign.glow > 0.5 ? 1 : 0)
    // Box px from the centre, y up: the light that casts the shadow and the eye. Then how far
    // the tubes stand off the wall, px.
    const lamp = uniform(new Vector3(0, 400, 900))
    const eye = uniform(new Vector3(0, 0, 1000))
    const lift = uniform(10)
    // 0 on a dark wall, 1 on a white one: room light drowns the neon's and shows the shadow.
    const tone = uniform(wallTone(element))

    const corner = positionGeometry.xy.add(0.5)
    const half = u.size.mul(0.5)
    const light = varying(attribute(LIGHT, 'float') as unknown as F)
    const on = clamp(light, 0, 1)
    // Leaving a page the tubes go dark and the glass fades with them.
    const fade = clamp(u.presence.div(0.15), 0, 1)
    const material = (): MeshBasicNodeMaterial =>
      new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })
    // Light past the box is masked at the box edge a pixel in, where the mask is whole.
    const boxMask = (x: F, y: F): F => {
      const at = varying(vec2(x, y)) as unknown as V2
      return ctx.mask(
        vec2(
          clamp(at.x, 1, u.size.x.sub(1)).div(u.size.x),
          clamp(at.y, 1, u.size.y.sub(1)).div(u.size.y).oneMinus(),
        ),
      )
    }

    const textures: { node: { value: Texture }; make: (s: Sign, r: Raster) => Texture }[] = []
    const sample = (make: (s: Sign, r: Raster) => Texture, uv: V2): V4 => {
      const node = texture(make(sign, layout as Raster), uv)
      textures.push({ node: node as unknown as { value: Texture }, make })
      return node as unknown as V4
    }
    const atlas = (s: Sign): Texture => canvasTexture(s.atlas, false)
    const haloQuad = attribute(HALO, 'vec4') as unknown as V4
    const cell = attribute(CELL, 'vec4') as unknown as V4
    /** The atlas UV of a box point in the piece's cell. */
    const cellAt = (x: F, y: F): V2 =>
      vec2(
        mix(cell.x, cell.z, x.sub(haloQuad.x).div(haloQuad.z)),
        mix(cell.y, cell.w, y.sub(haloQuad.y).div(haloQuad.w)),
      )
    const inCell = (uv: V2): V2 => vec2(clamp(uv.x, cell.x, cell.z), clamp(uv.y, cell.w, cell.y))

    // The wall: light thrown by the tubes, near and wide, and the tubes' shadow from the lamp.
    const haloX = haloQuad.x.add(corner.x.mul(haloQuad.z))
    const haloY = haloQuad.y.add(corner.y.oneMinus().mul(haloQuad.w))
    const wall = material()
    wall.positionNode = vec3(haloX.sub(half.x), half.y.sub(haloY), 0)
    const worldX = haloX.sub(half.x)
    const worldY = half.y.sub(haloY)
    // The tube point whose shadow lands here: back along the ray from the lamp, at most 1.6
    // times the stand-off away, so a lamp close by swings the shadow without tearing it off.
    const most = max(lift.mul(1.6), 1e-3)
    const ray = vec2(worldX.sub(lamp.x), worldY.sub(lamp.y)).mul(lift.div(max(lamp.z.sub(lift), 1)))
    const stretch = length(ray)
    const offset = varying(ray.mul(min(float(1), most.div(max(stretch, 1e-4)))))
    const shadowX = haloX.sub(offset.x)
    const shadowY = haloY.add(offset.y)
    const lit = sample(atlas, varying(cellAt(haloX, haloY)))
    const occluder = sample(atlas, inCell(varying(cellAt(shadowX, shadowY))))
    const thrown = lit.g
      .mul(lit.g)
      .mul(0.6)
      .add(lit.b.mul(lit.b).mul(0.5))
      .mul(max(u.strength, 0), light, glowing, mix(1, 0.6, tone))
    // The further the shadow falls from its tube, the softer and fainter it is.
    const soft = varying(clamp(stretch.div(most), 0, 1).mul(0.6))
    const shade = mix(occluder.r.mul(occluder.r), occluder.g.mul(occluder.g).mul(0.7), soft).mul(
      clamp(u.shadow, 0, 1),
      0.9,
    )
    // The shadow darkens the wall and the light on it, so the tubes float clear of both.
    const glowA = clamp(thrown, 0, 1).mul(shade.mul(0.75).oneMinus())
    const wallA = float(1).sub(glowA.oneMinus().mul(shade.oneMinus()))
    wall.colorNode = vec4(
      tint.mul(glowA).div(max(wallA, 1e-4)),
      wallA.add(dither()).clamp(0, 1).mul(fade, boxMask(haloX, haloY)),
    )

    // The bloom around the tubes, in the air in front of the wall.
    const coreQuad = attribute(CORE, 'vec4') as unknown as V4
    const bloomX = coreQuad.x.sub(bloomPad).add(corner.x.mul(coreQuad.z.add(bloomPad.mul(2))))
    const bloomY = coreQuad.y
      .sub(bloomPad)
      .add(corner.y.oneMinus().mul(coreQuad.w.add(bloomPad.mul(2))))
    const bloom = material()
    bloom.positionNode = vec3(bloomX.sub(half.x), half.y.sub(bloomY), 0)
    const near = sample(atlas, varying(cellAt(bloomX, bloomY))).r
    const haze = near.mul(near)
    bloom.colorNode = vec4(
      mix(tint, vec3(1), haze.mul(haze).mul(0.35).mul(on)),
      haze
        .mul(0.8)
        .mul(max(u.strength, 0), light, glowing, mix(1, 0.7, tone))
        .clamp(0, 1)
        .add(dither())
        .clamp(0, 1)
        .mul(fade, boxMask(bloomX, bloomY)),
    )

    // The tubes: round glass, normals from the distance field across each tube. Lit, the gas
    // glows white hot in the middle and saturated at the sides; dark, the glass shows.
    const coreX = coreQuad.x.add(corner.x.mul(coreQuad.z))
    const coreY = coreQuad.y.add(corner.y.oneMinus().mul(coreQuad.w))
    const tube = material()
    tube.positionNode = vec3(coreX.sub(half.x), half.y.sub(coreY), 0)
    const fieldUV = varying(
      vec2(coreX.sub(field.x).div(field.z), coreY.sub(field.y).div(field.w).oneMinus()),
    )
    const fieldSample = sample((s) => fieldTexture(s), fieldUV)
    const distance = fieldSample.r
    const out = vec2(fieldSample.g, fieldSample.b)
    let across: F
    let cover: F
    if (style === 'tube') {
      const rasterUV = varying(
        vec2(coreX.sub(frame.x).div(frame.z), coreY.sub(frame.y).div(frame.w).oneMinus()),
      )
      cover = sample((_, r) => canvasTexture(r.canvas, true), rasterUV).a
      across = clamp(distance.div(radius).add(1), 0, 1)
    } else {
      const off = distance.add(radius)
      cover = clamp(
        radius
          .sub(abs(off))
          .div(max(fwidth(distance), 1e-3))
          .add(0.5),
        0,
        1,
      )
      across = clamp(off.div(radius), -1, 1)
    }
    const normal = normalize(
      vec3(
        out.x.mul(across),
        out.y.negate().mul(across),
        sqrt(max(across.mul(across).oneMinus(), 0)).add(1e-3),
      ),
    )
    const at = varying(vec3(coreX.sub(half.x), half.y.sub(coreY), lift))
    const toLamp = normalize(lamp.sub(at))
    const toEye = normalize(eye.sub(at))
    const diffuse = max(dot(normal, toLamp), 0)
    const gloss = pow(max(dot(normal, normalize(toLamp.add(toEye))), 0), 70)
    const rim = pow(normal.z.oneMinus(), 2)
    const middle = pow(normal.z, 10)
    // Dark, a grey glass with a hint of its color, see-through in the middle.
    const glass = mix(vec3(0.5), tint, 0.4).mul(diffuse.mul(0.4).add(0.18)).add(rim.mul(0.25))
    // Lit, saturated gas with a paler core along the middle of the tube, darker at its sides;
    // in a bright room the core keeps its color.
    const hot = middle.mul(mix(0.2, 0.5, clamp(u.strength, 0, 1)), on, tone.mul(0.7).oneMinus())
    const gas = mix(tint, vec3(1), hot)
      .mul(mix(0.45, 1.05, normal.z))
      .mul(light.clamp(0, 1.2))
    const tubeRGB = mix(glass, gas, on).add(gloss.mul(mix(0.9, 0.45, on)))
    tube.colorNode = vec4(
      tubeRGB as V3,
      cover
        .mul(mix(clamp(rim.mul(0.5).add(gloss).add(0.45), 0, 1), float(1), on))
        .mul(fade, boxMask(coreX, coreY)),
    )

    const group = new Group()
    const sign3d = new Group()
    const geometry = shape(sign)
    const wallMesh = new Mesh(geometry, wall)
    const bloomMesh = new Mesh(geometry, bloom)
    const tubeMesh = new Mesh(geometry, tube)
    for (const mesh of [wallMesh, bloomMesh, tubeMesh]) mesh.frustumCulled = false
    bloomMesh.renderOrder = 1
    tubeMesh.renderOrder = 2
    sign3d.add(bloomMesh, tubeMesh)
    group.add(wallMesh, sign3d)
    ctx.onDispose(() => {
      for (const t of textures) t.node.value.dispose()
    })
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    const use = (next: Raster, made: Sign): void => {
      for (const t of textures) {
        const old = t.node.value
        t.node.value = t.make(made, next)
        old.dispose()
      }
      const old = tubeMesh.geometry
      const geo = shape(made)
      for (const mesh of [wallMesh, bloomMesh, tubeMesh]) mesh.geometry = geo
      old.dispose()
      field.value.set(...made.fieldFrame)
      frame.value.set(...next.frame)
      radius.value = made.radius
      bloomPad.value = made.bloom
      glowing.value = made.glow > 0.5 ? 1 : 0
      tone.value = wallTone(element)
      layout = next
      sign = made
      ctx.invalidate()
    }
    // Build again when the text, its fonts, its width or the glow radius change.
    let timer: ReturnType<typeof setTimeout> | undefined
    let building = false
    const redo = async (): Promise<void> => {
      timer = undefined
      building = true
      try {
        if ((await fonts(element)) || signal.aborted) return
        const next = raster(element, 'letter', ratio)
        if (!next?.quads.length) return
        const made = await build(next, style, ctx.params.glow, ratio)
        if (!signal.aborted) use(next, made)
      } finally {
        building = false
      }
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

    // Hover: the element or the link it sits in lights the sign; a tap toggles it on touch.
    let hovered = false
    if (trigger === 'hover') {
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      const set = (value: boolean): void => {
        if (value === hovered) return
        hovered = value
        ctx.invalidate()
      }
      const opts = { signal }
      target.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && set(true), opts)
      target.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && set(false), opts)
      target.addEventListener(
        'pointerdown',
        (e) => e.pointerType === 'touch' && set(!hovered),
        opts,
      )
      target.addEventListener('focusin', () => set(true), opts)
      target.addEventListener(
        'focusout',
        (e) => {
          if (!target.contains(e.relatedTarget as Element | null)) set(false)
        },
        opts,
      )
    }

    // A mouse near the sign becomes the lamp: the shadow swings away from it, the highlights
    // slide along the tubes and the sign turns toward it.
    let mouse: { x: number; y: number } | undefined
    const box = { x: 0, y: 0, width: 0, height: 0 }
    const around = (height: number): number => Math.max(160, height)
    const nearBox = (x: number, y: number): boolean => {
      const r = around(box.height)
      return (
        x > box.x - r && x < box.x + box.width + r && y > box.y - r && y < box.y + box.height + r
      )
    }
    const point = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      const was = mouse
      mouse = { x: e.clientX, y: e.clientY }
      if (was || nearBox(mouse.x, mouse.y)) ctx.invalidate()
    }
    const gone = (): void => {
      if (!mouse) return
      mouse = undefined
      ctx.invalidate()
    }
    addEventListener('pointermove', point, { passive: true, signal })
    document.documentElement.addEventListener('pointerleave', gone, { signal })
    addEventListener('blur', gone, { signal })

    // Seconds since the sign started to turn on; -1 before.
    let since = -1
    // Hover: seconds since the pointer came or went, and the brightness each unit had then.
    let swap = Number.POSITIVE_INFINITY
    let wasOn = false
    let from = new Float32Array(0)
    let lights = new Float32Array(Math.max(1, layout.units))
    const buzz: Stream = { kind: 0, start: 0, end: 0, count: 0 }
    const streams = new Map<number, Stream>()
    let rate = 0
    let wake: ReturnType<typeof setTimeout> | undefined
    ctx.onDispose(() => clearTimeout(wake))
    pacing.set(signal, () => rate)
    let picked = ''
    let breaking = new Set<number>()
    // Damped: how much the mouse is the lamp, where it is, and the turn of the sign.
    let held = 0
    let pointerX = 0
    let pointerY = 0
    let turnX = 0
    let turnY = 0

    return (input, time) => {
      const live = ctx.params
      if (Math.abs(Math.max(0, live.glow) * sign.em - sign.glow) > 0.5 && !timer && !building)
        schedule()
      const units = Math.max(1, layout?.units ?? 1)
      if (lights.length < units) lights = new Float32Array(units)
      const reduced = input.reducedMotion
      const now = time.now / 1000
      const dt = Math.min(input.delta, 0.1)
      // Tubes switching on or off, or the lamp and the sign moving: full frame rate.
      let busy = false
      // Seconds until a flicker starts or ends by itself, for the timer between them.
      let next = Number.POSITIVE_INFINITY
      const stagger = Math.min(0.11, Math.max(0.035, 1.2 / units))

      if (trigger === 'view' && since < 0) {
        if (inView(input.y, input.height, stage.height.peek(), SHOWN)) since = 0
      } else if (trigger === 'view') since += dt
      if (trigger === 'hover') {
        if (hovered !== wasOn) {
          wasOn = hovered
          swap = 0
          from = lights.slice(0, units)
        } else swap += dt
      }

      const flick = reduced ? 0 : Math.min(1, Math.max(0, live.flicker))
      const share = reduced ? 0 : Math.min(1, Math.max(0, live.broken))
      const key = `${units} ${share} ${live.seed}`
      if (key !== picked) {
        picked = key
        breaking = brokenUnits(units, share, live.seed)
      }
      if (flick > 0) advance(buzz, now, live.seed, 999, flick, false)
      // The buzz dims the whole sign or, now and then, one tube.
      const target = Math.floor(chance(live.seed, buzz.count, 77) * (units + 1)) - 1
      let anyLit = false
      let flickering = false
      for (let i = 0; i < units; i++) {
        let brightness = 1
        if (!reduced && trigger === 'view') {
          const start = 0.1 + i * stagger * (0.7 + 0.6 * chance(live.seed, i, 3))
          const [value, steady] = since < 0 ? [0, true] : ignite(live.seed, i, since - start, false)
          brightness = value
          busy ||= !steady
        } else if (!reduced && trigger === 'hover') {
          if (hovered) {
            const start = i * 0.018 + chance(live.seed, i, 4) * 0.03
            const [value, steady] = ignite(live.seed, i, swap - start, true)
            brightness = value
            busy ||= !steady
          } else {
            const k = Math.min(1, swap / DARKEN)
            brightness = (from[i] ?? 0) * (1 - k) * (1 - k)
            busy ||= k < 1
          }
        } else if (reduced && trigger === 'hover') brightness = hovered ? 1 : 0
        if (brightness > 0.5) anyLit = true
        if (brightness > 0 && flick > 0 && (target < 0 || target === i))
          brightness *= dip(buzz, now, live.seed, 999, flick, false)
        if (brightness > 0 && breaking.has(i)) {
          let stream = streams.get(i)
          if (!stream) {
            stream = { kind: 0, start: now, end: now + chance(live.seed, i, 5) * 1.5, count: 0 }
            streams.set(i, stream)
          }
          advance(stream, now, live.seed, i, 1, true)
          brightness *= dip(stream, now, live.seed, i, 1, true)
          flickering ||= stream.kind === 1
          next = Math.min(next, stream.end - now)
        }
        // Leaving a page the tubes go dark from the last one; entering they light in order.
        if (input.presence < 1 && input.presence <= 0.15 + (0.7 * i) / Math.max(1, units - 1))
          brightness = 0
        lights[i] = brightness
      }
      if (anyLit && flick > 0) {
        flickering ||= buzz.kind !== 0
        next = Math.min(next, buzz.end - now)
      }

      const attr = tubeMesh.geometry.getAttribute(LIGHT) as InstancedBufferAttribute
      const values = attr.array as Float32Array
      let changed = false
      sign.keys.forEach((k, i) => {
        const light = lights[k] ?? 0
        if (values[i] !== light) {
          values[i] = light
          changed = true
        }
      })
      if (changed) attr.needsUpdate = true

      // The lamp: a room light above the top of the viewport, so the shadow moves with the
      // scroll, or the mouse near the sign. Under reduced motion the sign hangs mid-viewport.
      const viewportWidth = stage.width.peek()
      const viewport = stage.height.peek()
      box.x = input.x
      box.y = input.y
      box.width = input.width
      box.height = input.height
      const ccx = reduced ? viewportWidth / 2 : input.x + input.width / 2
      const ccy = reduced ? viewport / 2 : input.y + input.height / 2
      const k = 1 - Math.exp(-dt * FOLLOW)
      const want = !reduced && mouse && nearBox(mouse.x, mouse.y) ? 1 : 0
      if (want && mouse) {
        if (held === 0) {
          pointerX = mouse.x
          pointerY = mouse.y
        }
        pointerX = follow(pointerX, mouse.x, k, 0.5)
        pointerY = follow(pointerY, mouse.y, k, 0.5)
      }
      held = follow(held, want, k, 0.002)
      const depth = Math.max(0, live.depth) * sign.em
      const hang = Math.max(360, input.height * 2.5)
      const mix3 = (room: number, hand: number): number => room + (hand - room) * held
      lamp.value.set(
        mix3(viewportWidth * 0.42 - ccx, pointerX - ccx),
        mix3(ccy + viewport * 0.35, ccy - pointerY),
        mix3(viewport * 1.3, hang + depth),
      )
      eye.value.set(
        viewportWidth / 2 - ccx,
        ccy - viewport / 2,
        ctx.render.camera?.position.z ?? 1000,
      )
      // The sign turns toward the mouse around its middle, at most `tilt` degrees and never so
      // far that an end stands off the wall more than twice as far as the middle.
      const reach = around(input.height)
      const aimX = Math.max(-1, Math.min(1, (pointerX - ccx) / (input.width / 2 + reach)))
      const aimY = Math.max(-1, Math.min(1, (ccy - pointerY) / (input.height / 2 + reach)))
      const most = (size: number): number =>
        Math.min(
          Math.max(0, live.tilt) * DEG,
          Math.asin(Math.min(1, (2 * depth) / Math.max(1, size / 2))),
        )
      const goalX = -aimY * most(input.height) * held
      const goalY = aimX * most(input.width) * held
      turnX = follow(turnX, goalX, k, 1e-4)
      turnY = follow(turnY, goalY, k, 1e-4)
      sign3d.position.z = depth
      sign3d.rotation.set(turnX, turnY, 0)
      lift.value = depth
      busy ||= held !== want || turnX !== goalX || turnY !== goalY
      busy ||= !!(want && mouse && (pointerX !== mouse.x || pointerY !== mouse.y))

      rate = reduced ? 0 : busy ? 60 : flickering ? FLICKER_FPS : 0
      clearTimeout(wake)
      wake = undefined
      // Between flickers nothing moves: a timer wakes the sign for the next one.
      if (!rate && !reduced && Number.isFinite(next))
        wake = setTimeout(() => ctx.invalidate(), Math.max(0, next * 1000))
    }
  },
})
export default neon
