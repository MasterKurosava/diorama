// Helpers for effect modules and site effects: a seeded random, tiling noise, dither, texture
// limits, motion (damping, easing, the pointer, scroll and view progress), switch lists, CSS
// colours, OKLab and shader pieces. Lazy chunks only, never a light entry.
import { cssColor } from '@dioramajs/render'
import {
  abs,
  cos,
  length,
  mat3,
  max,
  min,
  pow,
  screenCoordinate,
  select,
  sin,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DataTexture,
  LinearFilter,
  Matrix3,
  NoColorSpace,
  type Node,
  RepeatWrapping,
  type Texture,
} from 'three/webgpu'
import type { EffectContext, EffectInput } from './types'

/**
 * True in development builds (`import.meta.env.DEV` under Vite, otherwise `NODE_ENV`). Wrap
 * dev-only notes in it so production bundles drop them. One flag for every effect module, so a
 * test can switch it by mocking `@dioramajs/core/dev`.
 */
export { DEV } from '@dioramajs/core/dev'

/** mulberry32: the same sequence for the same seed on every load and backend. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** Options of `noise`. */
export interface NoiseOptions {
  /** Tile size in texels. Default 64. */
  readonly size?: 64 | 128 | 256
  /** Default 1. */
  readonly seed?: number
  /** Independent noise channels; the rest repeat the first. Default 1. */
  readonly channels?: 1 | 2 | 4
}

interface SharedNoise {
  readonly texture: DataTexture
  refs: number
}
/** Noise tiles per renderer, by size, seed and channels. */
const noiseTiles = new WeakMap<object, Map<string, SharedNoise>>()
/** Octaves summed into a noise tile. */
const OCTAVES = 4

/** One octave of value noise on a lattice of `cells` that wraps at the tile edge. */
function octave(out: Float32Array, size: number, cells: number, random: () => number): void {
  const lattice = Float32Array.from({ length: cells * cells }, random)
  const at = (x: number, y: number): number =>
    lattice[((y % cells) * cells + (x % cells)) | 0] as number
  const smooth = (t: number): number => t * t * (3 - 2 * t)
  const step = cells / size
  for (let y = 0; y < size; y++) {
    const fy = y * step
    const y0 = Math.floor(fy)
    const ty = smooth(fy - y0)
    for (let x = 0; x < size; x++) {
      const fx = x * step
      const x0 = Math.floor(fx)
      const tx = smooth(fx - x0)
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx
      out[y * size + x] = (out[y * size + x] as number) + top + (bottom - top) * ty
    }
  }
}

/** RGBA bytes of a tiling noise tile: four octaves, each channel its own stream of the seed. */
function bake(size: number, seed: number, channels: number): Uint8Array {
  const texels = size * size
  const data = new Uint8Array(texels * 4)
  const random = rng(seed)
  for (let channel = 0; channel < 4; channel++) {
    if (channel >= channels) {
      for (let i = 0; i < texels; i++) data[i * 4 + channel] = data[i * 4] as number
      continue
    }
    const sum = new Float32Array(texels)
    let weight = 0
    for (let index = 0, amplitude = 1; index < OCTAVES; index++, amplitude /= 2) {
      const layer = new Float32Array(texels)
      octave(layer, size, 4 << index, random)
      for (let i = 0; i < texels; i++)
        sum[i] = (sum[i] as number) + (layer[i] as number) * amplitude
      weight += amplitude
    }
    for (let i = 0; i < texels; i++) {
      data[i * 4 + channel] = Math.round(((sum[i] as number) / weight) * 255)
    }
  }
  return data
}

/**
 * Tiling value noise, baked on the CPU, linear, RepeatWrapping. Shared per renderer and options
 * with a reference count tied to `ctx`: never dispose it.
 */
export function noise(
  ctx: Pick<EffectContext, 'render' | 'onDispose'>,
  options: NoiseOptions = {},
): Texture {
  const { size = 64, seed = 1, channels = 1 } = options
  const owner = ctx.render.renderer
  let cache = noiseTiles.get(owner)
  if (!cache) {
    cache = new Map()
    noiseTiles.set(owner, cache)
  }
  const key = `${size}:${seed}:${channels}`
  let entry = cache.get(key)
  if (!entry) {
    const texture = new DataTexture(bake(size, seed, channels), size, size)
    texture.wrapS = texture.wrapT = RepeatWrapping
    texture.magFilter = texture.minFilter = LinearFilter
    texture.colorSpace = NoColorSpace
    texture.needsUpdate = true
    entry = { texture, refs: 0 }
    cache.set(key, entry)
  }
  const held = entry
  held.refs++
  ctx.onDispose(() => {
    if (--held.refs > 0) return
    cache.delete(key)
    held.texture.dispose()
  })
  return held.texture
}

