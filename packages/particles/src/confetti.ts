import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, palette, rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
} from 'three/webgpu'

type Float = Node<'float'>
type Vec3 = Node<'vec3'>
type Point = { x: number; y: number }
type Box = Readonly<Point> & { readonly width: number; readonly height: number }
type Params = {
  trigger: ChoiceParam<'click' | 'view' | 'event' | 'manual'>
  motion: ChoiceParam<'burst' | 'rain' | 'fireworks'>
  event: string
  fire: number
  once: boolean
  origin: ChoiceParam<'center' | 'edges' | 'pointer'>
  count: number
  angle: number
  spread: number
  speed: number
  gravity: number
  decay: number
  duration: number
  scale: number
  colors: string
  shapes: ChoiceParam<'mix' | 'rect' | 'circle' | 'ribbon'>
  seed: number
}

/** Pieces in the ring every burst writes into: one instanced draw. */
export const POOL = 1200
/** Drag never goes below this, so the closed form stays exact in float32. */
export const MIN_DRAG = 0.01
/** Pieces grow out of the element over this time, s. */
const GROW = 0.12
/** Spread of the launch over time, s: the burst pours out instead of appearing at once. */
const STAGGER = 0.03
/** Floats per piece in each of the five attributes. */
const ITEM = 4
/** A burst is born one 60 Hz frame back, so its first frame already shows it moving. */
const STEP = 1 / 60
/** Key light from the upper left, towards the viewer. */
const LIGHT = [-0.42, 0.72, 0.56] as const
const RAD = Math.PI / 180
/** Colours when `colors` holds none that resolve. */
const FALLBACK = '#ff5a36 #ffd23f #3ec1d3 #7b5cff #ffffff'
/** Rain: pieces start over this share of `duration`, s per s. */
const SHOWER = 0.4
/** Rain: a piece falls through the viewport in this share of `duration` once at full speed. */
const FALL = 0.65
/** Fireworks: shells a burst, and the time between two. */
const SHELLS = 5
const INTERVAL = 0.35
/** Fireworks: the speed of a shell's pieces as a share of `speed`, and their extra drag. */
const SHELL_SPEED = 0.35
const SHELL_AIR = 2.5

/** Elements that burst already, for `once`: it holds across rebuilds and park. */
const alreadyBurst = new WeakSet<Element>()
/** Phases with pieces in the air, so the frame policy keeps drawing. */
const flying = new WeakSet<AbortSignal>()

/** Where a piece is `t` s after launch, in world px (y up), without its sway. */
export interface Flight {
  x: number
  y: number
  z: number
  /** Vertical speed, px/s. */
  vy: number
}

/**
 * The closed form of a launch from `x0, y0, 0` at `vx, vy, vz` under gravity `g` (down) and
 * linear drag `k`: p(t) = p0 + v0·f + g·(t − f)/k with f = (1 − e^(−kt))/k. The vertex shader
 * draws the same path.
 */
export function flight(
  x0: number,
  y0: number,
  vx: number,
  vy: number,
  vz: number,
  k: number,
  g: number,
  t: number,
  out: Flight = { x: 0, y: 0, z: 0, vy: 0 },
): Flight {
  const drag = Math.max(k, MIN_DRAG)
  const e = Math.exp(-drag * t)
  const f = (1 - e) / drag
  out.x = x0 + vx * f
  out.y = y0 + vy * f - (g * (t - f)) / drag
  out.z = vz * f
  out.vy = vy * e - (g * (1 - e)) / drag
  return out
}

/** Shares of rect, circle and ribbon pieces for each `shapes` value. */

/** The pool's instance data: five vec4 a piece. */
interface Pool {
  /** x0, y0 in world px, birth time, drag factor. */
  readonly launch: Float32Array
  /** vx, vy, vz in px/s, life as a share of `duration`. */
  readonly motion: Float32Array
  /** Tumble axis (unit), spin in rad/s. */
  readonly turn: Float32Array
  /** Linear rgb, shape (0 rect, 1 circle, 2 ribbon) plus sheen / 2. */
  readonly look: Float32Array
  /** Width and height in px at scale 1, phase, curl. */
  readonly form: Float32Array
}

