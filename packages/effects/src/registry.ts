// The registry of effect sources by name. A source is a definition, a loader, an entry with
// metadata, or a group entry whose package map loads on first need. Each loads at most once.
import { DEV, isEffect, mediaQuery } from './define'
import { EffectError } from './errors'
import type {
  Effect,
  EffectEntries,
  EffectEntry,
  EffectGroup,
  EffectGroupEntry,
  EffectLoader,
  EffectSource,
  ParamSpec,
} from './types'

export interface RegistryEntry {
  /** Replaced once by the map entry of a group entry. */
  source: EffectSource
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
  /** Settles when a module may start evaluating; undefined: at once. */
  ready?(): Promise<unknown> | undefined
}

/** What an entry tells before its module loads. */
type EntryMeta = Omit<EffectEntry, 'load'>

/** Maps of groups, each loaded once whatever asks for it. */
const groupMaps = new WeakMap<EffectGroup, Promise<EffectEntries>>()

/**
 * Entries of a package whose map loads on first need: one entry per name, each sharing the
 * loader, with `extra` fields that must be known before the map, such as `intro`.
 */
export function group(
  load: () => Promise<EffectEntries>,
  names: readonly string[],
  extra: { readonly [name: string]: EntryMeta } = {},
): { readonly [name: string]: EffectGroupEntry } {
  const shared: EffectGroup = { load }
  return Object.fromEntries(names.map((name) => [name, { ...extra[name], group: shared }]))
}

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
    if (entry.effect) return entry.effect['~definition'].params ?? {}
    return metaOf(entry.source)?.params
  }

  /** The entry's `when` beats the definition's, so a site can enable an effect on touch. */
  when(name: string): string | undefined {
    const entry = this.entries.get(name)
    return mediaQuery(
      metaOf(entry?.source as EffectSource)?.when ?? entry?.effect?.['~definition'].when,
    )
  }

  /** The entry's beats the definition's too, like `when`. */
  reducedMotion(name: string): 'static' | 'off' | undefined {
    const entry = this.entries.get(name)
    return (
      metaOf(entry?.source as EffectSource)?.reducedMotion ??
      entry?.effect?.['~definition'].reducedMotion
    )
  }

  presence(name: string): 'fade' | 'custom' | undefined {
    return metaOf(this.entries.get(name)?.source as EffectSource)?.presence
  }

  intro(name: string, element: Element): boolean {
    const intro = metaOf(this.entries.get(name)?.source as EffectSource)?.intro
    return typeof intro === 'function' ? intro(element) : !!intro
  }

  /** The entry waits for its package's map. */
  unresolved(name: string): boolean {
    const entry = this.entries.get(name)
    return !!entry && !entry.failed && !!groupOf(entry.source)
  }

  /** Puts the map's entry, under the group entry's own fields, in place of the group entry. */
  resolve(name: string): Promise<void> {
    const entry = this.entries.get(name)
    const shared = groupOf(entry?.source)
    if (!entry || !shared || entry.failed) return Promise.resolve()
    let map = groupMaps.get(shared)
    if (!map) {
      map = shared.load()
      groupMaps.set(shared, map)
    }
    return map.then(
      (all) => {
        // Replaced meanwhile, by the site or an earlier resolve.
        if (this.entries.get(name) !== entry || groupOf(entry.source) !== shared) return
        const found = Object.hasOwn(all, name) ? all[name] : undefined
        if (!found) {
          this.#fail(name, entry, new Error(`no effect "${name}" in its package`))
          return
        }
        const { group: _, ...own } = entry.source as EffectGroupEntry
        entry.source = isEffect(found)
          ? { load: async () => found, params: found['~definition'].params, ...own }
          : typeof found === 'function'
            ? { load: found as EffectLoader, ...own }
            : { ...(found as EffectEntry), ...own }
      },
      (cause) => {
        if (this.entries.get(name) === entry) this.#fail(name, entry, cause)
      },
    )
  }

  load(name: string): Promise<Effect | undefined> {
    const entry = this.entries.get(name)
    if (!entry || entry.failed) return Promise.resolve(undefined)
    if (groupOf(entry.source)) return this.resolve(name).then(() => this.load(name))
    if (entry.effect) return Promise.resolve(entry.effect)
    const loader = loaderOf(entry.source) as EffectLoader
    entry.pending ??= (this.#events.ready?.() ?? Promise.resolve())
      .then(loader)
      .then(defaultEffect)
      .then(
        (effect) => {
          // A replaced entry keeps loading for nobody.
          if (this.entries.get(name) !== entry) return undefined
          entry.effect = effect
          if (DEV) this.#checkLoaded(name, entry, effect)
          this.#events.loaded(name, effect)
          return effect
        },
        (cause) => {
          if (this.entries.get(name) === entry) this.#fail(name, entry, cause)
          return undefined
        },
      )
    return entry.pending
  }

  #fail(name: string, entry: RegistryEntry, cause: unknown): void {
    entry.failed = true
    const message = cause instanceof Error ? cause.message : String(cause)
    this.#events.failed(name, new EffectError('EFFECT_LOAD', message, { effect: name, cause }))
  }

  /** Dev warnings: an alias, or entry metadata that disagrees with the definition. */
  #checkLoaded(name: string, entry: RegistryEntry, effect: Effect): void {
    const def = effect['~definition']
    if (def.name && def.name !== name) {
      this.#events.warn(`"${name}" loads effect "${def.name}" as an alias`)
    }
    const meta = metaOf(entry.source)
    if (!meta) return
    const params = def.params ?? {}
    const differs = Object.entries(meta.params ?? {}).some(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(params[key]),
    )
    if (differs) this.#events.warn(`entry metadata of "${name}" differs from its definition`)
  }
}

function loaderOf(source: EffectSource): EffectLoader | undefined {
  if (isEffect(source)) return undefined
  if (typeof source === 'function') return source as EffectLoader
  return 'load' in source ? source.load : undefined
}

const metaOf = (source: EffectSource): EntryMeta | undefined =>
  typeof source === 'object' && source !== null && !isEffect(source) ? source : undefined

const groupOf = (source: EffectSource | undefined): EffectGroup | undefined =>
  typeof source === 'object' && source !== null && 'group' in source ? source.group : undefined

/** The effect a loaded module stands for: the module itself or its default export. */
function defaultEffect(module: unknown): Effect {
  const effect = isEffect(module) ? module : (module as { default?: unknown })?.default
  if (!isEffect(effect)) throw new Error('module has no default effect export')
  return effect
}
