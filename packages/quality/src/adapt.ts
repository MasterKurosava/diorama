// Frame pacing watch for the quality plugin: learns the screen refresh rate, then steps the tier
// down when too many browser frames come late while the site draws.
/** Sliding window of active drawing the share is taken over, ms. */
const WINDOW = 2000
/** Intervals measured before the refresh rate is known, ms. */
const LEARN = 1000
/** A slow interval is longer than this many screen periods. */
const SLOW = 1.5
/** Share of slow intervals in a full window that steps the tier down. */
const SHARE = 0.25
/** Longer intervals are pauses (a hidden tab, a dialog, a long task), not frame pacing. */
const PAUSE = 250

/**
 * Decides from browser frame intervals, not from the app's own frames: the loop draws on demand,
 * so its rate says nothing. Time is in ms on the `requestAnimationFrame` clock.
 */
export class Adapter {
  /** Screen period, ms. 0 until the first second of active drawing is measured. */
  period = 0
  readonly #learn: number[] = []
  readonly #window: number[] = []
  #sum = 0
  #slow = 0
  #prev: number | undefined
  #quiet = Number.NEGATIVE_INFINITY

  /** Share of slow intervals in the window now. */
  get share(): number {
    return this.#window.length ? this.#slow / this.#window.length : 0
  }

  /** A frame of the probe. True when the window is full and slow enough to step down. */
  frame(now: number): boolean {
    const prev = this.#prev
    this.#prev = now
    if (prev === undefined) return false
    const interval = now - prev
    // Started inside a quiet span (compiles, resizes, page changes) or a pause: not counted.
    if (prev < this.#quiet || interval > PAUSE) return false
    if (!this.period) {
      this.#learn.push(interval)
      if (this.#learn.reduce((a, b) => a + b, 0) >= LEARN) {
        const sorted = [...this.#learn].sort((a, b) => a - b)
        this.period = sorted[Math.floor(sorted.length * 0.1)] as number
      }
      return false
    }
    this.#window.push(interval)
    this.#sum += interval
    if (interval > SLOW * this.period) this.#slow++
    while (this.#sum - (this.#window[0] as number) >= WINDOW) this.#drop()
    return this.#sum >= WINDOW && this.share >= SHARE
  }

  /** The probe stopped: the gap to its next run is no interval. */
  stop(): void {
    this.#prev = undefined
  }

  /** Intervals starting before `until` are not counted. */
  quiet(until: number): void {
    this.#quiet = Math.max(this.#quiet, until)
  }

  /** Starts the window over, after a step or a new start. */
  clear(): void {
    while (this.#window.length) this.#drop()
  }

  #drop(): void {
    const interval = this.#window.shift() as number
    this.#sum -= interval
    if (interval > SLOW * this.period) this.#slow--
  }
}
