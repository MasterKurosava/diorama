// The maps of emboss, built once on the CPU: the relief of the letters pressed into or raised out
// of the surface, and a tile of the surface's own fine relief per material. Runs only in the
// emboss chunk.
import { rng } from '@dioramajs/effects/kit'
import { DataUtils } from 'three/webgpu'
import { MAX_SIDE, type Raster } from './raster'
import { blur, coverage, distance } from './sdf'

export type Style = 'emboss' | 'deboss' | 'letterpress' | 'stamp'
export type Material = 'paper' | 'leather' | 'metal' | 'stone' | 'plaster'

/** Side of a material tile in texels, one per CSS px; it repeats over the box. */
export const TILE = 512

/** How a material takes the light. */
export interface Finish {
  /** Its color where the element has no background color of its own. */
  readonly base: string
  /** Height of its fine relief in px at grain 1. */
  readonly relief: number
  /** Strength and sharpness of its highlight. */
  readonly spec: number
  readonly shine: number
  /** Brushed metal: the highlight takes the metal's color and stretches across the brushing. */
  readonly metal: boolean
  /** Light that wraps past the terminator: soft, fibrous surfaces. */
  readonly wrap: number
  /** Albedo of the parts pressed in: burnished leather darkens, crushed paper a little. */
  readonly pressed: number
  /** How much the highlight takes the surface's color: metals and leather. */
  readonly tint: number
}

export const FINISHES: Readonly<Record<Material, Finish>> = {
  paper: {
    base: '#f3efe6',
    relief: 0.2,
    spec: 0.035,
    shine: 6,
    metal: false,
    wrap: 0.25,
    pressed: 0.95,
    tint: 0,
  },
  leather: {
    base: '#6a4330',
    relief: 0.32,
    spec: 0.12,
    shine: 14,
    metal: false,
    wrap: 0.1,
    pressed: 0.55,
    tint: 0.5,
  },
  metal: {
    base: '#b4b8bf',
    relief: 0.16,
    spec: 0.42,
    shine: 60,
    metal: true,
    wrap: 0,
    pressed: 0.9,
    tint: 0.7,
  },
  stone: {
    base: '#9a968f',
    relief: 0.45,
    spec: 0.07,
    shine: 14,
    metal: false,
    wrap: 0.05,
    pressed: 0.9,
    tint: 0,
  },
  plaster: {
    base: '#ece8e1',
    relief: 0.5,
    spec: 0.025,
    shine: 5,
    metal: false,
    wrap: 0.2,
    pressed: 0.94,
    tint: 0,
  },
}

/** Smooth 0..1 between edges a and b, with zero slope at both ends. */
const smoother = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** Quintic fade of a lattice fraction. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)

/** A periodic lattice of random values, `nx` by `ny` cells over the tile. */
interface Lattice {
  readonly values: Float32Array
  readonly nx: number
  readonly ny: number
}

function lattice(nx: number, ny: number, random: () => number): Lattice {
  const values = new Float32Array(nx * ny)
  for (let i = 0; i < values.length; i++) values[i] = random() * 2 - 1
  return { values, nx, ny }
}

/** Value noise of a lattice at tile texel x, y: smooth, -1..1, wrapping with the tile. */
function value(grid: Lattice, x: number, y: number): number {
  const fx = (x / TILE) * grid.nx
  const fy = (y / TILE) * grid.ny
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const tx = fade(fx - ix)
  const ty = fade(fy - iy)
  const x0 = ((ix % grid.nx) + grid.nx) % grid.nx
  const y0 = ((iy % grid.ny) + grid.ny) % grid.ny
  const x1 = (x0 + 1) % grid.nx
  const y1 = (y0 + 1) % grid.ny
  const a = grid.values[y0 * grid.nx + x0] as number
  const b = grid.values[y0 * grid.nx + x1] as number
  const c = grid.values[y1 * grid.nx + x0] as number
  const d = grid.values[y1 * grid.nx + x1] as number
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
}

