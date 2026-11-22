// dioramajs add: a built-in effect's source copied into the site's effects folder, with imports
// rewritten to public entries, private helpers copied under _<module>/, param docs as TSDoc, and
// `override` when the copy keeps a built-in name. Sources come from the installed packages, which
// publish src.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { BIN, SCOPE, SITE, SOURCE } from './names'
import { bare, posix, specifier } from './paths'
import { CODE, effectName, SHADER } from './vite'

/** A param of a built-in, from its module's meta.json. */
export interface BuiltInParam {
  readonly name: string
  readonly description?: string
}
/** A built-in effect and its source file. */
export interface BuiltIn {
  readonly name: string
  /** `media` for `@dioramajs/media`. */
  readonly module: string
  /** Absolute path of the effect's source. */
  readonly file: string
  readonly params: readonly BuiltInParam[]
}

interface Pkg {
  readonly dir: string
  readonly version: string
  readonly exports: { readonly [path: string]: unknown }
  readonly dependencies: readonly string[]
}

/** Internal entries a site reaches under another public name: '' is the package itself. */
const MOVED: { readonly [entry: string]: string } = {
  'effects/effect': '',
  'effects/kit': 'kit',
  'effects/runtime': 'kit',
}
const NAME = /^[a-z][a-z0-9-]*$/
/** The runtime's own copy of bare media: a re-export, no code to own. */
const BASE = 'image'
/** Module specifiers of static imports, dynamic imports and re-exports. */
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g
/** Line width of the TSDoc and imports written into a copy. */
const WIDTH = 100

const require = createRequire(import.meta.url)
const packages = new Map<string, Pkg>()
/** An installed package's folder, version, exports and dependencies, read once. */
function pkg(name: string): Pkg {
  let found = packages.get(name)
  if (!found) {
    const file = require.resolve(`${name}/package.json`)
    const json = JSON.parse(readFileSync(file, 'utf8'))
    found = {
      dir: dirname(file),
      version: json.version ?? '',
      exports: json.exports ?? {},
      dependencies: Object.keys(json.dependencies ?? {}),
    }
    packages.set(name, found)
  }
  return found
}

/** The source of a package entry: its source condition, else src/<entry>.ts. */
function sourceOf(info: Pkg, entry: string): string | undefined {
  const target = info.exports[entry ? `./${entry}` : '.']
  const path =
    typeof target === 'object' && target ? (target as Record<string, unknown>)[SOURCE] : undefined
  if (typeof path === 'string') return resolve(info.dir, path)
  const guess = resolve(info.dir, 'src', `${entry || 'index'}.ts`)
  return existsSync(guess) ? guess : undefined
}

let index: Map<string, BuiltIn> | undefined
/** Every built-in effect by name: the modules diorama depends on that publish a meta.json. */
export function builtIns(): ReadonlyMap<string, BuiltIn> {
  if (index) return index
  index = new Map()
  for (const dep of pkg(SITE).dependencies) {
    if (!dep.startsWith(`${SCOPE}/`)) continue
    const info = pkg(dep)
    if (!info.exports['./meta.json']) continue
    const module = dep.slice(SCOPE.length + 1)
    const meta = JSON.parse(readFileSync(join(info.dir, 'meta.json'), 'utf8')) as {
      name: string
      import?: string
      params?: BuiltInParam[]
    }[]
    for (const item of meta) {
      const entry = item.import?.startsWith(`${dep}/`)
        ? item.import.slice(dep.length + 1)
        : item.name
      const file = sourceOf(info, entry)
      if (file) index.set(item.name, { name: item.name, module, file, params: item.params ?? [] })
    }
  }
  return index
}

/** Index of the bracket closing the one at `open`, past strings and comments. */
function closing(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === '/' && (code[i + 1] === '/' || code[i + 1] === '*')) {
      const end = code[i + 1] === '/' ? code.indexOf('\n', i) : code.indexOf('*/', i + 2) + 1
      if (end <= 0) return -1
      i = end
    } else if (c === "'" || c === '"' || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++
    } else if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      if (--depth === 0) return i
    }
  }
  return -1
}

/** Splits at commas and semicolons outside brackets. */
function members(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++
    else if (c === '}' || c === ')' || c === ']' || (c === '>' && body[i - 1] !== '=')) depth--
    else if ((c === ';' || c === ',') && depth === 0) {
      out.push(body.slice(from, i))
      from = i + 1
    }
  }
  out.push(body.slice(from))
  return out.map((m) => m.trim()).filter(Boolean)
}

