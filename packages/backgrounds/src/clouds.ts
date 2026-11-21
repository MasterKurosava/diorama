import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, noise } from '@dioramajs/effects/kit'
import {
  clamp,
  exp,
  float,
  floor,
  hash,
  length,
  max,
  mix,
  normalize,
  smoothstep,
  texture,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, type Node, Vector2 } from 'three/webgpu'
import { startProgress } from './progress'
import { checkTarget } from './target'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Vec3 = Node<'vec3'>
type Style = 'day' | 'sunset' | 'night'
type Params = {
  style: ChoiceParam<Style>
  cover: number
  speed: number
  scale: number
  sun: number
  depth: number
  scroll: number
  layers: number
  fps: number
  seed: number
}

interface Preset {
  /** Sky from the horizon up: bottom, middle, top. */
  readonly sky: readonly [string, string, string]
  /** Sunlit side of the clouds, their shaded side. */
  readonly light: string
  readonly shade: string
  /** Sun or moon colour and its place in box UV, y up. */
  readonly sun: string
  readonly at: readonly [number, number]
  /** Strength of the glow around it. */
  readonly glow: number
}

/** The time of day: sky, cloud light and the sun or the moon. */
const PRESETS: Record<Style, Preset> = {
  day: {
    sky: ['#d6ecf8', '#8ec4ec', '#3b7fd4'],
    light: '#ffffff',
    shade: '#a7b6ca',
    sun: '#fff5d8',
    at: [0.82, 0.88],
    glow: 0.45,
  },
  sunset: {
    sky: ['#ffb26e', '#ee7d8c', '#37397f'],
    light: '#ffd3a6',
    shade: '#6a4775',
    sun: '#ffcf8a',
    at: [0.7, 0.16],
    glow: 0.7,
  },
  night: {
    sky: ['#1e2e54', '#101b38', '#050a19'],
    light: '#7d8db4',
    shade: '#121a30',
    sun: '#eef2ff',
    at: [0.24, 0.8],
    glow: 0.06,
  },
}

/** Cloud layers far to near: noise frequency, wind share, parallax share, opacity. */
const LAYERS = [
  { freq: 1.6, wind: 0.5, near: 0.35, alpha: 0.75 },
  { freq: 1.05, wind: 0.75, near: 0.65, alpha: 0.9 },
  { freq: 0.7, wind: 1, near: 1, alpha: 1 },
] as const
/** Wind in noise tiles a second at speed 1. */
const WIND = 0.15
/** Noise tiles per box width overhead at scale 1: small enough for detail, large enough for shapes. */
const FREQ = 0.8
/** Scroll: how far the nearest layer moves over the whole progress at scroll 1, in noise tiles. */
const SCROLL = 0.6
/** Pointer: how far the nearest layer moves at depth 1 with the pointer at an edge. */
const LEAN = 0.08
/** Step towards the sun for the self-shadow, in box UV. */
const STEP = 0.025

/**
 * A sky of soft clouds in layers over a gradient for the time of day: daylight, a sunset or a
 * moonlit night with stars. Each layer is baked noise under a perspective that shrinks clouds
 * towards the horizon, lit from the sun by a step towards it; wind moves the layers, nearer
 * ones faster, and the scroll and the pointer shift them apart.
 */
