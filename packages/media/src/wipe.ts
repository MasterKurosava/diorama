// What frost shares between the photo and the pane over the page: the wipe mask, the frozen
// share of the glass and the shader of its edge.
import { ease } from '@dioramajs/effects/kit'
import { length, max, min, smoothstep, step } from 'three/tsl'
import type { Node } from 'three/webgpu'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V4 = Node<'vec4'>

/** Share of the brush radius that is fully clear; the rest feathers out. */
const CORE = 0.6
/** Below this a cell counts as fogged again and the mask is cleared. */
const FOGGED = 1 / 255
/** Width of the noisy edge of a clearing or a thaw that grows from a point, px. */
export const EDGE = 80

/**
 * Where the glass is wiped clear: `size` × `size` cells over the box, each 0 (fogged) to 1
 * (clear), y up. A stroke clears a band along the pointer's path; each step the clear areas fog
 * back over `refog` seconds. Deterministic: the same strokes and steps give the same mask.
 */
export class Wipe {
  readonly clear: Float32Array
  /** Clearest cell, 0..1. */
  peak = 0
  /** Some cell is still fogging back. */
  active = false

  constructor(readonly size: number) {
    this.clear = new Float32Array(size * size)
  }

  /** Clears the cells within `radius` px of the segment `a`–`b` (box px, y up, box `width` × `height`). */
  stroke(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    width: number,
    height: number,
  ): void {
    if (radius <= 0 || width <= 0 || height <= 0) return
    const cells = this.size
    const cellWidth = width / cells
    const cellHeight = height / cells
    const dx = bx - ax
    const dy = by - ay
    const length2 = dx * dx + dy * dy
    // The cells the stroke can reach: its bounds grown by the radius.
    const colFrom = Math.max(0, Math.floor((Math.min(ax, bx) - radius) / cellWidth))
    const colTo = Math.min(cells - 1, Math.floor((Math.max(ax, bx) + radius) / cellWidth))
    const rowFrom = Math.max(0, Math.floor((Math.min(ay, by) - radius) / cellHeight))
    const rowTo = Math.min(cells - 1, Math.floor((Math.max(ay, by) + radius) / cellHeight))
    for (let j = rowFrom; j <= rowTo; j++) {
      const cellY = (j + 0.5) * cellHeight
      for (let i = colFrom; i <= colTo; i++) {
        const cellX = (i + 0.5) * cellWidth
        // The nearest point of the segment, as a share of it, and the distance to it in radii.
        const along =
          length2 < 1e-6
            ? 0
            : Math.max(0, Math.min(1, ((cellX - ax) * dx + (cellY - ay) * dy) / length2))
        const distance = Math.hypot(cellX - ax - dx * along, cellY - ay - dy * along) / radius
        if (distance >= 1) continue
        const value = Math.min(1, (1 - distance) / (1 - CORE))
        const cell = j * cells + i
        if (value > (this.clear[cell] as number)) this.clear[cell] = value
        if (value > this.peak) this.peak = value
        this.active = true
      }
    }
  }

  /**
   * Fogs back by `seconds` out of `refog`: a fully clear cell is fogged after `refog` s. With a
   * `floor` a wiped cell fogs back only down to it, so a thin fog returns instead of all of it.
   */
  step(seconds: number, refog: number, floor = 0): void {
    if (refog <= 0 || !this.active) return
    const by = seconds / refog
    let peak = 0
    let active = false
    const { clear } = this
    for (let cell = 0; cell < clear.length; cell++) {
      const was = clear[cell] as number
      if (was > floor) {
        const fogged = was - by
        const next = floor > 0 ? Math.max(fogged, floor) : fogged > FOGGED ? fogged : 0
        clear[cell] = next
        if (next > floor) active = true
      }
      if ((clear[cell] as number) > peak) peak = clear[cell] as number
    }
    this.peak = peak
    this.active = active
  }

  /** A copy of this mask at `size` cells a side, nearest cell. */
  resized(size: number): Wipe {
    if (size === this.size) return this
    const out = new Wipe(size)
    for (let j = 0; j < size; j++) {
      const from = Math.floor(((j + 0.5) * this.size) / size) * this.size
      for (let i = 0; i < size; i++) {
        const value = this.clear[from + Math.floor(((i + 0.5) * this.size) / size)] as number
        out.clear[j * size + i] = value
        if (value > out.peak) out.peak = value
        if (value > 0) out.active = true
      }
    }
    return out
  }

  /** Writes the mask into the red channel of RGBA bytes. */
  write(out: Uint8Array): void {
    const { clear } = this
    for (let cell = 0; cell < clear.length; cell++) {
      out[4 * cell] = Math.round((clear[cell] as number) * 255)
    }
  }
}

