import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { approach, chase, dither, ease } from '@dioramajs/effects/kit'
import {
  cbrt,
  clamp,
  cos,
  dFdx,
  dFdy,
  dot,
  fract,
  length,
  mat3,
  max,
  mix,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { type Color, Matrix3, type Node, Vector3, Vector4 } from 'three/webgpu'

type F = Node<'float'>
type Params = {
  style: ChoiceParam<'duotone' | 'halftone'>
  color: ColorParam
  background: ColorParam
  strength: number
  contrast: number
  cell: number
  angle: number
  reveal: ChoiceParam<'none' | 'fade' | 'spot' | 'view'>
  radius: number
  duration: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** OKLab (Björn Ottosson): linear sRGB to cone response. Rows as written, so transposed. */
export const LMS: Matrix3 = new Matrix3()
  .fromArray([
    0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566,
    0.0883024619, 0.2817188376, 0.6299787005,
  ])
  .transpose()
/** Cube roots of the cone response to Lab. */
export const LAB: Matrix3 = new Matrix3()
  .fromArray([
    0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099,
    0.0259040371, 0.7827717662, -0.808675766,
  ])
  .transpose()
const TO_RGB = LMS.clone().invert()
/** The first row of LAB: OKLab lightness from the cube roots. */
const LIGHTNESS = new Vector3(0.2104542553, 0.793617785, -0.0040720468)

/** Cube roots of the cone response of a linear sRGB colour: OKLab before its last matrix. */
export function cone(color: Color, out: Vector3 = new Vector3()): Vector3 {
  out.set(color.r, color.g, color.b).applyMatrix3(LMS)
  return out.set(Math.cbrt(out.x), Math.cbrt(out.y), Math.cbrt(out.z))
}

/**
 * The ends of the tone as cube roots, darker first, and whether `color` was the lighter one. `color`
 * is the ink and `background` the paper by role, so light ink on dark paper keeps the photo's shadows
 * dark instead of turning it into a negative.
 */
function ends(dark: Color, light: Color, darkOut: Vector3, lightOut: Vector3): boolean {
  cone(dark, darkOut)
  cone(light, lightOut)
  const flip = darkOut.dot(LIGHTNESS) > lightOut.dot(LIGHTNESS)
  if (flip) {
    const { x, y, z } = darkOut
    darkOut.copy(lightOut)
    lightOut.set(x, y, z)
  }
  return flip
}

/** Reduced-motion fade, s. */
const CALM = 0.15
/** The spot's centre trails the pointer by this, s. */
const TRAIL = 0.06
/** Feathered rim of the spot, as a share of its radius. */
const FEATHER = 0.45
/** reveal 'view': the colour is back while the image's middle is in this band of the viewport. */
const BAND = [0.25, 0.75] as const
/** Halftone dots fill a quarter circle's area, π/4, before they touch their neighbours. */
const TOUCH = Math.PI / 4
/**
 * Fit of the radius r of a dot clipped by its cell, from how far the cell has closed (s):
 * (r - 0.5) / (√½ - 0.5) = a·(1 - √(1 - s)) - b·s.
 */
const CLIP = [1.2233794, 0.2061065] as const

/**
 * Photos in brand colors: a duotone or a halftone in OKLab, which a CSS filter on the image
 * cannot give its copy, with the color back on hover or in a spot at the pointer.
 */
const tone: Effect<Params> = defineEffect({
  name: 'tone',
  params: {
    style: oneOf('duotone', 'halftone'),
    color: color('#000000'),
    background: color('#ffffff'),
    strength: 1,
    contrast: 1,
    cell: 6,
    angle: 45,
    reveal: oneOf('none', 'fade', 'spot', 'view'),
    radius: 140,
    duration: 0.4,
  },
  media: true,
  setup(ctx: EffectContext<Params>) {
    const { params, signal, u } = ctx
    const el = ctx.element as HTMLElement
    const halftone = params.style === 'halftone'
    const reveal = params.reveal
    // OKLab of the ends before the last matrix, where a straight line in Lab is still straight:
    // the mix happens there and only the cube and the matrix to sRGB remain per pixel. Darker
    // first, whichever param it came from; `flip` is 1 when the ink is the lighter end.
    const darkCone = uniform(new Vector3())
    const lightCone = uniform(new Vector3())
    const flip = uniform(0)
    // (colour back by the fade, spot radius px, spot centre px with y up).
    const look = uniform(new Vector4())
    const lms = mat3(LMS)
    const lab = vec3(...LIGHTNESS.toArray())
    ctx.surface.color((color, { uv }) => {
      const rgb = color.rgb.max(0)
      const lightness = dot(cbrt(lms.mul(rgb) as never) as unknown as Node<'vec3'>, lab)
      // Where the pixel falls between the dark and the light end, 0..1.
      const level = clamp(lightness.sub(0.5).mul(u.contrast).add(0.5), 0, 1) as unknown as F
      let toned: Node<'vec3'>
      if (halftone) {
        // Dot area is chosen so a cell averages the light of the duotone at `level` (Y ≈ L³),
        // the way print matches tone. `shade` is the darker end's share; light ink covers the
        // rest.
        const darkL = dot(lab, darkCone)
        const lightL = dot(lab, lightCone)
        const levelL = mix(darkL, lightL, level)
        const darkY = darkL.mul(darkL, darkL)
        const lightY = lightL.mul(lightL, lightL)
        const shade = clamp(
          lightY.sub(levelL.mul(levelL, levelL)).div(max(lightY.sub(darkY), 1e-4)),
          0,
          1,
        )
        const cover = mix(shade, shade.oneMinus(), flip)
        // A grid of `cell` CSS px about the box centre, turned by `angle`; distances in cells.
        const angle = u.angle.mul(Math.PI / 180)
        const inCells = uv.sub(0.5).mul(u.size).div(max(u.cell, 1))
        const turned = vec2(
          inCells.x.mul(cos(angle)).add(inCells.y.mul(sin(angle))),
          inCells.y.mul(cos(angle)).sub(inCells.x.mul(sin(angle))),
        )
        const fromDot = length(fract(turned).sub(0.5))
        // One device pixel in cells, the width of the antialiased rim. From the grid, not from
        // the distance: fwidth of a distance is up to √2 too wide across the diagonal, which
        // makes small light holes vanish and dark tones too light on DPR 1.
        const pixel = max(length(dFdx(turned)), length(dFdy(turned)), 1e-4)
        // Past π/4 a dot is a circle clipped by its cell: its radius inverts that area by the
        // CLIP fit, within 0.2% of the cell. At black it reaches half a pixel past the corner, so
        // no light point is left there.
        const closed = cover
          .sub(TOUCH)
          .div(1 - TOUCH)
          .clamp(0, 1)
        const grown = sqrt(closed.oneMinus())
          .oneMinus()
          .mul(CLIP[0])
          .sub(closed.mul(CLIP[1]))
          .mul(Math.SQRT1_2 - 0.5)
          .add(pixel.mul(pow(closed, 16), 0.5))
          .add(0.5)
        const radius = select(cover.lessThan(TOUCH), sqrt(cover.div(Math.PI)), grown)
        // A dot smaller than a pixel fades by its area instead of showing as half a pixel.
        const small = radius.mul(2).div(pixel).min(1)
        const ink = clamp(radius.sub(fromDot).div(pixel).add(0.5), 0, 1).mul(small, small)
        toned = mix(u.background.rgb, u.color.rgb, ink) as unknown as Node<'vec3'>
      } else {
        const cones = mix(darkCone, lightCone, level)
        const out = mat3(TO_RGB).mul(cones.mul(cones, cones)).clamp(0, 1)
        toned = out.add(dither(out)) as unknown as Node<'vec3'>
      }
      let amount: F = u.strength as unknown as F
      if (reveal !== 'none') {
        const back = look.x
        let spot: F = back as unknown as F
        if (reveal === 'spot') {
          const fromSpot = uv.mul(u.size).sub(look.zw)
          const inner = look.y.mul(1 - FEATHER)
          const lit = smoothstep(inner, look.y.max(inner.add(1e-3)), length(fromSpot)).oneMinus()
          spot = max(back, lit) as unknown as F
        }
        amount = amount.mul(spot.oneMinus()) as unknown as F
      }
      return vec4(mix(color.rgb, toned, amount), color.a)
    })

    const order = (): void => {
      const dark = darkCone.value as Vector3
      const light = lightCone.value as Vector3
      flip.value = ends(u.color.value as Color, u.background.value as Color, dark, light) ? 1 : 0
    }
    order()
    if (reveal === 'none') {
      return (): boolean => {
        order()
        return false
      }
    }

    // Pointer over the image (mouse or pen: on touch the tone stays), and where.
    let over = false
    const aim = { x: 0, y: 0 }
    const at = { x: 0, y: 0 }
    let placed = false
    // Progress of the colour coming back, 0..1, eased into the fade or the spot's size.
    let progress = 0
    // view: the first frame shows the state of where the page is, without a fade.
    let first = true
    const point = (e: PointerEvent): void => {
      const rect = el.getBoundingClientRect()
      aim.x = e.clientX - rect.left
      aim.y = rect.bottom - e.clientY
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler, { signal })
    const wake = (): void => ctx.invalidate()
    listen('pointerenter', (e) => {
      if (e.pointerType === 'touch' || reveal === 'view') return
      over = true
      point(e)
      if (!placed) {
        at.x = aim.x
        at.y = aim.y
        placed = true
      }
      wake()
    })
    if (reveal === 'spot') {
      listen('pointermove', (e) => {
        if (e.pointerType === 'touch' || !over) return
        point(e)
        // Under reduced motion the spot is a fade: a move changes nothing on screen.
        if (!ctx.input.reducedMotion) wake()
      })
    }
    listen('pointerleave', (e) => {
      if (e.pointerType === 'touch' || reveal === 'view') return
      over = false
      wake()
    })

    return (input): boolean => {
      order()
      const dt = input.delta
      const still = input.reducedMotion
      let goal = over ? 1 : 0
      if (reveal === 'view') {
        const viewportHeight = ctx.app.stage.height.peek() || 1
        const middle = (input.y + input.height / 2) / viewportHeight
        goal = middle >= BAND[0] && middle <= BAND[1] ? 1 : 0
        if (first) progress = goal
        first = false
      }
      if (progress !== goal) {
        const span = Math.max(still ? CALM : params.duration, 1e-3)
        progress = approach(progress, goal, dt / span)
      }
      const eased = still ? progress : ease('cubicInOut', progress)
      // Reduced motion turns the spot into the fade: nothing follows the pointer.
      const spot = reveal === 'spot' && !still
      const trailing = spot && chase(at, aim, dt <= 0 || progress <= 0 ? 0 : TRAIL, dt, 0.05)
      ;(look.value as Vector4).set(spot ? 0 : eased, spot ? params.radius * eased : 0, at.x, at.y)
      return progress !== goal || trailing
    }
  },
})
export default tone
