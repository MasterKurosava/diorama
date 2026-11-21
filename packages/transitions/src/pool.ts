import type { Copy } from '@dioramajs/effects'
import { hold, poseOf } from './geometry'

/**
 * Unpaired keyed ghosts wait here, invisible, for `grace` seconds in case a late partner shows up
 * (Next `loading.tsx`, streaming, Suspense). One ghost per key. Disabled when `grace` is 0.
 */
export class Pool {
  readonly #entries = new Map<string, { copy: Copy; timer: ReturnType<typeof setTimeout> }>()
  readonly #grace: () => number
  readonly #changed: () => void

  constructor(grace: () => number, changed: () => void) {
    this.#grace = grace
    this.#changed = changed
  }

  get size(): number {
    return this.#entries.size
  }

  add(key: string, copy: Copy): void {
    const pose = poseOf(copy)
    if (this.#entries.has(key) || !pose || !(this.#grace() > 0)) {
      copy.release()
      return
    }
    // Pin the pose a late partner will fly from, and veil it so the waiting ghost isn't drawn.
    hold(copy, pose)
    copy.opacity = 0
    copy.presence = 1
    copy.above = 0
    copy.veil = true
    const timer = setTimeout(() => this.take(key)?.release(), this.#grace() * 1000)
    this.#entries.set(key, { copy, timer })
    this.#changed()
  }

  take(key: string): Copy | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    clearTimeout(entry.timer)
    this.#entries.delete(key)
    this.#changed()
    if (entry.copy.state === 'released') return undefined
    entry.copy.veil = false
    return entry.copy
  }

  clear(): void {
    for (const { copy } of this.#entries.values()) copy.release()
    for (const key of [...this.#entries.keys()]) this.take(key)
  }
}
