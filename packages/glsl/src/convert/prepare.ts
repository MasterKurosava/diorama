// Stage 1 of the converter: a text pass before three's decoder. It expands includes with a line
// map back to the original files, reads pragmas, collects the interface declarations, and fixes
// what the decoder gets wrong (precision, GLSL 3 interface, prototypes, layout, bare blocks).
//
// The steps, in order:
//   expandIncludes   #include files inlined depth-first, following the #if branches three keeps
//   lex              tokens with offsets into the expanded code
//   readDirectives   #version, #extension, #pragma and `// @diorama` comments, precision words
//   checkBrackets    unbalanced brackets, which the decoder accepts silently
//   Scanner          top-level statements: uniforms, varyings, outputs, prototypes, functions
// Text changes either blank characters in place, keeping every offset, or replace a range; the
// replacements are applied last, from the end of the code backwards.
import GLSLDecoder from 'three/addons/transpiler/GLSLDecoder.js'
import { VERTEX_FILE } from '../effect-name'
import type { Dialect } from '../names'
import { NO_ARRAYS, NO_ARRAYS_HINT, type Position, type Reporter } from './errors'

/** What an include reader returns: the code, the code with its path, or nothing. */
export type IncludeResult = string | { readonly path: string; readonly code: string } | undefined
/** Gets the spec as written and the absolute path of the including file. */
export type IncludeReader = (spec: string, from: string) => IncludeResult

/** Pragmas in the trailing comment of a uniform declaration. */
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
/** Settings from `// @diorama key=value` comments. */
export interface FilePragma {
  name?: string
  stage?: string
  colorSpace?: string
  segments?: string
  bleed?: string
  animate?: string
  when?: string
  reducedMotion?: string
  presence?: string
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

export interface PrepareOptions {
  readonly filename: string
  readonly include: IncludeReader
  readonly dialect: Dialect | 'auto'
  readonly vertex: boolean | undefined
}

/** Where an expanded line came from. */
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
/** Lines of a function definition in the expanded code. */
interface Range {
  readonly name: string
  readonly start: number
  readonly end: number
}
interface Macro {
  readonly params: string[] | null
  readonly body: string
}
interface Token {
  readonly kind: 'id' | 'num' | 'punct' | 'directive' | 'comment'
  readonly text: string
  readonly start: number
  readonly end: number
}

/** Allowed values of the file pragmas that reach the effect definition as they are. */
const CHOICES: { readonly [key: string]: readonly string[] } = {
  reducedMotion: ['static', 'off'],
  presence: ['fade', 'custom'],
}
const INCLUDE = /^\s*#\s*include\s+(?:"([^"]+)"|<([^>]+)>|([^\s;"<>]+))\s*;?\s*(\/\/.*)?$/
const DIRECTIVE = /^\s*#\s*(\w+)\s*(.*)$/
const TYPES =
  /^(void|bool|float|u?int|mat[234](x[234])?|[ibu]?vec[234]|sampler2D|samplerCube|sampler3D|sampler2DArray|[iu]sampler2D)$/
const PRECISION = new Set(['lowp', 'mediump', 'highp'])
const INTERPOLATION = ['flat', 'smooth', 'noperspective', 'centroid', 'invariant']
const INTERFACE = new Set(['uniform', 'varying', 'in', 'out', 'attribute'])
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
const CLOSING: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
/** The longest identifier or number the lexer looks for at once. */
const MAX_WORD = 256
const MAX_NUMBER = 64

/** three's own `#if` evaluation, so includes follow the branches its decoder keeps. */
const evaluateCondition = (
  GLSLDecoder.prototype as unknown as {
    evaluateCondition(expr: string, macros: Map<string, Macro>): boolean
  }
).evaluateCondition

export function prepare(source: string, options: PrepareOptions, report: Reporter): Prepared {
  const { filename } = options
  const { code, origins, includes } = expandIncludes(source, options, report)
  const lines = new LineMap(code, origins, filename)
  const tokens = lex(code)
  const text = new SourceText(code)
  const fixes = new Set<string>()

  const ids = tokens.filter((token) => token.kind === 'id')
  const used = new Set(ids.map((token) => token.text))
  const vertex = options.vertex ?? (used.has('gl_Position') || VERTEX_FILE.test(filename))
  const { pragma, version3 } = readDirectives(tokens, text, fixes, lines, report)

  const statements = tokens.filter(
    (token) => token.kind !== 'comment' && token.kind !== 'directive',
  )
  checkBrackets(statements, lines, report)
  const scanner = new Scanner({ tokens, statements, code, text, fixes, lines, vertex, report })
  scanner.run()
  const { uniforms, varyings, externals, outputs, functions } = scanner

  const functionNames = new Set(functions.map((fn) => fn.name))
  const dialect: Dialect =
    options.dialect !== 'auto'
      ? options.dialect
      : functionNames.has('mainImage')
        ? 'shadertoy'
        : version3 || outputs.length
          ? 'glsl3'
          : 'three'

  const idents: Ident[] = ids.map((token) => {
    const line = lines.lineOf(token.start)
    return { name: token.text, line, column: lines.columnOf(token.start, line) }
  })
  const find = (name: string, fn?: string): Position => {
    const range = fn ? functions.find((candidate) => candidate.name === fn) : undefined
    const root = name.split('.')[0] as string
    const inRange = (ident: Ident): boolean =>
      !range || (ident.line >= range.start && ident.line <= range.end)
    const hit =
      idents.find((ident) => ident.name === root && inRange(ident)) ??
      idents.find((ident) => ident.name === root)
    if (hit) return lines.at(hit.line, hit.column)
    if (range) return lines.at(range.start, 1)
    return { file: filename, line: 1, column: 1 }
  }

  return {
    code: text.result(),
    files: report.files,
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
    at: (line, column) => lines.at(line, column),
    find,
  }
}

// Includes

/** `#define`, `#undef` and `#if` state while includes are expanded. */
class Conditionals {
  readonly #macros = new Map<string, Macro>()
  readonly #branches: { active: boolean; taken: boolean }[] = []

