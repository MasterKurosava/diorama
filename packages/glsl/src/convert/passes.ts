// AST passes around three's Linker. Whatever r187's transpiler would silently get wrong becomes
// a fix or a diagnostic.
import Linker from 'three/addons/transpiler/Linker.js'
import * as TSL from 'three/tsl'
import { type Dialect, isMediaName, normalizeName, similar, UV_VARYINGS } from '../names'
import { AST, type Ast, children, ownerFn, relink, renameRoot, rootName, rootOf, walk } from './ast'
import { NO_ARRAYS, NO_ARRAYS_HINT, type Reporter } from './errors'
import { MATRICES4, type Prepared, type Prototype, type UniformDecl } from './prepare'
import {
  bodies,
  materialise,
  simpleLoop,
  splitOverloads,
  structMembers,
  syntax,
  type Typing,
  vectorEquality,
  type Where,
} from './rewrite'

export const OUT = 'dio_out'
const POS = 'dio_pos'
const RESULT = 'dio_result'

const LOOKUPS = new Set([
  'texture',
  'texture2D',
  'textureLod',
  'texture2DLodEXT',
  'texelFetch',
  'textureGrad',
  'textureProj',
  'texture2DProj',
  'textureSize',
])
const MEDIA_ONLY = new Set(['texture', 'texture2D'])
const RESERVED_JS = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval undefined NaN Infinity'.split(
    ' ',
  ),
)
const SHADERTOY: Record<string, string> = {
  iTime: 'float',
  iResolution: 'vec3',
  iMouse: 'vec4',
  iChannel0: 'sampler2D',
  iChannel1: 'sampler2D',
  iChannel2: 'sampler2D',
  iChannel3: 'sampler2D',
}
const SHADERTOY_MISSING: Record<string, string> = {
  iTimeDelta: 'declare a param: `uniform float uDelta; // @default 0.016`',
  iFrame: 'derive frames from time: `floor(iTime * 60.0)`',
  iDate: 'pass the date as a function in `glslEffect({ uniforms })`',
  iChannelResolution: 'use `iResolution` or `// @input size`',
  iChannelTime: 'use `iTime`',
  iFrameRate: 'declare a param',
  iSampleRate: 'audio is not supported',
}

const tsl = TSL as unknown as Record<string, unknown>
export const isTsl = (name: string): boolean => tsl[name] !== undefined

type Kind =
  | 'uniform'
  | 'varying'
  | 'global'
  | 'function'
  | 'struct'
  | 'param'
  | 'local'
  | 'builtin'
  | 'external'
export interface Sym {
  readonly kind: Kind
  readonly name: string
  readonly node: Ast | undefined
  readonly type: string
  jsName: string
}

export interface Analysis {
  entry: Ast
  /** Why the fragment can't be a uv stage, if it can't. */
  uvBlocker: UvBlocker | undefined
  /** The sampler bound to the element's image. */
  media: string | undefined
  /** Names of uniforms that are read. */
  used: Set<string>
  varyings: Record<string, string>
  writes: string[]
  externals: string[]
  /** Uniform declarations including Shadertoy's implicit ones. */
  uniforms: UniformDecl[]
  /** Lines at the top of `build`, for bound built-ins. */
  prologue: string[]
  imports: Set<string>
  /** JS names already taken in `build`. */
  declared: Set<string>
  fixes: Set<string>
  /** `resolution`-like uniforms read only as x / y. */
  ratioOnly: Set<string>
}

const findFn = (program: Ast, names: readonly string[]): Ast | undefined =>
  program.body.find((s) => s.isFunctionDeclaration && names.includes(s.name))

const containsReturn = (node: Ast): boolean => {
  let found = false
  walk(node, (n) => {
    if (n.isReturn) found = true
  })
  return found
}

/** Deep copy of a subtree. Pre-link only, since linker data is reset. */
function clone(node: Ast): Ast {
  const copy = Object.create(Object.getPrototypeOf(node)) as Ast
  for (const key of Object.keys(node)) {
    const value = (node as unknown as Record<string, unknown>)[key]
    const out = copy as unknown as Record<string, unknown>
    if (key === 'parent') out[key] = null
    else if (key === 'linker') out[key] = { reference: null, accesses: [], assignments: [] }
    else if (Array.isArray(value))
      out[key] = value.map((v) => ((v as Ast)?.isASTNode ? clone(v as Ast) : v))
    else if ((value as Ast | null)?.isASTNode) out[key] = clone(value as Ast)
    else out[key] = value
  }
  return copy
}

/** `T(0)` for scalars and vectors, `T()` for matrices, a struct of member zeros. */
export function zeroOf(type: string, program: Ast): Ast {
  const struct = program.structTypes.get(type)
  if (struct)
    return new AST.FunctionCall(
      type,
      struct.members.map((m) => zeroOf(m.type, program)),
    )
  if (/^mat/.test(type)) return new AST.FunctionCall(type, [])
  const n =
    type === 'bool'
      ? new AST.Number('false', 'bool')
      : new AST.Number(/int$/.test(type) ? '0' : '0.0', /int$/.test(type) ? 'int' : 'float')
  return new AST.FunctionCall(type, [n])
}

const assign = (name: string, value: Ast): Ast =>
  new AST.Operator('=', new AST.Accessor(name), value)
const declare = (type: string, name: string, value: Ast | null, toVar = true): Ast => {
  const node = new AST.VariableDeclaration(type, name, value)
  node.needsToVar = toVar
  return node
}

