// The pieces of `shatter`: the ink box of a raster cut into seeded Voronoi cells biased to the
// glyphs, each cell with ink a convex polygon, where each piece flies and how it turns. Runs only
// in the shatter chunk.
import { rng } from '@dioramajs/effects/kit'
import type { Raster } from './raster'

/** What the pieces are made of. */
export type Style = 'glass' | 'stone' | 'paper'

/** Most corners of a shard: the shader reads this many edges. */
export const CORNERS = 12

/** One shard: a convex polygon of the text box with the ink it holds. */
export interface Shard {
  /** Corners in box px (y down), counterclockwise as seen on screen. */
  readonly poly: readonly number[]
  /** The point it turns around, box px: the middle of its ink, or of its area for glass. */
  readonly cx: number
  readonly cy: number
  /** Ink it holds, px². */
  readonly ink: number
  /** Square root of its area, px. */
  readonly size: number
  /** Mean linear colour of its ink. */
  readonly color: readonly [number, number, number]
}

/** The text cut into shards. */
export interface Cut {
  readonly shards: readonly Shard[]
  /** Ink bounds in box px: left, top, right, bottom. */
  readonly bounds: readonly [number, number, number, number]
}

export interface CutOptions {
  /** About this many cells; cells without ink are left out. */
  readonly pieces: number
  readonly seed: number
  /** Font size, px. */
  readonly em: number
  /** Cells are cut to the box of the ink they hold (stone, paper); glass keeps whole cells. */
  readonly trim: boolean
  /** Where a click struck, box px: smaller cells around it, in rings and rays like a hit pane. */
  readonly impact?: readonly [number, number]
  /** Share of the cells in the rings around the impact, and the first ring's radius in em. */
  readonly rings?: number
  readonly core?: number
}

const EMPTY: Cut = { shards: [], bounds: [0, 0, 0, 0] }

/** Pixels with less alpha than this, of 255, are not ink. */
const INK_ALPHA = 8

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** The part of a convex polygon (flat x, y list) where nx·x + ny·y <= c. */
export function clip(poly: readonly number[], nx: number, ny: number, c: number): number[] {
  const out: number[] = []
  const corners = poly.length / 2
  for (let i = 0; i < corners; i++) {
    const ax = poly[i * 2] as number
    const ay = poly[i * 2 + 1] as number
    const j = (i + 1) % corners
    const bx = poly[j * 2] as number
    const by = poly[j * 2 + 1] as number
    const overA = nx * ax + ny * ay - c
    const overB = nx * bx + ny * by - c
    if (overA <= 0) out.push(ax, ay)
    if ((overA < 0 && overB > 0) || (overA > 0 && overB < 0)) {
      const t = overA / (overA - overB)
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t)
    }
  }
  return out
}

/** Signed area of a polygon in a y-down frame: positive when counterclockwise on screen. */
export function area(poly: readonly number[]): number {
  let twice = 0
  const corners = poly.length / 2
  for (let i = 0; i < corners; i++) {
    const j = (i + 1) % corners
    twice += (poly[i * 2] as number) * (poly[j * 2 + 1] as number)
    twice -= (poly[j * 2] as number) * (poly[i * 2 + 1] as number)
  }
  return -twice / 2
}

