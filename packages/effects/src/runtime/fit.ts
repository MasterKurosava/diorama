// `ctx.fit`: a texture slot framed like the element's own media, object-fit as a UV transform.
import { clamp, step, texture, uniform, uv } from 'three/tsl'
import { type Node, type Texture, type TextureNode, type UniformNode, Vector4 } from 'three/webgpu'
import type { Fit, FitOptions } from '../types'
import { fitCrop } from './media'

type Vec2Node = Node<'vec2'>

/** Scratch crop of `update`. */
const scratchCrop = [1, 1, 0, 0]

/** `ctx.fit`: a texture node and its object-fit transform, recomputed in layout. */
export class FitImpl implements Fit {
  /** (scale u, scale v, offset u, offset v). */
  readonly crop: UniformNode<'vec4'> = uniform(new Vector4(1, 1, 0, 0)) as never
  readonly node: TextureNode
  fit: FitOptions['fit'] = 'cover'
  position: readonly [number, number] = [0.5, 0.5]
  /** Box size of the last layout, so `set()` frames a new texture in the same frame. */
  #width = 0
  #height = 0

  constructor(map: Texture, options?: FitOptions) {
    this.node = texture(map)
    // three shares one sampler among texture nodes of one texture; a slot that set() swaps later
    // must keep its own, or it goes on showing the texture it was compiled with.
    this.node.mergeable = false
    this.set(map, options)
  }

  uv(at: Vec2Node = uv()): Vec2Node {
    const crop = this.crop as unknown as Node<'vec4'>
    return at.mul(crop.xy).add(crop.zw)
  }

  mask(at: Vec2Node = uv()): Node<'float'> {
    const mapped = this.uv(at)
    return step(0, mapped.x).mul(step(mapped.x, 1), step(0, mapped.y), step(mapped.y, 1))
  }

  /** The texture at box UV under the fit, clamped at its edge like the media surface. */
  sample(at: Vec2Node = uv()): Node<'vec4'> {
    return this.node.sample(clamp(this.uv(at), 0, 1)) as unknown as Node<'vec4'>
  }

  set(map: Texture, options: FitOptions = {}): void {
    this.node.value = map
    this.fit = options.fit ?? 'cover'
    this.position = options.position ?? [0.5, 0.5]
    this.update(this.#width, this.#height)
  }

  /** Recomputes the transform for a box of this size. */
  update(width: number, height: number): void {
    this.#width = width
    this.#height = height
    const image = this.node.value.image as
      | { width?: number; height?: number; videoWidth?: number; videoHeight?: number }
      | undefined
    const imageWidth = image?.videoWidth || image?.width || 0
    const imageHeight = image?.videoHeight || image?.height || 0
    fitCrop(this.fit, this.position, imageWidth, imageHeight, width, height, scratchCrop)
    ;(this.crop.value as Vector4).fromArray(scratchCrop)
  }
}