/** Sum of value noise octaves into `out`, each [nx, ny, weight]. */
function octaves(
  out: Float32Array,
  random: () => number,
  layers: readonly (readonly [number, number, number])[],
): void {
  for (const [nx, ny, weight] of layers) {
    const grid = lattice(nx, ny, random)
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x
        out[i] = (out[i] as number) + value(grid, x, y) * weight
      }
  }
}

/** Index of a texel, wrapping with the tile. */
const at = (x: number, y: number): number =>
  (((y % TILE) + TILE) % TILE) * TILE + (((x % TILE) + TILE) % TILE)

/** Paper: short fibres in every direction over a fine tooth, and a soft cloud in the sheet. */
function paper(height: Float32Array, albedo: Float32Array, random: () => number): void {
  const fibres = new Float32Array(TILE * TILE)
  for (let fibre = 0; fibre < PAPER_FIBRES; fibre++) {
    let x = random() * TILE
    let y = random() * TILE
    let angle = random() * Math.PI * 2
    const bend = (random() - 0.5) * 0.08
    const length = 5 + random() ** 2 * 26
    const width = 0.4 + random() * 0.4
    const lift = 0.2 + random() * 0.5
    for (let travelled = 0; travelled < length; travelled += 0.5) {
      x += Math.cos(angle) * 0.5
      y += Math.sin(angle) * 0.5
      angle += bend
      const pixelX = Math.round(x)
      const pixelY = Math.round(y)
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const distanceSq = (pixelX + dx - x) ** 2 + (pixelY + dy - y) ** 2
          const fibreHeight = lift * Math.exp(-distanceSq / (2 * width * width))
          const i = at(pixelX + dx, pixelY + dy)
          if (fibreHeight > (fibres[i] as number)) fibres[i] = fibreHeight
        }
    }
  }
  const tooth = new Float32Array(TILE * TILE)
  octaves(tooth, random, [
    [64, 64, 0.25],
    [128, 128, 0.4],
    [256, 256, 0.3],
  ])
  const cloud = new Float32Array(TILE * TILE)
  octaves(cloud, random, [
    [8, 8, 0.6],
    [16, 16, 0.3],
    [32, 32, 0.15],
  ])
  for (let i = 0; i < height.length; i++) {
    height[i] = (fibres[i] as number) * 0.45 + (tooth[i] as number) + (cloud[i] as number) * 0.3
    albedo[i] = 1 + (cloud[i] as number) * 0.02 + (fibres[i] as number) * 0.01
  }
}

/** Leather: pebbled grain, rounded tops between creases, with fine wrinkles and pores. */
function leather(height: Float32Array, albedo: Float32Array, random: () => number): void {
  // Pebbles per side of the tile.
  const cells = 96
  const cell = TILE / cells
  const points = new Float32Array(cells * cells * 2)
  for (let i = 0; i < cells * cells; i++) {
    points[i * 2] = random()
    points[i * 2 + 1] = random()
  }
  const wrinkle = new Float32Array(TILE * TILE)
  octaves(wrinkle, random, [
    [64, 64, 0.5],
    [128, 128, 0.3],
  ])
  const warp = new Float32Array(TILE * TILE)
  octaves(warp, random, [
    [16, 16, 1],
    [32, 32, 0.5],
  ])
  const folds = new Float32Array(TILE * TILE)
  octaves(folds, random, [
    [6, 6, 1],
    [12, 12, 0.5],
  ])
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      // Distances to the nearest two cell points, in cells.
      const bend = (warp[y * TILE + x] as number) * 0.45
      const warpedX = x / cell + bend
      const warpedY = y / cell - bend * 0.7
      const ix = Math.floor(warpedX)
      const iy = Math.floor(warpedY)
      let nearest = 9
      let second = 9
      let near = 0
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const cx = ix + ox
          const cy = iy + oy
          const pointIndex =
            (((cy % cells) + cells) % cells) * cells + (((cx % cells) + cells) % cells)
          const pointX = cx + (points[pointIndex * 2] as number) * 0.8 + 0.1
          const pointY = cy + (points[pointIndex * 2 + 1] as number) * 0.8 + 0.1
          const dist = Math.hypot(pointX - warpedX, pointY - warpedY)
          if (dist < nearest) {
            second = nearest
            nearest = dist
            near = pointIndex
          } else if (dist < second) second = dist
        }
      // Rounded pebbles of their own heights with soft valleys between them.
      const pebble = smoother(0, 0.6, second - nearest) * (0.6 + 0.4 * (points[near * 2] as number))
      const i = y * TILE + x
      const crease = 1 - smoother(0, 0.25, second - nearest)
      const wrinkled = wrinkle[i] as number
      height[i] = pebble * 0.8 + wrinkled * 0.2 + (folds[i] as number) * 0.25
      albedo[i] = 1 - crease * 0.08 + wrinkled * 0.04 + (folds[i] as number) * 0.05
    }
}

