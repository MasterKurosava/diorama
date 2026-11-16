import type { ParamSpec } from '@diorama/effects'
import type { Node } from 'three/webgpu'

export type GlslType = 'float' | 'int' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'sampler2D'

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

export interface GlslDiagnostic {
  readonly code: GlslCode
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
  /** What to change, in one line. */
  readonly hint: string | undefined
  readonly file: string
  readonly line: number
  readonly column: number
  /** Three source lines with a caret, for terminals and the Vite overlay. */
  readonly frame: string
}

export interface SamplerLike {
  sample(uv: Node<'vec2'>): Node<'vec4'>
}

export interface ShaderScope {
  readonly uniforms: { readonly [name: string]: Node | SamplerLike }
  /** Box UV after earlier uv transforms, or the plane UV in a position stage. */
  readonly uv: Node<'vec2'>
  /** Box UV before transforms (gl_FragCoord). */
  readonly box: Node<'vec2'>
  readonly fragCoord: Node<'vec4'>
  /** Position stage only: the vertex in the plane's local unit square. */
  readonly position: Node<'vec3'> | undefined
  readonly varyings: { readonly [name: string]: Node }
  readonly functions: { readonly [name: string]: (...args: Node[]) => Node }
}

export interface UniformInfo {
  readonly type: GlslType
  readonly bind: Binding
}

/** Default export of a `?shader` import. `build` needs nothing but `three/tsl`. */
export interface GlslShader<P extends ParamSpec = ParamSpec> {
  readonly '~glsl': 1
  readonly name: string
  readonly file: string
  readonly dialect: 'three' | 'glsl3' | 'shadertoy'
  readonly stage: 'uv' | 'color' | 'position'
  readonly media: boolean
  readonly colorSpace: 'srgb' | 'linear'
  readonly animate: 'input' | 'hover' | 'visible'
  readonly animateFromPragma: boolean
  readonly segments: number
  readonly bleed: number
  readonly params: P
  readonly uniforms: { readonly [name: string]: UniformInfo }
  /** Varyings this stage reads (fragment) or writes (vertex), besides uv. */
  readonly varyings: { readonly [name: string]: GlslType }
  readonly writes: readonly string[]
  /** Prototypes the caller provides through `functions`. */
  readonly externals: readonly string[]
  /** URLs from `// @texture ./file` pragmas, by uniform name. */
  readonly textures: { readonly [uniform: string]: string }
  /** Runs on every material build. Returns vec2 for uv, vec4 for color, vec3 for position. */
  build(scope: ShaderScope): Node
}
