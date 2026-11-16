// @diorama/glsl/convert: GLSL to TSL at build time, in Node.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ParamDefault } from '@diorama/effects'
import { REVISION } from 'three/webgpu'
import { effectName } from '../effect-name'
import type { Binding, GlslDiagnostic, GlslShader } from '../types'
import { walk } from './ast'
import { bind } from './bindings'
import { decode } from './decoder'
import { encode } from './encoder'
import { PORT_BY_HAND, Reporter, sorted } from './errors'
import { block, literal, type ModuleParts, moduleCode, paramsType, propertyKey } from './module'
import { analyze, isTsl, toUvStage, type UvBlocker, zeroOf } from './passes'
import { type IncludeReader, type IncludeResult, prepare } from './prepare'

export type { GlslCode, GlslDiagnostic } from '../types'
export { format as formatDiagnostic, GlslError } from './errors'
export type { IncludeReader, IncludeResult } from './prepare'

export interface ConvertOptions {
  /** For messages and #include resolution. Default 'shader.glsl'. */
  readonly filename?: string
  /** Default: kebab-case file stem. */
  readonly name?: string
  readonly stage?: 'auto' | 'uv' | 'color' | 'position'
  readonly dialect?: 'auto' | 'three' | 'glsl3' | 'shadertoy'
  /** Binding overrides by GLSL uniform name. */
  readonly bindings?: { readonly [uniform: string]: Binding }
  readonly defaults?: { readonly [uniform: string]: ParamDefault }
  readonly colorSpace?: 'srgb' | 'linear'
  /** Default reads files relative to `from` and resolves bare specifiers like Node. */
  readonly include?: IncludeReader
  /** Folder of the generated module, for relative `@texture` URLs. Default: the shader's. */
  readonly outDir?: string
}
export interface ConvertResult {
  readonly code: string
  /** The companion `.d.ts`, with exact param types. */
  readonly declaration: string
  readonly shader: Omit<GlslShader, 'build'>
  /** Warnings and infos. Errors throw GlslError. */
  readonly diagnostics: readonly GlslDiagnostic[]
  /** Included files, to watch. */
  readonly includes: readonly string[]
  readonly stats: { readonly glslLines: number; readonly tslLines: number; readonly fixes: number }
}

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

const UV_BLOCKERS: Record<UvBlocker, string> = {
  vertex: 'it is a vertex shader',
  'no-image': 'there is no element image',
  'not-once': 'the image is not sampled exactly once',
  'other-textures': 'other textures are sampled',
  'early-return': 'there is an early return',
  discard: 'there is a discard',
  'not-last': 'the last statement of main is not a plain `gl_FragColor = texture(image, uv)`',
}

/** Result with the module split into parts, for loaders that inline stages. */
export interface Converted extends ConvertResult {
  readonly parts: ModuleParts
}

