import { definePlugin } from '../kernel/plugin'
import type { Plugin } from '../kernel/types'
import { velocityTracker } from './motion'

/**
 * Live pointer state. A move asks for a frame only if someone read the position in the last
 * frame (or since), so a page whose effects ignore the pointer draws nothing on mouse moves.
 */
export interface PointerState {
  /** Viewport position, CSS px. */
  readonly x: number
  /** Viewport y, CSS px. */
  readonly y: number
  /** Normalized device coordinates, -1..1, y up. */
  readonly nx: number
  /** Normalized y, -1..1, up is positive. */
  readonly ny: number
  /** Smoothed velocity, px/s. Reading it while it decays keeps frames coming. */
  readonly vx: number
  /** Smoothed vertical velocity, px/s. */
  readonly vy: number
  /** The pointer is over the page. A touch leaves when the finger lifts. */
  readonly inside: boolean
  /** Device of the last pointer event. */
  readonly type: 'mouse' | 'pen' | 'touch'
}

/** The `pointer` service. */
export interface PointerApi {
  /** Pointer state, updated in place every frame. */
  readonly state: PointerState
}

/** Tracks the pointer over the page. Built in. */
export const pointer: Plugin<'pointer'> = /*#__PURE__*/ definePlugin({
  name: 'pointer',
  dependencies: ['stage'],
  setup(app): PointerApi {
    const trackX = velocityTracker(app)
    const trackY = velocityTracker(app)
    let x = 0
    let y = 0
    let inside = false
    // The frame of the last read. Moves wake the loop only for a reader.
    let readFrame = -1
    const markRead = (): void => {
      readFrame = app.loop.time.frame
    }
    const state = {
      get x() {
        markRead()
        return x
      },
      get y() {
        markRead()
        return y
      },
      get nx() {
        markRead()
        return (x / (app.stage.width.peek() || 1)) * 2 - 1
      },
      get ny() {
        markRead()
        return 1 - (y / (app.stage.height.peek() || 1)) * 2
      },
      get vx() {
        markRead()
        return trackX.value
      },
      get vy() {
        markRead()
        return trackY.value
      },
      get inside() {
        markRead()
        return inside
      },
      type: 'mouse' as PointerState['type'],
    }
    if (typeof window === 'undefined') return { state }

    const wake = (): void => {
      if (readFrame >= app.loop.time.frame) app.invalidate()
    }
    const listen = { signal: app.abortSignal, passive: true }
    const move = (event: PointerEvent): void => {
      x = event.clientX
      y = event.clientY
      const { pointerType } = event
      state.type = pointerType === 'touch' || pointerType === 'pen' ? pointerType : 'mouse'
      inside = true
      wake()
    }
    const leave = (): void => {
      inside = false
      wake()
    }
    // A lifted finger hovers nothing. Without this, hover sticks after a tap.
    const lift = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') leave()
    }
    window.addEventListener('pointermove', move, listen)
    window.addEventListener('pointerdown', move, listen)
    window.addEventListener('pointerup', lift, listen)
    window.addEventListener('pointercancel', lift, listen)
    document.documentElement.addEventListener('pointerleave', leave, listen)

    // Velocity is fed per frame. Entering (first move, back over the page, a new touch)
    // re-bases without a spike.
    let lastX = 0
    let lastY = 0
    let wasInside = false
    app.system(
      'input',
      (time) => {
        const entered = inside && !wasInside
        wasInside = inside
        trackX.update(entered ? 0 : x - lastX, time)
        trackY.update(entered ? 0 : y - lastY, time)
        lastX = x
        lastY = y
      },
      { name: 'pointer' },
    )
    return { state }
  },
})
