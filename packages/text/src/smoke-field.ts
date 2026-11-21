// The data `smoke` marches through: the glyphs as a coarse field (distance, two blurs and the
// plume that streams up off them) and a tiling 3D noise of billows and swirls. Runs only in the
// smoke chunk.
import { rng } from '@dioramajs/effects/kit'
import {
  Data3DTexture,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
} from 'three/webgpu'
import { emOf } from './points'
import type { Raster } from './raster'
import { blur, coverage, distance } from './sdf'

/** The glyphs as smoke can read them, rows bottom up. */
export interface Field {
  /**
   * Half floats per texel: signed distance to the glyph edge in em (negative inside), the glyphs
   * blurred tight and wide, and the plume, each 0..1.
   */
  readonly data: Uint16Array
  readonly width: number
  readonly height: number
  /** The field in box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  /** Font size, px. */
  readonly em: number
  /** Ink bounds in box px: left, top, right, bottom. */
  readonly bounds: readonly [number, number, number, number]
}

/** Margins of the field around the ink, in em: the plume rises high above it. */
export const MARGIN = { side: 1.6, top: 3.6, bottom: 1.4 } as const
/** Longest side of the field in texels. */
const MAX_FIELD = 1280
/** Blur radii of the tight and wide channels, and the plume's height and width, in em. */
const TIGHT = 0.1
const WIDE = 0.42
const PLUME = { rise: 0.85, near: 0.06, far: 0.34, reach: 0.7 } as const

interface Yielder {
  yield(): Promise<void>
}
/** Milliseconds of work a task may do before it yields to the browser. */
const TASK_BUDGET = 8
let resumed = Number.NEGATIVE_INFINITY

/** Resolves at once while the task is young, otherwise after `scheduler.yield()`. */
function breathe(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Partial<Yielder> }).scheduler
  if (typeof scheduler?.yield !== 'function' || performance.now() - resumed < TASK_BUDGET)
    return Promise.resolve()
  return scheduler.yield().then(() => {
    resumed = performance.now()
  })
}

/** Texels per CSS px: finer for small text, coarser for display sizes, within MAX_FIELD. */
export function fieldScale(em: number, width: number, height: number): number {
  const wanted = Math.min(1, Math.max(0.3, 40 / Math.max(em, 1)))
  return Math.min(wanted, MAX_FIELD / Math.max(width, height, 1))
}

/** Normalizes `values` to a peak of 1, in place. */
function normalize(values: Float32Array): void {
  let peak = 1e-6
  for (const value of values) if (value > peak) peak = value
  for (let i = 0; i < values.length; i++) values[i] = (values[i] as number) / peak
}

/**
 * The plume: each column of `alpha` (w by h, rows top down) smeared upward, fading over `rise`
 * texels, and how far each texel is above the last ink below it.
 */
export function plume(
  alpha: Float32Array,
  w: number,
  h: number,
  rise: number,
): { value: Float32Array; above: Float32Array } {
  const value = new Float32Array(w * h)
  const above = new Float32Array(w * h)
  const keep = Math.exp(-1 / Math.max(rise, 1e-3))
  for (let x = 0; x < w; x++) {
    let smoke = 0
    // -1 until the first ink from below: the air under the letters has no plume to widen.
    let since = -1
    for (let y = h - 1; y >= 0; y--) {
      const i = y * w + x
      const ink = alpha[i] as number
      if (ink > 0.5) since = 0
      else if (since >= 0) since++
      smoke = Math.max(ink, smoke * keep)
      value[i] = smoke
      above[i] = since
    }
  }
  return { value, above }
}

/** Rows of `src` (w by h) blurred with three box passes of about `sigma`, zeros past the ends. */
export function blurRows(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  let current = Float32Array.from(src)
  if (sigma < 0.5) return current
  let next = new Float32Array(current.length)
  const radius = Math.max(1, Math.round(Math.sqrt(sigma * sigma + 1)))
  const weight = 1 / (2 * radius + 1)
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w
      let sum = 0
      for (let x = 0; x < Math.min(radius, w); x++) sum += current[row + x] as number
      for (let x = 0; x < w; x++) {
        if (x + radius < w) sum += current[row + x + radius] as number
        next[row + x] = sum * weight
        if (x - radius >= 0) sum -= current[row + x - radius] as number
      }
    }
    ;[current, next] = [next, current]
  }
  return current
}

