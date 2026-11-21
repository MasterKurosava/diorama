import GLSLDecoderBase from 'three/addons/transpiler/GLSLDecoder.js'
import type { Ast } from './ast'
import { PORT_BY_HAND, type Reporter } from './errors'
import type { Prepared } from './prepare'

interface Token {
  readonly str: string
  readonly pos: number
}
interface DecoderBase {
  keywords: { name: string; polyfill: string }[]
  index: number
  tokenizer: { readonly source: string; readonly position: number; readonly tokens: Token[] } | null
  parse(source: string): Ast
}

const Base = GLSLDecoderBase as unknown as new () => DecoderBase

/** three's decoder minus its polyfills. Diorama binds the built-ins itself. */
class DioramaDecoder extends Base {
  constructor() {
    super()
    this.keywords = []
  }
}

const POSITION = /\(line (\d+), column (\d+)\)/

/** Decoder failures become GLSL_SYNTAX at the original source position. */
export function decode(prepared: Prepared, report: Reporter): Ast | undefined {
  const decoder = new DioramaDecoder()
  const at = (offset: number): { line: number; column: number } => {
    const before = (decoder.tokenizer?.source ?? prepared.code).slice(0, offset).split('\n')
    return { line: before.length, column: (before[before.length - 1] as string).length + 1 }
  }
  const hint = `a limitation of three's transpiler: ${PORT_BY_HAND}`
  try {
    const program = decoder.parse(prepared.code)
    const tokenizer = decoder.tokenizer
    // The tokenizer stops silently at a character it does not know.
    if (tokenizer?.source.slice(tokenizer.position).trim()) {
      const position = at(tokenizer.position)
      const char = tokenizer.source.slice(tokenizer.position).trim()[0]
      report.add(
        'GLSL_SYNTAX',
        prepared.at(position.line, position.column),
        `unexpected character \`${char}\``,
        hint,
      )
      return undefined
    }
    return program
  } catch (error) {
    const message = String((error as Error)?.message ?? error)
    const match = POSITION.exec(message)
    const token = decoder.tokenizer?.tokens[Math.max(0, decoder.index - 1)]
    const position = match
      ? { line: Number(match[1]), column: Number(match[2]) }
      : at(token?.pos ?? 0)
    const text = message
      .replace(POSITION, '')
      .replace(/^THREE\.GLSLDecoder:\s*/, '')
      .trim()
    report.add(
      'GLSL_SYNTAX',
      prepared.at(position.line, position.column),
      text || 'syntax error',
      hint,
    )
    return undefined
  }
}
