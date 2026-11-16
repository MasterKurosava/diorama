import type { TransitionErrorCode } from './types'

declare const process: { env: Record<string, string | undefined> } | undefined

/** `import.meta.env.DEV` under Vite, otherwise `NODE_ENV`. */
export const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

/** Reported through `app.report` (the kernel wraps it as `REPORTED`) or logged in dev. */
export class TransitionError extends Error {
  override readonly name: 'TransitionError' = 'TransitionError'
  readonly code: TransitionErrorCode

  constructor(code: TransitionErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(`${code}: ${message}`, options)
    this.code = code
  }
}
