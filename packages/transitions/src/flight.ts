import type { Anchor } from '@diorama/core'
import type { Box, Copy, Crop, DrawnBox } from '@diorama/effects'
import type { Source } from './transition'
import type { Ease, Flight, FlightState, Presence } from './types'

/** Viewport box, radius and alpha a copy is drawn with. */
export type Pose = DrawnBox

export const clamp = (value: number): number => Math.min(1, Math.max(0, value))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
/** Cubic in-out. */
export const cubic: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
/** 0 up to `a`, 1 from `b`, smooth in between. */
export const smooth = (a: number, b: number, x: number): number => {
  const t = b > a ? clamp((x - a) / (b - a)) : +(x >= b)
  return t * t * (3 - 2 * t)
}
export const noop = (): void => {}

/** Moves box `a` on by velocity `v` for `t` seconds. */
export const push = (a: Box, v: Box, t: number): Box => ({
  x: a.x + v.x * t,
  y: a.y + v.y * t,
  width: Math.max(1, a.width + v.width * t),
  height: Math.max(1, a.height + v.height * t),
})

/** Width over height of the picture a crop shows in a box (object-fit keeps it). */
export const aspect = (crop: Crop, box: Box): number =>
  (crop.height * box.width) / (crop.width * box.height)

/** Both crops show the same picture, give or take 1% of aspect ratio. */
export const alike = (a: Crop, aBox: Box, b: Crop, bBox: Box): boolean =>
  Math.abs(aspect(a, aBox) / aspect(b, bBox) - 1) < 0.01

const inside = (start: number, size: number): number =>
  size <= 1 ? Math.min(Math.max(start, 0), 1 - size) : start

// Interpolates zoom and centre between `a` in `aBox` and `b` in `bBox`, drawn in `box`. Never
// stretches, so the content moves with the box instead of sliding inside it. Exact at both ends.
export function framing(a: Crop, aBox: Box, b: Crop, bBox: Box, box: Box, t: number): Crop {
  const zoom = lerp(aBox.width / a.width, bBox.width / b.width, t)
  const width = box.width / zoom
  const height = (box.height * aspect(a, aBox)) / zoom
  const x = lerp(a.x + a.width / 2, b.x + b.width / 2, t) - width / 2
  const y = lerp(a.y + a.height / 2, b.y + b.height / 2, t) - height / 2
  return { x: inside(x, width), y: inside(y, height), width, height }
}

export const rate = (a: Box, b: Box, dt: number): Box => ({
  x: (b.x - a.x) / dt,
  y: (b.y - a.y) / dt,
  width: (b.width - a.width) / dt,
  height: (b.height - a.height) / dt,
})

/** The farthest any edge of `a` is from the same edge of `b`. */
export const travel = (a: Box, b: Box): number =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - b.x - b.width),
    Math.abs(a.y + a.height - b.y - b.height),
  )

export const lerpBox = (a: Box, b: Box, t: number): Box => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  width: lerp(a.width, b.width, t),
  height: lerp(a.height, b.height, t),
})

export const sized = (b: Box): boolean => b.width > 0 && b.height > 0

export const inView = (b: Box, width: number, height: number): boolean =>
  sized(b) && b.x < width && b.y < height && b.x + b.width > 0 && b.y + b.height > 0

export const boxOf = (b: Box): Box => ({ x: b.x, y: b.y, width: b.width, height: b.height })

/** Pins the copy to `pose` instead of following its element. */
export function hold(copy: Copy, pose: Pose): void {
  copy.box = boxOf(pose)
  copy.radius = pose.radius
  copy.opacity = pose.opacity
  copy.clip = pose.clip
}

export const poseOf = (copy: Copy): Pose | undefined =>
  copy.box
    ? {
        ...copy.box,
        radius: copy.radius ?? copy.drawn?.radius ?? 0,
        opacity: copy.opacity,
        clip: copy.clip,
      }
    : copy.drawn

/** Largest corner radius in px, the way effects draws it. */
export function radiusOf(el: Element, box: Box): number {
  const style = getComputedStyle(el)
  let radius = 0
  for (const r of [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ]) {
    const value = Number.parseFloat(r || '0') || 0
    radius = Math.max(
      radius,
      r?.endsWith('%') ? (Math.min(box.width, box.height) * value) / 100 : value,
    )
  }
  return radius
}

/** Nearest clipping ancestor (overflow or inset clip-path), found the same way effects does. */
export function frameOf(el: Element): Element | undefined {
  const { body } = el.ownerDocument
  for (let node = el.parentElement; node && node !== body; node = node.parentElement) {
    const s = getComputedStyle(node)
    const overflow =
      (s.overflowX && s.overflowX !== 'visible') || (s.overflowY && s.overflowY !== 'visible')
    if (overflow || s.clipPath?.startsWith('inset(')) return node
  }
  return undefined
}

/** Site writes (GSAP) wake a frame and count as activity. */
export interface Owner {
  touch(): void
}