/**
 * The plume spread sideways the higher it rises: thin just above the letters, wide `reach`
 * texels up and in the air beside them, never below them.
 */
function widen(
  rising: { value: Float32Array; above: Float32Array },
  w: number,
  h: number,
  near: number,
  far: number,
  reach: number,
): Float32Array {
  const thin = blur(rising.value, w, h, near)
  const wide = blurRows(thin, w, h, far)
  // Air beside the letters is as high above the ink as the lowest letter top in its row.
  const row = new Float32Array(h).fill(-1)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const height = rising.above[y * w + x] as number
      if (height >= 0 && (row[y] as number) < 0) row[y] = height
      else if (height >= 0) row[y] = Math.min(row[y] as number, height)
    }
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) {
    const own = rising.above[i] as number
    const above = own >= 0 ? own : (row[Math.floor(i / w)] as number)
    const spread = Math.min(1, Math.max(0, above) / Math.max(reach, 1))
    out[i] = (thin[i] as number) + ((wide[i] as number) - (thin[i] as number)) * spread
  }
  return out
}

/** Builds the field of a raster; yields to the browser between steps. */
export async function build(raster: Raster): Promise<Field> {
  const em = emOf(raster)
  const [rasterX, rasterY, rasterWidth, rasterHeight] = raster.frame
  const side = MARGIN.side * em
  const frameWidth = rasterWidth + 2 * side
  const frameHeight = rasterHeight + (MARGIN.top + MARGIN.bottom) * em
  const scale = fieldScale(em, frameWidth, frameHeight)
  const width = Math.max(2, Math.ceil(frameWidth * scale))
  const height = Math.max(2, Math.ceil(frameHeight * scale))
  const frame = [rasterX - side, rasterY - MARGIN.top * em, width / scale, height / scale] as const
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    const rasterScale = raster.canvas.width / Math.max(1e-6, rasterWidth)
    ctx.drawImage(
      raster.canvas,
      (rasterX - frame[0]) * scale,
      (rasterY - frame[1]) * scale,
      (raster.canvas.width / rasterScale) * scale,
      (raster.canvas.height / rasterScale) * scale,
    )
  }
  const alpha = coverage(canvas, width, height)
  await breathe()
  const sdf = distance(alpha, width, height)
  await breathe()
  const tight = blur(alpha, width, height, TIGHT * em * scale)
  const wide = blur(alpha, width, height, WIDE * em * scale)
  await breathe()
  const texelsPerEm = em * scale
  const rising = widen(
    plume(alpha, width, height, PLUME.rise * texelsPerEm),
    width,
    height,
    PLUME.near * texelsPerEm,
    PLUME.far * texelsPerEm,
    PLUME.reach * texelsPerEm,
  )
  for (const channel of [tight, wide, rising]) normalize(channel)
  await breathe()
  // The ink bounds, from the coverage.
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if ((alpha[y * width + x] as number) > 0.05) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
  const bounds: [number, number, number, number] =
    right >= left
      ? [
          frame[0] + left / scale,
          frame[1] + top / scale,
          frame[0] + (right + 1) / scale,
          frame[1] + (bottom + 1) / scale,
        ]
      : [rasterX, rasterY, rasterX + rasterWidth, rasterY + rasterHeight]
  const data = new Uint16Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      // Rows bottom up, as the texture reads them.
      const texel = ((height - 1 - y) * width + x) * 4
      const edge = Math.max(-8, Math.min(8, (sdf[i] as number) / texelsPerEm))
      data[texel] = DataUtils.toHalfFloat(edge)
      data[texel + 1] = DataUtils.toHalfFloat(tight[i] as number)
      data[texel + 2] = DataUtils.toHalfFloat(wide[i] as number)
      data[texel + 3] = DataUtils.toHalfFloat(rising[i] as number)
    }
  return { data, width, height, frame, em, bounds }
}

/** The field as a linear half float texture. */
export function fieldTexture(field: Field): DataTexture {
  const map = new DataTexture(field.data, field.width, field.height, RGBAFormat, HalfFloatType)
  map.minFilter = map.magFilter = LinearFilter
  map.generateMipmaps = false
  map.colorSpace = NoColorSpace
  map.needsUpdate = true
  return map
}

/** Side of the 3D noise tile in texels. */
export const NOISE = 32

