// Rigid boxes for `physics`: gravity, a room of six walls, box-box contacts with friction and
// restitution, a joint that drags a box by a point, and sleeping. Sequential impulses on a fixed
// step, a separate pass of pseudo velocities for penetration, so pushing apart adds no bounce.
// Units are CSS px and seconds, y up, z toward the viewer. Runs only in the physics chunk.

/** The walls: the floor at y0, the ceiling at y1, the sides at x0 and x1, the page at z0. */
export interface Room {
  x0: number
  x1: number
  y0: number
  y1: number
  z0: number
  z1: number
}

/** What a step reads: gravity in px/s², restitution and friction. */
export interface Matter {
  readonly gravity: number
  readonly bounce: number
  readonly friction: number
}

/** Mass per px³: only ratios matter, this keeps the numbers small. */
const DENSITY = 1e-4
/** Velocity and position passes per step. */
const ITERATIONS = 16
const PUSHES = 4
/** Penetration left alone, px, and the share of the rest pushed out per step. */
const SLOP = 0.5
const BETA = 0.25
/** Fastest push out of an overlap, px/s. */
const PUSH = 600
/** Contacts this far apart, px, are kept: the speed that closes the gap is allowed, no more. */
const MARGIN = 1
/** Approach speed below which nothing bounces, px/s: resting contacts stay put. */
const BOUNCE_MIN = 70
/** Air: linear and angular drag per second. */
const DRAG = 0.04
const SPIN_DRAG = 0.35
/** Speed limits, px/s and rad/s: a thrown box never passes through a thin one in a step. */
const MAX_SPEED = 3200
const MAX_SPIN = 28
/** Slow enough to sleep, px/s and rad/s, for this long, s. */
const REST_SPEED = 7
const REST_SPIN = 0.09
const REST_TIME = 0.45
/** A box that hits a sleeping one faster than this wakes it, px/s. */
const WAKE = 45
/** The drag joint: frequency, damping ratio, and its strongest pull in px/s² of the box. */
const JOINT = { hz: 7, ratio: 0.85, pull: 60000 } as const

/** A box: pose, velocities, half extents, inverse mass and inertia. */
export class Box {
  /** Centre, px. */
  x = 0
  y = 0
  z = 0
  /** Orientation as a quaternion. */
  qx = 0
  qy = 0
  qz = 0
  qw = 1
  /** Linear velocity, px/s. */
  vx = 0
  vy = 0
  vz = 0
  /** Angular velocity, rad/s. */
  wx = 0
  wy = 0
  wz = 0
  /** Half extents, px. */
  hx = 1
  hy = 1
  hz = 1
  /** Inverse mass. */
  invMass = 1
  /** Inverse inertia about the box's own axes. */
  invInertiaX = 1
  invInertiaY = 1
  invInertiaZ = 1
  /** A static collider the solver never moves: a letter in its place. */
  pinned = false
  /** Out of the world: it moves on a path of its own and touches nothing. */
  ghost = false
  asleep = false
  /** Seconds it has been slow. */
  still = 0
  /** Rotation, row major: column k is the box's axis k in the world. */
  readonly m: Float64Array = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  /** Moved by the solver this step. */
  solved = false
  // Pseudo velocities of the position pass: linear shift and angular turn.
  shiftX = 0
  shiftY = 0
  shiftZ = 0
  turnX = 0
  turnY = 0
  turnZ = 0

  constructor(hx: number, hy: number, hz: number) {
    this.resize(hx, hy, hz)
  }

  resize(hx: number, hy: number, hz: number): void {
    this.hx = Math.max(hx, 0.5)
    this.hy = Math.max(hy, 0.5)
    this.hz = Math.max(hz, 0.5)
    const mass = 8 * this.hx * this.hy * this.hz * DENSITY
    const xx = this.hx * this.hx
    const yy = this.hy * this.hy
    const zz = this.hz * this.hz
    this.invMass = 1 / mass
    this.invInertiaX = 3 / (mass * (yy + zz))
    this.invInertiaY = 3 / (mass * (xx + zz))
    this.invInertiaZ = 3 / (mass * (xx + yy))
  }

  /** Writes the rotation matrix from the quaternion. */
  orient(): void {
    const { qx: x, qy: y, qz: z, qw: w, m } = this
    m[0] = 1 - 2 * (y * y + z * z)
    m[1] = 2 * (x * y - z * w)
    m[2] = 2 * (x * z + y * w)
    m[3] = 2 * (x * y + z * w)
    m[4] = 1 - 2 * (x * x + z * z)
    m[5] = 2 * (y * z - x * w)
    m[6] = 2 * (x * z - y * w)
    m[7] = 2 * (y * z + x * w)
    m[8] = 1 - 2 * (x * x + y * y)
  }

