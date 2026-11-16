import { definePlugin } from '../kernel/plugin'
import type { Plugin } from '../kernel/types'
import { velocityTracker } from './motion'

/** Live pointer state, updated in place in the `input` stage. */
export interface PointerState {
  /** Viewport position, CSS px. */
  readonly x: number
  readonly y: number
  /** Normalized device coordinates, -1..1, y up. */
  readonly nx: number
  readonly ny: number
  /** Smoothed velocity, px/s. Reading it while it decays keeps frames coming. */
  readonly vx: number
  readonly vy: number
  /** The pointer is over the page. A touch leaves when the finger lifts. */
  readonly inside: boolean
  /** Device of the last pointer event. */
  readonly type: 'mouse' | 'pen' | 'touch'
}

export interface PointerApi {
  readonly state: PointerState
}

export const pointer: Plugin<'pointer'> = /*#__PURE__*/ definePlugin({
  name: 'pointer',
  dependencies: ['stage'],
  setup(app): PointerApi {
    const trackX = velocityTracker(app)
    const trackY = velocityTracker(app)
    const state = {
      x: 0,
      y: 0,
      nx: 0,
      ny: 0,
      get vx() {
        return trackX.value
      },
      get vy() {
        return trackY.value
      },
      inside: false,
      type: 'mouse' as PointerState['type'],
    }
    if (typeof window === 'undefined') return { state }

    const { stage } = app
    let x = 0
    let y = 0
    const listen = { signal: app.abortSignal, passive: true }
    const move = (e: PointerEvent): void => {
      x = e.clientX
      y = e.clientY
      state.type = e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse'
      state.inside = true
      app.invalidate()
    }
    const leave = (): void => {
      state.inside = false
      app.invalidate()
    }
    // A lifted finger hovers nothing. Without this, hover sticks after a tap.
    const lift = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') leave()
    }
    window.addEventListener('pointermove', move, listen)
    window.addEventListener('pointerdown', move, listen)
    window.addEventListener('pointerup', lift, listen)
    window.addEventListener('pointercancel', lift, listen)
    document.documentElement.addEventListener('pointerleave', leave, listen)

    // Entering (first move, back over the page, a new touch) re-bases without a velocity spike.
    let inside = false
    app.system(
      'input',
      (t) => {
        const entered = state.inside && !inside
        inside = state.inside
        trackX.update(entered ? 0 : x - state.x, t)
        trackY.update(entered ? 0 : y - state.y, t)
        state.x = x
        state.y = y
        state.nx = (x / (stage.width.peek() || 1)) * 2 - 1
        state.ny = 1 - (y / (stage.height.peek() || 1)) * 2
      },
      { name: 'pointer' },
    )
    return { state }
  },
})
