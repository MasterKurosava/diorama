// Types for three r187's transpiler AST. @types/three 0.187 declares only part of it.
import * as ThreeAst from 'three/addons/transpiler/AST.js'

export interface Linked {
  reference: Ast | null
  accesses: Ast[]
  assignments: Ast[]
}

/** One loose shape for every node class in `AST.js`. The `is*` flags tell them apart. */
export interface Ast {
  readonly isASTNode: true
  parent: Ast | null
  linker: Linked
  isProgram?: true
  isComment?: true
  isVariableDeclaration?: true
  isUniform?: true
  isVarying?: true
  isFunctionParameter?: true
  isFunctionDeclaration?: true
  isTernary?: true
  isOperator?: true
  isUnary?: true
  isNumber?: true
  isString?: true
  isConditional?: true
  isFunctionCall?: true
  isReturn?: true
  isDiscard?: true
  isContinue?: true
  isBreak?: true
  isAccessor?: true
  isStaticElement?: true
  isDynamicElement?: true
  isAccessorElements?: true
  isFor?: true
  isWhile?: true
  isSwitch?: true
  isSwitchCase?: true
  isStructDefinition?: true
  readonly isAssignment?: boolean

  body: Ast[]
  type: string
  name: string
  value: Ast | null
  next: Ast | null
  immutable: boolean
  qualifier: string | null
  params: Ast[]
  left: Ast
  right: Ast
  expression: Ast
  after: boolean
  cond: Ast | null
  elseConditional: Ast | null
  property: string
  object: Ast
  elements: Ast[]
  initialization: Ast | null
  condition: Ast | null
  afterthought: Ast | null
  discriminant: Ast
  cases: Ast[]
  conditions: Ast[] | null
  comment: string
  members: { type: string; name: string }[]
  structTypes: Map<string, Ast>

  // Set by the converter.
  needsToVar?: boolean
  /** Materialise the declaration with `.toConst()` where it stands. */
  needsToConst?: boolean
  layout?: boolean
  /** GLSL name of a uniform or varying whose JS name changed. */
  glslName?: string
}

type Make<A extends unknown[]> = new (...args: A) => Ast
interface AstClasses {
  VariableDeclaration: Make<
    [type: string, name: string, value?: Ast | null, next?: Ast | null, immutable?: boolean]
  >
  Uniform: Make<[type: string, name: string]>
  Accessor: Make<[property: string]>
  FunctionCall: Make<[name: string, params?: Ast[]]>
  Number: Make<[value: string, type?: string]>
  Operator: Make<[type: string, left: Ast, right: Ast]>
  Unary: Make<[type: string, expression: Ast, after?: boolean]>
  While: Make<[condition: Ast, body?: Ast[]]>
  Return: Make<[value: Ast | null]>
  Conditional: Make<[cond?: Ast | null, body?: Ast[]]>
}
export const AST: AstClasses = ThreeAst as unknown as AstClasses

const SKIP = new Set(['parent', 'linker'])
/** Child nodes in field order. */
export function children(node: Ast): Ast[] {
  const out: Ast[] = []
  for (const key in node) {
    if (SKIP.has(key)) continue
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) if ((item as Ast | null)?.isASTNode) out.push(item as Ast)
    } else if ((value as Ast | null)?.isASTNode) out.push(value as Ast)
  }
  return out
}

/** Visits every node, parents first. */
export function walk(node: Ast, visit: (node: Ast) => void): void {
  visit(node)
  for (const child of children(node)) walk(child, visit)
}

/** The accessor a write lands on: `a` for `a`, `a.x` and `a[i].y`. */
export function rootOf(node: Ast | null | undefined): Ast | undefined {
  if (!node) return undefined
  if (node.isAccessor) return node
  if (node.isAccessorElements) return rootOf(node.object)
  return undefined
}

export const rootName = (accessor: Ast): string => accessor.property.split('.')[0] as string

export const ownerFn = (node: Ast): string | undefined => {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent)
    if (ancestor.isFunctionDeclaration) return ancestor.name
  return undefined
}

/** Replaces the root name of an accessor, keeping the swizzle. */
export function renameRoot(accessor: Ast, name: string): void {
  const dot = accessor.property.indexOf('.')
  accessor.property = dot < 0 ? name : name + accessor.property.slice(dot)
}

/** Restores parent links after edits. */
export function relink(node: Ast): void {
  for (const child of children(node)) {
    child.parent = node
    relink(child)
  }
}
