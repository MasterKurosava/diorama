import type { DioramaErrorOptions, ErrorCode, ErrorSource } from './types'

const CODE_BY_SOURCE: Record<ErrorSource, ErrorCode> = {
  config: 'CONFIG_INVALID',
  setup: 'PLUGIN_SETUP',
  listener: 'LISTENER',
  hook: 'HOOK',
  system: 'SYSTEM',
  effect: 'EFFECT',
  dispose: 'DISPOSE',
  loop: 'LOOP',
  report: 'REPORTED',
}

export class DioramaError extends Error {
  readonly code: ErrorCode
  readonly plugin: string | undefined
  readonly problems: readonly DioramaError[]

  constructor(code: ErrorCode, message: string, options: DioramaErrorOptions = {}) {
    const prefix = options.plugin ? `[diorama:${options.plugin}]` : '[diorama]'
    super(
      `${prefix} ${code}: ${message}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'DioramaError'
    this.code = code
    this.plugin = options.plugin
    this.problems = options.problems ?? []
  }
}

export function isDioramaError(value: unknown, code?: ErrorCode): value is DioramaError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { name?: unknown; code?: unknown }
  return v.name === 'DioramaError' && typeof v.code === 'string' && (!code || v.code === code)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function toDioramaError(
  error: unknown,
  source: ErrorSource,
  plugin: string | undefined,
): DioramaError {
  if (isDioramaError(error)) return error
  return new DioramaError(CODE_BY_SOURCE[source], messageOf(error), { plugin, cause: error })
}
