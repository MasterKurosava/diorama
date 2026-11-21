// dioramajs-glsl CLI: converts shaders next to their sources, checks them in CI, watches them.
import {
  existsSync,
  type FSWatcher,
  globSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import type { ParamDefault } from '@dioramajs/effects'
import { format, GlslError } from './convert/errors'
import { type Converted, type ConvertOptions, convertParts } from './convert/index'
import type { Binding } from './types'

export interface CliIO {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}
export interface CliRun {
  /** Exit code of the first pass. */
  readonly code: number
  /** Stops `--watch`. */
  close(): void
}

const USAGE = `dioramajs-glsl <files...> [--out-dir dir] [--stage auto|uv|color|position]
             [--bind uMouse=input:pointerNdc] [--default uStrength=1] [--check] [--json] [--watch]`
/** ms a burst of change events is merged into one conversion. */
const DEBOUNCE = 30
/** ms between checks for a watched file that is missing, until it reappears. */
const MISSING_RETRY = 250

/** `--default` values: a bool, a number, a tuple of numbers, or a colour. */
function parseDefault(text: string): ParamDefault {
  const parts = text.split(/[\s,]+/).filter(Boolean)
  const numbers = parts.map(Number)
  if (text === 'true' || text === 'false') return text === 'true'
  if (parts.length > 1 && numbers.every(Number.isFinite)) return numbers as unknown as ParamDefault
  if (parts.length === 1 && Number.isFinite(numbers[0])) return numbers[0] as number
  return { '~kind': 'color', value: text } as ParamDefault
}

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      'out-dir': { type: 'string' },
      stage: { type: 'string' },
      bind: { type: 'string', multiple: true },
      default: { type: 'string', multiple: true },
      check: { type: 'boolean' },
      json: { type: 'boolean' },
      watch: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

/** `key=value` arguments as an object, each value mapped. */
const pairs = <T>(
  list: readonly string[] | undefined,
  map: (value: string) => T,
): Record<string, T> =>
  Object.fromEntries(
    (list ?? []).map((item) => {
      const equals = item.indexOf('=')
      return [item.slice(0, equals), map(item.slice(equals + 1))]
    }),
  )

/** Runs the CLI in-process; `bin/diorama-glsl.mjs` exits with `code`. */
export function run(
  argv: readonly string[],
  io: CliIO = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  },
): CliRun {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`)
    return { code: 2, close() {} }
  }
  const { values, positionals } = parsed
  if (values.help || !positionals.length) {
    io.out(USAGE)
    return { code: values.help ? 0 : 2, close() {} }
  }
  const files: string[] = []
  for (const pattern of positionals) {
    const found = /[*?[]/.test(pattern) ? globSync(pattern) : [pattern]
    if (!found.length) {
      io.err(`${pattern}: no files match`)
      return { code: 2, close() {} }
    }
    for (const file of found) if (!files.includes(resolve(file))) files.push(resolve(file))
  }
  const options: ConvertOptions = {
    stage: values.stage as ConvertOptions['stage'],
    bindings: pairs(values.bind, (value) => value as Binding),
    defaults: pairs(values.default, parseDefault),
  }
  // Mirror the input folders under --out-dir so files with the same name don't collide.
  const outDir = values['out-dir'] && resolve(values['out-dir'])
  const root = commonFolder(files)
  const folder = (file: string): string =>
    outDir ? join(outDir, relative(root, dirname(file))) : dirname(file)
  const target = (file: string, ext: string): string =>
    join(folder(file), `${basename(file)}${ext}`)
  /** Includes of each converted file, to convert it again when one changes. */
  const deps = new Map<string, Set<string>>()

  /** Converts one file and writes, or with `--check` compares, its output. */
  const convertFile = (file: string): boolean => {
    let result: Converted
    try {
      result = convertParts(readFileSync(file, 'utf8'), {
        ...options,
        filename: file,
        outDir: folder(file),
      })
    } catch (error) {
      if (!(error instanceof GlslError)) {
        io.err(`${file}: ${(error as Error).message}`)
        return false
      }
      for (const diagnostic of error.diagnostics) io.err(format(diagnostic, true))
      return false
    }
    deps.set(file, new Set(result.includes))
    if (values.json) {
      const { code: _code, parts: _parts, ...rest } = result
      io.out(JSON.stringify({ file, ...rest }))
    } else {
      const table = Object.entries(result.shader.uniforms).map(
        ([uniform, info]) => `  ${uniform} → ${info.bind}`,
      )
      io.out(
        `${basename(file)} (${result.shader.stage}, ${result.stats.fixes} fixes)${table.length ? `\n${table.join('\n')}` : ''}`,
      )
      for (const diagnostic of result.diagnostics) io.out(format(diagnostic, true))
    }
    const js = target(file, '.js')
    if (values.check) {
      if (existsSync(js) && readFileSync(js, 'utf8') !== result.code) {
        io.err(`${js} is stale: run dioramajs-glsl without --check`)
        return false
      }
      return true
    }
    mkdirSync(dirname(js), { recursive: true })
    writeFileSync(js, result.code)
    writeFileSync(target(file, '.d.ts'), result.declaration)
    return true
  }

  let ok = true
  for (const file of files) ok = convertFile(file) && ok
  const code = ok ? 0 : 1
  if (!values.watch) return { code, close() {} }
  const close = watchFiles(files, deps, convertFile)
  io.out(`watching ${files.length} file(s)`)
  return { code, close }
}

/** The deepest folder that holds every file. */
function commonFolder(files: readonly string[]): string {
  return files.map(dirname).reduce((common, folder) => {
    while (common !== folder && !`${folder}${sep}`.startsWith(`${common}${sep}`))
      common = dirname(common)
    return common
  })
}

/**
 * Converts a file again when it or one of its includes changes. Editors that save by rename kill
 * the watcher, so a path is watched again once it reappears. Returns the stop function.
 */
function watchFiles(
  files: readonly string[],
  deps: ReadonlyMap<string, ReadonlySet<string>>,
  convertFile: (file: string) => boolean,
): () => void {
  const watchers = new Map<string, FSWatcher>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false
  /** Runs `fn` after `ms`, replacing a pending call with the same key. */
  const later = (key: string, ms: number, fn: () => void): void => {
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        if (!closed) fn()
      }, ms),
    )
  }
  const unwatch = (path: string): void => {
    watchers.get(path)?.close()
    watchers.delete(path)
  }
  const changed = (path: string): void =>
    later(path, DEBOUNCE, () => {
      for (const file of files) if (file === path || deps.get(file)?.has(path)) convertFile(file)
      sync()
    })
  /** Watches every file and include not watched yet. */
  const sync = (): void => {
    const wanted = new Set([...files, ...[...deps.values()].flatMap((includes) => [...includes])])
    for (const path of wanted) {
      if (watchers.has(path)) continue
      if (!existsSync(path)) {
        later(`missing:${path}`, MISSING_RETRY, () => (existsSync(path) ? changed(path) : sync()))
        continue
      }
      const watcher = watch(path, (event) => {
        if (event === 'rename') unwatch(path)
        changed(path)
      })
      // Windows emits EPERM when a watched file is deleted. Treat it as a rename.
      watcher.on('error', () => {
        unwatch(path)
        changed(path)
      })
      watchers.set(path, watcher)
    }
  }
  sync()
  return () => {
    closed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const path of [...watchers.keys()]) unwatch(path)
  }
}
