// Text pass before three's decoder. Expands includes with a line map, reads pragmas and fixes
// what the decoder gets wrong (precision, GLSL 3 interface, prototypes, layout).
import GLSLDecoder from 'three/addons/transpiler/GLSLDecoder.js'
import { VERTEX_FILE } from '../effect-name'
import type { Dialect } from '../names'
import { NO_ARRAYS, NO_ARRAYS_HINT, type Position, type Reporter } from './errors'

export type IncludeResult = string | { readonly path: string; readonly code: string } | undefined
/** Gets the spec as written and the absolute path of the including file. */
export type IncludeReader = (spec: string, from: string) => IncludeResult

export interface Pragmas {
  default?: string[]
  input?: string
  param?: string
  color?: string
  /** `true` for a bare `@texture`. */
  texture?: string | true
  media?: true
  /** Pragmas present on the line. */
  readonly keys: Set<string>
}
export interface FilePragma {
  name?: string
  stage?: string
  colorSpace?: string
  segments?: string
  bleed?: string
  animate?: string
}
export interface Decl {
  readonly name: string
  readonly type: string
  readonly array: boolean
  readonly at: Position
}
export interface UniformDecl extends Decl {
  readonly pragmas: Pragmas
}
export interface Prototype {
  readonly name: string
  readonly type: string
  readonly at: Position
}
interface Origin {
  readonly file: string
  readonly line: number
}
interface Ident {
  readonly name: string
  /** 1-based, in the expanded code. */
  readonly line: number
  readonly column: number
}
interface Range {
  readonly name: string
  readonly start: number
  readonly end: number
}

export interface Prepared {
  /** Expanded and cleaned source for the decoder. */
  readonly code: string
  readonly files: ReadonlyMap<string, readonly string[]>
  readonly includes: readonly string[]
  readonly stage: 'fragment' | 'vertex'
  readonly dialect: Dialect
  readonly uniforms: readonly UniformDecl[]
  readonly varyings: readonly Decl[]
  readonly externals: readonly Prototype[]
  /** GLSL 3 fragment outputs. */
  readonly outputs: readonly string[]
  readonly pragma: FilePragma
  /** Names used anywhere (pre-expansion identifiers). */
  readonly used: ReadonlySet<string>
  /** Text fixes applied here, for stats. */
  readonly fixes: ReadonlySet<string>
  /** Maps an expanded line/column to the file it came from. */
  at(line: number, column: number): Position
  /** First occurrence of an identifier, inside a function when given. */
  find(name: string, fn?: string): Position
}

const INCLUDE = /^\s*#\s*include\s+(?:"([^"]+)"|<([^>]+)>|([^\s;"<>]+))\s*;?\s*(\/\/.*)?$/
const TYPES =
  /^(void|bool|float|u?int|mat[234](x[234])?|[ibu]?vec[234]|sampler2D|samplerCube|sampler3D|sampler2DArray|[iu]sampler2D)$/
const PRECISION = new Set(['lowp', 'mediump', 'highp'])
/** three's mat4 built-ins. On a Diorama plane they are identities. */
export const MATRICES4: readonly string[] = [
  'modelMatrix',
  'viewMatrix',
  'projectionMatrix',
  'modelViewMatrix',
]
/** Uniforms RawShaderMaterial declares itself. */
const THREE_UNIFORMS = new Set([...MATRICES4, 'normalMatrix', 'cameraPosition'])
const ATTRIBUTES = new Set(['position', 'uv', 'normal'])
const DIRECTIVE = /^\s*#\s*(\w+)\s*(.*)$/

interface Macro {
  readonly params: string[] | null
  readonly body: string
}
/** three's own `#if` evaluation, so includes follow the branches its decoder keeps. */
const condition = (
  GLSLDecoder.prototype as unknown as {
    evaluateCondition(expr: string, macros: Map<string, Macro>): boolean
  }
).evaluateCondition

/** Whether a line ends inside a block comment, given whether it starts in one. */
function commentAfter(line: string, inside: boolean): boolean {
  for (let i = 0; i < line.length; ) {
    if (inside) {
      const close = line.indexOf('*/', i)
      if (close < 0) return true
      inside = false
      i = close + 2
    } else if (line.startsWith('//', i)) return false
    else if (line.startsWith('/*', i)) {
      inside = true
      i += 2
    } else i++
  }
  return inside
}

interface Tok {
  readonly kind: 'id' | 'num' | 'punct' | 'directive' | 'comment'
  readonly text: string
  readonly start: number
  readonly end: number
}