/** State shared by the passes. Each pass records the rewrites it applies in `fixes`. */
interface Ctx {
  readonly program: Ast
  readonly prepared: Prepared
  readonly report: Reporter
  readonly where: Where
  readonly vertex: boolean
  readonly dialect: Dialect
  readonly fixes: Set<string>
  readonly entry: Ast
  readonly functions: readonly Ast[]
  /** Prototypes without a definition. Their bodies come from `glslEffect({ functions })`. */
  readonly externals: readonly Prototype[]
  /** Names the decoded program reads, with #define bodies expanded. */
  readonly referenced: ReadonlySet<string>
}

/** Every accessor and call resolved to its symbol, with the function it sits in. */
interface Resolution {
  readonly globals: Map<string, Sym>
  readonly builtins: Map<string, Sym>
  readonly refs: Map<Ast, Sym | undefined>
  readonly calls: Map<Ast, Sym | undefined>
  readonly owner: Map<Ast, Ast>
  readonly locals: Sym[]
  readonly typing: Typing
}

export function analyze(
  program: Ast,
  prepared: Prepared,
  report: Reporter,
  options: { readonly bindings: Readonly<Record<string, string>> },
): Analysis | undefined {
  const entry = findEntry(program, prepared, report)
  if (!entry) return undefined
  const functions = program.body.filter((s) => s.isFunctionDeclaration)
  const defined = new Set(functions.map((f) => f.name))
  const referenced = new Set<string>()
  walk(program, (n) => {
    if (n.isAccessor) referenced.add(rootName(n))
  })
  const ctx: Ctx = {
    program,
    prepared,
    report,
    where: (name, fn) => prepared.find(name, fn),
    vertex: prepared.stage === 'vertex',
    dialect: prepared.dialect,
    fixes: new Set(prepared.fixes),
    entry,
    functions,
    externals: prepared.externals.filter((p) => !defined.has(p.name)),
    referenced,
  }
  const { fixes, vertex } = ctx

  splitDeclarations(ctx)
  const { earlyMain, coord } = returnOutput(ctx)
  singleExits(ctx)
  const uniforms = shadertoyUniforms(ctx)
  rewriteSyntax(ctx)
  const r = resolve(ctx)
  if (vertex) vertexStage(ctx, r)
  pruneDead(program, r)
  unsupportedBuiltins(ctx)
  const written = mutability(ctx, r)
  paramQualifiers(ctx)
  if (vectorEquality(program, r.typing)) {
    fixes.add('vector-equal')
    relink(program)
  }
  voidCalls(ctx, r)
  const images = samplers(ctx, r, uniforms, options.bindings)
  const { varyings, writes, prologue, imports } = varyingsAndBuiltins(ctx, r, images.used)
  const ratioOnly = ratios(r)
  const taken = renameClashes(ctx, r, coord)
  prologue.push(...externalBindings(r))
  unknownNames(ctx, r, taken)
  layouts(ctx, r)
  if (splitOverloads(r.calls, r.owner, r.typing, taken, report, ctx.where)) fixes.add('overload')
  structMembers(program, r.typing)
  if (materialise(declarationsOf(r), written, r.typing)) fixes.add('toconst')
  dropUnused(program, r)

  return {
    entry,
    uvBlocker: vertex
      ? 'vertex'
      : uvBlocker(entry, program, {
          media: images.media && r.globals.get(images.media)?.jsName,
          mediaReads: images.mediaReads,
          otherReads: images.otherReads,
          earlyMain,
        }),
    media: images.media,
    used: images.used,
    varyings,
    writes,
    externals: ctx.externals.map((p) => p.name),
    uniforms,
    prologue,
    imports,
    declared: taken,
    fixes,
    ratioOnly,
  }
}

/** main, or mainImage in Shadertoy. Reports when it is missing. */
function findEntry(program: Ast, prepared: Prepared, report: Reporter): Ast | undefined {
  const shadertoy = prepared.dialect === 'shadertoy'
  const entry = findFn(program, [shadertoy && prepared.stage !== 'vertex' ? 'mainImage' : 'main'])
  if (!entry) {
    report.add(
      'GLSL_NO_ENTRY',
      { file: prepared.find('main').file, line: 1, column: 1 },
      shadertoy ? 'no `mainImage` function' : 'no `main` function',
      'a shader is a `void main()` that writes gl_FragColor (or gl_Position)',
    )
  }
  return entry
}

/** One name per declaration, so `.toVar()` lands on its own variable. */
function splitDeclarations({ program, fixes }: Ctx): void {
  bodies(program, (body) => {
    for (let i = 0; i < body.length; i++) {
      const s = body[i] as Ast
      if (!s.isVariableDeclaration || !s.next) continue
      const split: Ast[] = []
      for (let d: Ast | null = s; d; d = d.next) {
        split.push(new AST.VariableDeclaration(d.type, d.name, d.value, null, d.immutable))
      }
      body.splice(i, 1, ...split)
      fixes.add('split-decl')
      i += split.length - 1
    }
  })
}

const hasEarlyReturn = (fn: Ast): boolean =>
  fn.body.some((s, i) => (s.isReturn ? i !== fn.body.length - 1 : containsReturn(s)))