/**
 * RGBA bytes of a tiling 3D noise cube of `size`: three smooth value noises for the swirl in red,
 * green and blue, and soft billows (inverted cell noise over a value noise) in alpha.
 */
export function bakeNoise(size: number, seed: number): Uint8Array {
  const random = rng(seed * 7919 + 11)
  const texels = size * size * size
  const quintic = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
  /** Value noise with `cells` lattice cells per tile, wrapping. */
  const value = (cells: number): Float32Array => {
    const lattice = Float32Array.from({ length: cells ** 3 }, random)
    const at = (x: number, y: number, z: number): number =>
      lattice[((z % cells) * cells + (y % cells)) * cells + (x % cells)] as number
    const out = new Float32Array(texels)
    const step = cells / size
    for (let z = 0; z < size; z++) {
      const fz = z * step
      const z0 = Math.floor(fz)
      const tz = quintic(fz - z0)
      for (let y = 0; y < size; y++) {
        const fy = y * step
        const y0 = Math.floor(fy)
        const ty = quintic(fy - y0)
        for (let x = 0; x < size; x++) {
          const fx = x * step
          const x0 = Math.floor(fx)
          const tx = quintic(fx - x0)
          const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
          const c00 = lerp(at(x0, y0, z0), at(x0 + 1, y0, z0), tx)
          const c10 = lerp(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx)
          const c01 = lerp(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx)
          const c11 = lerp(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx)
          out[(z * size + y) * size + x] = lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz)
        }
      }
    }
    return out
  }
  /** 1 at random points, falling to 0 a cell away: `cells` cells per tile, wrapping. */
  const cellular = (cells: number): Float32Array => {
    const points = Float32Array.from({ length: cells ** 3 * 3 }, random)
    const out = new Float32Array(texels)
    const unit = size / cells
    const wrap = (v: number): number => ((v % cells) + cells) % cells
    for (let z = 0; z < size; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const px = (x + 0.5) / unit
          const py = (y + 0.5) / unit
          const pz = (z + 0.5) / unit
          const cx = Math.floor(px)
          const cy = Math.floor(py)
          const cz = Math.floor(pz)
          // Squared distance to the nearest point in the 27 cells around.
          let best = 9
          for (let k = -1; k <= 1; k++)
            for (let j = -1; j <= 1; j++)
              for (let i = -1; i <= 1; i++) {
                const ox = cx + i
                const oy = cy + j
                const oz = cz + k
                const cell = ((wrap(oz) * cells + wrap(oy)) * cells + wrap(ox)) * 3
                const dx = ox + (points[cell] as number) - px
                const dy = oy + (points[cell + 1] as number) - py
                const dz = oz + (points[cell + 2] as number) - pz
                const squared = dx * dx + dy * dy + dz * dz
                if (squared < best) best = squared
              }
          out[(z * size + y) * size + x] = Math.max(0, 1 - Math.sqrt(best))
        }
    return out
  }
  const swirl = [0, 1, 2].map(() => {
    const low = value(4)
    const high = value(8)
    return low.map((v, i) => v * 0.68 + (high[i] as number) * 0.32)
  })
  const big = cellular(4)
  const small = cellular(8)
  const soft = value(8)
  const data = new Uint8Array(texels * 4)
  const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255)
  // Spread each swirl channel to the full byte range, so its mean sits at the middle.
  for (const [index, channel] of swirl.entries()) {
    let lo = 1
    let hi = 0
    for (const v of channel) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    for (let i = 0; i < texels; i++)
      data[i * 4 + index] = byte(((channel[i] as number) - lo) / (hi - lo || 1))
  }
  for (let i = 0; i < texels; i++) {
    const billow =
      (big[i] as number) * 0.55 + (small[i] as number) * 0.3 + (soft[i] as number) * 0.3
    data[i * 4 + 3] = byte(billow * 1.05 - 0.05)
  }
  return data
}

/** The noise cube as a linear, wrapping 3D texture. */
export function noiseTexture(seed: number): Data3DTexture {
  const map = new Data3DTexture(bakeNoise(NOISE, seed), NOISE, NOISE, NOISE)
  map.format = RGBAFormat
  map.minFilter = map.magFilter = LinearFilter
  map.wrapS = map.wrapT = map.wrapR = RepeatWrapping
  map.generateMipmaps = false
  map.colorSpace = NoColorSpace
  map.unpackAlignment = 1
  map.needsUpdate = true
  return map
}
