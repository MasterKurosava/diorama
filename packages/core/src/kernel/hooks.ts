import { DioramaError } from './errors'
import { type Depth, MAX_DEPTH } from './events'
import { type Orderable, orderRefs, sortOrderables } from './order'
import type { Owner, Report } from './scope'
import type { Cancel, Off, OrderOptions } from './types'
import { isThenable, noop } from './util'

const CANCEL: Cancel = Object.freeze({ '~cancel': true, reason: undefined })

/** Returned from a hook handler to stop the chain. `callHook` then returns it. */
export function cancel(reason?: string): Cancel {
  return reason === undefined ? CANCEL : Object.freeze({ '~cancel': true, reason })
}

/** Whether a hook result is a `cancel()`. */
export function isCancel(value: unknown): value is Cancel {
  return (
    typeof value === 'object' && value !== null && (value as Partial<Cancel>)['~cancel'] === true
  )
}

/** Labels of an ordered entry: `before`/`after` can target its own name or its plugin. */
export function labelsOf(owner: Owner, name: string | undefined): string[] {
  const own = name ?? owner.label
  return owner.plugin && owner.plugin !== own ? [own, owner.plugin] : [own]
}

interface Handler extends Orderable {
  readonly fn: (value: unknown, context: unknown) => unknown
  readonly owner: Owner
  active: boolean
}

/** Hook handlers by name, sorted by their order options. */
export class HookBus {
  readonly #chains = new Map<string, Handler[]>()
  /** Bumped whenever a chain changes, so callers can cache hook results. */
  readonly #versions = new Map<string, number>()
  #nextSeq = 0
  readonly #report: Report
  readonly #depth: Depth

  constructor(report: Report, depth: Depth) {
    this.#report = report
    this.#depth = depth
  }

  add(name: string, fn: Handler['fn'], owner: Owner, options?: OrderOptions): Off {
    if (!owner.open()) return noop
    const handler: Handler = {
      fn,
      owner,
      active: true,
      labels: labelsOf(owner, options?.name),
      before: orderRefs(options?.before),
      after: orderRefs(options?.after),
      rank: owner.rank,
      seq: this.#nextSeq++,
    }
    const sorted = sortOrderables([...(this.#chains.get(name) ?? []), handler])
    if (!Array.isArray(sorted)) {
      const path = sorted.cycle.map((entry) => entry.labels[0]).join(' → ')
      throw new DioramaError('ORDER_CYCLE', `hook "${name}": ${path}`, { plugin: owner.plugin })
    }
    this.#setChain(name, sorted)
    return owner.add(() => {
      if (!handler.active) return
      handler.active = false
      const rest = (this.#chains.get(name) ?? []).filter((other) => other !== handler)
      this.#setChain(name, rest)
    })
  }

  /**
   * Runs a sync chain. Each handler gets the value the previous one returned. A `cancel()`
   * stops the chain and is returned as the result. An async handler is reported and ignored.
   */
  call(name: string, value: unknown, context: unknown): unknown {
    const chain = this.#chains.get(name)
    if (!chain) return value
    if (this.#depth.value >= MAX_DEPTH) {
      this.#report(
        new DioramaError('RECURSION', `hook "${name}" nested too deep`),
        'hook',
        undefined,
        name,
      )
      return value
    }
    this.#depth.value++
    try {
      for (const handler of chain) {
        if (!handler.active || handler.owner.disposed) continue
        let result: unknown
        try {
          result = handler.fn(value, context)
        } catch (error) {
          this.#report(error, 'hook', handler.owner, name)
          continue
        }
        if (result === undefined) continue
        if (isThenable(result)) {
          result.then(undefined, noop)
          const error = new Error(`async handler in sync hook "${name}"`)
          this.#report(error, 'hook', handler.owner, name)
        } else if (isCancel(result)) {
          return result
        } else {
          value = result
        }
      }
      return value
    } finally {
      this.#depth.value--
    }
  }

  /** Runs a chain like `call`, awaiting each handler in turn. */
  async callAsync(name: string, value: unknown, context: unknown): Promise<unknown> {
    for (const handler of this.#chains.get(name) ?? []) {
      if (!handler.active || handler.owner.disposed) continue
      let result: unknown
      try {
        result = await handler.fn(value, context)
      } catch (error) {
        this.#report(error, 'hook', handler.owner, name)
        continue
      }
      // An owner disposed while we awaited must not affect the value.
      if (result === undefined || handler.owner.disposed) continue
      if (isCancel(result)) return result
      value = result
    }
    return value
  }

  version(name: string): number {
    return this.#versions.get(name) ?? 0
  }

  #setChain(name: string, chain: Handler[]): void {
    if (chain.length) this.#chains.set(name, chain)
    else this.#chains.delete(name)
    this.#versions.set(name, this.version(name) + 1)
  }
}