/** Turns every return into If/Else around the rest of the body. `result` receives the value. */
function singleExit(ctx: Ctx, body: Ast[], result: string | null, fn: Ast): Ast[] {
  const out: Ast[] = []
  for (let i = 0; i < body.length; i++) {
    const s = body[i] as Ast
    if (s.isReturn) {
      if (result && s.value) out.push(assign(result, s.value))
      return out
    }
    if (s.isConditional && containsReturn(s)) {
      const rest = body.slice(i + 1)
      let last = s
      for (let c: Ast | null = s; c; c = c.elseConditional) {
        c.body = singleExit(ctx, [...c.body, ...rest.map(clone)], result, fn)
        last = c
      }
      if (last.cond) {
        last.elseConditional = new AST.Conditional(
          null,
          singleExit(ctx, rest.map(clone), result, fn),
        )
      }
      out.push(s)
      return out
    }
    if ((s.isFor || s.isWhile || s.isSwitch) && containsReturn(s)) {
      ctx.report.add(
        'GLSL_EARLY_RETURN',
        ctx.where('return', fn.name),
        '`return` inside a loop or switch',
        'move the condition into the loop, or use break and a result variable',
      )
    }
    out.push(s)
  }
  return out
}

/** Makes main return its output through a single exit instead of writing it. */
function returnOutput(ctx: Ctx): { earlyMain: boolean; coord: string | undefined } {
  const { entry, prepared, report, where, vertex, dialect } = ctx
  const outputs = new Set(vertex ? ['gl_Position'] : ['gl_FragColor', ...prepared.outputs])
  if (dialect === 'shadertoy' && entry.params[0]) outputs.add(entry.params[0].name)
  const output = vertex ? POS : OUT
  walk(entry, (n) => {
    if (!n.isAccessor) return
    const root = rootName(n)
    if (outputs.has(root)) renameRoot(n, output)
    else if (root === 'gl_FragData') {
      report.add(
        'GLSL_OUTPUT',
        where('gl_FragData', entry.name),
        'gl_FragData: Diorama draws a single color',
        'write to gl_FragColor',
      )
    }
  })
  if (
    !vertex &&
    dialect !== 'shadertoy' &&
    !ctx.referenced.has('gl_FragColor') &&
    !prepared.outputs.length
  ) {
    report.add(
      'GLSL_OUTPUT',
      where('main'),
      'the fragment shader does not write gl_FragColor',
      'write the color to gl_FragColor',
    )
  }
  const earlyMain = hasEarlyReturn(entry)
  const coord = dialect === 'shadertoy' ? entry.params[1]?.name : undefined
  entry.params = []
  entry.layout = false
  entry.body = singleExit(ctx, entry.body, null, entry)
  if (vertex) {
    entry.type = 'vec3'
    entry.body.unshift(declare('vec4', POS, new AST.FunctionCall('vec4', [new AST.Number('0.0')])))
    entry.body.push(
      new AST.Return(
        new AST.Operator('/', new AST.Accessor(`${POS}.xyz`), new AST.Accessor(`${POS}.w`)),
      ),
    )
  } else {
    entry.type = 'vec4'
    entry.body.unshift(declare('vec4', OUT, new AST.FunctionCall('vec4', [new AST.Number('0.0')])))
    if (coord)
      entry.body.unshift(declare('vec2', coord, new AST.Accessor('gl_FragCoord.xy'), false))
    entry.body.push(new AST.Return(new AST.Accessor(OUT)))
  }
  ctx.fixes.add('output').add('layout')
  if (earlyMain) {
    ctx.fixes.add('single-exit')
    report.add(
      'GLSL_SINGLE_EXIT',
      where('return', entry.name),
      'early return in main rewritten as If/Else',
      undefined,
    )
  }
  return { earlyMain, coord }
}

function singleExits(ctx: Ctx): void {
  for (const fn of ctx.functions) {
    if (fn === ctx.entry || !hasEarlyReturn(fn)) continue
    if (fn.type === 'void') fn.body = singleExit(ctx, fn.body, null, fn)
    else {
      fn.body = [
        declare(fn.type, RESULT, zeroOf(fn.type, ctx.program)),
        ...singleExit(ctx, fn.body, RESULT, fn),
        new AST.Return(new AST.Accessor(RESULT)),
      ]
    }
    ctx.fixes.add('single-exit')
    ctx.report.add(
      'GLSL_SINGLE_EXIT',
      ctx.where('return', fn.name),
      `early returns in \`${fn.name}\` rewritten as If/Else with a single exit`,
      undefined,
    )
  }
}

/** Uniform declarations, with Shadertoy's implicit uniforms declared in the program too. */
function shadertoyUniforms({ program, prepared, dialect, referenced, where }: Ctx): UniformDecl[] {
  const uniforms: UniformDecl[] = [...prepared.uniforms]
  if (dialect !== 'shadertoy') return uniforms
  const declared = new Set(uniforms.map((u) => u.name))
  const injected: Ast[] = []
  for (const [name, type] of Object.entries(SHADERTOY)) {
    if (!referenced.has(name) || declared.has(name)) continue
    injected.push(new AST.Uniform(type === 'sampler2D' ? 'texture' : type, name))
    uniforms.push({ name, type, array: false, at: where(name), pragmas: { keys: new Set() } })
  }
  program.body.unshift(...injected)
  return uniforms
}

/** Rewrites before linking, then three's Linker. */
function rewriteSyntax({ program, report, where, fixes }: Ctx): void {
  relink(program)
  // three parses `true`/`false` as accessors and would emit JS booleans.
  walk(program, (n) => {
    if (n.isAccessor && (n.property === 'true' || n.property === 'false')) {
      const replacement = new AST.Number(n.property, 'bool')
      if (n.parent) replaceChild(n.parent, n, replacement)
    }
  })
  for (const fix of syntax(program, report, where)) fixes.add(fix)
  relink(program)
  new Linker().process(program)
}

const symbol = (
  map: Map<string, Sym>,
  kind: Kind,
  node: Ast | undefined,
  name: string,
  type: string,
): Sym => {
  if (!map.has(name)) map.set(name, { kind, name, node, type, jsName: name })
  return map.get(name) as Sym
}

