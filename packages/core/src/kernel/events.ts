import { DioramaError } from './errors'
import type { Owner, Report } from './scope'
import type { Off } from './types'
import { isThenable, noop } from './util'

/** Nesting counter shared by events and hooks. */
export interface Depth {
  value: number
}

export const MAX_DEPTH = 64

interface Listener {
  readonly fn: (payload: unknown) => unknown
  readonly owner: Owner
  readonly once: boolean
  active: boolean
  off: Off
}

export class EventBus {
  // Lists are copied on write, so a running emit keeps iterating its own snapshot.
  readonly #channels = new Map<string, Listener[]>()
  readonly #report: Report
  readonly #depth: Depth

  constructor(report: Report, depth: Depth) {
    this.#report = report
    this.#depth = depth
  }

  on(name: string, fn: (payload: unknown) => unknown, owner: Owner, once: boolean): Off {
    if (!owner.open()) return noop
    const entry: Listener = { fn, owner, once, active: true, off: noop }
    this.#channels.set(name, [...(this.#channels.get(name) ?? []), entry])
    entry.off = owner.add(() => {
      if (!entry.active) return
      entry.active = false
      const rest = (this.#channels.get(name) ?? []).filter((e) => e !== entry)
      if (rest.length) this.#channels.set(name, rest)
      else this.#channels.delete(name)
    })
    return entry.off
  }

  emit(name: string, payload: unknown): void {
    const list = this.#channels.get(name)
    if (!list) return
    if (this.#depth.value >= MAX_DEPTH) {
      this.#report(
        new DioramaError('RECURSION', `"${name}" nested too deep`),
        'listener',
        undefined,
        name,
      )
      return
    }
    this.#depth.value++
    try {
      for (const entry of list) {
        // `active` skips listeners removed earlier in this same delivery.
        if (!entry.active || entry.owner.disposed) continue
        if (entry.once) entry.off()
        try {
          const result = entry.fn(payload)
          if (isThenable(result))
            result.then(undefined, (e) => this.#report(e, 'listener', entry.owner, name))
        } catch (e) {
          this.#report(e, 'listener', entry.owner, name)
        }
      }
    } finally {
      this.#depth.value--
    }
  }
}