/**
 * ±0.5/255 from the integer hash of the screen pixel, against banding in gradients. With `rgb`,
 * ±0.5/255 after the sRGB encoding of that linear colour: the dither scaled by the slope of the
 * decoding curve there, so dark gradients get as much as light ones. Add it to the colour.
 */
export function dither(): Node<'float'>
export function dither(rgb: Node<'vec3'>): Node<'vec3'>
export function dither(rgb?: Node<'vec3'>): Node<'float'> | Node<'vec3'> {
  // PCG as in three's `hash`, inlined so no sine is involved and the graph is visible.
  const seed = uint(screenCoordinate.x).add(uint(screenCoordinate.y).mul(8192))
  const state = seed.mul(747796405).add(2891336453)
  const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737)
  const unit = word
    .shiftRight(22)
    .bitXor(word)
    .toFloat()
    .mul(1 / 2 ** 32)
  const value = unit.sub(0.5).div(255)
  if (!rgb) return value as unknown as Node<'float'>
  // A fit of the slope of the sRGB decoding curve, never under its linear toe.
  return value.mul(max(rgb.pow(0.5833).mul(2.275), vec3(1 / 12.92))) as unknown as Node<'vec3'>
}

/** The parts of three's backends `maxTextureSize` reads. */
interface Backends {
  readonly device?: { readonly limits?: { readonly maxTextureDimension2D?: number } }
  readonly gl?: { getParameter(name: number): unknown }
}
/** `WebGL2RenderingContext.MAX_TEXTURE_SIZE`. */
const MAX_TEXTURE_SIZE = 0x0d33
/** The side assumed when the backend says nothing. */
const FALLBACK_TEXTURE_SIZE = 4096

/**
 * Largest 2D texture side the device takes: the WebGPU device limit (8192 for three r187, which
 * asks for default limits), WebGL 2 `MAX_TEXTURE_SIZE`, else 4096. Caps decodes of big pictures.
 */
export function maxTextureSize(ctx: Pick<EffectContext, 'render'>): number {
  const backend = (ctx.render.renderer as unknown as { backend?: Backends }).backend
  const size =
    backend?.device?.limits?.maxTextureDimension2D ?? backend?.gl?.getParameter(MAX_TEXTURE_SIZE)
  return typeof size === 'number' && size > 0 ? size : FALLBACK_TEXTURE_SIZE
}

/**
 * Exponential approach, frame-rate independent: `seconds` is the time to cover ~63%, 0 jumps.
 * Within `near` of the target it lands there, so a caller can tell when it has settled. Without
 * `near` it lands only when floating point reaches the target, seconds later: to stop drawing
 * once it settles, pass a step too small to see, such as 0.5 for px or 1e-3 for a 0..1 value.
 */
export function damp(
  current: number,
  target: number,
  seconds: number,
  delta: number,
  near = 0,
): number {
  if (seconds <= 0) return target
  const next = target + (current - target) * Math.exp(-delta / seconds)
  return Math.abs(next - target) < near ? target : next
}

/**
 * Moves `at` towards `aim` with `damp` on both axes and lands on it once within `near` (a
 * distance), like `damp`'s own `near`. Returns whether it is still on its way, which an update
 * can return to keep frames coming. `seconds` 0 jumps.
 */
export function chase(
  at: { x: number; y: number },
  aim: { readonly x: number; readonly y: number },
  seconds: number,
  delta: number,
  near = 0,
): boolean {
  at.x = damp(at.x, aim.x, seconds, delta)
  at.y = damp(at.y, aim.y, seconds, delta)
  if (Math.hypot(at.x - aim.x, at.y - aim.y) > near) return true
  at.x = aim.x
  at.y = aim.y
  return false
}

/** Moves `current` towards `target` by at most `step`: a linear fade, `delta / seconds` a frame. */
export function approach(current: number, target: number, step: number): number {
  return target > current ? Math.min(target, current + step) : Math.max(target, current - step)
}

