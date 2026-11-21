import type { Effect, EffectContext, FitOptions } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { spiralBlur } from '@dioramajs/effects/kit'
import {
  exp,
  float,
  max,
  positionLocal,
  sin,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Mesh, MeshBasicNodeMaterial, type Node, PlaneGeometry, Vector4 } from 'three/webgpu'
import { framing } from './slots'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Params = {
  strength: number
  reach: number
  blur: number
  gap: number
  trim: boolean
  ripple: number
  shadow: number
  fps: number
}

/** Longest reach of the reflection below the box, px: also the visibility bleed. */
const BLEED = 480
/** Taps of the blur, on a golden-angle spiral. */
const TAPS = 12
/** Taps across the base the contact shadow averages. */
const SPREAD = 8
/** Alpha above which a row of the picture counts as part of the object. */
const SOLID = 0.1
/** Columns of the copy the lowest solid row is looked for in. */
const PROBE = 64

/**
 * The share of the picture's height, from its top, down to the bottom of its lowest row with
 * something in it: 1 for a picture without transparency, or one that cannot be read.
 */
export function lowest(alpha: ArrayLike<number>, columns: number, rows: number): number {
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = 0; i < columns; i++) {
      if ((alpha[4 * (j * columns + i) + 3] as number) > SOLID * 255) return (j + 1) / rows
    }
  }
  return 1
}

/**
 * Where the row at `share` of a picture's height (from its top) lands in the box, as box UV with
 * y up, under the element's object-fit and object-position. Clamped to the box.
 */
export function floorOf(
  options: FitOptions,
  natural: readonly [number, number],
  box: readonly [number, number],
  share: number,
): number {
  const [imageWidth, imageHeight] = natural
  const [width, height] = box
  if (!(imageWidth > 0 && imageHeight > 0 && width > 0 && height > 0)) return 0
  const contain = Math.min(width / imageWidth, height / imageHeight)
  const scale =
    options.fit === 'cover'
      ? Math.max(width / imageWidth, height / imageHeight)
      : options.fit === 'contain'
        ? contain
        : options.fit === 'none'
          ? 1
          : options.fit === 'scale-down'
            ? Math.min(1, contain)
            : height / imageHeight
  const drawn = imageHeight * scale
  const top = (height - drawn) * (options.position?.[1] ?? 0.5)
  const y = Math.min(height, Math.max(0, top + share * drawn))
  return 1 - y / height
}

/** The picture's lowest solid row as `lowest` gives it, read from a small copy. */
function measure(el: HTMLImageElement): number {
  const width = el.naturalWidth
  const height = el.naturalHeight
  if (!(width > 0 && height > 0)) return 1
  const rows = Math.max(1, Math.min(256, Math.round((PROBE * height) / width)))
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(PROBE, rows)
      : Object.assign(document.createElement('canvas'), { width: PROBE, height: rows })
  const pen = canvas.getContext('2d', { willReadFrequently: true }) as Pick<
    CanvasRenderingContext2D,
    'drawImage' | 'getImageData'
  > | null
  if (!pen) return 1
  pen.drawImage(el, 0, 0, PROBE, rows)
  return lowest(pen.getImageData(0, 0, PROBE, rows).data, PROBE, rows)
}

/**
 * A soft reflection of a product photo on a glossy floor below it: the picture mirrored at its
 * base (the lowest solid row of a cutout, or the bottom edge of a photo), fading and blurring
 * with distance, with an optional contact shadow and ripple. It draws on the canvas below the
 * box: the element stays DOM, the layout does not move and clicks pass through.
 */
