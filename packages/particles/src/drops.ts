import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { rng } from '@dioramajs/effects/kit'
import {
  atan,
  attribute,
  clamp,
  dot,
  float,
  fwidth,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  ClampToEdgeWrapping,
  DataTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  type Node,
  PlaneGeometry,
  RGBAFormat,
  UnsignedByteType,
  Vector4,
} from 'three/webgpu'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Vec3 = Node<'vec3'>
type Params = {
  motion: ChoiceParam<'rain' | 'thaw'>
  trigger: ChoiceParam<'view' | 'manual'>
  fire: number
  rate: number
  count: number
  scale: number
  speed: number
  trail: number
  dry: number
  merge: boolean
  x: number
  y: number
  duration: number
  color: ColorParam
  seed: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Drops the instance buffer holds. */
export const POOL = 480
/** Trail pieces kept; the oldest is overwritten. */
export const TRAILS = 1600
/** Radius in px (at scale 1) from which a drop is heavy enough to slide. */
export const SLIDE = 6
/** A sliding drop lays a piece of trail every this many px. */
const PIECE = 3
/** Width of the thaw front behind which drops appear, px; the same as frost's. */
const EDGE = 80
/** Resting drops evaporate after about this share of `dry`, fading over their last second. */
const REST = 0.5
/** A runner keeps running until it shrinks below this share of the slide radius. */
const KEEP = 0.62
/** Share of the meltwater drops that gather enough water to run. */
const RUNNERS = 0.55
/** Floats per trail piece in `Glass.trails`. */
const TRAIL_ITEM = 6

/** A drop on the glass, in px from the area's top left, y down. */
export interface Drop {
  x: number
  y: number
  r: number
  /** Slide speed now, px/s. */
  vy: number
  /** Sideways drift, px per px of slide. */
  lean: number
  /** Seconds it still holds on before it slides on. */
  hold: number
  /** Seconds left to dry, for drops at rest. */
  life: number
  /** Seconds it still gathers water, and how fast its radius grows meanwhile, px/s. */
  fed: number
  grow: number
  /** It has started to run, so it runs on until it is nearly used up. */
  running: boolean
  /** Where the last piece of trail ended. */
  mx: number
  my: number
  /** 0..1, its own randomness for the shader. */
  seed: number
}

/** What a step needs. */
export interface Weather {
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly speed: number
  readonly trail: number
  readonly dry: number
  readonly merge: boolean
}

/** A thaw spreading from a point: the drops appear just behind its front. */
interface Thaw {
  x: number
  y: number
  t: number
  duration: number
  count: number
  made: number
}

/**
 * Water on the glass: drops that rest and dry, heavy ones that slide down in fits and starts,
 * leave a wet trail and beads, and swallow what they meet. Deterministic for a seed; px, y down.
 */
export class Glass {
  readonly drops: Drop[] = []
  /** Trail pieces: x0, y0, x1, y1, width, birth time. */
  readonly trails: Float32Array = new Float32Array(TRAILS * TRAIL_ITEM)
  /** Next trail slot, and pieces written so far (capped at TRAILS). */
  head = 0
  laid = 0
  time = 0
  /** Last trail piece written, s. */
  wet: number = Number.NEGATIVE_INFINITY
  readonly #random: () => number
  readonly #thaws: Thaw[] = []
  #rain = 0

  constructor(
    seed: number,
    readonly pool: number = POOL,
  ) {
    this.#random = rng(seed)
  }

  /** A drop of radius `r` at `x`, `y`; merges with one it lands on. */
  add(x: number, y: number, r: number, weather: Weather): Drop | undefined {
    if (r <= 0) return undefined
    if (weather.merge) {
      for (const drop of this.drops) {
        if (Math.hypot(drop.x - x, drop.y - y) < (drop.r + r) * 0.8) {
          this.#absorb(drop, x, y, r)
          return drop
        }
      }
    }
    if (this.drops.length >= this.pool) {
      // The oldest resting drop dries at once to make room.
      const oldest = this.drops.findIndex((drop) => drop.vy === 0)
      if (oldest < 0) return undefined
      this.drops.splice(oldest, 1)
    }
    const random = this.#random
    const drop: Drop = {
      x,
      y,
      r,
      vy: 0,
      lean: (random() - 0.5) * 0.25,
      hold: random() * 0.6,
      life: weather.dry * REST * (0.6 + 0.8 * random()),
      fed: 0,
      grow: 0,
      running: false,
      mx: x,
      my: y,
      seed: random(),
    }
    this.drops.push(drop)
    return drop
  }

  /** A radius from the mix of a melt or a shower: mostly beads, some drops, a few heavy ones. */
  radius(scale: number, heavy = 0.1): number {
    const random = this.#random
    const kind = random()
    const r =
      kind < 0.62 - heavy / 2
        ? 1.2 + 1.8 * random() ** 1.5
        : kind < 1 - heavy
          ? 3 + 2.5 * random()
          : SLIDE + 0.3 + 4.3 * random()
    return r * scale
  }

  /** Starts a thaw from `x`, `y` that leaves `count` drops behind its front over `duration`. */
  thaw(x: number, y: number, count: number, duration: number): void {
    this.#thaws.push({ x, y, t: 0, duration: Math.max(duration, 1e-3), count, made: 0 })
  }

  /** A shower of `count` drops at once. */
  shower(count: number, weather: Weather): void {
    for (let i = 0; i < count; i++) this.#scatter(weather, 0.12)
  }

  /** True while a thaw spreads. */
  get thawing(): boolean {
    return this.#thaws.length > 0
  }

  /**
   * Advances by `seconds` with new rain at `rate` drops a second. Returns 'moving' while drops
   * slide or appear, 'drying' while only drops at rest and trails dry, 'still' when the glass is
   * bare.
   */
  step(seconds: number, weather: Weather, rate = 0): 'moving' | 'drying' | 'still' {
    const dt = Math.min(Math.max(seconds, 0), 0.1)
    this.time += dt
    let moving = this.#thaws.length > 0 || rate > 0
    this.#rain += rate * dt
    while (this.#rain >= 1) {
      this.#rain--
      this.#scatter(weather, 0.08)
    }
    this.#spreadThaws(dt, weather)
    const { drops } = this
    const random = this.#random
    const slide = SLIDE * weather.scale
    for (let i = 0; i < drops.length; i++) {
      const drop = drops[i] as Drop
      if (drop.fed > 0) {
        drop.fed -= dt
        drop.r += drop.grow * dt
        moving = true
      }
      if (drop.r >= slide && weather.speed > 0) drop.running = true
      if (!drop.running || drop.r < slide * KEEP || weather.speed <= 0) {
        if (drop.running) {
          // Used up: what is left stays as a bead and evaporates.
          drop.running = false
          drop.vy = 0
          drop.life = weather.dry * REST * (0.4 + 0.4 * random())
        }
        drop.life -= dt
        continue
      }
      moving = true
      if (drop.hold > 0) {
        drop.hold -= dt
        continue
      }
      // Heavier drops slide faster; glass holds them now and then.
      const goal = weather.speed * (120 + 380 * Math.min(1, (drop.r - slide) / (2 * slide)))
      drop.vy += (goal - drop.vy) * Math.min(1, dt * 8)
      const moved = drop.vy * dt
      drop.y += moved
      drop.x += drop.lean * moved
      if (random() < dt * 0.6) drop.hold = 0.03 + random() * 0.12
      if (random() < dt * 1.5) drop.lean = (random() - 0.5) * 0.3
      // The trail takes a little of the water, and now and then a tiny bead stays behind.
      drop.r = Math.max(0, drop.r - moved * 0.0018 * weather.scale)
      if (random() < moved * 0.012) {
        const bead = drop.r * (0.1 + 0.12 * random())
        drop.r = Math.sqrt(Math.max(0, drop.r * drop.r - bead * bead))
        this.#leaveBead(drop.x - drop.lean * drop.r, drop.y - drop.r * 1.3, bead, weather)
      }
      if (Math.hypot(drop.x - drop.mx, drop.y - drop.my) >= PIECE * weather.scale) {
        this.#layTrail(drop, weather)
      }
      if (weather.merge) this.#swallow(i)
    }
    // Gone: dried, slid off the area, or used up.
    for (let i = drops.length - 1; i >= 0; i--) {
      const drop = drops[i] as Drop
      if (drop.life <= 0 || drop.r < 0.5 || drop.y - drop.r > weather.height + 4) {
        drops.splice(i, 1)
      }
    }
    if (moving) return 'moving'
    if (drops.length || this.time - this.wet < weather.dry) return 'drying'
    return 'still'
  }

  /** Moves each thaw's front on and leaves the drops due behind it. */
  #spreadThaws(dt: number, weather: Weather): void {
    const { width, height } = weather
    for (let i = this.#thaws.length - 1; i >= 0; i--) {
      const thaw = this.#thaws[i] as Thaw
      thaw.t += dt
      const progress = Math.min(1, thaw.t / thaw.duration)
      const far = Math.hypot(Math.max(thaw.x, width - thaw.x), Math.max(thaw.y, height - thaw.y))
      // The same front as frost's thaw: it eases out from the start.
      const spread = 1 - (1 - progress) ** 2
      const front = spread * (far + 2 * EDGE) - EDGE * 0.5
      const due = Math.round(thaw.count * spread)
      for (; thaw.made < due; thaw.made++) {
        // A point just behind the front that lies on the area, or none after a few tries.
        for (let tries = 0; tries < 6; tries++) {
          const angle = this.#random() * Math.PI * 2
          const distance = front - this.#random() * EDGE
          if (distance <= 0) break
          const x = thaw.x + Math.cos(angle) * distance
          const y = thaw.y + Math.sin(angle) * distance
          if (x < 0 || y < 0 || x > width || y > height) continue
          const drop = this.add(x, y, this.radius(weather.scale, 0.12), weather)
          if (drop) this.#feed(drop, weather)
          break
        }
      }
      if (progress >= 1) this.#thaws.splice(i, 1)
    }
  }

  #scatter(weather: Weather, heavy: number): void {
    const random = this.#random
    this.add(
      random() * weather.width,
      random() * weather.height,
      this.radius(weather.scale, heavy),
      weather,
    )
  }

  /**
   * Meltwater keeps gathering: about half the drops grow until they run, the rest stay small
   * and evaporate soon.
   */
  #feed(drop: Drop, weather: Weather): void {
    const random = this.#random
    drop.fed = 0.4 + random() * 1.6
    const slide = SLIDE * weather.scale
    const goal =
      random() < RUNNERS ? slide * (1.05 + random() * 0.6) : drop.r * (1 + random() * 0.2)
    drop.grow = Math.max(0, goal - drop.r) / drop.fed
    drop.life = Math.max(drop.life, drop.fed + weather.dry * REST * random())
  }

  /** A small bead left behind by a running drop. */
  #leaveBead(x: number, y: number, r: number, weather: Weather): void {
    if (r < 0.6 || this.drops.length >= this.pool) return
    const drop = this.add(x, y, r, { ...weather, merge: false })
    if (drop) {
      drop.hold = 0
      // Beads in a trail are thin and go first.
      drop.life = weather.dry * REST * (0.3 + 0.4 * this.#random())
    }
  }

  /** A piece of wet trail from where the last one ended to where the drop is. */
  #layTrail(drop: Drop, weather: Weather): void {
    if (weather.trail > 0) {
      const offset = this.head * TRAIL_ITEM
      const trails = this.trails
      trails[offset] = drop.mx
      trails[offset + 1] = drop.my
      trails[offset + 2] = drop.x
      trails[offset + 3] = drop.y
      trails[offset + 4] = drop.r * 0.42
      trails[offset + 5] = this.time
      this.head = (this.head + 1) % TRAILS
      this.laid = Math.min(TRAILS, this.laid + 1)
      this.wet = this.time
    }
    drop.mx = drop.x
    drop.my = drop.y
  }

  /** The sliding drop `i` swallows every drop it touches. */
  #swallow(i: number): void {
    const { drops } = this
    const runner = drops[i] as Drop
    for (let j = drops.length - 1; j >= 0; j--) {
      if (j === i) continue
      const other = drops[j] as Drop
      const touch = runner.r + other.r
      if (
        Math.abs(other.y - runner.y) > touch ||
        Math.hypot(other.x - runner.x, other.y - runner.y) >= touch * 0.8
      )
        continue
      this.#absorb(runner, other.x, other.y, other.r)
      runner.vy = Math.max(runner.vy, other.vy)
      drops.splice(j, 1)
      if (j < i) i--
    }
  }

  #absorb(drop: Drop, x: number, y: number, r: number): void {
    const own = drop.r * drop.r
    const added = r * r
    // The bigger drop keeps its place more; the water adds up as area on the glass.
    drop.x = (drop.x * own + x * added) / (own + added)
    drop.y = Math.max(drop.y, (drop.y * own + y * added) / (own + added))
    drop.r = Math.sqrt(own + added)
    drop.life = Math.max(drop.life, 0)
  }
}

