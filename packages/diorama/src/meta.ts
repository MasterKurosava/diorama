// Reads what the light part must know before an effect module loads: literal param defaults,
// `when` and `reducedMotion`. A small lexer and parser, no dependencies, never runs the file.
// What it cannot read stays out: the key's accessor then appears once the module has loaded.

/** Metadata of a registry entry. */
export interface Meta {
  readonly params?: { readonly [name: string]: unknown }
  readonly when?: string
  readonly reducedMotion?: 'static' | 'off'
  readonly presence?: 'fade' | 'custom'
  /** `export const override = true`: the file replaces a built-in effect on purpose. */
  readonly override?: true
  /**
   * `export const intro = true`, or the source of its function of the element, plain JS the
   * registry inlines: an element in view at mount stays veiled until the effect draws it.
   */
  readonly intro?: true | string
}

type Kind = 'id' | 'str' | 'num' | 'punct'
interface Token {
  readonly kind: Kind
  readonly text: string
  /** Its span in the code, set by `lex`. */
  readonly at?: number
  readonly end?: number
}

/** Colour strings `effect()` turns into colour params. Mirrors CSS_COLOR of @dioramajs/effects. */
const CSS_COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\(.*)$/i
const UNKNOWN = Symbol('unknown')
type Value = unknown

/** Tokens of the code: identifiers, strings, numbers and single punctuation characters. */
function lex(code: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i] as string
    const at = i
    const count = tokens.length
    if (/\s/.test(c)) i++
    else if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === '"' || c === "'") {
      let text = ''
      i++
      while (i < n && code[i] !== c) {
        if (code[i] === '\\') {
          const escaped = code[i + 1] as string
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
          i += 2
        } else text += code[i++]
      }
      i++
      tokens.push({ kind: 'str', text })
    } else if (c === '`') {
      // A template without substitutions is a string. With them it is not a literal.
      let text = ''
      let plain = true
      let depth = 0
      i++
      while (i < n && (code[i] !== '`' || depth > 0)) {
        if (code[i] === '\\') i += 2
        else if (code[i] === '$' && code[i + 1] === '{') {
          plain = false
          depth++
          i += 2
        } else {
          if (depth > 0 && code[i] === '}') depth--
          else if (depth === 0) text += code[i]
          i++
        }
      }
      i++
      tokens.push(plain ? { kind: 'str', text } : { kind: 'id', text: '`' })
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
      const match = /^(0[xob][0-9a-f_]+|[0-9_]*\.?[0-9_]*(e[+-]?[0-9_]+)?)/i.exec(code.slice(i))
      const text = match?.[0] || c
      tokens.push({ kind: 'num', text })
      i += text.length
    } else if (/[A-Za-z_$]/.test(c)) {
      const text = /^[\w$]+/.exec(code.slice(i))?.[0] as string
      tokens.push({ kind: 'id', text })
      i += text.length
    } else {
      tokens.push({ kind: 'punct', text: c })
      i++
    }
    const token = tokens[count]
    if (token) tokens[count] = { ...token, at, end: i }
  }
  return tokens
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSE = new Set([')', ']', '}'])

/** Reads literal values from the tokens, starting at a token index. */
class Parser {
  readonly tokens: Token[]
  /** The current token's index. */
  at: number

