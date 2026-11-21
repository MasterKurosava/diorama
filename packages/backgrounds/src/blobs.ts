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
  clamp,
  dFdx,
  dFdy,
  dot,
  exp2,
  float,
  floor,
  hash,
  length,
  log2,
  max,
  mix,
  normalize,
  pow,
  smoothstep,
  sqrt,
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
type Vec3 = Node<'vec3'>
type Params = {
  style: ChoiceParam<'lava' | 'orbs' | 'glass'>
  count: number
  color1: ColorParam
  color2: ColorParam
  color3: ColorParam
  color4: ColorParam
  background: ColorParam
  scale: number
  softness: number
  warp: number
  speed: number
  attract: number
  scroll: number
  grain: number
  fps: number
  seed: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Blobs the shader holds: `count` shows the first of them. */
export const MAX = 8
/** Largest noise offset of the edges at warp 1, as a share of the longer side. */
const WARP = 0.06
/** Phase shift in radians over the whole scroll progress at scroll 1. */
const SCROLL = 4
/** Glass: light from the upper left, towards the viewer. */
const LIGHT = new Vector3(-0.45, 0.55, 0.7).normalize()
/** Glass: halfway between the light and the viewer, for the highlight. */
const HALFWAY = LIGHT.clone()
  .add(new Vector3(0, 0, 1))
  .normalize()

/**
 * Soft blobs of brand colour drift over a flat background on slow looping paths: lava merges them
 * like a lava lamp, orbs draws them as separate blurred discs, glass shades the merged shapes as
 * glossy drops. They lean towards the pointer and shift with scroll; colours mix in OKLab.
 */
const blobs: Effect<Params> = defineEffect({
  name: 'blobs',
  params: {
    style: oneOf('lava', 'orbs', 'glass'),
    count: 6,
    color1: color('#6d5dfc'),
    color2: color('#22d3ee'),
    color3: color('#f472b6'),
    color4: color('#fbbf24'),
    background: color('#0b1026'),
    scale: 1,
    softness: 0.3,
    warp: 0.3,
    speed: 0.15,
    attract: 0.2,
    scroll: 0.25,
    grain: 0.03,
    fps: 30,
    seed: 1,
  },
  rebuild: ['seed'],
  animate: { fps: (ctx) => ctx.params.fps },
  quality: { low: { fps: 15, count: 4 }, medium: { fps: 24 } },
  setup(ctx: EffectContext<Params>) {
    const { params, surface, u } = ctx
    if (DEV) checkTarget(ctx, 'blobs')
    const style = params.style
    const random = rng(params.seed)
    // Each blob orbits the middle: x = 0.5 + orbitX * sin(freqX * phase + phaseX), y likewise.
    // `at` holds its centre in box UV (y up) and its radius as a share of the longer side.
    const slots = Array.from({ length: MAX }, (_, i) => ({
      at: uniform(new Vector4(0.5, 0.5, 0, 0)),
      freqX: 0.35 + random() * 0.6,
      freqY: 0.3 + random() * 0.6,
      phaseX: random() * Math.PI * 2,
      phaseY: random() * Math.PI * 2,
      orbitX: 0.22 + random() * 0.2,
      orbitY: 0.2 + random() * 0.2,
      // The first two blobs are larger.
      radius: (0.085 + random() * 0.05) * (i < 2 ? 1.3 : 1),
      pull: 1 - i / MAX,
    }))
    const labs = [0, 1, 2, 3].map(() => uniform(new Vector3()))
    const backgroundLab = uniform(new Vector3())
    const drift = uniform(new Vector2())
    const grainFrame = uniform(0)
    const tile = noise(ctx, { seed: params.seed, channels: 2 })
    const colors = [u.color1, u.color2, u.color3, u.color4]

    surface.color((_, { box, radius }) => {
      const size = u.size as unknown as Vec2
      // Box UV with the longer side 1, so blobs stay round on any aspect.
      const aspect = size.div(max(size.x, size.y))
      const square = box.mul(aspect)
      const point = square.add(
        texture(tile, square.mul(1.4).add(drift))
          .rg.sub(0.5)
          .mul(u.warp.mul(WARP * 2)),
      )
      const [lab, shine] = style === 'orbs' ? [orbs(point, aspect), vec3(0)] : merged(point, aspect)
      // A cell of 1 CSS px of the box: grain sticks to the element and does not swim on scroll.
      const cell = floor(box.mul(size))
      const grain = hash(
        uint(cell.x).add(uint(cell.y).mul(8192)).add(uint(grainFrame).mul(2654435769)),
      )
      const grained = vec3(lab.x.add(grain.sub(0.5).mul(u.grain.mul(2))), lab.y, lab.z)
      const rgb = oklabToLinear(grained).add(shine).clamp(0, 1)
      return vec4(rgb.add(dither(rgb)), radius)
    })

    /** Orbs: separate discs over the background, painted in order, each with a blurred rim. */
    function orbs(point: Vec2, aspect: Vec2): Vec3 {
      let lab = backgroundLab as unknown as Vec3
      slots.forEach((slot, i) => {
        const shown = clamp(u.count.sub(i), 0, 1)
        // Blurred discs read smaller than merged shapes of the same radius.
        const discRadius = slot.at.z.mul(u.scale).mul(1.3)
        const distance = length(point.sub(slot.at.xy.mul(aspect)))
        const blur = discRadius.mul(u.softness.mul(1.4).add(0.08)).add(1e-3)
        const cover = float(1).sub(smoothstep(discRadius.sub(blur), discRadius.add(blur), distance))
        lab = mix(lab, labs[i % 4] as unknown as Vec3, cover.mul(shown).mul(0.9))
      })
      return lab
    }

    /**
     * Lava and glass: metaballs. The field sums a Gaussian per blob, 1/2 on its rim, and the shape
     * is where it passes 1/2. Gaussians fall off fast, so far blobs do not swell each other.
     */
    function merged(point: Vec2, aspect: Vec2): [lab: Vec3, shine: Vec3] {
      const background = backgroundLab as unknown as Vec3
      let field: Float = float(0)
      let gradient: Vec2 = vec2(0)
      let mixed: Vec3 = vec3(0)
      let weight: Float = float(0)
      let reach: Float = float(0)
      slots.forEach((slot, i) => {
        const blobRadius = slot.at.z.mul(u.scale)
        const radius2 = max(blobRadius.mul(blobRadius), 1e-6)
        const offset = point.sub(slot.at.xy.mul(aspect))
        const gaussian = exp2(dot(offset, offset).div(radius2).negate()).mul(
          clamp(u.count.sub(i), 0, 1),
        )
        field = field.add(gaussian)
        gradient = gradient.add(offset.mul(gaussian.div(radius2)).mul(-2))
        // Squared, so each blob keeps its own colour and merges blend over a short span.
        const colorWeight = gaussian.mul(gaussian)
        mixed = mixed.add((labs[i % 4] as unknown as Vec3).mul(colorWeight))
        weight = weight.add(colorWeight)
        reach = reach.add(blobRadius.mul(colorWeight))
      })
      // 0 on the edge, 1 at a lone blob's centre: 1 - d² / r², a paraboloid.
      const height = log2(max(field, 1e-6)).add(1)
      const pixel = length(vec2(dFdx(height), dFdy(height)))
      const edge = smoothstep(
        0,
        1,
        height.div(u.softness.mul(0.5).add(pixel.mul(1.5)).add(1e-3)).add(0.5),
      )
      const inner = mixed.div(max(weight, 1e-8))
      if (style !== 'glass') return [mix(background, inner, edge), vec3(0)]

      // A drop: the paraboloid read as a hemisphere, its normal from the field's gradient.
      const dropRadius = reach.div(max(weight, 1e-8))
      const slopeXY = gradient.div(max(field, 1e-6)).mul(dropRadius.mul(-0.5))
      const z = sqrt(clamp(height, 0, 1))
      const normal = normalize(vec3(slopeXY.div(max(length(slopeXY), 1)), z.add(0.05)))
      const light = dot(normal, vec3(LIGHT.x, LIGHT.y, LIGHT.z))
        .mul(0.5)
        .add(0.5)
      const highlight = pow(max(dot(normal, vec3(HALFWAY.x, HALFWAY.y, HALFWAY.z)), 0), 60).mul(0.9)
      const rim = pow(float(1).sub(normal.z).clamp(0, 1), 2.5)
      // The background shows through the middle of a drop, less towards its rim.
      const lab = mix(
        background,
        inner.mul(vec3(light.mul(0.35).add(0.75), 1, 1)),
        edge.mul(rim.mul(0.2).add(0.78)),
      )
      return [lab, vec3(highlight.add(rim.mul(0.35))).mul(edge)]
    }

    let phase = 0
    let clock = 0
    let scrollShift = 0
    /** Writes each blob's centre, radius and colour, leaning `pull` of the way to the pointer. */
    const place = (pointer: { readonly x: number; readonly y: number } | false, pull = 0): void => {
      const at = phase + scrollShift
      for (const slot of slots) {
        const x = 0.5 + slot.orbitX * Math.sin(slot.freqX * at + slot.phaseX)
        const y = 0.5 + slot.orbitY * Math.sin(slot.freqY * at + slot.phaseY)
        // Breathing: each blob swells and shrinks a little on its own rhythm.
        const radius = slot.radius * (1 + 0.1 * Math.sin(slot.freqX * 1.7 * at + slot.phaseY))
        const lean = pointer ? pull * slot.pull : 0
        ;(slot.at.value as Vector4).set(
          x + ((pointer ? pointer.x : x) - x) * lean,
          y + ((pointer ? pointer.y : y) - y) * lean,
          radius,
          0,
        )
      }
      labs.forEach((lab, i) => {
        ;(lab.value as Vector3).fromArray(toOklab(colors[i]?.value as Color))
      })
      ;(backgroundLab.value as Vector3).fromArray(toOklab(u.background.value as Color))
      ;(drift.value as Vector2).set(phase * 0.15, phase * -0.1)
    }
    // The first frame draws before any update: start where the scroll already is.
    scrollShift = params.scroll * startProgress(ctx) * SCROLL
    place(false)

    return (input: EffectInput) => {
      const still = input.reducedMotion
      if (params.fps > 0 && !still) {
        clock += input.delta
        phase += input.delta * params.speed
        grainFrame.value = steps(clock, params.fps) % 65536
      }
      if (!still) scrollShift = params.scroll * input.progress * SCROLL
      // At attract 0 the pointer is never read: reading it makes every pointer move draw a frame.
      const pull = !still && params.attract > 0 ? params.attract * input.hover : 0
      place(pull > 0 && input.pointer, pull)
    }
  },
})
export default blobs