/**
 * Cross-section of a wet trail at `across`, from -1 (one edge) to 1 (the other): its opacity
 * and how light it is. Symmetric about the middle, where the drop ran: a thin glossy line along
 * the centre, a faint film, and darker edges where the water film ends.
 */
export function trailProfile(across: number): { alpha: number; light: number } {
  const fromMiddle = Math.min(1, Math.abs(across))
  const t = Math.min(1, Math.max(0, (fromMiddle - 0.5) / 0.5))
  const edge = t * t * (3 - 2 * t)
  const film = (0.05 + 0.16 * edge) * (1 - fromMiddle ** 6)
  const gloss = Math.max(0, 1 - (fromMiddle / 0.3) ** 2) * 0.16
  const alpha = film + gloss
  return { alpha, light: alpha > 0 ? gloss / alpha : 0 }
}

/** {@link trailProfile} across a 64 × 1 texture: opacity in red, lightness in green. */
function profileTexture(): DataTexture {
  const size = 64
  const data = new Uint8Array(size * 4)
  for (let i = 0; i < size; i++) {
    const { alpha, light } = trailProfile(((i + 0.5) / size) * 2 - 1)
    data[i * 4] = Math.round(alpha * 255)
    data[i * 4 + 1] = Math.round(light * 255)
    data[i * 4 + 3] = 255
  }
  const map = new DataTexture(data, size, 1, RGBAFormat, UnsignedByteType)
  map.magFilter = map.minFilter = LinearFilter
  map.wrapS = map.wrapT = ClampToEdgeWrapping
  map.colorSpace = NoColorSpace
  map.needsUpdate = true
  return map
}

