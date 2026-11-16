import { VERSION } from '../version'
import { DioramaError, messageOf } from './errors'
import { findCycle, kahn } from './order'
import { type Definition, definitionOf, isPreset, refName, validateDefinition } from './plugin'
import type { Owner } from './scope'
import { satisfies } from './semver'
import type { AnyPlugin, AppOptions, DependencyRef, PluginStatus } from './types'
import { mergeOptions } from './util'

/** Names a plugin may not take beyond the App API's own members. */
export const RESERVED = ['then', 'toJSON', 'spawn', 'query', 'tick'] as const

export interface PluginRecord {
  readonly name: string
  readonly def: Definition
  readonly deps: readonly string[]
  readonly optional: readonly string[]
  readonly critical: boolean
  /** Options before the schema ran. `use` compares these to detect a re-install. */
  readonly raw: Record<string, unknown>
  options: Readonly<Record<string, unknown>>
  status: PluginStatus
  ordinal: number
  service: unknown
  hasService: boolean
  scope: Owner | undefined
  error: DioramaError | undefined
  /** Undoes the link to the owner that installed it at runtime. */
  release: (() => void) | undefined
}

export interface Entry {
  readonly plugin: AnyPlugin
  readonly def: Definition
  readonly layer: number
  readonly index: number
}

export interface Resolved {
  readonly list: PluginRecord[]
  readonly failures: Map<PluginRecord, DioramaError>
}

export interface Config {
  readonly options: AppOptions
  readonly defaults: readonly AnyPlugin[]
  readonly disabled: ReadonlySet<string>
  readonly reserved: (name: string) => boolean
}

/** Flattens layers (defaults < presets < plugins) and applies `disable`. */
export function collectEntries(config: Config, problems: DioramaError[]): Entry[] {
  const entries: Entry[] = []
  const push = (value: unknown, layer: number): void => {
    if (!value) return
    const def = definitionOf(value)
    if (def) entries.push({ plugin: value as AnyPlugin, def, layer, index: entries.length })
    else problems.push(new DioramaError('PLUGIN_INVALID', `not a plugin: ${String(value)}`))
  }
  const walk = (value: unknown, seen: Set<unknown>): void => {
    if (!value || seen.has(value)) return
    if (!isPreset(value)) {
      problems.push(new DioramaError('PLUGIN_INVALID', `not a preset: ${String(value)}`))
      return
    }
    seen.add(value)
    if (!Array.isArray(value.presets) || !Array.isArray(value.plugins)) {
      problems.push(new DioramaError('PLUGIN_INVALID', `preset "${value.name}" needs arrays`))
      return
    }
    for (const nested of value.presets) walk(nested, seen)
    for (const plugin of value.plugins) push(plugin, 1)
  }
  const list = (key: 'presets' | 'plugins'): readonly unknown[] => {
    const value = config.options[key]
    if (value === undefined || Array.isArray(value)) return value ?? []
    problems.push(new DioramaError('CONFIG_INVALID', `${key} must be an array`))
    return []
  }
  if (config.options.defaults !== false) for (const p of config.defaults) push(p, 0)
  for (const preset of list('presets')) walk(preset, new Set())
  for (const plugin of list('plugins')) push(plugin, 2)
  return entries.filter((e) => e.layer === 2 || !config.disabled.has(String(e.def.name)))
}

/** Why a missing plugin is missing, as a suffix for messages. */
export function missingHint(config: Config, name: string): string {
  if (config.disabled.has(name)) return ' (removed via disable)'
  if (config.options.defaults === false && config.defaults.some((p) => p.name === name)) {
    return ' (defaults are off)'
  }
  return ''
}

