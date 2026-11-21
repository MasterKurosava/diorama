import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, rng } from '@dioramajs/effects/kit'
import {
  abs,
  clamp,
  dFdx,
  dFdy,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  type Node,
  RepeatWrapping,
  RGBAFormat,
  Vector2,
} from 'three/webgpu'
import { startProgress } from './progress'
import { checkTarget } from './target'

type Params = {
  style: ChoiceParam<'contour' | 'waves' | 'stripes'>
  lines: number
  color: ColorParam
  background: ColorParam
  warp: number
  speed: number
  thickness: number
  scroll: number
  fps: number
  seed: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Texels along each side of the noise tile. */
const TILE = 128
/** How far noise bends the lines at warp 1, in box heights: hills for contour. */
const BEND = { contour: 1.8, waves: 0.22, stripes: 0.22 }
/** Line spacings the lines move over the whole scroll progress at scroll 1. */
const SCROLL = 3
/** Every fifth contour line is an index line, this much thicker. */
const INDEX = 1.8

/**
 * Lines across the element bent by baked noise: topographic contours of a slowly changing relief,
 * flowing wave lines or filled wavy stripes, shifted by scroll. Lines keep one width in CSS px
 * at any density and fade to their average where they crowd.
 */
const waves: Effect<Params> = defineEffect({
  name: 'waves',
  params: {
    style: oneOf('contour', 'waves', 'stripes'),
    lines: 16,
    color: color('#3b6a8f'),
    background: color('#0c1424'),
    warp: 0.5,
    speed: 0.3,
    thickness: 1.2,
    scroll: 0.3,
    fps: 30,
    seed: 1,
  },
  rebuild: ['seed'],
  animate: { fps: (ctx) => ctx.params.fps },
  quality: { low: { fps: 15 }, medium: { fps: 24 } },
  setup(ctx: EffectContext<Params>) {
    const { params, surface, u } = ctx
    if (DEV) checkTarget(ctx, 'waves')
    const style = params.style
    const tile = bakeNoise(params.seed)
    ctx.onDispose(() => tile.dispose())
    // Two noise layers slide apart over time, so the relief changes instead of only moving.
    const nearLayer = uniform(new Vector2())
    const farLayer = uniform(new Vector2())
    const scrollShift = uniform(0)

    /**
     * The tile at `point` (tile units) through a cubic B-spline, from four linear reads: C2 smooth,
     * so contours bend without kinks at texels or the flat spots of a quintic between them.
     */
    const smoothNoise = (point: Node<'vec2'>) => {
      const s = point.mul(TILE).sub(0.5)
      const i = floor(s)
      const f = fract(s)
      const f2 = f.mul(f)
      const f3 = f2.mul(f)
      // B-spline weights of the four texels, folded into two linear reads per axis.
      const w0 = float(1).sub(f).pow(3).div(6)
      const w1 = f3.mul(3).sub(f2.mul(6)).add(4).div(6)
      const w2 = f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1).div(6)
      const w3 = f3.div(6)
      const g0 = w0.add(w1)
      const g1 = w2.add(w3)
      // Texel centres sit at whole numbers of `s`; uv is (s + 0.5) / TILE.
      const low = i.sub(0.5).add(w1.div(g0)).div(TILE)
      const high = i.add(1.5).add(w3.div(g1)).div(TILE)
      const read = (x: Node<'float'>, y: Node<'float'>) => texture(tile, vec2(x, y))
      return mix(
        mix(read(high.x, high.y), read(low.x, high.y), g0.x),
        mix(read(high.x, low.y), read(low.x, low.y), g0.x),
        g0.y,
      )
    }

    surface.color((_, { box, radius }) => {
      const size = u.size as unknown as Node<'vec2'>
      const aspect = size.div(max(size.x, size.y))
      const point = box.mul(aspect)
      const down = float(1).sub(box.y)
      let height: Node<'float'>
      if (style === 'contour') {
        height = smoothNoise(point.mul(0.4).add(nearLayer))
          .r.mul(0.7)
          .add(smoothNoise(point.mul(0.85).add(farLayer)).g.mul(0.3))
      } else {
        // Stretched along x, with a slow swell, so the lines flow sideways.
        const stretched = smoothNoise(vec2(point.x.mul(0.25), point.y.mul(0.7)).add(nearLayer)).r
        height = stretched.add(
          sin(point.x.mul(7.5).add(farLayer.x.mul(40)).add(down.mul(3))).mul(0.03),
        )
      }
      // Line number at this pixel: whole numbers fall on the lines.
      const level = down
        .add(height.sub(0.5).mul(4).mul(u.warp).mul(BEND[style]))
        .mul(max(u.lines, 1))
        .add(scrollShift)
      // Lines per device px, and CSS px per device px, from the derivatives.
      const density = max(length(vec2(dFdx(level), dFdy(level))), 1e-5)
      const cssX = box.x.mul(size.x)
      const cssPerPixel = max(length(vec2(dFdx(cssX), dFdy(cssX))), 1e-4)
      const fromLine = abs(fract(level.add(0.5)).sub(0.5))
      let ink: Node<'float'>
      if (style === 'stripes') {
        // Bands half a spacing wide around each line.
        ink = clamp(float(0.5).sub(fromLine.sub(0.25).div(density)), 0, 1)
        ink = mix(ink, 0.5, smoothstep(0.25, 0.5, density))
      } else {
        let width = u.thickness as unknown as Node<'float'>
        if (style === 'contour') {
          const line = floor(level.add(0.5))
          const isIndex = line.sub(floor(line.div(5)).mul(5)).lessThan(0.5)
          width = width.mul(select(isIndex, INDEX, 1))
        }
        const widthPixels = width.div(cssPerPixel)
        const cover = clamp(
          max(widthPixels.mul(0.5), 0.5).sub(fromLine.div(density)).add(0.5),
          0,
          1,
        )
        // Thinner than a device pixel: fainter instead of thinner.
        const solid = cover.mul(min(widthPixels, 1))
        // Where the relief flattens, lines fade instead of spreading into blots.
        const flat = smoothstep(0.004, 0.014, density.div(cssPerPixel))
        // Where lines crowd, they fade to their average ink.
        const average = min(widthPixels.mul(density), 1)
        ink = mix(solid, average, smoothstep(0.25, 0.5, density)).mul(flat)
      }
      return vec4(mix(u.background, u.color, ink), radius)
    })

    let phase = 0
    const slideLayers = (): void => {
      ;(nearLayer.value as Vector2).set(phase * 0.06, phase * -0.035)
      ;(farLayer.value as Vector2).set(phase * -0.045, phase * 0.05)
    }
    // The first frame draws before any update: start where the scroll already is.
    scrollShift.value = params.scroll * startProgress(ctx) * SCROLL
    slideLayers()

    return (input: EffectInput) => {
      if (input.reducedMotion) return
      if (params.fps > 0) phase += input.delta * params.speed
      scrollShift.value = params.scroll * input.progress * SCROLL
      slideLayers()
    }
  },
})
export default waves

