// GLSL semantics that three's encoder or TSL r187 lose without an error: literal arithmetic,
// matrix literals, loops, ++/--, vector equality, overloads, struct members, lazy locals.
import { AST, type Ast, children, ownerFn, walk } from './ast'
import type { Position, Reporter } from './errors'

export type Where = (name: string, fn?: string) => Position

/** Rewrites the tree bottom-up. `fn` returns a replacement node, or nothing to keep it. */
export function rewrite(node: Ast, fn: (n: Ast) => Ast | undefined): void {
  const record = node as unknown as Record<string, unknown>
  const visit = (child: Ast): Ast => {
    rewrite(child, fn)
    const next = fn(child)
    if (!next) return child
    next.parent = node
    return next
  }
  for (const key of Object.keys(record)) {
    if (key === 'parent' || key === 'linker') continue
    const value = record[key]
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++)
        if ((value[i] as Ast | null)?.isASTNode) value[i] = visit(value[i] as Ast)
    } else if ((value as Ast | null)?.isASTNode) record[key] = visit(value as Ast)
  }
}

/** Every body array in the tree, with the node that owns it. */
export function bodies(root: Ast, visit: (body: Ast[], owner: Ast) => void): void {
  walk(root, (n) => {
    if (Array.isArray(n.body)) visit(n.body, n)
  })
}

interface NumberLiteral {
  readonly value: number
  readonly type: 'int' | 'float'
}
function numberLiteral(e: Ast | null | undefined): NumberLiteral | undefined {
  if (e?.isNumber && (e.type === 'int' || e.type === 'float')) {
    const value = Number(String(e.value).replace(/[fF]$/, ''))
    return Number.isFinite(value) ? { value, type: e.type } : undefined
  }
  if (e?.isUnary && e.type === '-') {
    const inner = numberLiteral(e.expression)
    return inner && { value: -inner.value, type: inner.type }
  }
  return undefined
}

function numberNode({ value, type }: NumberLiteral): Ast {
  const text = String(Math.abs(value))
  const n = new AST.Number(type === 'float' && /^\d+$/.test(text) ? `${text}.0` : text, type)
  return value < 0 ? new AST.Unary('-', n) : n
}

const ARITHMETIC: Record<string, (a: number, b: number, int: boolean) => number | undefined> = {
  '+': (a, b, int) => (int ? (a + b) | 0 : a + b),
  '-': (a, b, int) => (int ? (a - b) | 0 : a - b),
  '*': (a, b, int) => (int ? Math.imul(a, b) : a * b),
  '/': (a, b, int) => (int ? (b === 0 ? undefined : Math.trunc(a / b)) : a / b),
  '%': (a, b, int) => (int && b !== 0 ? a % b : undefined),
}

/**
 * three emits literal arithmetic as JS, where `7 / 2` gives 3.5, so fold anything with an int.
 * Float-only arithmetic can stay JS. The doubles match and `1.0 / 289.0` reads better.
 */
function foldLiteral(n: Ast): Ast | undefined {
  if (!n.isOperator) return undefined
  const op = ARITHMETIC[n.type]
  const a = numberLiteral(n.left)
  const b = numberLiteral(n.right)
  if (!op || !a || !b || (a.type === 'float' && b.type === 'float')) return undefined
  const int = a.type === 'int' && b.type === 'int'
  const value = op(a.value, b.value, int)
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : numberNode({ value, type: int ? 'int' : 'float' })
}

/** `matN` of literals: TSL builds it with three's row-major `set`, so it comes out transposed. */
function matrixLiteral(n: Ast): Ast | undefined {
  const m = n.isFunctionCall ? /^mat([234])$/.exec(n.name) : null
  if (!m) return undefined
  const size = Number(m[1])
  const values = n.params.map(numberLiteral)
  if (!values.length || !values.every(Boolean)) return undefined
  if (values.length !== 1 && values.length !== size * size) return undefined
  const zero: NumberLiteral = { value: 0, type: 'float' }
  const at = (col: number, row: number): NumberLiteral => {
    const v = values.length === 1 ? (col === row ? values[0] : zero) : values[col * size + row]
    return { value: (v as NumberLiteral).value, type: 'float' }
  }
  const columns = Array.from(
    { length: size },
    (_, col) =>
      new AST.FunctionCall(
        `vec${size}`,
        Array.from({ length: size }, (_, row) => numberNode(at(col, row))),
      ),
  )
  return new AST.FunctionCall(n.name, columns)
}