  /** Wakes it: it moves again on the next step. */
  wake(): void {
    this.asleep = false
    this.still = 0
  }

  /** Stops it where it is. */
  halt(): void {
    this.vx = this.vy = this.vz = 0
    this.wx = this.wy = this.wz = 0
  }
}

/** The world inverse inertia of `b` times (x, y, z), into `out`. */
function spin(b: Box, x: number, y: number, z: number, out: number[]): void {
  if (!b.solved) {
    out[0] = out[1] = out[2] = 0
    return
  }
  const m = b.m
  // Into the box's frame, scaled, and back.
  const u = ((m[0] as number) * x + (m[3] as number) * y + (m[6] as number) * z) * b.invInertiaX
  const v = ((m[1] as number) * x + (m[4] as number) * y + (m[7] as number) * z) * b.invInertiaY
  const w = ((m[2] as number) * x + (m[5] as number) * y + (m[8] as number) * z) * b.invInertiaZ
  out[0] = (m[0] as number) * u + (m[1] as number) * v + (m[2] as number) * w
  out[1] = (m[3] as number) * u + (m[4] as number) * v + (m[5] as number) * w
  out[2] = (m[6] as number) * u + (m[7] as number) * v + (m[8] as number) * w
}

// Scratch vectors, so the solver allocates nothing per contact.
const spinOfMass = [0, 0, 0]
const spinOfPush = [0, 0, 0]

/** One point of contact: `a` is pushed along the normal, away from `b` (or a wall). */
class Contact {
  a!: Box
  b: Box | null = null
  /** The point, px. */
  pointX = 0
  pointY = 0
  pointZ = 0
  /** The normal, pushing `a` out. */
  nx = 0
  ny = 0
  nz = 0
  /** Overlap, px; negative for a gap. */
  depth = 0
  /** Arms from the centres of `a` and `b` to the point. */
  armAX = 0
  armAY = 0
  armAZ = 0
  armBX = 0
  armBY = 0
  armBZ = 0
  /** Two tangents across the normal, for friction. */
  tangentUX = 0
  tangentUY = 0
  tangentUZ = 0
  tangentTX = 0
  tangentTY = 0
  tangentTZ = 0
  /** Effective masses along the normal and the two tangents. */
  massN = 0
  massU = 0
  massT = 0
  /** Normal speed the solve aims at: the bounce, or closing a gap. */
  target = 0
  /** Push out speed of the position pass. */
  bias = 0
  /** Impulses summed over the iterations: normal, tangents and the position pass. */
  impulseN = 0
  impulseU = 0
  impulseT = 0
  impulseP = 0
}

/** The effective mass along (x, y, z) of a contact. */
function massAlong(c: Contact, x: number, y: number, z: number): number {
  const a = c.a
  const b = c.b
  let inverse = 0
  if (a.solved) {
    const cx = c.armAY * z - c.armAZ * y
    const cy = c.armAZ * x - c.armAX * z
    const cz = c.armAX * y - c.armAY * x
    spin(a, cx, cy, cz, spinOfMass)
    inverse +=
      a.invMass +
      cx * (spinOfMass[0] as number) +
      cy * (spinOfMass[1] as number) +
      cz * (spinOfMass[2] as number)
  }
  if (b?.solved) {
    const cx = c.armBY * z - c.armBZ * y
    const cy = c.armBZ * x - c.armBX * z
    const cz = c.armBX * y - c.armBY * x
    spin(b, cx, cy, cz, spinOfMass)
    inverse +=
      b.invMass +
      cx * (spinOfMass[0] as number) +
      cy * (spinOfMass[1] as number) +
      cz * (spinOfMass[2] as number)
  }
  return inverse > 0 ? 1 / inverse : 0
}

/** Relative velocity at the contact along (x, y, z): of the real or the pseudo velocities. */
function along(c: Contact, x: number, y: number, z: number, pseudo: boolean): number {
  const a = c.a
  const b = c.b
  let vx = 0
  let vy = 0
  let vz = 0
  if (a.solved) {
    const wx = pseudo ? a.turnX : a.wx
    const wy = pseudo ? a.turnY : a.wy
    const wz = pseudo ? a.turnZ : a.wz
    vx += (pseudo ? a.shiftX : a.vx) + wy * c.armAZ - wz * c.armAY
    vy += (pseudo ? a.shiftY : a.vy) + wz * c.armAX - wx * c.armAZ
    vz += (pseudo ? a.shiftZ : a.vz) + wx * c.armAY - wy * c.armAX
  }
  if (b?.solved) {
    const wx = pseudo ? b.turnX : b.wx
    const wy = pseudo ? b.turnY : b.wy
    const wz = pseudo ? b.turnZ : b.wz
    vx -= (pseudo ? b.shiftX : b.vx) + wy * c.armBZ - wz * c.armBY
    vy -= (pseudo ? b.shiftY : b.vy) + wz * c.armBX - wx * c.armBZ
    vz -= (pseudo ? b.shiftZ : b.vz) + wx * c.armBY - wy * c.armBX
  }
  return vx * x + vy * y + vz * z
}