/**
 * Two channels of tiling value noise in half floats, three smooth octaves; the other two channels
 * are 1. Eight-bit noise steps the lines by a pixel wherever they run along it, and finer octaves
 * make them jitter.
 */
function bakeNoise(seed: number): DataTexture {
  const random = rng(seed)
  const data = new Uint16Array(TILE * TILE * 4)
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
  for (let channel = 0; channel < 4; channel++) {
    const sum = new Float32Array(TILE * TILE)
    let weight = 0
    for (let cells = 4, amp = 1; channel < 2 && cells <= 16; cells *= 2, amp *= 0.45) {
      const lattice = Float32Array.from({ length: cells * cells }, random)
      const at = (x: number, y: number): number =>
        lattice[(y % cells) * cells + (x % cells)] as number
      for (let y = 0; y < TILE; y++) {
        const fy = (y * cells) / TILE
        const y0 = Math.floor(fy)
        const ty = fade(fy - y0)
        for (let x = 0; x < TILE; x++) {
          const fx = (x * cells) / TILE
          const x0 = Math.floor(fx)
          const tx = fade(fx - x0)
          const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx
          const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx
          sum[y * TILE + x] = (sum[y * TILE + x] as number) + (top + (bottom - top) * ty) * amp
        }
      }
      weight += amp
    }
    for (let i = 0; i < sum.length; i++)
      data[i * 4 + channel] = DataUtils.toHalfFloat(weight ? (sum[i] as number) / weight : 1)
  }
  const texture = new DataTexture(data, TILE, TILE, RGBAFormat, HalfFloatType)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.magFilter = texture.minFilter = LinearFilter
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}