const SHAPES = { mix: [0.56, 0.24, 0.2], rect: [1, 0, 0], circle: [0, 1, 0], ribbon: [0, 0, 1] }

/** One piece of a burst: a shape, a size, a colour, a launch. Writes slot `i` of the pool. */
function piece(
  pool: Pool,
  i: number,
  random: () => number,
  shares: readonly number[],
  colors: readonly Color[],
  at: { readonly x: number; readonly y: number },
  aim: number,
  spread: number,
  speed: number,
  birth: number,
  air = 1,
): void {
  const offset = i * ITEM
  const roll = random()
  const shape =
    roll < (shares[0] as number) ? 0 : roll < (shares[0] as number) + (shares[1] as number) ? 1 : 2
  // Denser in the middle of the cone, like a real cannon.
  const angle = (aim + ((random() + random()) / 2 - 0.5) * spread) * RAD
  const velocity = speed * (0.45 + 0.75 * random() ** 0.8)
  const { launch, motion, turn, look, form } = pool
  launch[offset] = at.x
  launch[offset + 1] = at.y
  launch[offset + 2] = birth + random() * STAGGER
  // Streamers and big pieces catch more air, small dots less.
  launch[offset + 3] = (shape === 2 ? 1.35 : shape === 1 ? 0.85 : 1) * (0.75 + 0.5 * random()) * air
  motion[offset] = Math.cos(angle) * velocity
  motion[offset + 1] = Math.sin(angle) * velocity
  motion[offset + 2] = (random() - 0.5) * speed * 0.5
  motion[offset + 3] = 0.8 + 0.2 * random()
  // A random axis, uniform over the sphere: flips, spins on the spot and everything between.
  const axisZ = random() * 2 - 1
  const around = random() * Math.PI * 2
  const radius = Math.sqrt(1 - axisZ * axisZ)
  turn[offset] = radius * Math.cos(around)
  turn[offset + 1] = radius * Math.sin(around)
  turn[offset + 2] = axisZ
  turn[offset + 3] = (random() < 0.5 ? -1 : 1) * (3 + 7 * random())
  const color = colors[Math.floor(random() * colors.length)] as Color
  look[offset] = color.r
  look[offset + 1] = color.g
  look[offset + 2] = color.b
  // One piece in five is foil with a hard glint, the rest matte paper.
  const sheen = random() < 0.2 ? 0.75 + 0.24 * random() : 0.25 * random()
  look[offset + 3] = shape + sheen / 2
  const side = 7 + 4 * random()
  const [width, height] =
    shape === 1
      ? [side * 0.85, side * 0.85]
      : shape === 2
        ? [3.6 + random(), 22 + 14 * random()]
        : [side, side * (random() < 0.35 ? 1 : 1.4 + 0.6 * random())]
  form[offset] = width
  form[offset + 1] = height
  form[offset + 2] = random() * Math.PI * 2
  form[offset + 3] = (random() - 0.5) * (shape === 2 ? 0 : 0.5)
}

/** v rotated by `angle` around the unit `axis` (Rodrigues). */
function rotate(v: Vec3, axis: Vec3, angle: Float): Vec3 {
  const cosine = cos(angle)
  return v
    .mul(cosine)
    .add(cross(axis, v).mul(sin(angle)))
    .add(axis.mul(dot(axis, v).mul(cosine.oneMinus()))) as Vec3
}

/**
 * A burst of confetti from the element's box, a shower from the top of the viewport or fireworks
 * over it, over everything, to mark a sign-up, an order or a donation. The element is never
 * hidden, and under reduced motion nothing loads.
 */
