import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, inView, rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  clamp,
  cos,
  cross,
  dot,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  DoubleSide,
  Group,
  type InstancedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  Vector4,
} from 'three/webgpu'
import {
  emOf,
  glyphs,
  type Ink,
  instanced,
  pixels,
  type Style,
  sample,
  TIER,
  valueNoise,
} from './points'
import { fonts, type Raster, raster, unsupported } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type From = 'scatter' | 'below' | 'center' | 'edges'
type Trigger = 'view' | 'scroll' | 'hover'
type Params = {
  style: ChoiceParam<Style>
  from: ChoiceParam<From>
  trigger: ChoiceParam<Trigger>
  density: number
  dot: number
  duration: number
  stagger: number
  spread: number
  delay: number
  threshold: number
  color: ColorParam
  accent: ColorParam
  seed: number
}

/** Share of `duration` a particle may start after the first of its letter. */
export const JITTER = 0.35
/** Seconds the crisp glyphs take to fade in over the landed particles of a letter. */
export const FADE = 0.5
/** Grid step of the points at density 1, px. */
const STEP = 3
/** Most particles at the high tier. */
export const MAX_POINTS = 14000
/** How far the pointer reaches with the hover trigger at spread 1, px. */
const PUSH = 80
/** Hover springs: stiffness and damping per second (a little bounce). */
const STIFF = 150
const DAMP = 2 * 0.5 * Math.sqrt(STIFF)
/** Scroll trigger: the share of the scroll around the middle where the text holds. */
const HOLD: readonly [number, number] = [0.42, 0.58]
/** Out-of-focus blur per px of depth past the sharp zone around the page. */
const FOCUS = 0.012
/** Depth around the page that stays in focus, px. */
const SHARP = 80
/** Key light, from the upper left and towards the viewer. */
const LIGHT = [-0.45, 0.65, 0.62] as const
/** Edge smoothing room around a particle, px. */
const MARGIN = 1.5
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before rastering again after a change, ms; while the DOM shows, up to this idle timeout. */
const REDO_DELAY = 150
const REDO_IDLE_TIMEOUT = 1000
/** Hover: time constant of the smoothed pointer speed, s. */
const POINTER_SMOOTHING = 0.06
/** Hover: spring substeps per second, so a long frame stays stable. */
const SPRING_RATE = 120
/** Hover: extra px around the reach where a pointer move wakes the frame loop. */
const WAKE_MARGIN = 8

const colorParam = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam
/** A colour param that is set: empty or currentColor leave the text's own colour. */
const own = (value: string): boolean => {
  const v = value.trim().toLowerCase()
  return v !== '' && v !== 'currentcolor'
}

/** Seconds from the trigger until the text has landed, and with `crisp` until the glyphs show. */
export const span = (
  p: { readonly duration: number; readonly stagger: number; readonly delay: number },
  units: number,
  crisp: boolean,
): number =>
  p.delay +
  Math.max(0, units - 1) * p.stagger +
  Math.max(p.duration, 1e-3) * (1 + JITTER) +
  (crisp ? FADE * 0.4 : 0)

const HOME = 'dotHome'
const INK = 'dotInk'
const FROM = 'dotFrom'
const SPIN = 'dotSpin'
const PUSHED = 'dotPush'

/** Where the particles start and how they turn on the way. */
export interface Starts {
  /** Per particle: offset of the start from its place, box px (y down, z towards the viewer), and the bend of its path. */
  readonly from: Float32Array
  /** Per particle: a unit axis it tumbles around, and a random 0..1. */
  readonly spin: Float32Array
}

/**
 * Where each particle starts in 3D, as an offset from its place: in a cloud around and behind the
 * text, rising from below, out of a point deep behind its middle, or from both sides. Paths bend
 * by a smooth field, so particles that land close stream alike. `depth` is the camera distance.
 */
