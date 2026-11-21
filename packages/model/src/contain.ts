// How large a model may be drawn so that its bounds, turned and seen in perspective, stay inside
// the element's box.
import { type Box3, Euler, Matrix4, Vector3 } from 'three/webgpu'

const euler = new Euler()
/** Rounds of re-centring per tried scale. */
const CENTRING_ROUNDS = 4
/** Halvings of the binary search for the largest scale. */
const SEARCH_STEPS = 20

/** Px per unit and the move in the page plane, px with y up, that centres what is drawn. */
export interface Fit {
  scale: number
  x: number
  y: number
}

/**
 * The largest px per unit that keeps `points`, taken through `matrix` and turned by `pitch` and
 * each of `yaws` (the order of a `rotation.set(pitch, yaw, 0)`), inside `width` × `height` px seen
 * from `distance` px, and the shift that centres them. A near point draws larger than a far one,
 * so the drawn shape is not centred on the model: the shift takes up the slack. Scale 0 when
 * nothing fits.
 */
export function fitPoints(
  points: readonly Vector3[],
  matrix: Matrix4,
  yaws: readonly number[],
  pitch: number,
  width: number,
  height: number,
  distance: number,
  out: Fit = { scale: 0, x: 0, y: 0 },
): Fit {
  const eye = Math.max(1, distance)
  out.scale = out.x = out.y = 0
  if (!points.length || width <= 0 || height <= 0) return out
  const turned: Vector3[] = []
  for (const yaw of yaws) {
    const m = new Matrix4().makeRotationFromEuler(euler.set(pitch, yaw, 0)).multiply(matrix)
    for (const p of points) turned.push(p.clone().applyMatrix4(m))
  }
  // The shift is a move in the page plane, so it grows with the perspective of each point too:
  // a few rounds of centring settle it.
  let shiftX = 0
  let shiftY = 0
  const fits = (scale: number): boolean => {
    let best = Number.POSITIVE_INFINITY
    let tryX = 0
    let tryY = 0
    let ok = false
    for (let round = 0; round < CENTRING_ROUNDS; round++) {
      let left = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      let bottom = Number.POSITIVE_INFINITY
      let top = Number.NEGATIVE_INFINITY
      for (const p of turned) {
        const near = eye - p.z * scale
        if (near <= 0) return false
        const perspective = eye / near
        left = Math.min(left, (p.x * scale + tryX) * perspective)
        right = Math.max(right, (p.x * scale + tryX) * perspective)
        bottom = Math.min(bottom, (p.y * scale + tryY) * perspective)
        top = Math.max(top, (p.y * scale + tryY) * perspective)
      }
      const over = Math.max(
        Math.max(-left, right) / (width / 2),
        Math.max(-bottom, top) / (height / 2),
      )
      if (over < best) {
        best = over
        shiftX = tryX
        shiftY = tryY
        ok = over <= 1
      }
      tryX -= (left + right) / 2
      tryY -= (bottom + top) / 2
    }
    return ok
  }
  // Centred on the model, with scale s and eye distance d, |x| s d / (d - z s) <= width / 2 for
  // each point: the largest such s fits.
  let low = Number.POSITIVE_INFINITY
  for (const p of turned) {
    const spanX = Math.abs(p.x) * eye + (width / 2) * p.z
    const spanY = Math.abs(p.y) * eye + (height / 2) * p.z
    if (spanX > 0) low = Math.min(low, (width * eye) / 2 / spanX)
    if (spanY > 0) low = Math.min(low, (height * eye) / 2 / spanY)
  }
  if (!Number.isFinite(low)) return out
  // Shifted, it may grow until one side spans the box: a binary search up to twice that scale.
  let high = low * 2
  for (let i = 0; i < SEARCH_STEPS; i++) {
    const mid = (low + high) / 2
    if (fits(mid)) low = mid
    else high = mid
  }
  fits(low)
  out.scale = low
  out.x = shiftX
  out.y = shiftY
  return out
}

/** The eight corners of a box. */
export function corners(box: Box3, out: Vector3[] = []): Vector3[] {
  if (box.isEmpty()) return out
  for (let i = 0; i < 8; i++)
    out.push(
      new Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ),
    )
  return out
}

/** Yaws a turning model passes through: its fit holds at every one of them. */
export const AROUND: readonly number[] = Array.from({ length: 16 }, (_, i) => (i * Math.PI) / 8)