const clouds: Effect<Params> = defineEffect({
  name: 'clouds',
  params: {
    style: oneOf('day', 'sunset', 'night'),
    cover: 0.5,
    speed: 0.2,
    scale: 1,
    sun: 0.6,
    depth: 0.2,
    scroll: 0.3,
    layers: 3,
    fps: 30,
    seed: 1,
  },
  rebuild: ['layers', 'seed'],
  animate: { fps: (ctx) => ctx.params.fps },
  quality: { low: { fps: 15, layers: 1 }, medium: { fps: 24, layers: 2 } },
  setup(ctx: EffectContext<Params>) {
    const { params, surface, u } = ctx
    if (DEV) checkTarget(ctx, 'clouds')
    const preset = PRESETS[params.style]
    const night = params.style === 'night'
    const tile = noise(ctx, { size: 256, seed: params.seed, channels: 2 })
    const count = Math.min(3, Math.max(1, Math.round(params.layers)))
    // One layer keeps the nearest; two the farthest and the nearest.
    const layers = count === 1 ? [LAYERS[2]] : count === 2 ? [LAYERS[0], LAYERS[2]] : LAYERS
    const wind = uniform(0)
    const lift = uniform(0)
    const lean = uniform(new Vector2())
    const rgbOf = (hex: string): Vec3 => {
      const { r, g, b } = new Color(hex)
      return vec3(r, g, b) as unknown as Vec3
    }
    const [horizon, middle, zenith] = preset.sky.map(rgbOf) as [Vec3, Vec3, Vec3]
    const light = rgbOf(preset.light)
    const shade = rgbOf(preset.shade)
    const sunColor = rgbOf(preset.sun)
    const [sunX, sunY] = preset.at

    surface.color((_, { box, radius }) => {
      const size = u.size as unknown as Vec2
      const wide = size.x.div(max(size.y, 1))
      const y = box.y
      let rgb: Vec3 = mix(
        mix(horizon, middle, smoothstep(0, 0.45, y)),
        zenith,
        smoothstep(0.35, 1, y),
      )
      // The sun's glow and disc, round on any aspect.
      const sunDistance = length(vec2(box.x.sub(sunX).mul(wide), y.sub(sunY)))
      const sun = u.sun as unknown as Float
      rgb = rgb.add(
        sunColor.mul(exp(sunDistance.mul(sunDistance).mul(-9)).mul(sun).mul(preset.glow)),
      )
      const disc = float(1)
        .sub(smoothstep(0.035, 0.045, sunDistance))
        .mul(smoothstep(0, 0.01, sun))
      rgb = mix(rgb, sunColor, disc)
      if (night) rgb = rgb.add(vec3(starLight(box, size).mul(0.9)))

      // Cover 0 clears the sky, 1 covers it.
      const threshold = mix(0.62, 0.4, clamp(u.cover, 0, 1))
      const towardSun = normalize(vec2(sunX, sunY).sub(box).add(vec2(0, 1e-4))).mul(STEP)
      const haze = smoothstep(0, 0.35, y)
      for (const layer of layers) {
        const here = billows(skyPlane(box, layer, wide), layer.near)
        // At cover 0 no stray wisp is left in a clear sky.
        const coverage = smoothstep(threshold, threshold.add(0.11), here).mul(
          smoothstep(0, 0.02, u.cover),
        )
        // Denser towards the sun: this side is in the cloud's own shadow.
        const ahead = billows(skyPlane(box.add(towardSun), layer, wide), layer.near)
        const thick = smoothstep(threshold, threshold.add(0.3), here)
        const shadow = clamp(ahead.sub(here).mul(7).add(thick.mul(0.55)), 0, 1)
        let cloud: Vec3 = mix(light, shade, shadow)
        // Thin edges facing the sun glow.
        cloud = cloud.add(
          sunColor.mul(
            float(1)
              .sub(thick)
              .mul(clamp(here.sub(ahead).mul(6), 0, 1))
              .mul(sun.mul(0.4)),
          ),
        )
        // Far and low clouds fade into the colour of the horizon.
        cloud = mix(horizon, cloud, haze.mul(0.6).add(0.4))
        rgb = mix(rgb, cloud, coverage.mul(layer.alpha).mul(haze.mul(0.75).add(0.25)))
      }
      return vec4(rgb.clamp(0, 1).add(dither()), radius)
    })

    /** Night stars: one in a few dozen 4 px cells, a soft dot at a random spot of its cell. */
    function starLight(box: Vec2, size: Vec2): Float {
      const grid = box.mul(size).div(4)
      const cell = floor(grid)
      const id = uint(cell.x).add(uint(cell.y).mul(4096))
      const chance = hash(id)
      const spot = vec2(hash(id.add(7919)), hash(id.add(104729)))
        .mul(0.6)
        .add(0.2)
      const dot = float(1).sub(smoothstep(0.05, 0.3, length(grid.sub(cell).sub(spot))))
      return smoothstep(0.975, 1, chance)
        .mul(dot)
        .mul(smoothstep(0.15, 0.6, box.y)) as unknown as Float
    }

    /** Sky looked at from below: a plane over the viewer, farther towards the horizon. */
    function skyPlane(at: Vec2, layer: (typeof LAYERS)[number], wide: Float): Vec2 {
      return vec2(at.x.sub(0.5).mul(wide), 1)
        .div(at.y.add(0.32))
        .mul(layer.freq * FREQ)
        .div(max(u.scale, 0.1))
        .add(vec2(wind.mul(layer.wind), lift.mul(layer.near)))
        .add(lean.mul(layer.near)) as unknown as Vec2
    }

    /** Cloud density from three octaves: the shape, its billows and wisps on the edges. */
    function billows(point: Vec2, offset: number): Float {
      return texture(tile, point)
        .r.mul(0.56)
        .add(texture(tile, point.mul(2.6).add(vec2(0.37, 0.71 + offset))).g.mul(0.3))
        .add(
          texture(tile, point.mul(6.9).add(vec2(0.53 + offset, 0.19))).r.mul(0.14),
        ) as unknown as Float
    }

    let windTravel = 0
    const move = (progress: number): void => {
      wind.value = windTravel
      lift.value = -(progress - 0.5) * params.scroll * SCROLL
    }
    // The first frame draws before any update: start where the scroll already is.
    move(startProgress(ctx))

    return (input: EffectInput) => {
      if (input.reducedMotion) return
      if (params.fps > 0) windTravel += input.delta * params.speed * WIND
      move(input.progress)
      // At depth 0 the pointer is never read: reading it makes every pointer move draw a frame.
      const hover = params.depth > 0 ? input.hover : 0
      ;(lean.value as Vector2).set(
        hover > 0 ? (input.pointer.x - 0.5) * hover * params.depth * LEAN : 0,
        hover > 0 ? (input.pointer.y - 0.5) * hover * params.depth * LEAN : 0,
      )
    }
  },
})
export default clouds
