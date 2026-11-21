import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { rng } from '@dioramajs/effects/kit'
import {
  abs,
  clamp,
  dot,
  float,
  floor,
  fract,
  hash,
  max,
  mix,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { type Node, Vector2 } from 'three/webgpu'

type F = Node<'float'>
type V2 = Node<'vec2'>
type Style = 'rgb' | 'slice' | 'vhs'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<'hover' | 'interval' | 'scroll' | 'load'>
  strength: number
  blocks: number
  split: number
  interval: number
  duration: number
  seed: number
}

/** How a style spends a burst. */
interface Look {
  /** Share of the blocks struck at full strength. */
  readonly density: number
  /** Largest slice offset, as a share of the width. */
  readonly shift: number
  /** Scale of the channel split. */
  readonly split: number
  /** Share of the struck blocks smeared into streaks of one column. */
  readonly smear: number
  /** Darkening of the scanlines. */
  readonly scan: number
  /** Static mixed into struck blocks (and the tracking band of vhs). */
  readonly noise: number
}

const LOOKS: Readonly<Record<Style, Look>> = {
  rgb: { density: 0.3, shift: 0.05, split: 1, smear: 0, scan: 0.1, noise: 0.07 },
  slice: { density: 0.55, shift: 0.16, split: 0.35, smear: 0.3, scan: 0.06, noise: 0.08 },
  vhs: { density: 0.12, shift: 0.015, split: 0.7, smear: 0, scan: 0.18, noise: 0.3 },
}

/** The pattern jumps this often during a burst, s: digital steps rather than smooth motion. */
const STEP = 1 / 20
/** Scroll velocity below this never glitches; at FULL the glitch is at its peak. */
const QUIET = 0.03
const FULL = 0.3
/** Period of the scanlines, CSS px. */
const SCANLINE = 4
/** Pattern steps wrap here, so hash inputs stay exact in a float. */
const WRAP = 8192

/** A uniform random number in [0, 1) for the seed and two counters: the same on every load. */
export function chance(seed: number, a: number, b: number): number {
  // Large primes spread neighbouring seeds and counters far apart.
  const seeded = Math.round(seed) * 73856093
  return rng((seeded ^ Math.imul(a + 1, 19349663) ^ Math.imul(b + 1, 83492791)) >>> 0)()
}

/**
 * The strength of step `n` of burst `burst`, 0..1, at `t` of its length: the first step hits in
 * full, some later ones drop out so the picture stutters back, and the rest fade a little.
 */
export function strike(seed: number, burst: number, n: number, t: number): number {
  if (n === 0) return 1
  if (chance(seed, burst, n) < 0.2) return 0
  return (0.35 + 0.65 * chance(seed, burst, n + 4096)) * (1 - 0.4 * t)
}

/**
 * Digital glitch on an image or video: blocks of it slide sideways, its color channels split,
 * scanlines flicker and static flashes, in short bursts on hover, on a timer, with scroll speed or
 * once as it first shows. At rest the copy is the image as it is.
 */
