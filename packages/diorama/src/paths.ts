// Paths for the generated files, shared by the build integrations and the CLI.
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

export const posix = (path: string): string => path.replace(/\\/g, '/')

/** `file` as a posix import specifier relative to `from`, always starting with `.`. */
export function specifier(from: string, file: string): string {
  const path = posix(relative(from, file))
  return path.startsWith('.') ? path : `./${path}`
}

/** A specifier without its code extension, as TypeScript and bundlers resolve it. */
export const bare = (spec: string): string => spec.replace(/\.(m?[jt]sx?)$/, '')

/** `src/effects`, or `effects` in a project without src. */
export const effectsDir = (root: string): string =>
  existsSync(resolve(root, 'src')) ? 'src/effects' : 'effects'
