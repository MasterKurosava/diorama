import { withDocs } from '../dev'
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

/** An error of the kernel or a plugin. Its message reads `[diorama] CODE: message`. */
export class DioramaError extends Error {
  /** Error code, the key of its page in the docs. */
  readonly code: ErrorCode
  /** Plugin the error comes from, if any. */
  readonly plugin: string | undefined
  /** Every problem found, when the error collects several. */
  readonly problems: readonly DioramaError[]

  constructor(code: ErrorCode, message: string, options: DioramaErrorOptions = {}) {
    const prefix = options.plugin ? `[diorama:${options.plugin}]` : '[diorama]'
    super(
      withDocs(`${prefix} ${code}: ${message}`, code),
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'DioramaError'
    this.code = code
    this.plugin = options.plugin
    this.problems = options.problems ?? []
  }
}

/** Whether `value` is a `DioramaError`, with `code` if one is given. */
export function isDioramaError(value: unknown, code?: ErrorCode): value is DioramaError {
  if (typeof value !== 'object' || value === null) return false
  // Checks the shape, not the class, so errors from another copy of the package match too.
  const candidate = value as { name?: unknown; code?: unknown }
  return (
    candidate.name === 'DioramaError' &&
    typeof candidate.code === 'string' &&
    (!code || candidate.code === code)
  )
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Wraps anything thrown as a `DioramaError` whose code says where it was caught. */
export function toDioramaError(
  error: unknown,
  source: ErrorSource,
  plugin: string | undefined,
): DioramaError {
  if (isDioramaError(error)) return error
  return new DioramaError(CODE_BY_SOURCE[source], messageOf(error), { plugin, cause: error })
}
