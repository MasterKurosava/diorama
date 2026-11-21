import { withDocs } from '@dioramajs/core/dev'
import type { AssetErrorCode } from './types'

export { DEV } from '@dioramajs/core/dev'

export const noop = (): void => {}

/** Rejects `Asset.ready`. Reported as `asset:<url>`, which the kernel wraps as `REPORTED`. */
export class AssetError extends Error {
  /** Always `AssetError`. */
  override readonly name: 'AssetError' = 'AssetError'
  /** Error code, the key of its page in the docs. */
  readonly code: AssetErrorCode
  /** URL of the asset, if the error has one. */
  readonly url: string | undefined

  constructor(
    code: AssetErrorCode,
    message: string,
    options: { readonly url?: string; readonly cause?: unknown } = {},
  ) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.url = options.url
  }
}

/**
 * Adds the docs page to the message in development builds. Errors pass here on their way out of
 * the plugin, so the three.js loaders don't carry it.
 */
export function linked<E extends AssetError>(error: E): E {
  error.message = withDocs(error.message, error.code)
  return error
}

export const isAbort = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === 'AbortError' ||
  (error as { code?: string } | null)?.code === 'ASSET_ABORTED'
