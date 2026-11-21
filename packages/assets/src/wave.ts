// Load progress for `assets.progress`, `ready()` and `data-dio-progress` bars.
import { type ReadonlySignal, type Signal, signal } from '@dioramajs/core'

/** Work in the wave, in bytes or an estimate. `loaded` never exceeds `total`. */
export interface Item {
  total: number
  loaded: number
}

/** Progress stops here until the wave is done. 1 means `ready()` resolved. */
const BEFORE_END = 0.99

/**
 * The current wave of high and normal work. It starts when pending items appear, only grows,
 * and stays at 1 until the next wave starts from 0. Work of no weight (a decode the next frame
 * waits for) holds `ready()` but starts no wave of its own: the bar stays where it is.
 * `data-dio-progress` elements follow the first wave and the waves that start during a page
 * transition only: a texture loading as its section nears does not pull a bar back mid-scroll.
 */
export class Wave {
  readonly #progress: Signal<number> = signal(0)
  readonly progress: ReadonlySignal<number> = this.#progress
  readonly #pending = new Set<Item>()
  #done = 0
  /** The wave has weighed work, so progress moves. */
  #shown = false
  /** No weighed wave has ended yet: the page is still loading. */
  #first = true
  /** `data-dio-progress` elements follow this wave. */
  #bar = true
  #waiters: (() => void)[] = []
  #elements: HTMLElement[] = []
  readonly #find: () => HTMLElement[]

  constructor(find: () => HTMLElement[]) {
    this.#find = find
    this.#elements = find()
    this.#write()
  }

  add(item: Item): void {
    if (this.#pending.has(item)) return
    if (!this.#pending.size) {
      this.#done = 0
      this.#shown = false
    }
    this.#pending.add(item)
    if (!this.#shown && item.total > 0) {
      this.#shown = true
      this.#bar =
        this.#first ||
        (typeof document !== 'undefined' &&
          document.documentElement.hasAttribute('data-dio-transition'))
      if (this.#bar) this.#elements = this.#find()
      this.#set(0)
    }
    this.changed()
  }

  /** A page change: the bar follows the wave under way, or else the next one. */
  page(): void {
    this.#first = true
    if (!this.#shown || this.#bar || !this.#pending.size) return
    this.#bar = true
    this.#elements = this.#find()
    this.#write()
  }

  /** The item settled, failed or became low and left the wave. Counted as done. */
  done(item: Item): void {
    if (!this.#pending.delete(item)) return
    this.#done += item.total
    if (this.#pending.size) {
      this.changed()
      return
    }
    if (this.#shown || this.#progress.peek() < 1) this.#set(1)
    if (this.#shown) this.#first = false
    for (const resolve of this.#waiters.splice(0)) resolve()
  }

  changed(): void {
    if (!this.#pending.size || !this.#shown) return
    let loaded = this.#done
    let total = this.#done
    for (const item of this.#pending) {
      loaded += Math.min(item.loaded, item.total)
      total += item.total
    }
    const ratio = total > 0 ? Math.min(loaded / total, BEFORE_END) : 0
    if (ratio > this.#progress.peek()) this.#set(ratio)
  }

  ready(): Promise<void> {
    return this.#pending.size
      ? new Promise((resolve) => this.#waiters.push(resolve))
      : Promise.resolve()
  }

  /** Ends the wave and settles waiters. */
  close(): void {
    this.#pending.clear()
    for (const resolve of this.#waiters.splice(0)) resolve()
  }

  #set(value: number): void {
    this.#progress.value = value
    if (this.#bar) this.#write()
  }

  #write(): void {
    const value = String(this.#progress.peek())
    for (const el of this.#elements) el.style.setProperty('--dio-progress', value)
  }
}
