// What the fire of the text burns from, baked once per raster on the CPU: the distance field of
// the glyphs with the depth below the top of each stroke, the plume the flames rise in, the light
// the fire throws on the page, the wicks of the candles, the points sparks fly from, and the heat
// of each letter as a small texture. Runs only in the fire chunk.
import { rng } from '@dioramajs/effects/kit'
import { DataUtils } from 'three/webgpu'
import { MAX_SIDE, type Quad, type Raster } from './raster'
import { blur, coverage, distance, gradient, refine } from './sdf'

export type Style = 'flame' | 'embers' | 'candle'

/** A grid of half floats, RGBA, rows bottom up, over `frame` in box px: x, y, width, height. */
export interface Grid {
  readonly data: Uint16Array
  readonly width: number
  readonly height: number
  readonly frame: readonly [number, number, number, number]
}

export interface Fuel {
  /**
   * Per pixel: the signed distance to the glyph edge in px (negative inside), the unit direction
   * away from the edge (x right, y down) and the fuel height in px (inside the ink, minus the
   * depth below the top of the stroke).
   */
  readonly field: Grid
  /**
   * The plume the flames rise in, over the field widened by 0.6 em each side and `HEADROOM` ems
   * above it: per texel the strength 0..1, the strength times the height over its source in ems,
   * the ink coverage and the signed distance to the ink in ems.
   */
  readonly plume: Grid
  /** The fire's light on the page, blurred at three radii (red near, blue wide), peak 1. */
  readonly light: Grid
  /** Per candle: x and y of the top of its letter's ink in box px, its unit, a random 0..1. */
  readonly wicks: Float32Array
  /** Per spawn point of sparks: x and y in box px on the top of a stroke. */
  readonly spawns: Float32Array
  /** Largest font size, px. */
  readonly em: number
  /** Half the mean stroke width, px. */
  readonly stroke: number
}

/** Fuel height of a point with no ink anywhere below it, px. */
export const NO_FUEL = 1e4
/** How fast the fuel height grows per px of sideways offset: the taper of the flames. */
export const TAPER = 10
/** Most spark spawn points kept. */
const SPAWNS = 1024
/** Light radii in ems: near, middle, wide. */
const RADII = [0.2, 0.5, 0.9] as const
/** Plume texels per em. */
const PLUME = 28
/** Ems of air the plume covers above the text, and beside it. */
export const HEADROOM = 5
const SIDE = 0.6
/** Sideways spread of the plume per texel it rises: the side weights of a 1-2-1 style blur. */
const SPREAD = 0.14

/**
 * The plume of the flames over a coverage grid (`width` by `height`, rows top down, `texel` px each): fire
 * leaves the tops of strokes that have open air above them (a closed counter barely burns), rises,
 * spreads sideways and is stopped by ink. Per texel: the strength, and the strength times the
 * height over its source in ems.
 */
export function plume(
  ink: Float32Array,
  width: number,
  height: number,
  texel: number,
  em: number,
): [Float32Array, Float32Array] {
  const emit = new Float32Array(width * height)
  const minAir = em * 0.15
  const fullAir = em * 0.5
  for (let x = 0; x < width; x++) {
    let air = Number.POSITIVE_INFINITY
    for (let y = 0; y < height; y++) {
      const here = ink[y * width + x] as number
      if (y > 0) {
        const gained = here - (ink[(y - 1) * width + x] as number)
        const airShare = Math.min(1, Math.max(0, (air - minAir) / (fullAir - minAir)))
        if (gained > 0)
          emit[(y - 1) * width + x] = gained * airShare * airShare * (3 - 2 * airShare)
      }
      air = here >= 0.5 ? 0 : air + texel
    }
  }
  const strength = new Float32Array(width * height)
  const lifted = new Float32Array(width * height)
  let strengthRow = new Float32Array(width)
  let liftRow = new Float32Array(width)
  let nextStrength = new Float32Array(width)
  let nextLift = new Float32Array(width)
  const riseEm = texel / em
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? x - 1 : -1
      const right = x < width - 1 ? x + 1 : -1
      nextStrength[x] =
        (strengthRow[x] as number) * (1 - 2 * SPREAD) +
        SPREAD *
          ((left < 0 ? 0 : (strengthRow[left] as number)) +
            (right < 0 ? 0 : (strengthRow[right] as number)))
      nextLift[x] =
        (liftRow[x] as number) * (1 - 2 * SPREAD) +
        SPREAD *
          ((left < 0 ? 0 : (liftRow[left] as number)) +
            (right < 0 ? 0 : (liftRow[right] as number)))
    }
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const open = 1 - Math.min(1, ink[i] as number)
      const rowStrength = Math.min(1.25, (nextStrength[x] as number) * open + (emit[i] as number))
      const rowLift = ((nextLift[x] as number) + (nextStrength[x] as number) * riseEm) * open
      nextStrength[x] = rowStrength
      nextLift[x] = Math.min(rowLift, rowStrength * HEADROOM * 2)
      strength[i] = rowStrength
      lifted[i] = nextLift[x] as number
    }
    ;[strengthRow, nextStrength] = [nextStrength, strengthRow]
    ;[liftRow, nextLift] = [nextLift, liftRow]
  }
  // Smooths the steps the emission rows leave, so the flame bases are not faceted.
  return [blur(strength, width, height, 1), blur(lifted, width, height, 1)]
}

