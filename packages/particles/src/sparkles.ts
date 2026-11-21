import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  clamp,
  cos,
  exp,
  float,
  fwidth,
  length,
  max,
  mix,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
} from 'three/webgpu'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Params = {
  trigger: ChoiceParam<'hover' | 'click' | 'loop' | 'view'>
  style: ChoiceParam<'star' | 'dot' | 'cross'>
  count: number
  scale: number
  color: ColorParam
  spread: number
  duration: number
  fps: number
  seed: number
}
type Point = { x: number; y: number }

/** Sparkles one instance holds at once: one instanced draw. */
export const POOL = 64
/** Frames a second while a hover, click or view burst plays. */
const BURST_FPS = 60
/** Visibility bleed: the farthest spread plus the largest sparkle. */
const BLEED = 160
/** Size of the largest sparkles at scale 1, px. */
const SIZE = 30
/** Floats per sparkle in each of the three attributes. */
const ITEM = 4

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Phases with their rate of time frames, read by the frame policy. */
const rates = new WeakMap<AbortSignal, () => number>()

/**
 * A spot around a box `width` x `height` centred at 0,0 (y up): a point of its outline picked
 * evenly along it, pushed out along the side's normal by up to `spread`, or a little inside.
 */
export function around(
  random: () => number,
  width: number,
  height: number,
  spread: number,
  size: number,
): Point {
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)
  // Distance along the outline, clockwise from the top left corner.
  const along = random() * 2 * (w + h)
  const out = -size * 0.3 + random() ** 0.8 * (Math.max(0, spread) + size * 0.3)
  if (along < w) return { x: along - w / 2, y: h / 2 + out }
  if (along < w + h) return { x: w / 2 + out, y: h / 2 - (along - w) }
  if (along < 2 * w + h) return { x: w / 2 - (along - w - h), y: -h / 2 - out }
  return { x: -w / 2 - out, y: -h / 2 + (along - 2 * w - h) }
}

/**
 * Small twinkling sparkles around an element: while hovered, in a burst from a click, once as it
 * comes into view, or all the time. For badges, "new" labels, premium buttons and product
 * highlights. They draw over the page and never take a click; under reduced motion nothing loads.
 */