  constructor(tokens: Token[], at: number) {
    this.tokens = tokens
    this.at = at
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset]
  }

  is(text: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token?.kind === 'punct' && token.text === text
  }

  /** Skips to the next `,` or closer at this depth. */
  skip(): typeof UNKNOWN {
    let depth = 0
    for (let token = this.peek(); token; token = this.peek()) {
      if (token.kind === 'punct') {
        if (depth === 0 && (token.text === ',' || CLOSE.has(token.text))) break
        if (OPEN[token.text]) depth++
        else if (CLOSE.has(token.text)) depth--
      }
      this.at++
    }
    return UNKNOWN
  }

  /** A literal, or UNKNOWN with the expression skipped. */
  value(): Value {
    const start = this.at
    const result = this.literal()
    // `{ … } as const` and `satisfies` keep the literal; anything else after it does not.
    if (result !== UNKNOWN && this.peek()?.kind === 'id') {
      const word = this.peek()?.text
      if (word === 'as' || word === 'satisfies') {
        this.at++
        this.skip()
        return result
      }
    }
    if (result === UNKNOWN || !(this.is(',') || CLOSE.has(this.peek()?.text ?? ''))) {
      this.at = start
      return this.skip()
    }
    return result
  }

  literal(): Value {
    const token = this.peek()
    if (!token) return UNKNOWN
    if (token.kind === 'str') {
      this.at++
      return token.text
    }
    if (token.kind === 'num' || (this.is('-') && this.peek(1)?.kind === 'num')) {
      const sign = token.kind === 'num' ? 1 : -1
      if (sign < 0) this.at++
      const text = (this.peek()?.text ?? '').replace(/_/g, '')
      this.at++
      const number = sign * Number(text)
      return Number.isFinite(number) ? number : UNKNOWN
    }
    if (token.kind === 'id') {
      if (token.text === 'true' || token.text === 'false') {
        this.at++
        return token.text === 'true'
      }
      if (/^(color|oneOf|text)$/.test(token.text) && this.is('(', 1)) {
        this.at += 2
        const args = this.list(')')
        if (args === UNKNOWN || !(args as Value[]).every((a) => typeof a === 'string'))
          return UNKNOWN
        const strings = args as string[]
        if (token.text === 'oneOf')
          return strings.length ? { '~kind': 'choice', values: strings } : UNKNOWN
        if (strings.length !== 1) return UNKNOWN
        return token.text === 'color'
          ? { '~kind': 'color', value: strings[0] }
          : { '~kind': 'string', value: strings[0] }
      }
      return UNKNOWN
    }
    if (this.is('[')) {
      this.at++
      return this.list(']')
    }
    if (this.is('{')) {
      this.at++
      return this.object()
    }
    return UNKNOWN
  }

  /** Comma-separated values up to `close`. Any unknown item makes the list unknown. */
  list(close: string): Value[] | typeof UNKNOWN {
    const out: Value[] = []
    let known = true
    while (this.peek() && !this.is(close)) {
      const item = this.value()
      if (item === UNKNOWN) known = false
      out.push(item)
      if (this.is(',')) this.at++
      else if (!this.is(close)) return this.skip()
    }
    this.at++
    return known ? out : UNKNOWN
  }

  /** An object with the keys whose values are literals. Unknown values are left out. */
  object(): Record<string, Value> | typeof UNKNOWN {
    const out: Record<string, Value> = {}
    while (this.peek() && !this.is('}')) {
      const key = this.peek()
      if ((key?.kind === 'id' || key?.kind === 'str') && this.is(':', 1)) {
        this.at += 2
        const item = this.value()
        if (item !== UNKNOWN) out[key.text] = item
      } else this.skip()
      if (this.is(',')) this.at++
      else if (!this.is('}')) return UNKNOWN
    }
    this.at++
    return out
  }

  /** Arguments of a call whose `(` is the current token. */
  args(): Value[] {
    this.at++
    const out: Value[] = []
    while (this.peek() && !this.is(')')) {
      out.push(this.value())
      if (this.is(',')) this.at++
      else if (!this.is(')')) break
    }
    return out
  }
}

const isRecord = (v: Value): v is Record<string, Value> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A param default `defineEffect` accepts, with `text()` unwrapped as it does. */
function param(v: Value, colors: boolean): Value {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return colors && CSS_COLOR.test(v) ? { '~kind': 'color', value: v } : v
  if (Array.isArray(v))
    return v.length >= 2 && v.length <= 4 && v.every((n) => typeof n === 'number') ? v : UNKNOWN
  if (isRecord(v)) return v['~kind'] === 'string' ? v.value : v
  return UNKNOWN
}

/**
 * Meta from the params and options objects of a definition. `colors` reads CSS colour strings
 * as colour params, as `effect()` does.
 */
