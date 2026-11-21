// `defineEffect` and `effect()`: check a definition and freeze it into a callable effect. An
// entry of its own that only effect modules and the runtime import. It imports nothing the light
// entry has: effect modules share it lazily, and a lazy chunk that shared a module with a site's
// main chunk would make the bundler split that chunk in two.
import type { Empty } from '@dioramajs/core'
import type {
  AnyParamValue,
  CheckParams,
  CheckSpec,
  ChoiceParam,
  ColorParam,
  Effect,
  EffectDefinition,
  EffectOptions,
  EffectSetup,
  InputUniforms,
  OptionName,
  ParamDefault,
  ParamSpec,
  ReservedAttr,
  TextParam,
  WidenSpec,
} from './types'

declare const process: { env: Record<string, string | undefined> } | undefined
const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

const EFFECT_NAME = /^[a-z][a-z0-9-]*$/
const PARAM_NAME = /^[a-z][a-zA-Z0-9]*$/
/** Mirrors RESERVED_ATTRS of define.ts, both checked against the type. */
const RESERVED_ATTRS: readonly string[] = Object.keys({
  key: 0,
  state: 0,
  track: 0,
  load: 0,
  preload: 0,
  progress: 0,
  vt: 0,
  transition: 0,
  section: 0,
} satisfies Record<ReservedAttr, 0>)
/** The input uniforms of `ctx.u`. */
export const INPUTS = Object.keys({
  pointer: 0,
  pointerWorld: 0,
  hover: 0,
  velocity: 0,
  progress: 0,
  pin: 0,
  size: 0,
  time: 0,
  hoverTime: 0,
  motion: 0,
  opacity: 0,
  presence: 0,
} satisfies Record<keyof InputUniforms, 0>) as (keyof InputUniforms)[]
const RESERVED: ReadonlySet<string> = new Set([...RESERVED_ATTRS, ...INPUTS])

/** Option names are never params, or `effect({ when: 'hover' }, setup)` would make a param `when`. */
const OPTIONS: ReadonlySet<string> = new Set(
  Object.keys({
    name: 0,
    when: 0,
    animate: 0,
    rebuild: 0,
    media: 0,
    burst: 0,
    reducedMotion: 0,
    on: 0,
    bleed: 0,
    presence: 0,
    quality: 0,
  } satisfies Record<OptionName, unknown>),
)

/**
 * Colour strings three can parse. In `effect()` a string default that matches becomes a colour
 * param. Keep in sync with `IsCssColor` so '#gallery' stays a string in types and at runtime.
 */
export const CSS_COLOR: RegExp = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\(.*)$/i

type HexDigit =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
type IsHex<S extends string, N extends 0[] = []> = S extends `${infer C}${infer R}`
  ? C extends HexDigit
    ? IsHex<R, [...N, 0]>
    : false
  : N['length'] extends 3 | 4 | 6 | 8
    ? true
    : false
/** True for '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' and rgb()/hsl() strings. */
export type IsCssColor<S extends string> = S extends `#${infer H}`
  ? IsHex<H>
  : S extends `${'rgb' | 'rgba' | 'hsl' | 'hsla'}(${string}`
    ? true
    : false
/** The spec as setup sees it, with colour strings turned into colour params. */
export type ColorsIn<P extends ParamSpec> = {
  readonly [K in keyof P]: P[K] extends string
    ? IsCssColor<P[K]> extends true
      ? ColorParam
      : P[K]
    : P[K]
}

/** Like the light part's EffectError, with the same name and code. */
class DefinitionError extends Error {
  override readonly name: 'EffectError' = 'EffectError'
  readonly code: 'EFFECT_DEFINITION' = 'EFFECT_DEFINITION'
  readonly effect: string
  readonly element: undefined

  constructor(message: string, effect: string) {
    super(`EFFECT_DEFINITION: ${message}`)
    this.effect = effect
  }
}

/** Whether `defineEffect` accepts this as a param default. */
export function isParamDefault(value: unknown): value is ParamDefault {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean' || typeof value === 'string') return true
  if (Array.isArray(value)) {
    return value.length >= 2 && value.length <= 4 && value.every((n) => Number.isFinite(n))
  }
  const kind = (value as { '~kind'?: unknown } | null)?.['~kind']
  if (kind === 'color') return typeof (value as { value: unknown }).value === 'string'
  if (kind !== 'choice') return false
  const values = (value as { values: unknown }).values
  return Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string')
}