/** Brushed metal: long fine lines along x, each its own depth, and faint broad swirls. */
function metal(height: Float32Array, albedo: Float32Array, random: () => number): void {
  octaves(height, random, [
    [3, 512, 1],
    [7, 512, 0.6],
    [16, 256, 0.35],
    [2, 128, 0.25],
  ])
  const sheen = new Float32Array(TILE * TILE)
  octaves(sheen, random, [
    [4, 4, 0.5],
    [8, 8, 0.25],
  ])
  for (let i = 0; i < height.length; i++)
    albedo[i] = 1 + (height[i] as number) * 0.05 + (sheen[i] as number) * 0.04
}

/** Stone: speckled grains of darker and lighter mineral in a fine, pitted ground. */
function stone(height: Float32Array, albedo: Float32Array, random: () => number): void {
  octaves(height, random, [
    [32, 32, 0.35],
    [96, 96, 0.3],
    [256, 256, 0.3],
  ])
  const mottle = new Float32Array(TILE * TILE)
  octaves(mottle, random, [
    [6, 6, 0.6],
    [14, 14, 0.35],
  ])
  for (let i = 0; i < albedo.length; i++) albedo[i] = 1 + (mottle[i] as number) * 0.06
  for (let grain = 0; grain < STONE_GRAINS; grain++) {
    const x = random() * TILE
    const y = random() * TILE
    const radius = 0.5 + random() ** 3 * 2.2
    const tone = random() < 0.62 ? -(0.18 + random() * 0.35) : 0.12 + random() * 0.22
    const pit = random() < 0.25 ? -0.6 : 0
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const dist = Math.hypot(Math.round(x) + dx - x, Math.round(y) + dy - y)
        const cover = Math.min(1, Math.max(0, radius + 0.5 - dist))
        if (cover <= 0) continue
        const i = at(Math.round(x) + dx, Math.round(y) + dy)
        albedo[i] = (albedo[i] as number) + tone * cover
        height[i] = (height[i] as number) + pit * cover
      }
  }
}

/** Plaster: broad trowel undulations, fine sand and a few pores. */
function plaster(height: Float32Array, albedo: Float32Array, random: () => number): void {
  const trowel = new Float32Array(TILE * TILE)
  octaves(trowel, random, [
    [4, 6, 1.6],
    [8, 10, 0.8],
    [16, 16, 0.3],
  ])
  octaves(height, random, [
    [128, 128, 0.25],
    [256, 256, 0.2],
  ])
  for (let i = 0; i < height.length; i++) {
    height[i] = (height[i] as number) + (trowel[i] as number) * 2.2
    albedo[i] = 1 + (trowel[i] as number) * 0.02
  }
  for (let pore = 0; pore < PLASTER_PORES; pore++) {
    const x = Math.round(random() * TILE)
    const y = Math.round(random() * TILE)
    const radius = 0.6 + random() * 1.3
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const cover = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(dx, dy)))
        const i = at(x + dx, y + dy)
        height[i] = (height[i] as number) - cover * 0.7
        albedo[i] = (albedo[i] as number) - cover * 0.05
      }
  }
}