/** Resolves names (the strongest layer wins) and validates. Returns per-plugin failures. */
export async function resolveEntries(
  config: Config,
  entries: readonly Entry[],
  available?: (name: string) => boolean,
): Promise<Resolved> {
  const groups = new Map<string, Entry[]>()
  for (const e of entries) {
    const key = String(e.def.name)
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  const list: PluginRecord[] = []
  const failures = new Map<PluginRecord, DioramaError>()
  for (const [name, group] of groups) {
    const top = Math.max(...group.map((e) => e.layer))
    const winner = group.find((e) => e.layer === top) as Entry
    // Entries sharing the winner's definition merge their options by layer, then position.
    let raw: Record<string, unknown> = { ...winner.def.defaults }
    for (const e of group
      .filter((x) => x.def === winner.def)
      .sort((a, b) => a.layer - b.layer || a.index - b.index)) {
      raw = mergeOptions(raw, e.plugin.options)
    }
    const rec = record(winner.def, raw)
    list.push(rec)
    if (group.some((e) => e.layer === top && e.def !== winner.def)) {
      failures.set(
        rec,
        new DioramaError('PLUGIN_DUPLICATE', `two different plugins named "${name}"`, {
          plugin: name,
        }),
      )
    }
  }
  for (const rec of list) {
    const problem = failures.get(rec) ?? (await validate(rec, config.reserved))
    if (problem) failures.set(rec, problem)
  }
  const present = new Set(list.map((r) => r.name))
  for (const rec of list) {
    const missing = rec.deps.find((d) => !present.has(d) && !available?.(d))
    if (missing !== undefined && !failures.has(rec)) {
      failures.set(
        rec,
        new DioramaError(
          'PLUGIN_MISSING_DEPENDENCY',
          `requires "${missing}"${missingHint(config, missing)}`,
          { plugin: rec.name },
        ),
      )
    }
  }
  return { list, failures }
}

/** Validates the definition, core range and options, then freezes the final options. */
async function validate(
  rec: PluginRecord,
  reserved: (name: string) => boolean,
): Promise<DioramaError | undefined> {
  const plugin = rec.name
  const problems = validateDefinition(rec.def)
  if (!problems.length && reserved(rec.name)) {
    problems.push(`name "${rec.name}" is reserved by the App API`)
  }
  if (problems.length) return new DioramaError('PLUGIN_INVALID', problems.join('; '), { plugin })
  const { core, schema } = rec.def
  if (core !== undefined && !satisfies(VERSION, core)) {
    return new DioramaError('PLUGIN_INCOMPATIBLE', `requires core ${core}, running ${VERSION}`, {
      plugin,
    })
  }
  let value: unknown = rec.raw
  if (schema) {
    try {
      const result = await schema['~standard'].validate(rec.raw)
      if (result.issues) {
        const text = result.issues.map((i) => {
          const path = i.path?.map((p) => String(typeof p === 'object' ? p.key : p)).join('.')
          return path ? `${path}: ${i.message}` : i.message
        })
        return new DioramaError('PLUGIN_OPTIONS', text.join('; '), { plugin })
      }
      value = result.value
    } catch (e) {
      return new DioramaError('PLUGIN_OPTIONS', messageOf(e), { plugin, cause: e })
    }
  }
  rec.options = Object.freeze({ ...(value as object) })
  return undefined
}

function record(def: Definition, raw: Record<string, unknown>): PluginRecord {
  const names = (list?: readonly DependencyRef[]): string[] =>
    (list ?? []).map((d) => refName(d) ?? '')
  return {
    name: String(def.name),
    def,
    deps: names(def.dependencies),
    optional: names(def.optionalDependencies),
    critical: def.critical === true,
    raw,
    options: raw,
    status: 'pending',
    ordinal: -1,
    service: undefined,
    hasService: false,
    scope: undefined,
    error: undefined,
    release: undefined,
  }
}

interface OptionalEdge {
  readonly from: number
  readonly to: number
  /** Index in the dependent's `optionalDependencies`. */
  readonly k: number
}

const less = (a: number, b: number): boolean => a < b

/**
 * Start order by list position, or a cycle of required dependencies. Optional edges inside a
 * stuck set are dropped one at a time, starting with the dependent placed latest.
 */
export function orderPlugins(
  list: readonly PluginRecord[],
): PluginRecord[] | { cycle: PluginRecord[] } {
  const at = (i: number): PluginRecord => list[i] as PluginRecord
  const index = new Map(list.map((r, i) => [r.name, i]))
  const required: number[][] = list.map(() => [])
  const optional: OptionalEdge[] = []
  list.forEach((rec, to) => {
    for (const d of rec.deps) {
      const from = index.get(d)
      if (from !== undefined) required[from]?.push(to)
    }
    rec.optional.forEach((d, k) => {
      const from = index.get(d)
      if (from !== undefined) optional.push({ from, to, k })
    })
  })
  const strict = kahn(list.length, required, less)
  if (!Array.isArray(strict)) return { cycle: findCycle(required, strict.stuck).map(at) }
  for (;;) {
    const edges = required.map((targets) => [...targets])
    for (const e of optional) edges[e.from]?.push(e.to)
    const result = kahn(list.length, edges, less)
    if (Array.isArray(result)) return result.map(at)
    const drop = edgeToDrop(optional, edges, new Set(result.stuck))
    // Not reached: required edges alone sort, so every stuck set closes through an optional one.
    if (!drop) return { cycle: result.stuck.map(at) }
    optional.splice(optional.indexOf(drop), 1)
  }
}

export const cycleError = (cycle: readonly PluginRecord[]): DioramaError =>
  new DioramaError(
    'PLUGIN_CYCLE',
    `required dependencies form a cycle: ${cycle.map((r) => r.name).join(' → ')}`,
  )

/** The optional edge on a cycle whose dependent is placed latest (then its latest entry). */
function edgeToDrop(
  optional: readonly OptionalEdge[],
  edges: readonly (readonly number[])[],
  stuck: ReadonlySet<number>,
): OptionalEdge | undefined {
  // An edge lies on a cycle only if its target can reach its source again.
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>()
    const walk = (n: number): boolean => {
      if (n === to) return true
      if (seen.has(n)) return false
      seen.add(n)
      return (edges[n] ?? []).some((m) => stuck.has(m) && walk(m))
    }
    return walk(from)
  }
  let drop: OptionalEdge | undefined
  for (const e of optional) {
    if (!stuck.has(e.from) || !stuck.has(e.to)) continue
    if (drop && (e.to < drop.to || (e.to === drop.to && e.k <= drop.k))) continue
    if (reaches(e.to, e.from)) drop = e
  }
  return drop
}
