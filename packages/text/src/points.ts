// Particles of the text effects that break text into points (assemble, dust): the points sampled
// inside the glyphs of a raster, the instanced quad they are drawn with and the raster's own
// glyphs as a layer that fades per unit or per pixel. Runs only in their chunks.
import { rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  float,
  fwidth,
  length,
  max,
  positionGeometry,
  sRGBTransferEOTF,
  texture,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  CanvasTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
} from 'three/webgpu'
import type { Raster } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>

/** How one particle looks. */
export type Style = 'dots' | 'squares' | 'dashes'

/** Points inside the glyphs of a raster, in reading order. */
export interface Ink {
  readonly count: number
  /** Per point: x, y in box px (y down), the order of its unit, its alpha 0..1. */
  readonly at: Float32Array
  /** Per point: linear r, g, b of the text there, and a random 0..1. */
  readonly color: Float32Array
  /** Grid step the points were picked on, box px. */
  readonly step: number
  /** Ink bounds in box px: left, top, right, bottom. */
  readonly bounds: readonly [number, number, number, number]
}

export interface SampleOptions {
  /** Grid step in box px; widened until the points fit `max`. */
  readonly step: number
  /** Most points. */
  readonly max: number
  readonly seed: number
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** Tries per grid cell to land a point on ink. */
const TRIES = 3

const EMPTY: Ink = {
  count: 0,
  at: new Float32Array(4),
  color: new Float32Array(4),
  step: 1,
  bounds: [0, 0, 0, 0],
}

/** The raster's pixels, undefined when the canvas cannot be read. */
export function pixels(raster: Raster): ImageData | undefined {
  const { width, height } = raster.canvas
  try {
    const data = raster.canvas.getContext('2d')?.getImageData(0, 0, width, height)
    return data && data.data.length >= width * height * 4 ? data : undefined
  } catch {
    return undefined
  }
}

/**
 * Points on a jittered grid inside the glyphs: a cell takes one point where up to three tries
 * land on ink, so thin strokes keep theirs. The step widens until the ink holds at most `max`;
 * the order and colour of each point come from its unit and the pixel under it.
 */
export function sample(raster: Raster, image: ImageData | undefined, options: SampleOptions): Ink {
  if (!image) return EMPTY
  const { data, width, height } = image
  const [frameX, frameY, frameWidth, frameHeight] = raster.frame
  // Image px per box px.
  const scaleX = width / frameWidth
  const scaleY = height / frameHeight
  let peak = 0
  for (let i = 3; i < data.length; i += 4) peak = Math.max(peak, data[i] as number)
  if (!peak) return EMPTY
  // Half the strongest alpha: text drawn in a translucent colour still has its points.
  const cut = peak / 2
  let inked = 0
  for (let i = 3; i < data.length; i += 4) if ((data[i] as number) >= cut) inked++
  const area = inked / (scaleX * scaleY)
  const step = Math.max(options.step, Math.sqrt(area / Math.max(1, options.max)), 0.5)
  const cols = Math.max(1, Math.ceil(frameWidth / step))
  const rows = Math.max(1, Math.ceil(frameHeight / step))
  const taken = new Uint8Array(cols * rows)
  const random = rng(options.seed)
  const at: number[] = []
  const color: number[] = []
  /** Offset of the image pixel under a box point, -1 outside the image. */
  const pixel = (x: number, y: number): number => {
    const column = Math.floor((x - frameX) * scaleX)
    const row = Math.floor((y - frameY) * scaleY)
    return column < 0 || row < 0 || column >= width || row >= height
      ? -1
      : (row * width + column) * 4
  }
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const quad of raster.quads) {
    const firstCol = Math.max(0, Math.floor((quad.x - frameX) / step))
    const lastCol = Math.min(cols - 1, Math.floor((quad.x + quad.width - frameX) / step))
    const firstRow = Math.max(0, Math.floor((quad.y - frameY) / step))
    const lastRow = Math.min(rows - 1, Math.floor((quad.y + quad.height - frameY) / step))
    for (let gy = firstRow; gy <= lastRow; gy++) {
      for (let gx = firstCol; gx <= lastCol; gx++) {
        const cell = gy * cols + gx
        if (taken[cell]) continue
        for (let attempt = 0; attempt < TRIES; attempt++) {
          // The first try near the centre keeps the grid even; the others anywhere in the cell.
          const spread = attempt ? 1 : 0.6
          const x = frameX + (gx + 0.5 + (random() - 0.5) * spread) * step
          const y = frameY + (gy + 0.5 + (random() - 0.5) * spread) * step
          const offset = pixel(x, y)
          const alpha = offset < 0 ? 0 : (data[offset + 3] as number)
          if (alpha < cut) continue
          taken[cell] = 1
          at.push(x, y, quad.order, alpha / 255)
          color.push(
            toLinear((data[offset] as number) / 255),
            toLinear((data[offset + 1] as number) / 255),
            toLinear((data[offset + 2] as number) / 255),
            random(),
          )
          bounds[0] = Math.min(bounds[0], x)
          bounds[1] = Math.min(bounds[1], y)
          bounds[2] = Math.max(bounds[2], x)
          bounds[3] = Math.max(bounds[3], y)
          break
        }
      }
    }
  }
  let count = at.length / 4
  if (!count) return EMPTY
  let atOut = Float32Array.from(at)
  let colorOut = Float32Array.from(color)
  // Partly inked cells take a point more often than the area says: thin out evenly, in order.
  if (count > options.max) {
    const keep = options.max / count
    const keptAt = new Float32Array(options.max * 4)
    const keptColor = new Float32Array(options.max * 4)
    let kept = 0
    for (let i = 0; i < count && kept < options.max; i++) {
      if (random() >= keep) continue
      keptAt.set(atOut.subarray(i * 4, i * 4 + 4), kept * 4)
      keptColor.set(colorOut.subarray(i * 4, i * 4 + 4), kept * 4)
      kept++
    }
    count = kept
    atOut = keptAt.subarray(0, kept * 4)
    colorOut = keptColor.subarray(0, kept * 4)
  }
  return { count, at: atOut, color: colorOut, step, bounds }
}