/** Scoped resolution of every accessor and call. three's Linker misses `a.x` accessors. */
function resolve({ program, vertex, functions, externals }: Ctx): Resolution {
  const globals = new Map<string, Sym>()
  for (const s of program.body) {
    if (s.isUniform) symbol(globals, 'uniform', s, s.name, s.type)
    else if (s.isVarying) symbol(globals, 'varying', s, s.name, s.type)
    else if (s.isVariableDeclaration) symbol(globals, 'global', s, s.name, s.type)
    else if (s.isFunctionDeclaration) symbol(globals, 'function', s, s.name, s.type)
    else if (s.isStructDefinition) symbol(globals, 'struct', s, s.name, s.name)
  }
  for (const p of externals) symbol(globals, 'external', undefined, p.name, p.type)
  const builtins = new Map<string, Sym>()
  const builtin = (name: string, type: string, js: string): void => {
    symbol(builtins, 'builtin', undefined, name, type).jsName = js
  }
  if (vertex) {
    builtin('position', 'vec3', 'dio_position')
    builtin('uv', 'vec2', 'dio_uv')
    builtin('normal', 'vec3', 'dio_normal')
    for (const m of MATRICES4) builtin(m, 'mat4', 'dio_identity4')
    builtin('normalMatrix', 'mat3', 'dio_identity3')
  } else builtin('gl_FragCoord', 'vec4', 'dio_fragCoord')

  const refs = new Map<Ast, Sym | undefined>()
  const calls = new Map<Ast, Sym | undefined>()
  const owner = new Map<Ast, Ast>()
  const locals: Sym[] = []
  const scopes: Map<string, Sym>[] = []
  let current: Ast | undefined
  const lookup = (name: string): Sym | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i]?.get(name)
      if (hit) return hit
    }
    return globals.get(name) ?? builtins.get(name)
  }
  const local = (kind: Kind, node: Ast): void => {
    const scope = scopes[scopes.length - 1] as Map<string, Sym>
    const sym = symbol(scope, kind, node, node.name, node.type)
    if (sym.node === node) locals.push(sym)
  }
  const expr = (e: Ast | null | undefined): void => {
    if (!e) return
    if (e.isAccessor) {
      if (e.parent?.isStaticElement) return
      refs.set(e, lookup(rootName(e)))
      if (current) owner.set(e, current)
      return
    }
    if (e.isFunctionCall) {
      calls.set(e, lookup(e.name))
      if (current) owner.set(e, current)
    }
    if (e.isVariableDeclaration) {
      stmt(e)
      return
    }
    for (const child of children(e)) expr(child)
  }
  const block = (body: readonly Ast[]): void => {
    scopes.push(new Map())
    for (const s of body) stmt(s)
    scopes.pop()
  }
  const stmt = (s: Ast): void => {
    if (s.isVariableDeclaration) {
      expr(s.value)
      local('local', s)
    } else if (s.isConditional) {
      expr(s.cond)
      block(s.body)
      if (s.elseConditional) stmt(s.elseConditional)
    } else if (s.isFor) {
      scopes.push(new Map())
      if (s.initialization) stmt(s.initialization)
      expr(s.condition)
      expr(s.afterthought)
      block(s.body)
      scopes.pop()
    } else if (s.isWhile) {
      expr(s.condition)
      block(s.body)
    } else if (s.isSwitch) {
      expr(s.discriminant)
      for (const c of s.cases) {
        for (const cond of c.conditions ?? []) expr(cond)
        block(c.body)
      }
    } else if (s.isReturn) expr(s.value)
    else if (!s.isComment && !s.isDiscard && !s.isBreak && !s.isContinue && !s.isStructDefinition)
      expr(s)
  }
  for (const s of program.body) {
    if (s.isFunctionDeclaration) {
      current = s
      scopes.push(new Map())
      for (const p of s.params) local('param', p)
      block(s.body)
      scopes.pop()
      current = undefined
    } else if (s.isVariableDeclaration) expr(s.value)
  }
  const typing: Typing = {
    sym: (accessor) => refs.get(accessor),
    call: (call) => calls.get(call),
    structs: program.structTypes,
    functions,
  }
  return { globals, builtins, refs, calls, owner, locals, typing }
}

const symOf = (r: Resolution, accessor: Ast | undefined): Sym | undefined =>
  accessor ? r.refs.get(accessor) : undefined

