import { DEV, isEffect, query } from './define'
import { EffectError } from './errors'
import type { Effect, EffectEntry, EffectLoader, EffectSource, ParamSpec } from './types'

export interface RegistryEntry {
  readonly source: EffectSource
  /** Given directly, or set once the module has loaded. */
  effect: Effect | undefined
  pending: Promise<Effect | undefined> | undefined
  /** The import was rejected. Not retried until `register` replaces the entry. */
  failed: boolean
}

export interface RegistryEvents {
  loaded(name: string, effect: Effect): void
  failed(name: string, error: EffectError): void
  warn(message: string): void
}

const loaderOf = (source: EffectSource): EffectLoader | undefined =>
  isEffect(source)
    ? undefined
    : typeof source === 'function'
      ? (source as EffectLoader)
      : source.load

const entryOf = (source: EffectSource): EffectEntry | undefined =>
  typeof source === 'object' && source !== null ? source : undefined

/** Definitions and lazy entries by key, each loaded at most once. */
export class Registry {
  readonly entries: Map<string, RegistryEntry> = new Map()
  readonly #events: RegistryEvents

  constructor(events: RegistryEvents) {
    this.#events = events
  }

  set(name: string, source: EffectSource): RegistryEntry {
    const entry: RegistryEntry = {
      source,
      effect: isEffect(source) ? source : undefined,
      pending: undefined,
      failed: false,
    }
    this.entries.set(name, entry)
    return entry
  }

  /** Param defaults known now: the definition's, else the entry's metadata. */
  spec(name: string): ParamSpec | undefined {
    const entry = this.entries.get(name)
    if (!entry) return undefined
    return entry.effect ? (entry.effect['~definition'].params ?? {}) : entryOf(entry.source)?.params
  }

  /** The entry's `when` beats the definition's, so a site can enable an effect on touch. */
  when(name: string): string | undefined {
    const entry = this.entries.get(name)
    return query(
      entryOf(entry?.source as EffectSource)?.when ?? entry?.effect?.['~definition'].when,
    )
  }

  reducedMotion(name: string): 'static' | 'off' | undefined {
    const entry = this.entries.get(name)
    return (
      entry?.effect?.['~definition'].reducedMotion ??
      entryOf(entry?.source as EffectSource)?.reducedMotion
    )
  }

  load(name: string): Promise<Effect | undefined> {
    const entry = this.entries.get(name)
    if (!entry || entry.failed) return Promise.resolve(undefined)
    if (entry.effect) return Promise.resolve(entry.effect)
    const loader = loaderOf(entry.source) as EffectLoader
    entry.pending ??= Promise.resolve()
      .then(loader)
      .then((module) => {
        const effect = isEffect(module) ? module : (module as { default?: unknown })?.default
        if (!isEffect(effect)) throw new Error('module has no default effect export')
        return effect
      })
      .then(
        (effect) => {
          // A replaced entry keeps loading for nobody.
          if (this.entries.get(name) !== entry) return undefined
          entry.effect = effect
          if (DEV) this.#check(name, entry, effect)
          this.#events.loaded(name, effect)
          return effect
        },
        (cause) => {
          if (this.entries.get(name) !== entry) return undefined
          entry.failed = true
          const message = cause instanceof Error ? cause.message : String(cause)
          this.#events.failed(
            name,
            new EffectError('EFFECT_LOAD', message, { effect: name, cause }),
          )
          return undefined
        },
      )
    return entry.pending
  }

  #check(name: string, entry: RegistryEntry, effect: Effect): void {
    const def = effect['~definition']
    if (def.name && def.name !== name)
      this.#events.warn(`"${name}" loads effect "${def.name}" as an alias`)
    const meta = entryOf(entry.source)
    if (!meta) return
    const params = def.params ?? {}
    const differs =
      Object.entries(meta.params ?? {}).some(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify(params[k]),
      ) ||
      (meta.reducedMotion !== undefined && meta.reducedMotion !== (def.reducedMotion ?? 'static'))
    if (differs) this.#events.warn(`entry metadata of "${name}" differs from its definition`)
  }
}
