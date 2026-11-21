// Text of generated modules and declarations.
import type { ParamDefault } from '@dioramajs/effects'
import type { GlslShader } from '../types'

const IDENT = /^[A-Za-z_$][\w$]*$/
const quote = (text: string): string =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
export const propertyKey = (k: string): string => (IDENT.test(k) ? k : quote(k))

export const block = (members: readonly string[], indent = ''): string =>
  `{\n${members.map((m) => `${indent}  ${m},`).join('\n')}\n${indent}}`

/** A JS literal. Objects with only primitive values stay on one line. */
export function literal(value: unknown, indent = ''): string {
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map((v) => literal(v, indent)).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return '{}'
  const flat = entries.every(([, v]) => typeof v !== 'object' || Array.isArray(v))
  if (flat)
    return `{ ${entries.map(([k, v]) => `${propertyKey(k)}: ${literal(v, indent)}`).join(', ')} }`
  return block(
    entries.map(([k, v]) => `${propertyKey(k)}: ${literal(v, `${indent}  `)}`),
    indent,
  )
}

/** TS type of a param spec, widened like `WidenSpec`. */
export function paramsType(
  params: { readonly [name: string]: ParamDefault },
  readonly = true,
): string {
  const entries = Object.entries(params)
  if (!entries.length) return '{}'
  const prefix = readonly ? 'readonly ' : ''
  const type = (v: ParamDefault): string => {
    if (typeof v === 'number') return 'number'
    if (typeof v === 'boolean') return 'boolean'
    if (typeof v === 'string') return 'string'
    if (Array.isArray(v)) return `readonly [${v.map(() => 'number').join(', ')}]`
    return "import('@dioramajs/effects').ColorParam"
  }
  return `{ ${entries.map(([k, v]) => `${prefix}${propertyKey(k)}: ${type(v)}`).join('; ')} }`
}

export interface ModuleParts {
  readonly header: string
  readonly imports: readonly string[]
  /** `{ '~glsl': 1, ..., build($) { ... } }` */
  readonly object: string
}

export const moduleCode = (parts: ModuleParts): string =>
  [
    parts.header,
    parts.imports.length ? `import { ${parts.imports.join(', ')} } from 'three/tsl'` : '',
    '',
    `export default ${parts.object}`,
    '',
  ]
    .filter((line, i) => line !== '' || i > 1)
    .join('\n')

/**
 * What a registry knows of a shader effect before its module loads: the `EffectEntry` fields
 * other than `load`. Keys without a pragma are left out.
 */
export interface EntryMeta {
  /** Param defaults of both stages. */
  readonly params: { readonly [name: string]: ParamDefault }
  /** From `// @diorama when=…`. */
  readonly when?: string
  /** From `// @diorama reducedMotion=…`. */
  readonly reducedMotion?: 'static' | 'off'
  /** From `// @diorama presence=…`. */
  readonly presence?: 'fade' | 'custom'
}

type StageMeta = Pick<GlslShader, 'params' | 'when' | 'reducedMotion' | 'presence'>

/** Entry metadata of a stage and its pair. `main` (the imported file) wins over `other`. */
export function entryMeta(main: StageMeta, other?: StageMeta): EntryMeta {
  const meta: { -readonly [K in keyof EntryMeta]: EntryMeta[K] } = {
    params: { ...other?.params, ...main.params },
  }
  for (const key of ['when', 'reducedMotion', 'presence'] as const) {
    const value = main[key] ?? other?.[key]
    if (value) (meta as Record<string, unknown>)[key] = value
  }
  return meta
}

/** The `?entry` module: a lazy import of the effect with its metadata. */
export const entryModule = (request: string, meta: EntryMeta): string => {
  const fields = Object.entries(meta).map(([k, v]) => `, ${k}: ${JSON.stringify(v)}`)
  return `export default { load: () => import(${JSON.stringify(request)})${fields.join('')} }\n`
}

/** One module with both stages inline, for loaders that cannot import `?shader`. */
export function inlineEffect(
  stages: { readonly fragment?: ModuleParts; readonly vertex?: ModuleParts },
  runtime = '@dioramajs/glsl',
): string {
  const imports = new Set<string>()
  const lines: string[] = []
  const names: string[] = []
  for (const [name, parts] of Object.entries(stages)) {
    if (!parts) continue
    for (const i of parts.imports) imports.add(i)
    lines.push(`const ${name} = ${parts.object}`, '')
    names.push(name)
  }
  const header = (stages.fragment ?? stages.vertex)?.header ?? ''
  return [
    header,
    `import { glslEffect } from '${runtime}'`,
    imports.size ? `import { ${[...imports].sort().join(', ')} } from 'three/tsl'` : '',
    '',
    ...lines,
    `export default glslEffect({ ${names.join(', ')} })`,
    '',
  ]
    .filter((line, i) => line !== '' || i > 2)
    .join('\n')
}