/** One pair in flight. The mutable fields belong to the transition stepping it. */
export class FlightImpl implements Flight {
  readonly key: string
  /** Keyed by view-transition-name rather than data-dio-key. */
  readonly named: boolean
  readonly from: Element
  to: Element
  state: FlightState = 'flying'
  owner: Owner
  /** The source's ghost, or its still connected copy (FLIP, Barba sync). */
  readonly copy: Copy
  /** Veiled until drawable, then takes over under the flying copy. Same as `copy` for a FLIP. */
  target: Copy | undefined
  /** Other copy of a superseded flight's pair, still shown under this one. It fades out first. */
  trail: Copy | undefined
  /** Weight of the copy under the flying one (the target taking over, or the trail fading out). */
  share = 0
  /** `share` at landing. The crossfade continues from it. */
  landedShare = 0
  /** Where the takeover starts. Above 0 when a former trail becomes the target again. */
  shareFrom = 0
  /** Progress at which the takeover starts. Unset until the target is drawable. */
  mixAt: number | undefined
  /** Combined alpha of the pair. */
  cover: number
  duration = 0
  /** Last velocity of box and clip in px/s, carried into a flight that supersedes this one. */
  speed: Box | undefined
  clipSpeed: Box | undefined
  /** Velocity carried in from a superseded flight. Dies out early in this one. */
  kick: Box | undefined
  clipKick: Box | undefined
  anchor: Anchor | undefined
  pose: Pose
  /** Framing of the picture at `pose`. */
  crop: Crop | undefined
  cropPose: Pose | undefined
  /** Eased progress `pose` was taken at. Nonzero when a target sized late re-based the flight. */
  poseAt = 0
  radius: number | undefined
  /** Clipping ancestor of the target. The flight lands cut to its box. */
  frame: Element | undefined
  /** Clock time the flight starts at. Pushed forward while the target is lost. */
  startAt = 0
  /** Last live box of the target, kept while it is lost. */
  targetBox: Box | undefined
  /** In-place fade: seconds done, length, and the alpha it starts from. */
  fadeTime = 0
  fadeSpan = 0
  fadeFrom = 1
  /** The target won't get a copy (no effects, failed, or `wait` ran out). */
  failed = false
  /** The target left and has no replacement yet. */
  lost = false
  /** After fading out unpaired, wait in the pool for a late partner. */
  toPool = false
  /** Has faded in place, so it draws under fresh flights from then on, even when flying again. */
  lowered = false
  timer: ReturnType<typeof setTimeout> | undefined
  #progress = 0
  #opacity = 1

  constructor(
    owner: Owner,
    source: Pick<Source, 'key' | 'named' | 'element' | 'copy'>,
    to: Element,
    pose: Pose,
  ) {
    this.owner = owner
    this.key = source.key
    this.named = source.named
    this.from = source.element
    this.to = to
    this.copy = source.copy
    this.pose = pose
    this.cover = pose.opacity
  }

  get progress(): number {
    return this.#progress
  }
  set progress(value: number) {
    this.#progress = value
    this.owner.touch()
  }
  get opacity(): number {
    return this.#opacity
  }
  set opacity(value: number) {
    this.#opacity = value
    this.owner.touch()
  }
  /** Write from the built-in clock. Doesn't count as activity. */
  advance(value: number): void {
    this.#progress = value
  }
}

// Ends on the target's framing if both show the same picture, else on its own object-fit there.
export function flightCrop(f: FlightImpl, to: Box, box: Box, t: number): Crop | undefined {
  const c = f.copy
  if (f.cropPose !== f.pose) {
    f.cropPose = f.pose
    f.crop = c.crop ?? c.cropAt(f.pose)
  }
  const own = c.cropAt(to)
  if (!f.crop || !own) return undefined
  const target = f.target && f.target !== c ? f.target.cropAt(to) : undefined
  const end = target && alike(target, to, own, to) ? target : own
  return framing(f.crop, f.pose, end, to, box, t)
}

/** Moves a copy outside a flight. A framing set by the owner keeps its zoom and centre. */
export function place(c: Copy, box: Box): void {
  if (c.crop && c.box) c.crop = framing(c.crop, c.box, c.crop, c.box, box, 0)
  c.box = box
}

/** Current pose of the flying copy, at the alpha the pair covers. */
export function here(f: FlightImpl): Pose {
  const pose = poseOf(f.copy)
  return pose ? { ...pose, opacity: f.cover } : f.pose
}

// The flying copy at `(1 - share) * cover` over `under` in the same pose adds up to exactly
// `cover`, with `under` making up `share` of it. No dip or flash at any share.
export function show(f: FlightImpl, under: Copy | undefined): void {
  const c = f.copy
  const { share, cover } = f
  c.opacity = (1 - share) * cover
  c.veil = share >= 1
  if (!under) return
  under.box = c.box
  const own = c.crop && c.box ? under.cropAt(c.box) : undefined
  under.crop = own && c.crop && c.box && alike(own, c.box, c.crop, c.box) ? c.crop : undefined
  under.clip = c.clip
  under.radius = c.radius
  under.above = c.above - 1
  under.veil = false
  // A router re-render may remove its node mid-flight. Let it fade out as a ghost then.
  under.leave = 'ghost'
  const rest = 1 - c.opacity
  under.opacity = share > 0 && rest > 0 ? clamp((share * cover) / rest) : 0
}

/** An unpaired copy leaving or entering a page. */
export class PresenceImpl implements Presence {
  readonly element: Element
  readonly copy: Copy
  // Opacity under reduced motion, since custom effects may animate on u.presence.
  readonly prop: 'presence' | 'opacity'
  readonly scale: number
  readonly #owner: Owner
  #value = 1
  /** Clock time an entering copy may start at, or did start at. */
  at = 0
  /** Entering copy has been unveiled. */
  shown = false
  done = false
  /** Pool key a leaving copy waits under once faded. */
  key: string | undefined

  constructor(owner: Owner, element: Element, copy: Copy, reduced = false) {
    this.#owner = owner
    this.element = element
    this.copy = copy
    this.prop = reduced ? 'opacity' : 'presence'
    this.scale = reduced ? copy.opacity : 1
  }

  get presence(): number {
    return this.prop === 'presence' ? this.copy.presence : this.#value
  }
  set presence(value: number) {
    this.set(value)
    this.#owner.touch()
  }
  /** Write from the built-in clock. Doesn't count as activity. */
  set(value: number): void {
    this.#value = clamp(value)
    this.copy[this.prop] = this.scale * this.#value
  }
}
