import type {
  AnyPlugin,
  DependencyRef,
  Empty,
  OptionsOf,
  Plugin,
  PluginDefinition,
  PluginEntry,
  Preset,
  PresetDefinition,
  PresetEntry,
  PresetPlugins,
  RequiredOptions,
  ServiceFor,
  StandardSchemaV1,
} from './types'
import { mergeOptions } from './util'

const PLUGIN = Symbol.for('diorama.plugin')
const PRESET = Symbol.for('diorama.preset')

/** A plugin definition with its type parameters erased, as the kernel sees it. */
export interface Definition {
  readonly name: string
  readonly version?: string
  readonly core?: string
  readonly dependencies?: readonly DependencyRef[]
  readonly optionalDependencies?: readonly DependencyRef[]
  readonly defaults?: object
  readonly schema?: StandardSchemaV1
  readonly critical?: boolean
  setup(app: unknown, options: unknown): unknown
}

export const refName = (ref: unknown): string | undefined => {
  if (typeof ref === 'string') return ref
  const name = (ref as { name?: unknown } | null)?.name
  return typeof name === 'string' ? name : undefined
}

export const definitionOf = (value: unknown): Definition | undefined =>
  typeof value === 'function' ? (value as { [PLUGIN]?: Definition })[PLUGIN] : undefined

export const isPreset = (value: unknown): value is Preset =>
  typeof value === 'object' && value !== null && PRESET in value

/** Problems reported as PLUGIN_INVALID at start. `definePlugin` itself never throws. */
export function validateDefinition(def: Definition): string[] {
  const problems: string[] = []
  if (typeof def.name !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(def.name)) {
    problems.push(`name "${String(def.name)}" must be a lowerCamelCase identifier`)
  }
  if (typeof def.setup !== 'function') problems.push('setup must be a function')
  const deps = [def.dependencies ?? [], def.optionalDependencies ?? []]
  if (!deps.every(Array.isArray)) problems.push('dependencies must be arrays')
  else if (deps.flat().some((d) => refName(d) === undefined)) {
    problems.push('dependencies must be names or plugins')
  }
  if (def.core !== undefined && typeof def.core !== 'string')
    problems.push('core must be a semver range')
  if (def.defaults !== undefined && (typeof def.defaults !== 'object' || def.defaults === null)) {
    problems.push('defaults must be an object')
  }
  if (def.schema !== undefined && typeof def.schema?.['~standard']?.validate !== 'function') {
    problems.push('schema must implement Standard Schema')
  }
  return problems
}

function makePlugin(def: Definition, options: Readonly<Record<string, unknown>>): AnyPlugin {
  const plugin = (next?: object): AnyPlugin => makePlugin(def, mergeOptions(options, next))
  const names = (list?: readonly DependencyRef[]) =>
    Object.freeze(Array.isArray(list) ? list.map((d) => refName(d) ?? '') : [])
  Object.defineProperties(plugin, {
    name: { value: def.name },
    version: { value: def.version, enumerable: true },
    options: { value: Object.freeze({ ...options }), enumerable: true },
    defaults: { value: Object.freeze({ ...def.defaults }), enumerable: true },
    schema: { value: def.schema, enumerable: true },
    dependencies: { value: names(def.dependencies), enumerable: true },
    optionalDependencies: { value: names(def.optionalDependencies), enumerable: true },
    [PLUGIN]: { value: def },
  })
  return Object.freeze(plugin) as unknown as AnyPlugin
}

export function definePlugin<
  const N extends string,
  O extends object = Empty,
  DO extends Partial<OptionsOf<O, DO, SO>> = Empty,
  S = void,
  const D extends readonly DependencyRef[] = [],
  const OD extends readonly DependencyRef[] = [],
  SI = unknown,
  SO extends object = Empty,
>(
  definition: PluginDefinition<N, O, DO, S, D, OD, SI, SO>,
): Plugin<
  N,
  OptionsOf<O, DO, SO>,
  ServiceFor<N, S>,
  RequiredOptions<OptionsOf<O, DO, SO>, DO, SI>
> {
  return makePlugin(definition as unknown as Definition, {}) as never
}

export function definePreset<
  const E extends readonly PluginEntry[] = [],
  const PS extends readonly PresetEntry[] = [],
>(
  definition: PresetDefinition<E, PS>,
): Preset<Extract<E[number], AnyPlugin> | PresetPlugins<PS[number]>> {
  return Object.freeze({
    name: definition.name,
    plugins: copy(definition.plugins),
    presets: copy(definition.presets),
    [PRESET]: true,
  }) as never
}

// Non-arrays pass through untouched so createApp reports them instead of definePreset throwing.
const copy = <T>(list: readonly T[] | undefined): readonly T[] =>
  Array.isArray(list) ? Object.freeze([...list]) : (list ?? [])
