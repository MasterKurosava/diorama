import { type ReadonlySignal, type Signal, signal } from '@diorama/core'

/** Work in the wave, in bytes or an estimate. `loaded` never exceeds `total`. */
export interface Item {
  total: number
  loaded: number
}

/** Progress stops here until the wave is done. 1 means `ready()` resolved. */
const BEFORE_END = 0.99

/**
 * The current wave of high and normal work. It starts when pending items appear, only grows,
 * and stays at 1 until the next wave starts from 0.
 */
export class Wave {
  readonly #progress: Signal<number> = signal(0)
  readonly progress: ReadonlySignal<number> = this.#progress
  readonly #pending = new Set<Item>()
  #done = 0
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
      this.#elements = this.#find()
      this.#set(0)
    }
    this.#pending.add(item)
    this.changed()
  }

  /** The item settled, failed or became low and left the wave. Counted as done. */
  done(item: Item): void {
    if (!this.#pending.delete(item)) return
    this.#done += item.total
    if (this.#pending.size) {
      this.changed()
      return
    }
    this.#set(1)
    for (const resolve of this.#waiters.splice(0)) resolve()
  }

  changed(): void {
    if (!this.#pending.size) return
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
    this.#write()
  }

  #write(): void {
    const value = String(this.#progress.peek())
    for (const el of this.#elements) el.style.setProperty('--dio-progress', value)
  }
}
