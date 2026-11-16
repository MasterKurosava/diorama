// Naming conventions shared by the converter, the CLI and the runtime.
import type { OptionName, ReservedParam } from '@diorama/effects'
import { RESERVED_ATTRS } from './effect-name'
import type { GlslCode, GlslType, ShaderInput } from './types'

export type Dialect = 'three' | 'glsl3' | 'shadertoy'

export const INPUT_TYPES: { readonly [K in ShaderInput]: GlslType } = {
  time: 'float',
  hoverTime: 'float',
  hover: 'float',
  progress: 'float',
  velocity: 'float',
  pin: 'float',
  motion: 'float',
  pointer: 'vec2',
  pointerNdc: 'vec2',
  pointerPx: 'vec2',
  mouse4: 'vec4',
  size: 'vec2',
  size3: 'vec3',
  sizePx: 'vec2',
  sizePx3: 'vec3',
}
export const VECTOR_SIZES: Readonly<Record<string, number>> = { vec2: 2, vec3: 3, vec4: 4 }

export const isInput = (name: string): name is ShaderInput => Object.hasOwn(INPUT_TYPES, name)

/** Param names that would clash with effects inputs, reserved attributes or definition options. */
export const RESERVED: ReadonlySet<string> = new Set(
  Object.keys({
    ...RESERVED_ATTRS,
    pointer: 0,
    pointerWorld: 0,
    hover: 0,
    velocity: 0,
    pin: 0,
    size: 0,
    time: 0,
    hoverTime: 0,
    motion: 0,
    opacity: 0,
    presence: 0,
    name: 0,
    when: 0,
    animate: 0,
    rebuild: 0,
    media: 0,
    reducedMotion: 0,
    on: 0,
    bleed: 0,
  } satisfies Record<ReservedParam | OptionName, unknown>),
)

/** Varying names taken as the box UV. */
export const UV_VARYINGS: ReadonlySet<string> = new Set([
  'vUv',
  'vUV',
  'v_uv',
  'vTexCoord',
  'vTextureCoord',
])

/** Normalized sampler names that mean the element's own image. */
const MEDIA = new Set(['texture', 'tex', 'map', 'image', 'diffuse', 'tDiffuse', 'tMap', 'channel0'])

/**
 * Drops the `u`/`u_` prefix (`i` in Shadertoy) and camel-cases, so `u_strength` is `strength`
 * and `uRGBShift` is `rgbShift`.
 */
export function normalizeName(name: string, dialect: Dialect = 'three'): string {
  let n = name
  if (dialect === 'shadertoy' && /^i[A-Z]/.test(n)) n = n.slice(1)
  else if (n.startsWith('u_')) n = n.slice(2)
  else if (/^u[A-Z]/.test(n)) n = n.slice(1)
  n = n.replace(/_+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/_+$/, '')
  return n.replace(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)|^[A-Z]/, (s) => s.toLowerCase())
}

export const isMediaName = (normalized: string): boolean => MEDIA.has(normalized)

export const PARAM_NAME: RegExp = /^[a-z][a-zA-Z0-9]*$/
/** The normalized name if effects accepts it, else the camel-cased original. */
export function paramName(glsl: string, normalized: string): string {
  if (PARAM_NAME.test(normalized) && !RESERVED.has(normalized)) return normalized
  const camel = glsl
    .replace(/_+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase())
  return PARAM_NAME.test(camel) ? camel : `p${camel.replace(/[^a-zA-Z0-9]/g, '')}`
}

export interface Convention {
  readonly input: ShaderInput
  /** Accepted GLSL types and the input each one binds. */
  readonly types: { readonly [type: string]: ShaderInput }
  readonly note?: { readonly code: GlslCode; readonly message: string }
}

const MOUSE_NOTE = {
  code: 'GLSL_MOUSE',
  message:
    'Diorama gives UV 0..1; use `// @input pointerNdc` for NDC, `// @input pointerPx` for pixels',
} as const
const conventions: [readonly string[], Convention][] = [
  [['time', 'globalTime'], { input: 'time', types: { float: 'time' } }],
  [
    ['mouse', 'pointer', 'cursor'],
    { input: 'pointer', types: { vec2: 'pointer', vec4: 'mouse4' }, note: MOUSE_NOTE },
  ],
  [
    ['resolution', 'res'],
    {
      input: 'sizePx',
      types: { vec2: 'sizePx', vec3: 'sizePx3' },
      note: {
        code: 'GLSL_SEMANTICS',
        message: 'device pixels of the element box, not of the window',
      },
    },
  ],
  [
    [
      'size',
      'imageSize',
      'imageSizes',
      'imageResolution',
      'textureSize',
      'planeSize',
      'planeSizes',
      'meshSize',
      'meshSizes',
      'quadSize',
    ],
    {
      input: 'size',
      types: { vec2: 'size' },
      note: {
        code: 'GLSL_COVER',
        message:
          'box size in CSS px; Diorama applies object-fit, so a cover crop of your own is a no-op',
      },
    },
  ],
  [['hover', 'hoverProgress'], { input: 'hover', types: { float: 'hover' } }],
  [['hoverTime'], { input: 'hoverTime', types: { float: 'hoverTime' } }],
  [
    ['progress', 'scrollProgress'],
    {
      input: 'progress',
      types: { float: 'progress' },
      note: {
        code: 'GLSL_SEMANTICS',
        message:
          "the element's passage through the viewport, 0..1; for a tweened uProgress use `// @param reveal`",
      },
    },
  ],
  [
    ['velocity', 'scrollVelocity'],
    {
      input: 'velocity',
      types: { float: 'velocity' },
      note: {
        code: 'GLSL_SEMANTICS',
        message: 'Diorama gives −1..1 (3000 px/s = 1), not Lenis px/frame; adjust the multiplier',
      },
    },
  ],
  [['pin', 'pinProgress'], { input: 'pin', types: { float: 'pin' } }],
  [['motion'], { input: 'motion', types: { float: 'motion' } }],
]
const byName = new Map<string, Convention>()
for (const [names, convention] of conventions) for (const n of names) byName.set(n, convention)

export const conventionOf = (normalized: string): Convention | undefined => byName.get(normalized)

/** Edit distance, for "did you mean". */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = row[j] as number
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = next
    }
  }
  return row[b.length] as number
}

/** Candidates within edit distance 2, closest first. */
export function similar(name: string, candidates: Iterable<string>, limit = 3): string[] {
  const found: [string, number][] = []
  for (const c of new Set(candidates)) {
    if (c === name) continue
    const d = distance(name.toLowerCase(), c.toLowerCase())
    if (d <= 2) found.push([c, d])
  }
  return found
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([c]) => c)
}
