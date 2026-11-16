import type { Empty } from '@diorama/core'
import { EffectError } from './errors'
import { defaultOf, isParamDefault } from './params'
import type {
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
  ParamSpec,
  ReservedAttr,
  TextParam,
  When,
  WidenSpec,
} from './types'

declare const process: { env: Record<string, string | undefined> } | undefined

/** `import.meta.env.DEV` under Vite, otherwise `NODE_ENV`. */
export const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

const NAME = /^[a-z][a-z0-9-]*$/
const PARAM = /^[a-z][a-zA-Z0-9]*$/
/**
 * Framework `data-dio-*` names and the input uniforms of `ctx.u`. Both lists are checked
 * against the types, and @diorama/glsl mirrors them.
 */
export const RESERVED_ATTRS: readonly string[] = Object.keys({
  key: 0,
  state: 0,
  track: 0,
  load: 0,
  preload: 0,
  progress: 0,
  vt: 0,
  transition: 0,
} satisfies Record<ReservedAttr, 0>)
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
    reducedMotion: 0,
    on: 0,
    bleed: 0,
    presence: 0,
  } satisfies Record<OptionName, unknown>),
)
export const query = (when: When | undefined): string | undefined =>
  when === 'hover' ? '(hover: hover)' : when
export const isEffectName = (name: string): boolean =>
  NAME.test(name) && !RESERVED_ATTRS.includes(name)

/** Dev HMR: every live app hears re-evaluated definitions. */
const channel = new Set<(effect: Effect) => void>()
export const onDefine = (listener: (effect: Effect) => void): (() => void) => {
  channel.add(listener)
  return () => channel.delete(listener)
}

/** Dev HMR by registry key, for unnamed effects. A build plugin calls `redefine`. */
const keyed = new Set<(key: string, effect: Effect) => void>()
export const onRedefine = (listener: (key: string, effect: Effect) => void): (() => void) => {
  keyed.add(listener)
  return () => keyed.delete(listener)
}
/** Swaps the definition registered under `key` in live apps. */
export function redefine(key: string, effect: Effect): void {
  if (DEV) for (const listener of keyed) listener(key, effect)
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

export const isEffect = (value: unknown): value is Effect =>
  typeof value === 'function' && '~definition' in value

/** Colour param. A CSS colour string on the CPU, a `color` uniform on the GPU. */
/*#__NO_SIDE_EFFECTS__*/
export function color(value: string): ColorParam {
  return Object.freeze({ '~kind': 'color', value })
}

/** Plain string param for a default that looks like a colour, e.g. `text('#cafe')`. */
/*#__NO_SIDE_EFFECTS__*/
export function text(value: string): TextParam {
  return Object.freeze({ '~kind': 'string', value })
}

/** String param limited to these values. The first one is the default. */
/*#__NO_SIDE_EFFECTS__*/
export function oneOf<const T extends string>(...values: [T, ...T[]]): ChoiceParam<T> {
  return Object.freeze({ '~kind': 'choice', values: Object.freeze(values) })
}

function problems(def: EffectDefinition<ParamSpec>): string[] {
  const out: string[] = []
  if (def?.name !== undefined && (typeof def.name !== 'string' || !isEffectName(def.name))) {
    out.push(`name "${String(def?.name)}" must be kebab-case and not ${RESERVED_ATTRS.join('/')}`)
  }
  const params = def.params ?? {}
  for (const [key, value] of Object.entries(params)) {
    if (!PARAM.test(key)) out.push(`param "${key}" must be lowerCamelCase`)
    else if (RESERVED.has(key)) out.push(`param "${key}" is a built-in input or reserved name`)
    else if (OPTIONS.has(key))
      out.push(`param "${key}" is a reserved name of an option: effect({}, { ${key} }, setup)`)
    if (!isParamDefault(value)) out.push(`param "${key}" has an unsupported default`)
  }
  for (const key of def.rebuild ?? []) {
    if (!(key in params)) out.push(`rebuild names unknown param "${key}"`)
  }
  if (typeof def.setup !== 'function') out.push('setup must be a function')
  if (def.when !== undefined && typeof def.when !== 'string') out.push('when must be a string')
  if (def.presence !== undefined && def.presence !== 'fade' && def.presence !== 'custom') {
    out.push(`presence "${String(def.presence)}" must be 'fade' or 'custom'`)
  }
  if (def.on !== undefined && !isSelector(def.on)) {
    out.push(`on "${String(def.on)}" is not a valid selector`)
  }
  return out
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
          Object.entries(raw.params).map(([k, v]) => [k, isText(v) ? v.value : v]),
        ),
      }
    : raw
  const found = problems(def)
  if (found.length) {
    throw new EffectError('EFFECT_DEFINITION', found.join('; '), { effect: String(def?.name) })
  }
  const defaults = Object.freeze(
    Object.fromEntries(Object.entries(def.params ?? {}).map(([k, v]) => [k, defaultOf(v)])),
  )
  const effect = (params?: object) =>
    Object.freeze({ effect, params: Object.freeze({ ...params }) })
  Object.defineProperties(effect, {
    name: { value: def.name ?? '' },
    defaults: { value: defaults, enumerable: true },
    '~definition': { value: Object.freeze({ ...def }) },
  })
  const result = Object.freeze(effect) as unknown as Effect<WidenSpec<P>>
  if (DEV) for (const listener of channel) listener(result as unknown as Effect)
  return result
}

const isText = (value: unknown): value is TextParam =>
  (value as { '~kind'?: unknown } | null)?.['~kind'] === 'string'

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
export function effect(a: unknown, b?: unknown, c?: unknown): Effect {
  const [params, options, setup] =
    typeof a === 'function' ? [{}, {}, a] : typeof b === 'function' ? [a, {}, b] : [a, b, c]
  const spec = Object.fromEntries(
    Object.entries(params as object).map(([k, v]) => [
      k,
      typeof v === 'string' && CSS_COLOR.test(v) ? color(v) : v,
    ]),
  )
  return defineEffect({ ...(options as object), params: spec, setup } as never) as unknown as Effect
}
