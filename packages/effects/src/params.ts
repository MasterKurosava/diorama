import type { AnyParamValue, ParamDefault, ParamSpec } from './types'

export const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
export const camel = (name: string): string =>
  name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

const isColor = (value: string): boolean =>
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('color', value)
    : value.trim() !== ''

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

/** The value a default stands for: a colour's string, a choice's first value. */
export function defaultOf(spec: ParamDefault): AnyParamValue {
  if (typeof spec !== 'object') return spec
  if (Array.isArray(spec)) return Object.freeze([...spec])
  const d = spec as Exclude<ParamDefault, readonly number[] | number | boolean | string>
  return d['~kind'] === 'choice' ? d.values[0] : d.value
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
  if (typeof spec === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'string') return undefined
    const text = value.trim().replace(/px$/, '')
    const n = text ? Number(text) : Number.NaN
    return Number.isFinite(n) ? n : undefined
  }
  if (typeof spec === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value !== 'string') return undefined
    const text = value.trim().toLowerCase()
    if (text === '' || text === 'true' || text === '1' || text === 'on') return true
    return text === 'false' || text === '0' || text === 'off' ? false : undefined
  }
  if (Array.isArray(spec)) {
    const parts: unknown[] =
      typeof value === 'string'
        ? value
            .trim()
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number)
        : typeof value === 'object' && value !== null && Symbol.iterator in value
          ? [...(value as Iterable<unknown>)]
          : []
    return parts.length === spec.length && parts.every((n) => Number.isFinite(n))
      ? Object.freeze(parts as number[])
      : undefined
  }
  if (typeof value !== 'string') return undefined
  if (typeof spec === 'string') return value
  const d = spec as Exclude<ParamDefault, readonly number[] | number | boolean | string>
  if (d['~kind'] === 'color') return isColor(value) ? value.trim() : undefined
  if (d['~kind'] === 'string') return value
  return (d.values as readonly string[]).includes(value) ? value : undefined
}

/** For writes before the type is known. Rejects only values that are never valid. */
export const plausible = (value: unknown): boolean =>
  !(typeof value === 'number' && !Number.isFinite(value)) &&
  value !== 'undefined' &&
  value !== 'NaN' &&
  value !== undefined

/** Where the accessors of a live params object read and write. */
export interface ParamTarget {
  read(key: string): AnyParamValue | undefined
  write(key: string, value: unknown): void
  /** Keys that get accessors now. */
  keys(): Iterable<string>
}

const AXES = ['x', 'y', 'z', 'w'] as const

/** A live tuple: each component reads and writes the whole tuple through the target. */
function vector(target: ParamTarget, key: string, size: number): object {
  const current = (): readonly number[] => {
    const value = target.read(key)
    return Array.isArray(value) ? value : []
  }
  const vec: Record<PropertyKey, unknown> = {
    length: size,
    *[Symbol.iterator]() {
      yield* current()
    },
  }
  for (let i = 0; i < size; i++) {
    const access = {
      enumerable: true,
      get: () => current()[i],
      set: (n: number) => {
        const next = [...current()]
        next[i] = n
        target.write(key, next)
      },
    }
    Object.defineProperty(vec, i, access)
    Object.defineProperty(vec, AXES[i] as string, access)
  }
  return vec
}

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
        let vec = vectors.get(key)
        if ((vec as { length?: number } | undefined)?.length !== value.length) {
          vec = vector(target, key, value.length)
          vectors.set(key, vec)
        }
        return vec
      },
      set(value: unknown) {
        target.write(key, value)
      },
    })
    if (own && 'value' in own) target.write(key, own.value)
  }
}

export const specKeys = (...specs: (ParamSpec | object | undefined)[]): Set<string> =>
  new Set(specs.flatMap((s) => (s ? Object.keys(s) : [])))
