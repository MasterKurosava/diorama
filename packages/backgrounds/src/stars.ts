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
  attribute,
  clamp,
  cos,
  exp,
  float,
  fract,
  instanceIndex,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  Vector2,
} from 'three/webgpu'
import { startProgress } from './progress'
import { checkTarget } from './target'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Params = {
  motion: ChoiceParam<'drift' | 'warp' | 'still'>
  count: number
  depth: number
  twinkle: number
  speed: number
  warp: number
  scale: number
  color: ColorParam
  background: ColorParam
  shooting: number
  fps: number
  seed: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Stars the instance buffer holds: `count` draws the first of them. */
export const POOL = 4000
/** Shooting star slots, before the stars in the buffer. */
export const SHOTS = 3
/** A star's quad is this many radii wide, room for its halo. */
const HALO = 7
/** Drift: box widths a second the nearest stars travel at speed 1. */
const DRIFT = 0.02
/** Pointer parallax: box share the nearest stars move at depth 1 with the pointer at an edge. */
const LEAN = 0.04
/** Scroll parallax: box share the farthest stars lag over the whole crossing at depth 1. */
const LAG = 0.35
/** Scroll streaks: px of streak per unit of scroll velocity at warp 1. */
const STREAK = 220
/** Warp: depth units a second at speed 1, and the depth range the stars fly through. */
const FLY = 0.12
const NEAR = 0.06
/** Warp: the far end of the flight fills the box at 1; nearer, the stars spread out of it. */
const FOCAL = 1
/** Scroll velocity's share in the warp's trail length. */
const WARP_TRAIL = 0.04

/**
 * A starfield on an empty element: stars in depth layers twinkle, drift slowly and lean with the
 * pointer and the scroll, nearer ones more; a fast scroll stretches them into streaks, and now
 * and then a shooting star crosses the sky. The warp motion flies through the field instead.
 * One instanced draw over a flat sky color.
 */
const stars: Effect<Params> = defineEffect({
  name: 'stars',
  params: {
    motion: oneOf('drift', 'warp', 'still'),
    count: 800,
    depth: 0.5,
    twinkle: 0.5,
    speed: 0.3,
    warp: 0.5,
    scale: 1,
    color: color('#ffffff'),
    background: color('#04060f'),
    shooting: 4,
    fps: 30,
    seed: 1,
  },
  rebuild: ['seed'],
  animate: { fps: (ctx) => (ctx.params.motion === 'still' ? 0 : ctx.params.fps) },
  quality: { low: { count: 300, fps: 24 }, medium: { count: 550 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, surface, u, signal } = ctx
    if (DEV) checkTarget(ctx, 'stars')
    const warpMode = params.motion === 'warp'
    const random = rng(params.seed)

    surface.color((_, { radius }) => vec4(u.background, radius))

    // Per instance, two vec4 attributes.
    // star: x, y in box UV (y up), depth 0 far .. 1 near, twinkle phase.
    // look: radius px, brightness, tint 0 warm .. 1 cool, twinkle rate.
    // Shooting slots: star is x0, y0, angle, birth; look is radius, brightness, life, travel.
    const total = SHOTS + POOL
    const star = new Float32Array(total * 4)
    const look = new Float32Array(total * 4)
    // Shooting slots start born long ago, so they stay dark until the first one is shot.
    for (let i = 0; i < SHOTS; i++) star[i * 4 + 3] = -1e6
    for (let i = SHOTS; i < total; i++) {
      const at = i * 4
      const depth = random() ** 2
      star[at] = random()
      star[at + 1] = random()
      star[at + 2] = depth
      star[at + 3] = random() * Math.PI * 2
      // Many faint stars and a few bright ones; nearer ones a little larger.
      look[at] = (0.45 + 0.95 * random() ** 4) * (0.75 + 0.5 * depth)
      look[at + 1] = (0.3 + 0.7 * random() ** 2.5) * (0.65 + 0.35 * depth)
      look[at + 2] = random()
      look[at + 3] = 0.6 + 2.4 * random()
    }
    const quad = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))
    geometry.setAttribute('uv', quad.getAttribute('uv'))
    const starAttr = new InstancedBufferAttribute(star, 4)
    const lookAttr = new InstancedBufferAttribute(look, 4)
    geometry.setAttribute('star', starAttr)
    geometry.setAttribute('look', lookAttr)
    quad.dispose()
    const instances = (): number => SHOTS + Math.min(POOL, Math.max(0, Math.round(params.count)))
    geometry.instanceCount = instances()

    const clock = uniform(0)
    const drift = uniform(0)
    const fly = uniform(0)
    const lean = uniform(new Vector2())
    const lag = uniform(0)
    const streak = uniform(0)
    const shotClock = uniform(0)

    const starData = attribute('star', 'vec4')
    const lookData = attribute('look', 'vec4')
    const size = u.size as unknown as Vec2
    const depth = starData.z
    // Warp: distance from far 1 to near, starting over.
    const distance = mix(float(NEAR), 1, fract(depth.sub(fly))) as unknown as Float
    const starRadius = (warpMode
      ? lookData.x.mul(u.scale).mul(mix(1.8, 0.5, distance))
      : lookData.x.mul(u.scale)) as unknown as Float

    // Stars: centre in box px from the box centre, a direction, a length and a brightness.
    let starCenter: Vec2
    let starDirection: Vec2
    let starLength: Float
    let glow: Float
    let tail: Float
    if (warpMode) {
      // Each star flies from far to near and starts over, projected from the box centre.
      const spread = starData.xy.mul(2).sub(1)
      const behind = distance.add(streak.add(0.004))
      const project = (at: Float): Vec2 =>
        spread
          .mul(size)
          .mul(0.5 * FOCAL)
          .div(at) as unknown as Vec2
      const head = project(distance).add(
        lean.mul(size).mul(float(1).sub(distance)),
      ) as unknown as Vec2
      const trailEnd = project(behind).add(
        lean.mul(size).mul(float(1).sub(behind)),
      ) as unknown as Vec2
      const span = head.sub(trailEnd)
      starDirection = normalize(span.add(vec2(0, 1e-4))) as unknown as Vec2
      starLength = length(span).add(starRadius.mul(HALO)) as unknown as Float
      starCenter = head.add(trailEnd).mul(0.5) as unknown as Vec2
      // Stars fade in from the far end.
      glow = smoothstep(1, 0.55, distance).mul(lookData.y.add(0.25)) as unknown as Float
      tail = float(1) as unknown as Float
    } else {
      // Nearer layers drift faster, lag less behind the scroll and lean more with the pointer.
      const position = fract(
        starData.xy
          .add(vec2(drift.mul(mix(0.2, 1, depth)).negate(), lag.mul(mix(1, 0.35, depth))))
          .add(lean.mul(mix(0.3, 1, depth))),
      )
      starCenter = position.sub(0.5).mul(size) as unknown as Vec2
      starDirection = vec2(0, 1) as unknown as Vec2
      starLength = starRadius.mul(HALO).add(abs(streak).mul(mix(0.4, 1, depth))) as unknown as Float
      glow = lookData.y as unknown as Float
      tail = float(0) as unknown as Float
    }
    // Twinkle: a few stars dip deeply now and then, most only breathe.
    const wave = sin(clock.mul(lookData.w).add(starData.w)).mul(0.5).add(0.5)
    const blink = float(1).sub(u.twinkle.mul(wave.mul(wave).mul(wave)).mul(0.85))

    // Shooting stars: a head along a straight path, its trail growing and fading over its life.
    const age = shotClock.sub(starData.w)
    const life = age.div(max(lookData.z, 0.01))
    const alive = select(life.greaterThan(0).and(life.lessThan(1)), 1, 0)
    const heading = vec2(cos(starData.z), sin(starData.z))
    const travel = lookData.w.mul(length(size))
    const shotHead = starData.xy
      .sub(0.5)
      .mul(size)
      .add(heading.mul(life.mul(travel)))
    const swell = sin(clamp(life, 0, 1).mul(Math.PI))
    const shotLength = travel.mul(0.35).mul(swell).add(lookData.x.mul(HALO))
    const isShot = instanceIndex.lessThan(uint(SHOTS))

    // The same quad serves both: pick the star's or the shooting star's values.
    const shotWeight = select(isShot, 1, 0)
    const center = mix(
      starCenter,
      shotHead.sub(heading.mul(shotLength.mul(0.5))),
      shotWeight,
    ) as unknown as Vec2
    const direction = mix(starDirection, heading, shotWeight) as unknown as Vec2
    const quadLength = select(isShot, shotLength, starLength) as unknown as Float
    const quadWidth = select(isShot, lookData.x.mul(HALO), starRadius.mul(HALO)) as unknown as Float
    const brightness = select(
      isShot,
      lookData.y.mul(alive).mul(swell.add(0.2)),
      glow.mul(blink),
    ) as unknown as Float
    const tailed = select(isShot, 1, tail) as unknown as Float
    const coreRadius = select(isShot, lookData.x, starRadius) as unknown as Float

    const corner = positionGeometry
    // Right of the direction, so the quad keeps its winding and is not culled.
    const across = vec2(direction.y, direction.x.negate())
    const position = center
      .add(direction.mul(corner.y.mul(quadLength)))
      .add(across.mul(corner.x.mul(quadWidth)))
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(position, 0)
    const vBox = varying(position.div(size).add(0.5))
    const vLength = varying(quadLength)
    const vWidth = varying(quadWidth)
    const vRadius = varying(coreRadius)
    const vBrightness = varying(brightness)
    const vTail = varying(tailed)
    const vTint = varying(select(isShot, 0.6, lookData.z))

    // A round core with a soft halo, stretched into a capsule along a streak.
    const quadUv = uv()
    const along = quadUv.y.sub(0.5).mul(vLength)
    const side = quadUv.x.sub(0.5).mul(vWidth)
    const capsuleHalf = max(vLength.sub(vWidth).mul(0.5), 0)
    const beyond = max(abs(along).sub(capsuleHalf), 0)
    const radii = length(vec2(side, beyond)).div(max(vRadius, 0.2))
    // The halo ends inside the quad: cut at its edge, it would show as a faint square.
    const haloEdge = smoothstep(HALO / 2, HALO / 2 - 1.5, radii)
    const radii2 = radii.mul(radii)
    const shape = exp(radii2.mul(-1.4)).add(exp(radii2.mul(-0.18)).mul(haloEdge).mul(0.12))
    // A streak brightest at its head; spread over its length it keeps the star's light.
    const headBoost = mix(1, smoothstep(-0.5, 0.5, quadUv.y.sub(0.5)).mul(1.2), vTail)
    const spreadLight = vRadius.mul(HALO).div(max(vLength, 1e-3)).add(0.15).min(1)
    const tone = mix(vec3(1, 0.9, 0.8), vec3(0.82, 0.9, 1), vTint)
    const alpha = shape.mul(headBoost).mul(spreadLight).mul(vBrightness).clamp(0, 1)
    material.colorNode = vec4(tone.mul(u.color), alpha.mul(ctx.mask(vBox)).mul(u.presence))

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    // Over the sky the surface draws, inside this layer.
    mesh.renderOrder = 1
    ctx.place(mesh, { fit: 'none' })
    // Compiled now, so the first frame does not wait for the pipeline.
    await ctx.compile(mesh)
    if (signal.aborted) return

    let elapsed = 0
    let shotTime = 0
    let nextShot = 0
    let leanX = 0
    let leanY = 0
    /** Picks the next shooting star's time: random gaps averaging 60 / shooting seconds. */
    const schedule = (): void => {
      const mean = 60 / Math.max(params.shooting, 0.01)
      nextShot = shotTime + Math.max(1.2, -Math.log(1 - random()) * mean)
    }
    schedule()
    // The first one comes a little sooner, so a visitor sees one.
    nextShot = Math.min(nextShot, 3 + random() * 4)
    let slot = 0
    /** Launches a shooting star from the upper part of the box, down to the left or right. */
    const shoot = (): void => {
      const at = slot * 4
      slot = (slot + 1) % SHOTS
      const right = random() < 0.5
      const angle = ((15 + 22 * random()) * Math.PI) / 180
      star[at] = right ? 0.1 + 0.45 * random() : 0.45 + 0.45 * random()
      star[at + 1] = 0.55 + 0.4 * random()
      star[at + 2] = right ? -angle : Math.PI + angle
      star[at + 3] = shotTime
      look[at] = (0.9 + 0.5 * random()) * params.scale
      look[at + 1] = 0.75 + 0.25 * random()
      look[at + 2] = 0.6 + 0.5 * random()
      look[at + 3] = 0.22 + 0.2 * random()
      starAttr.needsUpdate = true
      lookAttr.needsUpdate = true
    }

    // The first frame draws before any update: start where the scroll already is.
    lag.value = -(startProgress(ctx) - 0.5) * params.depth * LAG

    return (input: EffectInput) => {
      geometry.instanceCount = instances()
      if (input.reducedMotion) {
        streak.value = 0
        return
      }
      const timed = params.motion !== 'still' && params.fps > 0
      const dt = input.delta
      if (timed) {
        elapsed += dt
        clock.value = elapsed
        drift.value = (drift.value as number) + dt * params.speed * DRIFT
        const boost = Math.abs(input.velocity) * params.warp * 2
        if (warpMode) fly.value = ((fly.value as number) + dt * (params.speed + boost) * FLY) % 1
        if (params.shooting > 0) {
          shotTime += dt
          shotClock.value = shotTime
          if (shotTime >= nextShot) {
            shoot()
            schedule()
          }
        }
      }
      // Scroll streaks; in the warp the same velocity speeds the flight and lengthens the trails.
      streak.value = warpMode
        ? Math.abs(input.velocity) * params.warp * WARP_TRAIL
        : input.velocity * params.warp * STREAK
      lag.value = -(input.progress - 0.5) * params.depth * LAG
      // The pointer is read only when the stars lean with it: a read draws a frame per move.
      const hover = params.depth > 0 ? input.hover : 0
      if (hover > 0) {
        leanX = (input.pointer.x - 0.5) * hover
        leanY = (input.pointer.y - 0.5) * hover
      } else leanX = leanY = 0
      ;(lean.value as Vector2).set(
        -leanX * params.depth * LEAN * 2,
        -leanY * params.depth * LEAN * 2,
      )
    }
  },
})
export default stars