/** Drops repeated corners and the flattest ones until at most `max` are left. */
function simplify(poly: number[], max: number): number[] {
  let p = poly
  const corners = (): number => p.length / 2
  // Corners closer than a hundredth of a px are one.
  for (let i = 0; i < corners() && corners() > 3; ) {
    const j = (i + 1) % corners()
    if (
      Math.hypot(
        (p[i * 2] as number) - (p[j * 2] as number),
        (p[i * 2 + 1] as number) - (p[j * 2 + 1] as number),
      ) < 0.01
    )
      p.splice(j * 2, 2)
    else i++
  }
  while (corners() > max) {
    // The corner whose triangle with its neighbours has the least area is the flattest.
    let flattest = 0
    let least = Number.POSITIVE_INFINITY
    const count = corners()
    for (let i = 0; i < count; i++) {
      const prev = (i + count - 1) % count
      const next = (i + 1) % count
      const twiceArea = Math.abs(
        ((p[i * 2] as number) - (p[prev * 2] as number)) *
          ((p[next * 2 + 1] as number) - (p[prev * 2 + 1] as number)) -
          ((p[next * 2] as number) - (p[prev * 2] as number)) *
            ((p[i * 2 + 1] as number) - (p[prev * 2 + 1] as number)),
      )
      if (twiceArea < least) {
        least = twiceArea
        flattest = i
      }
    }
    p = [...p.slice(0, flattest * 2), ...p.slice(flattest * 2 + 2)]
  }
  return p
}

/** Seeds of the cells: around the impact in rings, the rest on the glyphs more than between them. */
export function seeds(
  alpha: (x: number, y: number) => number,
  bounds: readonly [number, number, number, number],
  options: CutOptions,
): number[] {
  const [x0, y0, x1, y1] = bounds
  const width = Math.max(1, x1 - x0)
  const height = Math.max(1, y1 - y0)
  const wanted = Math.max(2, Math.round(options.pieces))
  const random = rng(Math.round(options.seed) * 7919 + 17)
  const out: number[] = []
  // Seeds closer than this make slivers.
  const gap = 0.3 * Math.sqrt((width * height) / wanted)
  const free = (x: number, y: number, room: number): boolean => {
    for (let i = 0; i < out.length; i += 2)
      if (Math.hypot((out[i] as number) - x, (out[i + 1] as number) - y) < room) return false
    return true
  }
  const inside = (x: number, y: number): boolean => x > x0 && x < x1 && y > y0 && y < y1
  const hit = options.impact
  if (hit) {
    // Rings around the point of impact, each wider and with more seeds, turned half a step from
    // the last: the cells between them are the wedges of a struck pane.
    const firstRadius = Math.max(options.em * (options.core ?? 0.16), 5)
    const far = Math.hypot(width, height) + firstRadius
    const budget = Math.round(wanted * (options.rings ?? 0.55))
    const turn = random() * Math.PI * 2
    let placed = 0
    for (let ringIndex = 0; placed < budget; ringIndex++) {
      const ring = firstRadius * 1.7 ** ringIndex
      if (ring > far) break
      const perRing = 5 + 2 * ringIndex
      for (let m = 0; m < perRing && placed < budget; m++) {
        const radius = ring * (0.86 + 0.28 * random())
        const halfStep = 0.5 * (ringIndex % 2)
        const angle = turn + ((m + halfStep + (random() - 0.5) * 0.5) / perRing) * Math.PI * 2
        const x = (hit[0] as number) + Math.cos(angle) * radius
        const y = (hit[1] as number) + Math.sin(angle) * radius
        if (!inside(x, y) || !free(x, y, Math.min(gap, ring * 0.3))) continue
        out.push(x, y)
        placed++
      }
    }
  }
  // The rest at random, mostly on ink: cells between the letters hold nothing and are left out.
  for (let tries = 0; out.length < wanted * 2 && tries < wanted * 60; tries++) {
    const x = x0 + random() * width
    const y = y0 + random() * height
    const keep = alpha(x, y) > 0.25 ? 0.92 : 0.1
    if (random() > keep || !free(x, y, gap)) continue
    out.push(x, y)
  }
  return out
}

/**
 * Cuts the ink of a raster into Voronoi cells of `seeds`: each cell with ink becomes a shard with
 * its mean colour, cut to the box of its ink when `trim` is set. `image` is the raster's pixels.
 */
