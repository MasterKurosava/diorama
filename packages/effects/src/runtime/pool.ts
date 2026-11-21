// Decoded pictures shared by the layers of one app, through the assets cache when it is there.
// Decoding prefers the image's bytes from the HTTP cache, which Chrome decodes off the main thread.
import type { EffectsView } from '../ports'

/** The element's source changed during decode, so its loop starts over. */
export const RETRY: unique symbol = Symbol('retry')

/** The image did not decode for its element (EFFECT_MEDIA). */
export class Undecodable extends Error {}

/** createImageBitmap is missing or refused the element, so the element is the texture source. */
export const REFUSED: unique symbol = Symbol('refused')

export interface Lease {
  readonly ready: Promise<ImageBitmap>
  release(): void
}

/** A loader for the assets cache: decodes the pixels, sized in bytes, closed on dispose. */
type Make = (context: {
  decode<R>(work: () => Promise<R>): Promise<R>
}) => Promise<{ value: ImageBitmap; bytes: number; dispose(): void }>

/** A decode shared through the local map, with its lease count. */
interface Shared {
  refs: number
  readonly ready: Promise<ImageBitmap>
  bitmap: ImageBitmap | undefined
}

/** CORS mode as it appears in the key. No attribute is '' (no CORS). */
function corsMode(element: Element): string {
  const value = element.getAttribute('crossorigin')
  if (value === null) return ''
  return value.toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous'
}

/**
 * Built outside `acquire` on purpose. A closure made there would capture the element, and a
 * cached picture would then pin the page it came from.
 */
const closer = (bitmap: ImageBitmap) => (): void => bitmap.close()

const FLIP: ImageBitmapOptions = { imageOrientation: 'flipY' }
const BYTES_PER_PIXEL = 4

/**
 * Decodes the image's bytes, or gives `undefined` when they cannot be read. Chrome decodes a
 * Blob off the main thread, but an <img> on it: about 60 ms for 1920×1080, a stalled flight.
 * The bytes come from the HTTP cache, where the element left them.
 */
export async function fromBytes(url: string, mode: string): Promise<ImageBitmap | undefined> {
  try {
    const target = new URL(url, location.href)
    // A no-CORS image of another origin: opaque bytes, and pixels no texture may use anyway
    if (!mode && target.origin !== location.origin && target.protocol !== 'data:') return
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

/**
 * Decoded pictures shared by the layers of one app. Pixels are shared, each layer keeps its own
 * Texture. With `@dioramajs/assets` they live in its cache under `image <currentSrc>[ crossOrigin]`,
 * the key of its `image` loader, so a preloaded picture is a hit. Otherwise (no assets, assets
 * stopped, or another loader failed under the key) a local map holds them until the last lease.
 */
export class Pool {
  readonly #view: EffectsView
  readonly #local = new Map<string, Shared>()
  /** Pixels the leases of this runtime hold, for stats. */
  readonly #held = new Map<object, ImageBitmap>()

  constructor(view: EffectsView) {
    this.#view = view
  }

  get bitmaps(): number {
    return new Set(this.#held.values()).size
  }

  /**
   * The element's decoded pixels. `anonymous` asks for them again in CORS mode through a
   * detached image, for an element without `crossorigin` whose pixels came back tainted.
   */
  acquire(image: HTMLImageElement, anonymous = false): Lease {
    const src = withoutHash(image.currentSrc)
    const mode = anonymous ? 'anonymous' : corsMode(image)
    const key = `image ${src}${mode ? ` ${mode}` : ''}`
    const make = decoder(image, src, mode, anonymous)
    const assets = this.#view.assets
    let lease: Lease = assets
      ? assets.acquire(key, make, {
          priority: 'normal',
          weight: image.naturalWidth * image.naturalHeight * BYTES_PER_PIXEL || undefined,
        })
      : this.#shared(key, make)
    const token = {}
    let released = false
    const ready = !assets
      ? lease.ready
      : lease.ready.catch((cause: unknown) => {
          if (released || cause === RETRY || cause === REFUSED || cause instanceof Undecodable) {
            throw cause
          }
          // Another loader failed under this key (a preload's request). Decode the element's
          // own pixels rather than fall back to the element, which three would crop.
          lease.release()
          lease = this.#shared(key, make)
          return lease.ready
        })
    ready.then((bitmap) => {
      if (!released) this.#held.set(token, bitmap)
    }, noop)
    return {
      ready,
      release: () => {
        if (released) return
        released = true
        this.#held.delete(token)
        lease.release()
      },
    }
  }

  #shared(key: string, make: Make): Lease {
    let shared = this.#local.get(key)
    if (!shared) {
      const ready = make({ decode: (work) => work() }).then((loaded) => loaded.value)
      const entry: Shared = { refs: 0, ready, bitmap: undefined }
      shared = entry
      this.#local.set(key, entry)
      ready.then(
        (bitmap) => {
          entry.bitmap = bitmap
          if (!entry.refs) bitmap.close()
        },
        () => {
          // The next acquire tries again. Waiting leases see this failure.
          if (this.#local.get(key) === entry) this.#local.delete(key)
        },
      )
    }
    const entry = shared
    entry.refs++
    let released = false
    return {
      ready: entry.ready,
      release: () => {
        if (released) return
        released = true
        if (--entry.refs) return
        if (this.#local.get(key) === entry) this.#local.delete(key)
        entry.bitmap?.close()
      },
    }
  }
}

const noop = (): void => {}

const withoutHash = (url: string): string => url.split('#')[0] as string

/**
 * The loader of one picture: its bytes decoded off the main thread, else the element decoded
 * (or, for `anonymous`, a detached image in CORS mode). The assets cache drops the loader once
 * it ran; the result's dispose is all an entry keeps.
 */
function decoder(image: HTMLImageElement, src: string, mode: string, anonymous: boolean): Make {
  return (context) =>
    context.decode(async () => {
      const decoded = await fromBytes(src, mode)
      if (decoded) return bitmapResult(decoded)
      let source: HTMLImageElement = image
      try {
        if (anonymous) {
          source = new Image()
          source.crossOrigin = 'anonymous'
          source.src = src
        }
        await source.decode()
      } catch (cause) {
        throw withoutHash(image.currentSrc) === src ? new Undecodable(src, { cause }) : RETRY
      }
      let value: ImageBitmap
      try {
        // Full resolution. three sizes an <img> texture by its layout width.
        value = await createImageBitmap(source, FLIP)
      } catch {
        throw REFUSED
      }
      return bitmapResult(value)
    })
}

const bitmapResult = (bitmap: ImageBitmap) => ({
  value: bitmap,
  bytes: bitmap.width * bitmap.height * BYTES_PER_PIXEL,
  dispose: closer(bitmap),
})