const sparkles: Effect<Params> = defineEffect({
  name: 'sparkles',
  params: {
    trigger: oneOf('hover', 'click', 'loop', 'view'),
    style: oneOf('star', 'dot', 'cross'),
    count: 12,
    scale: 1,
    color: color('#ffd75e'),
    spread: 24,
    duration: 1.1,
    fps: 30,
    seed: 1,
  },
  rebuild: ['seed'],
  reducedMotion: 'off',
  bleed: BLEED,
  quality: { low: { count: 8, fps: 20 } },
  animate: { fps: (ctx) => rates.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, u, element } = ctx
    const { trigger, style } = params
    const random = rng(params.seed)

    // Per sparkle, three vec4 attributes.
    // spot: x, y (px from the box centre, y up), birth, life.
    // drift: x, y, turn, spin.
    // look: size, whiteness.
    const spot = new Float32Array(POOL * ITEM)
    const drift = new Float32Array(POOL * ITEM)
    const look = new Float32Array(POOL * ITEM)
    // Born long ago, so empty slots stay dark.
    for (let i = 0; i < POOL; i++) spot[i * ITEM + 2] = -1e6
    const quad = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))
    quad.dispose()
    // Attribute names stay clear of WGSL keywords (`move` is one).
    const attributes = [
      ['sparkSpot', spot],
      ['sparkDrift', drift],
      ['sparkLook', look],
    ].map(([name, data]) => {
      const buffer = new InstancedBufferAttribute(data as Float32Array, ITEM).setUsage(
        DynamicDrawUsage,
      )
      geometry.setAttribute(name as string, buffer)
      return buffer
    })
    geometry.instanceCount = 0

    const time = uniform(0)
    const spotData = attribute('sparkSpot', 'vec4')
    const driftData = attribute('sparkDrift', 'vec4')
    const lookData = attribute('sparkLook', 'vec4')
    const age = time.sub(spotData.z)
    const progress = clamp(age.div(max(spotData.w, 1e-3)), 0, 1)
    const alive = step(0, age).mul(step(age, spotData.w))
    // Grows fast, then shrinks slower: a twinkle, not a pulse.
    const twinkle = pow(sin(pow(progress, 0.7).mul(Math.PI)), 1.2).mul(alive)
    const easeOut = float(1).sub(pow(progress.oneMinus(), 3))
    const angle = driftData.z.add(driftData.w.mul(progress))
    const scale = lookData.x.mul(u.scale).mul(SIZE).mul(twinkle)
    const corner = positionGeometry.xy as unknown as Vec2
    const local = vec2(
      corner.x.mul(cos(angle)).sub(corner.y.mul(sin(angle))),
      corner.x.mul(sin(angle)).add(corner.y.mul(cos(angle))),
    ).mul(scale)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const center = (spotData.xy as unknown as Vec2)
      .add((driftData.xy as unknown as Vec2).mul(easeOut))
      .add(local) as unknown as Vec2
    material.positionNode = vec3(center.x, center.y, 0)

    // -1..1 across the quad.
    const point = varying(corner.mul(2)) as unknown as Vec2
    const radius = length(point)
    const shape =
      style === 'star'
        ? star(point, radius)
        : style === 'cross'
          ? cross(point, radius)
          : dot(radius)
    const core = smoothstep(0.35, 0, radius)
    const rgb = mix(u.color, vec3(1), clamp(lookData.y.add(core.mul(0.25)), 0, 1))
    material.colorNode = vec4(rgb, shape.mul(smoothstep(0, 0.2, twinkle), u.opacity))
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.visible = false
    ctx.place(mesh, { fit: 'none' })
    await ctx.compile(mesh)
    if (signal.aborted) return

    let now = 0
    let cursor = 0
    let used = 0
    /** End of the latest sparkle written: frames run until then. */
    let last = Number.NEGATIVE_INFINITY
    let active = trigger === 'loop'
    let box = { width: 0, height: 0 }
    /** Bursts asked for since the last frame: the click point, or null for one around the box. */
    const pending: (Point | null)[] = []

    /** Writes one sparkle into the next slot of the ring. */
    const spawn = (at: Point, birth: number, travel: Point): void => {
      const slot = cursor
      cursor = (cursor + 1) % POOL
      used = Math.max(used, slot + 1)
      const offset = slot * ITEM
      const life = Math.max(0.1, params.duration) * (0.7 + 0.6 * random())
      spot[offset] = at.x
      spot[offset + 1] = at.y
      spot[offset + 2] = birth
      spot[offset + 3] = life
      drift[offset] = travel.x
      drift[offset + 1] = travel.y
      drift[offset + 2] = random() * Math.PI
      drift[offset + 3] = (random() < 0.5 ? -1 : 1) * (0.4 + 0.8 * random())
      look[offset] = 0.45 + 0.55 * random()
      look[offset + 1] = random() * 0.35
      last = Math.max(last, birth + life)
    }
    const upload = (): void => {
      for (const buffer of attributes) buffer.needsUpdate = true
      geometry.instanceCount = used
    }
    const count = (): number => Math.min(POOL, Math.max(0, Math.round(params.count)))
    /** Sparkles around the box, born over `over` s from now, drifting up a little. */
    const scatter = (n: number, over: number): void => {
      for (let j = 0; j < n; j++) {
        const at = around(random, box.width, box.height, params.spread, params.scale * SIZE)
        spawn(at, now + random() * over, { x: (random() - 0.5) * 6, y: 4 + 6 * random() })
      }
    }
    /** A burst from a point of the box (px from its centre), flying outwards and slowing. */
    const burst = (from: Point | null): void => {
      const n = count()
      const reach = Math.max(params.spread, 4) + params.scale * SIZE
      for (let j = 0; j < n; j++) {
        const angle = (j / Math.max(n, 1) + random() * 0.15) * Math.PI * 2
        const start = from ?? around(random, box.width, box.height, 0, params.scale * SIZE)
        const distance = reach * (0.5 + 0.7 * random()) + (from ? 0 : params.spread * 0.3)
        spawn(
          { x: start.x + Math.cos(angle) * 4, y: start.y + Math.sin(angle) * 4 },
          now + random() * 0.12,
          { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance },
        )
      }
    }

    const playing = (): boolean => now < last
    rates.set(signal, () =>
      trigger === 'loop' ? params.fps : active || playing() || pending.length ? BURST_FPS : 0,
    )
    const on = (type: string, fn: (e: Event) => void): void =>
      element.addEventListener(type, fn, { signal, passive: true })
    const wake = (): void => ctx.invalidate()
    if (trigger === 'hover') {
      on('pointerenter', () => {
        active = true
        wake()
      })
      on('pointerleave', () => {
        active = false
      })
      on('focusin', (e) => {
        let visible = true
        try {
          visible = (e.target as Element).matches(':focus-visible')
        } catch {}
        if (visible) {
          active = true
          wake()
        }
      })
      on('focusout', () => {
        active = false
      })
    } else if (trigger === 'click') {
      // Passive and never cancelled: the click goes on to the link, button or form.
      on('click', (e) => {
        const click = e as MouseEvent
        // A keyboard click has no position: burst around the whole box.
        const pointed = click.detail > 0 || click.clientX !== 0 || click.clientY !== 0
        if (pointed) {
          const rect = element.getBoundingClientRect()
          pending.push({
            x: click.clientX - (rect.left + rect.width / 2),
            y: rect.top + rect.height / 2 - click.clientY,
          })
        } else pending.push(null)
        wake()
      })
    } else if (trigger === 'view') {
      const seen = (entry: IntersectionObserverEntry): boolean => {
        const root = entry.rootBounds
        return (
          entry.isIntersecting &&
          (entry.intersectionRatio >= 0.5 ||
            (!!root && entry.intersectionRect.height >= 0.5 * root.height))
        )
      }
      const fire = (): void => {
        pending.push(null)
        wake()
      }
      if (typeof IntersectionObserver === 'function') {
        const observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some(seen)) return
            observer.disconnect()
            fire()
          },
          { threshold: [0, 0.25, 0.5] },
        )
        observer.observe(element)
        ctx.onDispose(() => observer.disconnect())
      } else fire()
    }

    /** Ambient slots: each one twinkles, rests a while and comes back somewhere else. */
    const nextTwinkle = new Float64Array(POOL).fill(Number.NaN)
    return (input) => {
      box = { width: input.width, height: input.height }
      now += input.delta
      let dirty = false
      for (const at of pending.splice(0)) {
        if (trigger === 'view') scatter(count(), Math.max(0.1, params.duration) * 0.8)
        else burst(at)
        dirty = true
      }
      if (trigger === 'hover' || trigger === 'loop') {
        const n = count()
        for (let i = 0; i < n; i++) {
          const due = nextTwinkle[i] as number
          if (!active) {
            nextTwinkle[i] = Number.NaN
            continue
          }
          // Just switched on: a quarter show at once, so a tap or a quick pass still sparkles, and
          // the rest spread out so they never pop together.
          if (Number.isNaN(due))
            nextTwinkle[i] = i < n / 4 ? now : now + random() * params.duration * 0.6
          if (now >= (nextTwinkle[i] as number)) {
            scatter(1, 0)
            nextTwinkle[i] = now + params.duration * (0.9 + 0.8 * random())
            dirty = true
          }
        }
      }
      if (dirty) upload()
      time.value = now
      mesh.visible = playing()
    }
  },
})
export default sparkles