/** Phases with drops to draw, and how often. */
const rates = new WeakMap<AbortSignal, number>()

/**
 * Water drops on glass over an element, or over the viewport on `<body>`: rain that beads,
 * runs and leaves wet trails, or a thaw that spreads from a point and leaves meltwater behind
 * its front. Drops catch the light and darken at their rims; nothing behind them is read, so
 * the page stays real DOM and clicks go through. Frames only while drops move or dry.
 */
const drops: Effect<Params> = defineEffect({
  name: 'drops',
  params: {
    motion: oneOf('rain', 'thaw'),
    trigger: oneOf('view', 'manual'),
    fire: 0,
    rate: 10,
    count: 140,
    scale: 1,
    speed: 1,
    trail: 0.6,
    dry: 8,
    merge: true,
    x: 0.5,
    y: 0.5,
    duration: 2.4,
    color: color('#ffffff'),
    seed: 1,
  },
  rebuild: ['seed'],
  reducedMotion: 'off',
  animate: { fps: (ctx) => rates.get(ctx.signal) ?? 0 },
  quality: { low: { count: 70, rate: 2 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, u, element, app, signal } = ctx
    const page = element === document.body || element === document.documentElement
    const low = ctx.quality === 'low'
    const glass = new Glass(params.seed, low ? POOL / 2 : POOL)
    const movingFps = low ? 30 : 60

    // Area: left and top in world px (y up), width and height.
    const area = uniform(new Vector4())
    /** 1 inside the area for a point in area px, y down. */
    const clip = (point: Vec2): Float =>
      step(0, point.x)
        .mul(step(point.x, area.z))
        .mul(step(0, point.y))
        .mul(step(point.y, area.w)) as unknown as Float
    const now = uniform(0)

    // Drops: centre (area px, y down), radius, opacity; stretch of the tail, own randomness.
    const dropData = new Float32Array(POOL * 4)
    const shapeData = new Float32Array(POOL * 2)
    const dropGeometry = instancedQuads([
      ['drop', dropData, 4],
      ['shape', shapeData, 2],
    ])
    const dropAttr = attribute('drop', 'vec4')
    const shapeAttr = attribute('shape', 'vec2')
    // The quad spans 1.25 radii around the head and the tail above it.
    const tail = shapeAttr.x.mul(2).add(1)
    const quadX = positionGeometry.x.mul(2.5)
    const quadY = positionGeometry.y.add(0.5).mul(tail.add(1.25)).sub(1.25)
    const radius = dropAttr.z
    const worldAt = vec2(
      area.x.add(dropAttr.x).add(quadX.mul(radius)),
      area.y.sub(dropAttr.y).add(quadY.mul(radius)),
    )
    const dropMaterial = overlayMaterial()
    dropMaterial.positionNode = vec3(worldAt, 0)
    const dropClip = clip(
      varying(vec2(dropAttr.x.add(quadX.mul(radius)), dropAttr.y.sub(quadY.mul(radius)))) as never,
    )
    // In drop radii from its centre, y up.
    const local = varying(vec2(quadX, quadY)) as unknown as Vec2
    const vTail = varying(tail) as unknown as Float
    const vAlpha = varying(dropAttr.w) as unknown as Float
    const vSeed = varying(shapeAttr.y) as unknown as Float
    // An egg, round below and drawn out above while it runs, its outline a little uneven.
    const egg = vec2(
      local.x,
      select(local.y.greaterThan(0), local.y.div(vTail), local.y),
    ) as unknown as Vec2
    const around = atan(egg.y, egg.x)
    const uneven = sin(around.mul(3).add(vSeed.mul(6.28)))
      .mul(0.05)
      .add(sin(around.mul(5).add(vSeed.mul(17))).mul(0.025))
    // 0 at the centre, 1 on the outline.
    const fromCenter = length(egg).mul(uneven.add(1))
    const inside = clamp(
      float(1)
        .sub(fromCenter)
        .div(max(fwidth(fromCenter), 1e-3)),
      0,
      1,
    )
    // A lens: the world through it is upside down, dark sky at its top and the lit ground at its
    // bottom; a crisp dark rim, heavier below; a thin bright caustic inside the lower edge; one
    // sharp highlight from a light up and to the left; a soft shadow just below on the glass.
    const height = sqrt(max(float(1).sub(fromCenter.mul(fromCenter)), 0))
    const normal = normalize(vec3(egg.x, egg.y, height.mul(1.1)))
    const highlight = max(dot(normal, normalize(vec3(-0.42, 0.62, 0.66))), 0)
      .pow(70)
      .mul(1.3)
    const below = smoothstep(0.1, -0.85, egg.y)
    const flip = egg.y.mul(-0.5).add(0.5).clamp(0, 1)
    const body = flip.pow(1.6).mul(0.32)
    const darkTop = flip.oneMinus().mul(0.2)
    const rim = smoothstep(0.74, 0.97, fromCenter).mul(below.mul(0.35).add(0.32))
    const caustic = smoothstep(0.58, 0.82, fromCenter)
      .mul(smoothstep(0.96, 0.84, fromCenter))
      .mul(below)
      .mul(0.55)
    const shadow = smoothstep(1.3, 0.95, length(egg.sub(vec2(0.1, -0.32)))).mul(0.16)
    const light = u.color as unknown as Vec3
    const lit = vec3(1)
      .mul(highlight)
      .add(light.mul(body.add(caustic)))
    const lens = highlight.add(body).add(darkTop).add(rim).add(caustic).clamp(0, 1)
    const alpha = mix(shadow, lens, inside)
    dropMaterial.colorNode = vec4(
      lit.mul(inside).div(max(alpha, 1e-3)),
      alpha.mul(vAlpha).mul(u.presence).mul(dropClip),
    )
    const dropMesh = new Mesh(dropGeometry, dropMaterial)
    dropMesh.frustumCulled = false
    dropMesh.renderOrder = 1

    const profile = profileTexture()
    // Trails: two ends (area px, y down), half width and birth time.
    const segData = new Float32Array(TRAILS * 4)
    const wetData = new Float32Array(TRAILS * 2)
    const trailGeometry = instancedQuads([
      ['seg', segData, 4],
      ['wet', wetData, 2],
    ])
    const segAttr = attribute('seg', 'vec4')
    const wetAttr = attribute('wet', 'vec2')
    const from = vec2(segAttr.x, segAttr.y)
    const along = vec2(segAttr.z, segAttr.w).sub(from)
    const span = max(length(along), 1e-3)
    const direction = along.div(span)
    const side = vec2(direction.y.negate(), direction.x)
    const middle = from.add(along.mul(0.5))
    const trailPoint = middle
      .add(direction.mul(positionGeometry.y.mul(span)))
      .add(side.mul(positionGeometry.x.mul(wetAttr.x).mul(2)))
    const trailMaterial = overlayMaterial()
    trailMaterial.positionNode = vec3(area.x.add(trailPoint.x), area.y.sub(trailPoint.y), 0)
    const across = varying(positionGeometry.x.mul(2)) as unknown as Float
    // Some pieces hold more water than others, so the streak reads broken.
    const patchy = varying(mix(0.3, 1, hash(instanceIndex))) as unknown as Float
    const age = varying(now.sub(wetAttr.y)) as unknown as Float
    const fade = float(1)
      .sub(age.div(max(u.dry, 0.05)))
      .clamp(0, 1)
      .pow(0.7)
    const film = texture(profile, vec2(across.mul(0.5).add(0.5), 0.5)) as unknown as Node<'vec4'>
    const trailAlpha = film.r
      .mul(fade)
      .mul(patchy)
      .mul(u.trail.clamp(0, 1))
      .mul(u.presence)
      .mul(clip(varying(trailPoint) as never))
    trailMaterial.colorNode = vec4(vec3(film.g), trailAlpha)
    const trailMesh = new Mesh(trailGeometry, trailMaterial)
    trailMesh.frustumCulled = false

    ctx.overlay.add(trailMesh, dropMesh)
    ctx.onDispose(() => {
      dropGeometry.dispose()
      trailGeometry.dispose()
      dropMaterial.dispose()
      trailMaterial.dispose()
      profile.dispose()
    })
    await ctx.compile(ctx.overlay)
    if (signal.aborted) return

    let fired = params.fire
    let started = false
    let state: ReturnType<Glass['step']> = 'still'
    // Drops on the viewport would ride a native scroll with the canvas until the frame lands:
    // while there is water on the glass, the canvas holds still instead.
    if (page || getComputedStyle(element).position === 'fixed') {
      ctx.onDispose(app.stage.hold(() => state !== 'still'))
    }
    const weatherOf = (width: number, height: number): Weather => ({
      width,
      height,
      scale: Math.max(params.scale, 0.1),
      speed: Math.max(params.speed, 0),
      trail: params.trail,
      dry: Math.max(params.dry, 0.1),
      merge: params.merge,
    })
    return (input: EffectInput) => {
      const viewWidth = app.stage.width.peek()
      const viewHeight = app.stage.height.peek()
      const [left, top, width, height] = page
        ? [0, 0, viewWidth, viewHeight]
        : [input.x, input.y, input.width, input.height]
      ;(area.value as Vector4).set(left - viewWidth / 2, viewHeight / 2 - top, width, height)
      const weather = weatherOf(width, height)
      const play = (): void => {
        if (params.motion === 'thaw') {
          glass.thaw(
            params.x * width,
            params.y * height,
            Math.max(0, Math.round(params.count)),
            params.duration,
          )
        } else glass.shower(Math.max(0, Math.round(params.count)), weather)
      }
      if (!started) {
        started = true
        if (params.trigger === 'view') play()
      }
      // `fire`: every increase plays once more; a decrease only moves the mark.
      if (params.trigger === 'manual' && params.fire !== fired) {
        if (params.fire > fired) play()
        fired = params.fire
      }
      const raining = params.motion === 'rain' && params.trigger === 'view'
      state = glass.step(input.delta, weather, raining ? Math.max(params.rate, 0) : 0)
      now.value = glass.time
      copyToBuffers(glass, dropData, shapeData, segData, wetData)
      dropGeometry.instanceCount = glass.drops.length
      trailGeometry.instanceCount = glass.laid
      for (const geometry of [dropGeometry, trailGeometry])
        for (const buffer of Object.values(geometry.attributes)) {
          if ((buffer as InstancedBufferAttribute).isInstancedBufferAttribute)
            (buffer as InstancedBufferAttribute).needsUpdate = true
        }
      rates.set(signal, state === 'moving' ? movingFps : state === 'drying' ? 15 : 0)
    }
  },
})
export default drops