export function starts(ink: Ink, from: From, em: number, depth: number, seed: number): Starts {
  const n = Math.max(1, ink.count)
  const offsets = new Float32Array(n * 4)
  const spin = new Float32Array(n * 4)
  const random = rng(seed + 101)
  const field = valueNoise(seed + 7)
  const [x0, y0, x1, y1] = ink.bounds
  const width = Math.max(1, x1 - x0)
  const height = Math.max(1, y1 - y0)
  const midX = (x0 + x1) / 2
  const midY = (y0 + y1) / 2
  const reach = Math.max(160, width * 0.45, height * 1.5)
  // Never past the camera: the nearest start stays at half its distance.
  const near = depth * 0.5
  const far = depth * 1.2
  const gauss = (): number => (random() + random() + random() - 1.5) / 1.5
  for (let i = 0; i < ink.count; i++) {
    const x = ink.at[i * 4] as number
    const y = ink.at[i * 4 + 1] as number
    let startX: number
    let startY: number
    let startZ: number
    let curve = 0.55
    if (from === 'below') {
      startX = x + gauss() * reach * 0.35
      startY = y1 + reach * (0.35 + 1.1 * random() ** 0.7)
      startZ = -far * 0.45 * random() + near * 0.25 * gauss()
      curve = 0.3
    } else if (from === 'center') {
      startX = midX + gauss() * width * 0.05
      startY = midY + gauss() * height * 0.15
      startZ = -far * (0.75 + 0.25 * random())
      curve = 0.7
    } else if (from === 'edges') {
      const side = x < midX ? -1 : 1
      startX = side < 0 ? x0 - reach * (0.25 + random()) : x1 + reach * (0.25 + random())
      startY = y + gauss() * height * 0.9
      startZ = gauss() * near * 0.6
      curve = 0.35
    } else {
      const angle = random() * Math.PI * 2
      const radius = Math.sqrt(random())
      startX = midX + Math.cos(angle) * (width / 2 + reach) * radius
      startY = midY + Math.sin(angle) * (height / 2 + reach * 0.7) * radius
      // Most come out of the depth behind the page, some from in front of it.
      startZ = random() < 0.7 ? -far * random() ** 0.8 : near * random() ** 0.7
    }
    const flow = field(x / (em * 1.6), y / (em * 1.6))
    const bend = ((flow - 0.5) * 2.4 + (random() - 0.5) * 0.5) * curve
    offsets.set([startX - x, startY - y, startZ, bend], i * 4)
    // A random axis on the sphere.
    const axisZ = random() * 2 - 1
    const azimuth = random() * Math.PI * 2
    const ring = Math.sqrt(1 - axisZ * axisZ)
    spin.set([ring * Math.cos(azimuth), ring * Math.sin(azimuth), axisZ, random()], i * 4)
  }
  return { from: offsets, spin }
}

/** v turned by `angle` around the unit `axis` (Rodrigues). */
function rotate(v: V3, axis: V3, angle: F): V3 {
  const c = cos(angle)
  return v
    .mul(c)
    .add(cross(axis, v).mul(sin(angle)))
    .add(axis.mul(dot(axis, v).mul(c.oneMinus()))) as V3
}

/**
 * Thousands of particles fly out of the depth around the page along curved paths, with real
 * perspective and focus, and settle into the shape of the text; the crisp text fades in over them
 * as each letter lands. Once on view, scrubbed by scroll, or as a heading of beads the pointer
 * lifts towards the viewer. At rest the element is plain DOM text, except with the hover trigger.
 */