const glitch: Effect<Params> = defineEffect({
  name: 'glitch',
  params: {
    style: oneOf('rgb', 'slice', 'vhs'),
    trigger: oneOf('hover', 'interval', 'scroll', 'load'),
    strength: 1,
    blocks: 12,
    split: 8,
    interval: 3,
    duration: 0.45,
    seed: 1,
  },
  media: true,
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { surface, u, params, signal } = ctx
    const el = ctx.element as HTMLElement
    const look = LOOKS[params.style]
    const vhs = params.style === 'vhs'
    const trigger = params.trigger
    // (strength of the burst now 0..1, pattern step), written on the CPU.
    const state = uniform(new Vector2())

    // Leaving a page glitches the picture out block by block, entering brings it back.
    const entered = smoothstep(0, 1, u.presence)
    const amount = max(state.x, entered.oneMinus())
    const strength = max(u.strength, 0)
    const size = u.size as unknown as V2
    const patternStep = state.y
    // A float of the seed and the step, so each step of each seed draws its own pattern.
    const base = floor(max(u.seed, 0)).mul(7919).add(patternStep.mul(97))
    // About `blocks` bands whose edges jump every step, cut into one to three columns.
    const rows = max(floor(max(u.blocks, 1).mul(mix(0.6, 1.4, hash(base)))), 1)
    const cols = floor(hash(base.add(1)).mul(3)).add(1)
    const shift = hash(base.add(2))
    const cell = (at: V2): { id: F; col: F } => {
      const row = floor(at.y.oneMinus().mul(rows).add(shift))
      const col = floor(at.x.mul(cols))
      // Four hash streams per cell: struck, offset, split or smear, presence.
      return { id: row.mul(4).add(col).add(base).mul(4) as unknown as F, col: col as unknown as F }
    }
    const density = clamp(amount.mul(strength, look.density), 0, 0.95)
    const struck = (id: F): F =>
      select(hash(id).lessThan(density), float(1), float(0)) as unknown as F
    // vhs: a band of bad tracking that rolls down the frame, step by step.
    const tracking = (at: V2): F => {
      const bandY = fract(hash(floor(max(u.seed, 0)).mul(7919)).add(patternStep.mul(0.045)))
      return smoothstep(0.06, 0, abs(at.y.oneMinus().sub(bandY))) as unknown as F
    }

    surface.uv((at) => {
      const { id, col } = cell(at)
      const on = struck(id)
      // A struck block slides sideways and wraps around, like a broken frame buffer.
      const moved = at.x.add(
        hash(id.add(1))
          .sub(0.5)
          .mul(2 * look.shift)
          .mul(amount, strength, on),
      )
      let x = moved.sub(floor(moved).mul(on))
      if (look.smear) {
        // Some repeat one column of pixels across the block, a streak.
        const smear = on.mul(step(1 - look.smear, hash(id.add(2))))
        x = mix(x, col.add(hash(id.add(3))).div(cols), smear)
      }
      if (vhs) {
        // The tape wobbles, and lines in the tracking band jump sideways.
        const line = at.y.mul(size.y)
        const wave = sin(line.mul(0.05).add(patternStep.mul(1.3))).mul(0.004)
        const jitter = hash(floor(line.div(2)).add(base.mul(3)))
          .sub(0.5)
          .mul(0.05)
        x = x.add(wave.add(jitter.mul(tracking(at))).mul(amount, strength))
      }
      return vec2(x, at.y)
    })

    surface.color((color, { uv, box, sample }) => {
      const { id } = cell(box)
      const on = struck(id)
      // Red and blue part ways: a little everywhere, more in the struck blocks. Only the
      // difference adds to what earlier effects made, so at rest it is a no-op.
      const splitPx = u.split.mul(amount, look.split, mix(0.35, 1.2, on.mul(hash(id.add(2)))))
      const offset = vec2(splitPx.div(max(size.x, 1)), 0)
      const here = sample(uv)
      const red = color.r.add(sample(uv.add(offset)).r.sub(here.r))
      const blue = color.b.add(sample(uv.sub(offset)).b.sub(here.b))
      let rgb: Node<'vec3'> = vec3(red, color.g, blue) as unknown as Node<'vec3'>
      // Scanlines, and the whole frame flickers a little each step.
      const dark = step(0.5, fract(box.y.mul(size.y).div(SCANLINE)))
      const flicker = hash(base.add(3)).sub(0.5).mul(0.2)
      rgb = rgb.mul(amount.mul(flicker.sub(dark.mul(look.scan))).add(1)) as unknown as Node<'vec3'>
      // Static flashes in the struck blocks on some steps, and along the tracking band.
      const grid = floor(box.mul(size).div(2))
      const grain = hash(
        grid.x.add(grid.y.mul(2048)).add(floor(hash(base.add(4)).mul(1e6))),
      ) as unknown as F
      let where: F = on.mul(step(0.5, hash(base.add(5)))) as unknown as F
      if (vhs) {
        where = max(where, tracking(box)) as unknown as F
        // Washed-out tape: less saturation, lifted blacks.
        const luma = dot(rgb, vec3(0.299, 0.587, 0.114))
        rgb = mix(rgb, vec3(luma), amount.mul(0.3))
          .mul(amount.mul(-0.08).add(1))
          .add(amount.mul(0.04)) as unknown as Node<'vec3'>
      }
      rgb = mix(rgb, vec3(grain), where.mul(amount, look.noise)) as unknown as Node<'vec3'>
      // Blocks drop out in a random order as the copy leaves; all of them show at rest.
      const kept = step(hash(id.add(3)), entered)
      return vec4(rgb, color.a.mul(kept))
    })

    // A burst asked for and not drawn yet, e.g. a timer that went off while off screen.
    let pending = trigger === 'load'
    // Seconds into the burst, -1 when none plays.
    let time = -1
    let bursts = 0
    let bursting = false
    // Seconds of scroll glitch or of a page transition, for the steps outside bursts.
    let clock = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const wake = (): void => {
      pending = true
      ctx.invalidate()
    }
    const schedule = (first: boolean): void => {
      clearTimeout(timer)
      const random = chance(params.seed, bursts, 7)
      // The first wait is shorter and more spread out than the later ones.
      const wait =
        Math.max(params.interval, 0.1) * (first ? 0.4 + 0.6 * random : 0.75 + 0.5 * random)
      timer = setTimeout(wake, wait * 1000)
    }
    ctx.onDispose(() => clearTimeout(timer))
    if (trigger === 'interval') schedule(true)
    if (trigger === 'hover') {
      el.addEventListener(
        'pointerenter',
        (e) => {
          if (e.pointerType !== 'touch' && time < 0) wake()
        },
        { signal },
      )
      // Touch screens have no hover: a tap plays the burst.
      el.addEventListener(
        'pointerdown',
        (e) => {
          if (e.pointerType === 'touch' && time < 0) wake()
        },
        { signal },
      )
    }

    return (input): boolean => {
      const stateValue = state.value as Vector2
      let level = 0
      let at = 0
      if (pending && time < 0) {
        pending = false
        time = 0
        bursts++
        bursting = true
      } else if (time >= 0) time += input.delta
      if (time >= 0) {
        const length = Math.max(params.duration, 0.05)
        if (time >= length) {
          time = -1
          bursting = false
          if (trigger === 'interval') schedule(false)
        } else {
          const burstStep = Math.floor(time / STEP)
          level = strike(params.seed, bursts, burstStep, time / length)
          at = bursts * 32 + burstStep
        }
      }
      if (trigger === 'scroll') {
        const speed = Math.min(1, Math.max(0, (Math.abs(input.velocity) - QUIET) / (FULL - QUIET)))
        if (speed > 0) {
          clock += input.delta
          const scrollStep = Math.floor(clock / STEP)
          level = Math.max(level, speed * (0.5 + 0.5 * chance(params.seed, 0, scrollStep)))
          at = scrollStep
        }
      }
      if (input.presence < 1) {
        clock += input.delta
        at = Math.floor(clock / STEP)
      }
      stateValue.set(level, at % WRAP)
      return bursting
    }
  },
})
export default glitch
