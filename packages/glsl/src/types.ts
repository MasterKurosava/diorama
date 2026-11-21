import type { ParamSpec, When } from '@dioramajs/effects'
import type { Node } from 'three/webgpu'

/** GLSL types a uniform or varying can have. */
export type GlslType = 'float' | 'int' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'sampler2D'

/** Built-in inputs a uniform can bind to, as `input:<name>`. */
export type ShaderInput =
  | 'time'
  | 'hoverTime'
  | 'hover'
  | 'progress'
  | 'velocity'
  | 'pin'
  | 'motion'
  | 'pointer'
  | 'pointerNdc'
  | 'pointerPx'
  | 'mouse4'
  | 'size'
  | 'size3'
  | 'sizePx'
  | 'sizePx3'

/** Where a uniform's value comes from. */
export type Binding =
  | 'media'
  | `input:${ShaderInput}`
  | `param:${string}`
  | `texture:${string}`
  | 'none'

/** Codes of conversion diagnostics: errors, warnings and notes. */
export type GlslCode =
  // errors
  | 'GLSL_SYNTAX'
  | 'GLSL_NO_ENTRY'
  | 'GLSL_INCLUDE'
  | 'GLSL_GLSLIFY'
  | 'GLSL_OUTPUT'
  | 'GLSL_INOUT'
  | 'GLSL_EARLY_RETURN'
  | 'GLSL_ARRAY'
  | 'GLSL_GLOBAL_STATE'
  | 'GLSL_SAMPLER'
  | 'GLSL_UNIFORM_TYPE'
  | 'GLSL_UNSUPPORTED_TYPE'
  | 'GLSL_NAME_CLASH'
  | 'GLSL_STAGE'
  | 'GLSL_VERTEX'
  | 'GLSL_UNKNOWN_IDENTIFIER'
  | 'GLSL_UNKNOWN_FUNCTION'
  | 'GLSL_TRANSPILER'
  | 'GLSL_TEXTURE'
  | 'GLSL_PRAGMA'
  // warnings
  | 'GLSL_UNUSED'
  | 'GLSL_MOUSE'
  | 'GLSL_LOD'
  | 'GLSL_PARAM_DEFAULT'
  | 'GLSL_PARAM_RESERVED'
  | 'GLSL_VARYING_WRITE'
  | 'GLSL_THREE_REVISION'
  | 'GLSL_SEMANTICS'
  // info
  | 'GLSL_TOVAR'
  | 'GLSL_SINGLE_EXIT'
  | 'GLSL_RENAMED'
  | 'GLSL_COVER'
  | 'GLSL_FRAGCOORD'
  | 'GLSL_ANIMATE'

/** A problem or note found while converting GLSL. */
export interface GlslDiagnostic {
  /** Diagnostic code, the key of its page in the docs. */
  readonly code: GlslCode
  /** Errors stop the conversion, warnings and notes do not. */
  readonly severity: 'error' | 'warning' | 'info'
  /** What was found. */
  readonly message: string
  /** What to change, in one line. */
  readonly hint: string | undefined
  /** File of the problem. */
  readonly file: string
  /** Line, from 1. */
  readonly line: number
  /** Column, from 1. */
  readonly column: number
  /** Three source lines with a caret, for terminals and the Vite overlay. */
  readonly frame: string
}

/** A texture uniform that can be sampled at any UV. */
export interface SamplerLike {
  /** Samples the texture at `uv`. */
  sample(uv: Node<'vec2'>): Node<'vec4'>
}

/** Nodes a shader's `build` reads. */
export interface ShaderScope {
  /** Uniform nodes and samplers by GLSL name. */
  readonly uniforms: { readonly [name: string]: Node | SamplerLike }
  /** Box UV after earlier uv transforms, or the plane UV in a position stage. */
  readonly uv: Node<'vec2'>
  /** Box UV before transforms (gl_FragCoord). */
  readonly box: Node<'vec2'>
  /** gl_FragCoord in CSS px of the box. */
  readonly fragCoord: Node<'vec4'>
  /** Position stage only: the vertex in the plane's local unit square. */
  readonly position: Node<'vec3'> | undefined
  /** Varying nodes by GLSL name. */
  readonly varyings: { readonly [name: string]: Node }
  /** TSL bodies of GLSL prototypes by name. */
  readonly functions: { readonly [name: string]: ShaderFunction }
}

/**
 * TSL body of a GLSL prototype, called with the arguments in GLSL order. Their node types are
 * known only in the shader, so an argument fits any TSL call; annotate it to narrow it:
 * `(p: Node<'vec2'>) => …`.
 */
// biome-ignore lint/suspicious/noExplicitAny: GLSL argument types are not known to TypeScript
export type ShaderFunction = (...args: any[]) => Node

/** Type and binding of one uniform. */
export interface UniformInfo {
  /** GLSL type. */
  readonly type: GlslType
  /** Where the value comes from. */
  readonly bind: Binding
}

/** Default export of a `?shader` import. `build` needs nothing but `three/tsl`. */
export interface GlslShader<P extends ParamSpec = ParamSpec> {
  /** Marks a converted shader. */
  readonly '~glsl': 1
  /** Effect name, from the file name or the pragma. */
  readonly name: string
  /** Source file. */
  readonly file: string
  /** GLSL flavour the source was written in. */
  readonly dialect: 'three' | 'glsl3' | 'shadertoy'
  /** What the shader changes: the UV, the colour or the vertex position. */
  readonly stage: 'uv' | 'color' | 'position'
  /** Whether it reads the element's image. */
  readonly media: boolean
  /** Colour space of its output. */
  readonly colorSpace: 'srgb' | 'linear'
  /** Frame policy of the effect. */
  readonly animate: 'input' | 'hover' | 'visible'
  /** Whether `animate` comes from a pragma rather than the inputs it reads. */
  readonly animateFromPragma: boolean
  /** Plane segments per side, for position stages. */
  readonly segments: number
  /** Extra space around the box, CSS px. */
  readonly bleed: number
  /** Params of the effect, from `param:` uniforms. */
  readonly params: P
  /** Uniforms by GLSL name. */
  readonly uniforms: { readonly [name: string]: UniformInfo }
  /** Varyings this stage reads (fragment) or writes (vertex), besides uv. */
  readonly varyings: { readonly [name: string]: GlslType }
  /** Varyings a vertex shader writes. */
  readonly writes: readonly string[]
  /** Prototypes the caller provides through `functions`. */
  readonly externals: readonly string[]
  /** URLs from `// @texture ./file` pragmas, by uniform name. */
  readonly textures: { readonly [uniform: string]: string }
  /** `// @diorama when=…`: media query the page must match, `hover` for `(hover: hover)`. */
  readonly when?: When
  /** `// @diorama reducedMotion=static|off`. */
  readonly reducedMotion?: 'static' | 'off'
  /** `// @diorama presence=fade|custom`. */
  readonly presence?: 'fade' | 'custom'
  /** Runs on every material build. Returns vec2 for uv, vec4 for color, vec3 for position. */
  build(scope: ShaderScope): Node
}
