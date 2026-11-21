// Turning an object under a drag with a little inertia, and with the arrow keys: coin and label.
import type { EffectInput } from '@dioramajs/effects'
import { damp } from '@dioramajs/effects/kit'

const TAU = Math.PI * 2
/** Fastest coast after a drag, radians per second. */
const COAST_MAX = TAU * 2
/** A drag held still this long before letting go does not coast, ms. */
const COAST_HOLD = 80
/** Coasting stops below this speed, radians per second. */
const COAST_STOP = 0.02
/** Half-lives, s: of the coast and of an arrow key step. */
const COAST_HALF_LIFE = 0.35
const KEY_HALF_LIFE = 0.08
/** A press that moved further than this, px, is a drag and not a tap. */
const TAP_SLOP = 4

export interface TurnOptions {
  /** Box of the element: a drag across it turns the object half a turn. */
  readonly input: EffectInput
  /** Whether a drag or a key may turn it now: the `drag` param. */
  enabled(): boolean
  /** Pitch limit of a vertical drag and the up and down keys, radians; 0 keeps it level. */
  readonly pitch: number
  /** One arrow key press, radians. */
  readonly step: number
  /** Requests a frame. */
  wake(): void
}

/**
 * Yaw and pitch offsets from a drag and the keys. They stay where the visitor leaves them; a
 * drag let go while moving coasts. A finger turns it only where the site gave the gesture to the
 * element (`touch-action: pan-y` or `none`), and tips it only with `none`.
 */
export class Turn {
  yaw = 0
  pitch = 0
  /** A drag moved more than a few px since the press: its click is no tap. */
  dragged = false
  #velocity = 0
  #yawKey = 0
  #pitchKey = 0
  #grab: { id: number; x: number; y: number; t: number; tip: boolean; moved: number } | undefined
  readonly #options: TurnOptions

  constructor(el: HTMLElement, signal: AbortSignal, o: TurnOptions) {
    this.#options = o
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, fn, { signal })
    listen('pointerdown', (e) => {
      if (this.#grab || !o.enabled() || e.button !== 0) return
      const mouse = e.pointerType !== 'touch'
      const action = getComputedStyle(el).touchAction
      const free = action === 'none'
      if (!mouse && !free && !(action.includes('pan-y') && !action.includes('pan-x'))) return
      this.#grab = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        tip: mouse || free,
        moved: 0,
      }
      this.dragged = false
      this.#velocity = 0
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
      // No text selection and no native drag of the image.
      if (mouse) e.preventDefault()
    })
    listen('pointermove', (e) => {
      const grab = this.#grab
      if (e.pointerId !== grab?.id) return
      const dx = ((e.clientX - grab.x) * Math.PI) / Math.max(1, o.input.width)
      const dy = grab.tip ? ((e.clientY - grab.y) * Math.PI) / Math.max(1, o.input.height) : 0
      const seconds = Math.max(1, e.timeStamp - grab.t) / 1000
      // The release speed is smoothed over the last few moves.
      this.#velocity = this.#velocity * 0.2 + (dx / seconds) * 0.8
      this.yaw += dx
      this.pitch = this.#hold(this.pitch + dy)
      const moved = grab.moved + Math.hypot(e.clientX - grab.x, e.clientY - grab.y)
      if (moved > TAP_SLOP) this.dragged = true
      this.#grab = { ...grab, x: e.clientX, y: e.clientY, t: e.timeStamp, moved }
      o.wake()
    })
    const release = (e: PointerEvent): void => {
      const grab = this.#grab
      if (e.pointerId !== grab?.id) return
      // Held still before letting go, cancelled by a scroll, or no motion wanted: no coasting.
      if (e.type !== 'pointerup' || e.timeStamp - grab.t > COAST_HOLD || o.input.reducedMotion)
        this.#velocity = 0
      this.#velocity = Math.min(COAST_MAX, Math.max(-COAST_MAX, this.#velocity))
      this.#grab = undefined
      o.wake()
    }
    listen('pointerup', release)
    listen('pointercancel', release)
    listen('dragstart', (e) => e.preventDefault())
    listen('keydown', (e) => {
      if (!o.enabled() || !el.hasAttribute('tabindex')) return
      const x = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      const y = o.pitch > 0 ? (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0) : 0
      if (!x && !y) return
      e.preventDefault()
      this.#yawKey += x * o.step
      this.#pitchKey += y * o.step
      o.wake()
    })
  }

  /** A pointer holds it now. */
  get held(): boolean {
    return this.#grab !== undefined
  }

  #hold(pitch: number): number {
    const limit = this.#options.pitch
    return Math.max(-limit, Math.min(limit, pitch))
  }

  /** Stops the coasting and the keys' easing. */
  stop(): void {
    this.#velocity = 0
    this.yaw += this.#yawKey
    this.pitch = this.#hold(this.pitch + this.#pitchKey)
    this.#yawKey = 0
    this.#pitchKey = 0
  }

  /** Coasts and eases the key steps by `dt` seconds; true while it still moves. */
  advance(dt: number, reduced: boolean): boolean {
    if (this.#velocity && !this.#grab) {
      this.yaw += this.#velocity * dt
      this.#velocity =
        Math.abs(this.#velocity) < COAST_STOP ? 0 : damp(this.#velocity, 0, COAST_HALF_LIFE, dt)
    }
    // Arrow keys ease to the next step, or jump to it under reduced motion.
    const ease = (left: number): number => {
      if (reduced) return 0
      return damp(left, 0, KEY_HALF_LIFE, dt, 1e-4)
    }
    if (this.#yawKey) {
      const rest = ease(this.#yawKey)
      this.yaw += this.#yawKey - rest
      this.#yawKey = rest
    }
    if (this.#pitchKey) {
      const rest = ease(this.#pitchKey)
      this.pitch = this.#hold(this.pitch + this.#pitchKey - rest)
      this.#pitchKey = Math.abs(this.pitch) >= this.#options.pitch ? 0 : rest
    }
    return this.#velocity !== 0 || this.#yawKey !== 0 || this.#pitchKey !== 0
  }
}
