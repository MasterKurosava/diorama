// Param values: key and attribute name forms, the value a default stands for, conversion of
// attribute strings and written values to a param's type, and live accessors for `params`.
import type { AnyParamValue, ParamDefault, ParamSpec } from './types'

/** A default made by `color()`, `text()` or `oneOf()`. */
type TaggedDefault = Exclude<ParamDefault, readonly number[] | number | boolean | string>

/** Where the accessors of a live params object read and write. */
export interface ParamTarget {
  read(key: string): AnyParamValue | undefined
  write(key: string, value: unknown): void
  /** Keys that get accessors now. */
  keys(): Iterable<string>
}

const AXES = ['x', 'y', 'z', 'w'] as const

export const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

export const camel = (name: string): string =>
  name.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase())

/** The value a default stands for: a colour's string, a choice's first value. */
export function defaultOf(spec: ParamDefault): AnyParamValue {
  if (typeof spec !== 'object') return spec
  if (Array.isArray(spec)) return Object.freeze([...spec])
  const tagged = spec as TaggedDefault
  return tagged['~kind'] === 'choice' ? tagged.values[0] : tagged.value
}

/** Strings and choices have no uniform, so changing them always re-runs setup. */
export const rebuilds = (spec: ParamDefault): boolean =>
  typeof spec === 'string' ||
  /^(choice|string)$/.test((spec as { '~kind'?: string })['~kind'] ?? '')

/**
 * Converts an attribute string or a written value to the type of `spec`. Numbers accept `px`,
 * booleans `on`/`off`/`1`/`0`, tuples take numbers split by spaces or commas. Returns undefined
 * to reject.
 */
export function coerce(spec: ParamDefault, value: unknown): AnyParamValue | undefined {
  if (typeof spec === 'number') return toNumber(value)
  if (typeof spec === 'boolean') return toBoolean(value)
  if (Array.isArray(spec)) return toTuple(value, spec.length)
  // 'auto' or a number, from markup or code.
  if (spec === 'auto') return value === 'auto' ? value : toNumber(value)
  if (typeof value !== 'string') return undefined
  if (typeof spec === 'string') return value
  const tagged = spec as TaggedDefault
  if (tagged['~kind'] === 'color') return isColor(value) ? value.trim() : undefined
  if (tagged['~kind'] === 'string') return value
  return (tagged.values as readonly string[]).includes(value) ? value : undefined
}

/** For writes before the type is known. Rejects only values that are never valid. */
export const plausible = (value: unknown): boolean =>
  !(typeof value === 'number' && !Number.isFinite(value)) &&
  value !== 'undefined' &&
  value !== 'NaN' &&
  value !== undefined

/**
 * Adds accessors for the keys the target knows now. A plain property assigned earlier (a tween
 * of a key not known yet) becomes an accessor and its value is written through.
 */
export function defineKeys(params: object, target: ParamTarget): void {
  const vectors = new Map<string, object>()
  for (const key of target.keys()) {
    const own = Object.getOwnPropertyDescriptor(params, key)
    if (own?.get) continue
    Object.defineProperty(params, key, {
      enumerable: true,
      configurable: true,
      get() {
        const value = target.read(key)
        if (!Array.isArray(value)) return value
        let vector = vectors.get(key)
        if ((vector as { length?: number } | undefined)?.length !== value.length) {
          vector = liveVector(target, key, value.length)
          vectors.set(key, vector)
        }
        return vector
      },
      set(value: unknown) {
        target.write(key, value)
      },
    })
    if (own && 'value' in own) target.write(key, own.value)
  }
}

export const specKeys = (...specs: (ParamSpec | object | undefined)[]): Set<string> =>
  new Set(specs.flatMap((spec) => (spec ? Object.keys(spec) : [])))

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/px$/, '')
  const number = text ? Number(text) : Number.NaN
  return Number.isFinite(number) ? number : undefined
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (text === '' || text === 'true' || text === '1' || text === 'on') return true
  return text === 'false' || text === '0' || text === 'off' ? false : undefined
}

function toTuple(value: unknown, size: number): readonly number[] | undefined {
  let parts: unknown[] = []
  if (typeof value === 'string') {
    parts = value
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
  } else if (typeof value === 'object' && value !== null && Symbol.iterator in value) {
    parts = [...(value as Iterable<unknown>)]
  }
  if (parts.length !== size || !parts.every((part) => Number.isFinite(part))) return undefined
  return Object.freeze(parts as number[])
}

const isColor = (value: string): boolean =>
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('color', value)
    : value.trim() !== ''

/** A live tuple: each component reads and writes the whole tuple through the target. */
function liveVector(target: ParamTarget, key: string, size: number): object {
  const current = (): readonly number[] => {
    const value = target.read(key)
    return Array.isArray(value) ? value : []
  }
  const vector: Record<PropertyKey, unknown> = {
    length: size,
    *[Symbol.iterator]() {
      yield* current()
    },
  }
  for (let index = 0; index < size; index++) {
    const access = {
      enumerable: true,
      get: () => current()[index],
      set: (component: number) => {
        const next = [...current()]
        next[index] = component
        target.write(key, next)
      },
    }
    Object.defineProperty(vector, index, access)
    Object.defineProperty(vector, AXES[index] as string, access)
  }
  return vector
}
