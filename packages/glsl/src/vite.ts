// @dioramajs/glsl/vite: `x.frag?shader|effect|entry` modules. Node only.
//   ?shader   the converted module of one file
//   ?effect   glue that wraps the file, and its .vert sibling, in `glslEffect`
//   ?entry    a light registry entry that imports `?effect` on first use
// In dev it also checks every shader file on start and on change, and shows errors in the overlay.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import { format, GlslError } from './convert/errors'
import { collectIncludes, sibling } from './convert/files'
import { type Converted, type ConvertOptions, convertParts, readInclude } from './convert/index'
import { entryMeta, entryModule, paramsType } from './convert/module'
import { effectName, SHADER_FILE, VERTEX_FILE } from './effect-name'
import type { GlslDiagnostic } from './types'

/** Options of the `glsl` Vite plugin. */
export interface GlslPluginOptions {
  /** Shader files to handle. Default /\.(frag|vert|glsl|fs|vs)$/. */
  readonly include?: RegExp
  /** Convert options for every file. Pragmas in the file override them. */
  readonly convert?: Omit<ConvertOptions, 'filename' | 'name' | 'include'>
  /** Fail `vite build` on warnings. Default false. */
  readonly strict?: boolean
  /** Dev: log each file's uniform bindings on first load. Default 'bindings'. */
  readonly report?: 'bindings' | 'none'
  /** Dev: 'all' checks every matching file, not just imported ones. Default 'all'. */
  readonly check?: 'all' | 'imported'
  /** Write `diorama-glsl.d.ts` (or the given path) with per-file param types. Default false. */
  readonly dts?: boolean | string
}

type Kind = 'shader' | 'effect' | 'entry'
/** What the declarations file needs of each converted file. */
type Typed = Map<string, { stem: string; params: Converted['shader']['params'] }>

