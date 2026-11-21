import { AssetError } from './errors'
import { abortError } from './queue'
import type { AssetLoader, Loaded, LoaderContext } from './types'

/** Resolves once the image has loaded, or rejects with ASSET_LOAD. Aborting stops the request. */
export function loaded(img: HTMLImageElement, url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    // A cached image may be complete at once. happy-dom never loads and reports complete.
    if (img.complete && (img.currentSrc || img.src)) return resolve()
    const done = (): void => {
      img.removeEventListener('load', ok)
      img.removeEventListener('error', fail)
      signal.removeEventListener('abort', abort)
    }
    const ok = (): void => {
      done()
      resolve()
    }
    const fail = (): void => {
      done()
      // In CORS mode a server without Access-Control-Allow-Origin fails the same way as a 404.
      const foreign = new URL(url, location.href).origin !== location.origin
      const hint =
        foreign && img.crossOrigin !== null
          ? ': is it served with Access-Control-Allow-Origin?'
          : ''
      reject(new AssetError('ASSET_LOAD', `cannot load ${url}${hint}`, { url }))
    }
    const abort = (): void => {
      done()
      img.removeAttribute('srcset')
      img.removeAttribute('src')
      reject(abortError())
    }
    img.addEventListener('load', ok)
    img.addEventListener('error', fail)
    signal.addEventListener('abort', abort)
  })
}

const FLIP: ImageBitmapOptions = { imageOrientation: 'flipY' }

/**
 * The image's bytes decoded, or `undefined` when they cannot be read. Chrome decodes a Blob off
 * the main thread, but an <img> on it: about 60 ms for 1920×1080. The bytes come from the HTTP
 * cache, where the image left them. Mirrors `fromBytes` of the effects pool.
 */
async function fromBytes(img: HTMLImageElement): Promise<ImageBitmap | undefined> {
  try {
    const mode = img.crossOrigin
    const target = new URL(img.currentSrc || img.src, location.href)
    // A no-CORS image of another origin: opaque bytes, and pixels no texture may use anyway
    if (mode === null && target.origin !== location.origin && target.protocol !== 'data:') return
    const response = await fetch(target, {
      credentials: mode === 'use-credentials' ? 'include' : 'same-origin',
      cache: 'force-cache',
    })
    if (!response.ok) return
    return await createImageBitmap(await response.blob(), FLIP)
  } catch {
    return undefined
  }
}

/** Shared with the effects pool. Decodes, then flips the pixels like effects textures. */
export async function bitmap(img: HTMLImageElement, url: string): Promise<Loaded<ImageBitmap>> {
  try {
    let pixels = await fromBytes(img)
    if (!pixels) {
      await img.decode()
      pixels = await createImageBitmap(img, FLIP)
    }
    return {
      value: pixels,
      bytes: pixels.width * pixels.height * 4,
      dispose: () => pixels.close(),
    }
  } catch (cause) {
    throw new AssetError('ASSET_PARSE', `cannot decode ${url}`, { url, cause })
  }
}

/** A detached image. The browser makes the request, then it takes a decode slot. */
export const image: AssetLoader<ImageBitmap> = {
  async load(context) {
    const img = new Image()
    if (context.crossOrigin) img.crossOrigin = context.crossOrigin
    if (context.priority !== 'normal') img.setAttribute('fetchpriority', context.priority)
    img.src = context.url
    await loaded(img, context.url, context.signal)
    return context.decode(() => bitmap(img, context.url))
  },
}

async function body(context: LoaderContext): Promise<ArrayBuffer> {
  return context.bytes(await context.fetch())
}

export const buffer: AssetLoader<ArrayBuffer> = {
  async load(context) {
    const value = await body(context)
    return { value, bytes: value.byteLength }
  },
}

export const json: AssetLoader<unknown> = {
  async load(context) {
    const bytes = await body(context)
    try {
      return { value: JSON.parse(new TextDecoder().decode(bytes)), bytes: bytes.byteLength }
    } catch (cause) {
      throw new AssetError('ASSET_PARSE', `${context.url} is not JSON`, {
        url: context.url,
        cause,
      })
    }
  },
}
