// @dioramajs/glsl/convert: GLSL to TSL at build time, in Node.
//
// The pipeline, one stage per module:
//   1. prepare   text pass: expands includes, reads pragmas, fixes what three's decoder misreads
//   2. decode    three's GLSLDecoder turns the text into an AST
//   3. analyze   AST passes around three's Linker: rewrites, checks and the facts the module needs
//   4. bind      uniforms become params, inputs, textures or the element's media
//   5. choose the stage (uv, color, position) and when the effect animates
//   6. encode    three's TSLEncoder turns the AST into the body of `build`
//   7. assemble the module and its `.d.ts`
// Every stage reports into one Reporter. Errors end the conversion with a GlslError.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ParamDefault } from '@dioramajs/effects'
import { REVISION } from 'three/webgpu'
import { effectName } from '../effect-name'
import type { Binding, GlslDiagnostic, GlslShader } from '../types'
import { type Ast, walk } from './ast'
import { type Bound, bind } from './bindings'
import { decode } from './decoder'
import { encode } from './encoder'
import { PORT_BY_HAND, type Position, Reporter, sorted } from './errors'
import { block, literal, type ModuleParts, moduleCode, paramsType, propertyKey } from './module'
import { type Analysis, analyze, isTsl, toUvStage, type UvBlocker, zeroOf } from './passes'
import { type IncludeReader, type IncludeResult, type Prepared, prepare } from './prepare'

export type { GlslCode, GlslDiagnostic } from '../types'
export { format as formatDiagnostic, GlslError } from './errors'
export { type EntryMeta, entryMeta, entryModule } from './module'
export type { IncludeReader, IncludeResult } from './prepare'

/** Options of `convert`. */
export interface ConvertOptions {
  /** For messages and #include resolution. Default 'shader.glsl'. */
  readonly filename?: string
  /** Default: kebab-case file stem. */
  readonly name?: string
  /** What the shader changes. `auto` infers it from the code. */
  readonly stage?: 'auto' | 'uv' | 'color' | 'position'
  /** GLSL flavour. `auto` infers it from the code. */
  readonly dialect?: 'auto' | 'three' | 'glsl3' | 'shadertoy'
  /** Binding overrides by GLSL uniform name. */
  readonly bindings?: { readonly [uniform: string]: Binding }
  /** Default values of params by GLSL uniform name. */
  readonly defaults?: { readonly [uniform: string]: ParamDefault }
  /** Colour space of the output. */
  readonly colorSpace?: 'srgb' | 'linear'
  /** Default reads files relative to `from` and resolves bare specifiers like Node. */
  readonly include?: IncludeReader
  /** Folder of the generated module, for relative `@texture` URLs. Default: the shader's. */
  readonly outDir?: string
}
/** What `convert` returns. */
export interface ConvertResult {
  /** The TSL module. */
  readonly code: string
  /** The companion `.d.ts`, with exact param types. */
  readonly declaration: string
  /** Shader metadata, as the module exports it. */
  readonly shader: Omit<GlslShader, 'build'>
  /** Warnings and infos. Errors throw GlslError. */
  readonly diagnostics: readonly GlslDiagnostic[]
  /** Included files, to watch. */
  readonly includes: readonly string[]
  /** Line counts and the number of fixes applied. */
  readonly stats: { readonly glslLines: number; readonly tslLines: number; readonly fixes: number }
}

/** Result with the module split into parts, for loaders that inline stages. */
export interface Converted extends ConvertResult {
  /** The module in parts. */
  readonly parts: ModuleParts
}

type Animate = GlslShader['animate']

const UV_BLOCKERS: Record<UvBlocker, string> = {
  vertex: 'it is a vertex shader',
  'no-image': 'there is no element image',
  'not-once': 'the image is not sampled exactly once',
  'other-textures': 'other textures are sampled',
  'early-return': 'there is an early return',
  discard: 'there is a discard',
  'not-last': 'the last statement of main is not a plain `gl_FragColor = texture(image, uv)`',
}

/** Pragma values of `animate` that are taken as they are. */
const ANIMATE_PRAGMAS = ['input', 'hover', 'visible']
/** Inputs that suggest a shader moves only under the pointer or with scroll. */
const EVENT_INPUTS = ['hover', 'velocity', 'progress', 'pin']
/** The three revision the converter is tested against. */
const TESTED_REVISION = '187'

/** Default include reader: relative to the including file, then as a package path. */
export function readInclude(spec: string, from: string): IncludeResult {
  const base = dirname(resolve(from))
  const local = resolve(base, spec)
  if (existsSync(local)) return { path: local, code: readFileSync(local, 'utf8') }
  if (spec.startsWith('.') || isAbsolute(spec)) return undefined
  try {
    const path = createRequire(resolve(from)).resolve(spec)
    return { path, code: readFileSync(path, 'utf8') }
  } catch {
    return undefined
  }
}

/**
 * Like `convert`, with the module also split into parts.
 * @throws {GlslError} With every error diagnostic of the stage.
 */