/** Distance from (`x`, `y`) to the farthest corner of a `width` × `height` box, px. */
export const reach = (x: number, y: number, width: number, height: number): number =>
  Math.hypot(Math.max(x, width - x), Math.max(y, height - y))

/**
 * The frozen share of the glass. Ice grows in from the edges while `cover` rises and thaws
 * outwards from a point while it falls, each over `duration` seconds. A thaw that reaches
 * everything leaves bare glass, so the next frost grows from the edges again.
 */
export class Freeze {
  /** How far the ice has grown in from the edges, 0..1. */
  grow: number
  /** How far the thaw has spread from its point, 0..1. */
  thaw = 0

  constructor(cover: number) {
    this.grow = clamp01(cover)
  }

  /** The frozen share now. */
  get cover(): number {
    return this.grow * (1 - this.thaw)
  }

  /** Moves towards `target` by `seconds`; `still` jumps there. True while it still moves. */
  step(target: number, seconds: number, duration: number, still = false): boolean {
    const goal = clamp01(target)
    const by = still || duration <= 0 ? Number.POSITIVE_INFINITY : seconds / duration
    const now = this.cover
    if (goal > now + 1e-6) {
      // A thaw closes back first, then the ice grows on from the edges.
      if (this.thaw > 0) {
        this.thaw = Math.max(1 - goal / Math.max(this.grow, 1e-6), this.thaw - by, 0)
        if (this.thaw > 0) return true
      }
      if (this.grow < goal) this.grow = Math.min(goal, this.grow + by)
    } else if (goal < now - 1e-6) {
      const thaw = 1 - goal / this.grow
      this.thaw = Math.min(thaw, this.thaw + by)
      if (this.thaw >= 1 - 1e-6) {
        this.grow = 0
        this.thaw = 0
      }
    }
    return Math.abs(this.cover - goal) > 1e-6
  }

  /**
   * `(grown front, thaw radius px, x, y)` for {@link frozen}; the thaw starts at `x`, `y` (px,
   * y up). The thaw spreads fast at first, the way warmth clears a wide patch at once.
   */
  look(x: number, y: number, width: number, height: number): [number, number, number, number] {
    return [ease('cubicInOut', this.grow), thawRadius(this.thaw, x, y, width, height), x, y]
  }
}

/**
 * Radius of a thaw `progress` (0..1) of the way from `x`, `y` across a `width` × `height` box,
 * px. It eases out, so the warmth clears a wide patch early and the front slows towards the
 * edges.
 */
export const thawRadius = (
  progress: number,
  x: number,
  y: number,
  width: number,
  height: number,
): number =>
  progress > 0
    ? (1 - (1 - Math.min(1, progress)) ** 2) * (reach(x, y, width, height) + 2 * EDGE)
    : 0

const clamp01 = (value: number): number =>
  Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1))

/**
 * Ice of the glass at `point` (px, y up) of a `size` box: 1 frozen, 0 bare. `freeze` is
 * {@link Freeze.look}; `ragged` and `melt` are noise in 0..1 for the frost front and the thaw
 * edge. `wet` is the band of bare glass just inside the thaw, still running with water, `slush`
 * the ice just outside it, going soft; `front` the newest crystals of a growing frost.
 */
export function frozen(
  point: V2,
  size: V2,
  freeze: V4,
  ragged: F,
  melt: F,
): { ice: F; wet: F; slush: F; front: F } {
  const side = min(min(point.x, size.x.sub(point.x)), min(point.y, size.y.sub(point.y)))
  // 0 at the edge, 1 in the middle of the shorter side.
  const inward = side.div(max(min(size.x, size.y).mul(0.5), 1)).add(ragged.sub(0.5).mul(0.45))
  const front = freeze.x.mul(1.55).sub(0.25)
  const edge = smoothstep(front, front.sub(0.06), inward) as unknown as F
  const thawReach = freeze.y
  const fromThaw = length(point.sub(freeze.zw)).add(melt.sub(0.5).mul(EDGE))
  const thawing = step(0.5, thawReach)
  const thawed = smoothstep(thawReach, thawReach.sub(EDGE * 0.5), fromThaw).mul(
    thawing,
  ) as unknown as F
  // Only where there was ice to melt: a thaw that passes bare glass leaves it dry.
  const wet = smoothstep(thawReach.sub(EDGE * 2.2), thawReach.sub(EDGE * 0.4), fromThaw)
    .mul(thawed)
    .mul(thawing)
    .mul(edge) as unknown as F
  const slush = smoothstep(thawReach.add(EDGE * 1.6), thawReach, fromThaw).mul(
    thawing,
  ) as unknown as F
  // The newest crystals, just behind the growing front.
  const fresh = smoothstep(front.sub(0.14), front.sub(0.06), inward).mul(edge) as unknown as F
  return { ice: edge.mul(thawed.oneMinus()) as unknown as F, wet, slush, front: fresh }
}