interface Yielder {
  yield(): Promise<void>
}
let resumed = Number.NEGATIVE_INFINITY

/**
 * A point between steps of a bake: resolves at once while the task is young, otherwise after
 * `scheduler.yield()`, so a bake does not block input as one long task.
 */
export function breathe(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Partial<Yielder> }).scheduler
  if (typeof scheduler?.yield !== 'function' || performance.now() - resumed < 8)
    return Promise.resolve()
  return scheduler.yield().then(() => {
    resumed = performance.now()
  })
}

const toHalf = (v: number): number => DataUtils.toHalfFloat(Math.max(-6e4, Math.min(6e4, v)))

/** Light margin around the field, px: two wide radii, past which the light no longer shows. */
export const lightMargin = (em: number): number => Math.ceil(2 * RADII[2] * em) + 2

/**
 * Fuel heights of a coverage grid (`width` by `height`, rows top down, `scale` grid px per box px): inside the
 * ink minus the depth below the top of its run, above it the height over the ink below, tapered
 * sideways at `TAPER` so a flame narrows as it rises.
 */
export function fuelHeights(
  alpha: Float32Array,
  width: number,
  height: number,
  scale: number,
): Float32Array {
  const heights = new Float32Array(width * height)
  const texelPx = 1 / scale
  for (let x = 0; x < width; x++) {
    let top = -1
    for (let y = 0; y < height; y++) {
      const i = y * width + x
      if ((alpha[i] as number) >= 0.5) {
        if (top < 0) top = y
        heights[i] = -(y - top + 0.5) * texelPx
      } else top = -1
    }
    let below = NO_FUEL
    for (let y = height - 1; y >= 0; y--) {
      const i = y * width + x
      if ((alpha[i] as number) >= 0.5) below = 0
      else {
        below = below >= NO_FUEL ? NO_FUEL : below + texelPx
        heights[i] = below
      }
    }
  }
  // The taper, through the air only: ink stops it, so no flame licks the side of a stroke.
  const taperStep = TAPER * texelPx
  const row = new Float32Array(width)
  for (let y = 0; y < height; y++) {
    let running = Number.POSITIVE_INFINITY
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      running =
        (alpha[i] as number) >= 0.5
          ? Number.POSITIVE_INFINITY
          : Math.min(heights[i] as number, running + taperStep)
      row[x] = running
    }
    running = Number.POSITIVE_INFINITY
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if ((alpha[i] as number) >= 0.5) {
        running = Number.POSITIVE_INFINITY
        continue
      }
      running = Math.min(heights[i] as number, running + taperStep)
      heights[i] = Math.min(NO_FUEL, row[x] as number, running)
    }
  }
  return heights
}

/**
 * The top of the ink of each letter for its candle: the highest column in the middle of the
 * letter, the one nearest the middle among those about as high. Letters with little ink
 * (punctuation) get none.
 */