/** Small GLSL lexer with offsets. Directives and comments come out as single tokens. */
function lex(code: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let lineStart = true
  while (i < code.length) {
    const c = code[i] as string
    if (c === '\n') {
      lineStart = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    const start = i
    if (c === '#' && lineStart) {
      while (i < code.length && code[i] !== '\n')
        i += code[i] === '\\' && code[i + 1] === '\n' ? 2 : 1
      out.push({ kind: 'directive', text: code.slice(start, i), start, end: i })
      continue
    }
    lineStart = false
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++
      out.push({ kind: 'comment', text: code.slice(start, i), start, end: i })
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2)
      i = close < 0 ? code.length : close + 2
      out.push({ kind: 'comment', text: code.slice(start, i), start, end: i })
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(i, i + 256))
    if (word) {
      i += word[0].length
      out.push({ kind: 'id', text: word[0], start, end: i })
      continue
    }
    const num = /^(0[xX][0-9a-fA-F]+[uU]?|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFuU]?)/.exec(
      code.slice(i, i + 64),
    )
    if (num) {
      i += num[0].length
      out.push({ kind: 'num', text: num[0], start, end: i })
      continue
    }
    const op = /^(<<=|>>=|\+\+|--|<<|>>|[-+*/%&|^!=<>]=|&&|\|\||\^\^|.)/.exec(code.slice(i, i + 3))
    i += (op as RegExpExecArray)[0].length
    out.push({ kind: 'punct', text: code.slice(start, i), start, end: i })
  }
  return out
}

function readPragmas(comment: string): Pragmas {
  const pragmas: Pragmas = { keys: new Set() }
  const parts = comment.replace(/^\/\/\s*/, '').split(/\s+/)
  let key = ''
  for (const part of parts) {
    if (part.startsWith('@')) {
      key = part.slice(1)
      pragmas.keys.add(key)
      if (key === 'media') pragmas.media = true
      if (key === 'texture') pragmas.texture = true
      if (key === 'default') pragmas.default = []
      continue
    }
    if (!part) continue
    if (key === 'default') pragmas.default?.push(part)
    else if (key === 'input') pragmas.input = part
    else if (key === 'param') pragmas.param = part
    else if (key === 'color') pragmas.color = part
    else if (key === 'texture') pragmas.texture = part
  }
  return pragmas
}

export interface PrepareOptions {
  readonly filename: string
  readonly include: IncludeReader
  readonly dialect: Dialect | 'auto'
  readonly vertex: boolean | undefined
}

