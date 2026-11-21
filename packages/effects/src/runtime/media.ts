// The media of a layer: the element's single texture, shared by every effect on it. Prepares it
// from the element's current source (decoded pixels from the pool, a CORS retry for tainted
// ones), follows source changes and video frames, and computes object-fit as a UV transform.
import { SRGBColorSpace, Texture, VideoTexture } from 'three/webgpu'
import { EffectError } from '../errors'
import type { FitOptions } from '../types'
import type { Styles } from './inputs'
import { type Lease, RETRY, Undecodable } from './pool'

type MediaElement = HTMLImageElement | HTMLVideoElement

/** What one pass of the loop got: the pixels and their pool lease, none for a video. */
interface Decoded {
  readonly lease?: Lease | undefined
  readonly pixels?: ImageBitmap | undefined
}

/** `HTMLMediaElement.HAVE_CURRENT_DATA`. */
const HAVE_CURRENT_DATA = 2
/** Thrown inside the loop when a newer generation took over. */
const STALE = Symbol('stale')

interface ProbeContext {
  drawImage(source: CanvasImageSource, x: number, y: number, w: number, h: number): void
  getImageData(x: number, y: number, w: number, h: number): unknown
}
/** The shared 1x1 canvas of `tainted`: null where none can be made. */
let probeContext: ProbeContext | null | undefined

export const isMedia = (element: Element): element is MediaElement =>
  element.localName === 'img' || element.localName === 'video'

/** The effect reads the element as a texture: `media: true`, or 'optional' on media. */
export const readsMedia = (
  def: { readonly media?: boolean | 'optional' },
  element: Element,
): boolean => def.media === true || (def.media === 'optional' && isMedia(element))

/**
 * CSS object-fit and object-position of a picture of `imageWidth` x `imageHeight` in a box as a
 * UV transform, `texture uv = box uv * crop.xy + crop.zw`, y up like `uv()`. Picture px count as
 * CSS px.
 */
export function fitCrop(
  fit: FitOptions['fit'],
  position: readonly [number, number],
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  crop: number[],
): void {
  if (!imageWidth || !imageHeight || !width || !height) {
    crop.splice(0, 4, 1, 1, 0, 0)
    return
  }
  const scale = fitScale(fit, imageWidth, imageHeight, width, height)
  // The picture's drawn size and its offset in the box; `fill` stretches it to the box.
  const drawnWidth = scale ? imageWidth * scale : width
  const drawnHeight = scale ? imageHeight * scale : height
  const offsetX = (width - drawnWidth) * position[0]
  const offsetY = (height - drawnHeight) * position[1]
  const scaleV = height / drawnHeight
  crop.splice(
    0,
    4,
    width / drawnWidth,
    scaleV,
    -offsetX / drawnWidth,
    1 - scaleV + offsetY / drawnHeight,
  )
}

/**
 * Draws the media into a shared 1x1 canvas and reads it back. A tainted source (cross-origin
 * without CORS) throws SecurityError here instead of inside `renderer.render` every frame.
 * A bitmap carries the taint of its image and draws without decoding the element.
 */
export function tainted(source: MediaElement | ImageBitmap): boolean {
  if (probeContext === undefined) probeContext = newProbeContext()
  if (!probeContext) return false
  try {
    probeContext.drawImage(source, 0, 0, 1, 1)
    probeContext.getImageData(0, 0, 1, 1)
    return false
  } catch (error) {
    if ((error as { name?: string }).name !== 'SecurityError') return false
    // A tainted canvas stays tainted, so the next source gets a fresh one.
    probeContext = undefined
    return true
  }
}