const QUERY = /\?(shader|effect|entry)$/
const SKIP = new Set(['node_modules', '.git', 'dist', '.vite'])
const RUNTIME = '@dioramajs/glsl'
const ENTRY = /\bvoid\s+(main|mainImage)\s*\(/
const HOT_ACCEPT = 'if (import.meta.hot) import.meta.hot.accept()'

const isVertex = (file: string): boolean => VERTEX_FILE.test(file)
const posix = (path: string): string => path.replace(/\\/g, '/')

/** One line per file: `wave.frag: uTexture→media, uShade→param:shade, vWave→varying`. */
export function bindingTable(file: string, result: Converted): string {
  const items = Object.entries(result.shader.uniforms).map(
    ([uniform, info]) => `${uniform}→${info.bind}`,
  )
  for (const varying of Object.keys(result.shader.varyings)) items.push(`${varying}→varying`)
  return `${file}: ${items.join(', ') || 'no uniforms'}`
}

/** Vite plugin that turns GLSL files into TSL shaders and effects on import. */
export function glsl(options: GlslPluginOptions = {}): Plugin {
  const include = options.include ?? SHADER_FILE
  let config: ResolvedConfig | undefined
  let server: ViteDevServer | undefined
  const tables = new Map<string, string>()
  const types: Typed = new Map()
  const dev = (): boolean => config?.command === 'serve'

  const convertFile = (
    file: string,
    includes: Map<string, { path: string; code: string }>,
  ): Converted =>
    convertParts(readFileSync(file, 'utf8'), {
      ...options.convert,
      filename: file,
      include: (spec, from) => includes.get(`${from}\0${spec}`) ?? readInclude(spec, from),
    })

  const writeDts = (): void => {
    if (!options.dts || !config) return
    const target = resolve(
      config.root,
      typeof options.dts === 'string' ? options.dts : 'diorama-glsl.d.ts',
    )
    const text = declarationsFile(types)
    if (existsSync(target) && readFileSync(target, 'utf8') === text) return
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }

  const remember = (file: string, result: Converted): void => {
    types.set(file, { stem: effectName(file), params: result.shader.params })
    writeDts()
    if (!dev() || options.report === 'none') return
    const table = bindingTable(relative(config?.root ?? '', file), result)
    if (tables.get(file) !== table) {
      tables.set(file, table)
      config?.logger.info(`[diorama-glsl] ${table}`)
    }
  }

  const overlay = (error: GlslError): void => {
    const first = error.diagnostics[0] as GlslDiagnostic
    const hot = server?.environments?.client?.hot ?? server?.hot
    hot?.send({
      type: 'error',
      err: {
        message: error.diagnostics.map((diagnostic) => format(diagnostic)).join('\n'),
        stack: '',
        id: first.file,
        frame: first.frame,
        plugin: 'diorama-glsl',
        loc: { file: first.file, line: first.line, column: first.column },
      },
    })
  }

  const checked = new Map<string, readonly string[]>()
  /** Converts a file outside the module graph and sends errors to the overlay. */
  const check = async (file: string): Promise<void> => {
    // No main means an include. It gets checked through the files that include it.
    const code = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (!ENTRY.test(code)) return
    // Resolve bare specifiers through Vite, as in `load`, so aliases work.
    const container = server?.environments?.client?.pluginContainer ?? server?.pluginContainer
    try {
      const includes = await collectIncludes(
        file,
        code,
        async (spec, from) => (await container?.resolveId(spec, from))?.id,
      )
      const result = convertFile(file, includes)
      checked.set(
        file,
        result.includes.map((path) => posix(resolve(path))),
      )
      remember(file, result)
    } catch (error) {
      if (error instanceof GlslError) overlay(error)
      else config?.logger.error(`[diorama-glsl] ${file}: ${(error as Error).message}`)
    }
  }

  return {
    name: 'diorama-glsl',
    enforce: 'pre',

    configResolved(resolved) {
      config = resolved
    },

    configureServer(dev) {
      server = dev
      // Adding or removing a .vert changes the effect of its .frag.
      const pair = (file: string): void => {
        if (!isVertex(file)) return
        const frag = sibling(posix(resolve(file)))
        for (const kind of ['effect', 'entry']) {
          const node = dev.moduleGraph.getModuleById(`${frag}?${kind}`)
          if (node) void dev.reloadModule(node)
        }
      }
      dev.watcher.on('add', pair)
      // Forget a deleted shader and re-check the files that included it.
      dev.watcher.on('unlink', (file) => {
        if (!include.test(file)) return
        const path = posix(resolve(file))
        const known = types.delete(path)
        tables.delete(path)
        checked.delete(path)
        if (known) writeDts()
        pair(file)
        for (const [other, deps] of checked) if (deps.includes(path)) void check(other)
      })
      if ((options.check ?? 'all') !== 'all') return
      for (const file of shaderFiles(dev.config.root, include)) void check(posix(file))
      const onFile = (file: string): void => {
        if (!include.test(file) || file.split(/[\\/]/).some((part) => SKIP.has(part))) return
        const path = posix(resolve(file))
        void check(path)
        for (const [other, deps] of checked) if (deps.includes(path)) void check(other)
      }
      dev.watcher.on('add', onFile)
      dev.watcher.on('change', onFile)
    },

    async resolveId(source, importer) {
      const query = QUERY.exec(source)?.[0]
      if (!query) return null
      const path = source.slice(0, -query.length)
      if (!include.test(path)) return null
      if (isAbsolute(path) && existsSync(path)) return `${posix(path)}${query}`
      const resolved = await this.resolve(path, importer, { skipSelf: true })
      return resolved ? `${posix(resolved.id.replace(/\?.*$/, ''))}${query}` : null
    },

    async load(id) {
      const match = QUERY.exec(id)
      if (!match) return null
      const file = id.slice(0, -match[0].length)
      const kind = match[1] as Kind
      const load = async (path: string): Promise<Converted> => {
        const code = readFileSync(path, 'utf8')
        const includes = await collectIncludes(
          path,
          code,
          async (spec, from) => (await this.resolve(spec, from, { skipSelf: true }))?.id,
        )
        try {
          const result = convertFile(path, includes)
          for (const dep of result.includes) this.addWatchFile(dep)
          for (const diagnostic of result.diagnostics) {
            if (diagnostic.severity !== 'warning') continue
            if (options.strict && !dev()) this.error(format(diagnostic, true))
            const { line, column } = diagnostic
            this.warn({ message: format(diagnostic), loc: { file: diagnostic.file, line, column } })
          }
          remember(path, result)
          return result
        } catch (error) {
          if (!(error instanceof GlslError)) throw error
          const first = error.diagnostics[0] as GlslDiagnostic
          return this.error({
            message: error.diagnostics.map((diagnostic) => format(diagnostic)).join('\n'),
            id: first.file,
            loc: { file: first.file, line: first.line, column: first.column },
            frame: first.frame,
          })
        }
      }
      const pair = sibling(file)
      const other = pair && !isVertex(file) && existsSync(pair) ? pair : undefined
      // Watch the .vert before it exists so adding one rebuilds the effect. Not in dev: Vite
      // resolves watch files as imports there and a missing one fails. The dev watcher covers it.
      if (pair && !isVertex(file) && kind !== 'shader' && (other || !dev())) this.addWatchFile(pair)
      if (kind === 'shader') return (await load(file)).code
      if (kind === 'effect') return effectGlue(file, other, dev())
      const second = other ? (await load(other)).shader : undefined
      const meta = entryMeta((await load(file)).shader, second)
      const lines = [entryModule(`${file}?effect`, meta).trimEnd()]
      if (dev()) lines.push(HOT_ACCEPT)
      return `${lines.join('\n')}\n`
    },

    transform(code, id) {
      // Glue modules that only export an effect built from `?shader` self-accept for HMR.
      if (!dev() || id.includes('node_modules') || QUERY.test(id)) return null
      if (!/\?shader['"]/.test(code) || code.includes('import.meta.hot')) return null
      if (!/^\s*export\s+default\b/m.test(code)) return null
      if (/^\s*export\s+(?!default\b|type\b|interface\b)/m.test(code)) return null
      return { code: `${code}\n${HOT_ACCEPT}\n`, map: null }
    },
  }
}

/** The `?effect` module: `glslEffect` over the file and its .vert sibling, if there is one. */
function effectGlue(file: string, other: string | undefined, dev: boolean): string {
  const stages = isVertex(file) ? { vertex: file } : { fragment: file, vertex: other }
  const lines = [`import { glslEffect } from '${RUNTIME}'`]
  const names: string[] = []
  for (const [name, path] of Object.entries(stages)) {
    if (!path) continue
    lines.push(`import ${name} from ${JSON.stringify(`${path}?shader`)}`)
    names.push(name)
  }
  lines.push(`export default glslEffect({ ${names.join(', ')} })`)
  if (dev) lines.push(HOT_ACCEPT)
  return `${lines.join('\n')}\n`
}

/**
 * Text of `diorama-glsl.d.ts`: declarations of `?shader`, `?effect` and `?entry` for every
 * converted file, and `EffectTypes` entries. A .frag and its .vert make one effect with the params
 * of both, keyed like glslEntries. A stem shared by several effects gets no declaration.
 */
function declarationsFile(types: Typed): string {
  const effectFile = (file: string): boolean => {
    const pair = sibling(file)
    return !isVertex(file) || !pair || !(types.has(pair) || existsSync(pair))
  }
  const stems = new Map<string, number>()
  for (const [file, typed] of types) {
    if (effectFile(file)) stems.set(typed.stem, (stems.get(typed.stem) ?? 0) + 1)
  }
  const lines = [
    '// Generated by @dioramajs/glsl. Do not edit.',
    "import type { Effect, EffectEntry } from '@dioramajs/effects'",
    "import type { GlslShader } from '@dioramajs/glsl'",
    '',
  ]
  const effects: string[] = []
  for (const [file, typed] of [...types].sort(([a], [b]) => a.localeCompare(b))) {
    if (stems.get(typed.stem) !== 1) continue
    const base = file.split(/[\\/]/).pop() as string
    lines.push(
      `declare module '*/${base}?shader' {\n  const shader: GlslShader<${paramsType(typed.params)}>\n  export default shader\n}`,
    )
    if (!effectFile(file)) continue
    const pair = sibling(file)
    const widened = paramsType({ ...(pair && types.get(pair)?.params), ...typed.params }, false)
    lines.push(
      `declare module '*/${base}?effect' {\n  const effect: Effect<${widened}>\n  export default effect\n}`,
      `declare module '*/${base}?entry' {\n  const entry: EffectEntry\n  export default entry\n}`,
    )
    effects.push(`    '${typed.stem}': Effect<${widened}>`)
  }
  if (effects.length) {
    lines.push(
      `declare module '@dioramajs/effects' {\n  interface EffectTypes {\n${effects.join('\n')}\n  }\n}`,
    )
  }
  return `${lines.join('\n')}\n`
}

/** Shader files under `root`, skipping dependency, VCS and build folders. */
function shaderFiles(root: string, include: RegExp): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (include.test(entry.name)) files.push(path)
    }
  }
  walk(root)
  return files
}
