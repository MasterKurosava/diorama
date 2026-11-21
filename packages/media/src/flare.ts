import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { approach, chase, ease, follow } from '@dioramajs/effects/kit'
import {
  abs,
  atan,
  cos,
  dot,
  exp,
  length,
  max,
  min,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { type Node, Vector4 } from 'three/webgpu'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Params = {
  style: ChoiceParam<'lens' | 'sweep'>
  by: ChoiceParam<'pointer' | 'scroll' | 'fixed'>
  strength: number
  glow: number
  ghosts: number
  streak: number
  color: ColorParam
  position: readonly [number, number]
  travel: number
  angle: number
  width: number
  rest: number
  ease: number
  duration: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/**
 * Ghosts along the axis from the light through the centre of the box: where they sit on it (0 is
 * the light, 1 the centre, 2 the mirror point), their radius as a share of the glow, how bright
 * they are and their tint, like the coatings of a real lens.
 */
export const GHOSTS: readonly {
  readonly at: number
  readonly radius: number
  readonly power: number
  readonly tint: readonly [number, number, number]
}[] = [
  { at: 1.55, radius: 0.5, power: 0.11, tint: [1, 0.62, 0.3] },
  { at: 0.7, radius: 0.16, power: 0.16, tint: [0.45, 1, 0.75] },
  { at: 2.1, radius: 0.9, power: 0.05, tint: [0.62, 0.55, 1] },
  { at: 1.2, radius: 0.24, power: 0.13, tint: [1, 0.85, 0.55] },
  { at: 2.45, radius: 0.32, power: 0.1, tint: [0.4, 0.7, 1] },
  { at: 0.4, radius: 0.1, power: 0.2, tint: [1, 1, 1] },
  { at: 1.85, radius: 0.13, power: 0.14, tint: [1, 0.45, 0.8] },
  { at: 2.8, radius: 0.6, power: 0.04, tint: [0.5, 1, 0.9] },
]
/** The cool tint the anamorphic streak takes over the light's colour. */
const COOL = [0.45, 0.7, 1] as const
/** The light stops following once it is this close to its aim, px. */
const NEAR = 0.05

/** The light's x for a scroll `progress` 0..1: `travel` of the width across, centred on home. */
export const along = (home: number, progress: number, travel: number, width: number): number =>
  home + (Math.min(1, Math.max(0, progress)) - 0.5) * travel * width

/**
 * A light source over a photo: a glow with lens ghosts along the axis through the centre and an
 * optional anamorphic streak, or a glossy band that sweeps over the highlights. It follows the
 * pointer, travels with the scroll or stays put; the photo itself is untouched under it.
 */
const flare: Effect<Params> = defineEffect({
  name: 'flare',
  params: {
    style: oneOf('lens', 'sweep'),
    by: oneOf('pointer', 'scroll', 'fixed'),
    strength: 0.6,
    glow: 0.25,
    ghosts: 4,
    streak: 0,
    color: color('#ffe8c8'),
    position: [0.8, 0.2],
    travel: 0.6,
    angle: 115,
    width: 0.3,
    rest: 0,
    ease: 0.12,
    duration: 0.4,
  },
  media: true,
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { params, u } = ctx
    const sweep = params.style === 'sweep'
    const by = params.by
    // (light px with y up, how far it is on 0..1, unused).
    const look = uniform(new Vector4())
    const lookNode = look as unknown as V4
    const size = u.size as unknown as V2

    ctx.surface.color((color, { uv }) => {
      const point = uv.mul(size)
      const at = lookNode.xy
      const on = lookNode.z.mul(max(u.strength, 0)) as unknown as F
      // The halo's radius, px.
      const reach = max(min(size.x, size.y).mul(max(u.glow, 0)), 1) as unknown as F
      const distance = length(point.sub(at)) as unknown as F
      // A soft halo with a hot core.
      const halo = exp(distance.div(reach).pow(2).mul(-2))
        .mul(0.55)
        .add(exp(distance.div(reach.mul(0.12)).pow(2).negate()).mul(0.6))
        .mul(smoothstep(0, 0.02, u.glow)) as unknown as F
      let light = (u.color as unknown as V3).mul(halo) as unknown as V3
      if (sweep) {
        // A band through the light across `angle`, brighter on the picture's highlights.
        const radians = u.angle.mul(Math.PI / 180)
        const fromBand = abs(dot(point.sub(at), vec2(sin(radians), cos(radians)))) as unknown as F
        const half = max(u.width.mul(length(size)).mul(0.5), 1) as unknown as F
        const soft = smoothstep(half, 0, fromBand)
        const core = smoothstep(half.mul(0.25), 0, fromBand)
        const luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722))
        const gloss = smoothstep(0.05, 0.85, luma).mul(0.75).add(0.25)
        const band = soft.mul(soft).mul(0.45).add(core.mul(0.35)).mul(gloss)
        light = light.add((u.color as unknown as V3).mul(band)) as unknown as V3
      } else {
        // Thin rays around the core, the way an aperture spreads a bright point.
        const angle = atan(point.y.sub(at.y), point.x.sub(at.x))
        const rays = abs(cos(angle.mul(6)))
          .pow(48)
          .add(
            abs(cos(angle.mul(9).add(0.7)))
              .pow(64)
              .mul(0.6),
          )
        const burst = rays.mul(exp(distance.div(reach.mul(0.75)).negate())).mul(0.22)
        light = light.add((u.color as unknown as V3).mul(burst)) as unknown as V3
        // Ghosts along the line from the light through the centre, faded in by `ghosts`: mostly
        // clear glass with a faint fill and a rim split into colours, as lens coatings make them.
        const axis = size.mul(0.5).sub(at)
        for (const [i, ghost] of GHOSTS.entries()) {
          const centre = at.add(axis.mul(ghost.at))
          const radius = reach.mul(ghost.radius)
          const fromGhost = length(point.sub(centre))
          const fill = smoothstep(radius, radius.mul(0.6), fromGhost).mul(0.3)
          // A thin ring at `share` of the radius; red, green and blue a little apart.
          const ring = (share: number) =>
            smoothstep(radius.mul(0.1), 0, abs(fromGhost.sub(radius.mul(share))))
          const rim = vec3(ring(0.92), ring(0.87), ring(0.82)).mul(0.75)
          const shown = u.ghosts.sub(i).clamp(0, 1)
          light = light.add(
            vec3(...ghost.tint).mul(
              (u.color as unknown as V3).mul(rim.add(fill).mul(ghost.power * 1.6, shown)),
            ),
          ) as unknown as V3
        }
      }
      // An anamorphic streak: a thin line through the light across the whole frame.
      const dy = abs(point.y.sub(at.y))
      const dx = abs(point.x.sub(at.x))
      const thin = max(reach.mul(0.03), 1)
      const line = exp(dy.div(thin).negate())
        .mul(exp(dx.div(max(size.x.mul(0.45), 1)).negate()))
        .mul(u.streak.max(0))
      const cool = (u.color as unknown as V3).mul(vec3(...COOL))
      light = light.add(cool.mul(line)) as unknown as V3
      // Screen over the picture, so it brightens without clipping to white.
      const lit = light.mul(on).clamp(0, 1)
      const rgb = color.rgb.add(lit).sub(color.rgb.mul(lit))
      return vec4(rgb, color.a)
    })

    const aim = { x: 0, y: 0 }
    const at = { x: 0, y: 0 }
    let snap = true
    let active = by === 'pointer' ? 0 : 1
    // Touch: the light follows the finger while it is pressed.
    const pointer =
      by === 'pointer'
        ? follow(ctx, {
            enter() {
              if (active <= 0) snap = true
            },
          })
        : undefined

    return (input): boolean => {
      const dt = input.delta
      const still = input.reducedMotion
      const { width, height } = input
      const [homeX = 0.5, homeY = 0.5] = params.position as readonly number[]
      // A page transition takes the copy as it is, without a pointer's light.
      const goal = by !== 'pointer' || (pointer?.over && input.presence >= 1) ? 1 : 0
      aim.x = homeX * width
      aim.y = (1 - homeY) * height
      if (pointer?.over) Object.assign(aim, pointer.box(input))
      else if (by === 'scroll' && !still) aim.x = along(aim.x, input.progress, params.travel, width)
      // Only a pointer's light trails; it glides home when the pointer leaves.
      const jump = by !== 'pointer' || snap || still || dt <= 0
      snap = false
      const following = chase(at, aim, jump ? 0 : params.ease, dt, NEAR)
      const span = Math.max(params.duration, 1e-3)
      active = still || input.presence < 1 ? goal : approach(active, goal, dt / span)
      const eased = still ? active : ease('cubicInOut', active)
      const rest = Math.min(1, Math.max(0, params.rest))
      ;(look.value as Vector4).set(at.x, at.y, rest + (1 - rest) * eased, 0)
      return following || active !== goal
    }
  },
})
export default flare
