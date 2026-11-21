// The shape of a turning leaf of `flipbook`. The sheet leaves the spine flat at the `root` angle,
// wraps over a cylinder of `radius` past a fold line and runs on straight `bend` further round.
// Lengths along the sheet are kept, so a page never stretches. The fold may lean (`tilt`) when a
// corner is lifted. The vertex shader of flipbook.ts mirrors `point`.

/** A leaf at one moment. Angles in radians, lengths in px. */
export interface Shape {
  /** Turn of the flat part about the spine: 0 lying to the right, π turned over to the left. */
  root: number
  /** Distance of the fold line from the spine along its normal. */
  fold: number
  /** Lean of the fold line from the spine's direction; negative lifts the bottom corner first. */
  tilt: number
  /** Radius of the bend. */
  radius: number
  /**
   * Angle the sheet turns through over the bend: positive on towards the left page as the free
   * edge leads, negative back up as it trails.
   */
  bend: number
}

const unit = (value: number): number => Math.min(1, Math.max(0, value))
/** smoothstep: 0 at `a`, 1 at `b`, eased between. */
const smooth = (a: number, b: number, x: number): number => {
  const t = unit((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Largest lean of the fold, at a corner. */
export const TILT: number = (15 * Math.PI) / 180
/** How far the free edge runs ahead of the spine, then behind it, as parts of a half turn. */
const SWAY = 0.2
/** The bow a sheet keeps half way, rad: a page never stands edge-on and flat. */
const BOW = 0.35

/**
 * The shape at `t` of a turn (0 lying right, 1 turned over), lifted at height `grab` (-1 the
 * bottom corner, 1 the top) on a page `width` by `height` px; `curl` 0..1 tightens the bend.
 * The free edge leads as the leaf lifts and trails as it lands, the part at the spine first;
 * half way the sheet stands up with a slight bow.
 */
export function shape(t: number, grab: number, width: number, height: number, curl: number): Shape {
  const radius = Math.max(1, width * (0.5 - 0.42 * unit(curl)))
  const eased = smooth(0, 1, t)
  const sway = SWAY * Math.sin(2 * Math.PI * unit(t))
  const tip = Math.PI * unit(eased + sway)
  const root = Math.PI * unit(eased - sway)
  const fold = width * (1 - smooth(0, 0.55, Math.min(t, 1 - t)))
  // A lifted corner folds along a slant; the fold line never crosses the spine.
  const limit = Math.atan((2 * fold) / Math.max(height, 1))
  const tilt = Math.max(-limit, Math.min(limit, TILT * Math.max(-1, Math.min(1, grab))))
  return { root, fold, tilt, radius, bend: tip - root + BOW * Math.sin(Math.PI * unit(t)) }
}

/** A stiff leaf at `t` of a turn on a page `width` px wide: it swings flat about the spine. */
export function board(t: number, width: number): Shape {
  return { root: Math.PI * smooth(0, 1, t), fold: width, tilt: 0, radius: width, bend: 0 }
}

/**
 * Where the point `u` px from the spine and `v` px above the page's middle goes: [x, y, z] in px,
 * x from the spine towards where the leaf lies at rest, z towards the viewer.
 */
export function point(leaf: Shape, u: number, v: number, out: number[] = [0, 0, 0]): number[] {
  const cosTilt = Math.cos(leaf.tilt)
  const sinTilt = Math.sin(leaf.tilt)
  // Distance past the fold line, across it, and the position along it.
  const pastFold = (u - leaf.fold) * cosTilt + v * sinTilt
  const along = (leaf.fold - u) * sinTilt + v * cosTilt
  // The length of sheet on the cylinder, the angle a point has wrapped round it, and the
  // straight run beyond.
  const arc = leaf.radius * Math.abs(leaf.bend)
  const phi = Math.min(Math.max(pastFold, 0), arc) / leaf.radius
  const rest = Math.max(pastFold - arc, 0)
  const across = Math.min(pastFold, 0) + leaf.radius * Math.sin(phi) + rest * Math.cos(leaf.bend)
  const z = Math.sign(leaf.bend) * leaf.radius * (1 - Math.cos(phi)) + rest * Math.sin(leaf.bend)
  const x = leaf.fold + across * cosTilt - along * sinTilt
  // Then the whole sheet turns about the spine by `root`.
  const cosRoot = Math.cos(leaf.root)
  const sinRoot = Math.sin(leaf.root)
  out[0] = x * cosRoot - z * sinRoot
  out[1] = across * sinTilt + along * cosTilt
  out[2] = x * sinRoot + z * cosRoot
  return out
}

/** How far the leaf reaches over each side of the spine along one row, and how high it is there. */
export interface Reach {
  /** Largest x and the height there. */
  readonly right: number
  readonly rightZ: number
  /** Smallest x and the height there. */
  readonly left: number
  readonly leftZ: number
}

const scratch: number[] = [0, 0, 0]

/** The reach of the row `v` of a leaf `width` px wide, sampled at `samples` points. */
export function reach(leaf: Shape, width: number, v: number, samples = 24): Reach {
  let right = -Infinity
  let left = Infinity
  let rightZ = 0
  let leftZ = 0
  for (let i = 0; i <= samples; i++) {
    point(leaf, (width * i) / samples, v, scratch)
    const [x, , z] = scratch as [number, number, number]
    if (x > right) {
      right = x
      rightZ = z
    }
    if (x < left) {
      left = x
      leftZ = z
    }
  }
  return { right, rightZ, left, leftZ }
}
