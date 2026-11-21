import type { FrameTime } from '../kernel/types'

/** Smoothing rate of velocities, per second. Frame-rate independent. */
const SMOOTHING = 10
/** Below this speed (px/s) motion counts as settled. */
const REST_SPEED = 1
/** Without frames for this long (ms) a velocity counts as settled. */
const STALE_MS = 100

/** A smoothed velocity fed once per frame. */
export interface VelocityTracker {
  /** The smoothed velocity. Reading it before it settles asks for the next frame. */
  readonly value: number
  /** Feeds the distance moved since the previous frame. */
  update(distance: number, t: FrameTime): void
}

/**
 * Exponentially smoothed velocity. Frames keep coming while someone reads it as it decays, so
 * effects driven by it ease out instead of freezing mid-motion. Unread, it asks for none.
 */
export function velocityTracker(app: {
  invalidate(): void
  readonly loop: { readonly driver: { now(): number } }
}): VelocityTracker {
  let velocity = 0
  /** Driver time of the last update. */
  let updatedAt = 0
  return {
    get value() {
      if (velocity) {
        // Nobody read it while frames were stopped, so it would have settled by now.
        if (app.loop.driver.now() - updatedAt > STALE_MS) velocity = 0
        else app.invalidate()
      }
      return velocity
    },
    update(distance, time) {
      const instant = time.delta > 0 ? distance / time.delta : 0
      velocity += (instant - velocity) * (1 - Math.exp(-time.delta * SMOOTHING))
      if (Math.abs(velocity) <= REST_SPEED) velocity = 0
      updatedAt = time.now
    },
  }
}