/** A `for` that three can emit as `Loop({ start, end })`. */
export function simpleLoop(f: Ast): boolean {
  const init = f.initialization
  const cond = f.condition
  const after = f.afterthought
  return (
    !!init?.isVariableDeclaration &&
    init.next === null &&
    !!cond?.left?.isAccessor &&
    cond.left.property === init.name &&
    !!after &&
    ((!!after.isUnary && after.expression?.property === init.name) ||
      (!!after.isOperator && after.left?.property === init.name))
  )
}

/** Whether the body continues this loop, not a nested one. */
function continues(body: readonly Ast[]): boolean {
  const own = (n: Ast): boolean =>
    !!n.isContinue || (!n.isFor && !n.isWhile && children(n).some(own))
  return body.some(own)
}

const isStep = (n: Ast | null | undefined): n is Ast =>
  !!n?.isUnary && (n.type === '++' || n.type === '--')
/** `x++` as a statement: TSL's increment() returns a value and never reaches the stack. */
const step = (n: Ast): Ast =>
  new AST.Operator(n.type === '++' ? '+=' : '-=', n.expression, new AST.Number('1', 'int'))

/**
 * Tree rewrites before linking: literal arithmetic, matrix literals, `for` loops three can't
 * emit, and `++`/`--` statements.
 */
export function syntax(program: Ast, report: Reporter, where: Where): Set<string> {
  const fixes = new Set<string>()
  rewrite(program, (n) => {
    const next = foldLiteral(n) ?? matrixLiteral(n)
    if (next) fixes.add(n.isOperator ? 'int-literal' : 'matrix')
    return next
  })

  bodies(program, (body) => {
    for (let i = 0; i < body.length; i++) {
      const s = body[i] as Ast
      if (!s.isFor) continue
      const fn = ownerFn(s)
      if (!s.condition) s.condition = new AST.Number('true', 'bool')
      if (simpleLoop(s)) continue
      if (s.initialization?.next) {
        report.add(
          'GLSL_TRANSPILER',
          where(s.initialization.next.name, fn),
          'several variables in a `for` header',
          'declare the second variable before the loop',
        )
      }
      if (s.afterthought && continues(s.body)) {
        report.add(
          'GLSL_TRANSPILER',
          where('continue', fn),
          '`continue` in a `for` loop that TSL emits as while: the loop step is skipped',
          'write the loop as `for (int i = 0; i < N; i++)` or replace continue with if',
        )
      }
      if (s.initialization && s.afterthought) continue
      // three's encoder needs all three parts of a `for`. Emit a `while` in its own block instead.
      const loop = new AST.While(s.condition, [
        ...s.body,
        ...(s.afterthought ? [s.afterthought] : []),
      ])
      body[i] = s.initialization
        ? new AST.Conditional(new AST.Number('true', 'bool'), [s.initialization, loop])
        : loop
      fixes.add('loop')
    }
    for (let i = 0; i < body.length; i++) {
      if (isStep(body[i])) {
        body[i] = step(body[i] as Ast)
        fixes.add('increment')
      }
    }
  })
  walk(program, (n) => {
    if (n.isFor && !simpleLoop(n) && isStep(n.afterthought)) n.afterthought = step(n.afterthought)
  })
  walk(program, (n) => {
    if (!isStep(n)) return
    if (n.parent?.isFor && n.parent.afterthought === n && simpleLoop(n.parent)) return
    report.add(
      'GLSL_TRANSPILER',
      where(n.expression.property ?? n.type, ownerFn(n)),
      `\`${n.type}\` inside an expression: TSL r187 evaluates it as int`,
      'move the increment into its own statement: `x += 1.0;`',
    )
  })
  return fixes
}

export interface Typed {
  readonly kind: string
  readonly name: string
  readonly type: string
}
export interface Typing {
  /** The symbol an accessor's root resolves to. */
  sym(accessor: Ast): Typed | undefined
  call(call: Ast): Typed | undefined
  readonly structs: ReadonlyMap<string, Ast>
  readonly functions: readonly Ast[]
}

const VECTOR = /^([ibu]?)vec([234])$/
const COMPONENT: Record<string, string> = { '': 'float', i: 'int', u: 'uint', b: 'bool' }
const PREFIX: Record<string, string> = { float: '', int: 'i', uint: 'u', bool: 'b' }
const isVector = (t: string | undefined): boolean => !!t && VECTOR.test(t)
const isMatrix = (t: string | undefined): boolean => !!t && /^mat[234]$/.test(t)
const scalarOf = (t: string): string => {
  const m = VECTOR.exec(t)
  return m ? (COMPONENT[m[1] as string] as string) : t
}
const sizeOf = (t: string): number =>
  Number(VECTOR.exec(t)?.[2] ?? /^mat([234])$/.exec(t)?.[1] ?? 1)
