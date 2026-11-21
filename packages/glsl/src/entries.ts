// @dioramajs/glsl/entries: a folder of `?entry` modules as a registry. Imports no three.
import type { EffectEntries, EffectEntry } from '@dioramajs/effects'
import { effectName, SHADER_FILE, VERTEX_FILE } from './effect-name'

/**
 * Turns `import.meta.glob('./effects/*.frag', { query: '?entry', import: 'default', eager: true })`
 * into a registry keyed by effect name. A `.vert` with the same stem as a `.frag` belongs to that
 * effect and gets no key of its own. Two files that map to one name throw.
 */
export function glslEntries(modules: { readonly [path: string]: EffectEntry }): EffectEntries {
  const entries: Record<string, EffectEntry> = {}
  const owners = new Map<string, string>()
  const paths = Object.keys(modules).map((path) => path.replace(/\?.*$/, ''))
  const fragments = new Set(
    paths.filter((path) => !VERTEX_FILE.test(path)).map((path) => path.replace(SHADER_FILE, '')),
  )
  for (const [key, entry] of Object.entries(modules)) {
    const path = key.replace(/\?.*$/, '')
    if (VERTEX_FILE.test(path) && fragments.has(path.replace(SHADER_FILE, ''))) continue
    const name = effectName(path)
    const other = owners.get(name)
    if (other) throw new Error(`glslEntries: "${other}" and "${path}" are both effect "${name}"`)
    owners.set(name, path)
    entries[name] = entry
  }
  return entries
}
