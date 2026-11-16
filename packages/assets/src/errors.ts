import type { AssetErrorCode } from './types'

declare const process: { env: Record<string, string | undefined> } | undefined

/** `import.meta.env.DEV` under Vite, otherwise `NODE_ENV`. */
export const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

export const noop = (): void => {}

/** Rejects `Asset.ready`. Reported as `asset:<url>`, which the kernel wraps as `REPORTED`. */
export class AssetError extends Error {
  override readonly name: 'AssetError' = 'AssetError'
  readonly code: AssetErrorCode
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

export const isAbort = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === 'AbortError' ||
  (error as { code?: string } | null)?.code === 'ASSET_ABORTED'