const vectorOf = (scalar: string, size: number): string | undefined =>
  size === 1 ? scalar : PREFIX[scalar] === undefined ? undefined : `${PREFIX[scalar]}vec${size}`

const CONSTRUCTOR = /^(bool|float|u?int|mat[234]|[ibu]?vec[234])$/
const SCALAR_RESULT = new Set(['length', 'distance', 'dot', 'determinant'])
const COMPARE = new Set([
  'equal',
  'notEqual',
  'lessThan',
  'lessThanEqual',
  'greaterThan',
  'greaterThanEqual',
])
const SAMPLE =
  /^(texture|texture2D|textureLod|texture2DLodEXT|texelFetch|textureGrad|textureProj|texture2DProj)$/

function member(type: string | undefined, name: string, typing: Typing): string | undefined {
  if (!type) return undefined
  const def = typing.structs.get(type)
  if (def) return def.members.find((m) => m.name === name)?.type
  if (!/^[xyzw]+$|^[rgba]+$|^[stpq]+$/.test(name) || name.length > 4) return undefined
  return vectorOf(scalarOf(type), name.length)
}

const index = (type: string | undefined): string | undefined =>
  !type
    ? undefined
    : isMatrix(type)
      ? `vec${sizeOf(type)}`
      : isVector(type)
        ? scalarOf(type)
        : undefined

const overloads = (typing: Typing, name: string): Ast[] =>
  typing.functions.filter((f) => f.name === name)

/** The overload a call picks by argument count and types, or undefined if ambiguous. */
export function pick(call: Ast, group: readonly Ast[], typing: Typing): Ast | undefined {
  const args = call.params.map((p) => typeOf(p, typing))
  const sized = group.filter((f) => f.params.length === args.length)
  const fits = (exact: boolean) =>
    sized.filter((f) => f.params.every((p, i) => p.type === args[i] || (!exact && !args[i])))
  const exact = fits(true)
  if (exact.length === 1) return exact[0]
  const loose = fits(false)
  return loose.length === 1 ? loose[0] : sized.length === 1 ? sized[0] : undefined
}

/** The GLSL type of an expression, when it is evident. */
export function typeOf(e: Ast | null | undefined, typing: Typing): string | undefined {
  if (!e) return undefined
  if (e.isNumber) return e.type
  if (e.isUnary) return e.type === '!' ? 'bool' : typeOf(e.expression, typing)
  if (e.isTernary) return typeOf(e.left, typing) ?? typeOf(e.right, typing)
  if (e.isAccessor) {
    const sym = typing.sym(e)
    let type = sym?.type
    for (const part of e.property.split('.').slice(1)) type = member(type, part, typing)
    return type
  }
  if (e.isAccessorElements) {
    let type = typeOf(e.object, typing)
    for (const el of e.elements) {
      type = el.isStaticElement ? member(type, el.value?.property ?? '', typing) : index(type)
    }
    return type
  }
  if (e.isFunctionCall) {
    if (CONSTRUCTOR.test(e.name) || typing.structs.has(e.name)) return e.name
    const sym = typing.call(e)
    if (sym?.kind === 'function') {
      const group = overloads(typing, e.name)
      const types = new Set(group.map((f) => f.type))
      return types.size === 1 ? group[0]?.type : pick(e, group, typing)?.type
    }
    if (sym) return sym.type
    if (SAMPLE.test(e.name)) return 'vec4'
    if (e.name === 'textureSize') return 'ivec2'
    if (e.name === 'all' || e.name === 'any') return 'bool'
    if (e.name === 'cross') return 'vec3'
    const args = e.params.map((p) => typeOf(p, typing))
    const first = args[0]
    if (SCALAR_RESULT.has(e.name)) return first && scalarOf(first)
    if (COMPARE.has(e.name)) return first && vectorOf('bool', sizeOf(first))
    // genType built-ins return the widest argument type (`step(0.5, v)`, `mix(a, b, 0.5)`).
    return args.find(isMatrix) ?? args.find(isVector) ?? (args.every(Boolean) ? first : undefined)
  }
  if (e.isOperator) {
    if (e.isAssignment) return typeOf(e.left, typing)
    if (/^(==|!=|<|>|<=|>=|&&|\|\||\^\^)$/.test(e.type)) return 'bool'
    const l = typeOf(e.left, typing)
    const r = typeOf(e.right, typing)
    if (e.type === '*' && isMatrix(l) && isVector(r)) return r
    if (e.type === '*' && isVector(l) && isMatrix(r)) return l
    if (isMatrix(l)) return l
    if (isMatrix(r)) return r
    if (isVector(l)) return l
    if (isVector(r)) return r
    return l ?? r
  }
  return undefined
}