/** What is wrong with a definition, empty when nothing is. */
export function problems(def: EffectDefinition<ParamSpec>): string[] {
  const found: string[] = []
  const name = def?.name
  if (
    name !== undefined &&
    (typeof name !== 'string' || !EFFECT_NAME.test(name) || RESERVED_ATTRS.includes(name))
  ) {
    found.push(`name "${String(name)}" must be kebab-case and not ${RESERVED_ATTRS.join('/')}`)
  }
  const params = def.params ?? {}
  for (const [key, value] of Object.entries(params)) {
    // A choice has no uniform, so it may share a name with an input (the `motion` key).
    const choice = (value as { '~kind'?: unknown })?.['~kind'] === 'choice'
    if (!PARAM_NAME.test(key)) found.push(`param "${key}" must be lowerCamelCase`)
    else if (RESERVED.has(key) && !(INPUTS.includes(key as never) && choice)) {
      found.push(`param "${key}" is a built-in input or reserved name`)
    } else if (OPTIONS.has(key)) {
      found.push(`param "${key}" is a reserved name of an option: effect({}, { ${key} }, setup)`)
    }
    if (!isParamDefault(value)) found.push(`param "${key}" has an unsupported default`)
  }
  for (const key of def.rebuild ?? []) {
    if (!(key in params)) found.push(`rebuild names unknown param "${key}"`)
  }
  if (typeof def.setup !== 'function') found.push('setup must be a function')
  if (def.when !== undefined && typeof def.when !== 'string') found.push('when must be a string')
  if (def.presence !== undefined && def.presence !== 'fade' && def.presence !== 'custom') {
    found.push(`presence "${String(def.presence)}" must be 'fade' or 'custom'`)
  }
  if (def.on !== undefined && !isSelector(def.on)) {
    found.push(`on "${String(def.on)}" is not a valid selector`)
  }
  return found
}

/**
 * Checks a definition and returns it as a frozen callable. Registers and loads nothing.
 * Throws `EFFECT_DEFINITION` on a bad definition.
 */
/*#__NO_SIDE_EFFECTS__*/
export function defineEffect<const P extends ParamSpec = Empty>(
  definition: EffectDefinition<P> & CheckParams<P>,
): Effect<WidenSpec<P>> {
  const raw = definition as EffectDefinition<ParamSpec>
  // Unwrap `text()` here so the cascade and runtime only ever see plain strings.
  const def = raw?.params
    ? {
        ...raw,
        params: Object.fromEntries(
          Object.entries(raw.params).map(([key, value]) => [
            key,
            isText(value) ? value.value : value,
          ]),
        ),
      }
    : raw
  const found = problems(def)
  if (found.length) {
    throw new DefinitionError(found.join('; '), String(def?.name))
  }
  const defaults = Object.freeze(
    Object.fromEntries(
      Object.entries(def.params ?? {}).map(([key, value]) => [key, defaultOf(value)]),
    ),
  )
  const effect = (params?: object) =>
    Object.freeze({ effect, params: Object.freeze({ ...params }) })
  Object.defineProperties(effect, {
    name: { value: def.name ?? '' },
    defaults: { value: defaults, enumerable: true },
    '~definition': { value: Object.freeze({ ...def }) },
  })
  const result = Object.freeze(effect) as unknown as Effect<WidenSpec<P>>
  if (DEV) {
    // The listeners of `onDefine` (define.ts), on a global key.
    const globals = globalThis as unknown as Record<
      symbol,
      Set<(effect: Effect) => void> | undefined
    >
    for (const listener of globals[Symbol.for('diorama.defined')] ?? []) listener(result as never)
  }
  return result
}

/**
 * String param limited to these values, the first one the default. The same as `oneOf` of the
 * light entry, for effect modules, which must not import it.
 */
/*#__NO_SIDE_EFFECTS__*/
export function oneOf<const T extends string>(...values: [T, ...T[]]): ChoiceParam<T> {
  return Object.freeze({ '~kind': 'choice', values: Object.freeze(values) })
}

/**
 * Short form of `defineEffect`: defaults, optional options, setup. An unnamed effect takes its
 * registry key (the file name when a build plugin finds it).
 *
 *     export default effect({ strength: 1 }, ({ surface, u }) => { ... })
 */
export function effect(setup: EffectSetup<Empty>): Effect<Empty>
export function effect<const P extends ParamSpec>(
  params: P & CheckSpec<P>,
  setup: EffectSetup<ColorsIn<P>>,
): Effect<WidenSpec<P>>
export function effect<const P extends ParamSpec>(
  params: P & CheckSpec<P>,
  options: EffectOptions<ColorsIn<P>>,
  setup: EffectSetup<ColorsIn<P>>,
): Effect<WidenSpec<P>>
/*#__NO_SIDE_EFFECTS__*/
export function effect(first: unknown, second?: unknown, third?: unknown): Effect {
  // (setup), (params, setup) or (params, options, setup).
  const [params, options, setup] =
    typeof first === 'function'
      ? [{}, {}, first]
      : typeof second === 'function'
        ? [first, {}, second]
        : [first, second, third]
  const spec = Object.fromEntries(
    Object.entries(params as object).map(([key, value]) => [
      key,
      typeof value === 'string' && CSS_COLOR.test(value)
        ? Object.freeze({ '~kind': 'color', value })
        : value,
    ]),
  )
  return defineEffect({ ...(options as object), params: spec, setup } as never) as unknown as Effect
}

function isSelector(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  if (typeof document === 'undefined') return true
  try {
    document.createDocumentFragment().querySelector(value)
    return true
  } catch {
    return false
  }
}

/** The value a default stands for, as params.ts `defaultOf` reads it. */
const defaultOf = (spec: ParamDefault): AnyParamValue =>
  typeof spec !== 'object'
    ? spec
    : Array.isArray(spec)
      ? Object.freeze([...spec])
      : '~kind' in spec && spec['~kind'] === 'choice'
        ? spec.values[0]
        : (spec as ColorParam).value

const isText = (value: unknown): value is TextParam =>
  (value as { '~kind'?: unknown } | null)?.['~kind'] === 'string'
