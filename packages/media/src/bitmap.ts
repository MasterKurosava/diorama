// Big pictures for the effects that inspect them (zoom, lightbox, panorama, flipbook): bytes from
// the assets cache, decoded off the main thread no larger than the effect and the device allow,
// into a texture of the effect's own with mipmaps. The cache keeps the bytes, never the pixels.
import type { EffectContext } from '@dioramajs/effects'
import { maxTextureSize } from '@dioramajs/effects/kit'
import { LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three/webgpu'
import { frugal } from './slots'

type Priority = 'high' | 'normal' | 'low'

/** The part of `@dioramajs/assets` the pictures use. */
interface Assets {
  load(
    url: string,
    options: { type: string; priority: Priority },
  ): { readonly ready: Promise<unknown>; release(): void }
  track(work: PromiseLike<unknown>, options: { weight: number; priority: Priority }): void
}

/** Options of `picture`. */
export interface PictureOptions {
  /** Longest side in px. The device limit caps it too, Save-Data and 2G halve it. */
  readonly resolution?: number
  /** Default 'normal'. */
  readonly priority?: Priority
}

/** A picture leased for an effect. */
export interface Picture {
  /**
   * The texture: decoded flipped like a bitmap, mipmapped, at the renderer's top anisotropy. A
   * `.ktx2` comes from the cache as it is (compressed, top-left origin, shared: never dispose
   * it) and rejects with `code: 'EFFECT_MEDIA'` when it is larger than the device takes.
   */
  readonly ready: Promise<Texture>
  /** Frees the texture and the lease; the bytes stay in the cache. Safe twice and before ready. */
  release(): void
}

const FLIP: ImageBitmapOptions = { imageOrientation: 'flipY' }

/** Width and height from the header of a PNG, GIF, JPEG, WebP or AVIF file, else undefined. */
export function dimensions(bytes: ArrayBuffer): [number, number] | undefined {
  const byte = new Uint8Array(bytes)
  const view = new DataView(bytes)
  const text = (at: number, length: number): string =>
    String.fromCharCode(...byte.subarray(at, at + length))
  try {
    if (text(1, 3) === 'PNG') return [view.getUint32(16), view.getUint32(20)]
    if (text(0, 4) === 'GIF8') return [view.getUint16(6, true), view.getUint16(8, true)]
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
      const chunk = text(12, 4)
      if (chunk === 'VP8 ') {
        return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff]
      }
      if (chunk === 'VP8L') {
        const packed = view.getUint32(21, true)
        return [(packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1]
      }
      if (chunk === 'VP8X') {
        return [
          (view.getUint32(24, true) & 0xffffff) + 1,
          (view.getUint32(27, true) & 0xffffff) + 1,
        ]
      }
    }
    if (byte[0] === 0xff && byte[1] === 0xd8) {
      // Segments up to the first SOFn (start of frame, not DHT, JPG or DAC): its height and width.
      for (let at = 2; at + 9 < byte.length; ) {
        const marker = byte[at + 1] as number
        if (byte[at] !== 0xff) return undefined
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return [view.getUint16(at + 7), view.getUint16(at + 5)]
        }
        at += marker === 0xff ? 1 : 2 + view.getUint16(at + 2)
      }
    }
    if (text(4, 4) === 'ftyp') {
      // AVIF: the largest `ispe` box of the header, so a grid's size beats its tiles'.
      let best: [number, number] | undefined
      for (let at = 8; at + 16 <= Math.min(byte.length, 1 << 16); at++) {
        if (byte[at] !== 0x69 || text(at, 4) !== 'ispe') continue
        const size: [number, number] = [view.getUint32(at + 8), view.getUint32(at + 12)]
        if (!best || size[0] * size[1] > best[0] * best[1]) best = size
      }
      return best
    }
  } catch {
    // A header cut short.
  }
  return undefined
}

/** `createImageBitmap` options that flip and shrink `width` by `height` to `max` on its long side. */
export function shrink(width: number, height: number, max: number): ImageBitmapOptions {
  const scale = max / Math.max(width, height)
  if (!(scale < 1)) return FLIP
  // One side only, so the decoder keeps the shape.
  const side =
    width >= height
      ? { resizeWidth: Math.round(width * scale) }
      : { resizeHeight: Math.round(height * scale) }
  return { ...FLIP, ...side, resizeQuality: 'high' }
}

/** The long side a decode may take: `resolution` within the device limit, halved when frugal. */
export function cap(ctx: Pick<EffectContext, 'render'>, resolution: number = Infinity): number {
  const max = Math.min(resolution, maxTextureSize(ctx))
  return frugal() ? Math.round(max / 2) : max
}

/**
 * Leases the picture at `url` for an effect: bytes from the assets cache, decoded at most `cap`
 * on the long side into a texture of its own. Needs the assets plugin.
 */
export function picture(
  ctx: Pick<EffectContext, 'app' | 'render'>,
  url: string,
  options: PictureOptions = {},
): Picture {
  const assets = (ctx.app as unknown as { assets?: Assets }).assets
  if (!assets) throw new Error('pictures need the assets plugin')
  const ktx2 = /\.ktx2([?#]|$)/i.test(url)
  const max = cap(ctx, options.resolution)
  const lease = assets.load(url, {
    type: ktx2 ? 'ktx2' : 'buffer',
    priority: options.priority ?? 'normal',
  })
  let released = false
  let own: Texture | undefined
  const ready = (async (): Promise<Texture> => {
    const value = await lease.ready
    if (ktx2) {
      const { width, height } = (value as Texture).image as { width: number; height: number }
      const limit = maxTextureSize(ctx)
      if (Math.max(width, height) <= limit) return value as Texture
      throw Object.assign(new Error(`${url} is ${width} x ${height}, the device takes ${limit}`), {
        code: 'EFFECT_MEDIA',
      })
    }
    const blob = new Blob([value as ArrayBuffer])
    const size = dimensions(value as ArrayBuffer)
    let bitmap = await createImageBitmap(blob, size ? shrink(size[0], size[1], max) : FLIP)
    // An unknown header, or one EXIF turns: shrink what came out.
    if (Math.max(bitmap.width, bitmap.height) > max) {
      const next = shrink(bitmap.width, bitmap.height, max)
      bitmap.close()
      bitmap = await createImageBitmap(blob, next)
    }
    if (released) {
      bitmap.close()
      throw Object.assign(new Error(`${url} was released`), { name: 'AbortError' })
    }
    const texture = new Texture(bitmap)
    texture.colorSpace = SRGBColorSpace
    texture.flipY = false
    texture.minFilter = LinearMipmapLinearFilter
    texture.anisotropy =
      (ctx.render.renderer as unknown as { getMaxAnisotropy?(): number }).getMaxAnisotropy?.() ?? 1
    texture.needsUpdate = true
    own = texture
    return texture
  })()
  // `assets.ready()` waits for the decode as well as the bytes, without moving the progress.
  assets.track(ready, { weight: 0, priority: options.priority ?? 'normal' })
  // The effect handles the rejection where it awaits; this keeps it from going unhandled.
  ready.catch(() => {})
  return {
    ready,
    release() {
      if (released) return
      released = true
      lease.release()
      if (!own) return
      ;(own.image as ImageBitmap).close()
      own.dispose()
    },
  }
}
