// The letters of a raster as a bevelled surface: height and slope from the distance to the glyph
// edge, for effects that light text as a material.
import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat } from 'three/webgpu'
import { MAX_SIDE, type Raster } from './raster'
import { blur, coverage, distance } from './sdf'

/** The surface of the glyphs over the raster's frame and a margin around it. */
export interface Relief {
  /**
   * Per texel, half floats: the slope of the surface along x and y (px of height per px, y down),
   * the height 0..1 of the bevel, and the signed distance to the glyph edge in px, positive inside.
   */
  readonly data: Uint16Array
  readonly width: number
  readonly height: number
  /** The field in box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
}

/** Height 0..1 of a rounded bevel `t` of its width in from the edge: a quarter circle. */
export const profile = (t: number): number => {
  const inset = Math.min(1, Math.max(0, t))
  return Math.sqrt(inset * (2 - inset))
}

/**
 * Builds the surface: a quarter-round bevel `bevel` px wide along every glyph edge (0 for flat
 * letters), softened a little so the ridge where two bevels meet is round, with `margin` px of
 * field around the raster for light and shadow cast beside the letters.
 */
export function relief(raster: Raster, bevel: number, margin: number, ratio: number): Relief {
  const [frameX, frameY, frameWidth, frameHeight] = raster.frame
  const pad = Math.max(0, Math.ceil(margin))
  // Texels per box px: about ten across the bevel, at most two per CSS px and MAX_SIDE a side.
  const scale = Math.min(
    2,
    ratio,
    Math.max(1, 10 / Math.max(bevel, 1e-3)),
    MAX_SIDE / Math.max(frameWidth + 2 * pad, frameHeight + 2 * pad),
  )
  const width = Math.max(1, Math.ceil((frameWidth + 2 * pad) * scale))
  const height = Math.max(1, Math.ceil((frameHeight + 2 * pad) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // The raster's own scale, as raster() chose it.
  const rasterScale = Math.min(ratio, MAX_SIDE / Math.max(frameWidth, frameHeight))
  canvas
    .getContext('2d')
    ?.drawImage(
      raster.canvas,
      pad * scale,
      pad * scale,
      (raster.canvas.width / rasterScale) * scale,
      (raster.canvas.height / rasterScale) * scale,
    )
  // In texels, negative inside.
  const field = distance(coverage(canvas, width, height), width, height)
  const bevelTexels = Math.max(0, bevel) * scale
  // Under half a texel the bevel is flat: the letters are a plateau.
  const bevelled = bevelTexels > 0.5
  const lift = new Float32Array(width * height)
  for (let i = 0; i < lift.length; i++) {
    const inside = -(field[i] as number)
    lift[i] = bevelled ? profile(inside / bevelTexels) : inside > 0 ? 1 : 0
  }
  const smooth = bevelled ? blur(lift, width, height, Math.max(0.6, bevelTexels * 0.12)) : lift
  const data = new Uint16Array(width * height * 4)
  const half = DataUtils.toHalfFloat
  // Slope of the true height (bevel px of rise per CSS px), by central differences.
  const slopeScale = bevelled ? (Math.max(0, bevel) * scale) / 2 : 0
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width
    const down = Math.min(height - 1, y + 1) * width
    const row = y * width
    for (let x = 0; x < width; x++) {
      const i = row + x
      const left = row + Math.max(0, x - 1)
      const right = row + Math.min(width - 1, x + 1)
      const at = i * 4
      data[at] = half(((smooth[right] as number) - (smooth[left] as number)) * slopeScale)
      data[at + 1] = half(((smooth[down + x] as number) - (smooth[up + x] as number)) * slopeScale)
      data[at + 2] = half(lift[i] as number)
      // Clamped to stay well inside the half float range.
      data[at + 3] = half(Math.max(-4096, Math.min(4096, -(field[i] as number) / scale)))
    }
  }
  const frame = [frameX - pad, frameY - pad, width / scale, height / scale] as const
  return { data, width, height, frame }
}

/** The relief as a linearly filtered half-float texture; its first row is the top. */
export function reliefTexture(surface: Relief): DataTexture {
  const map = new DataTexture(
    surface.data,
    surface.width,
    surface.height,
    RGBAFormat,
    HalfFloatType,
  )
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}