/** Points the tier allows, as a share of the cap at high. */
export const TIER = { low: 0.25, medium: 0.55, high: 1 } as const

/** A quad per particle: the instance attributes are `count` items of their item size. */
export function instanced(
  count: number,
  attributes: Readonly<Record<string, readonly [Float32Array, number]>>,
  dynamic: readonly string[] = [],
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  for (const [name, [data, size]] of Object.entries(attributes)) {
    const buffer = new InstancedBufferAttribute(data, size)
    if (dynamic.includes(name)) buffer.setUsage(DynamicDrawUsage)
    geometry.setAttribute(name, buffer)
  }
  geometry.instanceCount = count
  return geometry
}

/** Where and how one particle is drawn, per vertex. */
export interface Look {
  /** Centre in box px, y down. */
  readonly centre: V2
  /** Length along `dir` and width across it, px. */
  readonly size: V2
  /** Unit direction of the length, box px, y down; along x when undefined. */
  readonly dir?: V2
  /** Linear colour. */
  readonly rgb: V3
  readonly alpha: F
}

/** Edge smoothing room around a particle, px. */
const MARGIN = 1.5

/**
 * The material of a particle quad: a round dot, a square or a dash with rounded ends along
 * `dir`, its edge smoothed over a screen pixel. `mask` takes the box UV of the centre.
 */
export function particles(
  style: Style,
  look: Look,
  half: V2,
  mask: (uv: V2) => F,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const corner = positionGeometry.xy as unknown as V2
  const extent = look.size.add(MARGIN * 2) as V2
  const local = corner.mul(extent) as V2
  const dir = look.dir
  // The corner's y goes up while box px go down: mirrored here, so the y flip below keeps the
  // winding and the quad faces the camera.
  const { x: localX, y: localY } = local
  const x = dir
    ? look.centre.x.add(dir.x.mul(localX)).sub(dir.y.mul(localY))
    : look.centre.x.add(localX)
  const y = dir
    ? look.centre.y.add(dir.y.mul(localX)).sub(dir.x.mul(localY))
    : look.centre.y.sub(localY)
  material.positionNode = vec3(x.sub(half.x), half.y.sub(y), 0)
  const fragment = varying(local) as V2
  const size = varying(look.size) as V2
  // Signed distance to the particle's edge, px.
  let dist: F
  if (style === 'squares')
    dist = max(abs(fragment.x).sub(size.x.mul(0.5)), abs(fragment.y).sub(size.y.mul(0.5)))
  else if (style === 'dashes') {
    const radius = size.y.mul(0.5)
    const along = max(abs(fragment.x).sub(max(size.x.mul(0.5).sub(radius), 0)), 0)
    dist = length(vec2(along, fragment.y)).sub(radius) as F
  } else dist = length(fragment).sub(size.x.mul(0.5)) as F
  const shape = float(0.5)
    .sub(dist.div(max(fwidth(dist), 1e-4)))
    .clamp(0, 1)
  const uv = vec2(look.centre.x.div(half.x.mul(2)), look.centre.y.div(half.y.mul(2)).oneMinus())
  const alpha = varying(look.alpha.mul(mask(uv.clamp(0, 1) as V2)))
  material.colorNode = vec4(varying(look.rgb), shape.mul(alpha))
  return material
}

