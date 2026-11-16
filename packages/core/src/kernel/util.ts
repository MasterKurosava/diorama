import type { Logger, LogLevel } from './types'

export const noop = (): void => {}

export const resolved: Promise<void> = Promise.resolve()

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export function mergeOptions(base: object, next: object | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  if (next) {
    for (const [key, value] of Object.entries(next)) if (value !== undefined) result[key] = value
  }
  return result
}

export function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const key of ka) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false
  }
  return true
}

export function perfNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 }

export function createLogger(sink: Logger, level: LogLevel, prefix: string): Logger {
  const min = LEVELS[level]
  const at =
    (name: keyof Logger, value: number) =>
    (...data: unknown[]): void => {
      if (value < min) return
      if (prefix) sink[name](prefix, ...data)
      else sink[name](...data)
    }
  return {
    debug: at('debug', 0),
    info: at('info', 1),
    warn: at('warn', 2),
    error: at('error', 3),
  }
}