export function cut(raster: Raster, image: ImageData | undefined, options: CutOptions): Cut {
  if (!image) return EMPTY
  const { data, width, height } = image
  const [frameX, frameY, frameWidth, frameHeight] = raster.frame
  // Image px per box px.
  const scaleX = width / (frameWidth || 1)
  const scaleY = height / (frameHeight || 1)
  // Ink bounds from the pixels.
  let inkLeft = Number.POSITIVE_INFINITY
  let inkTop = Number.POSITIVE_INFINITY
  let inkRight = Number.NEGATIVE_INFINITY
  let inkBottom = Number.NEGATIVE_INFINITY
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      if ((data[(row * width + column) * 4 + 3] as number) < INK_ALPHA) continue
      if (column < inkLeft) inkLeft = column
      if (column > inkRight) inkRight = column
      if (row < inkTop) inkTop = row
      if (row > inkBottom) inkBottom = row
    }
  if (inkRight < inkLeft) return EMPTY
  // In box px, a px to spare.
  const bounds = [
    frameX + inkLeft / scaleX - 1,
    frameY + inkTop / scaleY - 1,
    frameX + (inkRight + 1) / scaleX + 1,
    frameY + (inkBottom + 1) / scaleY + 1,
  ] as const
  /** Offset of the image pixel under a box point, -1 outside the image. */
  const pixel = (x: number, y: number): number => {
    const column = Math.floor((x - frameX) * scaleX)
    const row = Math.floor((y - frameY) * scaleY)
    return column < 0 || row < 0 || column >= width || row >= height
      ? -1
      : (row * width + column) * 4
  }
  const alpha = (x: number, y: number): number => {
    const offset = pixel(x, y)
    return offset < 0 ? 0 : (data[offset + 3] as number) / 255
  }
  const points = seeds(alpha, bounds, options)
  const count = points.length / 2
  const [x0, y0, x1, y1] = bounds
  const rect = [x0, y0, x0, y1, x1, y1, x1, y0]
  const shards: Shard[] = []
  // Seed indices, sorted again by distance for each cell.
  const order = Array.from({ length: count }, (_, i) => i)
  // Ink per px² below this is a crumb, not a shard.
  const crumb = Math.max(4, options.em * options.em * 0.0012)
  // One sample per px, a fine grid for small text.
  const step = Math.min(1, Math.max(0.5, options.em / 40))
  for (let i = 0; i < count; i++) {
    // The Voronoi cell of seed i: the rect clipped by the half plane of each nearer seed.
    const ax = points[i * 2] as number
    const ay = points[i * 2 + 1] as number
    order.sort(
      (a, b) =>
        Math.hypot((points[a * 2] as number) - ax, (points[a * 2 + 1] as number) - ay) -
        Math.hypot((points[b * 2] as number) - ax, (points[b * 2 + 1] as number) - ay),
    )
    let poly = rect
    for (const j of order) {
      if (j === i) continue
      const bx = points[j * 2] as number
      const by = points[j * 2 + 1] as number
      const distance = Math.hypot(bx - ax, by - ay)
      // The cell lies within its farthest corner: seeds past twice that cannot cut it.
      let reach = 0
      for (let k = 0; k < poly.length; k += 2)
        reach = Math.max(reach, Math.hypot((poly[k] as number) - ax, (poly[k + 1] as number) - ay))
      if (distance > reach * 2) break
      const nx = bx - ax
      const ny = by - ay
      poly = clip(poly, nx, ny, nx * ((ax + bx) / 2) + ny * ((ay + by) / 2))
      if (poly.length < 6) break
    }
    if (poly.length < 6) continue

    // The ink inside, sampled every `step` px.
    let polyLeft = Number.POSITIVE_INFINITY
    let polyTop = Number.POSITIVE_INFINITY
    let polyRight = Number.NEGATIVE_INFINITY
    let polyBottom = Number.NEGATIVE_INFINITY
    for (let k = 0; k < poly.length; k += 2) {
      polyLeft = Math.min(polyLeft, poly[k] as number)
      polyRight = Math.max(polyRight, poly[k] as number)
      polyTop = Math.min(polyTop, poly[k + 1] as number)
      polyBottom = Math.max(polyBottom, poly[k + 1] as number)
    }
    // Per edge: the inward normal and its offset, as nx, ny, c.
    const edges: number[] = []
    const corners = poly.length / 2
    for (let k = 0; k < corners; k++) {
      const a = k * 2
      const b = ((k + 1) % corners) * 2
      // The normal points in: clipping keeps the rect's winding, counterclockwise on screen.
      const ex = (poly[b] as number) - (poly[a] as number)
      const ey = (poly[b + 1] as number) - (poly[a + 1] as number)
      const nx = ey
      const ny = -ex
      edges.push(nx, ny, nx * (poly[a] as number) + ny * (poly[a + 1] as number))
    }
    const sign = area(poly) > 0 ? 1 : -1
    // Alpha, and alpha weighted sums of x, y and the linear colour.
    let sum = 0
    let sumX = 0
    let sumY = 0
    let red = 0
    let green = 0
    let blue = 0
    // Box of the inked samples.
    let left = Number.POSITIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (let y = Math.floor(polyTop) + step / 2; y < polyBottom; y += step)
      for (let x = Math.floor(polyLeft) + step / 2; x < polyRight; x += step) {
        let inside = true
        for (let k = 0; k < edges.length && inside; k += 3)
          inside =
            sign *
              ((edges[k] as number) * x +
                (edges[k + 1] as number) * y -
                (edges[k + 2] as number)) >=
            0
        if (!inside) continue
        const offset = pixel(x, y)
        if (offset < 0) continue
        const cover = (data[offset + 3] as number) / 255
        if (cover < 0.03) continue
        sum += cover
        sumX += cover * x
        sumY += cover * y
        red += cover * toLinear((data[offset] as number) / 255)
        green += cover * toLinear((data[offset + 1] as number) / 255)
        blue += cover * toLinear((data[offset + 2] as number) / 255)
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    const ink = sum * step * step
    if (ink < crumb) continue
    if (options.trim) {
      const pad = step + 1.5
      poly = clip(poly, -1, 0, -(left - pad))
      poly = clip(poly, 1, 0, right + pad)
      poly = clip(poly, 0, -1, -(top - pad))
      poly = clip(poly, 0, 1, bottom + pad)
      if (poly.length < 6) continue
    }
    poly = simplify(poly, CORNERS)
    const signedArea = area(poly)
    // Counterclockwise on screen: the walls face out.
    if (signedArea < 0) {
      const back: number[] = []
      for (let k = poly.length - 2; k >= 0; k -= 2)
        back.push(poly[k] as number, poly[k + 1] as number)
      poly = back
    }
    // Stone and paper turn around the middle of their ink.
    let cx = sumX / sum
    let cy = sumY / sum
    if (!options.trim) {
      // The middle of the area: a pane turns around its own middle.
      let twiceArea = 0
      let areaX = 0
      let areaY = 0
      const sides = poly.length / 2
      for (let k = 0; k < sides; k++) {
        const j = (k + 1) % sides
        const xa = poly[k * 2] as number
        const ya = poly[k * 2 + 1] as number
        const xb = poly[j * 2] as number
        const yb = poly[j * 2 + 1] as number
        const cross = xa * yb - xb * ya
        twiceArea += cross
        areaX += (xa + xb) * cross
        areaY += (ya + yb) * cross
      }
      if (Math.abs(twiceArea) > 1e-6) {
        cx = areaX / (3 * twiceArea)
        cy = areaY / (3 * twiceArea)
      }
    }
    shards.push({
      poly,
      cx,
      cy,
      ink,
      size: Math.sqrt(Math.abs(signedArea)),
      color: [red / sum, green / sum, blue / sum],
    })
  }
  return { shards, bounds }
}