/** Easing curves on 0..1, clamped. */
export function ease(curve: 'expoOut' | 'quartOut' | 'cubicInOut', t: number): number {
  const x = Math.min(1, Math.max(0, t))
  if (curve === 'expoOut') return x === 1 ? 1 : 1 - 2 ** (-10 * x)
  if (curve === 'quartOut') return 1 - (1 - x) ** 4
  return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2
}

/**
 * Reads a switch list param such as `close="esc backdrop swipe"`: the known names it holds,
 * in any order, separated by spaces or commas. `'all'` or `'*'` turns on all of them, an empty
 * string none. Unknown names are left out and returned, so the effect can note them once.
 */
export function flags<const T extends string>(
  value: string,
  known: readonly T[],
): { readonly on: ReadonlySet<T>; readonly unknown: readonly string[] } {
  const words = value.split(/[\s,]+/).filter(Boolean)
  if (words.some((word) => word === 'all' || word === '*')) {
    return { on: new Set(known), unknown: [] }
  }
  const on = new Set<T>()
  const unknown: string[] = []
  for (const word of words) {
    if ((known as readonly string[]).includes(word)) on.add(word as T)
    else unknown.push(word)
  }
  return { on, unknown }
}

/** Where `value` is between `start` and `end`, 0..1: a step at `start` when `end` is not past it. */
export function between(value: number, start: number, end: number): number {
  if (end > start) return Math.min(1, Math.max(0, (value - start) / (end - start)))
  return value < start ? 0 : 1
}

/** Share of the viewport above the line that counts as looked at. */
const VIEW_LINE = 0.9

/**
 * Whether `share` 0..1 of a box is in view, counted above the bottom tenth of the viewport: a
 * box peeking in at the edge has not been looked at yet. `top` and `height` are the box's in
 * viewport px (`input.y`, `input.height`), `viewport` the viewport height. An empty box never is.
 */
export function inView(top: number, height: number, viewport: number, share: number): boolean {
  const line = viewport * VIEW_LINE
  const shown = Math.min(top + height, line) - Math.max(top, 0)
  return height > 0 && shown / Math.min(height, line) >= share
}

/**
 * Scroll progress of a box coming into view, 0..1: 0 while less than `share` of it shows, 1 once
 * it is centred in the viewport. `progress` is `input.progress`, `height` the box height and
 * `viewport` the viewport height in px.
 */
export function entering(
  progress: number,
  height: number,
  viewport: number,
  share: number,
): number {
  const from = (share * height) / (viewport + height || 1)
  return Math.min(1, Math.max(0, (progress - from) / (0.5 - from || 1)))
}

/** Callbacks of `follow`. Each gets the pointer event; the pointer is already updated. */
export interface FollowHandlers {
  /** A mouse or pen came over the element, or a finger pressed on it. */
  readonly enter?: (event: PointerEvent) => void
  /** It moved while over the element or pressed on it. */
  readonly move?: (event: PointerEvent) => void
  /** It left the element, or the finger lifted or went to a scroll (`pointercancel`). */
  readonly leave?: (event: PointerEvent) => void
}

/** The box `toBox` measures from: its left and top edges in client px and its height. */
export type ClientBox = Pick<EffectInput, 'x' | 'y' | 'height'>

/** The pointer `follow` tracks. Live: read it in the update. */
export interface FollowedPointer {
  /** A mouse or pen is over the element, or a finger is pressed on it. */
  readonly over: boolean
  /** Its last position in client px, like `event.clientX`. Kept after it leaves. */
  readonly x: number
  /** Its last position in client px, like `event.clientY`. Kept after it leaves. */
  readonly y: number
  /**
   * Its last position in px of `box` with y up, as `toBox` gives it: pass `input` in the update,
   * so a still pointer keeps its place on the page while it scrolls. The same object every call.
   */
  box(box: ClientBox): { readonly x: number; readonly y: number }
}

/**
 * A point in client px, such as an event's `clientX` and `clientY`, in px of `box` from its
 * bottom left: the units of the shader's `box` times `u.size`. Pass `input` as the box in the
 * update, since the page may scroll under a still pointer. Writes into `out` when given.
 */
export function toBox(
  point: { readonly x: number; readonly y: number },
  box: ClientBox,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  out.x = point.x - box.x
  out.y = box.height - (point.y - box.y)
  return out
}

