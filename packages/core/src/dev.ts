/**
 * Development flag and links to the error pages, for Diorama packages. A module of its own, so
 * a package that needs only these does not take the kernel into its bundle.
 * @internal
 * @module
 */

declare const process: { env: Record<string, string | undefined> } | undefined

/** True in development builds: `import.meta.env.DEV` under Vite, otherwise `NODE_ENV`. */
export const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

/** Address of the error pages. The page of a code is this plus the code in kebab case. */
export const DOCS_URL = 'https://dioramajs.dev/docs/errors/'

/** The page that explains `code`: `EFFECT_CORS` has `DOCS_URL + 'effect-cors'`. */
export const docsUrl = (code: string): string => DOCS_URL + code.toLowerCase().replace(/_/g, '-')

/**
 * Ends `message` with the page of `code` in development builds, unless it links a page already.
 * Production builds return the message as is.
 */
export const withDocs = (message: string, code: string): string =>
  DEV && !message.includes(DOCS_URL) ? `${message}\n${docsUrl(code)}` : message