/** Where each shard flies once the text breaks, at force, spin and gravity 1. */
export interface Flight {
  /** Per shard: velocity in px/s (x, y up, z toward the viewer) and its delay, s. */
  readonly velocity: Float32Array
  /** Per shard: a unit axis it tumbles around and its rate, rad/s. */
  readonly spin: Float32Array
  /** Per shard: two phases, a rate and a random 0..1 for the flutter of paper. */
  readonly sway: Float32Array
}

/** Drag per second in the page plane and in depth, and gravity in px/s², per style. */
export const AIR: Readonly<Record<Style, { drag: number; depth: number; fall: number }>> = {
  glass: { drag: 0.3, depth: 1.2, fall: 2300 },
  stone: { drag: 0.4, depth: 1.5, fall: 2600 },
  paper: { drag: 2.6, depth: 2.6, fall: 760 },
}

/** Speed of the crack across the text, px/s: the far pieces let go a moment later. */
export const CRACK = 4200

/**
 * How each shard leaves `origin` (box px): out from it, faster close by, a little up and toward
 * the viewer, tumbling away from the blow. `reach` caps the depth so no piece passes the camera.
 */
export function launch(
  pieces: Cut,
  origin: readonly [number, number],
  style: Style,
  em: number,
  reach: number,
  seed: number,
): Flight {
  const count = Math.max(1, pieces.shards.length)
  const velocity = new Float32Array(count * 4)
  const spin = new Float32Array(count * 4)
  const sway = new Float32Array(count * 4)
  const random = rng(Math.round(seed) * 104729 + 3)
  const [originX, originY] = origin
  // Heavier pieces fly slower.
  const heavy = style === 'stone' ? 0.7 : style === 'paper' ? 0.55 : 1
  const air = AIR[style]
  pieces.shards.forEach((shard, i) => {
    const dx = shard.cx - originX
    const dy = shard.cy - originY
    const distance = Math.hypot(dx, dy)
    // Straight out from the blow; a piece right on it goes any way.
    const heading = distance > 1e-3 ? Math.atan2(-dy, dx) : random() * Math.PI * 2
    const ux = Math.cos(heading)
    const uy = Math.sin(heading)
    // 1 at the blow, falling off over about an em and a half.
    const near = 1 / (1 + distance / (em * 1.4))
    const speed = (150 + 520 * near) * (0.75 + 0.5 * random()) * heavy
    let vx = ux * speed + (random() - 0.5) * 120 * heavy
    let vy = uy * speed + (120 + 200 * random()) * heavy
    // Mostly toward the viewer, some into the page; never past the camera.
    const toward = random() < 0.82 ? 1 : -0.4
    const vz = Math.min(reach * air.depth, (150 + 380 * random()) * (0.35 + near) * heavy) * toward
    if (style === 'paper') {
      vx *= 1.6
      vy *= 1.4
    }
    velocity.set([vx, vy, vz, distance / CRACK], i * 4)
    // Tumbling away from the blow: around the axis across the way it flies, with some wobble.
    let ax = -uy + (random() - 0.5) * 1.2
    let ay = ux + (random() - 0.5) * 1.2
    let az = (random() - 0.5) * 0.9
    const len = Math.hypot(ax, ay, az) || 1
    ax /= len
    ay /= len
    az /= len
    // Small chips spin faster than large slabs.
    const rate =
      (4 + 7 * random()) *
      Math.min(1.8, Math.sqrt(em / Math.max(8, shard.size))) *
      (style === 'stone' ? 0.75 : 1)
    spin.set([ax, ay, az, rate * (random() < 0.15 ? -1 : 1)], i * 4)
    sway.set([random() * Math.PI * 2, random() * Math.PI * 2, 4 + 3 * random(), random()], i * 4)
  })
  return { velocity, spin, sway }
}

