import { VERSION } from '../version'
import { DioramaError, messageOf } from './errors'
import { findCycle, topologicalSort } from './order'
import { type Definition, definitionOf, isPreset, refName, validateDefinition } from './plugin'
import type { Owner } from './scope'
import { satisfies } from './semver'
import type {
  AnyPlugin,
  AppOptions,
  DependencyRef,
  PluginStatus,
  StandardSchemaIssue,
} from './types'
import { mergeOptions } from './util'

/** Names a plugin may not take beyond the App API's own members. */
export const RESERVED = ['then', 'toJSON', 'spawn', 'query', 'tick'] as const

// Layers of plugin entries. Of two entries with one name, the higher layer wins.
const LAYER_DEFAULTS = 0
const LAYER_PRESETS = 1
const LAYER_PLUGINS = 2
/** Plugins installed with `use()` after start. */
export const LAYER_RUNTIME = 3

/** Everything the kernel knows about one installed plugin. */
export interface PluginRecord {
  readonly name: string
  readonly def: Definition
  /** Names of the required dependencies. */
  readonly deps: readonly string[]
  /** Names of the optional dependencies. */
  readonly optional: readonly string[]
  readonly critical: boolean
  /** Options before the schema ran. `use` compares these to detect a re-install. */
  readonly raw: Record<string, unknown>
  options: Readonly<Record<string, unknown>>
  status: PluginStatus
  /** Start order. Systems and hooks of earlier plugins run first. */
  ordinal: number
  service: unknown
  hasService: boolean
  scope: Owner | undefined
  error: DioramaError | undefined
  /** Undoes the link to the owner that installed it at runtime. */
  release: (() => void) | undefined
}

/** A plugin as listed in the options, before names are resolved. */
export interface Entry {
  readonly plugin: AnyPlugin
  readonly def: Definition
  readonly layer: number
  /** Position in the flattened list, for a stable merge order. */
  readonly index: number
}

export interface Resolved {
  /** One record per plugin name. */
  readonly list: PluginRecord[]
  readonly failures: Map<PluginRecord, DioramaError>
}

export interface Config {
  readonly options: AppOptions
  /** The built-in plugins, before `defaults: false` and `disable` apply. */
  readonly defaults: readonly AnyPlugin[]
  readonly disabled: ReadonlySet<string>
  readonly reserved: (name: string) => boolean
}

/** An optional dependency: `to` depends on `from`. Dropped first to break a cycle. */
interface OptionalEdge {
  readonly from: number
  readonly to: number
  /** Index in the dependent's `optionalDependencies`. */
  readonly position: number
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
  const walkPreset = (value: unknown, seen: Set<unknown>): void => {
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
    for (const nested of value.presets) walkPreset(nested, seen)
    for (const plugin of value.plugins) push(plugin, LAYER_PRESETS)
  }
  const listOption = (key: 'presets' | 'plugins'): readonly unknown[] => {
    const value = config.options[key]
    if (value === undefined || Array.isArray(value)) return value ?? []
    problems.push(new DioramaError('CONFIG_INVALID', `${key} must be an array`))
    return []
  }
  if (config.options.defaults !== false) {
    for (const plugin of config.defaults) push(plugin, LAYER_DEFAULTS)
  }
  for (const preset of listOption('presets')) walkPreset(preset, new Set())
  for (const plugin of listOption('plugins')) push(plugin, LAYER_PLUGINS)
  // `disable` drops built-ins and preset plugins, never a plugin listed in `plugins`.
  return entries.filter(
    (entry) => entry.layer === LAYER_PLUGINS || !config.disabled.has(String(entry.def.name)),
  )
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
  for (const entry of entries) {
    const name = String(entry.def.name)
    groups.set(name, [...(groups.get(name) ?? []), entry])
  }
  const list: PluginRecord[] = []
  const failures = new Map<PluginRecord, DioramaError>()
  for (const [name, group] of groups) {
    const topLayer = Math.max(...group.map((entry) => entry.layer))
    const winner = group.find((entry) => entry.layer === topLayer) as Entry
    const record = createRecord(winner.def, mergeGroupOptions(group, winner))
    list.push(record)
    if (group.some((entry) => entry.layer === topLayer && entry.def !== winner.def)) {
      failures.set(
        record,
        new DioramaError('PLUGIN_DUPLICATE', `two different plugins named "${name}"`, {
          plugin: name,
        }),
      )
    }
  }
  for (const record of list) {
    const problem = failures.get(record) ?? (await validate(record, config.reserved))
    if (problem) failures.set(record, problem)
  }
  const present = new Set(list.map((record) => record.name))
  for (const record of list) {
    const missing = record.deps.find((name) => !present.has(name) && !available?.(name))
    if (missing === undefined || failures.has(record)) continue
    failures.set(
      record,
      new DioramaError(
        'PLUGIN_MISSING_DEPENDENCY',
        `requires "${missing}"${missingHint(config, missing)}`,
        { plugin: record.name },
      ),
    )
  }
  return { list, failures }
}

/**
 * Start order by list position, or a cycle of required dependencies. Optional edges inside a
 * stuck set are dropped one at a time, starting with the dependent placed latest.
 */