/** A TSDoc comment, wrapped to the line width. */
function tsdoc(text: string, indent: string): string[] {
  const clean = text.replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').trim()
  const one = `${indent}/** ${clean} */`
  if (one.length <= WIDTH) return [one]
  const lines: string[] = []
  let line = ''
  for (const word of clean.split(' ')) {
    if (line && indent.length + 3 + line.length + 1 + word.length > WIDTH) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  lines.push(line)
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`), `${indent} */`]
}

/** Where the params type literal of the default export opens: inline, or a local type. */
function paramsType(code: string): number {
  const annotation = /\bconst\s+[\w$]+\s*:\s*Effect<\s*/.exec(code)
  if (!annotation) return -1
  const at = annotation.index + annotation[0].length
  if (code[at] === '{') return at
  const id = /^[A-Za-z_$][\w$]*/.exec(code.slice(at))?.[0]
  if (!id) return -1
  const decl = new RegExp(
    `^(?:export\\s+)?(?:type\\s+${id}\\s*=\\s*|interface\\s+${id}\\b[^{\\n]*)\\{`,
    'm',
  ).exec(code)
  return decl ? decl.index + decl[0].length - 1 : -1
}

/** TSDoc from the param descriptions on the members of the params type. */
export function documentParams(code: string, params: readonly BuiltInParam[]): string {
  const notes = new Map(params.flatMap((p) => (p.description ? [[p.name, p.description]] : [])))
  const open = paramsType(code)
  const close = open < 0 ? -1 : closing(code, open)
  if (!notes.size || close < 0) return code
  const start = code.lastIndexOf('\n', open) + 1
  const indent = /^[ \t]*/.exec(code.slice(start))?.[0] ?? ''
  const body = code.slice(open + 1, close)
  // One member a line, so each can carry its comment.
  const lines = body.includes('\n')
    ? body
        .replace(/^[ \t]*\n/, '')
        .replace(/\n[ \t]*$/, '')
        .split('\n')
    : members(body).map((m) => `${indent}  ${m}`)
  const out: string[] = []
  let depth = 0
  for (const line of lines) {
    const key = depth === 0 && /^([ \t]*)(?:readonly\s+)?(['"]?)([\w$-]+)\2\??\s*:/.exec(line)
    const note = key && notes.get(key[3] as string)
    if (key && note && !/\*\/\s*$/.test(out.at(-1) ?? ''))
      out.push(...tsdoc(note, key[1] as string))
    out.push(line)
    for (const c of line.replace(/'[^']*'|"[^"]*"/g, '')) {
      if (c === '{' || c === '(' || c === '[') depth++
      else if (c === '}' || c === ')' || c === ']') depth--
    }
  }
  return `${code.slice(0, open + 1)}\n${out.join('\n')}\n${indent}${code.slice(close)}`
}

/** One import statement per module and kind, as rewriting can map two entries to one. */
function mergeImports(code: string): string {
  const IMPORT = /^import (type )?\{([^}]*)\} from '([^']+)'\n/gm
  const groups = new Map<string, string[]>()
  for (const m of code.matchAll(IMPORT)) {
    const key = `${m[1] ?? ''}${m[3]}`
    const names = (m[2] as string).split(',').map((n) => n.trim())
    groups.set(key, [...(groups.get(key) ?? []), ...names.filter(Boolean)])
  }
  const done = new Set<string>()
  return code.replace(IMPORT, (all, type: string | undefined, _names, from: string) => {
    const key = `${type ?? ''}${from}`
    const names = [...new Set(groups.get(key))]
    if (done.has(key)) return ''
    done.add(key)
    if (names.length === (_names as string).split(',').filter((n) => n.trim()).length) return all
    const head = `import ${type ?? ''}`
    const one = `${head}{ ${names.join(', ')} } from '${from}'`
    return one.length <= WIDTH
      ? `${one}\n`
      : `${head}{\n${names.map((n) => `  ${n},\n`).join('')}} from '${from}'\n`
  })
}

/** A file of a package, resolved like a bundler: with or without its extension. */
function resolveFile(path: string): string | undefined {
  for (const file of [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.ts')]) {
    if (existsSync(file) && extname(file)) return file
  }
  return undefined
}

/** The copy of one built-in: its text and its helpers, by path inside the effects folder. */
export interface Copy {
  readonly main: string
  readonly helpers: ReadonlyMap<string, string>
}

/** Builds the copy of `effect` under the name `as`. Throws on an import it cannot place. */
export function copy(effect: BuiltIn, as: string = effect.name): Copy {
  const site = pkg(SITE)
  const helpers = new Map<string, string>()
  const queue: { file: string; module: string; at: string }[] = []

  /** The helper's path in the folder, queued for copying on first use. */
  const helper = (file: string, module: string): string => {
    const src = join(pkg(`${SCOPE}/${module}`).dir, 'src')
    const at = `_${module}/${posix(relative(src, file))}`
    if (!helpers.has(at) && !queue.some((q) => q.at === at)) queue.push({ file, module, at })
    return at
  }
  const local = (from: string, to: string): string => bare(specifier(dirname(from), to))

  const rewrite = (code: string, file: string, module: string, at: string): string =>
    code.replace(SPEC, (all, lead: string, q: string, spec: string) => {
      const to = place(spec, file, module, at)
      return to === undefined ? all : `${lead}${q}${to}${q}`
    })

  const place = (spec: string, file: string, module: string, at: string): string | undefined => {
    if (spec.startsWith('.')) {
      const target = resolveFile(resolve(dirname(file), spec))
      const src = join(pkg(`${SCOPE}/${module}`).dir, 'src')
      if (!target || relative(src, target).startsWith('..'))
        throw new Error(`${effect.name}: cannot place '${spec}' of ${posix(file)}`)
      const entry = bare(posix(relative(src, target)))
      // Shared state, like the page's audio graph, stays one copy through a public entry.
      if (site.exports[`./${module}/${entry}`]) return `${SITE}/${module}/${entry}`
      return local(at, helper(target, module))
    }
    if (!spec.startsWith(`${SCOPE}/`)) return undefined
    const entry = spec.slice(SCOPE.length + 1)
    const moved = MOVED[entry]
    if (moved !== undefined) return moved ? `${SITE}/${moved}` : SITE
    if (site.exports[`./${entry}`]) return `${SITE}/${entry}`
    const [name = '', ...rest] = entry.split('/')
    const source = rest.length ? sourceOf(pkg(`${SCOPE}/${name}`), rest.join('/')) : undefined
    if (!source) throw new Error(`${effect.name}: '${spec}' has no public entry in ${SITE}`)
    return local(at, helper(source, name))
  }

  let main = rewrite(readFileSync(effect.file, 'utf8'), effect.file, effect.module, `${as}.ts`)
  for (let job = queue.shift(); job; job = queue.shift()) {
    helpers.set(
      job.at,
      mergeImports(rewrite(readFileSync(job.file, 'utf8'), job.file, job.module, job.at)),
    )
  }
  main = documentParams(mergeImports(main), effect.params)
  if (as !== effect.name) main = rename(main, effect.name, as)
  const version = site.version ? ` ${site.version}` : ''
  main = `// The built-in \`${effect.name}\` effect of ${SITE}${version}, copied by \`${BIN} add\`: yours to edit.\n${main}`
  if (builtIns().has(as) && !/^export const override\b/m.test(main)) {
    main += `\n// Replaces the built-in \`${as}\` on purpose: no EFFECT_OVERRIDE warning.\nexport const override = true\n`
  }
  const intro = introOf(effect)
  if (intro && !/^export const intro\b/m.test(main)) main += `\n${intro}`
  return { main, helpers }
}

/**
 * The built-in's intro rule from its module's light map, as an `export const intro` the folder
 * registry inlines: `true`, or the rule's function with its types taken out.
 */
export function introOf(effect: BuiltIn): string | undefined {
  const index = sourceOf(pkg(`${SCOPE}/${effect.module}`), '')
  if (!index) return undefined
  const code = readFileSync(index, 'utf8')
  const key = new RegExp(`\\n\\s*(?:${effect.name}|'${effect.name}'):\\s*\\{`).exec(code)
  if (!key) return undefined
  const open = key.index + key[0].length - 1
  const value = /\bintro:\s*(true\b|[\w$.]+)/.exec(code.slice(open, closing(code, open)))?.[1]
  const head = '/** Plays behind a veil when in view at mount, until the effect draws. */\n'
  if (!value) return undefined
  if (value === 'true') return `${head}export const intro = true\n`
  // `ns.rule` of `import * as ns from './intro'`, or a named import.
  const [ns, rule] = value.includes('.') ? value.split('.') : [undefined, value]
  const from = ns
    ? new RegExp(`import \\* as ${ns} from '([^']+)'`).exec(code)?.[1]
    : new RegExp(`import \\{[^}]*\\b${rule}\\b[^}]*\\} from '([^']+)'`).exec(code)?.[1]
  const file = from && resolveFile(resolve(dirname(index), from))
  if (!file || !rule) return undefined
  const source = readFileSync(file, 'utf8')
  const at = new RegExp(`^export const ${rule}\\b[^=]*=\\s*`, 'm').exec(source)
  if (!at) return undefined
  // The statement ends where a line starts at column 0 with anything but a closer.
  const rest = source.slice(at.index + at[0].length)
  const end = /\n(?=[^\s)\]}])|$/.exec(rest)?.index ?? rest.length
  const fn = rest
    .slice(0, end)
    .trimEnd()
    .replace(
      /^\(([^)]*)\)(?:\s*:\s*[^=]+?)?\s*=>/,
      (_, params: string) =>
        `(${params
          .split(',')
          .map((p) => p.replace(/:.*$/s, '').trim())
          .filter(Boolean)
          .join(', ')}) =>`,
    )
  const doc = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*$/.exec(source.slice(0, at.index))?.[1]
  return `${doc ? `${doc}\n` : head}export const intro: (element: Element) => boolean = ${fn}\n`
}