/**
 * Follows the pointer the way a light or a brush on an element wants it: a mouse or pen while it
 * is over the element, the first finger while it is pressed on it. Touch never blocks the page's
 * scroll: the browser takes the finger with `pointercancel` when one starts. Each change asks
 * for a frame. Listeners go with `ctx.signal`. Returns the live pointer; `on` adds callbacks.
 */
export function follow(
  ctx: Pick<EffectContext, 'element' | 'signal' | 'invalidate'>,
  on: FollowHandlers = {},
): FollowedPointer {
  const { element, signal } = ctx
  let finger = -1
  const inBox = { x: 0, y: 0 }
  const pointer = {
    over: false,
    x: 0,
    y: 0,
    box: (box: ClientBox) => toBox(pointer, box, inBox),
  }
  const listen = (type: string, handler: (event: PointerEvent) => void): void =>
    element.addEventListener(type, handler as EventListener, { signal })
  const moved = (event: PointerEvent, handler?: (event: PointerEvent) => void): void => {
    pointer.x = event.clientX
    pointer.y = event.clientY
    ctx.invalidate()
    handler?.(event)
  }
  const enter = (event: PointerEvent): void => {
    if (pointer.over) moved(event, on.move)
    else {
      pointer.over = true
      moved(event, on.enter)
    }
  }
  const leave = (event: PointerEvent): void => {
    pointer.over = false
    finger = -1
    ctx.invalidate()
    on.leave?.(event)
  }
  listen('pointerenter', (event) => {
    if (event.pointerType !== 'touch') enter(event)
  })
  listen('pointermove', (event) => {
    if (event.pointerType !== 'touch') enter(event)
    else if (event.pointerId === finger) moved(event, on.move)
  })
  listen('pointerleave', (event) => {
    if (event.pointerType !== 'touch') leave(event)
  })
  listen('pointerdown', (event) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return
    finger = event.pointerId
    enter(event)
  })
  const lift = (event: PointerEvent): void => {
    if (event.pointerId === finger) leave(event)
  }
  listen('pointerup', lift)
  listen('pointercancel', lift)
  return pointer
}

/** The words of a CSS colour list: spaces and commas apart, outside parentheses. */
function words(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let word = ''
  for (const char of text) {
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (!depth && (char === ',' || /\s/.test(char))) {
      if (word) out.push(word)
      word = ''
    } else word += char
  }
  if (word) out.push(word)
  return out
}

/**
 * The colours of a list as `#rrggbb`, such as a brand palette in a param: any CSS colour,
 * `var(--brand)` (its value or fallback, followed 8 levels deep) and `currentColor` read from the
 * element's computed style, as `cssColor` of `@dioramajs/render` reads them. Spaces and commas
 * outside parentheses separate the colours; words that are no colour are left out. Read at the
 * call: a later change of a variable shows when the effect reads the list again.
 */
export function palette(text: string, element: Element): string[] {
  return words(text).flatMap((word) => {
    const hex = cssColor(word, element)
    return hex ? [hex] : []
  })
}

/** A colour in OKLab: lightness, a, b. */
export type Oklab = [lightness: number, a: number, b: number]

/**
 * OKLab (Björn Ottosson) of a linear sRGB colour, three's working space. Mixed in OKLab, two
 * colours meet through a clean middle instead of a muddy grey.
 */