const assemble: Effect<Params> = defineEffect({
  name: 'assemble',
  params: {
    style: oneOf('dots', 'squares', 'dashes'),
    from: oneOf('scatter', 'below', 'center', 'edges'),
    trigger: oneOf('view', 'scroll', 'hover'),
    density: 1,
    dot: 2.2,
    duration: 1.4,
    stagger: 0.03,
    spread: 1,
    delay: 0,
    threshold: 0.2,
    color: colorParam('currentColor'),
    accent: colorParam('currentColor'),
    seed: 1,
  },
  rebuild: ['density', 'seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  reducedMotion: 'off',
  // Particles fly in from well outside the box.
  bleed: 600,
  quality: { low: { density: 0.6 } },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const trigger = params.trigger
    const hover = trigger === 'hover'
    const onScreen = (): boolean => {
      const r = element.getBoundingClientRect()
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < stage.height.peek() &&
        r.left < stage.width.peek()
      )
    }
    // As in text-reveal: text the visitor has seen as DOM stays; veiled text has not been seen.
    const veiled = (): boolean =>
      trigger !== 'scroll' && element.getAttribute('data-dio-state') === 'entering'
    let seen = onScreen() && !veiled()
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const warn = (reason: string): void => {
      if (DEV) app.log.warn(`assemble: ${reason}, the text stays as it is`, element)
    }
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    const cap = Math.round(MAX_POINTS * TIER[ctx.quality])
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()
    const pick = (r: Raster): Ink =>
      sample(r, pixels(r), {
        step: STEP / Math.sqrt(Math.max(params.density, 0.05)),
        max: cap,
        seed: params.seed,
      })
    let ink = layout ? pick(layout) : undefined
    if (!layout || !ink?.count) {
      if (reason) warn(`${reason} cannot be drawn`)
      ctx.showDom(true)
      return
    }

    // Time since the trigger in seconds and when it ends; 0 on hover keeps the glyphs
    // away and the particles on; `solid` shows the glyphs over them, for a heading seen as DOM.
    const clock = uniform(-1)
    const end = uniform(1)
    const finale = uniform(hover ? 0 : 1)
    const solid = uniform(0)
    const tinted = uniform(0)
    const shimmer = uniform(0)
    const depth = ctx.render.camera.position.z || 1000
    const frame = uniform(new Vector4(...layout.frame))
    const half = u.size.mul(0.5) as unknown as V2
    const mask = (uv: V2): F => ctx.mask(uv)
    const now = min(clock, u.presence.mul(end))
    // When the glyphs of unit `order` fade in: as its last particles land.
    const crisp = (order: F): F => {
      const landed = u.delay.add(order.mul(u.stagger)).add(u.duration.mul(1 + JITTER))
      return smoothstep(landed.sub(FADE * 0.6), landed.add(FADE * 0.4), now).mul(finale) as F
    }

    // The path: box px with y down and z towards the viewer.
    const home = attribute(HOME, 'vec4') as unknown as Node<'vec4'>
    const inkOf = attribute(INK, 'vec4') as unknown as Node<'vec4'>
    const from = attribute(FROM, 'vec4') as unknown as Node<'vec4'>
    const spinOf = attribute(SPIN, 'vec4') as unknown as Node<'vec4'>
    // Two random 0..1 values per particle, stored in the spare lanes of its attributes.
    const random1 = inkOf.w
    const random2 = spinOf.w
    const begin = u.delay.add(home.z.mul(u.stagger)).add(random1.mul(JITTER).mul(u.duration))
    const flight = max(u.duration.mul(random2.mul(0.3).add(0.7)), 1e-3)
    const progress = now.sub(begin).div(flight).clamp(0, 1)
    // Fast early, then a long settle with no overshoot: 1 - (1 - k)^4 (1 + 4k), zero speed at
    // both ends.
    const ease = (x: F): F => {
      const remaining = x.oneMinus()
      return float(1).sub(
        remaining.mul(remaining).mul(remaining).mul(remaining).mul(x.mul(4).add(1)),
      ) as F
    }
    const eased = ease(progress)
    const travel = from.xyz.mul(u.spread) as V3
    // The bend: sideways in the page's plane by the field, and a little in or out of it.
    const arc = vec3(
      travel.y.negate(),
      travel.x,
      length(travel.xy).mul(random2.sub(0.5)).mul(0.5),
    ).mul(from.w) as V3
    const spot = vec3(home.x, home.y, 0)
    const path = (s: F): V3 =>
      spot.add(travel.mul(s.oneMinus())).add(arc.mul(s.mul(s.oneMinus()).mul(4))) as V3
    // A little drift that dies out as the particle lands.
    const loose = eased.oneMinus().mul(eased.oneMinus())
    const drift = vec3(
      sin(now.mul(1.7).add(random1.mul(43))),
      cos(now.mul(1.3).add(random2.mul(37))),
      sin(now.mul(1.1).add(random2.mul(29))).mul(3),
    ).mul(loose.mul(min(u.spread, 1)).mul(5)) as V3
    let position = path(eased).add(drift) as V3
    let push: V3 | undefined
    if (hover) {
      push = attribute(PUSHED, 'vec3') as unknown as V3
      position = position.add(push) as V3
    }
    const z = position.z
    // Speed along the path, px/s: 20k(1 - k)^3 is the derivative of the ease.
    const remaining = progress.oneMinus()
    const slope = travel.negate().add(arc.mul(eased.mul(2).oneMinus().mul(4)))
    const speed = length(slope)
      .mul(progress.mul(20).mul(remaining).mul(remaining).mul(remaining))
      .div(flight)

    const style = params.style
    const landing = smoothstep(0.6, 1, progress)
    // Sizes vary in flight, a few particles much larger, and all land at `dot`.
    const variety = mix(random2.mul(random2).mul(1.4).add(0.6), float(1), landing)
    // Out of focus away from the page, more so in front of it.
    const blur = max(abs(z).sub(SHARP), 0)
      .mul(FOCUS)
      .mul(select(z.greaterThan(0), 0.6, 1))
    const width = u.dot.mul(variety).mul(style === 'dashes' ? 0.7 : 1)
    // Along the motion on screen: dots and dashes stretch with their speed.
    const trail = path(eased).sub(path(eased.sub(0.15)))
    const along = normalize(vec2(trail.x, trail.y.negate()).add(vec2(1e-6, 0))) as V2
    const extent =
      style === 'dashes'
        ? min(max(u.dot.mul(2.4), width.add(speed.mul(0.03))), u.dot.mul(12))
        : style === 'dots'
          ? min(width.add(speed.mul(0.0035)), width.mul(2.5))
          : width
    const size = vec2(extent, width) as V2

    const corner = positionGeometry.xy as unknown as V2
    const local = corner.mul(size.add(blur.mul(2)).add(MARGIN * 2)) as V2
    let centre = vec3(position.x.sub(half.x), half.y.sub(position.y), z) as V3
    if (push) {
      // Lifted along the line to the camera, so a bead looms towards the viewer where it is
      // instead of sliding away from the middle of the screen.
      const world = modelWorldMatrix.mul(vec4(centre.xy, 0, 1)).xy
      centre = centre.sub(vec3(world.mul(push.z.div(depth)), 0)) as V3
    }
    const light = vec3(...LIGHT).normalize()
    let offset: V3
    let lightLocal: V3 = light as V3
    let facet: V3 | undefined
    if (style === 'squares') {
      // A tile tumbling around its axis, flat to the viewer once landed.
      const axis = spinOf.xyz as V3
      const turns = random2
        .sub(0.5)
        .mul(12)
        .add(select(random2.greaterThan(0.5), 3, -3))
      const angle = turns.mul(eased.oneMinus())
      offset = rotate(vec3(local.x, local.y, 0) as V3, axis, angle)
      facet = rotate(vec3(0, 0, 1) as V3, axis, angle)
    } else {
      offset = vec3(
        along.x.mul(local.x).sub(along.y.mul(local.y)),
        along.y.mul(local.x).add(along.x.mul(local.y)),
        0,
      ) as V3
      // The light in the particle's own frame, turned with it.
      lightLocal = vec3(
        light.x.mul(along.x).add(light.y.mul(along.y)),
        light.y.mul(along.x).sub(light.x.mul(along.y)),
        light.z,
      ) as V3
    }
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    material.forceSinglePass = true
    material.positionNode = centre.add(offset)

    // Colour: the text's own, or `color`, with `accent` shimmering through the cloud in flight.
    const base = mix(inkOf.xyz, u.color, tinted)
    const wave = sin(now.mul(2.4).sub(home.x.mul(0.015)).add(random1.mul(6.283)))
      .mul(0.5)
      .add(0.5)
    const flying = mix(base, u.accent, wave.mul(shimmer))
    let rgb = mix(flying, inkOf.xyz, landing) as V3
    if (push) {
      // Lifted particles take the flight colours while they are away.
      const away = length(push).div(PUSH).clamp(0, 1)
      rgb = mix(rgb, flying, away) as V3
    }
    // Far ones dimmer, near ones a touch brighter.
    const nearness = clamp(
      z
        .div(depth)
        .mul(select(z.greaterThan(0), 1.4, 0.6))
        .add(1),
      0.45,
      1.4,
    )
    // The cloud fades in, a particle brightens as it sets off; glyphs take over once solid.
    const appear = smoothstep(0, 0.35, now).mul(smoothstep(0, 0.12, progress).mul(0.4).add(0.6))
    const handoff = smoothstep(0.9, 1, max(crisp(home.z).mul(smoothstep(0.85, 1, progress)), solid))
    const r = width.mul(0.5)
    // A blurred particle spreads the same light over a larger disc.
    const focus = r.div(r.add(blur))
    const alpha = home.w
      .mul(appear)
      .mul(handoff.oneMinus())
      .mul(clamp(z.div(depth * 1.2).add(1), 0.3, 1))
      .mul(max(focus, 0.2))
      .mul(
        mask(
          vec2(position.x.div(half.x.mul(2)), position.y.div(half.y.mul(2)).oneMinus()).clamp(0, 1),
        ),
      )

    const vLocal = varying(local) as V2
    const vSize = varying(size) as V2
    const vBlur = varying(blur) as F
    const vFocus = varying(focus) as F
    const vLight = varying(lightLocal) as V3
    let dist: F
    let shade: F
    let gloss: F
    if (style === 'squares') {
      dist = max(abs(vLocal.x).sub(vSize.x.mul(0.5)), abs(vLocal.y).sub(vSize.y.mul(0.5))) as F
      // Two-sided: the face towards the viewer catches the light and a hard glint.
      const facing = normalize(varying(facet as V3))
      const n = facing.mul(select(facing.z.greaterThanEqual(0), 1, -1))
      const halfway = light.add(vec3(0, 0, 1)).normalize()
      shade = max(dot(n, light), 0).mul(0.75).add(0.4) as F
      gloss = pow(max(dot(n, halfway), 0), 70).mul(1.6) as F
    } else {
      // A bead: a sphere over the disc (a capsule while it streaks), lit from the upper left.
      const capRadius = vSize.y.mul(0.5)
      const core = max(vSize.x.mul(0.5).sub(capRadius), 0)
      const fromCore = vec2(vLocal.x.sub(clamp(vLocal.x, core.negate(), core)), vLocal.y)
      dist = length(fromCore).sub(capRadius) as F
      const p = fromCore.div(max(capRadius, 1e-3))
      const n = vec3(p, sqrt(max(float(1).sub(dot(p, p)), 0)))
      const halfway = vLight.add(vec3(0, 0, 1)).normalize()
      shade = mix(float(1), max(dot(n, vLight), 0).mul(0.8).add(0.5), vFocus) as F
      gloss = pow(max(dot(n, halfway), 0), 28)
        .mul(0.55)
        .mul(vFocus) as F
      if (style === 'dashes') {
        // A streak of light: bright at the head, fading along the tail.
        const head = smoothstep(vSize.x.mul(-0.5), vSize.x.mul(0.5), vLocal.x)
        shade = head.mul(0.75).add(0.5) as F
        gloss = float(0) as F
      }
    }
    const soft = max(fwidth(dist), vBlur)
    const shape = float(0.5)
      .sub(dist.div(max(soft, 1e-4)))
      .clamp(0, 1)
    const glint = mix(vec3(1), u.accent, shimmer.mul(0.5))
    material.colorNode = vec4(
      varying(rgb.mul(nearness)).mul(shade).add(glint.mul(gloss)),
      shape.mul(varying(alpha)),
    )

    const letters = glyphs(layout, half, frame, ({ order }) => max(crisp(order), solid) as F, mask)
    const total = (): number => span(ctx.params, layout?.units ?? 0, !hover)
    // The tumble axes double as the direction each bead scatters in when the pointer lifts it.
    let spins: Float32Array = new Float32Array(4)
    const build = (next: Ink): ReturnType<typeof instanced> => {
      const s = starts(next, params.from, emOf(layout as Raster), depth, params.seed)
      spins = s.spin
      const attributes: Record<string, readonly [Float32Array, number]> = {
        [HOME]: [next.at, 4],
        [INK]: [next.color, 4],
        [FROM]: [s.from, 4],
        [SPIN]: [s.spin, 4],
      }
      if (hover) attributes[PUSHED] = [new Float32Array(Math.max(1, next.count) * 3), 3]
      return instanced(next.count, attributes, [PUSHED])
    }
    const dots = new Mesh(build(ink), material)
    dots.frustumCulled = false
    dots.renderOrder = 1
    const group = new Group()
    group.add(letters.mesh, dots)
    ctx.onDispose(() => letters.dispose())
    // Placed before any showDom, which hides the replace object.
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()

    // Hover springs: offset and velocity of each particle, box px (y down, z to the viewer).
    let offsets = new Float32Array(ink.count * 3)
    let velocity = new Float32Array(ink.count * 3)
    const use = (next: Raster, points: Ink): void => {
      layout = next
      ink = points
      const old = dots.geometry
      dots.geometry = build(points)
      old.dispose()
      letters.use(next)
      frame.value.set(...next.frame)
      offsets = new Float32Array(points.count * 3)
      velocity = new Float32Array(points.count * 3)
    }

    let dom = false
    const show = (value: boolean): void => {
      dom = value
      ctx.showDom(value)
    }
    clock.value = seen ? total() : -1
    end.value = total()
    if (seen && !hover) show(true)

    // Raster again when the text, its fonts or its width change, like text-reveal.
    let cancel: (() => void) | undefined
    let stuck: string | undefined
    // Particles move, so the update asks for frames.
    let playing = false
    const redo = async (): Promise<void> => {
      cancel = undefined
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(`${why} cannot be drawn`)
      stuck = why
      if (why) {
        playing = false
        ctx.invalidate()
        return
      }
      const next = raster(element, 'letter', ratio)
      const points = next && pick(next)
      if (!next || !points?.count) return
      use(next, points)
      end.value = total()
      ctx.invalidate()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(() => void redo(), { timeout: REDO_IDLE_TIMEOUT })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(() => void redo(), REDO_DELAY)
        cancel = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => cancel?.())
    const text = new MutationObserver(schedule)
    text.observe(element, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => text.disconnect())
    const resize = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width
      if (Math.abs(width - (layout?.width ?? width)) > 0.5) schedule()
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // The pointer in viewport px for the hover trigger: a mouse anywhere on the page, a finger
    // while it presses on the text.
    const pointer = { x: 0, y: 0, on: false, touch: -1, vx: 0, vy: 0, lastX: Number.NaN, lastY: 0 }
    let near = { x: 0, y: 0, width: 0, height: 0 }
    if (hover) {
      const wake = (): void => {
        const reach = PUSH * Math.max(ctx.params.spread, 0) + WAKE_MARGIN
        const { x, y } = pointer
        if (
          x > near.x - reach &&
          x < near.x + near.width + reach &&
          y > near.y - reach &&
          y < near.y + near.height + reach
        ) {
          playing = true
          ctx.invalidate()
        }
      }
      const move = (e: PointerEvent): void => {
        if (e.pointerType === 'touch' && e.pointerId !== pointer.touch) return
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.on = true
        wake()
      }
      const lift = (e: PointerEvent): void => {
        if (e.pointerType === 'touch' && e.pointerId !== pointer.touch) return
        pointer.touch = -1
        pointer.on = false
        playing = true
        ctx.invalidate()
      }
      addEventListener('pointermove', move, { passive: true, signal })
      element.addEventListener(
        'pointerdown',
        (e) => {
          const p = e as PointerEvent
          if (p.pointerType !== 'touch') return
          pointer.touch = p.pointerId
          move(p)
        },
        { passive: true, signal },
      )
      addEventListener('pointerup', lift, { passive: true, signal })
      addEventListener('pointercancel', lift, { passive: true, signal })
      document.documentElement.addEventListener(
        'pointerleave',
        (e) => (e as PointerEvent).pointerType !== 'touch' && lift(e as PointerEvent),
        { signal },
      )
      addEventListener('blur', () => lift(new PointerEvent('pointerup')), { signal })
    }

    /**
     * Steps the hover springs: particles under the pointer rise towards the viewer and part a
     * little. True while any particle is away from its target or moving.
     */
    const spring = (input: { x: number; y: number }, delta: number): boolean => {
      const count = ink?.count ?? 0
      const at = ink?.at
      if (!count || !at) return false
      const reach = PUSH * Math.max(ctx.params.spread, 0)
      const boxX = pointer.x - input.x
      const boxY = pointer.y - input.y
      // The pointer's own speed carries the particles along a little.
      const dt = Math.min(Math.max(delta, 0), 1 / 20)
      if (pointer.on && !Number.isNaN(pointer.lastX) && dt > 0) {
        const smoothing = 1 - Math.exp(-dt / POINTER_SMOOTHING)
        pointer.vx += ((boxX - pointer.lastX) / dt - pointer.vx) * smoothing
        pointer.vy += ((boxY - pointer.lastY) / dt - pointer.vy) * smoothing
      } else {
        pointer.vx = 0
        pointer.vy = 0
      }
      pointer.lastX = pointer.on ? boxX : Number.NaN
      pointer.lastY = boxY
      const steps = Math.max(1, Math.ceil(dt * SPRING_RATE))
      const stepTime = dt / steps
      const reachSquared = reach * reach
      let moving = false
      let dirty = false
      const target = [0, 0, 0]
      for (let i = 0; i < count; i++) {
        target[0] = target[1] = target[2] = 0
        if (pointer.on && reach > 0) {
          const dx = (at[i * 4] as number) - boxX
          const dy = (at[i * 4 + 1] as number) - boxY
          const d2 = dx * dx + dy * dy
          if (d2 < reachSquared) {
            const dist = Math.sqrt(d2) + 1e-3
            const closeness = 1 - dist / reach
            const falloff = closeness * closeness * (3 - 2 * closeness)
            // Up towards the viewer, each a little apart in its own direction and height.
            const spinAt = i * 4
            const lift = 0.6 + 0.8 * (spins[spinAt + 3] as number)
            target[0] =
              ((dx / dist) * 0.1 + (spins[spinAt] as number) * 0.2) * falloff * reach +
              pointer.vx * 0.02 * falloff
            target[1] =
              ((dy / dist) * 0.1 + (spins[spinAt + 1] as number) * 0.2) * falloff * reach +
              pointer.vy * 0.02 * falloff
            target[2] = falloff * reach * 2 * lift
          }
        }
        const base = i * 3
        let still = true
        for (let axis = 0; axis < 3; axis++)
          still &&=
            Math.abs((target[axis] as number) - (offsets[base + axis] as number)) < 0.02 &&
            Math.abs(velocity[base + axis] as number) < 0.05
        // At its target and still: snapped there, and no frames for it.
        if (still) {
          for (let axis = 0; axis < 3; axis++) {
            if (offsets[base + axis] === target[axis] && velocity[base + axis] === 0) continue
            offsets[base + axis] = target[axis] as number
            velocity[base + axis] = 0
            dirty = true
          }
          continue
        }
        for (let axis = 0; axis < 3; axis++) {
          let offset = offsets[base + axis] as number
          let speed = velocity[base + axis] as number
          const goal = target[axis] as number
          for (let step = 0; step < steps; step++) {
            speed += (STIFF * (goal - offset) - DAMP * speed) * stepTime
            offset += speed * stepTime
          }
          offsets[base + axis] = offset
          velocity[base + axis] = speed
        }
        moving = true
        dirty = true
      }
      if (dirty) {
        const attr = dots.geometry.getAttribute(PUSHED) as InstancedBufferAttribute
        ;(attr.array as Float32Array).set(offsets)
        attr.needsUpdate = true
      }
      return moving
    }

    // Seconds since the view or hover trigger, -1 before it; the hover trigger's
    // fade from the glyphs to its particles when the heading was seen as DOM.
    let elapsed = -1
    let fade = hover && seen ? 0 : -1
    if (fade >= 0) playing = true
    return (input): boolean => {
      if (stuck) {
        show(true)
        return playing
      }
      const { y, height, progress, presence } = input
      near = input
      const p = ctx.params
      tinted.value = own(p.color) ? 1 : 0
      shimmer.value = own(p.accent) ? 1 : 0
      const last = total()
      const vh = stage.height.peek()
      let time: number
      if (trigger === 'scroll') {
        // Gathers from `threshold` of the box in view to just before the middle, holds, and
        // scatters again on the way to the top.
        const start = (p.threshold * height) / (vh + height || 1)
        const gathered = Math.min(1, Math.max(0, (progress - start) / (HOLD[0] - start || 1)))
        const scattered = Math.min(
          1,
          Math.max(0, (progress - HOLD[1]) / (1 - start - HOLD[1] || 1)),
        )
        if (seen && gathered < 1) time = last
        else {
          seen = false
          time = gathered * last
        }
        time = Math.min(time, (1 - scattered) * last)
      } else {
        if (!seen && elapsed < 0) {
          // Counted above the bottom tenth of the viewport, like `reveal`.
          if (inView(y, height, vh, p.threshold)) {
            elapsed = 0
            playing = true
          }
        } else if (elapsed >= 0 && elapsed < last) elapsed += input.delta
        time = seen ? last : Math.max(elapsed, 0)
      }
      clock.value = Math.min(time, last)
      end.value = last
      if (!hover) {
        if (trigger === 'view' && time >= last) playing = false
        show(time >= last && presence >= 1)
        return playing
      }
      // Hover: the particles stay; a seen heading fades from its glyphs to them first.
      let busy = elapsed >= 0 && elapsed < last
      if (fade >= 0) {
        fade += input.delta
        solid.value = Math.max(0, 1 - fade / FADE)
        if (fade >= FADE) fade = -1
        else busy = true
      } else solid.value = 0
      if (spring(input, input.delta)) busy = true
      playing = busy
      show(false)
      return playing
    }
  },
})
export default assemble
