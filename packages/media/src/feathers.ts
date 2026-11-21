// A tile of window frost for the pane: feathers of ice (a stem with barbs, and barbs on the
// barbs) in red, their glow in green and small six-armed stars in blue. Baked once per page on
// the CPU and wrapped at the edges, so the tile repeats without seams.
import { rng } from '@dioramajs/effects/kit'
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu'

/** Tile side, px. */
export const TILE = 512

/** Longest stretch of baking between two yields to the page, ms. */
const SLICE = 6

let baked: Promise<Uint8Array> | undefined

/**
 * RGBA bytes of the tile, the same on every call. The bake takes the main thread for under
 * 100 ms in all, so it runs in slices of a few ms between tasks.
 */
export function feathers(): Promise<Uint8Array> {
  baked ??= (async () => {
    const steps = bake(TILE, 7)
    for (let since = now(); ; ) {
      const { done, value } = steps.next()
      if (done) return value
      if (now() - since > SLICE) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        since = now()
      }
    }
  })()
  return baked
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/** The tile as a texture of its own; dispose it with the instance. */
export async function featherTexture(): Promise<DataTexture> {
  const texture = new DataTexture(await feathers(), TILE, TILE, RGBAFormat, UnsignedByteType)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}

/** Yields after each feather and star, returns the bytes. */
function* bake(size: number, seed: number): Generator<void, Uint8Array> {
  const random = rng(seed)
  const lines = new Float32Array(size * size)
  const stars = new Float32Array(size * size)
  // A straight stroke `length` px long that fades towards its end.
  const line = (
    out: Float32Array,
    x: number,
    y: number,
    angle: number,
    length: number,
    value: number,
  ): void => {
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    for (let along = 0; along <= length; along += 0.6)
      splat(out, size, x + dx * along, y + dy * along, value * (1 - (0.6 * along) / length))
  }
  // A stem that bends a little as it grows, with barbs at about 60 degrees on both sides.
  const feather = (
    x: number,
    y: number,
    heading: number,
    length: number,
    depth: number,
    value: number,
  ): void => {
    let tipX = x
    let tipY = y
    let angle = heading
    let side = random() < 0.5 ? 1 : -1
    let next = 3 + random() * 3
    for (let along = 0; along < length; along += 1.5) {
      angle += (random() - 0.5) * 0.06
      const nextX = tipX + Math.cos(angle) * 1.5
      const nextY = tipY + Math.sin(angle) * 1.5
      line(lines, tipX, tipY, angle, 1.5, value * (1 - (0.5 * along) / length))
      tipX = nextX
      tipY = nextY
      if (depth > 0 && along >= next) {
        next = along + 2.5 + random() * 4
        const left = length - along
        const barbLength = left * (0.3 + random() * 0.25) + 2
        const turn = angle + side * (0.95 + random() * 0.25)
        if (depth > 1) feather(tipX, tipY, turn, barbLength, depth - 1, value * 0.8)
        else line(lines, tipX, tipY, turn, barbLength, value * 0.6)
        if (random() < 0.7) side = -side
      }
    }
  }
  for (let i = 0; i < 64; i++) {
    feather(random() * size, random() * size, random() * Math.PI * 2, 50 + random() * 150, 2, 1)
    yield
  }
  // Six-armed stars.
  for (let i = 0; i < 260; i++) {
    const x = random() * size
    const y = random() * size
    const armLength = 2 + random() ** 2 * 7
    const turn = random() * Math.PI
    for (let arm = 0; arm < 6; arm++) {
      const angle = turn + (arm * Math.PI) / 3
      line(stars, x, y, angle, armLength, 0.9)
      // Two tiny barbs halfway along each arm.
      const midX = x + Math.cos(angle) * armLength * 0.5
      const midY = y + Math.sin(angle) * armLength * 0.5
      line(stars, midX, midY, angle + 1, armLength * 0.3, 0.6)
      line(stars, midX, midY, angle - 1, armLength * 0.3, 0.6)
    }
  }
  yield
  const glow = blur(lines, size, 3)
  yield
  blur(glow, size, 3, glow)
  yield
  let peak = 0
  for (const value of glow) peak = Math.max(peak, value)
  const data = new Uint8Array(size * size * 4)
  for (let cell = 0; cell < size * size; cell++) {
    data[4 * cell] = Math.round((lines[cell] as number) * 255)
    data[4 * cell + 1] = Math.round(
      Math.min(1, ((glow[cell] as number) / (peak || 1)) * 1.25) * 255,
    )
    data[4 * cell + 2] = Math.round((stars[cell] as number) * 255)
    data[4 * cell + 3] = 255
  }
  return data
}

/** Draws `value` at (`x`, `y`) with bilinear weights, wrapped, keeping the brighter value. */
function splat(out: Float32Array, size: number, x: number, y: number, value: number): void {
  const col = Math.floor(x)
  const row = Math.floor(y)
  const fx = x - col
  const fy = y - row
  const left = ((col % size) + size) % size
  const bottom = ((row % size) + size) % size
  const right = left + 1 === size ? 0 : left + 1
  const top = bottom + 1 === size ? 0 : bottom + 1
  const scaled = value * 1.6
  let cell = bottom * size + left
  let weight = scaled * (1 - fx) * (1 - fy)
  if (weight > (out[cell] as number)) out[cell] = Math.min(weight, 1)
  cell = bottom * size + right
  weight = scaled * fx * (1 - fy)
  if (weight > (out[cell] as number)) out[cell] = Math.min(weight, 1)
  cell = top * size + left
  weight = scaled * (1 - fx) * fy
  if (weight > (out[cell] as number)) out[cell] = Math.min(weight, 1)
  cell = top * size + right
  weight = scaled * fx * fy
  if (weight > (out[cell] as number)) out[cell] = Math.min(weight, 1)
}

/** A wrapped box blur of `radius` cells, horizontal then vertical, with running sums. */
function blur(
  src: Float32Array,
  size: number,
  radius: number,
  out: Float32Array = new Float32Array(src.length),
): Float32Array {
  const horizontal = new Float32Array(src.length)
  const width = 2 * radius + 1
  for (let y = 0; y < size; y++) {
    let sum = 0
    for (let i = -radius; i <= radius; i++) sum += src[y * size + ((i + size) % size)] as number
    for (let x = 0; x < size; x++) {
      horizontal[y * size + x] = sum / width
      sum +=
        (src[y * size + ((x + radius + 1) % size)] as number) -
        (src[y * size + ((x - radius + size) % size)] as number)
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0
    for (let i = -radius; i <= radius; i++) {
      sum += horizontal[((i + size) % size) * size + x] as number
    }
    for (let y = 0; y < size; y++) {
      out[y * size + x] = sum / width
      sum +=
        (horizontal[((y + radius + 1) % size) * size + x] as number) -
        (horizontal[((y - radius + size) % size) * size + x] as number)
    }
  }
  return out
}
