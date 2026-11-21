import type { CrossOrigin } from './types'

/** Asset type by file extension, for loads without an explicit type. */
export const BY_EXTENSION: Readonly<Record<string, string>> = {
  glb: 'gltf',
  gltf: 'gltf',
  ktx2: 'ktx2',
  jpg: 'texture',
  jpeg: 'texture',
  png: 'texture',
  webp: 'texture',
  avif: 'texture',
  gif: 'texture',
}

/** Absolute URL without the fragment, which never reaches the request. */
export function absolute(url: string, base?: string | URL): string {
  const parsed = new URL(url, base ?? document.baseURI)
  parsed.hash = ''
  return parsed.href
}

/**
 * CORS mode of a texture load. Pixels of another origin fetched without CORS are tainted and the
 * GPU upload throws SecurityError on every draw, so such a texture is always asked in CORS mode.
 */
export function textureCors(url: string, crossOrigin: CrossOrigin): CrossOrigin {
  if (crossOrigin) return crossOrigin
  const page = globalThis.location?.origin
  const target = new URL(url)
  return page && /^https?:$/.test(target.protocol) && target.origin !== page ? 'anonymous' : ''
}

/** Lower-case extension of an absolute URL's path, without the dot. '' for none. */
export const extensionOf = (url: string): string =>
  /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? ''

/**
 * Cache key `type url[ crossOrigin][ options]`. The CORS mode is part of it, as in the browser's
 * image cache. The effects pool builds `image <currentSrc>[ crossOrigin]` keys the same way.
 */
export function keyOf(
  type: string,
  url: string,
  crossOrigin: CrossOrigin,
  options: Readonly<Record<string, unknown>>,
): string {
  const entries = Object.entries(options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  let key = `${type} ${url}`
  if (crossOrigin) key += ` ${crossOrigin}`
  if (entries.length) key += ` ${JSON.stringify(entries)}`
  return key
}

/** URL and type of a `keyOf` key. A key without a space stands for both. */
export const parseKey = (key: string): { readonly url: string; readonly type: string } => ({
  url: key.split(' ')[1] ?? key,
  type: key.split(' ')[0] ?? key,
})

const CANDIDATE = /[\s,]*(\S+)/y

/**
 * A srcset with absolute candidate URLs. A URL is a run of non-spaces, so commas inside stay
 * (CDN transforms like `w_400,c_fill`). Per the HTML spec, one ending in commas has no descriptors.
 */
export function srcset(value: string, base: string): string {
  const out: string[] = []
  for (let i = 0; ; ) {
    CANDIDATE.lastIndex = i
    const match = CANDIDATE.exec(value)
    if (!match) break
    let url = match[1] as string
    i = CANDIDATE.lastIndex
    let descriptor = ''
    if (url.endsWith(',')) url = url.replace(/,+$/, '')
    else {
      const end = value.indexOf(',', i)
      descriptor = value.slice(i, end < 0 ? undefined : end).trim()
      i = end < 0 ? value.length : end + 1
    }
    const href = new URL(url, base).href
    out.push(descriptor ? `${href} ${descriptor}` : href)
  }
  return out.join(', ')
}