/** three's matrices are identities here and `vUv = uv` is implicit. */
function vertexStage({ program, prepared, report, where, entry, fixes }: Ctx, r: Resolution): void {
  const identity = (n: Ast): boolean =>
    !!n.isAccessor &&
    !n.property.includes('.') &&
    symOf(r, n)?.kind === 'builtin' &&
    /Matrix$/.test(n.property)
  const fold = (n: Ast): void => {
    for (const child of children(n)) fold(child)
    if (n.isOperator && n.type === '*' && n.parent) {
      if (identity(n.left)) replaceChild(n.parent, n, n.right)
      else if (identity(n.right)) replaceChild(n.parent, n, n.left)
    }
  }
  fold(program)
  fixes.add('matrices')
  bodies(program, (body) => {
    for (let i = body.length - 1; i >= 0; i--) {
      const s = body[i] as Ast
      if (!s.isOperator || s.type !== '=') continue
      const sym = symOf(r, rootOf(s.left))
      if (sym?.kind !== 'varying' || !UV_VARYINGS.has(sym.name)) continue
      const plain =
        s.left.isAccessor &&
        !s.left.property.includes('.') &&
        s.right.isAccessor &&
        s.right.property === 'uv' &&
        symOf(r, s.right)?.kind === 'builtin'
      if (!plain) {
        report.add(
          'GLSL_VARYING_WRITE',
          where(sym.name, entry.name),
          `write to \`${sym.name}\` in the vertex shader is dropped: the fragment gets the box UV`,
          'move the UV transform into the fragment shader',
        )
      }
      body.splice(i, 1)
    }
  })
  let position = false
  walk(entry, (n) => {
    if (n.isOperator && n.isAssignment && rootOf(n.left)?.property.split('.')[0] === POS)
      position = true
  })
  if (!position) {
    report.add(
      'GLSL_VERTEX',
      where('main'),
      'the vertex shader does not write gl_Position',
      'write the position: `gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);`',
    )
  }
  if (prepared.used.has('cameraPosition') || prepared.used.has('gl_PointSize')) {
    const name = prepared.used.has('cameraPosition') ? 'cameraPosition' : 'gl_PointSize'
    report.add(
      'GLSL_VERTEX',
      where(name),
      `\`${name}\` is not supported: the plane is drawn without a camera of its own`,
      'shaders with their own projection or point sprites cannot be converted',
    )
  }
}

/** Forgets references held by statements that were dropped. */
function pruneDead(program: Ast, r: Resolution): void {
  const live = new Set<Ast>()
  walk(program, (n) => {
    live.add(n)
  })
  for (const map of [r.refs, r.calls])
    for (const node of [...map.keys()]) if (!live.has(node)) map.delete(node)
}

function unsupportedBuiltins({ prepared, report, where }: Ctx): void {
  if (prepared.used.has('gl_FrontFacing')) {
    report.add(
      'GLSL_UNSUPPORTED_TYPE',
      where('gl_FrontFacing'),
      '`gl_FrontFacing` is not supported',
      'the plane always faces the camera: replace it with true',
    )
  }
}

/** Reassigned locals get `.toVar()` and written params a copy. Writes to global state fail. */
function mutability({ program, report, where, vertex, fixes }: Ctx, r: Resolution): Set<Sym> {
  const toVar = new Set<Ast>()
  const written = new Set<Sym>()
  walk(program, (n) => {
    const write =
      n.isOperator && n.isAssignment
        ? n.left
        : n.isUnary && n.isAssignment
          ? n.expression
          : undefined
    if (!write) return
    const target = rootOf(write)
    const sym = symOf(r, target)
    if (!sym || !target) return
    const fn = r.owner.get(target)?.name
    if (sym.kind === 'local' || sym.kind === 'param') written.add(sym)
    if (sym.kind === 'local' && sym.node) {
      const parent = sym.node.parent
      if (parent?.isFor && parent.initialization === sym.node && simpleLoop(parent)) return
      if (
        !sym.node.needsToVar &&
        !toVar.has(sym.node) &&
        sym.name !== OUT &&
        sym.name !== POS &&
        sym.name !== RESULT
      ) {
        toVar.add(sym.node)
        report.add(
          'GLSL_TOVAR',
          where(sym.name, fn),
          `\`${sym.name}\` is reassigned: added .toVar()`,
          undefined,
        )
      }
      sym.node.needsToVar = true
      fixes.add('tovar')
    } else if (sym.kind === 'param' && sym.node) {
      if (!sym.node.linker.assignments.length) {
        sym.node.linker.assignments.push(n)
        fixes.add('param-copy')
      }
    } else if (
      sym.kind === 'global' ||
      sym.kind === 'uniform' ||
      (sym.kind === 'varying' && !vertex)
    ) {
      report.add(
        'GLSL_GLOBAL_STATE',
        where(sym.name, fn),
        `write to ${sym.kind === 'global' ? 'global variable' : sym.kind === 'uniform' ? 'uniform' : 'varying'} \`${sym.name}\``,
        'make the variable local and pass the value through parameters',
      )
    }
  })
  return written
}

/** TSL functions take values, so out/inout and sampler parameters can't work. */
function paramQualifiers({ functions, entry, report, where }: Ctx): void {
  for (const fn of functions) {
    if (fn === entry) continue
    for (const p of fn.params) {
      if (p.qualifier === 'out' || p.qualifier === 'inout') {
        report.add(
          'GLSL_INOUT',
          where(p.qualifier, fn.name),
          `parameter \`${p.name}\` is ${p.qualifier}: the caller does not see changes`,
          'return the value, or a struct, from the function',
        )
      }
      if (/^sampler/.test(p.type)) {
        report.add(
          'GLSL_SAMPLER',
          where(p.name, fn.name),
          `sampler \`${p.name}\` as a function parameter`,
          'sample the texture in main and pass the color to the function',
        )
      }
    }
  }
}

function voidCalls({ functions, report, where }: Ctx, r: Resolution): void {
  for (const [call, sym] of r.calls) {
    if (
      sym?.kind !== 'function' ||
      !functions.every((f) => f.name !== call.name || f.type === 'void')
    )
      continue
    report.add(
      'GLSL_TRANSPILER',
      where(call.name, r.owner.get(call)?.name),
      `call of void function \`${call.name}\`: TSL r187 drops calls without a value (and any discard in them)`,
      'inline the function body at the call site or return a value from it',
    )
  }
}

interface Images {
  readonly media: string | undefined
  readonly used: Set<string>
  readonly mediaReads: number
  readonly otherReads: number
}

