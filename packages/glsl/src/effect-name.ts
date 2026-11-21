// Shader file names, shared by convert, the Vite plugin, the loader and glslEntries.
import type { ReservedAttr } from '@dioramajs/effects'

/** `data-dio-*` names reserved by effects. A Record so the type forces the full list. */
export const RESERVED_ATTRS: Readonly<Record<ReservedAttr, 0>> = {
  key: 0,
  state: 0,
  track: 0,
  load: 0,
  preload: 0,
  progress: 0,
  vt: 0,
  transition: 0,
  section: 0,
}

/**
 * Kebab-case file stem, so `rgb_shift.frag` is `rgb-shift`. Invalid or reserved stems get a
 * `shader-` prefix: `2d.frag` is `shader-2d`, `transition.frag` is `shader-transition`.
 */
export function effectName(file: string): string {
  const stem = (file.split(/[\\/]/).pop() as string).replace(/\.[^.]*$/, '')
  const name = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return /^[a-z][a-z0-9-]*$/.test(name) && !Object.hasOwn(RESERVED_ATTRS, name)
    ? name
    : `shader-${name}`.replace(/-+$/, '')
}

export const SHADER_FILE: RegExp = /\.(frag|vert|glsl|fs|vs)$/
export const VERTEX_FILE: RegExp = /\.(vert|vs)$/
