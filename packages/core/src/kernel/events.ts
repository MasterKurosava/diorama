import { DioramaError } from './errors'
import type { Owner, Report } from './scope'
import type { Off } from './types'
import { isThenable, noop } from './util'

/** Nesting counter shared by events and hooks. */
export interface Depth {
  value: number
}

/** Emits and hook calls nested deeper than this are reported as RECURSION and skipped. */
export const MAX_DEPTH = 64

interface Listener {
  readonly fn: (payload: unknown) => unknown
  readonly owner: Owner
  readonly once: boolean
  active: boolean
  off: Off
}

/** Event listeners by name. Errors in listeners are reported and never reach the emitter. */
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
    const listener: Listener = { fn, owner, once, active: true, off: noop }
    this.#channels.set(name, [...(this.#channels.get(name) ?? []), listener])
    listener.off = owner.add(() => {
      if (!listener.active) return
      listener.active = false
      const rest = (this.#channels.get(name) ?? []).filter((other) => other !== listener)
      if (rest.length) this.#channels.set(name, rest)
      else this.#channels.delete(name)
    })
    return listener.off
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
      for (const listener of list) {
        // `active` skips listeners removed earlier in this same delivery.
        if (!listener.active || listener.owner.disposed) continue
        if (listener.once) listener.off()
        try {
          const result = listener.fn(payload)
          if (isThenable(result)) {
            result.then(undefined, (error) => this.#report(error, 'listener', listener.owner, name))
          }
        } catch (error) {
          this.#report(error, 'listener', listener.owner, name)
        }
      }
    } finally {
      this.#depth.value--
    }
  }
}
