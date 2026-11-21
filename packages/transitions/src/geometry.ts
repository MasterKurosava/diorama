// Box, crop and pose math shared by flights, the pool and the plugin. Boxes are viewport CSS px.
import type { Box, Copy, Crop, DrawnBox } from '@dioramajs/effects'
import type { Ease } from './types'

/** Viewport box, radius and alpha a copy is drawn with. */
export type Pose = DrawnBox

/** Two crops count as the same picture within this share of aspect ratio. */
const SAME_ASPECT = 0.01
/** A box pushed by a velocity never shrinks below this many px. */
const MIN_SIZE = 1

export const clamp = (value: number): number => Math.min(1, Math.max(0, value))
export const lerp = (from: number, to: number, t: number): number => from + (to - from) * t
/** Cubic in-out. */
export const cubic: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
/** 0 up to `from`, 1 from `to`, smooth in between. */
export const smooth = (from: number, to: number, x: number): number => {
  const t = to > from ? clamp((x - from) / (to - from)) : +(x >= to)
  return t * t * (3 - 2 * t)
}
export const noop = (): void => {}

/** Moves `box` on by `velocity` (px/s per field) for `seconds`. */
export const push = (box: Box, velocity: Box, seconds: number): Box => ({
  x: box.x + velocity.x * seconds,
  y: box.y + velocity.y * seconds,
  width: Math.max(MIN_SIZE, box.width + velocity.width * seconds),
  height: Math.max(MIN_SIZE, box.height + velocity.height * seconds),
})

/** Velocity of a box that moved from `from` to `to` in `dt` seconds. */
export const rate = (from: Box, to: Box, dt: number): Box => ({
  x: (to.x - from.x) / dt,
  y: (to.y - from.y) / dt,
  width: (to.width - from.width) / dt,
  height: (to.height - from.height) / dt,
})

/** The farthest any edge of `a` is from the same edge of `b`. */
export const travel = (a: Box, b: Box): number =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - b.x - b.width),
    Math.abs(a.y + a.height - b.y - b.height),
  )

/** Any side of the box moved or changed size by more than a pixel. */
export const moved = (a: Box, b: Box): boolean =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  ) > 1

export const lerpBox = (from: Box, to: Box, t: number): Box => ({
  x: lerp(from.x, to.x, t),
  y: lerp(from.y, to.y, t),
  width: lerp(from.width, to.width, t),
  height: lerp(from.height, to.height, t),
})

export const sized = (box: Box): boolean => box.width > 0 && box.height > 0

export const inView = (box: Box, width: number, height: number): boolean =>
  sized(box) && box.x < width && box.y < height && box.x + box.width > 0 && box.y + box.height > 0

/** A plain copy of the box fields of a DOMRect, an anchor or a pose. */
export const boxOf = (box: Box): Box => ({
  x: box.x,
  y: box.y,
  width: box.width,
  height: box.height,
})

/** Width over height of the picture a crop shows in a box (object-fit keeps it). */
export const aspect = (crop: Crop, box: Box): number =>
  (crop.height * box.width) / (crop.width * box.height)

/** Both crops show the same picture, give or take 1% of aspect ratio. */
export const alike = (a: Crop, aBox: Box, b: Crop, bBox: Box): boolean =>
  Math.abs(aspect(a, aBox) / aspect(b, bBox) - 1) < SAME_ASPECT

/**
 * Interpolates zoom and centre between crop `a` shown in `aBox` and crop `b` shown in `bBox`,
 * drawn in `box`. Never stretches, so the content moves with the box instead of sliding inside
 * it. Exact at both ends.
 */
export function framing(a: Crop, aBox: Box, b: Crop, bBox: Box, box: Box, t: number): Crop {
  const zoom = lerp(aBox.width / a.width, bBox.width / b.width, t)
  const width = box.width / zoom
  const height = (box.height * aspect(a, aBox)) / zoom
  const x = lerp(a.x + a.width / 2, b.x + b.width / 2, t) - width / 2
  const y = lerp(a.y + a.height / 2, b.y + b.height / 2, t) - height / 2
  return { x: keepInside(x, width), y: keepInside(y, height), width, height }
}

/** Pins the copy to `pose` instead of following its element. */
export function hold(copy: Copy, pose: Pose): void {
  copy.box = boxOf(pose)
  copy.radius = pose.radius
  copy.opacity = pose.opacity
  copy.clip = pose.clip
}

/** Where the copy is drawn now: its pinned box if it has one, else its last drawn frame. */
export const poseOf = (copy: Copy): Pose | undefined =>
  copy.box
    ? {
        ...copy.box,
        radius: copy.radius ?? copy.drawn?.radius ?? 0,
        opacity: copy.opacity,
        clip: copy.clip,
      }
    : copy.drawn

/** Moves a copy outside a flight. A framing set by the owner keeps its zoom and centre. */
export function place(copy: Copy, box: Box): void {
  if (copy.crop && copy.box) copy.crop = framing(copy.crop, copy.box, copy.crop, copy.box, box, 0)
  copy.box = box
}

/** Largest corner radius in px, the way effects draws it. */
export function radiusOf(element: Element, box: Box): number {
  const style = getComputedStyle(element)
  const corners = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ]
  let radius = 0
  for (const corner of corners) {
    const value = Number.parseFloat(corner || '0') || 0
    radius = Math.max(
      radius,
      corner?.endsWith('%') ? (Math.min(box.width, box.height) * value) / 100 : value,
    )
  }
  return radius
}

/** Nearest clipping ancestor (overflow or inset clip-path), found the same way effects does. */
export function frameOf(element: Element): Element | undefined {
  const { body } = element.ownerDocument
  for (let node = element.parentElement; node && node !== body; node = node.parentElement) {
    const style = getComputedStyle(node)
    const overflow =
      (style.overflowX && style.overflowX !== 'visible') ||
      (style.overflowY && style.overflowY !== 'visible')
    if (overflow || style.clipPath?.startsWith('inset(')) return node
  }
  return undefined
}

/** Keeps a crop edge inside the picture when the crop is no larger than the picture. */
const keepInside = (start: number, size: number): number =>
  size <= 1 ? Math.min(Math.max(start, 0), 1 - size) : start