  /** The current line is inside branches that are all taken. */
  get active(): boolean {
    return this.#branches.every((branch) => branch.active)
  }

  directive(name: string, text: string): void {
    const args = text
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*?\*\//g, '')
      .trim()
    const macros = this.#macros
    const branches = this.#branches
    const top = branches[branches.length - 1]
    if (name === 'define' && this.active) this.#define(args)
    else if (name === 'undef' && this.active) macros.delete(args)
    else if (name === 'ifdef' || name === 'ifndef' || name === 'if') {
      const on =
        this.active &&
        (name === 'if' ? evaluateCondition(args, macros) : macros.has(args) === (name === 'ifdef'))
      branches.push({ active: !!on, taken: !!on })
    } else if ((name === 'elif' || name === 'else') && top) {
      const parent = branches.slice(0, -1).every((branch) => branch.active)
      top.active = parent && !top.taken && (name === 'else' || !!evaluateCondition(args, macros))
      top.taken ||= top.active
    } else if (name === 'endif') branches.pop()
  }

  #define(args: string): void {
    const functionLike = /^(\w+)\((.*?)\)\s*(.*)$/.exec(args)
    const objectLike = /^(\w+)(?:\s+(.*))?$/.exec(args)
    if (functionLike) {
      const params = (functionLike[2] as string).split(',').map((param) => param.trim())
      this.#macros.set(functionLike[1] as string, {
        params: params.filter(Boolean),
        body: (functionLike[3] ?? '').trim(),
      })
    } else if (objectLike) {
      this.#macros.set(objectLike[1] as string, {
        params: null,
        body: (objectLike[2] ?? '').trim(),
      })
    }
  }
}

/**
 * Inlines `#include` files depth-first, skipping comments and the branches the decoder drops.
 * Every expanded line remembers the file and line it came from. Original lines of every file go
 * to `report.files`, for code frames.
 */
