// Stage 4 of the converter: maps each uniform to a binding by file pragmas, converter options and
// naming convention, and gives every param its default.
import type { ParamDefault } from '@dioramajs/effects'
import {
  conventionOf,
  type Dialect,
  INPUT_TYPES,
  isInput,
  normalizeName,
  PARAM_NAME,
  paramName,
  RESERVED,
  VECTOR_SIZES,
} from '../names'
import type { Binding, GlslType, UniformInfo } from '../types'
import type { Reporter } from './errors'
import type { UniformDecl } from './prepare'

const SUPPORTED = new Set(['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'sampler2D'])

export interface BindingOptions {
  readonly bindings: { readonly [uniform: string]: Binding }
  readonly defaults: { readonly [uniform: string]: ParamDefault }
}
export interface BindingInput {
  readonly uniforms: readonly UniformDecl[]
  readonly used: ReadonlySet<string>
  readonly media: string | undefined
  readonly dialect: Dialect
  readonly options: BindingOptions
  /** The uniform is only read as `x / y` or `y / x` of itself. */
  readonly ratioOnly: (name: string) => boolean
  /** Whether a `@texture` path exists, relative to the file that declares it. */
  readonly exists: (path: string, from: string) => boolean
}
export interface Bound {
  readonly uniforms: Record<string, UniformInfo>
  readonly params: Record<string, ParamDefault>
  /** `@texture` paths, each relative to the file that declares it. */
  readonly textures: Record<string, { readonly path: string; readonly from: string }>
}

const color = (value: string): ParamDefault => ({ '~kind': 'color', value }) as ParamDefault
const hex = (numbers: number[]): string =>
  `#${numbers
    .slice(0, 3)
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** Whether a colour default has an alpha below 1, which a colour param cannot keep. */
function hasAlpha(words: readonly string[]): boolean {
  if (words.length === 4) return Number(words[3]) < 1
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(words[0] ?? '')?.[1]
  return !!hex && !/^f+$/i.test(hex.length === 4 ? hex.slice(3) : hex.slice(6))
}

/** A default from pragma words, checked against the GLSL type. */
function parseDefault(
  words: readonly string[],
  type: string,
  isColor: boolean,
): ParamDefault | undefined {
  if (isColor) {
    if (words.length === 1 && /^#|^[a-z]/i.test(words[0] as string))
      return color(words[0] as string)
    const numbers = words.map(Number)
    return numbers.length >= 3 && numbers.every(Number.isFinite) ? color(hex(numbers)) : undefined
  }
  if (type === 'bool') {
    const word = words[0]?.toLowerCase()
    return word === 'true' || word === '1' || word === 'on'
      ? true
      : word === 'false' || word === '0' || word === 'off'
        ? false
        : undefined
  }
  const numbers = words.map(Number)
  if (!numbers.length || !numbers.every(Number.isFinite)) return undefined
  const size = VECTOR_SIZES[type]
  if (!size) return numbers[0] as number
  const tuple = numbers.length === 1 ? Array(size).fill(numbers[0]) : numbers
  return tuple.length === size ? (tuple as unknown as ParamDefault) : undefined
}

function zero(type: string, isColor: boolean): ParamDefault {
  if (isColor) return color('#000000')
  if (type === 'bool') return false
  const size = VECTOR_SIZES[type]
  return size ? (Array(size).fill(0) as unknown as ParamDefault) : 0
}

/** A default given as an option, checked against the GLSL type. */
function checkDefault(value: ParamDefault, type: string, isColor: boolean): boolean {
  if (isColor && typeof value === 'object' && !Array.isArray(value)) return true
  if (Array.isArray(value)) return value.length === VECTOR_SIZES[type]
  if (typeof value === 'boolean') return type === 'bool'
  if (typeof value === 'number') return type === 'float' || type === 'int'
  return false
}

/**
 * Stage 4 of the converter. Each uniform gets one binding, tried in this order: unsupported
 * types and unused uniforms, samplers (media, `@texture` or a per-element image param), an
 * explicit `@input`/`@param` pragma or option, `@color`, and last the naming convention
 * (`uTime` is the time input, anything unknown becomes a param).
 */
export function bind(input: BindingInput, report: Reporter): Bound {
  const binder = new Binder(input, report)
  for (const decl of input.uniforms) binder.uniform(decl)
  return { uniforms: binder.uniforms, params: binder.params, textures: binder.textures }
}

class Binder {
  readonly uniforms: Record<string, UniformInfo> = {}
  readonly params: Record<string, ParamDefault> = {}
  readonly textures: Bound['textures'] = {}
  readonly #input: BindingInput
  readonly #report: Reporter
  /** Uniform that took each `param:` or `input:` key. */
  readonly #owners = new Map<string, string>()

  constructor(input: BindingInput, report: Reporter) {
    this.#input = input
    this.#report = report
  }

  uniform(decl: UniformDecl): void {
    if (this.uniforms[decl.name]) return
    const { type } = decl
    const option = this.#input.options.bindings[decl.name]
    if (decl.array || !SUPPORTED.has(type)) {
      if (option) this.#set(decl, option)
      else {
        this.#report.add(
          'GLSL_UNSUPPORTED_TYPE',
          decl.at,
          `uniform \`${decl.name}\`: ${decl.array ? 'arrays are' : `type ${type} is`} not supported`,
          'pass the value as a function in `glslEffect({ uniforms })` or change the type',
        )
      }
      return
    }
    if (!this.#input.used.has(decl.name)) {
      this.#report.add(
        'GLSL_UNUSED',
        decl.at,
        `uniform \`${decl.name}\` is not used`,
        'remove the declaration',
      )
      this.#set(decl, 'none')
      return
    }
    if (type === 'sampler2D') {
      this.#sampler(decl, option)
      return
    }
    const { pragmas } = decl
    const explicit = (
      pragmas.input
        ? `input:${pragmas.input}`
        : pragmas.param
          ? `param:${pragmas.param}`
          : undefined
    ) as Binding | undefined
    const chosen = explicit ?? option
    if (chosen) this.#explicit(decl, chosen)
    else if (pragmas.color) this.#param(decl, this.#paramNameOf(decl), true)
    else this.#byConvention(decl)
  }

  #set(decl: UniformDecl, bind: Binding): void {
    this.uniforms[decl.name] = { type: decl.type as GlslType, bind }
  }

  /** Takes `key` for the uniform `name`. Reports a clash if another uniform took it first. */
  #claim(key: string, name: string, at: UniformDecl['at']): boolean {
    const other = this.#owners.get(key)
    if (other && other !== name) {
      this.#report.add(
        'GLSL_NAME_CLASH',
        at,
        `\`${name}\` and \`${other}\` both map to \`${key}\``,
        'rename one of the uniforms or set `// @param <name>`',
      )
      return false
    }
    this.#owners.set(key, name)
    return true
  }

  #paramNameOf(decl: UniformDecl): string {
    return paramName(decl.name, normalizeName(decl.name, this.#input.dialect))
  }

  /** The element's media, a `@texture` file, a binding option, or a per-element image param. */
  #sampler(decl: UniformDecl, option: Binding | undefined): void {
    const { texture } = decl.pragmas
    if (this.#input.media === decl.name) this.#set(decl, 'media')
    else if (typeof texture === 'string') {
      const from = decl.at.file
      if (!this.#input.exists(texture, from)) {
        this.#report.add(
          'GLSL_TEXTURE',
          decl.at,
          `file \`${texture}\` not found`,
          'the path is relative to the shader file',
        )
      }
      this.#set(decl, `texture:${decl.name}`)
      this.textures[decl.name] = { path: texture, from }
    } else if (texture === true) this.#set(decl, `texture:${decl.name}`)
    else if (option) this.#set(decl, option)
    else {
      // A per-element image: `data-dio-<param>="/b.jpg"`.
      const name = decl.pragmas.param ?? this.#paramNameOf(decl)
      if (this.#claim(`param:${name}`, decl.name, decl.at)) {
        this.#set(decl, `param:${name}`)
        this.params[name] = ''
      }
    }
  }

  /** A binding from a pragma or an option, checked against the uniform's type. */
  #explicit(decl: UniformDecl, chosen: Binding): void {
    const { type } = decl
    if (chosen.startsWith('input:')) {
      const name = chosen.slice('input:'.length)
      if (!isInput(name)) {
        this.#report.add(
          'GLSL_UNIFORM_TYPE',
          decl.at,
          `unknown input \`${name}\``,
          `inputs: ${Object.keys(INPUT_TYPES).join(', ')}`,
        )
      } else if (INPUT_TYPES[name] !== type) {
        this.#report.add(
          'GLSL_UNIFORM_TYPE',
          decl.at,
          `Diorama's \`${name}\` is ${INPUT_TYPES[name]}, but \`${decl.name}\` is ${type}`,
          'change the uniform type or the input',
        )
      } else if (this.#claim(`input:${name}`, decl.name, decl.at)) this.#set(decl, chosen)
    } else if (chosen.startsWith('param:')) {
      const isColor =
        !!decl.pragmas.color || ((type === 'vec3' || type === 'vec4') && /colou?r/i.test(chosen))
      this.#param(decl, chosen.slice('param:'.length), isColor)
    } else if (chosen === 'none') this.#set(decl, 'none')
    else {
      this.#report.add(
        'GLSL_UNIFORM_TYPE',
        decl.at,
        `binding \`${chosen}\` does not fit ${type}`,
        '`media` and `texture:` are for sampler2D only',
      )
    }
  }

  /** Binds by name: Diorama's conventions (`uTime`, `uMouse`, ...) or a param of that name. */
  #byConvention(decl: UniformDecl): void {
    const { type } = decl
    const normalized = normalizeName(decl.name, this.#input.dialect)
    if (decl.name === 'u_mouse' && type === 'vec2') {
      if (this.#claim('input:pointerPx', decl.name, decl.at)) this.#set(decl, 'input:pointerPx')
      return
    }
    const convention = conventionOf(normalized)
    if (convention) {
      this.#convention(decl, normalized, convention)
      return
    }
    const isColor = (type === 'vec3' || type === 'vec4') && /colou?r/i.test(normalized)
    if (RESERVED.has(normalized)) {
      const name = paramName(decl.name, '')
      this.#report.add(
        'GLSL_PARAM_RESERVED',
        decl.at,
        `\`${normalized}\` is reserved in Diorama: the param is named \`${name}\``,
        'choose your own name: `// @param fade`',
      )
      this.#param(decl, name, isColor)
      return
    }
    this.#param(decl, paramName(decl.name, normalized), isColor)
  }

  #convention(
    decl: UniformDecl,
    normalized: string,
    convention: NonNullable<ReturnType<typeof conventionOf>>,
  ): void {
    const inputName = convention.types[decl.type]
    if (!inputName) {
      const want = Object.keys(convention.types).join(' or ')
      this.#report.add(
        'GLSL_UNIFORM_TYPE',
        decl.at,
        `Diorama's \`${normalized}\` is ${want}, but \`${decl.name}\` is ${decl.type}`,
        `rename the uniform or set \`// @param ${normalized}Value\``,
      )
      return
    }
    if (!this.#claim(`input:${inputName}`, decl.name, decl.at)) return
    this.#set(decl, `input:${inputName}`)
    const { note } = convention
    // A size read only as a ratio means the same in any units, so its note would be noise.
    const silenced =
      note?.code === 'GLSL_SEMANTICS' &&
      convention.input === 'sizePx' &&
      this.#input.ratioOnly(decl.name)
    if (!note || silenced) return
    const message = inputName === 'mouse4' ? `${note.message}; zw = 0` : note.message
    this.#report.add(
      note.code,
      decl.at,
      `\`${decl.name}\` → ${inputName}: ${message}`,
      note.code === 'GLSL_SEMANTICS'
        ? `an explicit pragma silences this: \`// @input ${inputName}\``
        : undefined,
    )
  }

  /** Makes the uniform a param, with its default from a pragma, an option, or zero. */
  #param(decl: UniformDecl, name: string, isColor: boolean): void {
    if (!PARAM_NAME.test(name) || RESERVED.has(name)) {
      this.#report.add(
        'GLSL_PARAM_RESERVED',
        decl.at,
        `invalid param name \`${name}\`: reserved or not lowerCamelCase`,
        'choose another name: `// @param fade`',
      )
      name = paramName(decl.name, '')
    }
    if (!this.#claim(`param:${name}`, decl.name, decl.at)) return
    this.#set(decl, `param:${name}`)
    this.params[name] = this.#defaultOf(decl, name, isColor)
  }

  #defaultOf(decl: UniformDecl, name: string, isColor: boolean): ParamDefault {
    const { type, pragmas } = decl
    let value: ParamDefault | undefined
    const words = pragmas.color ? [pragmas.color] : pragmas.default
    if (words) {
      value = parseDefault(words, type, isColor)
      if (isColor && value !== undefined && hasAlpha(words)) {
        this.#report.add(
          'GLSL_PARAM_DEFAULT',
          decl.at,
          `colour param \`${name}\` is opaque: the alpha of \`${words.join(' ')}\` is dropped`,
          'give the alpha its own float param',
        )
      }
      if (value === undefined) {
        this.#report.add(
          'GLSL_PARAM_DEFAULT',
          decl.at,
          `default \`${words.join(' ')}\` does not fit ${type}`,
          'give a number, a tuple or a color that matches the uniform type',
        )
      }
    }
    const fromOption = this.#input.options.defaults[decl.name]
    if (value === undefined && fromOption !== undefined && checkDefault(fromOption, type, isColor))
      value = fromOption
    if (value !== undefined) return value
    if (!words) {
      this.#report.add(
        'GLSL_PARAM_DEFAULT',
        decl.at,
        `param \`${name}\` has no default; using ${isColor ? '#000000' : '0'}`,
        `add \`// @default …\` to \`${decl.name}\``,
      )
    }
    return zero(type, isColor)
  }
}