/** Instance attributes of the glyph layer: the piece's box and its unit's order. */
const GLYPH_BOX = 'inkBox'
const GLYPH_UNIT = 'inkUnit'

function glyphShape(raster: Raster): InstancedBufferGeometry {
  const count = raster.quads.length
  const box = new Float32Array(Math.max(1, count) * 4)
  const unit = new Float32Array(Math.max(1, count))
  raster.quads.forEach((q, i) => {
    box.set([q.x, q.y, q.width, q.height], i * 4)
    unit[i] = q.order
  })
  return instanced(count, { [GLYPH_BOX]: [box, 4], [GLYPH_UNIT]: [unit, 1] })
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  // Premultiplied, so mip levels and filtering do not darken edges.
  map.premultiplyAlpha = true
  return map
}

/** What the alpha of the glyph layer can read, per fragment. */
export interface GlyphPoint {
  /** The order of the unit. */
  readonly order: F
  /** The point in box px, y down. */
  readonly at: V2
  /** The point in the raster's UV. */
  readonly uv: V2
}

/** The raster's glyphs, one quad per piece, with an alpha of their own. */
export interface Glyphs {
  readonly mesh: Mesh
  /** Swaps in a new raster of the same element. */
  use(next: Raster): void
  dispose(): void
}

export function glyphs(
  raster: Raster,
  half: V2,
  frame: Node<'vec4'>,
  alpha: (point: GlyphPoint) => F,
  mask: (uv: V2) => F,
): Glyphs {
  const box = attribute(GLYPH_BOX, 'vec4') as unknown as Node<'vec4'>
  const unit = attribute(GLYPH_UNIT, 'float') as unknown as F
  const corner = (positionGeometry.xy as unknown as V2).add(0.5) as V2
  const x = box.x.add(corner.x.mul(box.z))
  const y = box.y.add(corner.y.oneMinus().mul(box.w))
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  material.positionNode = vec3(x.sub(half.x), half.y.sub(y), 0)
  const uv = varying(
    vec2(x.sub(frame.x).div(frame.z), y.sub(frame.y).div(frame.w).oneMinus()),
  ) as V2
  const at = varying(vec2(x, y)) as V2
  const boxUV = varying(vec2(x.div(half.x.mul(2)), y.div(half.y.mul(2)).oneMinus())) as V2
  const map = texture(canvasTexture(raster.canvas), uv)
  const texel = map as unknown as Node<'vec4'>
  const rgb = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as V3
  const own = alpha({ order: varying(unit) as F, at, uv })
  material.colorNode = vec4(rgb, texel.a.mul(own).mul(mask(boxUV.clamp(0, 1) as V2)))
  const mesh = new Mesh(glyphShape(raster), material)
  mesh.frustumCulled = false
  return {
    mesh,
    use(next) {
      const old = mesh.geometry
      mesh.geometry = glyphShape(next)
      old.dispose()
      const previous = map.value as Texture
      map.value = canvasTexture(next.canvas)
      previous.dispose()
    },
    dispose() {
      ;(map.value as Texture).dispose()
    },
  }
}

/** A tiling value noise on the CPU: smooth, 0..1, the same for the same seed. */
export function valueNoise(seed: number, cells = 32): (x: number, y: number) => number {
  const random = rng(seed)
  const lattice = Float32Array.from({ length: cells * cells }, random)
  const at = (x: number, y: number): number =>
    lattice[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)] as number
  const smooth = (t: number): number => t * t * (3 - 2 * t)
  const octave = (x: number, y: number): number => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const tx = smooth(x - x0)
    const ty = smooth(y - y0)
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx
    return top + (bottom - top) * ty
  }
  // A second octave at twice the frequency, offset so the two lattices do not line up.
  return (x, y) => (octave(x, y) * 2 + octave(x * 2.03 + 7.1, y * 2.03 + 3.7)) / 3
}

/** The median font size of the raster's pieces, px. */
export function emOf(raster: Raster): number {
  const sizes = raster.quads.map((q) => q.em).sort((a, b) => a - b)
  return sizes[sizes.length >> 1] ?? 16
}
