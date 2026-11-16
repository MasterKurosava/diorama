import { LinearSRGBColorSpace, NoColorSpace, SRGBColorSpace, Texture } from 'three/webgpu'
import type { AssetLoader } from '../types'

const COLOR_SPACES: Readonly<Record<string, string>> = {
  linear: LinearSRGBColorSpace,
  none: NoColorSpace,
}

/** GPU bytes of an RGBA8 texture. Mipmaps add a third. */
export const rgbaBytes = ({ width = 0, height = 0 }: { width?: number; height?: number }): number =>
  Math.round((width * height * 16) / 3)

/**
 * A Texture over the pixels of the `image` entry with the same URL and CORS mode, which a
 * preload or an effect may have decoded already. Origin bottom-left like effects textures.
 * `options.colorSpace` is 'srgb' (default), 'linear' or 'none' for data maps.
 */
export const texture: AssetLoader<Texture> = {
  async load(context) {
    const { crossOrigin, priority } = context
    const pixels = context.load<ImageBitmap>(context.url, { type: 'image', crossOrigin, priority })
    let bitmap: ImageBitmap
    try {
      bitmap = await pixels.ready
    } catch (error) {
      pixels.release()
      throw error
    }
    const value = new Texture(bitmap)
    // Decoded flipped already, so both backends upload it as is.
    value.flipY = false
    value.colorSpace = COLOR_SPACES[String(context.options.colorSpace)] ?? SRGBColorSpace
    value.needsUpdate = true
    value.userData.keep = true
    return {
      value,
      bytes: rgbaBytes(bitmap),
      dispose() {
        value.dispose()
        pixels.release()
      },
    }
  },
}