export function toOklab(color: Color): Oklab {
  const { r, g, b } = color
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** Linear sRGB of an OKLab colour into `out`, clamped to the gamut. */
export function fromOklab(lab: Readonly<Oklab>, out: Color = new Color()): Color {
  const [L, a, b] = lab
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const unit = (value: number): number => Math.min(1, Math.max(0, value))
  return out.setRGB(
    unit(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    unit(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    unit(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  )
}

/** `a` and `b` mixed in OKLab by `t` 0..1, into `out`. */
export function mixOklab(a: Color, b: Color, t: number, out: Color = new Color()): Color {
  const from = toOklab(a)
  const to = toOklab(b)
  return fromOklab(
    [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ],
    out,
  )
}

/** The inverse of a 3×3 matrix written as rows. */
const inverse = (rows: number[]): Matrix3 => new Matrix3().fromArray(rows).transpose().invert()

/** `fromOklab` in a shader: linear sRGB of an OKLab colour, clamped to the gamut. */
export function oklabToLinear(lab: Node<'vec3'>): Node<'vec3'> {
  // The exact inverses of the two matrices of `toOklab`.
  const toCone = inverse([
    0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099,
    0.0259040371, 0.7827717662, -0.808675766,
  ])
  const toRgb = inverse([
    0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566,
    0.0883024619, 0.2817188376, 0.6299787005,
  ])
  const cone = mat3(toCone).mul(lab)
  return mat3(toRgb).mul(cone.mul(cone).mul(cone)).clamp(0, 1) as unknown as Node<'vec3'>
}

/**
 * The corner radii of an element in px as CSS draws them: top left, top right, bottom right,
 * bottom left. A `%` counts against the shorter side of the `width` × `height` box, and no corner
 * takes more than half of that side, so `999px` draws a pill.
 */
export function radii(
  element: Element,
  width: number,
  height: number,
): [number, number, number, number] {
  const style = getComputedStyle(element)
  const shorter = Math.min(width, height)
  const px = (value: string): number => {
    const first = (value ?? '').trim().split(/\s+/)[0] ?? ''
    const number = Number.parseFloat(first) || 0
    const radius = first.endsWith('%') ? (number / 100) * shorter : number
    return Math.max(0, Math.min(shorter / 2, radius))
  }
  return [
    px(style.borderTopLeftRadius),
    px(style.borderTopRightRadius),
    px(style.borderBottomRightRadius),
    px(style.borderBottomLeftRadius),
  ]
}

/**
 * Signed distance in px from a rounded box, negative inside: `point` from the box centre, `half`
 * its half size, `radius` its corners. `clamp(0.5 - d, 0, 1)` is a 1 px antialiased mask.
 */
export function roundedBox(
  point: Node<'vec2'>,
  half: Node<'vec2'>,
  radius: Node<'float'> | number,
): Node<'float'> {
  const corner = abs(point).sub(half).add(radius)
  return length(max(corner, 0))
    .add(min(max(corner.x, corner.y), 0))
    .sub(radius) as unknown as Node<'float'>
}

/**
 * The radius of the corner `point` is nearest to, for `point` from the box centre with y up and
 * `corners` the four radii of `radii` (top left, top right, bottom right, bottom left), for a
 * `roundedBox` with corners that differ.
 */
export function cornerRadius(point: Node<'vec2'>, corners: Node<'vec4'>): Node<'float'> {
  return select(
    point.x.lessThan(0),
    select(point.y.greaterThan(0), corners.x, corners.w),
    select(point.y.greaterThan(0), corners.y, corners.z),
  ) as unknown as Node<'float'>
}

/** The golden angle: taps this far apart cover a disc evenly. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/**
 * A soft blur: the mean of `taps` reads on a golden-angle spiral over the disc of `radius` (in
 * the units of `uv`) around `uv`. `turn` rotates the spiral; turned per pixel, the taps read as
 * grain instead of ghost copies. One tap reads `uv` itself.
 */
export function spiralBlur(
  read: (uv: Node<'vec2'>) => Node<'vec4'>,
  uv: Node<'vec2'>,
  radius: Node<'vec2'>,
  taps: number,
  turn?: Node<'float'>,
): Node<'vec4'> {
  let sum = vec4(0) as unknown as Node<'vec4'>
  for (let i = 0; i < taps; i++) {
    const r = taps > 1 ? Math.sqrt((i + 0.5) / taps) : 0
    let offset: Node<'vec2'>
    if (turn) {
      const angle = turn.add(i * GOLDEN)
      offset = vec2(cos(angle).mul(r), sin(angle).mul(r)) as unknown as Node<'vec2'>
    } else {
      const angle = i * GOLDEN
      offset = vec2(Math.cos(angle) * r, Math.sin(angle) * r) as unknown as Node<'vec2'>
    }
    sum = sum.add(read(uv.add(radius.mul(offset)) as unknown as Node<'vec2'>)) as Node<'vec4'>
  }
  return sum.div(taps) as unknown as Node<'vec4'>
}

/**
 * Schlick's Fresnel: the share of light a surface reflects at `cosine` between its normal and
 * the view, `f0` head-on (0.04 for glass and plastic, 0.02 for water). Edges catch more light.
 */
export function fresnel(cosine: Node<'float'>, f0: number): Node<'float'> {
  return pow(cosine.oneMinus(), 5)
    .mul(1 - f0)
    .add(f0) as unknown as Node<'float'>
}
