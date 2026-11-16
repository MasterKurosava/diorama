import { DioramaError } from './errors'
import { type Depth, MAX_DEPTH } from './events'
import { type Orderable, orderRefs, sortOrderables } from './order'
import type { Owner, Report } from './scope'
import type { Cancel, Off, OrderOptions } from './types'
import { isThenable, noop } from './util'

const CANCEL: Cancel = Object.freeze({ '~cancel': true, reason: undefined })

export function cancel(reason?: string): Cancel {
  return reason === undefined ? CANCEL : Object.freeze({ '~cancel': true, reason })
}

export function isCancel(value: unknown): value is Cancel {
  return (
    typeof value === 'object' && value !== null && (value as Partial<Cancel>)['~cancel'] === true
  )
}

/** before/after can target the entry name or its owning plugin. */
export function labelsOf(owner: Owner, name: string | undefined): string[] {
  const own = name ?? owner.label
  return owner.plugin && owner.plugin !== own ? [own, owner.plugin] : [own]
}

interface Handler extends Orderable {
  readonly fn: (value: unknown, context: unknown) => unknown
  readonly owner: Owner
  active: boolean
}

export class HookBus {
  readonly #chains = new Map<string, Handler[]>()
  readonly #versions = new Map<string, number>()
  #seq = 0
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
      seq: this.#seq++,
    }
    const sorted = sortOrderables([...(this.#chains.get(name) ?? []), handler])
    if (!Array.isArray(sorted)) {
      const path = sorted.cycle.map((h) => h.labels[0]).join(' → ')
      throw new DioramaError('ORDER_CYCLE', `hook "${name}": ${path}`, { plugin: owner.plugin })
    }
    this.#set(name, sorted)
    return owner.add(() => {
      if (!handler.active) return
      handler.active = false
      this.#set(
        name,
        (this.#chains.get(name) ?? []).filter((h) => h !== handler),
      )
    })
  }

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
      for (const h of chain) {
        if (!h.active || h.owner.disposed) continue
        let result: unknown
        try {
          result = h.fn(value, context)
        } catch (e) {
          this.#report(e, 'hook', h.owner, name)
          continue
        }
        if (result === undefined) continue
        if (isThenable(result)) {
          result.then(undefined, noop)
          this.#report(new Error(`async handler in sync hook "${name}"`), 'hook', h.owner, name)
        } else if (isCancel(result)) return result
        else value = result
      }
      return value
    } finally {
      this.#depth.value--
    }
  }

  async callAsync(name: string, value: unknown, context: unknown): Promise<unknown> {
    for (const h of this.#chains.get(name) ?? []) {
      if (!h.active || h.owner.disposed) continue
      let result: unknown
      try {
        result = await h.fn(value, context)
      } catch (e) {
        this.#report(e, 'hook', h.owner, name)
        continue
      }
      // An owner disposed while we awaited must not affect the value.
      if (result === undefined || h.owner.disposed) continue
      if (isCancel(result)) return result
      value = result
    }
    return value
  }

  version(name: string): number {
    return this.#versions.get(name) ?? 0
  }

  #set(name: string, chain: Handler[]): void {
    if (chain.length) this.#chains.set(name, chain)
    else this.#chains.delete(name)
    this.#versions.set(name, this.version(name) + 1)
  }
}
