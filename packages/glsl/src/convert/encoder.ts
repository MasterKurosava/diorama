import TSLEncoderBase from 'three/addons/transpiler/TSLEncoder.js'
import * as TSL from 'three/tsl'
import { UV_VARYINGS } from '../names'
import type { Ast } from './ast'

interface EncoderBase {
  tab: string
  imports: Set<string>
  global: Set<string>
  overloadings: Map<string, Ast[]>
  iife: boolean
  emitExpression(node: Ast, output?: string | null): string
  emitVariables(node: Ast, isRoot?: boolean): string
  emitFunction(node: Ast): string
  emitComment(statement: Ast, body: Ast[]): string
  emitExtraLine(statement: Ast, body: Ast[]): string
}
const Base = TSLEncoderBase as unknown as new () => EncoderBase
const tsl = TSL as unknown as Record<string, unknown>

/** three's TSL encoder, writing the body of `build($)`. */
class DioramaEncoder extends Base {
  constructor(declared: Iterable<string>) {
    super()
    this.iife = true
    for (const name of declared) this.global.add(name)
  }

  addImport(name: string): void {
    const root = name.split('.')[0] as string
    if (tsl[root] !== undefined && !this.global.has(root)) this.imports.add(root)
  }

  emitUniform(node: Ast): string {
    return `const ${node.name} = $.uniforms.${node.glslName ?? node.name}`
  }

  emitVarying(node: Ast): string {
    const glsl = node.glslName ?? node.name
    const source = UV_VARYINGS.has(glsl) && node.type === 'vec2' ? '$.uv' : `$.varyings.${glsl}`
    return `const ${node.name} = ${source}`
  }

  override emitExpression(node: Ast, output: string | null = null): string {
    // r187 writes `- 1.0`, which is not a primitive: `- 1.0.mul( a )` fails at runtime.
    if (node.isUnary && node.type === '-' && node.expression.isNumber) {
      const n = node.expression
      if (n.type === 'float') return `-${n.value}`
      this.addImport(n.type)
      return `${n.type}( -${n.value} )`
    }
    if (node.isNumber && node.type === 'bool') {
      this.addImport('bool')
      return `bool( ${node.value} )`
    }
    return super.emitExpression(node, output)
  }

  override emitVariables(node: Ast, isRoot = true): string {
    const code = super.emitVariables(node, isRoot)
    return node.needsToConst && !node.needsToVar ? `${code}.toConst()` : code
  }

  /** The program's statements without three's module header. */
  emitProgram(ast: Ast): string {
    let code = ''
    for (const statement of ast.body) {
      if (!statement.isFunctionDeclaration) continue
      const list = this.overloadings.get(statement.name) ?? []
      list.push(statement)
      this.overloadings.set(statement.name, list)
    }
    for (const statement of ast.body) {
      code += this.emitExtraLine(statement, ast.body)
      if (statement.isComment) {
        code += this.emitComment(statement, ast.body)
        continue
      }
      code += statement.isFunctionDeclaration
        ? this.tab + this.emitFunction(statement)
        : `${this.tab + this.emitExpression(statement)};\n`
    }
    return code
  }
}

export interface Encoded {
  readonly body: string
  readonly imports: readonly string[]
}

/** Emits the TSL statements of a checked program, indented with two spaces. */
export function encode(program: Ast, declared: Iterable<string>): Encoded {
  const encoder = new DioramaEncoder(declared)
  const raw = encoder.emitProgram(program)
  const lines = raw
    .replace(/\/\*@__PURE__\*\/ /g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(/^\t+/, (tabs) => '  '.repeat(tabs.length)))
  const out: string[] = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    if (line === '' && (prev === undefined || prev === '' || prev.endsWith('{'))) continue
    if (/^\s*}/.test(line) && prev === '') out.pop()
    out.push(line)
  }
  while (out[out.length - 1] === '') out.pop()
  return { body: out.join('\n'), imports: [...encoder.imports].sort() }
}
