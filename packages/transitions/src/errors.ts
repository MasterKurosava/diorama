import { withDocs } from '@dioramajs/core/dev'
import type { TransitionErrorCode } from './types'

/** Reported through `app.report` (the kernel wraps it as `REPORTED`) or logged in dev. */
export class TransitionError extends Error {
  /** Always `TransitionError`. */
  override readonly name: 'TransitionError' = 'TransitionError'
  /** Error code, the key of its page in the docs. */
  readonly code: TransitionErrorCode

  constructor(code: TransitionErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(withDocs(`${code}: ${message}`, code), options)
    this.code = code
  }
}