function expandIncludes(
  source: string,
  options: PrepareOptions,
  report: Reporter,
): { code: string; origins: Origin[]; includes: string[] } {
  const includes: string[] = []
  const lines: string[] = []
  const origins: Origin[] = []
  const conditionals = new Conditionals()
  const keep = (line: string, file: string, index: number): void => {
    lines.push(line)
    origins.push({ file, line: index + 1 })
  }

  const expand = (file: string, code: string, stack: readonly string[]): void => {
    const own = code.split(/\r?\n/)
    if (!report.files.has(file)) report.files.set(file, own)
    let inComment = false
    own.forEach((line, index) => {
      const directive = inComment ? null : DIRECTIVE.exec(line)
      inComment = endsInComment(line, inComment)
      if (directive) conditionals.directive(directive[1] as string, directive[2] as string)
      if (!directive || !conditionals.active) {
        keep(line, file, index)
        return
      }
      const at = { file, line: index + 1, column: Math.max(1, line.indexOf('#') + 1) }
      const include = INCLUDE.exec(line)
      if (/^\s*#\s*pragma\s+glslify\b/.test(line)) {
        report.add(
          'GLSL_GLSLIFY',
          at,
          'glslify is not supported',
          'replace `#pragma glslify: x = require(...)` with an `#include` of the file or package',
        )
      } else if (include?.[2]) {
        report.add(
          'GLSL_INCLUDE',
          at,
          `#include <${include[2]}> is a three ShaderChunk`,
          'three chunks are not converted: paste the code you need or include a file with #include "./file.glsl"',
        )
      } else if (include) {
        const spec = (include[1] ?? include[3]) as string
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
        keep(line, file, index)
        return
      }
      // A failed include leaves an empty line, so line numbers still match.
      keep('', file, index)
    })
  }

  expand(options.filename, source, [options.filename])
  return { code: lines.join('\n'), origins, includes }
}

/** Whether a line ends inside a block comment, given whether it starts in one. */
function endsInComment(line: string, inside: boolean): boolean {
  for (let index = 0; index < line.length; ) {
    if (inside) {
      const close = line.indexOf('*/', index)
      if (close < 0) return true
      inside = false
      index = close + 2
    } else if (line.startsWith('//', index)) return false
    else if (line.startsWith('/*', index)) {
      inside = true
      index += 2
    } else index++
  }
  return inside
}

/** Offsets and lines of the expanded code, and where each line came from. */
class LineMap {
  /** Offset of the first character of each line. */
  readonly #starts = [0]
  readonly #origins: readonly Origin[]
  readonly #filename: string

  constructor(code: string, origins: readonly Origin[], filename: string) {
    for (let index = 0; index < code.length; index++) {
      if (code[index] === '\n') this.#starts.push(index + 1)
    }
    this.#origins = origins
    this.#filename = filename
  }