/** A transparent overlay material that draws both faces in one pass. */
function overlayMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  material.forceSinglePass = true
  return material
}

/** A unit quad drawn once per instance, with the given per-instance attributes. */
function instancedQuads(
  attributes: readonly [name: string, data: Float32Array, size: number][],
): InstancedBufferGeometry {
  const quad = new PlaneGeometry(1, 1)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(quad.getIndex())
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))
  quad.dispose()
  for (const [name, data, size] of attributes) {
    const buffer = new InstancedBufferAttribute(data, size)
    buffer.setUsage(DynamicDrawUsage)
    geometry.setAttribute(name, buffer)
  }
  geometry.instanceCount = 0
  return geometry
}

/** Copies the glass into the instance buffers. */
function copyToBuffers(
  glass: Glass,
  drop: Float32Array,
  shape: Float32Array,
  seg: Float32Array,
  wet: Float32Array,
): void {
  glass.drops.forEach((d, i) => {
    drop[i * 4] = d.x
    drop[i * 4 + 1] = d.y
    drop[i * 4 + 2] = d.r
    // Drops at rest fade over their last second.
    drop[i * 4 + 3] = d.running || d.fed > 0 ? 1 : Math.min(1, d.life)
    // The tail stretches with the slide speed.
    shape[i * 2] = d.vy > 0 ? Math.min(1.4, d.vy / 260) : 0
    shape[i * 2 + 1] = d.seed
  })
  const trails = glass.trails
  for (let k = 0; k < glass.laid; k++) {
    const offset = k * TRAIL_ITEM
    seg[k * 4] = trails[offset] as number
    seg[k * 4 + 1] = trails[offset + 1] as number
    seg[k * 4 + 2] = trails[offset + 2] as number
    seg[k * 4 + 3] = trails[offset + 3] as number
    wet[k * 2] = trails[offset + 4] as number
    wet[k * 2 + 1] = trails[offset + 5] as number
  }
}