const confetti: Effect<Params> = defineEffect({
  name: 'confetti',
  params: {
    trigger: oneOf('click', 'view', 'event', 'manual'),
    motion: oneOf('burst', 'rain', 'fireworks'),
    event: '',
    fire: 0,
    once: false,
    origin: oneOf('center', 'edges', 'pointer'),
    count: 200,
    angle: 90,
    spread: 70,
    speed: 1400,
    gravity: 1600,
    decay: 1.2,
    duration: 3,
    scale: 1,
    colors: '#ff5a36 #ffd23f #3ec1d3 #7b5cff #ffffff',
    shapes: oneOf('mix', 'rect', 'circle', 'ribbon'),
    seed: 1,
  },
  rebuild: ['seed'],
  reducedMotion: 'off',
  // The layer counts as visible while the element is anywhere near: a burst outlives a scroll.
  bleed: 100000,
  quality: { low: { count: 80 }, medium: { count: 140 } },
  animate: (ctx) => flying.has(ctx.signal),
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, render, u, app, element } = ctx
    const { trigger, origin, shapes, seed } = params
    const style = params.motion
    const random = rng(seed)
    const shares = SHAPES[shapes]

    const pool: Pool = {
      launch: new Float32Array(POOL * ITEM),
      motion: new Float32Array(POOL * ITEM),
      turn: new Float32Array(POOL * ITEM),
      look: new Float32Array(POOL * ITEM),
      form: new Float32Array(POOL * ITEM),
    }
    // Unborn slots: age far past any life, so they collapse to a point.
    for (let i = 0; i < POOL; i++) pool.launch[i * ITEM + 2] = -1e6
    // Streamers bend along their length; flat pieces need only their curl.
    const quad = new PlaneGeometry(1, 1, 1, shares[2] ? 10 : 3)
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))
    geometry.setAttribute('uv', quad.getAttribute('uv'))
    const buffers = Object.fromEntries(
      Object.entries(pool).map(([name, data]) => {
        const buffer = new InstancedBufferAttribute(data, ITEM).setUsage(DynamicDrawUsage)
        geometry.setAttribute(name, buffer)
        return [name, buffer]
      }),
    ) as Record<keyof Pool, InstancedBufferAttribute>
    geometry.instanceCount = 1
    quad.dispose()

    // The vertex: the closed-form path, a sideways sway as the piece slows, a tumble around its
    // axis that starts fast, and the paper's own curl or a streamer's wave.
    const time = uniform(0)
    const launch = attribute('launch', 'vec4')
    const motion = attribute('motion', 'vec4')
    const turn = attribute('turn', 'vec4')
    const look = attribute('look', 'vec4')
    const form = attribute('form', 'vec4')
    const age = time.sub(launch.z)
    const life = u.duration.mul(motion.w)
    // The same closed form as `flight`: decay is e^(-kt), travel is (1 - e^(-kt)) / k.
    const drag = max(u.decay.mul(launch.w), MIN_DRAG)
    const decay = exp(drag.mul(age).negate())
    const travel = decay.oneMinus().div(drag)
    const phase = form.z
    const spin = turn.w
    const sway = sin(age.mul(abs(spin).mul(0.35).add(1.2)).add(phase)).mul(
      fract(phase.mul(2.9)).mul(16).add(8),
      u.scale,
      decay.oneMinus(),
    )
    const center = vec3(
      launch.x.add(motion.x.mul(travel)).add(sway),
      launch.y.add(motion.y.mul(travel)).sub(u.gravity.mul(age.sub(travel)).div(drag)),
      motion.z.mul(travel),
    )
    const shape = floor(look.w)
    const ribbon = step(1.5, shape)
    const size = form.xy.mul(u.scale)
    const grow = smoothstep(0, GROW, age).mul(step(age, life))
    const along = positionGeometry.y.mul(size.y)
    const waves = age.mul(5).add(phase).add(positionGeometry.y.mul(5))
    const bend = ribbon.mul(size.x).mul(1.1)
    // Out of the piece's plane: a parabola for the curl plus the streamer's wave, and its slope.
    const lift = form.w
      .mul(along)
      .mul(along)
      .div(max(size.y, 1e-3))
      .add(bend.mul(sin(waves)))
    const slope = form.w
      .mul(along)
      .mul(2)
      .div(max(size.y, 1e-3))
      .add(bend.mul(cos(waves)).mul(5).div(max(size.y, 1e-3)))
    const axis = turn.xyz as unknown as Vec3
    // The tumble starts fast and settles to `spin` as the piece slows.
    const angle = phase.add(spin.mul(age)).add(spin.mul(2).mul(travel))
    const local = vec3(positionGeometry.x.mul(size.x), along, lift).mul(grow) as unknown as Vec3
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
    // One pass: a transparent double-sided material would otherwise draw back and front apart.
    material.forceSinglePass = true
    material.positionNode = center.add(rotate(local, axis, angle))
    const normal = varying(rotate(vec3(0, slope.negate(), 1) as unknown as Vec3, axis, angle))
    // Gone over the last fifth of its life, never popping; a page leaving takes it along.
    const fade = varying(smoothstep(life.mul(0.8), life, age).oneMinus().mul(u.presence))

    // The fragment: lit paper, two-sided, with a glint on foil pieces and edges smoothed by
    // their screen-space distance, so a piece turning edge-on thins out instead of shimmering.
    const view = normalize(cameraPosition.sub(positionWorld))
    const surfaceNormal = normalize(normal)
    const facing = dot(surfaceNormal, view)
    // Lit from whichever side faces the viewer.
    const towardViewer = surfaceNormal.mul(select(facing.greaterThanEqual(0), 1, -1))
    const front = step(0, facing)
    const light = vec3(...LIGHT).normalize()
    const sheen = fract(look.w).mul(2)
    const tint = look.xyz
    const backTint = mix(tint.mul(0.78), vec3(1), 0.06)
    const diffuse = max(dot(towardViewer, light), 0)
    const glint = pow(
      max(dot(towardViewer, normalize(light.add(view))), 0),
      mix(18, 90, sheen),
    ).mul(mix(0.18, 1.1, sheen))
    const rgb = mix(backTint, tint, front).mul(diffuse.mul(0.55).add(0.62)).add(glint)
    const pieceUv = uv()
    const edge = min(pieceUv, pieceUv.oneMinus()).div(max(fwidth(pieceUv), 1e-5))
    const square = clamp(edge.x.add(0.25), 0, 1).mul(clamp(edge.y.add(0.25), 0, 1))
    const insideCircle = length(pieceUv.sub(0.5)).negate().add(0.5)
    const round = clamp(insideCircle.div(max(fwidth(insideCircle), 1e-5)).add(0.5), 0, 1)
    material.colorNode = vec4(rgb, select(shape.equal(1), round, square).mul(fade))

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    ctx.overlay.add(mesh)
    // Compiled now, so the first burst does not wait for its pipeline.
    await ctx.compile(mesh)
    mesh.visible = false
    if (signal.aborted) return

    let now = 0
    let cursor = 0
    let used = 0
    /** Latest birth of a burst: pieces fly until `duration` after it. */
    let last = Number.NEGATIVE_INFINITY
    let fired = params.fire
    /** Bursts asked for since the last frame: a viewport point, or x NaN for the box. */
    const pending: Point[] = []
    /** Pieces were in the air last frame, so the clock runs. */
    let airborne = false
    const worldPoint = { x: 0, y: 0 }
    const probe: Flight = { x: 0, y: 0, z: 0, vy: 0 }
    const cameraDistance = render.camera.position.z || 1000

    /** Asks for a burst from a viewport point, or from the box when undefined. */
    const fire = (at?: Point): void => {
      if (params.once && alreadyBurst.has(element)) return
      alreadyBurst.add(element)
      pending.push(at ?? { x: Number.NaN, y: 0 })
      // Asks for frames from the click on: a button the site swaps or hides in the same click
      // keeps its burst as an orphan instead of closing before the first frame.
      flying.add(signal)
      ctx.invalidate()
    }
    /** Where the pointer is, when it is on the page. */
    const pointer = (): Point | undefined => {
      const state = app.pointer.state
      return origin === 'pointer' && state.inside ? { x: state.x, y: state.y } : undefined
    }
    const on = (type: string, fn: (e: Event) => void): void =>
      element.addEventListener(type, fn, { signal })
    if (trigger === 'click') {
      // Never cancelled: the form still submits and the link still opens.
      on('click', (e) => {
        const click = e as MouseEvent
        // A keyboard click has no position.
        const pointed = click.detail > 0 || click.clientX !== 0 || click.clientY !== 0
        fire(origin === 'pointer' && pointed ? { x: click.clientX, y: click.clientY } : undefined)
      })
    } else if (trigger === 'event') {
      const name = params.event.trim()
      if (name) on(name, () => fire(pointer()))
      else if (DEV)
        app.log.warn('EFFECT_PARAM: confetti with data-dio-trigger="event" needs data-dio-event')
    } else if (trigger === 'view') {
      // The first time half the box is in view, or it fills half the viewport's height: a box
      // over twice the viewport tall never shows half of itself.
      const seen = (entry: IntersectionObserverEntry): boolean => {
        const root = entry.rootBounds
        return (
          entry.isIntersecting &&
          (entry.intersectionRatio >= 0.5 ||
            (!!root && entry.intersectionRect.height >= 0.5 * root.height))
        )
      }
      if (typeof IntersectionObserver === 'function') {
        const observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some(seen)) return
            observer.disconnect()
            fire()
          },
          { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5] },
        )
        observer.observe(element)
        ctx.onDispose(() => observer.disconnect())
      } else fire()
    }

    /** Writes a burst into the ring, from `at` or from the box. */
    const launchBurst = (at: Point, box: Box, vw: number, vh: number): void => {
      const count = Math.min(POOL, Math.max(0, Math.round(params.count)))
      if (!count) return
      const listed = palette(params.colors, element)
      const colors = (listed.length ? listed : palette(FALLBACK, element)).map(
        (hex) => new Color(hex),
      )
      const spread = Math.min(360, Math.max(0, params.spread))
      const birth = now - STEP
      if (style !== 'burst') {
        launchSky(count, colors, birth, vw, vh)
        return
      }
      const edges = origin === 'edges' && Number.isNaN(at.x)
      // Two cannons at the lower corners of the box (within the viewport), aimed inwards.
      const left = Math.min(vw, Math.max(0, box.x))
      const right = Math.min(vw, Math.max(0, box.x + box.width))
      const low = Math.min(vh, Math.max(0, box.y + box.height))
      for (let n = 0; n < count; n++) {
        const i = (cursor + n) % POOL
        let x: number
        let y: number
        let aim = params.angle
        if (edges) {
          const side = n % 2 ? 1 : -1
          x = (side < 0 ? left : right) - side * random() * 8
          y = low - random() * Math.min(box.height, 40)
          aim += side * 30
        } else if (Number.isNaN(at.x)) {
          // Out of the box: a spot around its centre, a third of its size.
          x = box.x + box.width * (0.5 + (random() - 0.5) / 3)
          y = box.y + box.height * (0.5 + (random() - 0.5) / 3)
        } else {
          x = at.x + (random() - 0.5) * 6
          y = at.y + (random() - 0.5) * 6
        }
        piece(
          pool,
          i,
          random,
          shares,
          colors,
          render.toWorld(x, y, worldPoint),
          aim,
          spread,
          params.speed * (edges ? 1.1 : 1),
          birth,
        )
      }
      commit(count, birth + STAGGER)
    }

    /** Marks `count` new pieces in the ring, the latest born at `latest`. */
    const commit = (count: number, latest: number): void => {
      cursor = (cursor + count) % POOL
      used = Math.min(POOL, Math.max(used, cursor === 0 ? POOL : cursor, count))
      last = latest
      for (const buffer of Object.values(buffers)) buffer.needsUpdate = true
      geometry.instanceCount = used
    }

    /**
     * Rain: pieces start above the viewport over its width through a short while and fall at a
     * speed that crosses it within their life. Fireworks: shells burst at random points of the
     * upper viewport one after another, each piece in any direction.
     */
    const launchSky = (
      count: number,
      colors: Color[],
      birth: number,
      vw: number,
      vh: number,
    ): void => {
      const rain = style === 'rain'
      // Drag that makes gravity's end speed cross the viewport in FALL of the life.
      const endSpeed = (vh + 80) / Math.max(FALL * params.duration, 0.1)
      const air = rain ? params.gravity / (endSpeed * Math.max(params.decay, 1e-3)) : SHELL_AIR
      // A shell throws evenly all round: a random aim each, not a cone dense in its middle.
      const spread = rain ? 40 : 20
      const speed = rain ? 120 : params.speed * SHELL_SPEED
      const shells = Math.min(SHELLS, count)
      const shellPoints = Array.from({ length: shells }, () => ({
        x: vw * (0.15 + 0.7 * random()),
        y: vh * (0.15 + 0.4 * random()),
      }))
      let latest = birth
      for (let n = 0; n < count; n++) {
        const i = (cursor + n) % POOL
        const shell = shellPoints[n % shells] as Point
        const start = rain
          ? birth + random() * SHOWER * params.duration
          : birth + (n % shells) * INTERVAL
        latest = Math.max(latest, start)
        const x = rain ? random() * vw : shell.x + (random() - 0.5) * 6
        const y = rain ? -20 - random() * 60 : shell.y + (random() - 0.5) * 6
        const from = render.toWorld(x, y, worldPoint)
        const aim = rain ? 270 : random() * 360
        piece(pool, i, random, shares, colors, from, aim, spread, speed, start, air)
      }
      commit(count, latest + STAGGER)
    }

    /** A piece of a live burst is still on screen or will come back to it. */
    const inView = (vh: number): boolean => {
      const bottom = -vh / 2 - 60 * params.scale
      for (let i = 0; i < used; i++) {
        const offset = i * ITEM
        const { motion, launch } = pool
        const age = now - (launch[offset + 2] as number)
        // Not out yet: it will be.
        if (age < 0 && age > -1) return true
        if (age < 0 || age >= params.duration * (motion[offset + 3] as number)) continue
        flight(
          launch[offset] as number,
          launch[offset + 1] as number,
          motion[offset] as number,
          motion[offset + 1] as number,
          motion[offset + 2] as number,
          params.decay * (launch[offset + 3] as number),
          params.gravity,
          age,
          probe,
        )
        // Past its apex a piece only falls: once below the viewport it is gone for good.
        const screenY = (probe.y * cameraDistance) / Math.max(cameraDistance - probe.z, 1)
        if (probe.vy > 0 || screenY > bottom) return true
      }
      return false
    }

    return (input) => {
      // `fire`: every increase is a burst; a decrease only moves the mark.
      if (trigger === 'manual' && params.fire !== fired) {
        if (params.fire > fired) fire(pointer())
        fired = params.fire
      }
      if (airborne) now += input.delta
      if (pending.length) {
        const vw = app.stage.width.peek()
        const vh = app.stage.height.peek()
        for (const at of pending.splice(0)) launchBurst(at, input, vw, vh)
      }
      time.value = now
      const showing = now - last < params.duration && inView(app.stage.height.peek())
      mesh.visible = showing
      airborne = showing
      if (showing) flying.add(signal)
      else {
        flying.delete(signal)
        last = Number.NEGATIVE_INFINITY
      }
    }
  },
})
export default confetti
