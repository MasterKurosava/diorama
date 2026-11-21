// @dioramajs/glsl/loader: webpack 5 and Turbopack loader over convert(). Node only.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { format, GlslError } from './convert/errors'
import { collectIncludes, sibling } from './convert/files'
import { type ConvertOptions, convertParts, readInclude } from './convert/index'
import { entryMeta, entryModule, inlineEffect } from './convert/module'
import { VERTEX_FILE } from './effect-name'

/** What an import returns: the shader, an effect, or a lazy registry entry. */
export type LoaderMode = 'shader' | 'effect' | 'entry'
/** Options of the webpack and Turbopack loader. */
export interface LoaderOptions extends Omit<ConvertOptions, 'filename' | 'name' | 'include'> {
  /** Defaults to the import query, else 'shader'. `entry` needs webpack's `resourceQuery`. */
  readonly mode?: LoaderMode
}

/** The subset of webpack's loader context we use. Turbopack implements it too. */
export interface LoaderContext<O> {
  /** Path of the file. */
  readonly resourcePath: string
  /** Query of the import. */
  readonly resourceQuery: string
  /** Loader options. */
  getOptions(): O
  /** Makes the loader async and returns its callback. */
  async(): (error: Error | null, code?: string) => void
  /** Watches a file. */
  addDependency(file: string): void
  /** Reports a warning. */
  emitWarning(warning: Error): void
  /** Returns a resolver with the bundler's rules. */
  getResolve?(options?: object): (context: string, request: string) => Promise<string>
}

const isVertex = (file: string): boolean => VERTEX_FILE.test(file)

/** Webpack and Turbopack loader that turns GLSL files into TSL shaders and effects. */
export default function dioramaGlslLoader(
  this: LoaderContext<LoaderOptions>,
  source: string,
): void {
  const callback = this.async()
  const file = this.resourcePath
  const { mode: option, ...convert } = this.getOptions() ?? {}
  const query = /^\?(shader|effect|entry)\b/.exec(this.resourceQuery)?.[1] as LoaderMode | undefined
  const mode = option ?? query ?? 'shader'
  const resolver = this.getResolve?.()
  const resolveBare = async (spec: string, from: string): Promise<string | undefined> => {
    try {
      return resolver
        ? await resolver(from.replace(/[\\/][^\\/]*$/, ''), spec)
        : createRequire(from).resolve(spec)
    } catch {
      return undefined
    }
  }
  const run = async (): Promise<string> => {
    const stage = async (path: string, code: string) => {
      const includes = await collectIncludes(path, code, resolveBare)
      const result = convertParts(code, {
        ...convert,
        filename: path,
        include: (spec, from) => includes.get(`${from}\0${spec}`) ?? readInclude(spec, from),
      })
      for (const dep of result.includes) this.addDependency(dep)
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === 'warning') this.emitWarning(new Error(format(diagnostic, true)))
      }
      return result
    }
    const main = await stage(file, source)
    if (mode === 'shader') return main.code
    const pair = sibling(file)
    if (pair) this.addDependency(pair)
    const other =
      pair && !isVertex(file) && existsSync(pair)
        ? await stage(pair, readFileSync(pair, 'utf8'))
        : undefined
    if (mode === 'effect') {
      return isVertex(file)
        ? inlineEffect({ vertex: main.parts })
        : inlineEffect({ fragment: main.parts, vertex: other?.parts })
    }
    return entryModule(`${file.replace(/\\/g, '/')}?effect`, entryMeta(main.shader, other?.shader))
  }
  run().then(
    (code) => callback(null, code),
    (error: unknown) => {
      if (error instanceof GlslError) {
        const err = new Error(
          error.diagnostics.map((diagnostic) => format(diagnostic, true)).join('\n\n'),
        )
        err.name = 'GlslError'
        callback(err)
      } else callback(error as Error)
    },
  )
}