  /** 1-based line of an offset, by binary search. */
  lineOf(offset: number): number {
    const starts = this.#starts
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((starts[middle] as number) <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }

  /** 1-based column of an offset on its line. */
  columnOf(offset: number, line: number): number {
    return offset - (this.#starts[line - 1] as number) + 1
  }

  /** Position in the original file of an expanded line and column. */
  at(line: number, column: number): Position {
    const origins = this.#origins
    const origin = origins[line - 1] ??
      origins[origins.length - 1] ?? { file: this.#filename, line }
    return { file: origin.file, line: origin.line, column }
  }

  /** Position in the original file of an offset into the expanded code. */
  positionOf(offset: number): Position {
    const line = this.lineOf(offset)
    return this.at(line, this.columnOf(offset, line))
  }
}

/** The expanded code being cleaned for the decoder. */
class SourceText {
  readonly #chars: string[]
  /** Length-changing replacements, applied last in reverse order. */
  readonly #replacements: { start: number; end: number; text: string }[] = []

  constructor(code: string) {
    this.#chars = code.split('')
  }

  /** Turns a range into spaces, keeping newlines, so no offset moves. */
  blank(start: number, end: number): void {
    for (let index = start; index < end; index++) {
      if (this.#chars[index] !== '\n') this.#chars[index] = ' '
    }
  }

  replace(start: number, end: number, text: string): void {
    this.#replacements.push({ start, end, text })
  }

  result(): string {
    const chars = this.#chars
    for (const { start, end, text } of this.#replacements.sort((a, b) => b.start - a.start)) {
      chars.splice(start, end - start, ...text)
    }
    return chars.join('')
  }
}

// Tokens

/** Small GLSL lexer with offsets. Directives and comments come out as single tokens. */
function lex(code: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let lineStart = true
  const push = (kind: Token['kind'], start: number): void => {
    tokens.push({ kind, text: code.slice(start, index), start, end: index })
  }
  while (index < code.length) {
    const char = code[index] as string
    if (char === '\n') {
      lineStart = true
      index++
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      index++
      continue
    }
    const start = index
    if (char === '#' && lineStart) {
      // A directive runs to the end of the line, across backslash continuations.
      while (index < code.length && code[index] !== '\n')
        index += code[index] === '\\' && code[index + 1] === '\n' ? 2 : 1
      push('directive', start)
      continue
    }
    lineStart = false
    if (char === '/' && code[index + 1] === '/') {
      while (index < code.length && code[index] !== '\n') index++
      push('comment', start)
      continue
    }
    if (char === '/' && code[index + 1] === '*') {
      const close = code.indexOf('*/', index + 2)
      index = close < 0 ? code.length : close + 2
      push('comment', start)
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(index, index + MAX_WORD))
    if (word) {
      index += word[0].length
      push('id', start)
      continue
    }
    const number = /^(0[xX][0-9a-fA-F]+[uU]?|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFuU]?)/.exec(
      code.slice(index, index + MAX_NUMBER),
    )
    if (number) {
      index += number[0].length
      push('num', start)
      continue
    }
    const operator = /^(<<=|>>=|\+\+|--|<<|>>|[-+*/%&|^!=<>]=|&&|\|\||\^\^|.)/.exec(
      code.slice(index, index + 3),
    )
    index += (operator as RegExpExecArray)[0].length
    push('punct', start)
  }
  return tokens
}

/**
 * Blanks `#version`, `#extension` and `#pragma` (the decoder has no use for them) and precision
 * qualifiers, reads `// @diorama` file pragmas, and reports names with a leading underscore.
 */
function readDirectives(
  tokens: readonly Token[],
  text: SourceText,
  fixes: Set<string>,
  lines: LineMap,
  report: Reporter,
): { pragma: FilePragma; version3: boolean } {
  const pragma: FilePragma = {}
  let version3 = false
  for (const token of tokens) {
    if (token.kind === 'directive') {
      const directive = /^#\s*(\w+)\s*(.*)$/.exec(token.text)
      const name = directive?.[1] ?? ''
      if (name === 'version') {
        version3 = /\b300\b/.test(directive?.[2] ?? '')
        text.blank(token.start, token.end)
      } else if (name === 'extension' || name === 'pragma') text.blank(token.start, token.end)
    } else if (token.kind === 'comment' && /^\/\/\s*@diorama\b/.test(token.text)) {
      readFilePragma(token, pragma, lines, report)
      text.blank(token.start, token.end)
    } else if (token.kind === 'id') {
      if (PRECISION.has(token.text)) {
        fixes.add('precision')
        text.blank(token.start, token.end)
      } else if (token.text.startsWith('_')) {
        report.add(
          'GLSL_SYNTAX',
          lines.positionOf(token.start),
          `name \`${token.text}\` starts with an underscore, which three's transpiler cannot read`,
          'rename it without the leading `_`',
        )
      }
    }
  }
  return { pragma, version3 }
}

/** Reads `key=value` pairs of a `// @diorama` comment into `pragma`. */
function readFilePragma(
  comment: Token,
  pragma: FilePragma,
  lines: LineMap,
  report: Reporter,
): void {
  // A quoted value may hold spaces: when="(min-width: 768px)".
  for (const [, key = '', raw = ''] of comment.text.matchAll(/(\w+)=("[^"]*"|'[^']*'|\S+)/g)) {
    const value = /^["']/.test(raw) ? raw.slice(1, -1).trim() : raw
    const allowed = CHOICES[key]
    if (allowed ? !allowed.includes(value) : key === 'when' && !value) {
      report.add(
        'GLSL_PRAGMA',
        lines.positionOf(comment.start),
        `\`${key}=${raw}\` is not a valid value`,
        allowed
          ? `use ${allowed.map((choice) => `\`${key}=${choice}\``).join(' or ')}`
          : 'use `when=hover` or a quoted media query: `when="(min-width: 768px)"`',
      )
      continue
    }
    ;(pragma as Record<string, string>)[key] = value
  }
}

/** Pragmas of a uniform's trailing comment: `// @input time`, `// @default 0.5 1`, ... */
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

/** three's decoder silently accepts some unbalanced brackets, so check them here. */
function checkBrackets(statements: readonly Token[], lines: LineMap, report: Reporter): void {
  const open: Token[] = []
  for (const token of statements) {
    if (token.text === '(' || token.text === '[' || token.text === '{') open.push(token)
    else if (CLOSING[token.text]) {
      const top = open.pop()
      if (top?.text !== CLOSING[token.text]) {
        const missing = top ? `\`${top.text}\` is not closed` : `extra \`${token.text}\``
        report.add(
          'GLSL_SYNTAX',
          lines.positionOf(token.start),
          `unbalanced bracket: ${missing}`,
          'check the brackets above this line',
        )
        return
      }
    }
  }
  const unclosed = open[0]
  if (unclosed) {
    report.add(
      'GLSL_SYNTAX',
      lines.positionOf(unclosed.start),
      `bracket \`${unclosed.text}\` is not closed`,
      'add the closing bracket',
    )
  }
}

// Statements

interface ScannerInput {
  /** Every token, comments included, for trailing pragma comments. */
  readonly tokens: readonly Token[]
  /** Tokens without comments and directives. */
  readonly statements: readonly Token[]
  readonly code: string
  readonly text: SourceText
  readonly fixes: Set<string>
  readonly lines: LineMap
  readonly vertex: boolean
  readonly report: Reporter
}

/**
 * Walks the top-level statements. Collects the interface (uniforms, varyings, outputs), function
 * prototypes and the line ranges of function definitions, and rewrites declarations three's
 * decoder would misread. Inside function bodies it only fixes bare blocks and reports arrays.
 */
class Scanner {
  readonly uniforms: UniformDecl[] = []
  readonly varyings: Decl[] = []
  readonly externals: Prototype[] = []
  readonly outputs: string[] = []
  readonly functions: Range[] = []
  readonly #input: ScannerInput
  readonly #structs = new Set<string>()

  constructor(input: ScannerInput) {
    this.#input = input
  }

  run(): void {
    const { statements } = this.#input
    let index = 0
    let depth = 0
    while (index < statements.length) {
      const token = statements[index] as Token
      if (token.text === '{') depth++
      if (token.text === '}') depth--
      if (depth !== 0 || token.text === '}' || token.text === ';') {
        this.#insideBlock(index, depth)
        index++
        continue
      }
      const end = this.#statementEnd(index)
      index = this.#statement(statements.slice(index, end + 1), end)
    }
  }

  #isType(token: Token | undefined): boolean {
    return (
      !!token && token.kind === 'id' && (TYPES.test(token.text) || this.#structs.has(token.text))
    )
  }

  /** A token inside braces. Only bare blocks and arrays in function bodies need attention. */
  #insideBlock(index: number, depth: number): void {
    const { statements, text, fixes, lines, report } = this.#input
    const token = statements[index] as Token
    const previous = statements[index - 1]
    if (depth > 1 && token.text === '{' && /^[;{}:]$/.test(previous?.text ?? '')) {
      // three's decoder reads a bare block as an array literal. `if (true)` keeps the scope.
      text.replace(token.start, token.end, 'if (true) {')
      fixes.add('block')
    }
    if (depth <= 0) return
    // three silently drops the brackets of arrays inside functions.
    const next = statements[index + 1]
    const after = statements[index + 2]
    const arrayDeclaration =
      this.#isType(token) &&
      ((next?.kind === 'id' && after?.text === '[') || next?.text === '[') &&
      previous?.text !== '.'
    if (arrayDeclaration) {
      report.add('GLSL_ARRAY', lines.positionOf(token.start), NO_ARRAYS, NO_ARRAYS_HINT)
    }
  }

  /** Index of the `;` that ends the statement at `start`, or of the `{` that opens a body. */
  #statementEnd(start: number): number {
    const { statements } = this.#input
    let index = start
    let nesting = 0
    while (index < statements.length) {
      const text = (statements[index] as Token).text
      if (text === '{' || text === '(' || text === '[') nesting++
      if (text === '}' || text === ')' || text === ']') nesting--
      if (nesting === 0 && text === ';') break
      if (nesting === 1 && text === '{' && statements[index - 1]?.text === ')') break
      index++
    }
    return index
  }

  /** Handles one top-level statement. Returns the index to continue the walk at. */
  #statement(statement: readonly Token[], endIndex: number): number {
    const { statements, text, fixes } = this.#input
    const end = statements[endIndex]
    const first = statement[0] as Token
    const words = statement.map((token) => token.text)
    const head = this.#stripQualifiers(statement, words)
    const word = words[head]
    const typeToken = statement[head]
    if (word === 'precision') {
      fixes.add('precision')
      text.blank(first.start, end?.end ?? first.end)
    } else if (word === 'struct') {
      if (statement[head + 1]) this.#structs.add((statement[head + 1] as Token).text)
    } else if (word !== undefined && INTERFACE.has(word)) {
      this.#interface(statement, head, end)
    } else if (
      this.#isType(typeToken) &&
      statement[head + 1]?.kind === 'id' &&
      statement[head + 2]?.text === '('
    ) {
      if (end?.text !== ';') {
        this.#functionDefinition(statement, head, endIndex)
        // Continue at the `{` of the body, which the walk then enters.
        return endIndex
      }
      const name = statement[head + 1] as Token
      this.externals.push({
        name: name.text,
        type: (typeToken as Token).text,
        at: this.#input.lines.positionOf(name.start),
      })
      fixes.add('prototype')
      text.blank(first.start, end.end)
    } else if (this.#isType(typeToken) || word === 'const') {
      const nameIndex = word === 'const' ? head + 2 : head + 1
      if (statement[nameIndex + 1]?.text === '[' || statement[head + 1]?.text === '[') {
        this.#input.report.add(
          'GLSL_ARRAY',
          this.#input.lines.positionOf(first.start),
          NO_ARRAYS,
          NO_ARRAYS_HINT,
        )
      }
    }
    return endIndex + 1
  }

  /**
   * Blanks layout and interpolation qualifiers. Only location 0 can be an output. Returns the
   * index of the first word after them.
   */
  #stripQualifiers(statement: readonly Token[], words: readonly string[]): number {
    const { text, lines, report } = this.#input
    const first = statement[0] as Token
    let head = 0
    if (first.text === 'layout') {
      const close = words.indexOf(')')
      const location = /location\s*=\s*(\d+)/.exec(words.slice(0, close + 1).join(' '))
      if (location && location[1] !== '0') {
        report.add(
          'GLSL_OUTPUT',
          lines.positionOf(first.start),
          `layout(location = ${location[1]}): Diorama draws a single color`,
          'keep one output at location 0',
        )
      }
      text.blank(first.start, (statement[close] as Token).end)
      head = close + 1
    }
    while (INTERPOLATION.includes(words[head] ?? '')) {
      text.blank((statement[head] as Token).start, (statement[head] as Token).end)
      head++
    }
    return head
  }

  /** `uniform`, `varying`, `in`, `out` or `attribute` declarations. */
  #interface(statement: readonly Token[], head: number, end: Token | undefined): void {
    const { text, fixes, lines, vertex, report } = this.#input
    const first = statement[0] as Token
    const keyword = (statement[head] as Token).text
    const statementEnd = end?.end ?? first.end
    const typeToken = statement
      .slice(head + 1)
      .find((token) => token.kind === 'id' && !PRECISION.has(token.text))
    const type = typeToken?.text ?? 'float'
    const declarations = declaredNames(
      statement.slice(statement.indexOf(typeToken as Token) + 1, -1),
    ).map(({ token, array }) => ({
      name: token.text,
      type,
      array,
      at: lines.positionOf(token.start),
    }))
    const kind =
      keyword === 'uniform'
        ? 'uniform'
        : keyword === 'attribute' || (keyword === 'in' && vertex)
          ? 'attribute'
          : keyword === 'out' && !vertex
            ? 'output'
            : 'varying'

    if (kind === 'uniform' && declarations.every((decl) => THREE_UNIFORMS.has(decl.name))) {
      // Copied from a RawShaderMaterial. These matrices are built-ins here.
      text.blank(first.start, statementEnd)
      return
    }
    if (kind === 'attribute') {
      for (const decl of declarations) {
        if (ATTRIBUTES.has(decl.name)) continue
        report.add(
          'GLSL_VERTEX',
          decl.at,
          `attribute \`${decl.name}\`: a Diorama plane has only position, uv and normal`,
          'compute the value from position or uv',
        )
      }
      text.blank(first.start, statementEnd)
      return
    }
    if (kind === 'output') {
      this.#output(statement)
      fixes.add('glsl3')
      text.blank(first.start, statementEnd)
      return
    }
    if (kind === 'uniform') {
      const comment = this.#trailingComment(statementEnd)
      const pragmas = comment ? readPragmas(comment.text) : { keys: new Set<string>() }
      if (comment && pragmas.keys.size) text.blank(comment.start, comment.end)
      for (const decl of declarations) this.uniforms.push({ ...decl, pragmas })
    } else this.varyings.push(...declarations)
    if (declarations.length > 1 || keyword === 'in' || keyword === 'out') {
      fixes.add(keyword === 'in' || keyword === 'out' ? 'glsl3' : 'split-interface')
      // three reads only the first name of a declaration, so split them.
      const storage = kind === 'uniform' ? 'uniform' : 'varying'
      const split = declarations
        .map((decl) => `${storage} ${type} ${decl.name}${decl.array ? '[1]' : ''};`)
        .join(' ')
      text.replace((statement[head] as Token).start, statementEnd, split)
    }
  }

  /** A GLSL 3 fragment output. Diorama draws one colour. */
  #output(statement: readonly Token[]): void {
    const name = statement[statement.length - 2]
    if (!name) return
    if (this.outputs.length) {
      this.#input.report.add(
        'GLSL_OUTPUT',
        this.#input.lines.positionOf(name.start),
        `second output \`${name.text}\`: Diorama draws a single color`,
        'keep one `out vec4`',
      )
    }
    this.outputs.push(name.text)
  }

  /** Records the line range of a function definition and blanks a `(void)` parameter list. */
  #functionDefinition(statement: readonly Token[], head: number, bodyStart: number): void {
    const { statements, code, text, lines } = this.#input
    let depth = 0
    let close = bodyStart
    for (; close < statements.length; close++) {
      const token = (statements[close] as Token).text
      if (token === '{') depth++
      if (token === '}' && --depth === 0) break
    }
    this.functions.push({
      name: (statement[head + 1] as Token).text,
      start: lines.lineOf((statement[0] as Token).start),
      end: lines.lineOf((statements[close] as Token | undefined)?.start ?? code.length),
    })
    const param = statement[head + 3]
    if (param?.text === 'void' && statement[head + 4]?.text === ')') {
      text.blank(param.start, param.end)
    }
  }

  /** A comment that starts on the line where the statement ends. */
  #trailingComment(end: number): Token | undefined {
    const { tokens, lines } = this.#input
    const line = lines.lineOf(end)
    return tokens.find(
      (token) =>
        token.kind === 'comment' && token.start >= end && lines.lineOf(token.start) === line,
    )
  }
}

/** Names of an interface declaration, each maybe with `[N]`. GLSL allows no initialisers here. */
function declaredNames(rest: readonly Token[]): { token: Token; array: boolean }[] {
  const names: { token: Token; array: boolean }[] = []
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] as Token
    if (token.text === '=') break
    if (token.kind === 'id') names.push({ token, array: rest[index + 1]?.text === '[' })
    if (token.text === '[') {
      while (index < rest.length && (rest[index] as Token).text !== ']') index++
    }
  }
  return names
}
