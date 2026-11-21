// File helpers shared by the Vite plugin, the loader and the CLI.
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { readInclude } from './index'

/** The other stage's file: `wave.vert` for `wave.frag` and back, same for `.fs` and `.vs`. */
export function sibling(file: string): string | undefined {
  const pairs: Record<string, string> = {
    '.frag': '.vert',
    '.vert': '.frag',
    '.fs': '.vs',
    '.vs': '.fs',
  }
  const match = /\.(frag|vert|fs|vs)$/.exec(file)
  return match ? file.slice(0, -match[0].length) + pairs[match[0]] : undefined
}
/** Resolves bare `#include` specifiers up front because `convert` reads includes synchronously. */
export async function collectIncludes(
  file: string,
  code: string,
  resolveBare: (spec: string, from: string) => Promise<string | undefined>,
): Promise<Map<string, { path: string; code: string }>> {
  const found = new Map<string, { path: string; code: string }>()
  const visit = async (from: string, text: string, depth: number): Promise<void> => {
    if (depth > 32) return
    for (const match of text.matchAll(/^\s*#\s*include\s+(?:"([^"]+)"|([^\s;"<>]+))/gm)) {
      const spec = (match[1] ?? match[2]) as string
      const key = `${from}\0${spec}`
      if (found.has(key)) continue
      let hit = readInclude(spec, from)
      if (!hit && !spec.startsWith('.') && !isAbsolute(spec)) {
        const path = await resolveBare(spec, from)
        if (path && existsSync(path)) hit = { path, code: readFileSync(path, 'utf8') }
      }
      if (!hit || typeof hit === 'string') continue
      found.set(key, hit)
      await visit(hit.path, hit.code, depth + 1)
    }
  }
  await visit(file, code, 0)
  return found
}