export function orderPlugins(
  list: readonly PluginRecord[],
): PluginRecord[] | { cycle: PluginRecord[] } {
  const recordAt = (i: number): PluginRecord => list[i] as PluginRecord
  const indexByName = new Map(list.map((record, i) => [record.name, i]))
  const required: number[][] = list.map(() => [])
  const optional: OptionalEdge[] = []
  list.forEach((record, to) => {
    for (const name of record.deps) {
      const from = indexByName.get(name)
      if (from !== undefined) required[from]?.push(to)
    }
    record.optional.forEach((name, position) => {
      const from = indexByName.get(name)
      if (from !== undefined) optional.push({ from, to, position })
    })
  })
  const requiredOnly = topologicalSort(list.length, required, byIndex)
  if (!Array.isArray(requiredOnly)) {
    return { cycle: findCycle(required, requiredOnly.stuck).map(recordAt) }
  }
  for (;;) {
    const edges = required.map((targets) => [...targets])
    for (const edge of optional) edges[edge.from]?.push(edge.to)
    const result = topologicalSort(list.length, edges, byIndex)
    if (Array.isArray(result)) return result.map(recordAt)
    const drop = edgeToDrop(optional, edges, new Set(result.stuck))
    // Not reached: required edges alone sort, so every stuck set closes through an optional one.
    if (!drop) return { cycle: result.stuck.map(recordAt) }
    optional.splice(optional.indexOf(drop), 1)
  }
}

export const cycleError = (cycle: readonly PluginRecord[]): DioramaError =>
  new DioramaError(
    'PLUGIN_CYCLE',
    `required dependencies form a cycle: ${cycle.map((record) => record.name).join(' → ')}`,
  )

/** Entries sharing the winner's definition merge their options by layer, then position. */
function mergeGroupOptions(group: readonly Entry[], winner: Entry): Record<string, unknown> {
  const same = group
    .filter((entry) => entry.def === winner.def)
    .sort((a, b) => a.layer - b.layer || a.index - b.index)
  let options: Record<string, unknown> = { ...winner.def.defaults }
  for (const entry of same) options = mergeOptions(options, entry.plugin.options)
  return options
}

/** Validates the definition, core range and options, then freezes the final options. */
async function validate(
  record: PluginRecord,
  reserved: (name: string) => boolean,
): Promise<DioramaError | undefined> {
  const plugin = record.name
  const problems = validateDefinition(record.def)
  if (!problems.length && reserved(record.name)) {
    problems.push(`name "${record.name}" is reserved by the App API`)
  }
  if (problems.length) return new DioramaError('PLUGIN_INVALID', problems.join('; '), { plugin })
  const { core, schema } = record.def
  if (core !== undefined && !satisfies(VERSION, core)) {
    return new DioramaError('PLUGIN_INCOMPATIBLE', `requires core ${core}, running ${VERSION}`, {
      plugin,
    })
  }
  let value: unknown = record.raw
  if (schema) {
    try {
      const result = await schema['~standard'].validate(record.raw)
      if (result.issues) {
        return new DioramaError('PLUGIN_OPTIONS', describeIssues(result.issues), { plugin })
      }
      value = result.value
    } catch (error) {
      return new DioramaError('PLUGIN_OPTIONS', messageOf(error), { plugin, cause: error })
    }
  }
  record.options = Object.freeze({ ...(value as object) })
  return undefined
}

/** Schema issues as `path: message` parts joined by `; `. */
function describeIssues(issues: readonly StandardSchemaIssue[]): string {
  const parts = issues.map((issue) => {
    const path = issue.path
      ?.map((segment) => String(typeof segment === 'object' ? segment.key : segment))
      .join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  return parts.join('; ')
}

function createRecord(def: Definition, raw: Record<string, unknown>): PluginRecord {
  // A non-array list is left to `validate`, which reports it as PLUGIN_INVALID.
  const names = (list?: readonly DependencyRef[]): string[] =>
    Array.isArray(list) ? list.map((ref) => refName(ref) ?? '') : []
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

/** Ties between ready plugins go to the one listed first. */
const byIndex = (a: number, b: number): boolean => a < b

/** The optional edge on a cycle whose dependent is placed latest (then its latest entry). */
function edgeToDrop(
  optional: readonly OptionalEdge[],
  edges: readonly (readonly number[])[],
  stuck: ReadonlySet<number>,
): OptionalEdge | undefined {
  // An edge lies on a cycle only if its target can reach its source again.
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>()
    const walk = (node: number): boolean => {
      if (node === to) return true
      if (seen.has(node)) return false
      seen.add(node)
      return (edges[node] ?? []).some((next) => stuck.has(next) && walk(next))
    }
    return walk(from)
  }
  let drop: OptionalEdge | undefined
  for (const edge of optional) {
    if (!stuck.has(edge.from) || !stuck.has(edge.to)) continue
    const notLater =
      drop && (edge.to < drop.to || (edge.to === drop.to && edge.position <= drop.position))
    if (notLater) continue
    if (reaches(edge.to, edge.from)) drop = edge
  }
  return drop
}