export function wicksOf(
  quads: readonly Quad[],
  alpha: Float32Array,
  width: number,
  height: number,
  frame: readonly [number, number, number, number],
  scale: number,
  seed: number,
): Float32Array {
  const random = rng(Math.round(seed) * 31 + 7)
  const wicks: number[] = []
  const seen = new Set<number>()
  for (const quad of quads) {
    if (seen.has(quad.order)) continue
    const colLeft = Math.max(0, Math.floor((quad.x + quad.width * 0.18 - frame[0]) * scale))
    const colRight = Math.min(width - 1, Math.ceil((quad.x + quad.width * 0.82 - frame[0]) * scale))
    const rowTop = Math.max(0, Math.floor((quad.y - frame[1]) * scale))
    const rowBottom = Math.min(height - 1, Math.ceil((quad.y + quad.height - frame[1]) * scale))
    const tops = new Int32Array(Math.max(0, colRight - colLeft + 1)).fill(-1)
    let highest = Number.POSITIVE_INFINITY
    let lowest = Number.NEGATIVE_INFINITY
    for (let x = colLeft; x <= colRight; x++) {
      for (let y = rowTop; y <= rowBottom; y++) {
        if ((alpha[y * width + x] as number) < 0.5) continue
        tops[x - colLeft] = y
        highest = Math.min(highest, y)
        break
      }
      for (let y = rowBottom; y >= rowTop; y--) {
        if ((alpha[y * width + x] as number) < 0.5) continue
        lowest = Math.max(lowest, y)
        break
      }
    }
    if (!Number.isFinite(highest) || (lowest - highest) / scale < quad.em * 0.3) continue
    const middle = (colLeft + colRight) / 2
    const near = quad.em * 0.04 * scale
    let best = -1
    for (let x = colLeft; x <= colRight; x++) {
      const top = tops[x - colLeft] as number
      if (top < 0 || top > highest + near) continue
      if (best < 0 || Math.abs(x - middle) < Math.abs(best - middle)) best = x
    }
    seen.add(quad.order)
    wicks.push(
      frame[0] + (best + 0.5) / scale,
      frame[1] + (tops[best - colLeft] as number) / scale,
      quad.order,
      random(),
    )
  }
  return Float32Array.from(wicks.length ? wicks : [0, 0, -1, 0])
}

/** Points on the tops of strokes, at most `SPAWNS`, picked by the seed. */
function spawnsOf(
  alpha: Float32Array,
  width: number,
  height: number,
  frame: readonly [number, number, number, number],
  scale: number,
  seed: number,
): Float32Array {
  const random = rng(Math.round(seed) * 17 + 5)
  const up = Math.max(1, Math.round(scale * 1.5))
  const picked: number[] = []
  let seen = 0
  for (let y = up; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if ((alpha[i] as number) < 0.5 || (alpha[i - up * width] as number) >= 0.5) continue
      // Reservoir sampling: every top point equally likely.
      seen++
      if (picked.length < SPAWNS * 2) picked.push(x, y)
      else {
        const j = Math.floor(random() * seen)
        if (j < SPAWNS) {
          picked[j * 2] = x
          picked[j * 2 + 1] = y
        }
      }
    }
  const points = new Float32Array(Math.max(2, picked.length))
  for (let index = 0; index < picked.length; index += 2) {
    points[index] = frame[0] + ((picked[index] as number) + 0.5) / scale
    points[index + 1] = frame[1] + (picked[index + 1] as number) / scale
  }
  return points
}

/**
 * Adds the grid `source` (`srcWidth` by `srcHeight` at `srcScale` texels per box px over
 * `srcFrame`) into a coarser grid, averaged.
 */
function shrink(
  source: Float32Array,
  srcWidth: number,
  srcHeight: number,
  srcFrame: readonly [number, number, number, number],
  srcScale: number,
  dstWidth: number,
  dstHeight: number,
  dstFrame: readonly [number, number, number, number],
  dstScale: number,
): Float32Array {
  const sum = new Float32Array(dstWidth * dstHeight)
  const area = (dstScale / srcScale) ** 2
  for (let y = 0; y < srcHeight; y++) {
    const dstY = Math.floor((srcFrame[1] + (y + 0.5) / srcScale - dstFrame[1]) * dstScale)
    if (dstY < 0 || dstY >= dstHeight) continue
    for (let x = 0; x < srcWidth; x++) {
      const value = source[y * srcWidth + x] as number
      if (!value) continue
      const dstX = Math.floor((srcFrame[0] + (x + 0.5) / srcScale - dstFrame[0]) * dstScale)
      if (dstX >= 0 && dstX < dstWidth)
        sum[dstY * dstWidth + dstX] = (sum[dstY * dstWidth + dstX] as number) + value * area
    }
  }
  return sum
}

/**
 * Bakes the fuel of a raster for `style`: the field at up to 2 px per box px (less for large
 * text, `ratio` 1 halves it), its light and its candles. Yields to the browser between steps.
 */
