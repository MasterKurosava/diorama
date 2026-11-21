import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither } from '@dioramajs/effects/kit'
import {
  abs,
  clamp,
  exp,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  select,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { startProgress } from './progress'
import { checkTarget } from './target'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Vec3 = Node<'vec3'>
type Params = {
  style: ChoiceParam<'neon' | 'blueprint' | 'minimal'>
  color: ColorParam
  background: ColorParam
  accent: ColorParam
  cells: number
  horizon: number
  speed: number
  sun: number
  thickness: number
  depth: number
  scroll: number
  fps: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Cells a second the floor travels at speed 1. */
const TRAVEL = 2
/** Cells the floor travels over the whole scroll progress at scroll 1. */
const SCROLL = 6
/** Focal length as a share of the box width: lower spreads the floor wider. */
const FOCAL = 0.55
/** Sideways camera shift at depth 1 with the pointer at an edge, as a share of the box width. */
const PAN = 0.35
/** Blueprint: every fifth line is a major line, this much thicker. */
const MAJOR = 1.8

/**
 * A floor of grid lines in perspective that runs towards the viewer, under a sky with a glow on
 * the horizon and an optional sun: neon synthwave, a blueprint or plain thin lines. Lines keep
 * their width in CSS px and fade to an even tone where they crowd near the horizon.
 */
const grid: Effect<Params> = defineEffect({
  name: 'grid',
  params: {
    style: oneOf('neon', 'blueprint', 'minimal'),
    color: color('#ff4fd8'),
    background: color('#0d0221'),
    accent: color('#ff8a3d'),
    cells: 14,
    horizon: 0.5,
    speed: 0.4,
    sun: 0.5,
    thickness: 1.2,
    depth: 0.2,
    scroll: 0.3,
    fps: 30,
  },
  animate: { fps: (ctx) => ctx.params.fps },
  quality: { low: { fps: 15 }, medium: { fps: 24 } },
  setup(ctx: EffectContext<Params>) {
    const { params, surface, u } = ctx
    if (DEV) checkTarget(ctx, 'grid')
    const style = params.style
    const travel = uniform(0)
    const pan = uniform(0)

    surface.color((_, { box, radius }) => {
      const size = u.size as unknown as Vec2
      const line = u.color as unknown as Vec3
      const background = u.background as unknown as Vec3
      const glow = u.accent as unknown as Vec3
      // Horizon height from the bottom, in box UV; the floor below, the sky above.
      const horizon = float(1).sub(clamp(u.horizon, 0.05, 0.95))
      const below = horizon.sub(box.y)
      const belowPx = max(below.mul(size.y), 0.5)
      const floorPx = horizon.mul(size.y)
      // A pinhole camera over the floor, its height set so `cells` span the bottom edge.
      const height = max(u.cells, 1).mul(floorPx).div(size.x)
      const screenX = box.x.sub(0.5).mul(size.x).add(pan.mul(size.x))
      // Floor coordinates in cells: across, and away from the viewer.
      const floorX = screenX.mul(height).div(belowPx)
      const floorZ = height.mul(size.x.mul(FOCAL)).div(belowPx).add(travel)
      // Distance to the nearest line in device px, through the derivatives.
      const stepX = max(fwidth(floorX), 1e-5)
      const stepZ = max(fwidth(floorZ), 1e-5)
      const toLineX = abs(fract(floorX.add(0.5)).sub(0.5)).div(stepX)
      const toLineZ = abs(fract(floorZ.add(0.5)).sub(0.5)).div(stepZ)
      // CSS px per device px, so the width holds at any pixel ratio.
      const cssPerPixel = max(fwidth(box.x.mul(size.x)), 1e-4)
      const width = (u.thickness as unknown as Float).div(cssPerPixel)
      // Blueprint: every fifth line of each direction is a major line.
      const major = (coordinate: Float): Float => {
        if (style !== 'blueprint') return float(1) as unknown as Float
        const index = floor(coordinate.add(0.5))
        const isMajor = abs(index.sub(floor(coordinate.add(0.5).div(5)).mul(5))).lessThan(0.5)
        return select(isMajor, MAJOR, 1) as unknown as Float
      }
      const stroke = (distance: Float, step: Float, lineWidth: Float): Float => {
        const solid = clamp(max(lineWidth.mul(0.5), 0.5).sub(distance).add(0.5), 0, 1).mul(
          min(lineWidth, 1),
        )
        // Where lines crowd, a faint even tone that fades out instead of moiré or a solid band.
        const tone = min(lineWidth.mul(step), 1)
          .mul(0.3)
          .mul(float(1).sub(smoothstep(0.5, 3, step)))
        return mix(solid, tone, smoothstep(0.2, 0.5, step))
      }
      const ink = max(
        stroke(toLineX, stepX, width.mul(major(floorX))),
        stroke(toLineZ, stepZ, width.mul(major(floorZ))),
      )
      // Near the horizon the floor sinks into haze.
      const near = clamp(below.div(max(horizon, 1e-3)), 0, 1)
      const haze = smoothstep(0, 0.3, near)
      const sky = clamp(box.y.sub(horizon).div(max(float(1).sub(horizon), 1e-3)), 0, 1)
      // Sun: a disc sitting on the horizon, radius a share of the sky's height.
      const sunRadius = u.sun.mul(0.75).mul(float(1).sub(horizon)).mul(size.y)
      const fromSun = vec2(
        box.x.sub(0.5).mul(size.x),
        box.y.sub(horizon).mul(size.y).sub(sunRadius.mul(0.35)),
      )
      const sunDistance = length(fromSun)
      const antialias = cssPerPixel.mul(1.2)
      const disc = float(1)
        .sub(smoothstep(sunRadius.sub(antialias), sunRadius.add(antialias), sunDistance))
        .mul(select(u.sun.greaterThan(0), 1, 0))
      // Height inside the sun disc, 0 at its bottom, 1 at its top.
      const sunHeight = clamp(fromSun.y.div(max(sunRadius, 1)).mul(0.5).add(0.5), 0, 1)
      let floorColor: Vec3
      let skyColor: Vec3
      if (style === 'neon') {
        // Lines with a soft halo, the floor dark, the sky warming to the glow at the horizon.
        const halo = exp(min(toLineX, toLineZ).negate().div(width.mul(3).add(2))).mul(0.45)
        const lit = max(ink, halo.mul(float(1).sub(smoothstep(0.2, 0.5, max(stepX, stepZ)))))
        floorColor = mix(background, mix(glow, line, haze), lit.mul(mix(0.6, 1, haze)))
        floorColor = mix(floorColor, glow, float(1).sub(haze).mul(0.35))
        skyColor = mix(glow.mul(0.8), background, smoothstep(0, 0.45, sky))
        skyColor = skyColor.add(glow.mul(exp(sky.negate().mul(14)).mul(0.6)))
        // The lower part of the sun cut by bands that thicken towards the horizon.
        const band = clamp(float(0.72).sub(sunHeight).mul(1.3), 0, 0.7)
        const cut = select(
          band.greaterThan(0.005),
          smoothstep(band, band.add(0.08), fract(sunHeight.mul(12))),
          1,
        )
        const sunColor = mix(line, mix(glow, vec3(1, 0.93, 0.6), 0.6), sunHeight)
        skyColor = mix(skyColor, sunColor, disc.mul(cut))
        skyColor = skyColor.add(
          glow.mul(
            exp(sunDistance.div(max(sunRadius, 1)).negate().mul(1.6))
              .mul(u.sun)
              .mul(0.5),
          ),
        )
      } else if (style === 'blueprint') {
        // Pale lines on the paper colour, a faint haze for the horizon, the sun as a drawn circle.
        const mist = mix(background, glow, 0.25)
        floorColor = mix(mist, mix(background, line, ink.mul(0.85)), haze)
        skyColor = mix(mist, background, smoothstep(0, 0.5, sky))
        const ring = float(1).sub(
          smoothstep(0, antialias.mul(1.4), abs(sunDistance.sub(sunRadius)).sub(width.mul(0.5))),
        )
        skyColor = mix(skyColor, line, ring.mul(select(u.sun.greaterThan(0), 0.85, 0)))
      } else {
        // Thin lines that fade out towards the horizon over a flat colour; the sun a flat disc.
        floorColor = mix(background, line, ink.mul(smoothstep(0.05, 0.7, near)).mul(0.55))
        skyColor = mix(background, glow, disc)
      }
      const rgb = select(below.greaterThan(0), floorColor, skyColor).clamp(0, 1)
      return vec4(rgb.add(dither()), radius)
    })

    let clock = 0
    // The first frame draws before any update: start where the scroll already is.
    travel.value = params.scroll * startProgress(ctx) * SCROLL

    return (input: EffectInput) => {
      if (input.reducedMotion) return
      if (params.fps > 0) clock += input.delta * params.speed * TRAVEL
      travel.value = clock + params.scroll * input.progress * SCROLL
      // At depth 0 the pointer is never read: reading it makes every pointer move draw a frame.
      const hover = params.depth > 0 ? input.hover : 0
      pan.value = hover > 0 ? (input.pointer.x - 0.5) * hover * params.depth * PAN : 0
    }
  },
})
export default grid