function meta(params: Value, options: Value, colors: boolean): Meta | undefined {
  const out: {
    params?: Record<string, Value>
    when?: string
    reducedMotion?: 'static' | 'off'
    presence?: 'fade' | 'custom'
  } = {}
  if (isRecord(params)) {
    const known = Object.entries(params)
      .map(([k, v]) => [k, param(v, colors)] as const)
      .filter(([, v]) => v !== UNKNOWN)
    if (known.length) out.params = Object.fromEntries(known)
  }
  if (isRecord(options)) {
    if (typeof options.when === 'string') out.when = options.when
    const motion = options.reducedMotion
    if (motion === 'static' || motion === 'off') out.reducedMotion = motion
    const presence = options.presence
    if (presence === 'fade' || presence === 'custom') out.presence = presence
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The metadata of an effect module's default export, if it is an `effect()` or `defineEffect()`,
 * and its `export const override = true`.
 */
export function readMeta(code: string): Meta | undefined {
  let tokens: Token[]
  try {
    tokens = lex(code)
  } catch {
    return undefined
  }
  const found = definition(tokens)
  const at = tokens.findIndex(
    (t, i) =>
      t.kind === 'id' &&
      t.text === 'export' &&
      tokens[i + 1]?.text === 'const' &&
      tokens[i + 2]?.text === 'override' &&
      tokens[i + 3]?.text === '=' &&
      tokens[i + 4]?.text === 'true',
  )
  const intro = introOf(code, tokens)
  const meta = {
    ...found,
    ...(at >= 0 ? { override: true as const } : {}),
    ...(intro ? { intro } : {}),
  }
  return Object.keys(meta).length ? meta : undefined
}

/** Words that start the statement after an initializer. */
const STATEMENT = new Set([
  'export',
  'const',
  'let',
  'var',
  'import',
  'function',
  'class',
  'declare',
])

/**
 * `export const intro`: `true`, or the source of an arrow or function expression without type
 * annotations, which the registry can inline. Anything else is left to the module.
 */
function introOf(code: string, tokens: Token[]): true | string | undefined {
  const is = (k: number, text: string): boolean => tokens[k]?.text === text
  const start = tokens.findIndex(
    (t, k) => t.kind === 'id' && t.text === 'export' && is(k + 1, 'const') && is(k + 2, 'intro'),
  )
  if (start < 0) return undefined
  // Past a type annotation, whose arrows are `=` and `>`, to the initializer.
  let equals = start + 3
  for (let depth = 0; equals < tokens.length; equals++) {
    const token = tokens[equals] as Token
    if (token.kind !== 'punct') continue
    if (token.text in OPEN) depth++
    else if (CLOSE.has(token.text)) depth--
    else if (token.text === '=' && depth === 0 && !is(equals + 1, '>')) break
  }
  // The initializer runs to a `;`, the next statement or the closer of what holds it.
  const first = equals + 1
  let last = first
  for (let depth = 0, k = first; k < tokens.length; k++) {
    const token = tokens[k] as Token
    if (
      depth === 0 &&
      k > first &&
      (token.text === ';' || (token.kind === 'id' && STATEMENT.has(token.text) && !is(k - 1, '.')))
    )
      break
    if (token.kind === 'punct' && token.text in OPEN) depth++
    else if (token.kind === 'punct' && CLOSE.has(token.text) && --depth < 0) break
    last = k
  }
  if (is(first, 'true') && last === first) return true
  // The parameters: `x =>`, `(x) =>` or `function (x) {`, none of them typed.
  let head = first
  if (is(head, 'function')) head++
  if (tokens[head]?.kind === 'id' && is(first, 'function')) head++
  if (tokens[head]?.kind === 'id' && is(head + 1, '=') && is(head + 2, '>'))
    return slice(code, tokens, first, last)
  if (!is(head, '(')) return undefined
  let close = head
  for (let depth = 0; close <= last; close++) {
    if (is(close, '(')) depth++
    else if (is(close, ')') && --depth === 0) break
    else if (is(close, ':') && depth === 1) return undefined
  }
  const arrow = is(close + 1, '=') && is(close + 2, '>')
  return arrow || (is(first, 'function') && is(close + 1, '{'))
    ? slice(code, tokens, first, last)
    : undefined
}

const slice = (code: string, tokens: Token[], first: number, last: number): string =>
  code.slice(tokens[first]?.at, tokens[last]?.end)

/** Meta of the `effect()` or `defineEffect()` call the module exports as default. */
function definition(tokens: Token[]): Meta | undefined {
  const word = (i: number, text: string): boolean =>
    tokens[i]?.kind === 'id' && tokens[i]?.text === text
  const punct = (i: number, text: string): boolean =>
    tokens[i]?.kind === 'punct' && tokens[i]?.text === text
  let at = -1
  let binding: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    if (word(i, 'export') && word(i + 1, 'default')) {
      at = i + 2
      // `export default x` names a binding unless a call follows.
      if (tokens[at]?.kind === 'id' && !punct(at + 1, '(') && !punct(at + 1, '<'))
        binding = tokens[at]?.text
      break
    }
    // export { x as default }
    if (word(i, 'as') && word(i + 1, 'default') && tokens[i - 1]?.kind === 'id') {
      binding = tokens[i - 1]?.text
      break
    }
  }
  if (binding) {
    at = -1
    for (let i = 0; i < tokens.length - 2; i++) {
      if ((word(i, 'const') || word(i, 'let')) && word(i + 1, binding) && punct(i + 2, '=')) {
        at = i + 3
        break
      }
    }
  }
  if (at < 0) return undefined
  const callee = tokens[at]
  if (callee?.kind !== 'id' || !punct(at + 1, '(')) return undefined
  const parser = new Parser(tokens, at + 1)
  if (callee.text === 'effect') {
    const args = parser.args()
    if (args.length === 2) return meta(args[0], undefined, true)
    if (args.length === 3) return meta(args[0], args[1], true)
    return undefined
  }
  if (callee.text === 'defineEffect') {
    const [def] = parser.args()
    return isRecord(def) ? meta(def.params, def, false) : undefined
  }
  return undefined
}

const IDENT = /^[A-Za-z_$][\w$]*$/
const quoted = (s: string): string =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

/** A JS literal on one line, in the generated files' style. */
export function literal(value: unknown): string {
  if (typeof value === 'string') return quoted(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return '{}'
  const key = (k: string): string => (IDENT.test(k) ? k : quoted(k))
  return `{ ${entries.map(([k, v]) => `${key(k)}: ${literal(v)}`).join(', ')} }`
}

/** The entry fields besides `load`: `params: {…}`, `when: '…'`. */
export function fields(data: Meta | undefined): string[] {
  const out: string[] = []
  if (data?.params) out.push(`params: ${literal(data.params)}`)
  if (data?.when !== undefined) out.push(`when: ${quoted(data.when)}`)
  if (data?.reducedMotion) out.push(`reducedMotion: ${quoted(data.reducedMotion)}`)
  if (data?.presence) out.push(`presence: ${quoted(data.presence)}`)
  if (data?.override) out.push('override: true')
  if (data?.intro) out.push(`intro: ${data.intro}`)
  return out
}

/** A registry entry: the bare loader, or the loader with its metadata. */
export const entry = (load: string, data: Meta | undefined): string =>
  data ? `{ ${[`load: ${load}`, ...fields(data)].join(', ')} }` : load

/** The params' type, widened like `WidenSpec`, for `Effect<…>` in declarations. */
export function paramsType(params: { readonly [name: string]: unknown } | undefined): string {
  const entries = Object.entries(params ?? {})
  // The `Empty` of defineEffect, spelled so: Biome bans `{}` in the site's generated file.
  if (!entries.length) return 'Record<never, never>'
  const type = (v: unknown): string => {
    if (typeof v === 'number') return 'number'
    if (typeof v === 'boolean') return 'boolean'
    if (typeof v === 'string') return 'string'
    if (Array.isArray(v)) return `readonly [${v.map(() => 'number').join(', ')}]`
    const kind = (v as { '~kind'?: string })['~kind']
    if (kind === 'choice')
      return `import('@dioramajs/diorama').ChoiceParam<${(v as { values: string[] }).values.map(quoted).join(' | ')}>`
    return "import('@dioramajs/diorama').ColorParam"
  }
  const key = (k: string): string => (IDENT.test(k) ? k : quoted(k))
  return `{ ${entries.map(([k, v]) => `${key(k)}: ${type(v)}`).join('; ')} }`
}
