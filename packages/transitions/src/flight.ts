// The two kinds of moving copies a transition steps: a flight (a keyed pair flying from the old
// element to the new one) and a presence (an unpaired copy fading out or in).
import type { Anchor } from '@dioramajs/core'
import type { Box, Copy, Crop } from '@dioramajs/effects'
import { alike, clamp, framing, type Pose, poseOf } from './geometry'
import type { Source } from './transition'
import type { Flight, FlightState, Presence } from './types'

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
  /** `targetBox` comes from the pose the target's own effects give it (`copy.posed`). */
  posed = false
  /** The target was drawable in an earlier frame, so its effects have run and posed it. */
  warm = false
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

/**
 * The crop of the flying copy at `box`, `t` of the way to `to`. It ends on the target's framing if
 * both show the same picture, else on the copy's own object-fit there.
 */
export function flightCrop(flight: FlightImpl, to: Box, box: Box, t: number): Crop | undefined {
  const { copy } = flight
  if (flight.cropPose !== flight.pose) {
    flight.cropPose = flight.pose
    flight.crop = copy.crop ?? copy.cropAt(flight.pose)
  }
  const own = copy.cropAt(to)
  if (!flight.crop || !own) return undefined
  const target = flight.target && flight.target !== copy ? flight.target.cropAt(to) : undefined
  const end = target && alike(target, to, own, to) ? target : own
  return framing(flight.crop, flight.pose, end, to, box, t)
}

/** Current pose of the flying copy, at the alpha the pair covers. */
export function here(flight: FlightImpl): Pose {
  const pose = poseOf(flight.copy)
  return pose ? { ...pose, opacity: flight.cover } : flight.pose
}

/**
 * Draws the flying copy at `(1 - share) * cover` and `under` beneath it in the same pose, so the
 * two add up to exactly `cover` with `under` making up `share` of it. No dip or flash at any share.
 */
export function show(flight: FlightImpl, under: Copy | undefined): void {
  const { copy, share, cover } = flight
  copy.opacity = (1 - share) * cover
  copy.veil = share >= 1
  if (!under) return
  under.box = copy.box
  const own = copy.crop && copy.box ? under.cropAt(copy.box) : undefined
  const sameFraming = own && copy.crop && copy.box && alike(own, copy.box, copy.crop, copy.box)
  under.crop = sameFraming ? copy.crop : undefined
  under.clip = copy.clip
  under.radius = copy.radius
  under.above = copy.above - 1
  under.veil = false
  // A router re-render may remove its node mid-flight. Let it fade out as a ghost then.
  under.leave = 'ghost'
  const rest = 1 - copy.opacity
  under.opacity = share > 0 && rest > 0 ? clamp((share * cover) / rest) : 0
}

/** An unpaired copy leaving or entering a page. */
export class PresenceImpl implements Presence {
  readonly element: Element
  readonly copy: Copy
  /** Opacity under reduced motion, since custom effects may animate on `u.presence`. */
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