export interface MediaHost {
  /** The decoded picture of the element's current source, shared through the pool. */
  acquire(element: HTMLImageElement, anonymous?: boolean): Lease
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
  /** The pending `requestVideoFrameCallback` id. */
  #videoFrame = 0
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
    const generation = ++this.#generation
    this.state = 'pending'
    return this.#loop(generation).then(
      () => {
        if (generation !== this.#generation) return
        this.state = 'ready'
        this.#pending = undefined
        this.#host.invalidate()
      },
      (error: unknown): Promise<void> | undefined => {
        // A newer run took over. A disposed media settles nothing, as #pending may be this run.
        if (error === STALE) {
          return this.#abort.signal.aborted ? new Promise(() => {}) : this.#pending
        }
        this.state = 'failed'
        this.error = error as EffectError
        this.#pending = undefined
        throw error
      },
    )
  }

  /**
   * Waits for the element's data, decodes its pixels and checks them for taint, starting over
   * whenever the source changes on the way. Throws STALE once a newer run took over.
   */
  async #loop(generation: number): Promise<void> {
    const element = this.element
    const signal = this.#abort.signal
    for (;;) {
      const src = element.currentSrc
      await data(element, signal)
      if (generation !== this.#generation) throw STALE
      if (element.currentSrc !== src) continue
      const decoded = isVideo(element)
        ? this.#videoReady(element)
        : await this.#decode(element, src, generation)
      if (!decoded) continue
      let { lease, pixels } = decoded
      this.src = element.currentSrc
      // Probe the pixels, not the element, so a hit does not make the browser decode the <img>.
      if (tainted(pixels ?? element)) {
        lease?.release()
        const clean = await this.#untaint(element, src, generation)
        if (!clean) continue
        lease = clean
        pixels = await clean.ready
      }
      this.#apply(pixels, lease)
      return
    }
  }

  #videoReady(video: HTMLVideoElement): Decoded {
    if (video.readyState < HAVE_CURRENT_DATA) throw this.#error('EFFECT_MEDIA', 'video has no data')
    return {}
  }

  /**
   * The picture's pixels through the pool. A preloaded picture is a pool hit, so no decode and no
   * second createImageBitmap. Undefined when the source changed meanwhile: start over.
   */
  async #decode(
    image: HTMLImageElement,
    src: string,
    generation: number,
  ): Promise<Decoded | undefined> {
    let lease: Lease | undefined = this.#host.acquire(image)
    let pixels: ImageBitmap | undefined
    try {
      pixels = await lease.ready
    } catch (cause) {
      lease.release()
      lease = undefined
      if (generation !== this.#generation) throw STALE
      // The source changed during decode. Not a failure, start over.
      if (cause === RETRY || image.currentSrc !== src) return undefined
      if (cause instanceof Undecodable) {
        throw this.#error('EFFECT_MEDIA', `cannot decode ${src || 'the image'}`, cause.cause)
      }
      // No bitmap (createImageBitmap missing or refused), so the element itself is the source.
    }
    if (generation !== this.#generation || image.currentSrc !== src) {
      lease?.release()
      if (generation !== this.#generation) throw STALE
      return undefined
    }
    return { lease, pixels }
  }

  /**
   * Tainted pixels: site builders cannot set `crossorigin`, so an image without it is asked for
   * once more in CORS mode, and served with CORS headers those pixels are clean. Throws
   * EFFECT_CORS otherwise. Undefined when the source changed meanwhile: start over.
   */
  async #untaint(
    element: MediaElement,
    src: string,
    generation: number,
  ): Promise<Lease | undefined> {
    const retry = !isVideo(element) && !element.hasAttribute('crossorigin')
    const again = retry ? await this.#cors(element as HTMLImageElement) : undefined
    if (generation !== this.#generation || element.currentSrc !== src) {
      again?.release()
      if (generation !== this.#generation) throw STALE
      return undefined
    }
    if (!again) {
      throw this.#error(
        'EFFECT_CORS',
        `${this.src} is cross-origin without CORS headers: serve it with Access-Control-Allow-Origin`,
      )
    }
    return again
  }

  /** The pixels again in CORS mode, or undefined if the server does not allow it. */
  async #cors(image: HTMLImageElement): Promise<Lease | undefined> {
    const lease = this.#host.acquire(image, true)
    try {
      if (!tainted(await lease.ready)) return lease
    } catch {}
    lease.release()
    return undefined
  }

  #error(code: 'EFFECT_MEDIA' | 'EFFECT_CORS', message: string, cause?: unknown): EffectError {
    this.src = this.element.currentSrc
    return new EffectError(code, message, { element: this.element, cause })
  }

  #apply(pixels: ImageBitmap | undefined, lease: Lease | undefined): void {
    const element = this.element
    const image = pixels ?? element
    if (this.texture) {
      // r187 copies into the old GPU texture without a size check. Dropping it makes the next
      // draw allocate one of the new size, and the Texture object and its nodes stay valid.
      this.texture.dispose()
      this.#close()
      this.texture.image = image
    } else {
      this.texture = isVideo(element) ? new VideoTexture(element) : new Texture(image)
      this.texture.colorSpace = SRGBColorSpace
      if (isVideo(element)) this.#followFrames(element)
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
  #followFrames(video: HTMLVideoElement): void {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      video.addEventListener('timeupdate', () => this.#host.visible() && this.#host.invalidate(), {
        signal: this.#abort.signal,
      })
      return
    }
    const next = (): void => {
      if (this.#abort.signal.aborted) return
      if (this.#host.visible()) this.#host.invalidate()
      this.#videoFrame = video.requestVideoFrameCallback(next)
    }
    this.#videoFrame = video.requestVideoFrameCallback(next)
  }

  #changed(): void {
    if (this.state !== 'ready' || this.element.currentSrc === this.src) return
    this.#host.stale()
    this.#pending = this.#start()
    this.#pending.catch((error: unknown) => this.#host.failed(error as EffectError))
  }

  /** Natural size of the current source, frozen for a ghost. */
  size(): [number, number] {
    const element = this.element
    if (this.#size) return this.#size
    if (isVideo(element)) return [element.videoWidth, element.videoHeight]
    return [element.naturalWidth, element.naturalHeight]
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
    const element = this.element
    if (this.#videoFrame && isVideo(element)) {
      element.cancelVideoFrameCallback?.(this.#videoFrame)
    }
  }

  /**
   * CSS object-fit and object-position as a UV transform,
   * `texture uv = box uv * crop.xy + crop.zw`, y up like `uv()`.
   */
  fit(styles: Styles, width: number, height: number, crop: number[]): void {
    const [imageWidth, imageHeight] = this.size()
    fitCrop(styles.fit, styles.position, imageWidth, imageHeight, width, height, crop)
  }

  dispose(): void {
    this.freeze()
    this.texture?.dispose()
    this.#close()
  }
}

const isVideo = (element: MediaElement): element is HTMLVideoElement =>
  element.localName === 'video'

/** Resolves once the element has data for its current source. Aborting leaves it pending. */
function data(element: MediaElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const ready = isVideo(element)
      ? element.readyState >= HAVE_CURRENT_DATA
      : element.complete && !!element.currentSrc
    if (ready) return resolve()
    const options = { once: true, signal }
    element.addEventListener(isVideo(element) ? 'loadeddata' : 'load', () => resolve(), options)
    element.addEventListener('error', () => resolve(), options)
  })
}

/** The picture's scale under object-fit; 0 for `fill`, which stretches it to the box. */
function fitScale(
  fit: FitOptions['fit'],
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
): number {
  if (fit === 'cover') return Math.max(width / imageWidth, height / imageHeight)
  if (fit === 'contain') return Math.min(width / imageWidth, height / imageHeight)
  if (fit === 'none') return 1
  if (fit === 'scale-down') return Math.min(1, width / imageWidth, height / imageHeight)
  return 0
}

function newProbeContext(): ProbeContext | null {
  try {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, 1)
        : document.createElement('canvas')
    return (canvas.getContext('2d', { willReadFrequently: true }) as ProbeContext | null) ?? null
  } catch {
    return null
  }
}
