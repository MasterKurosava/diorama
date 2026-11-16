// @diorama/glsl/loader: webpack 5 and Turbopack loader over convert(). Node only.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { format, GlslError } from './convert/errors'
import { collectIncludes, sibling } from './convert/files'
import { type ConvertOptions, convertParts, readInclude } from './convert/index'
import { inlineEffect } from './convert/module'
import { VERTEX_FILE } from './effect-name'

export type LoaderMode = 'shader' | 'effect' | 'entry'
export interface LoaderOptions extends Omit<ConvertOptions, 'filename' | 'name' | 'include'> {
  /** Defaults to the import query, else 'shader'. `entry` needs webpack's `resourceQuery`. */
  readonly mode?: LoaderMode
}

/** The subset of webpack's loader context we use. Turbopack implements it too. */
export interface LoaderContext<O> {
  readonly resourcePath: string
  readonly resourceQuery: string
  getOptions(): O
  async(): (error: Error | null, code?: string) => void
  addDependency(file: string): void
  emitWarning(warning: Error): void
  getResolve?(options?: object): (context: string, request: string) => Promise<string>
}

const isVertex = (file: string): boolean => VERTEX_FILE.test(file)

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
      for (const d of result.diagnostics) {
        if (d.severity === 'warning') this.emitWarning(new Error(format(d, true)))
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
    const params = { ...other?.shader.params, ...main.shader.params }
    const request = JSON.stringify(`${file.replace(/\\/g, '/')}?effect`)
    return `export default { load: () => import(${request}), params: ${JSON.stringify(params)} }\n`
  }
  run().then(
    (code) => callback(null, code),
    (error: unknown) => {
      if (error instanceof GlslError) {
        const err = new Error(error.diagnostics.map((d) => format(d, true)).join('\n\n'))
        err.name = 'GlslError'
        callback(err)
      } else callback(error as Error)
    },
  )
}
