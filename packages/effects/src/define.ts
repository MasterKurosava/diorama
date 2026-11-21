// Definition helpers of the light entry: the dev flag, effect name rules, the param builders
// `color`, `text` and `oneOf`, and the channels that swap definitions in live apps on hot reload.
import type { ChoiceParam, ColorParam, Effect, ReservedAttr, TextParam, When } from './types'

declare const process: { env: Record<string, string | undefined> } | undefined

type DefineListener = (effect: Effect) => void
type RedefineListener = (key: string, effect: Effect) => void

/** `import.meta.env.DEV` under Vite, otherwise `NODE_ENV`. */
export const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

const EFFECT_NAME = /^[a-z][a-z0-9-]*$/

/**
 * Framework `data-dio-*` names, which no effect may take. Checked against the `ReservedAttr`
 * type; effect.ts and @dioramajs/glsl keep their own copies.
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
  section: 0,
} satisfies Record<ReservedAttr, 0>)

/** Global key of the definition listeners. effect.ts reads it without importing this file. */
const DEFINED = Symbol.for('diorama.defined')

/** Listeners of `redefine`, which swaps unnamed effects by registry key. */
const redefineListeners = new Set<RedefineListener>()

/** The media query of a `when` value: 'hover' stands for `(hover: hover)`. */
export const mediaQuery = (when: When | undefined): string | undefined =>
  when === 'hover' ? '(hover: hover)' : when

export const isEffectName = (name: string): boolean =>
  EFFECT_NAME.test(name) && !RESERVED_ATTRS.includes(name)

export const isEffect = (value: unknown): value is Effect =>
  typeof value === 'function' && '~definition' in value

/** Dev hot reload: the listener hears every definition evaluated again, in any live app. */
export const onDefine = (listener: DefineListener): (() => void) => {
  const globals = globalThis as unknown as Record<symbol, Set<DefineListener> | undefined>
  const listeners = globals[DEFINED] ?? new Set()
  globals[DEFINED] = listeners
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Dev hot reload by registry key, for unnamed effects. A build plugin calls `redefine`. */
export const onRedefine = (listener: RedefineListener): (() => void) => {
  redefineListeners.add(listener)
  return () => redefineListeners.delete(listener)
}

/** Swaps the definition registered under `key` in live apps. */
export function redefine(key: string, effect: Effect): void {
  if (DEV) for (const listener of redefineListeners) listener(key, effect)
}

/**
 * Colour param. A CSS colour string on the CPU, as written; a `color` uniform on the GPU. The
 * uniform reads `var(--name)` and `currentColor` from the element when the value is written and
 * again in every frame the element draws, so a theme switch shows with the next frame. Code that
 * reads the string itself resolves it with `cssColor(value, element)` of `@dioramajs/render`.
 */
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