/** Applies the impulse j·(x, y, z) at the contact, to the real or the pseudo velocities. */
function push(c: Contact, j: number, x: number, y: number, z: number, pseudo: boolean): void {
  const a = c.a
  const b = c.b
  const px = j * x
  const py = j * y
  const pz = j * z
  const turn = spinOfPush
  if (a.solved) {
    spin(
      a,
      c.armAY * pz - c.armAZ * py,
      c.armAZ * px - c.armAX * pz,
      c.armAX * py - c.armAY * px,
      turn,
    )
    if (pseudo) {
      a.shiftX += a.invMass * px
      a.shiftY += a.invMass * py
      a.shiftZ += a.invMass * pz
      a.turnX += turn[0] as number
      a.turnY += turn[1] as number
      a.turnZ += turn[2] as number
    } else {
      a.vx += a.invMass * px
      a.vy += a.invMass * py
      a.vz += a.invMass * pz
      a.wx += turn[0] as number
      a.wy += turn[1] as number
      a.wz += turn[2] as number
    }
  }
  if (b?.solved) {
    spin(
      b,
      c.armBY * pz - c.armBZ * py,
      c.armBZ * px - c.armBX * pz,
      c.armBX * py - c.armBY * px,
      turn,
    )
    if (pseudo) {
      b.shiftX -= b.invMass * px
      b.shiftY -= b.invMass * py
      b.shiftZ -= b.invMass * pz
      b.turnX -= turn[0] as number
      b.turnY -= turn[1] as number
      b.turnZ -= turn[2] as number
    } else {
      b.vx -= b.invMass * px
      b.vy -= b.invMass * py
      b.vz -= b.invMass * pz
      b.wx -= turn[0] as number
      b.wy -= turn[1] as number
      b.wz -= turn[2] as number
    }
  }
}

/** The part of a convex polygon (flat x, y, z list) where nx·x + ny·y + nz·z <= c. */
function clip(poly: number[], nx: number, ny: number, nz: number, c: number): number[] {
  const out: number[] = []
  const corners = poly.length / 3
  for (let i = 0; i < corners; i++) {
    const j = (i + 1) % corners
    const ax = poly[i * 3] as number
    const ay = poly[i * 3 + 1] as number
    const az = poly[i * 3 + 2] as number
    const bx = poly[j * 3] as number
    const by = poly[j * 3 + 1] as number
    const bz = poly[j * 3 + 2] as number
    const overA = nx * ax + ny * ay + nz * az - c
    const overB = nx * bx + ny * by + nz * bz - c
    if (overA <= 0) out.push(ax, ay, az)
    if ((overA < 0 && overB > 0) || (overA > 0 && overB < 0)) {
      const t = overA / (overA - overB)
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t)
    }
  }
  return out
}

/** Takes one contact point: `a` is pushed along the normal (nx, ny, nz) by `depth` px. */
type Add = (
  a: Box,
  b: Box | null,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  depth: number,
) => void

/** The box's axis `k` in the world. */
const axis = (b: Box, k: number): [number, number, number] => [
  b.m[k] as number,
  b.m[3 + k] as number,
  b.m[6 + k] as number,
]
const half = (b: Box, k: number): number => (k === 0 ? b.hx : k === 1 ? b.hy : b.hz)
const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] as number) * (b[0] as number) +
  (a[1] as number) * (b[1] as number) +
  (a[2] as number) * (b[2] as number)

/**
 * Face contact: the face of `ref` along its axis `k` against the face of `inc` that looks back
 * at it, clipped to the reference face. `refIsA` says which box the normal pushes.
 */