/** Finds the element's image sampler, which supports plain sampling only, and checks the rest. */
function samplers(
  { report, where, dialect, fixes }: Ctx,
  r: Resolution,
  uniforms: readonly UniformDecl[],
  bindings: Readonly<Record<string, string>>,
): Images {
  const all = uniforms.filter((u) => u.type === 'sampler2D' && !u.array)
  const used = new Set<string>()
  for (const [accessor, sym] of r.refs) {
    if (sym?.kind === 'uniform' && accessor.parent) used.add(sym.name)
  }
  const candidates = all.filter(
    (s) =>
      used.has(s.name) &&
      s.pragmas.texture === undefined &&
      (bindings[s.name] ?? 'media') === 'media',
  )
  let media: string | undefined
  const pragma = all.filter((s) => s.pragmas.media)
  const byOption = all.filter((s) => bindings[s.name] === 'media')
  if (pragma.length || byOption.length) media = (pragma[0] ?? byOption[0])?.name
  else if (candidates.length === 1) media = candidates[0]?.name
  else if (candidates.length > 1) {
    const named = candidates.filter((s) => isMediaName(normalizeName(s.name, dialect)))
    if (named.length === 1) media = named[0]?.name
    else {
      report.add(
        'GLSL_SAMPLER',
        (candidates[0] as UniformDecl).at,
        `ambiguous element image: ${candidates.map((s) => s.name).join(', ')}`,
        'mark the main sampler `// @media` and the others `// @texture`',
      )
    }
  }
  if (all.some((s) => used.has(s.name))) fixes.add('texture')
  let mediaReads = 0
  let otherReads = 0
  for (const [call, sym] of r.calls) {
    if (sym || !LOOKUPS.has(call.name)) continue
    const first = call.params[0]
    const target = first?.isAccessor && !first.property.includes('.') ? symOf(r, first) : undefined
    const fn = r.owner.get(call)?.name
    if (target?.kind !== 'uniform' || target.type !== 'texture') {
      report.add(
        'GLSL_SAMPLER',
        where(call.name, fn),
        `\`${call.name}\` does not read a sampler uniform`,
        'sample the texture through its uniform directly in main',
      )
      continue
    }
    if (target.name !== media) {
      otherReads++
      if (call.name === 'texture2DLodEXT') call.name = 'textureLod'
      if (call.name === 'textureProj' || call.name === 'texture2DProj') {
        report.add(
          'GLSL_SAMPLER',
          where(call.name, fn),
          `\`${call.name}\` is not supported`,
          'replace it with texture(s, p.xy / p.w)',
        )
      }
      continue
    }
    if (MEDIA_ONLY.has(call.name) && call.params.length === 2) {
      mediaReads++
    } else if (
      MEDIA_ONLY.has(call.name) ||
      call.name === 'textureLod' ||
      call.name === 'texture2DLodEXT'
    ) {
      mediaReads++
      const at = where(call.name, fn)
      call.name = 'texture'
      call.params = call.params.slice(0, 2)
      report.add(
        'GLSL_LOD',
        at,
        `LOD or bias of \`${target.name}\` dropped: the element's image is sampled without a level`,
        'to sample a specific level, bind the texture with `// @texture`',
      )
    } else {
      const hint =
        call.name === 'textureSize'
          ? 'read the image size from a uniform: `uniform vec2 uImageSize; // @input size`'
          : call.name === 'texelFetch'
            ? 'use texture(s, uv) with a UV coordinate'
            : 'use texture(s, uv)'
      report.add(
        'GLSL_SAMPLER',
        where(call.name, fn),
        `\`${call.name}\` on the element's image: only sampling is supported`,
        hint,
      )
    }
  }
  for (const [accessor, sym] of r.refs) {
    if (sym?.kind !== 'uniform' || sym.type !== 'texture') continue
    const call = accessor.parent
    if (call?.isFunctionCall && LOOKUPS.has(call.name) && call.params[0] === accessor) continue
    report.add(
      'GLSL_SAMPLER',
      where(sym.name, r.owner.get(accessor)?.name),
      `sampler \`${sym.name}\` is used outside a texture lookup`,
      'pass colors to functions, not samplers',
    )
  }
  return { media, used, mediaReads, otherReads }
}

/** Lines that bind each built-in at the top of `build`. */
const BOUND: Record<string, string> = {
  dio_fragCoord: 'const dio_fragCoord = $.fragCoord;',
  dio_position: 'const dio_position = $.position;',
  dio_uv: 'const dio_uv = $.uv;',
  dio_normal: 'const dio_normal = vec3( 0.0, 0.0, 1.0 );',
  dio_identity4: 'const dio_identity4 = mat4();',
  dio_identity3: 'const dio_identity3 = mat3();',
}
const BOUND_IMPORTS: Record<string, string> = {
  dio_normal: 'vec3',
  dio_identity4: 'mat4',
  dio_identity3: 'mat3',
}

