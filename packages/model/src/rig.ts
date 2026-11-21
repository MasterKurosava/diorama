// What `model` shares with the effects that work on its scene from the same element.
import type { Box3, Group, Object3D } from 'three/webgpu'

/** The placed model of an element, as `model` publishes it. */
export interface Rig {
  /** The normalised wrapper from `ctx.model`: the file's scene is its only child. */
  readonly scene: Group
  /** The group `model` turns. Its rotation is the pose, drag, spin, scroll turn and tilt. */
  readonly pivot: Group
  /** The file's scene, whose coordinates the markup uses. */
  readonly file: Object3D
  /** The model's layer root, at the centre of its box. */
  readonly root: Object3D
  /** The model element's box this frame, viewport px. */
  readonly box: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /**
   * Turns the model so that this yaw and pitch (radians, the model's own rotation) face the
   * viewer: through the same easing as the arrow keys, at once under reduced motion. Pitch is
   * held to the model's limit.
   */
  face(yaw: number, pitch: number): void
  /**
   * Bounds of parts in the file's coordinates to fit in the box and centre on the pivot instead
   * of the file's own, as parts move apart; undefined goes back to the file's bounds.
   */
  contain(boxes: readonly Box3[] | undefined): void
  /** Requests a frame of the element's layer. */
  invalidate(): void
}

type Listener = (rig: Rig | undefined) => void

const rigs = new WeakMap<Element, Rig>()
const listeners = new WeakMap<Element, Set<Listener>>()

/** Called by `model`: the element's rig, or undefined when it goes. */
export function publish(element: Element, rig: Rig | undefined): void {
  if (rig) rigs.set(element, rig)
  else rigs.delete(element)
  for (const listener of listeners.get(element) ?? []) listener(rig)
}

/** The element's rig now, if `model` placed one. */
export const rigOf = (element: Element): Rig | undefined => rigs.get(element)

/**
 * Calls `listener` with the element's rig now if there is one, then on every change: a new rig
 * when `model` rebuilds, undefined when it goes. Stops with the signal.
 */
export function watchRig(element: Element, listener: Listener, signal: AbortSignal): void {
  const own = listeners.get(element) ?? new Set()
  listeners.set(element, own)
  own.add(listener)
  signal.addEventListener('abort', () => own.delete(listener), { once: true })
  const now = rigs.get(element)
  if (now) listener(now)
}