export async function bake(
  layout: Raster,
  style: Style,
  ratio: number,
  seed: number,
): Promise<Fuel> {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const em = Math.max(1, ...layout.quads.map((line) => line.em))
  const margin = 2
  const scale = Math.min(
    Math.max(1, Math.min(2, 160 / em)) * (ratio / 2),
    MAX_SIDE / Math.max(frameWidth + 2 * margin, frameHeight + 2 * margin),
  )
  const fieldWidth = Math.max(1, Math.ceil((frameWidth + 2 * margin) * scale))
  const fieldHeight = Math.max(1, Math.ceil((frameHeight + 2 * margin) * scale))
  const frame = [frameX - margin, frameY - margin, fieldWidth / scale, fieldHeight / scale] as const
  const glyphs = document.createElement('canvas')
  glyphs.width = fieldWidth
  glyphs.height = fieldHeight
  const rasterScale = layout.canvas.width / Math.max(1e-6, frameWidth)
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
  refine(alpha, fieldWidth, fieldHeight, sdf)
  await breathe()
  let depthSum = 0
  let inside = 0
  for (let i = 0; i < sdf.length; i++) {
    const dist = (sdf[i] as number) / scale
    sdf[i] = dist
    if ((alpha[i] as number) >= 0.5) {
      depthSum -= dist
      inside++
    }
  }
  const stroke = inside ? Math.max(0.5, (2 * depthSum) / inside) : em * 0.06
  const normal = gradient(sdf, fieldWidth, fieldHeight)
  const fuel = fuelHeights(alpha, fieldWidth, fieldHeight, scale)
  await breathe()
  const data = new Uint16Array(fieldWidth * fieldHeight * 4)
  for (let y = 0; y < fieldHeight; y++)
    for (let x = 0; x < fieldWidth; x++) {
      const i = y * fieldWidth + x
      const texel = ((fieldHeight - 1 - y) * fieldWidth + x) * 4
      data[texel] = toHalf(sdf[i] as number)
      data[texel + 1] = toHalf(normal[i * 2] as number)
      data[texel + 2] = toHalf(normal[i * 2 + 1] as number)
      data[texel + 3] = toHalf(fuel[i] as number)
    }
  const field: Grid = { data, width: fieldWidth, height: fieldHeight, frame }
  await breathe()

  const plumeScale = Math.min(PLUME / em, scale) * (ratio === 1 ? 0.75 : 1)
  const side = em * SIDE
  const plumeWidth = Math.max(1, Math.ceil((frame[2] + 2 * side) * plumeScale))
  const plumeHeight = Math.max(1, Math.ceil((frame[3] + HEADROOM * em) * plumeScale))
  const plumeFrame = [
    frame[0] - side,
    frame[1] - HEADROOM * em,
    plumeWidth / plumeScale,
    plumeHeight / plumeScale,
  ] as const
  const plumeInk = shrink(
    alpha,
    fieldWidth,
    fieldHeight,
    frame,
    scale,
    plumeWidth,
    plumeHeight,
    plumeFrame,
    plumeScale,
  )
  const [strength, lifted] = plume(plumeInk, plumeWidth, plumeHeight, 1 / plumeScale, em)
  const apart = distance(plumeInk, plumeWidth, plumeHeight)
  const plumeData = new Uint16Array(plumeWidth * plumeHeight * 4)
  for (let y = 0; y < plumeHeight; y++)
    for (let x = 0; x < plumeWidth; x++) {
      const i = y * plumeWidth + x
      const texel = ((plumeHeight - 1 - y) * plumeWidth + x) * 4
      plumeData[texel] = toHalf(strength[i] as number)
      plumeData[texel + 1] = toHalf(lifted[i] as number)
      plumeData[texel + 2] = toHalf(Math.min(1, plumeInk[i] as number))
      plumeData[texel + 3] = toHalf(
        Math.max(-1, Math.min(4, (apart[i] as number) / plumeScale / em)),
      )
    }
  await breathe()

  const wicks =
    style === 'candle'
      ? wicksOf(layout.quads, alpha, fieldWidth, fieldHeight, frame, scale, seed)
      : new Float32Array([0, 0, -1, 0])
  const spawns = spawnsOf(alpha, fieldWidth, fieldHeight, frame, scale, seed)

  // The light: what burns, blurred. Flames and coals light from the tops of the strokes down,
  // a candle from a small ball over its wick.
  const lightPad = lightMargin(em)
  const lightScale = Math.min(0.5, 12 / em, scale)
  const lightWidth = Math.max(1, Math.ceil((frame[2] + 2 * lightPad) * lightScale))
  const lightHeight = Math.max(1, Math.ceil((frame[3] + 2 * lightPad) * lightScale))
  const lightFrame = [
    frame[0] - lightPad,
    frame[1] - lightPad,
    lightWidth / lightScale,
    lightHeight / lightScale,
  ] as const
  let source: Float32Array
  if (style === 'candle') {
    source = new Float32Array(lightWidth * lightHeight)
    const ball = Math.max(1, em * 0.12 * lightScale)
    for (let wick = 0; wick < wicks.length; wick += 4) {
      if ((wicks[wick + 2] as number) < 0) continue
      const wickX = ((wicks[wick] as number) - lightFrame[0]) * lightScale
      const wickY = ((wicks[wick + 1] as number) - lightFrame[1]) * lightScale
      for (let y = Math.floor(wickY - 2 * ball); y <= Math.ceil(wickY + 2 * ball); y++)
        for (let x = Math.floor(wickX - 2 * ball); x <= Math.ceil(wickX + 2 * ball); x++) {
          if (x < 0 || y < 0 || x >= lightWidth || y >= lightHeight) continue
          const distanceSq = ((x + 0.5 - wickX) ** 2 + (y + 0.5 - wickY) ** 2) / (ball * ball)
          source[y * lightWidth + x] = Math.max(
            source[y * lightWidth + x] as number,
            Math.exp(-distanceSq),
          )
        }
    }
  } else {
    const hot = new Float32Array(fieldWidth * fieldHeight)
    const reach = em * 0.3
    for (let i = 0; i < hot.length; i++) {
      const fuelAt = fuel[i] as number
      if ((alpha[i] as number) >= 0.5) hot[i] = Math.exp(fuelAt / reach)
    }
    source = shrink(
      hot,
      fieldWidth,
      fieldHeight,
      frame,
      scale,
      lightWidth,
      lightHeight,
      lightFrame,
      lightScale,
    )
  }
  await breathe()
  const channels = RADII.map((sigma) =>
    blur(source, lightWidth, lightHeight, sigma * em * lightScale),
  )
  const peaks = channels.map((channel) => channel.reduce((p, v) => Math.max(p, v), 1e-6))
  await breathe()
  const lightData = new Uint16Array(lightWidth * lightHeight * 4)
  for (let y = 0; y < lightHeight; y++)
    for (let x = 0; x < lightWidth; x++) {
      const i = y * lightWidth + x
      const texel = ((lightHeight - 1 - y) * lightWidth + x) * 4
      for (let channel = 0; channel < 3; channel++)
        lightData[texel + channel] = toHalf(
          ((channels[channel] as Float32Array)[i] as number) / (peaks[channel] as number),
        )
      lightData[texel + 3] = toHalf(1)
    }
  return {
    field,
    plume: { data: plumeData, width: plumeWidth, height: plumeHeight, frame: plumeFrame },
    light: { data: lightData, width: lightWidth, height: lightHeight, frame: lightFrame },
    wicks,
    spawns,
    em,
    stroke,
  }
}

