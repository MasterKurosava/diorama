import type { CompressedTexture } from 'three/webgpu'
import type { AssetLoader } from '../types'
import { KTX2, ktx2Loader, parseError, refused } from './decoders'

/**
 * A KTX2 (Basis) texture, transcoded for the formats of the app's renderer, so it waits for
 * `render`. Origin top-left like glTF, and `flipY` can't be set.
 */
export const ktx2: AssetLoader<CompressedTexture> = {
  async load(context) {
    if (context.decoders.ktx2 === false) throw refused(KTX2, 'ktx2', context.url)
    const buffer = await context.bytes(await context.fetch())
    // Wait for render after the request, which frees its slot.
    const { renderer } = await context.render()
    const loader = await ktx2Loader(renderer, context.decoders, context.url)
    let value: CompressedTexture
    try {
      value = await context.decode(
        () => new Promise((resolve, reject) => loader.parse(buffer, resolve, reject)),
      )
    } catch (cause) {
      throw parseError(cause, context, true)
    }
    value.userData.keep = true
    return { value, bytes: buffer.byteLength, renderBound: true, dispose: () => value.dispose() }
  },
}