/** The live magnitudes a pose reads. */
export interface Strength {
  readonly force: number
  readonly spin: number
  readonly gravity: number
  /** Multiplies the drag of the air, in the page plane and in depth. */
  readonly drag?: number
}

/** Values per shard in the state map: offset and how far it has come loose, turn, bend and alpha. */
export const TEXELS = 3

const smoothstep = (from: number, to: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/**
 * Writes the pose of shard `i` at `time` seconds after the break into `out` (TEXELS RGBA texels):
 * offset in px (x, y up, z toward the viewer) and how far it has come loose; its turn as a
 * quaternion; the bend of paper (curvature 1/px and the angle of its axis) and its alpha.
 */
export function pose(
  out: Float32Array,
  i: number,
  flight: Flight,
  time: number,
  style: Style,
  size: number,
  em: number,
  strength: Strength,
): void {
  const at = i * 4 * TEXELS
  const v = i * 4
  const delay = flight.velocity[v + 3] as number
  // Seconds since this piece let go.
  const t = Math.max(0, time - delay)
  const air = AIR[style]
  const force = Math.max(0, strength.force)
  const thick = Math.max(1e-3, strength.drag ?? 1)
  const drag = air.drag * thick
  // Distance per unit of start velocity under linear drag.
  const along = (1 - Math.exp(-drag * t)) / drag
  const fall = air.fall * Math.max(0, strength.gravity)
  let x = (flight.velocity[v] as number) * force * along
  const y = (flight.velocity[v + 1] as number) * force * along - (fall / drag) * (t - along)
  const depth = air.depth * thick
  const z = ((flight.velocity[v + 2] as number) * force * (1 - Math.exp(-depth * t))) / depth
  const spinRate = flight.spin[v + 3] as number
  let angle = spinRate * Math.max(0, strength.spin) * t
  let ax = flight.spin[v] as number
  let ay = flight.spin[v + 1] as number
  let az = flight.spin[v + 2] as number
  let bend = 0
  let bendAngle = 0
  if (style === 'paper') {
    // A falling leaf: it rocks around a level axis and sways side to side as it sinks, and bends.
    const swayPhase = flight.sway[v] as number
    const axisPhase = flight.sway[v + 1] as number
    const rate = flight.sway[v + 2] as number
    const jitter = flight.sway[v + 3] as number
    const settle = 1 - Math.exp(-2.5 * t)
    x += Math.sin(rate * t + swayPhase) * em * 0.45 * settle * Math.min(1, strength.gravity + 0.2)
    const tumble = spinRate * Math.max(0, strength.spin) * 0.35 * (1 - Math.exp(-1.5 * t))
    const rock =
      Math.sin(rate * t + swayPhase + Math.PI / 2) * 0.9 * settle * Math.min(1.5, strength.spin)
    angle = tumble + rock
    ax = Math.cos(axisPhase)
    ay = Math.sin(axisPhase) * 0.35
    az = 0.25 * (jitter - 0.5)
    const len = Math.hypot(ax, ay, az) || 1
    ax /= len
    ay /= len
    az /= len
    bend =
      ((0.6 + 0.4 * Math.sin(rate * 1.7 * t + axisPhase)) * 1.6 * Math.min(1, t * 3)) /
      Math.max(size, 8)
    bendAngle = axisPhase + Math.PI / 2
  }
  const halfSin = Math.sin(angle / 2)
  const loose = smoothstep(0, 0.07, t) * (time > delay ? 1 : 0)
  out[at] = x
  out[at + 1] = y
  out[at + 2] = z
  out[at + 3] = loose
  out[at + 4] = ax * halfSin
  out[at + 5] = ay * halfSin
  out[at + 6] = az * halfSin
  out[at + 7] = Math.cos(angle / 2)
  out[at + 8] = bend
  out[at + 9] = bendAngle
  out[at + 10] = 1
  out[at + 11] = 0
}

/** Seconds a piece flies before it has faded out, per style. */
export const LIFE: Readonly<Record<Style, number>> = { glass: 2, stone: 1.9, paper: 3.2 }

/** Alpha of a piece `time` seconds after its break, fading over the last half second of its life. */
export const fadeOf = (style: Style, time: number): number =>
  1 - smoothstep(LIFE[style] - 0.55, LIFE[style], time)