export function convertParts(source: string, options: ConvertOptions = {}): Converted {
  const filename = options.filename ?? 'shader.glsl'
  const report = new Reporter()
  const bindings = options.bindings ?? {}

  const prepared = prepare(
    source,
    {
      filename,
      include: options.include ?? readInclude,
      dialect: options.dialect ?? 'auto',
      vertex: options.stage === 'position' ? true : undefined,
    },
    report,
  )
  const program = decode(prepared, report)
  const analysis = program && analyze(program, prepared, report, { bindings })
  // decode and analyze always report an error before giving up.
  if (!program || !analysis) throw report.failure()
  const bound = bind(
    {
      uniforms: analysis.uniforms,
      used: analysis.used,
      media: analysis.media,
      dialect: prepared.dialect,
      options: { bindings, defaults: options.defaults ?? {} },
      ratioOnly: (name) => analysis.ratioOnly.has(name),
      exists: (path, from) => existsSync(resolve(dirname(resolve(from)), path)),
    },
    report,
  )

  const entryAt = prepared.find(analysis.entry.name)
  const stage = chooseStage(prepared, analysis, options, entryAt, report)
  startLocalsAtZero(program)
  const binds = Object.values(bound.uniforms).map((uniform) => uniform.bind)
  const { animate, animateFromPragma } = chooseAnimate(prepared, analysis, bound, binds, report)
  if (REVISION !== TESTED_REVISION) {
    report.add(
      'GLSL_THREE_REVISION',
      { file: filename, line: 1, column: 1 },
      `three r${REVISION}: the converter is tested against r${TESTED_REVISION}`,
      `use three r${TESTED_REVISION} or check that converted effects render as expected`,
    )
  }
  report.throwIfErrors()

  const encoded = encodeProgram(program, analysis, entryAt, report)
  const file = basename(filename)
  const textures = textureUrls(bound, options.outDir ?? dirname(resolve(filename)))
  const { pragma } = prepared
  const shader: Omit<GlslShader, 'build'> = {
    '~glsl': 1,
    name: options.name ?? pragma.name ?? effectName(filename),
    file,
    dialect: prepared.dialect,
    stage,
    media: binds.includes('media'),
    colorSpace:
      (pragma.colorSpace ?? options.colorSpace ?? 'srgb') === 'linear' ? 'linear' : 'srgb',
    animate,
    animateFromPragma,
    segments: Math.max(1, Math.floor(Number(pragma.segments)) || 1),
    bleed: Math.max(0, Number(pragma.bleed) || 0),
    params: bound.params,
    uniforms: bound.uniforms,
    varyings: analysis.varyings as GlslShader['varyings'],
    writes: analysis.writes,
    externals: analysis.externals,
    textures,
    // Only when set, so a module without these pragmas has no such keys.
    ...(pragma.when && { when: pragma.when }),
    ...(pragma.reducedMotion && {
      reducedMotion: pragma.reducedMotion as NonNullable<GlslShader['reducedMotion']>,
    }),
    ...(pragma.presence && { presence: pragma.presence as NonNullable<GlslShader['presence']> }),
  }
  const build = [...analysis.prologue, encoded.body, `return ${analysis.entry.name}();`].join('\n')
  checkBuildParses(build, entryAt, report)

  const imports = [...new Set([...encoded.imports, ...analysis.imports])].filter(isTsl).sort()
  const header = `// Generated by @dioramajs/glsl from ${file} (three r${REVISION}). Edit the GLSL, not this file.`
  const parts: ModuleParts = { header, imports, object: shaderObject(shader, textures, build) }
  const code = moduleCode(parts)
  const declaration = [
    `// Generated by @dioramajs/glsl from ${file}. Edit the GLSL, not this file.`,
    "import type { GlslShader } from '@dioramajs/glsl'",
    `declare const shader: GlslShader<${paramsType(shader.params)}>`,
    'export default shader',
    '',
  ].join('\n')
  return {
    code,
    declaration,
    shader,
    diagnostics: sorted(report.list.filter((diagnostic) => diagnostic.severity !== 'error')),
    includes: prepared.includes,
    stats: {
      glslLines: countLines(source, /^(\/\/|\/\*|\*)/),
      tslLines: countLines(code, /^\/\//),
      fixes: analysis.fixes.size,
    },
    parts,
  }
}

/**
 * Converts one GLSL stage into a `GlslShader` module.
 * @throws {GlslError} With every error diagnostic of the stage; `diagnostics` holds the codes.
 */
export function convert(source: string, options: ConvertOptions = {}): ConvertResult {
  const { parts: _, ...result } = convertParts(source, options)
  return result
}

/**
 * What the shader changes. The pragma wins over the option, the option over inference. A fragment
 * that samples the element's image once and does nothing else with it becomes a uv stage, which
 * rewrites its entry to return the sampling coordinate.
 */
function chooseStage(
  prepared: Prepared,
  analysis: Analysis,
  options: ConvertOptions,
  entryAt: Position,
  report: Reporter,
): GlslShader['stage'] {
  const requested = prepared.pragma.stage ?? options.stage ?? 'auto'
  if (prepared.stage === 'vertex') {
    if (requested !== 'auto' && requested !== 'position') {
      report.add(
        'GLSL_STAGE',
        entryAt,
        `a vertex shader cannot be a ${requested} stage`,
        'remove `stage` or use `stage=position`',
      )
    }
    return 'position'
  }
  if (requested === 'position') {
    report.add(
      'GLSL_STAGE',
      entryAt,
      'the position stage is for vertex shaders only',
      'remove `stage=position`',
    )
  } else if (requested === 'uv' && analysis.uvBlocker) {
    report.add(
      'GLSL_STAGE',
      entryAt,
      `cannot use the uv stage: ${UV_BLOCKERS[analysis.uvBlocker]}`,
      'remove `stage=uv` to make the shader a color stage',
    )
  } else if (requested === 'uv' || (requested === 'auto' && !analysis.uvBlocker)) {
    toUvStage(analysis.entry)
    return 'uv'
  }
  return 'color'
}

/** Locals declared without a value start at zero, as three's `property()` cannot be assigned. */
function startLocalsAtZero(program: Ast): void {
  walk(program, (node) => {
    if (!node.isVariableDeclaration || node.value) return
    node.value = zeroOf(node.type, program)
    node.value.parent = node
  })
}

/**
 * When the effect draws frames. Without a pragma it follows from the bound inputs: time means
 * every frame while visible, hover time or hover only under the pointer, anything else only when
 * an input changes.
 */
function chooseAnimate(
  prepared: Prepared,
  analysis: Analysis,
  bound: Bound,
  binds: readonly Binding[],
  report: Reporter,
): { animate: Animate; animateFromPragma: boolean } {
  const { pragma } = prepared
  const has = (input: string): boolean => binds.includes(`input:${input}` as Binding)
  const animateFromPragma = ANIMATE_PRAGMAS.includes(pragma.animate ?? '')
  if (animateFromPragma) return { animate: pragma.animate as Animate, animateFromPragma }
  const animate: Animate = has('time')
    ? 'visible'
    : has('hoverTime') || has('hover')
      ? 'hover'
      : 'input'
  if (has('time') && EVENT_INPUTS.some(has)) {
    const timeUniform = analysis.uniforms.find(
      (uniform) => bound.uniforms[uniform.name]?.bind === 'input:time',
    )
    report.add(
      'GLSL_ANIMATE',
      prepared.find(timeUniform?.name ?? 'main'),
      'the shader renders every frame while visible',
      'if it moves only under the pointer, `uHoverTime` instead of `uTime` (or `// @diorama animate=hover`) skips frames at rest',
    )
  }
  return { animate, animateFromPragma }
}

function encodeProgram(
  program: Ast,
  analysis: Analysis,
  entryAt: Position,
  report: Reporter,
): ReturnType<typeof encode> {
  try {
    return encode(program, analysis.declared)
  } catch (error) {
    report.add(
      'GLSL_TRANSPILER',
      entryAt,
      `three's encoder failed: ${(error as Error).message}`,
      PORT_BY_HAND,
    )
    throw report.failure()
  }
}

/** The encoder can still emit invalid JS. Parse the body, without running it, before shipping. */
function checkBuildParses(build: string, entryAt: Position, report: Reporter): void {
  try {
    new Function('$', build)
  } catch (error) {
    report.add(
      'GLSL_TRANSPILER',
      entryAt,
      `three's encoder produced invalid JS: ${(error as Error).message}`,
      PORT_BY_HAND,
    )
    throw report.failure()
  }
}

/**
 * `@texture` paths by uniform, relative to the generated module. Pragma paths are relative to the
 * file that declares them, which may be an include.
 */
function textureUrls(bound: Bound, outDir: string): Record<string, string> {
  const base = resolve(outDir)
  return Object.fromEntries(
    Object.entries(bound.textures).map(([uniform, texture]) => {
      const absolute = resolve(dirname(resolve(texture.from)), texture.path)
      const path = relative(base, absolute).replace(/\\/g, '/')
      return [uniform, /^\.\.?\//.test(path) ? path : `./${path}`]
    }),
  )
}

/** The default export: shader metadata, texture URLs resolved by the bundler, and `build`. */
function shaderObject(
  shader: Omit<GlslShader, 'build'>,
  textures: Record<string, string>,
  build: string,
): string {
  const urls = Object.entries(textures).map(
    ([uniform, path]) => `${uniform}: new URL(${literal(path)}, import.meta.url).href`,
  )
  const valueCode = (key: string, value: unknown): string =>
    key !== 'textures' ? literal(value, '  ') : urls.length ? block(urls, '  ') : '{}'
  return block([
    ...Object.entries(shader).map(
      ([key, value]) => `${propertyKey(key)}: ${valueCode(key, value)}`,
    ),
    `build($) {\n${indent(build)}\n  }`,
  ])
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line ? `    ${line}` : line))
    .join('\n')

/** Lines that hold code: not blank and not matching `comments`. */
const countLines = (text: string, comments: RegExp): number =>
  text.split(/\r?\n/).filter((line) => line.trim() && !comments.test(line.trim())).length
