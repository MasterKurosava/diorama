// Text of generated modules and declarations.
import type { ParamDefault } from '@diorama/effects'

const IDENT = /^[A-Za-z_$][\w$]*$/
const quote = (s: string): string =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
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
  const r = readonly ? 'readonly ' : ''
  const type = (v: ParamDefault): string => {
    if (typeof v === 'number') return 'number'
    if (typeof v === 'boolean') return 'boolean'
    if (typeof v === 'string') return 'string'
    if (Array.isArray(v)) return `readonly [${v.map(() => 'number').join(', ')}]`
    return "import('@diorama/effects').ColorParam"
  }
  return `{ ${entries.map(([k, v]) => `${r}${propertyKey(k)}: ${type(v)}`).join('; ')} }`
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

/** One module with both stages inline, for loaders that cannot import `?shader`. */
export function inlineEffect(
  stages: { readonly fragment?: ModuleParts; readonly vertex?: ModuleParts },
  runtime = '@diorama/glsl',
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
