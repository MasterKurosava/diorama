import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, noise, oklabToLinear, rng, toOklab } from '@dioramajs/effects/kit'
import {
  dot,
  exp,
  floor,
  hash,
  max,
  min,
  select,
  sin,
  texture,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { type Color, type Node, Vector2, Vector3, Vector4 } from 'three/webgpu'
import { steps } from './clock'
import { startProgress } from './progress'
import { checkTarget } from './target'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Params = {
  style: ChoiceParam<'mesh' | 'aurora'>
  color1: ColorParam
  color2: ColorParam
  color3: ColorParam
  color4: ColorParam
  speed: number
  scale: number
  warp: number
  attract: number
  scroll: number
  grain: number
  fps: number
  octaves: number
  seed: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/**
 * Horizontal and vertical frequencies of the blobs' Lissajous paths, in the ratio 2:3:5:7, so the
 * whole picture repeats only after minutes.
 */
const FREQ_X = [0.5, 0.75, 1.25, 1.75]
const FREQ_Y = [0.75, 1.25, 1.75, 0.5]
/** Share of `attract` each blob moves towards the pointer: they lean in without merging. */
const PULL = [1, 0.7, 0.45, 0.25]
/** Blob radius at scale 1, as a share of the box's longer side. */
const SIGMA = 0.22
/** Largest warp offset at warp 1, as a share of the longer side. */
const WARP = 0.8
/** Phase shift in radians over the whole scroll progress at scroll 1. */
const SCROLL = 4
/** Aurora: waves of each curtain along x, per box width. */
const WAVES = [1.3, 0.9, 1.7]
/** Aurora: how far a curtain waves up and down, as a share of the longer side. */
const SWAY = 0.05
/** Aurora: how fast a curtain's glow fades above and below its edge, per sigma. */
const FADE_UP = 0.6
const FADE_DOWN = 1.6
/** Aurora: how strongly the rays vary the curtains' brightness. */
const RAYS = 5

/**
 * Four soft colour blobs drift over the element on Lissajous paths, or three curtains of light wave
 * over the first colour, warped by noise, drawn to the pointer and shifted by scroll. Mixed in
 * OKLab, dithered against banding, with optional grain.
 */
const gradient: Effect<Params> = defineEffect({
  name: 'gradient',
  params: {
    style: oneOf('mesh', 'aurora'),
    color1: color('#0b1d3a'),
    color2: color('#3a2b8c'),
    color3: color('#e35d6a'),
    color4: color('#f6c177'),
    speed: 0.2,
    scale: 1,
    warp: 0.4,
    attract: 0.15,
    scroll: 0.25,
    grain: 0.03,
    fps: 30,
    octaves: 2,
    seed: 1,
  },
  rebuild: ['octaves', 'seed'],
  animate: { fps: (ctx) => ctx.params.fps },
  quality: { low: { fps: 15, octaves: 1 }, medium: { fps: 24 } },
  setup(ctx: EffectContext<Params>) {
    const { params, surface, u } = ctx
    if (DEV) checkTarget(ctx, 'gradient')
    // One component per blob: its OKLab colour in labL, labA, labB, its centre in box UV in
    // centerX, centerY.
    const labL = uniform(new Vector4())
    const labA = uniform(new Vector4())
    const labB = uniform(new Vector4())
    const centerX = uniform(new Vector4())
    const centerY = uniform(new Vector4())
    const drift = uniform(new Vector2())
    // The grain's frame number follows the clock at `fps`, so grain never asks for frames.
    const grainFrame = uniform(0)
    const random = rng(params.seed)
    // Each blob orbits the middle: x = 0.5 + orbit * sin(freqX * phase + phaseX), y likewise.
    const paths = FREQ_X.map((freqX, i) => ({
      freqX,
      freqY: FREQ_Y[i] as number,
      phaseX: random() * Math.PI * 2,
      phaseY: random() * Math.PI * 2,
      orbit: 0.3 + random() * 0.12,
      pull: PULL[i] as number,
    }))
    const colors = [u.color1, u.color2, u.color3, u.color4]
    const tile = noise(ctx, { seed: params.seed, channels: 2 })
    const octaves = Math.min(3, Math.max(1, Math.round(params.octaves)))

    surface.color((_, { box, radius }) => {
      const size = u.size as unknown as Vec2
      // Box UV with the longer side 1, so blobs stay round on any aspect.
      const aspect = size.div(max(size.x, size.y))
      const point = warped(box.mul(aspect))
      let sigma = u.scale.mul(SIGMA)
      let distances: Node<'vec4'>
      if (params.style === 'aurora') {
        sigma = sigma.mul(0.25)
        distances = curtainDistances(point, aspect, sigma.mul(sigma))
      } else {
        const dx = centerX.mul(aspect.x).sub(point.x)
        const dy = centerY.mul(aspect.y).sub(point.y)
        distances = dx.mul(dx).add(dy.mul(dy))
      }
      // Gaussian weights relative to the nearest blob: far from all of them they never underflow
      // to zero.
      const nearest = min(min(distances.x, distances.y), min(distances.z, distances.w))
      const weights = exp(nearest.sub(distances).div(sigma.mul(sigma)))
      const lab = vec3(dot(weights, labL), dot(weights, labA), dot(weights, labB)).div(
        dot(weights, vec4(1)),
      )
      // A cell of 1 CSS px of the box: grain sticks to the element and does not swim on scroll.
      const cell = floor(box.mul(size))
      const grain = hash(
        uint(cell.x).add(uint(cell.y).mul(8192)).add(uint(grainFrame).mul(2654435769)),
      )
      const lightness = lab.x.add(grain.sub(0.5).mul(u.grain.mul(2)))
      const rgb = oklabToLinear(vec3(lightness, lab.y, lab.z))
      return vec4(rgb.add(dither(rgb)), radius)
    })

    /** The point bent by `octaves` layers of noise, each finer one half as strong. */
    function warped(point: Vec2): Vec2 {
      for (let octave = 0, frequency = 1; octave < octaves; octave++, frequency *= 2) {
        const offset = texture(tile, point.mul(0.6 * frequency).add(drift)).rg.sub(0.5)
        point = point.add(offset.mul(u.warp.mul(WARP / frequency)))
      }
      return point
    }

    /**
     * Aurora: squared distances to the sky and three curtains. The first colour is the sky, at a
     * fixed distance, so it shows wherever no curtain is near. Each other colour is a curtain along
     * a wavy line, sharp below and fading upwards in rays of uneven brightness.
     */
    function curtainDistances(point: Vec2, aspect: Vec2, sigma2: Float): Node<'vec4'> {
      const rays = texture(tile, vec2(point.x.mul(3), point.y.mul(0.2)).add(drift))
      const curtain = (x: Float, y: Float, i: number): Float => {
        const edge = y
          .sub(0.5)
          .mul(0.25)
          .add(0.35)
          .mul(aspect.y)
          .add(
            sin(point.x.mul((WAVES[i] as number) * Math.PI * 2).add(x.mul(Math.PI * 2))).mul(SWAY),
          )
        const above = point.y.sub(edge)
        const across = select(above.greaterThan(0), above.mul(FADE_UP), above.mul(FADE_DOWN))
        const ray = (i === 0 ? rays.r : i === 1 ? rays.g : rays.r.add(rays.g).mul(0.5)).sub(0.5)
        return across.mul(across).add(ray.mul(sigma2).mul(RAYS))
      }
      return vec4(
        sigma2.mul(1.21),
        curtain(centerX.y, centerY.y, 0),
        curtain(centerX.z, centerY.z, 1),
        curtain(centerX.w, centerY.w, 2),
      )
    }

    let phase = 0
    let clock = 0
    let scrollShift = 0
    const lab = new Vector3()
    /** Writes each blob's centre and colour, leaning `pull` of the way towards the pointer. */
    const place = (pointer: { readonly x: number; readonly y: number } | false, pull = 0): void => {
      const at = phase + scrollShift
      paths.forEach((path, i) => {
        let x = 0.5 + path.orbit * Math.sin(path.freqX * at + path.phaseX)
        let y = 0.5 + path.orbit * Math.sin(path.freqY * at + path.phaseY)
        if (pointer) {
          x += (pointer.x - x) * pull * path.pull
          y += (pointer.y - y) * pull * path.pull
        }
        ;(centerX.value as Vector4).setComponent(i, x)
        ;(centerY.value as Vector4).setComponent(i, y)
        lab.fromArray(toOklab(colors[i]?.value as Color))
        ;(labL.value as Vector4).setComponent(i, lab.x)
        ;(labA.value as Vector4).setComponent(i, lab.y)
        ;(labB.value as Vector4).setComponent(i, lab.z)
      })
      ;(drift.value as Vector2).set(phase * 0.2, phase * -0.15)
    }
    // The first frame draws before any update: start where the scroll already is.
    scrollShift = params.scroll * startProgress(ctx) * SCROLL
    place(false)

    return (input: EffectInput) => {
      const still = input.reducedMotion
      const fps = params.fps
      if (fps > 0 && !still) {
        clock += input.delta
        phase += input.delta * params.speed
        grainFrame.value = steps(clock, fps) % 65536
      }
      if (!still) scrollShift = params.scroll * input.progress * SCROLL
      // At attract 0 the pointer is never read: reading it makes every pointer move draw a frame.
      const pull = params.attract > 0 ? params.attract * input.hover : 0
      place(pull > 0 && input.pointer, pull)
    }
  },
})
export default gradient
