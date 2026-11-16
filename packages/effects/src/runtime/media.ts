import { SRGBColorSpace, Texture, VideoTexture } from 'three/webgpu'
import { EffectError } from '../errors'
import type { Styles } from './inputs'
import { type Lease, RETRY, Undecodable } from './pool'

type MediaElement = HTMLImageElement | HTMLVideoElement

export const isMedia = (el: Element): el is MediaElement =>
  el.localName === 'img' || el.localName === 'video'
const isVideo = (el: MediaElement): el is HTMLVideoElement => el.localName === 'video'
const HAVE_CURRENT_DATA = 2

/** Thrown inside the loop when a newer generation took over. */
const STALE = Symbol('stale')

type Probe = {
  drawImage(el: CanvasImageSource, x: number, y: number, w: number, h: number): void
  getImageData(x: number, y: number, w: number, h: number): unknown
}
let probe: Probe | null | undefined
/**
 * Draws the media into a shared 1x1 canvas and reads it back. A tainted source (cross-origin
 * without CORS) throws SecurityError here instead of inside `renderer.render` every frame.
 * A bitmap carries the taint of its image and draws without decoding the element.
 */
export function tainted(el: MediaElement | ImageBitmap): boolean {
  if (probe === undefined) {
    try {
      const canvas =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(1, 1)
          : document.createElement('canvas')
      probe = (canvas.getContext('2d', { willReadFrequently: true }) as Probe | null) ?? null
    } catch {
      probe = null
    }
  }
  if (!probe) return false
  try {
    probe.drawImage(el, 0, 0, 1, 1)
    probe.getImageData(0, 0, 1, 1)
    return false
  } catch (error) {
    if ((error as { name?: string }).name !== 'SecurityError') return false
    // A tainted canvas stays tainted, so the next source gets a fresh one.
    probe = undefined
    return true
  }
}

/** Resolves once the element has data for its current source. Aborting leaves it pending. */
function data(el: MediaElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const ready = isVideo(el) ? el.readyState >= HAVE_CURRENT_DATA : el.complete && !!el.currentSrc
    if (ready) return resolve()
    const options = { once: true, signal }
    el.addEventListener(isVideo(el) ? 'loadeddata' : 'load', () => resolve(), options)
    el.addEventListener('error', () => resolve(), options)
  })
}

export interface MediaHost {
  /** The decoded picture of the element's current source, shared through the pool. */
  acquire(element: HTMLImageElement): Lease
  invalidate(): void
  /** The source changed. The copy is stale until the new one is ready. */
  stale(): void
  /** A source change failed after the media was ready. */
  failed(error: EffectError): void
  visible(): boolean
}

/** The element's single texture, shared by every effect on it. */
export class Media {
  readonly element: MediaElement
  texture: Texture | undefined
  state: 'idle' | 'pending' | 'ready' | 'failed' = 'idle'
  error: EffectError | undefined
  /** `currentSrc` the texture holds, or the one that failed. */
  src = ''
  readonly #host: MediaHost
  readonly #abort = new AbortController()
  #generation = 0
  #pending: Promise<void> | undefined
  /** The pool lease of the pixels the texture shows. */
  #lease: Lease | undefined
  #frame = 0
  /** A ghost's media size, taken from what the texture holds. */
  #size: [number, number] | undefined

  constructor(element: MediaElement, host: MediaHost) {
    this.element = element
    this.#host = host
    const event = isVideo(element) ? 'loadeddata' : 'load'
    // A new source after the first (srcset switch, lazy library, React reuse) restarts the loop.
    element.addEventListener(event, () => this.#changed(), { signal: this.#abort.signal })
  }

  /**
   * Starts preparing once and rejects with EFFECT_MEDIA or EFFECT_CORS. A failed run starts
   * over, since mounts only get here after a retry (new source, `crossorigin`) and the layer may
   * have outlived the failure (another effect, a `layers()` lease).
   */
  ready(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'failed') this.error = undefined
    this.#pending ??= this.#start()
    return this.#pending
  }