const MAKERS: Readonly<
  Record<Material, (height: Float32Array, albedo: Float32Array, random: () => number) => void>
> = { paper, leather, metal, stone, plaster }

/** Fibres in a paper tile, mineral grains in a stone tile, pores in a plaster tile. */
const PAPER_FIBRES = 1800
const STONE_GRAINS = 9000
const PLASTER_PORES = 500

const tiles = new Map<Material, Uint16Array>()

/**
 * The fine relief of a material as a TILE by TILE tile, half floats per texel: its slope along x
 * and y (px of height per px at grain 1, y down), its albedo factor around 1 and 0. The same on
 * every load; built once per material and page.
 */
export function tile(material: Material): Uint16Array {
  const cached = tiles.get(material)
  if (cached) return cached
  const height = new Float32Array(TILE * TILE)
  const albedo = new Float32Array(TILE * TILE).fill(1)
  MAKERS[material](height, albedo, rng(0x5eed + material.length * 7919))
  // Unit spread, then the material's own height.
  let sum = 0
  let sumSquares = 0
  for (const v of height) {
    sum += v
    sumSquares += v * v
  }
  const mean = sum / height.length
  const spread = Math.sqrt(Math.max(1e-9, sumSquares / height.length - mean * mean))
  const heightScale = FINISHES[material].relief / spread
  const toHalf = DataUtils.toHalfFloat
  const data = new Uint16Array(TILE * TILE * 4)
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const i = y * TILE + x
      const texel = i * 4
      const slopeX =
        ((height[at(x + 1, y)] as number) - (height[at(x - 1, y)] as number)) * 0.5 * heightScale
      const slopeY =
        ((height[at(x, y + 1)] as number) - (height[at(x, y - 1)] as number)) * 0.5 * heightScale
      data[texel] = toHalf(Math.max(-8, Math.min(8, slopeX)))
      data[texel + 1] = toHalf(Math.max(-8, Math.min(8, slopeY)))
      data[texel + 2] = toHalf(Math.max(0.3, Math.min(1.7, albedo[i] as number)))
      data[texel + 3] = toHalf(0)
    }
  tiles.set(material, data)
  return data
}

/** The relief of the letters over the raster's frame and a margin around it. */
export interface Press {
  /**
   * Half floats per texel, rows top down, for a depth of 1 em: the slope along x and y (px of
   * height per px, y down), the height in px (negative pressed in) and how far the spot sits
   * below its surroundings, px (for ambient occlusion).
   */
  readonly data: Uint16Array
  readonly width: number
  readonly height: number
  /** The field in box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  /** Largest font size, px. */
  readonly em: number
  /** The stamp's pad in box px, x, y, width, height, and its corner radius; zeros otherwise. */
  readonly pad: readonly [number, number, number, number, number]
  /** Highest point of the relief, px for a depth of 1 em. */
  readonly top: number
}

/**
 * Height for a depth of one unit at signed distance `d` (px, positive inside the letters) from
 * the glyph edge, with a bevel `b` px wide: raised letters with rounded shoulders, letters pressed
 * in with steep walls, a shallower impression with the paper pushed up into a lip around it.
 */
export function shape(style: Style, d: number, b: number): number {
  const bevel = Math.max(0.35, b)
  if (style === 'emboss' || style === 'stamp') return smoother(-0.45 * bevel, 1.05 * bevel, d)
  if (style === 'deboss') return -smoother(-0.25 * bevel, 0.85 * bevel, d)
  // The paper bends down outside the ink, so the walls are bare paper and the ink lies flat.
  const lip = Math.exp(-(((d + 1.9 * bevel) / bevel) ** 2))
  return -0.62 * smoother(-1.1 * bevel, 0.1 * bevel, d) + 0.035 * lip
}

