import type { Logger, LogLevel } from './types'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 }

export const noop = (): void => {}

export const resolved: Promise<void> = Promise.resolve()

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Copies `base` and overwrites it with the keys of `next` that are not `undefined`. */
export function mergeOptions(base: object, next: object | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  if (!next) return result
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

export function shallowEqual(a: object, b: object): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  const first = a as Record<string, unknown>
  const second = b as Record<string, unknown>
  return keys.every((key) => Object.is(first[key], second[key]))
}

export function perfNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/** Forwards to `sink` the calls at `level` or above, after `prefix` if one is given. */
export function createLogger(sink: Logger, level: LogLevel, prefix: string): Logger {
  const threshold = LEVELS[level]
  const forward =
    (method: keyof Logger) =>
    (...data: unknown[]): void => {
      if (LEVELS[method] < threshold) return
      if (prefix) sink[method](prefix, ...data)
      else sink[method](...data)
    }
  return {
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
  }
}