/** Varyings the shader reads or writes, and built-ins bound in the prologue. */
function varyingsAndBuiltins(
  { report, where, vertex, fixes }: Ctx,
  r: Resolution,
  used: Set<string>,
): Pick<Analysis, 'varyings' | 'writes' | 'prologue' | 'imports'> {
  const varyings: Record<string, string> = {}
  const writes: string[] = []
  const prologue: string[] = []
  const imports = new Set<string>()
  const builtins = new Set<string>()
  for (const [accessor, sym] of r.refs) {
    if (sym?.kind === 'uniform') used.add(sym.name)
    if (sym?.kind === 'builtin') {
      builtins.add(sym.jsName)
      renameRoot(accessor, sym.jsName)
    }
    if (sym?.kind === 'varying' && !UV_VARYINGS.has(sym.name)) {
      varyings[sym.name] = sym.type
      const isWrite = (n: Ast | null): boolean =>
        !!n?.isOperator && !!n.isAssignment && rootOf(n.left) === accessor
      if (vertex && isWrite(accessor.parent) && !writes.includes(sym.name)) writes.push(sym.name)
    }
  }
  if (!vertex) {
    for (const name of Object.keys(varyings)) {
      if (!/^(float|vec[234])$/.test(varyings[name] as string)) {
        report.add(
          'GLSL_UNSUPPORTED_TYPE',
          where(name),
          `varying \`${name}\` has type ${varyings[name]}`,
          'varyings must be float or vecN',
        )
      }
    }
  }
  for (const name of Object.keys(BOUND)) {
    if (!builtins.has(name)) continue
    prologue.push(BOUND[name] as string)
    const type = BOUND_IMPORTS[name]
    if (type) imports.add(type)
  }
  if (builtins.size) fixes.add('polyfill')
  if (builtins.has('dio_fragCoord')) {
    report.add(
      'GLSL_FRAGCOORD',
      where('gl_FragCoord'),
      "gl_FragCoord is in device pixels of the element box, from its bottom-left corner, not the screen's",
      undefined,
    )
  }
  return { varyings, writes, prologue, imports }
}

/** Uniforms read only as `u.x / u.y`. That ratio of a resolution is the same in any units. */
function ratios(r: Resolution): Set<string> {
  const ratioOnly = new Set<string>()
  const accessesBy = new Map<string, Ast[]>()
  for (const [accessor, sym] of r.refs) {
    if (sym?.kind === 'uniform')
      accessesBy.set(sym.name, [...(accessesBy.get(sym.name) ?? []), accessor])
  }
  for (const [name, list] of accessesBy) {
    const ok = list.every((a) => {
      const p = a.parent
      if (!p?.isOperator || p.type !== '/') return false
      const other = p.left === a ? p.right : p.left
      return (
        !!other.isAccessor &&
        /^\w+\.[xy]$/.test(a.property) &&
        /^\w+\.[xy]$/.test(other.property) &&
        rootName(other) === name &&
        a.property !== other.property
      )
    })
    if (ok) ratioOnly.add(name)
  }
  return ratioOnly
}

const clash = (name: string): boolean =>
  isTsl(name) || RESERVED_JS.has(name) || name === '$' || /^dio_/.test(name)

/** Names that shadow three/tsl or JS get a trailing `_`. Returns every JS name taken. */
function renameClashes(
  { program, report, where, functions, fixes }: Ctx,
  r: Resolution,
  coord: string | undefined,
): Set<string> {
  const taken = new Set<string>([
    ...r.globals.keys(),
    ...r.locals.map((l) => l.name),
    ...Object.keys(BOUND),
  ])
  const renamed = new Map<Sym, string>()
  for (const sym of [...r.globals.values(), ...r.locals]) {
    if ([OUT, POS, RESULT].includes(sym.name)) continue
    if (sym.kind === 'local' && coord && sym.name === coord) continue
    if (!clash(sym.name)) continue
    let next = `${sym.name}_`
    while (taken.has(next) || clash(next)) next += '_'
    taken.add(next)
    sym.jsName = next
    renamed.set(sym, next)
    fixes.add('rename')
    if (sym.kind !== 'uniform' && sym.kind !== 'varying') {
      report.add(
        'GLSL_RENAMED',
        where(sym.name, sym.kind === 'function' ? undefined : sym.node && ownerFn(sym.node)),
        `\`${sym.name}\` clashes with a TSL or JS name: emitted as \`${next}\``,
        undefined,
      )
    }
  }
  for (const [sym, next] of renamed) {
    const node = sym.node
    if (!node) continue
    if (sym.kind === 'uniform' || sym.kind === 'varying') node.glslName = sym.name
    if (sym.kind === 'struct') {
      walk(program, (n) => {
        if (
          (n.isVariableDeclaration || n.isFunctionDeclaration || n.isFunctionParameter) &&
          n.type === sym.name
        )
          n.type = next
      })
      program.structTypes.set(next, node)
    }
    if (sym.kind === 'function') {
      for (const f of functions) if (f.name === sym.name) f.name = next
    } else node.name = next
  }
  for (const [accessor, sym] of r.refs)
    if (sym && renamed.has(sym)) renameRoot(accessor, sym.jsName)
  for (const [call, sym] of r.calls) if (sym && renamed.has(sym)) call.name = sym.jsName
  return taken
}

const externalBindings = (r: Resolution): string[] =>
  [...r.globals.values()]
    .filter((sym) => sym.kind === 'external')
    .map((sym) => `const ${sym.jsName} = $.functions.${sym.name};`)

