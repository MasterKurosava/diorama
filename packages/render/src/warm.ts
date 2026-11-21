import { renderOutput, screenUV, texture } from 'three/tsl'
import {
  DataTexture,
  LinearMipmapLinearFilter,
  NoColorSpace,
  NodeMaterial,
  QuadMesh,
  SRGBColorSpace,
  Texture,
  type WebGPURenderer,
} from 'three/webgpu'

/**
 * Compiles a stand-in for three's output pass (tone mapping and colour space onto the canvas)
 * before the first frame. The first node build on a page is by far the slowest, since three's
 * node code runs for the first time, and the first frame builds the real pass synchronously
 * (r187 `Renderer#_renderOutput`): one long task. Here `compileAsync` takes that first build
 * apart from the frame, with its own yields, and also makes the frame buffer target. A failure
 * changes nothing but the cost of the first frame.
 */
export async function warm(renderer: WebGPURenderer): Promise<void> {
  const source = new DataTexture(new Uint8Array(4), 1, 1)
  source.needsUpdate = true
  const material = new NodeMaterial()
  material.fragmentNode = renderOutput(
    texture(source, screenUV),
    renderer.toneMapping,
    renderer.outputColorSpace,
  )
  const quad = new QuadMesh(material)
  // Only a warm-up: whatever fails here, the dispose of a half-built material included, the
  // first frame builds what it needs.
  try {
    await renderer.compileAsync(quad, quad.camera)
  } catch {}
  try {
    material.dispose()
    source.dispose()
  } catch {}
  await upload(renderer)
}

/**
 * Uploads two tiny pictures the way effects upload theirs (a bitmap with mipmaps, in sRGB and
 * as data). The first upload of a format makes pipelines synchronously in the GPU process: three's
 * mipmap pass and the browser's copy of external images, together 30 to 40 ms on a desktop GPU,
 * which stall every frame of the page. Here they come before any effect shows, not in the frame
 * where the first picture appears.
 */
async function upload(renderer: WebGPURenderer): Promise<void> {
  if (typeof createImageBitmap !== 'function' || typeof ImageData !== 'function') return
  for (const colorSpace of [SRGBColorSpace, NoColorSpace]) {
    let bitmap: ImageBitmap | undefined
    let picture: Texture | undefined
    try {
      bitmap = await createImageBitmap(new ImageData(4, 4), { imageOrientation: 'flipY' })
      picture = new Texture(bitmap)
      picture.colorSpace = colorSpace
      picture.flipY = false
      picture.minFilter = LinearMipmapLinearFilter
      picture.needsUpdate = true
      renderer.initTexture(picture)
    } catch {
      // Only a warm-up.
    } finally {
      picture?.dispose()
      bitmap?.close()
    }
  }
}