/** Seconds into the burn when each unit catches: from a unit picked by the seed outward. */
export function catchTimes(
  quads: readonly Quad[],
  units: number,
  seed: number,
  em: number,
): Float32Array {
  const centre = new Float32Array(units * 2)
  const count = new Float32Array(units)
  for (const quad of quads) {
    centre[quad.order * 2] = (centre[quad.order * 2] as number) + quad.x + quad.width / 2
    centre[quad.order * 2 + 1] = (centre[quad.order * 2 + 1] as number) + quad.y + quad.height / 2
    count[quad.order] = (count[quad.order] as number) + 1
  }
  for (let i = 0; i < units; i++) {
    const members = Math.max(1, count[i] as number)
    centre[i * 2] = (centre[i * 2] as number) / members
    centre[i * 2 + 1] = (centre[i * 2 + 1] as number) / members
  }
  const random = rng(Math.round(seed) * 13 + 1)
  const start = Math.min(units - 1, Math.floor(random() * units))
  const startX = centre[start * 2] as number
  const startY = centre[start * 2 + 1] as number
  // The fire runs along the text at about 9 ems a second, a little unevenly.
  const pace = Math.max(1, em) * 9
  const out = new Float32Array(units)
  for (let i = 0; i < units; i++) {
    const dist = Math.hypot(
      (centre[i * 2] as number) - startX,
      ((centre[i * 2 + 1] as number) - startY) * 2,
    )
    out[i] = dist / pace + (i === start ? 0 : random() * 0.08)
  }
  return out
}