function faces(ref: Box, inc: Box, k: number, refIsA: boolean, add: Add): void {
  const between = [inc.x - ref.x, inc.y - ref.y, inc.z - ref.z]
  const refAxis = axis(ref, k)
  const side = dot(between, refAxis) >= 0 ? 1 : -1
  const nf: [number, number, number] = [refAxis[0] * side, refAxis[1] * side, refAxis[2] * side]
  // The incident face: the one of `inc` most against the reference normal.
  let j = 0
  let most = -1
  for (let i = 0; i < 3; i++) {
    const facing = Math.abs(dot(axis(inc, i), nf))
    if (facing > most) {
      most = facing
      j = i
    }
  }
  const incAxis = axis(inc, j)
  const incSide = dot(incAxis, nf) > 0 ? -1 : 1
  const toFace = half(inc, j) * incSide
  // Centre of the incident face and its two in-plane axes with their half extents.
  const cx = inc.x + incAxis[0] * toFace
  const cy = inc.y + incAxis[1] * toFace
  const cz = inc.z + incAxis[2] * toFace
  const u = axis(inc, (j + 1) % 3)
  const v = axis(inc, (j + 2) % 3)
  const hu = half(inc, (j + 1) % 3)
  const hv = half(inc, (j + 2) % 3)
  let poly: number[] = []
  for (const [a, b] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const) {
    poly.push(
      cx + u[0] * hu * a + v[0] * hv * b,
      cy + u[1] * hu * a + v[1] * hv * b,
      cz + u[2] * hu * a + v[2] * hv * b,
    )
  }
  // Clipped by the side planes of the reference face.
  for (const q of [(k + 1) % 3, (k + 2) % 3]) {
    const sideAxis = axis(ref, q)
    const offset = sideAxis[0] * ref.x + sideAxis[1] * ref.y + sideAxis[2] * ref.z
    const extent = half(ref, q)
    poly = clip(poly, sideAxis[0], sideAxis[1], sideAxis[2], offset + extent)
    poly = clip(poly, -sideAxis[0], -sideAxis[1], -sideAxis[2], -offset + extent)
    if (poly.length < 3) return
  }
  const refHalf = half(ref, k)
  const [a, b] = refIsA ? [ref, inc] : [inc, ref]
  const sign = refIsA ? -1 : 1
  for (let i = 0; i < poly.length; i += 3) {
    const px = poly[i] as number
    const py = poly[i + 1] as number
    const pz = poly[i + 2] as number
    const depth = refHalf - ((px - ref.x) * nf[0] + (py - ref.y) * nf[1] + (pz - ref.z) * nf[2])
    if (depth < -MARGIN) continue
    // Halfway between the incident point and the reference face.
    const halfDepth = depth / 2
    add(
      a,
      b,
      px + nf[0] * halfDepth,
      py + nf[1] * halfDepth,
      pz + nf[2] * halfDepth,
      nf[0] * sign,
      nf[1] * sign,
      nf[2] * sign,
      depth,
    )
  }
}

/**
 * Contacts of two boxes by the separating axis test: none when an axis separates them. The names
 * follow the usual write-up of the test: `T` from A to B, `ax` and `bx` the axes of each box,
 * `ha` and `hb` their half extents, `c` the absolute cosines between their axes.
 */