/** The definition's `name` set to the copy's, so the registry does not report an alias. */
function rename(code: string, from: string, to: string): string {
  const at = code.search(/\bdefineEffect\s*\(/)
  if (at < 0) return code
  const match = new RegExp(`(\\bname\\s*:\\s*)(['"])${from.replace(/-/g, '\\-')}\\2`).exec(
    code.slice(at),
  )
  if (!match) return code
  const i = at + match.index
  return `${code.slice(0, i)}${match[1]}${match[2]}${to}${match[2]}${code.slice(i + match[0].length)}`
}

/** What `add` reports. */
export interface AddReport {
  readonly code: number
  readonly out: readonly string[]
  readonly err: readonly string[]
}

/** Copies the named built-ins into `dir`. `shown` turns a path into the one printed. */
export function add(
  dir: string,
  names: readonly string[],
  options: { readonly as?: string | undefined; readonly force?: boolean | undefined },
  shown: (path: string) => string,
): AddReport {
  const out: string[] = []
  const err: string[] = []
  const all = builtIns()
  const site = pkg(SITE)
  let code = 0
  const files = existsSync(dir) ? readdirSync(dir) : []
  for (const name of names) {
    const effect = all.get(name)
    const as = options.as ?? name
    if (name === BASE) {
      err.push(`${BASE} is the base layer, nothing to copy; write your own with effect()`)
      code = 2
      continue
    }
    if (!effect) {
      err.push(`unknown built-in effect "${name}"`)
      code ||= 1
      continue
    }
    if (!NAME.test(as)) {
      err.push(`"${as}" is not a kebab-case effect name`)
      code ||= 1
      continue
    }
    const file = join(dir, `${as}.ts`)
    const taken = files.filter(
      (f) =>
        (CODE.has(extname(f)) || extname(f) === SHADER) &&
        !f.endsWith('.d.ts') &&
        !f.startsWith('_') &&
        effectName(f) === as &&
        (f !== `${as}.ts` || !options.force),
    )
    if (taken.length) {
      const which = taken.includes(`${as}.ts`) ? `${shown(file)} exists: --force replaces it` : ''
      err.push(which || `"${as}" is taken by ${shown(join(dir, taken[0] as string))}`)
      code ||= 1
      continue
    }
    let made: Copy
    try {
      made = copy(effect, as)
    } catch (error) {
      err.push((error as Error).message)
      code ||= 1
      continue
    }
    for (const [at, text] of made.helpers) {
      const path = join(dir, at)
      if (existsSync(path)) {
        if (readFileSync(path, 'utf8') === text) continue
        if (!options.force) {
          err.push(
            `kept ${shown(path)}: it differs from ${SITE} ${site.version}'s, --force replaces it`,
          )
          continue
        }
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      out.push(`wrote ${shown(path)}`)
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, made.main)
    if (!files.includes(`${as}.ts`)) files.push(`${as}.ts`)
    out.push(`wrote ${shown(file)}${all.has(as) ? `, which replaces the built-in "${as}"` : ''}`)
  }
  return { code, out, err }
}