export function prepare(source: string, options: PrepareOptions, report: Reporter): Prepared {
  const files = report.files
  const includes: string[] = []
  const lines: string[] = []
  const origins: Origin[] = []

  // Expand includes depth-first, skipping comments and branches the decoder drops.
  const macros = new Map<string, Macro>()
  const branches: { active: boolean; taken: boolean }[] = []
  const active = (): boolean => branches.every((b) => b.active)
  const directive = (name: string, text: string): void => {
    const args = text
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*?\*\//g, '')
      .trim()
    const top = branches[branches.length - 1]
    if (name === 'define' && active()) {
      const fn = /^(\w+)\((.*?)\)\s*(.*)$/.exec(args)
      const obj = /^(\w+)(?:\s+(.*))?$/.exec(args)
      if (fn) {
        const params = (fn[2] as string).split(',').map((p) => p.trim())
        macros.set(fn[1] as string, { params: params.filter(Boolean), body: (fn[3] ?? '').trim() })
      } else if (obj) macros.set(obj[1] as string, { params: null, body: (obj[2] ?? '').trim() })
    } else if (name === 'undef' && active()) macros.delete(args)
    else if (name === 'ifdef' || name === 'ifndef' || name === 'if') {
      const on =
        active() &&
        (name === 'if' ? condition(args, macros) : macros.has(args) === (name === 'ifdef'))
      branches.push({ active: !!on, taken: !!on })
    } else if ((name === 'elif' || name === 'else') && top) {
      const parent = branches.slice(0, -1).every((b) => b.active)
      top.active = parent && !top.taken && (name === 'else' || !!condition(args, macros))
      top.taken ||= top.active
    } else if (name === 'endif') branches.pop()
  }
  const expand = (file: string, text: string, stack: readonly string[]): void => {
    const own = text.split(/\r?\n/)
    if (!files.has(file)) files.set(file, own)
    let comment = false
    own.forEach((line, i) => {
      const at = { file, line: i + 1, column: Math.max(1, line.indexOf('#') + 1) }
      const d = comment ? null : DIRECTIVE.exec(line)
      comment = commentAfter(line, comment)
      if (d) directive(d[1] as string, d[2] as string)
      if (!d || !active()) {
        lines.push(line)
        origins.push({ file, line: i + 1 })
        return
      }
      const m = INCLUDE.exec(line)
      if (/^\s*#\s*pragma\s+glslify\b/.test(line)) {
        report.add(
          'GLSL_GLSLIFY',
          at,
          'glslify is not supported',
          'replace `#pragma glslify: x = require(...)` with an `#include` of the file or package',
        )
      } else if (m?.[2]) {
        report.add(
          'GLSL_INCLUDE',
          at,
          `#include <${m[2]}> is a three ShaderChunk`,
          'three chunks are not converted: paste the code you need or include a file with #include "./file.glsl"',
        )
      } else if (m) {
        const spec = (m[1] ?? m[3]) as string
        const found = options.include(spec, file)
        const resolved = typeof found === 'string' ? { path: spec, code: found } : found
        if (!resolved) {
          report.add(
            'GLSL_INCLUDE',
            at,
            `#include "${spec}" not found`,
            'check the path relative to the including file',
          )
        } else if (stack.includes(resolved.path)) {
          report.add(
            'GLSL_INCLUDE',
            at,
            `include cycle: ${[...stack, resolved.path].join(' → ')}`,
            'remove the mutual include',
          )
        } else {
          if (!includes.includes(resolved.path)) includes.push(resolved.path)
          expand(resolved.path, resolved.code, [...stack, resolved.path])
          return
        }
      } else {
        lines.push(line)
        origins.push({ file, line: i + 1 })
        return
      }
      lines.push('')
      origins.push({ file, line: i + 1 })
    })
  }
  expand(options.filename, source, [options.filename])

  const code = lines.join('\n')
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1)
  const lineOf = (offset: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] as number) <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const at = (line: number, column: number): Position => {
    const origin = origins[line - 1] ??
      origins[origins.length - 1] ?? { file: options.filename, line }
    return { file: origin.file, line: origin.line, column }
  }
  const posOf = (offset: number): Position => {
    const line = lineOf(offset)
    return at(line, offset - (starts[line - 1] as number) + 1)
  }

  const tokens = lex(code)
  const chars = code.split('')
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' '
  }
  /** Length-changing replacements, applied last in reverse order. */
  const edits: { start: number; end: number; text: string }[] = []

  const ids = tokens.filter((t) => t.kind === 'id')
  const used = new Set(ids.map((t) => t.text))
  const vertex = options.vertex ?? (used.has('gl_Position') || VERTEX_FILE.test(options.filename))
  const pragma: FilePragma = {}
  const fixes = new Set<string>()
  let version3 = false
  for (const t of tokens) {
    if (t.kind === 'directive') {
      const d = /^#\s*(\w+)\s*(.*)$/.exec(t.text)
      const name = d?.[1] ?? ''
      if (name === 'version') {
        version3 = /\b300\b/.test(d?.[2] ?? '')
        blank(t.start, t.end)
      } else if (name === 'extension' || name === 'pragma') blank(t.start, t.end)
    } else if (t.kind === 'comment' && /^\/\/\s*@diorama\b/.test(t.text)) {
      for (const [, k, v] of t.text.matchAll(/(\w+)=(\S+)/g)) {
        ;(pragma as Record<string, string>)[k as string] = v as string
      }
      blank(t.start, t.end)
    } else if (t.kind === 'id') {
      if (PRECISION.has(t.text)) {
        fixes.add('precision')
        blank(t.start, t.end)
      } else if (t.text.startsWith('_')) {
        report.add(
          'GLSL_SYNTAX',
          posOf(t.start),
          `name \`${t.text}\` starts with an underscore, which three's transpiler cannot read`,
          'rename it without the leading `_`',
        )
      }
    }
  }

  // Scan top-level statements for interface declarations, prototypes and function ranges.
  const code0 = tokens.filter((t) => t.kind !== 'comment' && t.kind !== 'directive')
  // three's decoder silently accepts some unbalanced brackets, so check them here.
  const open: Tok[] = []
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  for (const t of code0) {
    if (t.text === '(' || t.text === '[' || t.text === '{') open.push(t)
    else if (pairs[t.text]) {
      const top = open.pop()
      if (top?.text !== pairs[t.text]) {
        const missing = top ? `\`${top.text}\` is not closed` : `extra \`${t.text}\``
        report.add(
          'GLSL_SYNTAX',
          posOf(t.start),
          `unbalanced bracket: ${missing}`,
          'check the brackets above this line',
        )
        open.length = 0
        break
      }
    }
  }
  const unclosed = open[0]
  if (unclosed)
    report.add(
      'GLSL_SYNTAX',
      posOf(unclosed.start),
      `bracket \`${unclosed.text}\` is not closed`,
      'add the closing bracket',
    )
  const uniforms: UniformDecl[] = []
  const varyings: Decl[] = []
  const externals: Prototype[] = []
  const outputs: string[] = []
  const functions: Range[] = []
  const structs = new Set<string>()
  const isType = (t: Tok | undefined): boolean =>
    !!t && t.kind === 'id' && (TYPES.test(t.text) || structs.has(t.text))
  const trailingComment = (end: number): Tok | undefined => {
    const line = lineOf(end)
    return tokens.find((t) => t.kind === 'comment' && t.start >= end && lineOf(t.start) === line)
  }

  const fragmentOut = (stmt: Tok[]): void => {
    const name = stmt[stmt.length - 2]
    if (!name) return
    if (outputs.length) {
      report.add(
        'GLSL_OUTPUT',
        posOf(name.start),
        `second output \`${name.text}\`: Diorama draws a single color`,
        'keep one `out vec4`',
      )
    }
    outputs.push(name.text)
  }

  let i = 0
  let depth = 0
  while (i < code0.length) {
    const t = code0[i] as Tok
    if (t.text === '{') depth++
    if (t.text === '}') depth--
    if (depth !== 0 || t.text === '}' || t.text === ';') {
      if (depth > 1 && t.text === '{' && /^[;{}:]$/.test(code0[i - 1]?.text ?? '')) {
        // three's decoder reads a bare block as an array literal. `if (true)` keeps the scope.
        edits.push({ start: t.start, end: t.end, text: 'if (true) {' })
        fixes.add('block')
      }
      if (depth > 0) {
        // three silently drops the brackets of arrays inside functions.
        const next = code0[i + 1]
        const after = code0[i + 2]
        if (
          isType(t) &&
          ((next?.kind === 'id' && after?.text === '[') || next?.text === '[') &&
          code0[i - 1]?.text !== '.'
        ) {
          report.add('GLSL_ARRAY', posOf(t.start), NO_ARRAYS, NO_ARRAYS_HINT)
        }
      }
      i++
      continue
    }
    let j = i
    let inner = 0
    while (j < code0.length) {
      const s = (code0[j] as Tok).text
      if (s === '{' || s === '(' || s === '[') inner++
      if (s === '}' || s === ')' || s === ']') inner--
      if (inner === 0 && s === ';') break
      if (inner === 1 && s === '{' && code0[j - 1]?.text === ')') break
      j++
    }
    const stmt = code0.slice(i, j + 1)
    const end = code0[j] as Tok | undefined
    const first = stmt[0] as Tok
    const words = stmt.map((s) => s.text)

    // Strip layout qualifiers. Only location 0 can be an output.
    let k = 0
    if (first.text === 'layout') {
      const close = words.indexOf(')')
      const loc = /location\s*=\s*(\d+)/.exec(words.slice(0, close + 1).join(' '))
      if (loc && loc[1] !== '0') {
        report.add(
          'GLSL_OUTPUT',
          posOf(first.start),
          `layout(location = ${loc[1]}): Diorama draws a single color`,
          'keep one output at location 0',
        )
      }
      blank(first.start, (stmt[close] as Tok).end)
      k = close + 1
    }
    while (['flat', 'smooth', 'noperspective', 'centroid', 'invariant'].includes(words[k] ?? '')) {
      blank((stmt[k] as Tok).start, (stmt[k] as Tok).end)
      k++
    }
    const head = words[k]
    if (head === 'precision') {
      fixes.add('precision')
      blank(first.start, end?.end ?? first.end)
    } else if (head === 'struct') {
      if (stmt[k + 1]) structs.add((stmt[k + 1] as Tok).text)
    } else if (
      head === 'uniform' ||
      head === 'varying' ||
      head === 'in' ||
      head === 'out' ||
      head === 'attribute'
    ) {
      const typeTok = stmt.slice(k + 1).find((s) => s.kind === 'id' && !PRECISION.has(s.text))
      const rest = stmt.slice(stmt.indexOf(typeTok as Tok) + 1, -1)
      // Each name may have [N]. GLSL allows no initialisers here.
      const names: { tok: Tok; array: boolean }[] = []
      for (let n = 0; n < rest.length; n++) {
        const s = rest[n] as Tok
        if (s.text === '=') break
        if (s.kind === 'id') names.push({ tok: s, array: rest[n + 1]?.text === '[' })
        if (s.text === '[') while (n < rest.length && (rest[n] as Tok).text !== ']') n++
      }
      const type = typeTok?.text ?? 'float'
      const decls = names.map(({ tok, array }) => ({
        name: tok.text,
        type,
        array,
        at: posOf(tok.start),
      }))
      const kind =
        head === 'uniform'
          ? 'uniform'
          : head === 'attribute' || (head === 'in' && vertex)
            ? 'attribute'
            : head === 'out' && !vertex
              ? 'output'
              : 'varying'
      if (kind === 'uniform' && decls.every((d) => THREE_UNIFORMS.has(d.name))) {
        // Copied from a RawShaderMaterial. These matrices are built-ins here.
        blank(first.start, end?.end ?? first.end)
      } else if (kind === 'attribute') {
        for (const d of decls) {
          if (!ATTRIBUTES.has(d.name)) {
            report.add(
              'GLSL_VERTEX',
              d.at,
              `attribute \`${d.name}\`: a Diorama plane has only position, uv and normal`,
              'compute the value from position or uv',
            )
          }
        }
        blank(first.start, end?.end ?? first.end)
      } else if (kind === 'output') {
        fragmentOut(stmt)
        fixes.add('glsl3')
        blank(first.start, end?.end ?? first.end)
      } else {
        if (kind === 'uniform') {
          const comment = trailingComment(end?.end ?? first.end)
          const pragmas = comment ? readPragmas(comment.text) : { keys: new Set<string>() }
          if (comment && pragmas.keys.size) blank(comment.start, comment.end)
          for (const d of decls) uniforms.push({ ...d, pragmas })
        } else varyings.push(...decls)
        const keyword = kind === 'uniform' ? 'uniform' : 'varying'
        if (decls.length > 1 || head === 'in' || head === 'out') {
          fixes.add(head === 'in' || head === 'out' ? 'glsl3' : 'split-interface')
          // three reads only the first name of a declaration, so split them.
          const text = decls
            .map((d) => `${keyword} ${type} ${d.name}${d.array ? '[1]' : ''};`)
            .join(' ')
          edits.push({ start: (stmt[k] as Tok).start, end: end?.end ?? first.end, text })
        }
      }
    } else if (isType(stmt[k]) && stmt[k + 1]?.kind === 'id' && stmt[k + 2]?.text === '(') {
      const name = stmt[k + 1] as Tok
      if (end?.text === ';') {
        externals.push({ name: name.text, type: (stmt[k] as Tok).text, at: posOf(name.start) })
        fixes.add('prototype')
        blank(first.start, end.end)
      } else {
        let d = 0
        let close = j
        for (; close < code0.length; close++) {
          const s = (code0[close] as Tok).text
          if (s === '{') d++
          if (s === '}' && --d === 0) break
        }
        functions.push({
          name: name.text,
          start: lineOf(first.start),
          end: lineOf((code0[close] as Tok | undefined)?.start ?? code.length),
        })
        const param = stmt[k + 3]
        if (param?.text === 'void' && stmt[k + 4]?.text === ')') blank(param.start, param.end)
        i = j
        continue
      }
    } else if (isType(stmt[k]) || head === 'const') {
      const nameIdx = head === 'const' ? k + 2 : k + 1
      if (stmt[nameIdx + 1]?.text === '[' || stmt[k + 1]?.text === '[') {
        report.add('GLSL_ARRAY', posOf(first.start), NO_ARRAYS, NO_ARRAYS_HINT)
      }
    }
    i = j + 1
  }

  for (const e of edits.sort((a, b) => b.start - a.start)) {
    chars.splice(e.start, e.end - e.start, ...e.text)
  }

  const fnNames = new Set(functions.map((f) => f.name))
  const dialect: Dialect =
    options.dialect !== 'auto'
      ? options.dialect
      : fnNames.has('mainImage')
        ? 'shadertoy'
        : version3 || outputs.length
          ? 'glsl3'
          : 'three'

  const idents: Ident[] = ids.map((t) => {
    const line = lineOf(t.start)
    return { name: t.text, line, column: t.start - (starts[line - 1] as number) + 1 }
  })
  const find = (name: string, fn?: string): Position => {
    const range = fn ? functions.find((f) => f.name === fn) : undefined
    const root = name.split('.')[0] as string
    const hit =
      idents.find(
        (t) => t.name === root && (!range || (t.line >= range.start && t.line <= range.end)),
      ) ?? idents.find((t) => t.name === root)
    if (hit) return at(hit.line, hit.column)
    if (range) return at(range.start, 1)
    return { file: options.filename, line: 1, column: 1 }
  }

  return {
    code: chars.join(''),
    files,
    includes,
    stage: vertex ? 'vertex' : 'fragment',
    dialect,
    uniforms,
    varyings,
    externals,
    outputs,
    pragma,
    used,
    fixes,
    at,
    find,
  }
}