export function convertParts(source: string, options: ConvertOptions = {}): Converted {
  const filename = options.filename ?? 'shader.glsl'
  const report = new Reporter()
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
  const bindings = options.bindings ?? {}
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

  // The pragma wins over the option, the option over inference.
  const pragma = prepared.pragma
  const requested = pragma.stage ?? options.stage ?? 'auto'
  const vertex = prepared.stage === 'vertex'
  let stage: GlslShader['stage'] = vertex ? 'position' : 'color'
  const at = prepared.find(analysis.entry.name)
  if (vertex && requested !== 'auto' && requested !== 'position') {
    report.add(
      'GLSL_STAGE',
      at,
      `a vertex shader cannot be a ${requested} stage`,
      'remove `stage` or use `stage=position`',
    )
  } else if (!vertex) {
    if (requested === 'position') {
      report.add(
        'GLSL_STAGE',
        at,
        'the position stage is for vertex shaders only',
        'remove `stage=position`',
      )
    } else if (requested === 'uv' && analysis.uvBlocker) {
      report.add(
        'GLSL_STAGE',
        at,
        `cannot use the uv stage: ${UV_BLOCKERS[analysis.uvBlocker]}`,
        'remove `stage=uv` to make the shader a color stage',
      )
    } else if (requested === 'uv' || (requested === 'auto' && !analysis.uvBlocker)) {
      stage = 'uv'
      toUvStage(analysis.entry)
    }
  }

  // Locals declared without a value start at zero, as three's `property()` cannot be assigned.
  walk(program, (n) => {
    if (!n.isVariableDeclaration || n.value) return
    n.value = zeroOf(n.type, program)
    n.value.parent = n
  })

  // Without a pragma, animate follows from the bound inputs.
  const binds = Object.values(bound.uniforms).map((u) => u.bind)
  const has = (input: string): boolean => binds.includes(`input:${input}` as Binding)
  const animateFromPragma = ['input', 'hover', 'visible'].includes(pragma.animate ?? '')
  const animate = (
    animateFromPragma
      ? pragma.animate
      : has('time')
        ? 'visible'
        : has('hoverTime') || has('hover')
          ? 'hover'
          : 'input'
  ) as GlslShader['animate']
  if (!animateFromPragma && has('time') && ['hover', 'velocity', 'progress', 'pin'].some(has)) {
    report.add(
      'GLSL_ANIMATE',
      prepared.find(
        analysis.uniforms.find((u) => bound.uniforms[u.name]?.bind === 'input:time')?.name ??
          'main',
      ),
      'the shader renders every frame while visible',
      'if it moves only under the pointer, `uHoverTime` instead of `uTime` (or `// @diorama animate=hover`) skips frames at rest',
    )
  }
  if (REVISION !== '187') {
    report.add(
      'GLSL_THREE_REVISION',
      { file: filename, line: 1, column: 1 },
      `three r${REVISION}: the converter is tested against r187`,
      'use three r187 or check that converted effects render as expected',
    )
  }
  report.throwIfErrors()

  let encoded: ReturnType<typeof encode>
  try {
    encoded = encode(program, analysis.declared)
  } catch (error) {
    report.add(
      'GLSL_TRANSPILER',
      at,
      `three's encoder failed: ${(error as Error).message}`,
      PORT_BY_HAND,
    )
    throw report.failure()
  }
  const imports = [...new Set([...encoded.imports, ...analysis.imports])].filter(isTsl).sort()
  const file = basename(filename)
  // Pragma paths are relative to the declaring file, which may be an include. URLs are relative
  // to the module.
  const outDir = resolve(options.outDir ?? dirname(resolve(filename)))
  const textures = Object.fromEntries(
    Object.entries(bound.textures).map(([u, t]) => {
      const path = relative(outDir, resolve(dirname(resolve(t.from)), t.path)).replace(/\\/g, '/')
      return [u, /^\.\.?\//.test(path) ? path : `./${path}`]
    }),
  )
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
  }
  const pad = (text: string): string =>
    text
      .split('\n')
      .map((line) => (line ? `    ${line}` : line))
      .join('\n')
  const build = [...analysis.prologue, encoded.body, `return ${analysis.entry.name}();`].join('\n')
  // The encoder can still emit invalid JS. Parse the body, without running it, before shipping.
  try {
    new Function('$', build)
  } catch (error) {
    report.add(
      'GLSL_TRANSPILER',
      at,
      `three's encoder produced invalid JS: ${(error as Error).message}`,
      PORT_BY_HAND,
    )
    throw report.failure()
  }
  const urls = Object.entries(textures).map(
    ([u, path]) => `${u}: new URL(${literal(path)}, import.meta.url).href`,
  )
  const value = (k: string, v: unknown): string =>
    k !== 'textures' ? literal(v, '  ') : urls.length ? block(urls, '  ') : '{}'
  const object = block([
    ...Object.entries(shader).map(([k, v]) => `${propertyKey(k)}: ${value(k, v)}`),
    `build($) {\n${pad(build)}\n  }`,
  ])
  const header = `// Generated by @diorama/glsl from ${file} (three r${REVISION}). Edit the GLSL, not this file.`
  const parts: ModuleParts = { header, imports, object }
  const code = moduleCode(parts)

  const declaration = [
    `// Generated by @diorama/glsl from ${file}. Edit the GLSL, not this file.`,
    "import type { GlslShader } from '@diorama/glsl'",
    `declare const shader: GlslShader<${paramsType(shader.params)}>`,
    'export default shader',
    '',
  ].join('\n')
  const count = (text: string, comments: RegExp): number =>
    text.split(/\r?\n/).filter((l) => l.trim() && !comments.test(l.trim())).length
  return {
    code,
    declaration,
    shader,
    diagnostics: sorted(report.list.filter((d) => d.severity !== 'error')),
    includes: prepared.includes,
    stats: {
      glslLines: count(source, /^(\/\/|\/\*|\*)/),
      tslLines: count(code, /^\/\//),
      fixes: analysis.fixes.size,
    },
    parts,
  }
}

/** Converts one GLSL stage into a `GlslShader` module. Throws `GlslError` with every problem. */
export function convert(source: string, options: ConvertOptions = {}): ConvertResult {
  const { parts: _, ...result } = convertParts(source, options)
  return result
}