const reflection: Effect<Params> = defineEffect({
  name: 'reflection',
  params: {
    strength: 0.35,
    reach: 0.45,
    blur: 8,
    gap: 0,
    trim: true,
    ripple: 0,
    shadow: 0,
    fps: 30,
  },
  media: true,
  bleed: BLEED,
  quality: { low: { blur: 0, fps: 15 } },
  animate: {
    fps: (ctx) => (ctx.params.ripple > 0 && !ctx.input.reducedMotion ? ctx.params.fps : 0),
  },
  setup(ctx: EffectContext<Params>) {
    const { params, u, app } = ctx
    const el = ctx.element as HTMLImageElement | HTMLVideoElement
    const video = el.localName === 'video'
    const fit = framing(el)
    let share = 1
    if (!video && params.trim) {
      try {
        share = measure(el as HTMLImageElement)
      } catch (error) {
        app.log.warn(
          'reflection: cannot read the picture to find its base (cross-origin without CORS?), it reflects from the bottom edge',
          error,
        )
      }
    }
    const taps = ctx.quality === 'low' ? 1 : TAPS
    // (floor in box UV with y up, gap px, unused, unused).
    const state = uniform(new Vector4())
    const floorLine = (state as unknown as V4).x
    const gap = (state as unknown as V4).y
    const size = u.size as unknown as V2
    const reach = u.reach.clamp(0, 1) as unknown as F

    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    // The plane hangs below the floor line: its top on the line (less `gap`), `reach` of the
    // element's height long.
    const top = floorLine.sub(0.5).sub(gap.div(max(size.y, 1)))
    material.positionNode = vec3(
      positionLocal.x,
      top.sub(float(0.5).sub(positionLocal.y).mul(reach)),
      0,
    )
    // 0 at the floor line, 1 at the far end of the reflection.
    const below = uv().y.oneMinus() as unknown as F
    // Depth below the floor, px: the mirrored point is as far above it.
    const depth = below.mul(reach, size.y)
    const wave = sin(depth.mul(0.22).add(uv().x.mul(size.x).mul(0.03)).sub(u.time.mul(2.4)))
    const sway = u.ripple.max(0).mul(below).mul(wave).div(max(size.x, 1))
    const mirrored = vec2(uv().x.add(sway), floorLine.add(below.mul(reach)))
    // The element's picture at box UV, premultiplied, transparent outside its masks.
    const read = (at: V2): V4 => {
      const inBox = vec2(at.x.clamp(0, 1), at.y.clamp(0, 1)) as unknown as V2
      const color = texture(ctx.map, ctx.coverUV(inBox) as never) as unknown as V4
      return vec4(color.rgb.mul(color.a), color.a).mul(ctx.mask(inBox)) as unknown as V4
    }
    // Blur grows with depth; colours are averaged by alpha, so cutout edges do not grey.
    const radius = u.blur.max(0).mul(below).div(size) as unknown as V2
    const average = spiralBlur(read, mirrored as unknown as V2, radius, taps)
    const fade = below.oneMinus().pow(2).mul(u.strength.clamp(0, 1))
    const lit = average.a.mul(fade)
    const rgb = average.rgb.div(max(average.a, 1e-4)) as unknown as V3
    // The contact shadow: the base's coverage, wider and softer with depth.
    const base = floorLine.add(float(3).div(max(size.y, 1)))
    const across = float(8).add(depth.mul(0.6)).div(max(size.x, 1))
    let cover = float(0) as unknown as F
    for (let i = 0; i < SPREAD; i++) {
      // -1..1 across the spread.
      const offset = (i / (SPREAD - 1)) * 2 - 1
      cover = cover.add(read(vec2(uv().x.add(across.mul(offset)), base)).a) as unknown as F
    }
    const soft = max(reach.mul(size.y).mul(0.12), 6)
    const dark = cover
      .div(SPREAD)
      .mul(exp(depth.div(soft).negate()), u.shadow.clamp(0, 1)) as unknown as F
    const alpha = lit.add(dark.mul(lit.oneMinus()))
    material.colorNode = vec4(rgb.mul(lit).div(max(alpha, 1e-4)), alpha)
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.frustumCulled = false
    // Under the copies of other elements, which draw over it.
    mesh.renderOrder = -1
    ctx.place(mesh)

    const natural = (): readonly [number, number] =>
      video
        ? [(el as HTMLVideoElement).videoWidth, (el as HTMLVideoElement).videoHeight]
        : [(el as HTMLImageElement).naturalWidth, (el as HTMLImageElement).naturalHeight]
    return (input) => {
      const floor = params.trim ? floorOf(fit, natural(), [input.width, input.height], share) : 0
      ;(state.value as Vector4).set(floor, params.gap, 0, 0)
      mesh.visible = params.strength > 0 || params.shadow > 0
    }
  },
})
export default reflection
