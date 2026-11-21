// The distance from the ink edge inside the glyphs of a raster, as a texture, for normals: bevels
// and walls. Runs only in the chunks of the effects that light their glyphs.
import { DataTexture, LinearFilter, NoColorSpace, RedFormat, UnsignedByteType } from 'three/webgpu'
import type { Raster } from './raster'
import { blur, coverage, distance } from './sdf'

/** Most samples of a field. */
const MAX_SAMPLES = 1_000_000
/** Blur of the distances, samples: distances to sample centres step along curves. */
const SMOOTH = 2

/** A distance field over a raster's frame. */
export interface Field {
  /** Distance in red: `value * (band + 1) - 1` box px, positive inside the ink. */
  readonly map: DataTexture
  /** Box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  /** Largest distance it holds, px. */
  readonly band: number
}

/**
 * Bytes of the distance inside the ink of `alpha` (`width` x `height` coverage, rows top down) at `scale`
 * samples a px: `(px + 1) / (band + 1)`, so -1 px and less is 0, `band` px and more 255. Rows go
 * bottom up, as a DataTexture reads them. Undefined without ink.
 */
export function encode(
  alpha: Float32Array,
  width: number,
  height: number,
  scale: number,
  band: number,
): Uint8Array | undefined {
  if (!alpha.some((a) => a > 0)) return undefined
  const signed = distance(alpha, width, height)
  const top = band * scale + 2
  for (let i = 0; i < signed.length; i++)
    signed[i] = Math.min(top, Math.max(-scale - 2, -(signed[i] as number)))
  const smooth = blur(signed, width, height, SMOOTH)
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * width
    for (let x = 0; x < width; x++) {
      const inside = (smooth[y * width + x] as number) / scale
      data[row + x] = Math.round(Math.min(1, Math.max(0, (inside + 1) / (band + 1))) * 255)
    }
  }
  return data
}

/**
 * The distance from the edge of the raster's ink, inside it, up to `band` px. Read back from the
 * canvas once, at up to a million samples. Undefined without pixels to read.
 */
export function field(layout: Raster, band: number): Field | undefined {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const ratio = layout.canvas.width / (frameWidth || 1)
  const scale = Math.min(ratio, Math.sqrt(MAX_SAMPLES / Math.max(1, frameWidth * frameHeight)))
  // Rows a multiple of four bytes, as WebGL unpacks them.
  const width = Math.max(4, Math.ceil((frameWidth * scale) / 4) * 4)
  const height = Math.max(1, Math.ceil(frameHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return undefined
  ctx.drawImage(layout.canvas, 0, 0, frameWidth * scale, frameHeight * scale)
  const data = encode(coverage(canvas, width, height), width, height, scale, band)
  if (!data) return undefined
  const map = new DataTexture(data, width, height, RedFormat, UnsignedByteType)
  map.colorSpace = NoColorSpace
  map.magFilter = map.minFilter = LinearFilter
  map.generateMipmaps = false
  map.unpackAlignment = 1
  map.needsUpdate = true
  return { map, frame: [frameX, frameY, width / scale, height / scale], band }
}