/** Signed distance to a rounded rectangle, positive inside: x, y, width, height, radius. */
export function inRound(
  x: number,
  y: number,
  rect: readonly [number, number, number, number, number],
): number {
  const [rx, ry, rw, rh, r] = rect
  const qx = Math.abs(x - (rx + rw / 2)) - (rw / 2 - r)
  const qy = Math.abs(y - (ry + rh / 2)) - (rh / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  return -outside
}

/**
 * Builds the relief of the letters for `style`: a distance field of the glyphs, a profile over
 * `bevelEm` of each line's font size, the stamp's pad around the whole text, then the slope and
 * how sunken each spot is. Heights are in px for a depth of 1 em of each line's font size.
 */
export function press(layout: Raster, style: Style, bevelEm: number, ratio: number): Press {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const em = Math.max(1, ...layout.quads.map((line) => line.em))
  // A short stamp (a monogram, a word) gets a round seal: room for its circle around the text.
  const round = style === 'stamp' && frameWidth < (frameHeight + em * 0.6) * 2.4
  const margin =
    Math.ceil(
      style !== 'stamp'
        ? em * 0.45
        : round
          ? Math.max(frameWidth - frameHeight, 0) / 2 + em * 0.8
          : em * 0.8,
    ) + 4
  const scale = Math.min(
    2,
    ratio,
    MAX_SIDE / Math.max(frameWidth + 2 * margin, frameHeight + 2 * margin),
  )
  const mapWidth = Math.max(1, Math.ceil((frameWidth + 2 * margin) * scale))
  const mapHeight = Math.max(1, Math.ceil((frameHeight + 2 * margin) * scale))
  const fieldX = frameX - margin
  const fieldY = frameY - margin
  const canvas = document.createElement('canvas')
  canvas.width = mapWidth
  canvas.height = mapHeight
  // The raster's own scale, as raster() chose it.
  const rasterScale = layout.canvas.width / Math.max(1e-6, frameWidth)
  canvas
    .getContext('2d')
    ?.drawImage(
      layout.canvas,
      margin * scale,
      margin * scale,
      (layout.canvas.width / rasterScale) * scale,
      (layout.canvas.height / rasterScale) * scale,
    )
  const alpha = coverage(canvas, mapWidth, mapHeight)
  const field = distance(alpha, mapWidth, mapHeight)

  // The font size of each texel row: the line whose band holds it, or the nearest.
  const lines = [...layout.quads].sort((a, b) => a.y - b.y)
  const rowEm = new Float32Array(mapHeight)
  for (let y = 0; y < mapHeight; y++) {
    const rowY = fieldY + (y + 0.5) / scale
    let best = em
    let gap = Number.POSITIVE_INFINITY
    for (const line of lines) {
      const lineGap =
        rowY < line.y
          ? line.y - rowY
          : rowY > line.y + line.height
            ? rowY - line.y - line.height
            : 0
      if (lineGap < gap) {
        gap = lineGap
        best = line.em
      }
    }
    rowEm[y] = best
  }

  // The stamp's pad: a rounded block around the ink, its edge wavering like poured wax.
  let pad: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  let wobble: ((x: number, y: number) => number) | undefined
  if (style === 'stamp') {
    let inkLeft = Number.POSITIVE_INFINITY
    let inkTop = Number.POSITIVE_INFINITY
    let inkRight = Number.NEGATIVE_INFINITY
    let inkBottom = Number.NEGATIVE_INFINITY
    for (let y = 0; y < mapHeight; y++)
      for (let x = 0; x < mapWidth; x++)
        if ((alpha[y * mapWidth + x] as number) > 0.3) {
          inkLeft = Math.min(inkLeft, x)
          inkRight = Math.max(inkRight, x + 1)
          inkTop = Math.min(inkTop, y)
          inkBottom = Math.max(inkBottom, y + 1)
        }
    if (!Number.isFinite(inkLeft))
      [inkLeft, inkTop, inkRight, inkBottom] = [
        margin * scale,
        margin * scale,
        mapWidth - margin * scale,
        mapHeight - margin * scale,
      ]
    let padWidth = (inkRight - inkLeft) / scale + em * 0.72
    let padHeight = (inkBottom - inkTop) / scale + em * 0.6
    const padCentreX = fieldX + (inkLeft + inkRight) / 2 / scale
    const padCentreY = fieldY + (inkTop + inkBottom) / 2 / scale
    if (round) {
      padWidth = Math.max(padWidth, padHeight) + em * 0.2
      padHeight = padWidth
    }
    pad = [
      padCentreX - padWidth / 2,
      padCentreY - padHeight / 2,
      padWidth,
      padHeight,
      round ? padWidth / 2 : Math.min(padHeight / 2, padWidth / 2, em * 0.38),
    ]
    const [padX, padY] = pad
    const grid = lattice(9, 9, rng(0x5a1))
    wobble = (x, y) =>
      value(
        grid,
        ((x - padX) / Math.max(1, padWidth)) * TILE,
        ((y - padY) / Math.max(1, padHeight)) * TILE,
      )
  }

  const lift = new Float32Array(mapWidth * mapHeight)
  for (let y = 0; y < mapHeight; y++) {
    const lineEm = rowEm[y] as number
    // Wax letters are rounder than pressed ones.
    const bevel = Math.max(0, bevelEm) * lineEm * (style === 'stamp' ? 1.6 : 1)
    const boxY = fieldY + (y + 0.5) / scale
    for (let x = 0; x < mapWidth; x++) {
      const i = y * mapWidth + x
      const edgeDistance = -(field[i] as number) / scale
      const raised = shape(style, edgeDistance, bevel)
      let lifted = raised * lineEm
      if (style === 'stamp') {
        const boxX = fieldX + (x + 0.5) / scale
        const padDistance = inRound(boxX, boxY, pad) + (wobble?.(boxX, boxY) ?? 0) * em * 0.035
        // A low pool of wax, a raised rim just inside its edge, the letters standing on it.
        const pool = smoother(-0.05 * em, 0.07 * em, padDistance) * 0.32
        const rim = Math.exp(-(((padDistance - 0.12 * em) / (0.045 * em)) ** 2)) * 0.6
        lifted = (pool + rim + raised * 0.62) * em
      }
      lift[i] = lifted
    }
  }
  // Softened a little so ridges are round, then slopes by central differences.
  const bevelPx = Math.max(0, bevelEm) * em * scale
  const smooth = blur(lift, mapWidth, mapHeight, Math.max(0.5, bevelPx * 0.12))
  const wide = blur(smooth, mapWidth, mapHeight, Math.max(1, em * 0.06 * scale))
  const data = new Uint16Array(mapWidth * mapHeight * 4)
  let top = 0
  const toHalf = DataUtils.toHalfFloat
  for (let y = 0; y < mapHeight; y++) {
    const up = Math.max(0, y - 1) * mapWidth
    const down = Math.min(mapHeight - 1, y + 1) * mapWidth
    const row = y * mapWidth
    for (let x = 0; x < mapWidth; x++) {
      const i = row + x
      const left = row + Math.max(0, x - 1)
      const right = row + Math.min(mapWidth - 1, x + 1)
      const texel = i * 4
      data[texel] = toHalf((((smooth[right] as number) - (smooth[left] as number)) * scale) / 2)
      data[texel + 1] = toHalf(
        (((smooth[down + x] as number) - (smooth[up + x] as number)) * scale) / 2,
      )
      data[texel + 2] = toHalf(smooth[i] as number)
      top = Math.max(top, smooth[i] as number)
      data[texel + 3] = toHalf(Math.max(0, (wide[i] as number) - (smooth[i] as number)))
    }
  }
  // The margin is flat: the texture's edge texels hold zeros, so samples past it read flat.
  return {
    data,
    width: mapWidth,
    height: mapHeight,
    frame: [fieldX, fieldY, mapWidth / scale, mapHeight / scale],
    em,
    pad,
    top,
  }
}
