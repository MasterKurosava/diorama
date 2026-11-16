// Maps each uniform to a binding by naming convention, converter options and file pragmas.
import type { ParamDefault } from '@diorama/effects'
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
const hex = (n: number[]): string =>
  `#${n
    .slice(0, 3)
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** A default from pragma words, checked against the GLSL type. */
function parseDefault(
  words: readonly string[],
  type: string,
  isColor: boolean,
): ParamDefault | undefined {
  if (isColor) {
    if (words.length === 1 && /^#|^[a-z]/i.test(words[0] as string))
      return color(words[0] as string)
    const n = words.map(Number)
    return n.length >= 3 && n.every(Number.isFinite) ? color(hex(n)) : undefined
  }
  if (type === 'bool') {
    const w = words[0]?.toLowerCase()
    return w === 'true' || w === '1' || w === 'on'
      ? true
      : w === 'false' || w === '0' || w === 'off'
        ? false
        : undefined
  }
  const n = words.map(Number)
  if (!n.length || !n.every(Number.isFinite)) return undefined
  const size = VECTOR_SIZES[type]
  if (!size) return n[0] as number
  const tuple = n.length === 1 ? Array(size).fill(n[0]) : n
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

export function bind(input: BindingInput, report: Reporter): Bound {
  const uniforms: Record<string, UniformInfo> = {}
  const params: Record<string, ParamDefault> = {}
  const textures: Bound['textures'] = {}
  const owners = new Map<string, string>()
  const claim = (key: string, name: string, at: UniformDecl['at']): boolean => {
    const other = owners.get(key)
    if (other && other !== name) {
      report.add(
        'GLSL_NAME_CLASH',
        at,
        `\`${name}\` and \`${other}\` both map to \`${key}\``,
        'rename one of the uniforms or set `// @param <name>`',
      )
      return false
    }
    owners.set(key, name)
    return true
  }

  for (const d of input.uniforms) {
    if (uniforms[d.name]) continue
    const type = d.type
    const set = (bind: Binding): void => {
      uniforms[d.name] = { type: type as GlslType, bind }
    }
    const option = input.options.bindings[d.name]
    if (d.array || !SUPPORTED.has(type)) {
      if (option) set(option)
      else {
        report.add(
          'GLSL_UNSUPPORTED_TYPE',
          d.at,
          `uniform \`${d.name}\`: ${d.array ? 'arrays are' : `type ${type} is`} not supported`,
          'pass the value as a function in `glslEffect({ uniforms })` or change the type',
        )
      }
      continue
    }
    if (!input.used.has(d.name)) {
      report.add('GLSL_UNUSED', d.at, `uniform \`${d.name}\` is not used`, 'remove the declaration')
      set('none')
      continue
    }
    const p = d.pragmas
    const addParam = (name: string, isColor: boolean): void => {
      if (!PARAM_NAME.test(name) || RESERVED.has(name)) {
        report.add(
          'GLSL_PARAM_RESERVED',
          d.at,
          `invalid param name \`${name}\`: reserved or not lowerCamelCase`,
          'choose another name: `// @param fade`',
        )
        name = paramName(d.name, '')
      }
      if (!claim(`param:${name}`, d.name, d.at)) return
      set(`param:${name}`)
      let value: ParamDefault | undefined
      const words = p.color ? [p.color] : p.default
      if (words) {
        value = parseDefault(words, type, isColor)
        if (value === undefined) {
          report.add(
            'GLSL_PARAM_DEFAULT',
            d.at,
            `default \`${words.join(' ')}\` does not fit ${type}`,
            'give a number, a tuple or a color that matches the uniform type',
          )
        }
      }
      const fromOption = input.options.defaults[d.name]
      if (
        value === undefined &&
        fromOption !== undefined &&
        checkDefault(fromOption, type, isColor)
      ) {
        value = fromOption
      }
      if (value === undefined) {
        if (!words) {
          report.add(
            'GLSL_PARAM_DEFAULT',
            d.at,
            `param \`${name}\` has no default; using ${isColor ? '#000000' : '0'}`,
            `add \`// @default …\` to \`${d.name}\``,
          )
        }
        value = zero(type, isColor)
      }
      params[name] = value
    }

    if (type === 'sampler2D') {
      if (input.media === d.name) set('media')
      else if (typeof p.texture === 'string') {
        const from = d.at.file
        if (!input.exists(p.texture, from)) {
          report.add(
            'GLSL_TEXTURE',
            d.at,
            `file \`${p.texture}\` not found`,
            'the path is relative to the shader file',
          )
        }
        set(`texture:${d.name}`)
        textures[d.name] = { path: p.texture, from }
      } else if (p.texture === true) set(`texture:${d.name}`)
      else if (option) set(option)
      else {
        // A per-element image: `data-dio-<param>="/b.jpg"`.
        const name = p.param ?? paramName(d.name, normalizeName(d.name, input.dialect))
        if (claim(`param:${name}`, d.name, d.at)) {
          set(`param:${name}`)
          params[name] = ''
        }
      }
      continue
    }

    const explicit = (p.input ? `input:${p.input}` : p.param ? `param:${p.param}` : undefined) as
      | Binding
      | undefined
    const chosen = explicit ?? option
    if (chosen) {
      if (chosen.startsWith('input:')) {
        const name = chosen.slice(6)
        if (!isInput(name)) {
          report.add(
            'GLSL_UNIFORM_TYPE',
            d.at,
            `unknown input \`${name}\``,
            `inputs: ${Object.keys(INPUT_TYPES).join(', ')}`,
          )
        } else if (INPUT_TYPES[name] !== type) {
          report.add(
            'GLSL_UNIFORM_TYPE',
            d.at,
            `Diorama's \`${name}\` is ${INPUT_TYPES[name]}, but \`${d.name}\` is ${type}`,
            'change the uniform type or the input',
          )
        } else if (claim(`input:${name}`, d.name, d.at)) set(chosen)
      } else if (chosen.startsWith('param:')) {
        addParam(
          chosen.slice(6),
          !!p.color || ((type === 'vec3' || type === 'vec4') && /colou?r/i.test(chosen)),
        )
      } else if (chosen === 'none') set('none')
      else {
        report.add(
          'GLSL_UNIFORM_TYPE',
          d.at,
          `binding \`${chosen}\` does not fit ${type}`,
          '`media` and `texture:` are for sampler2D only',
        )
      }
      continue
    }
    if (p.color) {
      addParam(paramName(d.name, normalizeName(d.name, input.dialect)), true)
      continue
    }

    const n = normalizeName(d.name, input.dialect)
    if (d.name === 'u_mouse' && type === 'vec2') {
      if (claim('input:pointerPx', d.name, d.at)) set('input:pointerPx')
      continue
    }
    const convention = conventionOf(n)
    if (convention) {
      const inputName = convention.types[type]
      if (!inputName) {
        const want = Object.keys(convention.types).join(' or ')
        report.add(
          'GLSL_UNIFORM_TYPE',
          d.at,
          `Diorama's \`${n}\` is ${want}, but \`${d.name}\` is ${type}`,
          `rename the uniform or set \`// @param ${n}Value\``,
        )
        continue
      }
      if (!claim(`input:${inputName}`, d.name, d.at)) continue
      set(`input:${inputName}`)
      const note = convention.note
      if (
        note &&
        !(
          note.code === 'GLSL_SEMANTICS' &&
          convention.input === 'sizePx' &&
          input.ratioOnly(d.name)
        )
      ) {
        const message = inputName === 'mouse4' ? `${note.message}; zw = 0` : note.message
        report.add(
          note.code,
          d.at,
          `\`${d.name}\` → ${inputName}: ${message}`,
          note.code === 'GLSL_SEMANTICS'
            ? `an explicit pragma silences this: \`// @input ${inputName}\``
            : undefined,
        )
      }
      continue
    }
    const isColor = (type === 'vec3' || type === 'vec4') && /colou?r/i.test(n)
    if (RESERVED.has(n)) {
      const name = paramName(d.name, '')
      report.add(
        'GLSL_PARAM_RESERVED',
        d.at,
        `\`${n}\` is reserved in Diorama: the param is named \`${name}\``,
        'choose your own name: `// @param fade`',
      )
      addParam(name, isColor)
      continue
    }
    addParam(paramName(d.name, n), isColor)
  }
  return { uniforms, params, textures }
}