/** Vector `a == b` is one bool in GLSL. TSL's `equal` gives a bvec, which If and select reject. */
export function vectorEquality(program: Ast, typing: Typing): boolean {
  let changed = false
  rewrite(program, (n) => {
    if (!n.isOperator || (n.type !== '==' && n.type !== '!=')) return undefined
    if (!isVector(typeOf(n.left, typing)) && !isVector(typeOf(n.right, typing))) return undefined
    changed = true
    const eq = n.type === '=='
    return new AST.FunctionCall(eq ? 'all' : 'any', [
      new AST.FunctionCall(eq ? 'equal' : 'notEqual', [n.left, n.right]),
    ])
  })
  return changed
}

/**
 * three binds overloads with `overloadingFn`, which needs every variant to be a layout function.
 * When one isn't, or a variant calls its own group, each variant gets its own name and each call
 * is pointed at the variant its argument types pick.
 */
export function splitOverloads(
  calls: ReadonlyMap<Ast, Typed | undefined>,
  owner: ReadonlyMap<Ast, Ast>,
  typing: Typing,
  taken: Set<string>,
  report: Reporter,
  where: Where,
): boolean {
  const groups = new Map<string, Ast[]>()
  for (const f of typing.functions) groups.set(f.name, [...(groups.get(f.name) ?? []), f])
  const split = new Map<string, Ast[]>()
  for (const [name, group] of groups) {
    if (group.length < 2) continue
    const recursive = [...calls].some(
      ([call, sym]) =>
        sym?.kind === 'function' && call.name === name && group.includes(owner.get(call) as Ast),
    )
    if (recursive || group.some((f) => f.layout === false)) split.set(name, group)
  }
  if (!split.size) return false
  // Pick before renaming: argument types may come from calls of the same group.
  const picked = new Map<Ast, Ast>()
  for (const [call, sym] of calls) {
    const group = sym?.kind === 'function' ? split.get(call.name) : undefined
    if (!group) continue
    const target = pick(call, group, typing)
    if (target) picked.set(call, target)
    else {
      report.add(
        'GLSL_TRANSPILER',
        where(call.name, owner.get(call)?.name),
        `overload \`${call.name}\`: no variant matches the argument types`,
        'give the variants distinct names',
      )
    }
  }
  for (const group of split.values()) {
    for (const f of group) {
      let next = `${f.name}_${f.params.map((p) => p.type).join('_') || 'void'}`
      while (taken.has(next)) next += '_'
      taken.add(next)
      for (const [call, target] of picked) if (target === f) call.name = next
      f.name = next
    }
  }
  return true
}

/** Struct members go through `.get('name')` because TSL struct nodes have no member properties. */
export function structMembers(program: Ast, typing: Typing): void {
  walk(program, (n) => {
    if (n.isAccessor && !n.parent?.isStaticElement && n.property.includes('.')) {
      const [root, ...parts] = n.property.split('.')
      let type = typing.sym(n)?.type
      let path = root as string
      let changed = false
      for (const part of parts) {
        const isStruct = !!type && typing.structs.has(type)
        path += isStruct ? `.get( '${part}' )` : `.${part}`
        changed ||= isStruct
        type = member(type, part, typing)
      }
      if (changed) n.property = path
    } else if (n.isAccessorElements) {
      let type = typeOf(n.object, typing)
      for (const el of n.elements) {
        const name = el.isStaticElement ? (el.value?.property ?? '') : ''
        const isStruct = !!type && typing.structs.has(type)
        type = el.isStaticElement ? member(type, name, typing) : index(type)
        if (isStruct && el.value) el.value.property = `get( '${name}' )`
      }
    }
  })
}

/**
 * Locals are lazy in TSL. A value computed from inputs that change later, or computed once and
 * read in several branches, is materialised where GLSL declares it.
 */
export function materialise(
  declarations: readonly Ast[],
  written: ReadonlySet<Typed>,
  typing: Typing,
): boolean {
  const stable = (e: Ast | null): boolean => {
    if (!e) return true
    if (e.isNumber) return true
    if (e.isUnary && e.type === '-') return stable(e.expression)
    if (e.isAccessor) {
      const sym = typing.sym(e)
      return !!sym && !written.has(sym)
    }
    if (e.isFunctionCall && CONSTRUCTOR.test(e.name) && !typing.call(e))
      return e.params.every(stable)
    return false
  }
  let changed = false
  for (const d of declarations) {
    if (d.needsToVar || stable(d.value)) continue
    d.needsToConst = true
    changed = true
  }
  return changed
}