const didYouMean = (near: readonly string[]): string =>
  `did you mean ${near.map((s) => `\`${s}\``).join(', ')}?`

/** Unknown names fail at build time, not in the browser. */
function unknownNames(
  { report, where, functions, externals }: Ctx,
  r: Resolution,
  taken: ReadonlySet<string>,
): void {
  const known = [...taken, ...r.builtins.keys()]
  for (const [accessor, sym] of r.refs) {
    if (sym) continue
    const name = rootName(accessor)
    if (name === OUT || name === POS || name === RESULT || /^dio_/.test(name) || isTsl(name))
      continue
    const near = similar(name, known)
    const hint =
      SHADERTOY_MISSING[name] ?? (near.length ? didYouMean(near) : 'declare a variable or uniform')
    report.add(
      'GLSL_UNKNOWN_IDENTIFIER',
      where(name, r.owner.get(accessor)?.name),
      `unknown identifier \`${name}\``,
      hint,
    )
  }
  const fnNames = [
    ...functions.map((f) => f.name),
    ...externals.map((p) => p.name),
    ...Object.keys(tsl),
  ]
  for (const [call, sym] of r.calls) {
    if (sym || isTsl(call.name) || LOOKUPS.has(call.name)) continue
    if (call.name === 'array') {
      report.add('GLSL_ARRAY', where('{', r.owner.get(call)?.name), NO_ARRAYS, NO_ARRAYS_HINT)
      continue
    }
    const near = similar(call.name, fnNames)
    report.add(
      'GLSL_UNKNOWN_FUNCTION',
      where(call.name, r.owner.get(call)?.name),
      `unknown function \`${call.name}\``,
      near.length
        ? didYouMean(near)
        : 'declare a prototype and pass its body in `glslEffect({ functions })`',
    )
  }
}

/** Only functions that read nothing but their inputs get a layout. */
function layouts({ program, entry, functions }: Ctx, r: Resolution): void {
  const impure = new Set<Ast>([entry])
  const deps = new Map<Ast, Set<Ast>>()
  for (const fn of functions) deps.set(fn, new Set())
  const taint = (fn: Ast | undefined): void => {
    if (fn) impure.add(fn)
  }
  const outside = new Set<Kind>(['uniform', 'varying', 'global', 'builtin'])
  for (const [accessor, sym] of r.refs) {
    if (!sym || outside.has(sym.kind)) taint(r.owner.get(accessor))
  }
  for (const [call, sym] of r.calls) {
    const fn = r.owner.get(call)
    if (!fn) continue
    if (sym?.kind === 'external' || LOOKUPS.has(call.name)) taint(fn)
    else if (sym?.kind === 'function')
      for (const f of functions)
        if (f.name === sym.jsName || f.name === sym.name) deps.get(fn)?.add(f)
  }
  const struct = (t: string): boolean => program.structTypes.has(t)
  for (const fn of functions) {
    if (struct(fn.type) || fn.params.some((p) => struct(p.type))) impure.add(fn)
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [fn, list] of deps) {
      if (impure.has(fn)) continue
      if ([...list].some((d) => impure.has(d))) {
        impure.add(fn)
        changed = true
      }
    }
  }
  for (const fn of impure) fn.layout = false
}

const declarationsOf = (r: Resolution): Ast[] =>
  r.locals.flatMap((l) => (l.kind === 'local' && l.node?.isVariableDeclaration ? [l.node] : []))

function dropUnused(program: Ast, r: Resolution): void {
  const used = new Set<Ast | undefined>()
  for (const sym of r.refs.values()) used.add(sym?.node)
  program.body = program.body.filter((s) => !((s.isUniform || s.isVarying) && !used.has(s)))
}

export function replaceChild(parent: Ast, old: Ast, next: Ast): void {
  const record = parent as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key === 'parent' || key === 'linker') continue
    const value = record[key]
    if (value === old) record[key] = next
    else if (Array.isArray(value)) {
      const i = value.indexOf(old)
      if (i >= 0) value[i] = next
    }
  }
  next.parent = parent
}

/** Why a fragment can't be a uv stage. convert turns it into the message. */
export type UvBlocker =
  | 'vertex'
  | 'no-image'
  | 'not-once'
  | 'other-textures'
  | 'early-return'
  | 'discard'
  | 'not-last'

/**
 * The uv stage's image read, `dio_out = texture(S, X)`, sits right before main's final
 * `return dio_out`. `uvBlocker` checks that shape and `toUvStage` relies on it.
 */
const imageReadAt = (body: readonly Ast[]): number => body.length - 2

/**
 * A uv stage reads the image once, as main's last statement `out = texture(S, X)`, with no
 * other textures, `discard` or early returns. main then returns X.
 */
function uvBlocker(
  entry: Ast,
  program: Ast,
  image: {
    readonly media: string | undefined
    readonly mediaReads: number
    readonly otherReads: number
    readonly earlyMain: boolean
  },
): UvBlocker | undefined {
  const { media } = image
  if (!media) return 'no-image'
  if (image.mediaReads !== 1) return 'not-once'
  if (image.otherReads) return 'other-textures'
  if (image.earlyMain) return 'early-return'
  let discard = false
  walk(program, (n) => {
    if (n.isDiscard) discard = true
  })
  if (discard) return 'discard'
  const read = entry.body[imageReadAt(entry.body)]
  const call = read?.right
  const s = call?.params?.[0]
  let outRefs = 0
  walk(entry, (n) => {
    if (n.isAccessor && rootName(n) === OUT) outRefs++
  })
  // The declaration has no accessor; the write and the final return have one each.
  const plain =
    read?.isOperator &&
    read.type === '=' &&
    read.left.isAccessor &&
    read.left.property === OUT &&
    call?.isFunctionCall &&
    MEDIA_ONLY.has(call.name) &&
    s?.isAccessor &&
    s.property === media &&
    call.params.length === 2 &&
    outRefs === 2
  return plain ? undefined : 'not-last'
}

/** Makes main return the sampling coordinate for the uv stage. */
export function toUvStage(entry: Ast): void {
  const body = entry.body
  const at = imageReadAt(body)
  const coordinate = (body[at] as Ast).right.params[1] as Ast
  body.splice(at, 2, new AST.Return(coordinate))
  const decl = body.findIndex((s) => s.isVariableDeclaration && s.name === OUT)
  if (decl >= 0) body.splice(decl, 1)
  entry.type = 'vec2'
  relink(entry)
}
