import type { EffectsView } from '../instances'

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

type Make = (context: {
  decode<R>(work: () => Promise<R>): Promise<R>
}) => Promise<{ value: ImageBitmap; bytes: number; dispose(): void }>

interface Shared {
  refs: number
  readonly ready: Promise<ImageBitmap>
  bitmap: ImageBitmap | undefined
}

/** CORS mode as it appears in the key. No attribute is '' (no CORS). */
function cors(el: Element): string {
  const value = el.getAttribute('crossorigin')
  if (value === null) return ''
  return value.toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous'
}

/**
 * Built outside `acquire` on purpose. A closure made there would capture the element, and a
 * cached picture would then pin the page it came from.
 */
const closer = (bitmap: ImageBitmap) => (): void => bitmap.close()

/**
 * Decoded pictures shared by the layers of one app. Pixels are shared, each layer keeps its own
 * Texture. With `@diorama/assets` they live in its cache under `image <currentSrc>[ crossOrigin]`,
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

  acquire(el: HTMLImageElement): Lease {
    const src = el.currentSrc.split('#')[0] as string
    const mode = cors(el)
    const key = `image ${src}${mode ? ` ${mode}` : ''}`
    // assets drops the loader once it ran. The result's dispose is all an entry keeps.
    const make: Make = (context) =>
      context.decode(async () => {
        try {
          await el.decode()
        } catch (cause) {
          throw el.currentSrc.split('#')[0] === src ? new Undecodable(src, { cause }) : RETRY
        }
        let value: ImageBitmap
        try {
          // Full resolution. three sizes an <img> texture by its layout width.
          value = await createImageBitmap(el, { imageOrientation: 'flipY' })
        } catch {
          throw REFUSED
        }
        return { value, bytes: value.width * value.height * 4, dispose: closer(value) }
      })
    const assets = this.#view.assets
    let lease: Lease = assets
      ? assets.acquire(key, make, {
          priority: 'normal',
          weight: el.naturalWidth * el.naturalHeight * 4 || undefined,
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