export function collide(A: Box, B: Box, add: Add): void {
  const T = [B.x - A.x, B.y - A.y, B.z - A.z]
  const ax = [axis(A, 0), axis(A, 1), axis(A, 2)]
  const bx = [axis(B, 0), axis(B, 1), axis(B, 2)]
  const ha = [A.hx, A.hy, A.hz]
  const hb = [B.hx, B.hy, B.hz]
  const c = new Float64Array(9)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      c[i * 3 + j] = Math.abs(dot(ax[i] as number[], bx[j] as number[])) + 1e-6
  // The least overlap over the face axes, and which axis: 0..2 of A, 3..5 of B.
  let best = Number.POSITIVE_INFINITY
  let kind = -1
  for (let i = 0; i < 3; i++) {
    const overlap =
      (ha[i] as number) +
      (hb[0] as number) * (c[i * 3] as number) +
      (hb[1] as number) * (c[i * 3 + 1] as number) +
      (hb[2] as number) * (c[i * 3 + 2] as number) -
      Math.abs(dot(T, ax[i] as number[]))
    if (overlap < -MARGIN) return
    if (overlap < best) {
      best = overlap
      kind = i
    }
  }
  for (let j = 0; j < 3; j++) {
    const overlap =
      (ha[0] as number) * (c[j] as number) +
      (ha[1] as number) * (c[3 + j] as number) +
      (ha[2] as number) * (c[6 + j] as number) +
      (hb[j] as number) -
      Math.abs(dot(T, bx[j] as number[]))
    if (overlap < -MARGIN) return
    if (overlap < best) {
      best = overlap
      kind = 3 + j
    }
  }
  let edge = -1
  let edgeBest = Number.POSITIVE_INFINITY
  let L: number[] = [0, 0, 0]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const a = ax[i] as number[]
      const b = bx[j] as number[]
      const l = [
        (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
        (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
        (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
      ]
      const len = Math.hypot(l[0] as number, l[1] as number, l[2] as number)
      // Parallel edges: a face axis covers them.
      if (len < 1e-3) continue
      l[0] = (l[0] as number) / len
      l[1] = (l[1] as number) / len
      l[2] = (l[2] as number) / len
      let radius = 0
      for (let k = 0; k < 3; k++)
        radius +=
          (ha[k] as number) * Math.abs(dot(ax[k] as number[], l)) +
          (hb[k] as number) * Math.abs(dot(bx[k] as number[], l))
      const overlap = radius - Math.abs(dot(T, l))
      if (overlap < -MARGIN) return
      if (overlap < edgeBest) {
        edgeBest = overlap
        edge = i * 3 + j
        L = l
      }
    }
  // Faces give whole patches of contact: an edge wins only when clearly the least overlap.
  if (edge >= 0 && edgeBest < best * 0.92 - 0.25) {
    const i = Math.floor(edge / 3)
    const j = edge % 3
    if (dot(T, L) < 0) L = [-(L[0] as number), -(L[1] as number), -(L[2] as number)]
    // The edge of A nearest B and the edge of B nearest A.
    const pa = [A.x, A.y, A.z]
    for (let k = 0; k < 3; k++) {
      if (k === i) continue
      const s = dot(ax[k] as number[], L) > 0 ? 1 : -1
      for (let n = 0; n < 3; n++)
        pa[n] = (pa[n] as number) + ((ax[k] as number[])[n] as number) * (ha[k] as number) * s
    }
    const pb = [B.x, B.y, B.z]
    for (let k = 0; k < 3; k++) {
      if (k === j) continue
      const s = dot(bx[k] as number[], L) > 0 ? -1 : 1
      for (let n = 0; n < 3; n++)
        pb[n] = (pb[n] as number) + ((bx[k] as number[])[n] as number) * (hb[k] as number) * s
    }
    // The closest points of the two edge lines, each kept on its edge.
    const d1 = ax[i] as number[]
    const d2 = bx[j] as number[]
    const r = [
      (pa[0] as number) - (pb[0] as number),
      (pa[1] as number) - (pb[1] as number),
      (pa[2] as number) - (pb[2] as number),
    ]
    const b = dot(d1, d2)
    const cc = dot(d1, r)
    const f = dot(d2, r)
    const den = 1 - b * b
    let s = den > 1e-6 ? (b * f - cc) / den : 0
    s = Math.max(-(ha[i] as number), Math.min(ha[i] as number, s))
    let t = b * s + f
    t = Math.max(-(hb[j] as number), Math.min(hb[j] as number, t))
    const qa = [0, 1, 2].map((n) => (pa[n] as number) + (d1[n] as number) * s)
    const qb = [0, 1, 2].map((n) => (pb[n] as number) + (d2[n] as number) * t)
    add(
      A,
      B,
      ((qa[0] as number) + (qb[0] as number)) / 2,
      ((qa[1] as number) + (qb[1] as number)) / 2,
      ((qa[2] as number) + (qb[2] as number)) / 2,
      -(L[0] as number),
      -(L[1] as number),
      -(L[2] as number),
      edgeBest,
    )
    return
  }
  if (kind < 3) faces(A, B, kind, true, add)
  else faces(B, A, kind - 3, false, add)
}

/** Where a box is held: a point of it, in its own frame, and where that point should go. */
export interface Hold {
  readonly box: Box
  readonly lx: number
  readonly ly: number
  readonly lz: number
  tx: number
  ty: number
  tz: number
}

/** The drag joint for one step: the arm, softness, the bias and the strongest impulse. */
interface Joint {
  readonly rx: number
  readonly ry: number
  readonly rz: number
  readonly gamma: number
  readonly cx: number
  readonly cy: number
  readonly cz: number
  readonly max: number
}

/** The boxes and their room. */
export class World {
  readonly boxes: Box[] = []
  readonly room: Room = { x0: -1e5, x1: 1e5, y0: -1e5, y1: 1e5, z0: -1e5, z1: 1e5 }
  hold: Hold | undefined
  /** Contacts of this step, the first `#count` of a pool kept between steps. */
  readonly #contacts: Contact[] = []
  #count = 0
  // The drag joint for one step: its inverse effective mass and the impulse summed so far.
  readonly #jointMass = new Float64Array(9)
  #jointX = 0
  #jointY = 0
  #jointZ = 0
  #joint: Joint | undefined

  #add: Add = (a, b, x, y, z, nx, ny, nz, depth) => {
    let c = this.#contacts[this.#count]
    if (!c) {
      c = new Contact()
      this.#contacts.push(c)
    }
    this.#count++
    c.a = a
    c.b = b
    c.pointX = x
    c.pointY = y
    c.pointZ = z
    c.nx = nx
    c.ny = ny
    c.nz = nz
    c.depth = depth
  }

  /** The walls a box touches, at its corners. */
  #walls(b: Box): void {
    const m = b.m
    const room = this.room
    for (let i = 0; i < 8; i++) {
      // Corner i: the bits of i pick the sign of each half extent.
      const sx = i & 1 ? b.hx : -b.hx
      const sy = i & 2 ? b.hy : -b.hy
      const sz = i & 4 ? b.hz : -b.hz
      const x = b.x + (m[0] as number) * sx + (m[1] as number) * sy + (m[2] as number) * sz
      const y = b.y + (m[3] as number) * sx + (m[4] as number) * sy + (m[5] as number) * sz
      const z = b.z + (m[6] as number) * sx + (m[7] as number) * sy + (m[8] as number) * sz
      if (room.y0 - y > -MARGIN) this.#add(b, null, x, y, z, 0, 1, 0, room.y0 - y)
      if (y - room.y1 > -MARGIN) this.#add(b, null, x, y, z, 0, -1, 0, y - room.y1)
      if (room.x0 - x > -MARGIN) this.#add(b, null, x, y, z, 1, 0, 0, room.x0 - x)
      if (x - room.x1 > -MARGIN) this.#add(b, null, x, y, z, -1, 0, 0, x - room.x1)
      if (room.z0 - z > -MARGIN) this.#add(b, null, x, y, z, 0, 0, 1, room.z0 - z)
      if (z - room.z1 > -MARGIN) this.#add(b, null, x, y, z, 0, 0, -1, z - room.z1)
    }
  }

  /** Advances `dt` seconds; true while any box is awake. */
  step(dt: number, matter: Matter): boolean {
    const boxes = this.boxes
    for (const b of boxes) {
      b.solved = !b.pinned && !b.ghost && !b.asleep
      b.orient()
    }
    const held = this.hold?.box

    // Gravity and the drag of the air.
    const drag = 1 / (1 + DRAG * dt)
    const turn = 1 / (1 + SPIN_DRAG * dt)
    for (const b of boxes) {
      if (!b.solved) continue
      b.vy -= matter.gravity * dt
      b.vx *= drag
      b.vy *= drag
      b.vz *= drag
      // A held box swings, but it does not spin like a top.
      const spinDrag = b === held ? 1 / (1 + 4 * dt) : turn
      b.wx *= spinDrag
      b.wy *= spinDrag
      b.wz *= spinDrag
    }

    // Contacts with the walls and between boxes that come near each other.
    this.#count = 0
    for (const b of boxes) if (b.solved) this.#walls(b)
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i] as Box
      if (a.ghost) continue
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j] as Box
        if (b.ghost || (!a.solved && !b.solved)) continue
        // Boxes farther apart than their bounding spheres cannot touch.
        const reach = Math.hypot(a.hx, a.hy, a.hz) + Math.hypot(b.hx, b.hy, b.hz) + MARGIN
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dz = b.z - a.z
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue
        const before = this.#count
        collide(a, b, this.#add)
        if (this.#count === before) continue
        // A sleeping box hit by a moving one wakes up.
        for (const [sleeper, mover] of [
          [a, b],
          [b, a],
        ] as const) {
          if (!sleeper.asleep || sleeper.pinned || !mover.solved) continue
          const speed2 = mover.vx * mover.vx + mover.vy * mover.vy + mover.vz * mover.vz
          if (speed2 > WAKE * WAKE) sleeper.wake()
        }
      }
    }
    const contacts = this.#contacts
    const count = this.#count

    // Arms, tangents, effective masses and target speeds of every contact.
    for (let i = 0; i < count; i++) {
      const c = contacts[i] as Contact
      const a = c.a
      const b = c.b
      c.armAX = c.pointX - a.x
      c.armAY = c.pointY - a.y
      c.armAZ = c.pointZ - a.z
      c.armBX = b ? c.pointX - b.x : 0
      c.armBY = b ? c.pointY - b.y : 0
      c.armBZ = b ? c.pointZ - b.z : 0
      const { nx, ny, nz } = c
      // Two tangents across the normal.
      if (Math.abs(nx) > 0.57) {
        const length = Math.hypot(nx, ny)
        c.tangentUX = ny / length
        c.tangentUY = -nx / length
        c.tangentUZ = 0
      } else {
        const length = Math.hypot(ny, nz)
        c.tangentUX = 0
        c.tangentUY = nz / length
        c.tangentUZ = -ny / length
      }
      c.tangentTX = ny * c.tangentUZ - nz * c.tangentUY
      c.tangentTY = nz * c.tangentUX - nx * c.tangentUZ
      c.tangentTZ = nx * c.tangentUY - ny * c.tangentUX
      c.massN = massAlong(c, nx, ny, nz)
      c.massU = massAlong(c, c.tangentUX, c.tangentUY, c.tangentUZ)
      c.massT = massAlong(c, c.tangentTX, c.tangentTY, c.tangentTZ)
      const approach = along(c, nx, ny, nz, false)
      if (c.depth < 0) c.target = c.depth / dt
      else c.target = approach < -BOUNCE_MIN ? -matter.bounce * approach : 0
      c.bias = c.depth > SLOP ? Math.min(((c.depth - SLOP) * BETA) / dt, PUSH) : 0
      c.impulseN = c.impulseU = c.impulseT = c.impulseP = 0
    }
    this.#prepareHold(dt)

    // Friction and normal impulses on the real velocities, with the drag joint.
    const friction = Math.max(0, matter.friction)
    for (let it = 0; it < ITERATIONS; it++) {
      this.#solveHold()
      // Forward, then backward: the first contacts of a sweep take more than their share.
      for (let n = 0; n < count; n++) {
        const c = contacts[it & 1 ? count - 1 - n : n] as Contact
        if (c.impulseN > 0 && friction > 0) {
          // Coulomb: friction holds up to `friction` times the normal impulse.
          const limit = friction * c.impulseN
          let j = -c.massU * along(c, c.tangentUX, c.tangentUY, c.tangentUZ, false)
          let next = Math.max(-limit, Math.min(limit, c.impulseU + j))
          j = next - c.impulseU
          c.impulseU = next
          push(c, j, c.tangentUX, c.tangentUY, c.tangentUZ, false)
          j = -c.massT * along(c, c.tangentTX, c.tangentTY, c.tangentTZ, false)
          next = Math.max(-limit, Math.min(limit, c.impulseT + j))
          j = next - c.impulseT
          c.impulseT = next
          push(c, j, c.tangentTX, c.tangentTY, c.tangentTZ, false)
        }
        let j = c.massN * (c.target - along(c, c.nx, c.ny, c.nz, false))
        const next = Math.max(0, c.impulseN + j)
        j = next - c.impulseN
        c.impulseN = next
        push(c, j, c.nx, c.ny, c.nz, false)
      }
    }

    // Overlaps pushed apart on the pseudo velocities, so the push adds no bounce.
    for (let it = 0; it < PUSHES; it++) {
      for (let n = 0; n < count; n++) {
        const c = contacts[it & 1 ? count - 1 - n : n] as Contact
        if (c.bias <= 0) continue
        let j = c.massN * (c.bias - along(c, c.nx, c.ny, c.nz, true))
        const next = Math.max(0, c.impulseP + j)
        j = next - c.impulseP
        c.impulseP = next
        push(c, j, c.nx, c.ny, c.nz, true)
      }
    }

    // Every box moved and turned; the slow ones go to sleep.
    let awake = false
    for (const b of boxes) {
      if (!b.solved) continue
      const speed = Math.hypot(b.vx, b.vy, b.vz)
      if (speed > MAX_SPEED) {
        const scale = MAX_SPEED / speed
        b.vx *= scale
        b.vy *= scale
        b.vz *= scale
      }
      const spinRate = Math.hypot(b.wx, b.wy, b.wz)
      if (spinRate > MAX_SPIN) {
        const scale = MAX_SPIN / spinRate
        b.wx *= scale
        b.wy *= scale
        b.wz *= scale
      }
      b.x += (b.vx + b.shiftX) * dt
      b.y += (b.vy + b.shiftY) * dt
      b.z += (b.vz + b.shiftZ) * dt
      // q += ½ ω q dt, then normalized.
      const ox = (b.wx + b.turnX) * dt * 0.5
      const oy = (b.wy + b.turnY) * dt * 0.5
      const oz = (b.wz + b.turnZ) * dt * 0.5
      const { qx, qy, qz, qw } = b
      let x = qx + ox * qw + oy * qz - oz * qy
      let y = qy - ox * qz + oy * qw + oz * qx
      let z = qz + ox * qy - oy * qx + oz * qw
      let w = qw - ox * qx - oy * qy - oz * qz
      const length = Math.hypot(x, y, z, w) || 1
      x /= length
      y /= length
      z /= length
      w /= length
      b.qx = x
      b.qy = y
      b.qz = z
      b.qw = w
      b.shiftX = b.shiftY = b.shiftZ = b.turnX = b.turnY = b.turnZ = 0
      if (b !== held && speed < REST_SPEED && spinRate < REST_SPIN) {
        b.still += dt
        if (b.still >= REST_TIME) {
          b.asleep = true
          b.halt()
          continue
        }
      } else b.still = 0
      awake = true
    }
    return awake
  }

  /** The drag joint, Box2D's mouse joint in 3D: a soft spring from a point of the box. */
  #prepareHold(dt: number): void {
    const h = this.hold
    this.#jointX = this.#jointY = this.#jointZ = 0
    this.#joint = undefined
    if (!h?.box.solved) return
    const b = h.box
    const m = b.m
    // The arm from the centre to the held point, in the world.
    const rx = (m[0] as number) * h.lx + (m[1] as number) * h.ly + (m[2] as number) * h.lz
    const ry = (m[3] as number) * h.lx + (m[4] as number) * h.ly + (m[5] as number) * h.lz
    const rz = (m[6] as number) * h.lx + (m[7] as number) * h.ly + (m[8] as number) * h.lz
    const mass = 1 / b.invMass
    // A spring of JOINT.hz and damping ratio as softness gamma and position bias beta.
    const omega = 2 * Math.PI * JOINT.hz
    const damping = 2 * mass * JOINT.ratio * omega
    const stiffness = mass * omega * omega
    const gamma = 1 / (dt * (damping + dt * stiffness))
    const beta = dt * stiffness * gamma
    // K = (1/m + γ) I + the turn each unit impulse gives the point; its inverse.
    const K = new Float64Array(9)
    for (let col = 0; col < 3; col++) {
      const ex = col === 0 ? 1 : 0
      const ey = col === 1 ? 1 : 0
      const ez = col === 2 ? 1 : 0
      spin(b, ry * ez - rz * ey, rz * ex - rx * ez, rx * ey - ry * ex, spinOfMass)
      const [wx, wy, wz] = spinOfMass as [number, number, number]
      K[col] = (col === 0 ? b.invMass + gamma : 0) + (wy * rz - wz * ry)
      K[3 + col] = (col === 1 ? b.invMass + gamma : 0) + (wz * rx - wx * rz)
      K[6 + col] = (col === 2 ? b.invMass + gamma : 0) + (wx * ry - wy * rx)
    }
    const inverse = invert(K)
    if (!inverse) return
    this.#jointMass.set(inverse)
    this.#joint = {
      rx,
      ry,
      rz,
      gamma,
      cx: (b.x + rx - h.tx) * beta,
      cy: (b.y + ry - h.ty) * beta,
      cz: (b.z + rz - h.tz) * beta,
      max: JOINT.pull * mass * dt,
    }
  }

  #solveHold(): void {
    const h = this.hold
    const joint = this.#joint
    if (!h || !joint || !h.box.solved) return
    const b = h.box
    const { rx, ry, rz } = joint
    // Velocity of the held point with the spring's bias and softness.
    const vx = b.vx + b.wy * rz - b.wz * ry + joint.cx + joint.gamma * this.#jointX
    const vy = b.vy + b.wz * rx - b.wx * rz + joint.cy + joint.gamma * this.#jointY
    const vz = b.vz + b.wx * ry - b.wy * rx + joint.cz + joint.gamma * this.#jointZ
    const k = this.#jointMass
    let jx = -((k[0] as number) * vx + (k[1] as number) * vy + (k[2] as number) * vz)
    let jy = -((k[3] as number) * vx + (k[4] as number) * vy + (k[5] as number) * vz)
    let jz = -((k[6] as number) * vx + (k[7] as number) * vy + (k[8] as number) * vz)
    // The summed impulse is capped at the joint's strongest pull.
    let totalX = this.#jointX + jx
    let totalY = this.#jointY + jy
    let totalZ = this.#jointZ + jz
    const total = Math.hypot(totalX, totalY, totalZ)
    if (total > joint.max) {
      totalX *= joint.max / total
      totalY *= joint.max / total
      totalZ *= joint.max / total
    }
    jx = totalX - this.#jointX
    jy = totalY - this.#jointY
    jz = totalZ - this.#jointZ
    this.#jointX = totalX
    this.#jointY = totalY
    this.#jointZ = totalZ
    b.vx += b.invMass * jx
    b.vy += b.invMass * jy
    b.vz += b.invMass * jz
    spin(b, ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx, spinOfPush)
    b.wx += spinOfPush[0] as number
    b.wy += spinOfPush[1] as number
    b.wz += spinOfPush[2] as number
  }
}

/** The inverse of a row-major 3×3 matrix, undefined when singular. */
function invert(m: Float64Array): Float64Array | undefined {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return undefined
  const scale = 1 / det
  return new Float64Array([
    A * scale,
    -(b * i - c * h) * scale,
    (b * f - c * e) * scale,
    B * scale,
    (a * i - c * g) * scale,
    -(a * f - c * d) * scale,
    C * scale,
    -(a * h - b * g) * scale,
    (a * e - b * d) * scale,
  ])
}