/**
 * The heat and char of every letter as a small texture over the field and the flames above it:
 * one texel per quarter em, heat (0..1.5, stored /1.5) in red over the letter and its flames,
 * char in green over the letter.
 */
export class HeatMap {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  /** Box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  readonly #scale: number
  readonly #heat: Float32Array
  readonly #char: Float32Array

  constructor(frame: readonly [number, number, number, number], em: number) {
    this.#scale = Math.min(1, 4 / Math.max(1, em))
    this.width = Math.max(2, Math.ceil(frame[2] * this.#scale) + 2)
    this.height = Math.max(2, Math.ceil(frame[3] * this.#scale) + 2)
    const texelsPerPx = this.#scale
    this.frame = [
      frame[0] - 1 / texelsPerPx,
      frame[1] - 1 / texelsPerPx,
      this.width / texelsPerPx,
      this.height / texelsPerPx,
    ]
    this.data = new Uint8Array(this.width * this.height * 4)
    this.#heat = new Float32Array(this.width * this.height)
    this.#char = new Float32Array(this.width * this.height)
  }

  /**
   * Paints the units' heat and char: each letter heats its own box widened by half an em (its
   * flames spread and sway) and `up` px above it, where they rise; overlaps take the hotter. Char
   * stays on the letter.
   */
  paint(
    quads: readonly Quad[],
    heat: Float32Array,
    char: Float32Array,
    up: number,
    em: number,
  ): void {
    const texelsPerPx = this.#scale
    const [frameX, frameY] = this.frame
    const cols = this.width
    const rows = this.height
    this.#heat.fill(0)
    this.#char.fill(0)
    const pad = em * 0.5
    for (const quad of quads) {
      const unitHeat = heat[quad.order] ?? 0
      const unitChar = char[quad.order] ?? 0
      if (unitHeat <= 0 && unitChar <= 0) continue
      const left = Math.max(0, Math.floor((quad.x - pad - frameX) * texelsPerPx))
      const right = Math.min(
        cols - 1,
        Math.ceil((quad.x + quad.width + pad - frameX) * texelsPerPx),
      )
      const charLeft = Math.floor((quad.x - em * 0.1 - frameX) * texelsPerPx)
      const charRight = Math.ceil((quad.x + quad.width + em * 0.1 - frameX) * texelsPerPx)
      const top = Math.max(0, Math.floor((quad.y - up - frameY) * texelsPerPx))
      const letterTop = Math.max(0, Math.floor((quad.y - frameY) * texelsPerPx))
      const bottom = Math.min(rows - 1, Math.ceil((quad.y + quad.height - frameY) * texelsPerPx))
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++) {
          const i = y * cols + x
          if (unitHeat > (this.#heat[i] as number)) this.#heat[i] = unitHeat
          if (
            y >= letterTop &&
            x >= charLeft &&
            x <= charRight &&
            unitChar > (this.#char[i] as number)
          )
            this.#char[i] = unitChar
        }
    }
    // Rows bottom up; a 1-2-1 blur across keeps letters of different heat from stepping.
    for (let y = 0; y < rows; y++) {
      const row = y * cols
      const outRow = (rows - 1 - y) * cols
      for (let x = 0; x < cols; x++) {
        const left = row + Math.max(0, x - 1)
        const right = row + Math.min(cols - 1, x + 1)
        const heatValue =
          ((this.#heat[left] as number) +
            2 * (this.#heat[row + x] as number) +
            (this.#heat[right] as number)) /
          4
        const charValue =
          ((this.#char[left] as number) +
            2 * (this.#char[row + x] as number) +
            (this.#char[right] as number)) /
          4
        const texel = (outRow + x) * 4
        this.data[texel] = Math.round(Math.min(1, heatValue / 1.5) * 255)
        this.data[texel + 1] = Math.round(Math.min(1, charValue) * 255)
        this.data[texel + 3] = 255
      }
    }
  }
}