  #start(): Promise<void> {
    const gen = ++this.#generation
    this.state = 'pending'
    const run = this.#loop(gen).then(
      () => {
        if (gen !== this.#generation) return
        this.state = 'ready'
        this.#pending = undefined
        this.#host.invalidate()
      },
      (error: unknown): Promise<void> | undefined => {
        // A newer run took over. A disposed media settles nothing, as #pending may be this run.
        if (error === STALE)
          return this.#abort.signal.aborted ? new Promise(() => {}) : this.#pending
        this.state = 'failed'
        this.error = error as EffectError
        this.#pending = undefined
        throw error
      },
    )
    return run
  }

  async #loop(gen: number): Promise<void> {
    const el = this.element
    const signal = this.#abort.signal
    for (;;) {
      const src = el.currentSrc
      await data(el, signal)
      if (gen !== this.#generation) throw STALE
      if (el.currentSrc !== src) continue
      let lease: Lease | undefined
      let pixels: ImageBitmap | undefined
      if (isVideo(el)) {
        if (el.readyState < HAVE_CURRENT_DATA)
          throw this.#error('EFFECT_MEDIA', 'video has no data')
      } else {
        // A preloaded picture is a pool hit, so no decode and no second createImageBitmap.
        lease = this.#host.acquire(el)
        try {
          pixels = await lease.ready
        } catch (cause) {
          lease.release()
          lease = undefined
          if (gen !== this.#generation) throw STALE
          // The source changed during decode. Not a failure, start over.
          if (cause === RETRY || el.currentSrc !== src) continue
          if (cause instanceof Undecodable) {
            throw this.#error('EFFECT_MEDIA', `cannot decode ${src || 'the image'}`, cause.cause)
          }
          // No bitmap (createImageBitmap missing or refused), so the element itself is the source.
        }
        if (gen !== this.#generation || el.currentSrc !== src) {
          lease?.release()
          if (gen !== this.#generation) throw STALE
          continue
        }
      }
      this.src = el.currentSrc
      // Probe the pixels, not the element, so a hit does not make the browser decode the <img>.
      if (tainted(pixels ?? el)) {
        lease?.release()
        throw this.#error(
          'EFFECT_CORS',
          `${this.src} is cross-origin: add crossorigin="anonymous" and CORS headers`,
        )
      }
      this.#apply(pixels, lease)
      return
    }
  }

  #error(code: 'EFFECT_MEDIA' | 'EFFECT_CORS', message: string, cause?: unknown): EffectError {
    this.src = this.element.currentSrc
    return new EffectError(code, message, { element: this.element, cause })
  }

  #apply(pixels: ImageBitmap | undefined, lease: Lease | undefined): void {
    const el = this.element
    const image = pixels ?? el
    if (this.texture) {
      // r187 copies into the old GPU texture without a size check. Dropping it makes the next
      // draw allocate one of the new size, and the Texture object and its nodes stay valid.
      this.texture.dispose()
      this.#close()
      this.texture.image = image
    } else {
      this.texture = isVideo(el) ? new VideoTexture(el) : new Texture(image)
      this.texture.colorSpace = SRGBColorSpace
      if (isVideo(el)) this.#video(el)
    }
    this.#lease = lease
    // A bitmap is decoded already flipped, so both backends upload it as is.
    this.texture.flipY = !pixels
    this.texture.needsUpdate = true
  }

  /** Releases the pixels. The pool closes them after their last lease. */
  #close(): void {
    this.#lease?.release()
    this.#lease = undefined
  }

  /** Requests frames while the video plays and the layer is on screen. */
  #video(el: HTMLVideoElement): void {
    if (typeof el.requestVideoFrameCallback !== 'function') {
      el.addEventListener('timeupdate', () => this.#host.visible() && this.#host.invalidate(), {
        signal: this.#abort.signal,
      })
      return
    }
    const next = (): void => {
      if (this.#abort.signal.aborted) return
      if (this.#host.visible()) this.#host.invalidate()
      this.#frame = el.requestVideoFrameCallback(next)
    }
    this.#frame = el.requestVideoFrameCallback(next)
  }

  #changed(): void {
    if (this.state !== 'ready' || this.element.currentSrc === this.src) return
    this.#host.stale()
    this.#pending = this.#start()
    this.#pending.catch((error: unknown) => this.#host.failed(error as EffectError))
  }

  /** Natural size of the current source, frozen for a ghost. */
  size(): [number, number] {
    const el = this.element
    if (this.#size) return this.#size
    return isVideo(el) ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight]
  }

  /**
   * The element left but its copy is kept. Stops source changes and video frames and keeps the
   * texture. The size comes from the pixels, since the site may reset the element's `src`.
   */
  freeze(): void {
    const image = this.texture?.image as { width?: number; height?: number } | undefined
    const bitmap = image && image !== this.element
    this.#size = bitmap ? [image.width ?? 0, image.height ?? 0] : this.size()
    this.#generation++
    this.#abort.abort()
    const el = this.element
    if (this.#frame && isVideo(el)) el.cancelVideoFrameCallback?.(this.#frame)
  }

  /**
   * CSS object-fit and object-position as a UV transform,
   * `texture uv = box uv * crop.xy + crop.zw`, y up like `uv()`.
   */
  fit(styles: Styles, width: number, height: number, crop: number[]): void {
    const [iw, ih] = this.size()
    if (!iw || !ih || !width || !height) {
      crop.splice(0, 4, 1, 1, 0, 0)
      return
    }
    let rw = width
    let rh = height
    if (styles.fit !== 'fill') {
      const pick = styles.fit === 'cover' ? Math.max : Math.min
      const scale = pick(width / iw, height / ih)
      rw = iw * scale
      rh = ih * scale
    }
    const ox = (width - rw) * styles.position[0]
    const oy = (height - rh) * styles.position[1]
    const sx = width / rw
    const sy = height / rh
    crop.splice(0, 4, sx, sy, -ox / rw, 1 - sy + oy / rh)
  }

  dispose(): void {
    this.freeze()
    this.texture?.dispose()
    this.#close()
  }
}