/** Star: a four-point sparkle, an astroid with thin spikes and a soft halo. */
function star(point: Vec2, radius: Float): Float {
  const astroid = pow(abs(point.x), 0.45).add(pow(abs(point.y), 0.45)) as unknown as Float
  return clamp(
    float(1)
      .sub(astroid)
      .div(max(fwidth(astroid), 1e-4)),
    0,
    1,
  )
    .add(exp(radius.mul(radius).mul(-7)).mul(0.6))
    .clamp(0, 1) as unknown as Float
}

/** Cross: a lens glint, two thin bars that taper to their ends. */
function cross(point: Vec2, radius: Float): Float {
  const bar = (x: Float, y: Float): Float =>
    clamp(
      abs(x)
        .oneMinus()
        .mul(0.14)
        .sub(abs(y))
        .div(max(fwidth(y), 1e-4)),
      0,
      1,
    ) as unknown as Float
  return max(bar(point.x, point.y), bar(point.y, point.x))
    .add(exp(radius.mul(radius).mul(-14)).mul(0.7))
    .clamp(0, 1) as unknown as Float
}

/** Dot: a round dot with a soft glow. */
function dot(radius: Float): Float {
  return clamp(
    float(0.32)
      .sub(radius)
      .div(max(fwidth(radius), 1e-4))
      .add(0.5),
    0,
    1,
  )
    .add(exp(radius.mul(radius).mul(-6)).mul(0.5))
    .clamp(0, 1) as unknown as Float
}
