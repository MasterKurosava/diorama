import type { LayerImpl } from './layer'

/** Quiet time after which the watcher sleeps, ms. */
const IDLE = 1000

/**
 * Wakes the loop when the DOM moves without events the kernel sees, such as GSAP tweens of
 * `transform` or `opacity`, CSS animations and slider tracks. Runs its own rAF without drawing
 * and invalidates only when the box or opacity of a visible moving layer changed.
 */
export class Watcher {
  readonly #layers: () => Iterable<LayerImpl>
  readonly #invalidate: () => void
  /** x, y, width, height and opacity per layer at the last tick. */
  readonly #seen = new WeakMap<LayerImpl, number[]>()
  #frame = 0
  #quiet = 0

  constructor(layers: () => Iterable<LayerImpl>, invalidate: () => void, signal: AbortSignal) {
    this.#layers = layers
    this.#invalidate = invalidate
    if (typeof window === 'undefined') return
    const wake = (): void => this.wake()
    const options = { passive: true, capture: true, signal }
    for (const type of ['scroll', 'resize']) window.addEventListener(type, wake, options)
    for (const type of ['pointerdown', 'pointermove', 'transitionrun', 'animationstart']) {
      document.addEventListener(type, wake, options)
    }
    signal.addEventListener('abort', () => cancelAnimationFrame(this.#frame), { once: true })
  }

  wake(): void {
    if (this.#frame || typeof requestAnimationFrame !== 'function') return
    this.#quiet = performance.now()
    this.#frame = requestAnimationFrame(this.#tick)
  }

  readonly #tick = (now: number): void => {
    this.#frame = 0
    let targets = 0
    let awake = false
    let moved = false
    for (const layer of this.#layers()) {
      const frame = layer.mode === 'frame'
      if (!layer.visible || !(frame || layer.inputs.styles.moving)) continue
      targets++
      awake ||= frame
      const { x, y, width, height } = layer.element.getBoundingClientRect()
      const opacity = layer.inputs.styles.opacity()
      const last = this.#seen.get(layer) ?? []
      this.#seen.set(layer, last)
      if (
        last[0] !== x ||
        last[1] !== y ||
        last[2] !== width ||
        last[3] !== height ||
        last[4] !== opacity
      ) {
        last[0] = x
        last[1] = y
        last[2] = width
        last[3] = height
        last[4] = opacity
        moved = true
      }
    }
    if (moved) {
      this.#quiet = now
      this.#invalidate()
    }
    if (!targets || (!awake && now - this.#quiet > IDLE)) return
    this.#frame = requestAnimationFrame(this.#tick)
  }
}
