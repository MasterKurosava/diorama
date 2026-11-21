// An element that pulses with a page's music: it scales, shakes and glows, or sends out rings, on
// the beats, the bass or the loudness of an <audio> or <video>.
import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { cornerRadius, radii, roundedBox } from '@dioramajs/effects/kit'
import {
  abs,
  clamp,
  exp,
  float,
  positionGeometry,
  select,
  smoothstep,
  uniform,
  varying,
} from 'three/tsl'
import {
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { audio, check, local, routed, running, source, sourceOf, wake } from './graph'

type Params = {
  for: string
  by: ChoiceParam<'beat' | 'bass' | 'level'>
  style: ChoiceParam<'glow' | 'ring'>
  color: ColorParam
  zoom: number
  shake: number
  glow: number
  spread: number
  sensitivity: number
  duration: number
  fps: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>

/** The kick and the bass line, Hz. */
export const BASS: readonly [number, number] = [40, 150]
/** Samples of the analyser: bins of about 23 Hz at 48 kHz, five of them in the bass. */
const FFT = 2048
/** Time constant of the running average a beat must stand out of, s. */
const AVERAGE = 1.2
/** The loudest recent energy fades with this time constant, for the level styles, s. */
const GAIN = 4
/**
 * Shortest time between two beats, s: at most three pulses a second, under the flash threshold
 * of WCAG 2.3.1 whatever the tempo; faster music pulses on every other beat.
 */
export const GAP = 0.34
/** Energy below which a frame is silence, linear amplitude. */
const FLOOR = 1e-4
/** Rings alive at once and how long one travels, s. */
const RINGS = 4
const LIFE = 0.9
/** The steady light that stands for "playing" under reduced motion, of `glow`. */
const STILL = 0.35
/** Rise time of the level styles, s. */
const ATTACK = 0.03
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Smoothing of the analyser between frames, 0..1. */
const SMOOTHING = 0.2
/** Px the light's quad reaches past `spread`, so the soft edge is never cut. */
const QUAD_PAD = 4
/** Each beat shakes in a new direction: the golden angle, radians, never repeats a pattern. */
const GOLDEN_ANGLE = 2.39996
/** Shakes a second of the wobble after a beat. */
const WOBBLE = 9

/** What the frame policy reads, by the phase's signal: the probe hands setup a proxy context. */
const rates = new WeakMap<AbortSignal, () => number>()

/** An error the runtime reports with its code, like its own EffectError. */
function fault(
  code: 'EFFECT_CORS' | 'EFFECT_TARGET' | 'EFFECT_PARAM',
  message: string,
  element: Element,
): Error {
  return Object.assign(new Error(`${code}: beat ${message}`), {
    name: 'EffectError',
    code,
    effect: 'beat',
    element,
  })
}

const corsError = (element: Element, media: HTMLMediaElement): Error =>
  fault(
    'EFFECT_CORS',
    `cannot listen to ${sourceOf(media) || 'its source'}: from another origin without CORS, Web Audio would mute it. Add crossorigin="anonymous" to the <${media.localName}> and serve the file with Access-Control-Allow-Origin`,
    element,
  )

/** The player: `for`, else the first audio or video of the closest container that holds one. */
export function findPlayer(element: Element, selector: string): HTMLMediaElement {
  let found: Element | null | undefined = null
  if (selector) {
    try {
      found = document.querySelector(selector)
    } catch {
      throw fault('EFFECT_PARAM', `data-dio-for "${selector}" is not a selector`, element)
    }
  } else {
    for (let node: Element | null = element; node && !found; node = node.parentElement)
      found = node.querySelector('audio, video')
  }
  if (found?.localName !== 'audio' && found?.localName !== 'video') {
    const where = selector ? `"${selector}"` : 'around it'
    throw fault(
      'EFFECT_TARGET',
      `found no <audio> or <video> ${where}: name the player with data-dio-for`,
      element,
    )
  }
  return found as HTMLMediaElement
}

/** Mean linear amplitude of the bins between `lo` and `hi` Hz, from decibels. */
export function energy(db: ArrayLike<number>, rate: number, lo: number, hi: number): number {
  const binHz = rate / (2 * db.length)
  const first = Math.max(0, Math.floor(lo / binHz))
  const last = Math.min(db.length - 1, Math.ceil(hi / binHz))
  let sum = 0
  for (let i = first; i <= last; i++) {
    const decibels = db[i] as number
    sum += Number.isFinite(decibels) ? 10 ** (decibels / 20) : 0
  }
  return sum / Math.max(1, last - first + 1)
}

/** Root mean square of analyser bytes around 128. */
export function loudness(bytes: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i++) {
    const sample = ((bytes[i] as number) - 128) / 128
    sum += sample * sample
  }
  return Math.sqrt(sum / Math.max(1, bytes.length))
}

/**
 * Beats from the energy of each frame: a rise above the running average by a margin, and near the
 * loudest recent energy (so a hi-hat between kicks is not one), no sooner than GAP after the last
 * beat. The sensitivity lowers both bars. Returns the strength 0..1 of a beat on this frame, 0 for
 * none. Deterministic: the same frames give the same beats.
 */
export class Detector {
  #average = 0
  #loud = 0
  #previous = 0
  #last = Number.NEGATIVE_INFINITY
  #time = 0

  /** Takes the energy of one frame `dt` s long. */
  step(value: number, dt: number, sensitivity: number): number {
    this.#time += dt
    const average = this.#average
    this.#average =
      average === 0 ? value : average + (value - average) * (1 - Math.exp(-dt / AVERAGE))
    this.#loud = Math.max(value, this.#loud * Math.exp(-dt / GAIN))
    const rising = value > this.#previous
    this.#previous = value
    const keen = Math.min(1, Math.max(0, sensitivity))
    const margin = 1.75 - 0.6 * keen
    if (
      !rising ||
      value < FLOOR ||
      value < average * margin ||
      value < this.#loud * (0.65 - 0.3 * keen) ||
      this.#time - this.#last < GAP
    )
      return 0
    this.#last = this.#time
    return Math.min(1, 0.55 + (value / Math.max(average, 1e-9) - margin) / margin)
  }

  /** Forgets the average, as after a pause or a seek. */
  reset(): void {
    this.#average = 0
    this.#previous = 0
  }
}

/**
 * An element that pulses with a page's music: it scales, shakes and glows, or sends out rings, on
 * the beats, the bass or the loudness of an <audio> or <video>. It never starts the sound; frames
 * only while the player plays and a pulse fades. The element stays live DOM.
 */
const beat: Effect<Params> = defineEffect({
  name: 'beat',
  params: {
    for: '',
    by: oneOf('beat', 'bass', 'level'),
    style: oneOf('glow', 'ring'),
    color: Object.freeze({ '~kind': 'color', value: '#ff5a36' }) as ColorParam,
    zoom: 1.06,
    shake: 0,
    glow: 0.8,
    spread: 28,
    sensitivity: 0.5,
    duration: 0.25,
    fps: 60,
  },
  on: ':not(audio, video, canvas)',
  bleed: 96,
  quality: { low: { fps: 30 }, medium: { fps: 45 } },
  animate: { fps: (ctx) => rates.get(ctx.signal)?.() ?? 0 },
  setup(ctx: EffectContext<Params>) {
    const { params, signal, u, element } = ctx
    const el = element as HTMLElement
    const media = findPlayer(element, params.for)
    if (local(media) === false) throw corsError(element, media)
    const by = params.by
    const rings = params.style === 'ring'

    // The light: a quad around the box, drawn outside the element's rounded shape only.
    const size = uniform(new Vector2(1, 1))
    const corners = uniform(new Vector4())
    const level = uniform(0)
    // Per ring: its age, s (-1 when unused), and its strength.
    const pulses = Array.from({ length: RINGS }, () => uniform(new Vector2(-1, 0)))
    const pad = u.spread.max(1).add(QUAD_PAD)
    // Px from the element's centre, y up.
    const pixel = varying(positionGeometry.xy.mul(size.add(pad.mul(2)))) as unknown as V2
    const half = size.mul(0.5) as unknown as V2
    const distance = roundedBox(
      pixel,
      half,
      cornerRadius(pixel, corners as unknown as Node<'vec4'>),
    )
    const outside = smoothstep(-0.5, 0.5, distance)
    let alpha: F
    if (rings) {
      alpha = float(0) as unknown as F
      for (const ring of pulses) {
        const age = ring.x
        const t = age.div(LIFE).clamp(0, 1)
        // Out fast, then slowing: a ring's distance from the edge.
        const at = t.oneMinus().pow(3).oneMinus().mul(u.spread)
        const line = float(1.25)
          .sub(abs(distance.sub(at).sub(1)))
          .clamp(0, 1)
        alpha = alpha.add(
          line
            .mul(t.oneMinus().pow(2))
            .mul(ring.y)
            .mul(select(age.greaterThanEqual(0), 1, 0)),
        ) as unknown as F
      }
      // A faint glow under the rings while the music plays.
      alpha = alpha
        .add(
          exp(distance.max(0).negate().div(u.spread.max(1).mul(0.25)))
            .mul(level)
            .mul(0.35),
        )
        .mul(u.glow) as unknown as F
    } else {
      alpha = exp(distance.max(0).negate().div(u.spread.max(1).mul(0.5)))
        .mul(level)
        .mul(u.glow) as unknown as F
    }
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    material.colorNode = u.color
    material.opacityNode = clamp(alpha, 0, 1).mul(outside).mul(u.opacity)
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.frustumCulled = false
    mesh.visible = false
    ctx.place(mesh, { fit: 'none' })

    const reduced = (): boolean => ctx.app.stage.reducedMotion.peek()
    const listen = (target: EventTarget, type: string, fn: (e: Event) => void): void =>
      target.addEventListener(type, fn, { signal })
    const redraw = (): void => ctx.invalidate()
    let playing = !media.paused && !media.ended
    let broken: Error | undefined
    let analyser: AnalyserNode | undefined
    let rate = 48000
    let db = new Float32Array(0)
    let bytes = new Uint8Array(0)
    let connecting = false

    /** Takes the player's sound into the graph once it is known not to mute it. */
    const connect = async (): Promise<void> => {
      if (analyser || connecting || broken || reduced()) return
      connecting = true
      try {
        if (!(await check(media))) {
          if (!signal.aborted && !routed(media)) broken = corsError(element, media)
          return
        }
        const graph = audio()
        if (!graph || signal.aborted || !(await running(graph, signal))) return
        const node = source(graph, media)
        const made = graph.createAnalyser()
        made.fftSize = FFT
        made.smoothingTimeConstant = SMOOTHING
        node.connect(made)
        signal.addEventListener('abort', () => node.disconnect(made), { once: true })
        rate = graph.sampleRate
        db = new Float32Array(made.frequencyBinCount)
        bytes = new Uint8Array(made.fftSize)
        analyser = made
      } catch (error) {
        broken = error as Error
      } finally {
        connecting = false
        redraw()
      }
    }
    const detector = new Detector()
    listen(media, 'play', () => {
      wake()
      void connect()
    })
    listen(media, 'playing', () => {
      playing = true
      redraw()
    })
    for (const type of ['pause', 'ended', 'emptied', 'seeking']) {
      listen(media, type, () => {
        detector.reset()
        if (type === 'seeking') return
        playing = false
        redraw()
      })
    }
    if (playing) void connect()

    // The pulse 0..1, the rings, the loudest recent energy, and what the DOM had before.
    let pulse = 0
    let peak = 0
    let count = 0
    // Seconds since the last beat, and the direction of its shake.
    let since = 0
    let angle = 0
    const ages = new Float32Array(RINGS).fill(-1)
    const strengths = new Float32Array(RINGS)
    const saved = { scale: el.style.scale, translate: el.style.translate }
    let base = 1
    let moved = false
    const restore = (): void => {
      if (!moved) return
      moved = false
      el.style.scale = saved.scale
      el.style.translate = saved.translate
    }
    ctx.onDispose(restore)
    const alive = (): boolean => pulse > 0 || ages.some((age) => age >= 0)
    rates.set(signal, () => ((playing && analyser) || alive() ? params.fps : 0))

    const world = { x: 0, y: 0 }
    let measured = ''
    let radiiPx = [0, 0, 0, 0]
    return (input) => {
      if (broken) throw broken
      const dt = Math.min(input.delta, MAX_STEP)
      const still = input.reducedMotion
      if (!still && playing && !analyser) void connect()
      let hit = 0
      if (still) {
        pulse = playing ? STILL : 0
        ages.fill(-1)
      } else {
        let value = 0
        if (playing && analyser) {
          analyser.getFloatFrequencyData(db)
          if (by === 'level') {
            analyser.getByteTimeDomainData(bytes)
            value = loudness(bytes)
          } else value = energy(db, rate, BASS[0], BASS[1])
          hit = detector.step(value, dt, params.sensitivity)
        }
        const fall = Math.exp(-dt / Math.max(1e-3, params.duration))
        if (by === 'beat') pulse = Math.max(pulse * fall, hit)
        else {
          peak = Math.max(value, peak * Math.exp(-dt / GAIN))
          const target = playing && peak > FLOOR ? (value / peak) ** 1.5 : 0
          pulse =
            target > pulse
              ? pulse + (target - pulse) * (1 - Math.exp(-dt / ATTACK))
              : Math.max(target, pulse * fall)
        }
        // A hundredth of a pulse is under a tenth of a pixel of scale: rest.
        if (pulse < 0.01) pulse = 0
        for (let i = 0; i < RINGS; i++) {
          if ((ages[i] as number) < 0) continue
          ages[i] = (ages[i] as number) + dt
          if ((ages[i] as number) >= LIFE) ages[i] = -1
        }
        if (hit > 0) {
          count++
          since = 0
          angle = count * GOLDEN_ANGLE
          if (rings) {
            const free = ages.indexOf(-1)
            const slot = free >= 0 ? free : ages.indexOf(Math.max(...ages))
            ages[slot] = 0
            strengths[slot] = hit
          }
        } else since += dt
      }

      // The element: a CSS scale and translate on the DOM, or a pose on a copy another effect draws.
      const amount = still ? 0 : pulse
      // zoom is a factor, 1 or 0 for none.
      const grow = (params.zoom > 0 ? params.zoom - 1 : 0) * amount
      const wobble = by === 'beat' ? Math.cos(since * Math.PI * 2 * WOBBLE) : 1
      const shakeX = params.shake * amount * Math.cos(angle) * wobble
      const shakeY = params.shake * amount * Math.sin(angle) * wobble
      const copied = el.getAttribute('data-dio-state') === 'drawn'
      if (copied) {
        restore()
        if (grow || shakeX || shakeY) {
          const centre = ctx.render.toWorld(
            input.x + input.width / 2,
            input.y + input.height / 2,
            world,
          )
          ctx.pose(ctx.layer, { x: centre.x + shakeX, y: centre.y - shakeY, scale: 1 + grow }, 1)
        }
      } else if (grow || shakeX || shakeY) {
        if (!moved) {
          moved = true
          base = Number.parseFloat(getComputedStyle(el).scale) || 1
        }
        el.style.scale = String(base * (1 + grow))
        el.style.translate =
          shakeX || shakeY ? `${shakeX.toFixed(2)}px ${shakeY.toFixed(2)}px` : saved.translate
      } else restore()

      level.value = pulse
      pulses.forEach((ring, i) => {
        ring.value.set(ages[i] as number, strengths[i] as number)
      })
      mesh.visible = params.glow > 0 && alive()
      if (!mesh.visible) return
      // The light follows the element as it shows. The runtime's box may hold the CSS scale and
      // translate of an earlier frame or none, so while the light is on the DOM is asked.
      let width = input.width
      let height = input.height
      let offsetX = 0
      let offsetY = 0
      let cssScale = 1
      if (!copied) {
        const rect = el.getBoundingClientRect()
        width = rect.width
        height = rect.height
        offsetX = rect.left + rect.width / 2 - (input.x + input.width / 2)
        offsetY = input.y + input.height / 2 - (rect.top + rect.height / 2)
        cssScale = rect.width / Math.max(1, el instanceof HTMLElement ? el.offsetWidth : rect.width)
      }
      size.value.set(width, height)
      // Corner radii are read again only when the unscaled box changes.
      const box = `${(width / cssScale).toFixed(1)}x${(height / cssScale).toFixed(1)}`
      if (box !== measured) {
        measured = box
        radiiPx = radii(el, width / cssScale, height / cssScale)
      }
      corners.value.set(...(radiiPx.map((c) => c * cssScale) as [number, number, number, number]))
      const reach = Math.max(1, params.spread) + QUAD_PAD
      mesh.scale.set(width + reach * 2, height + reach * 2, 1)
      mesh.position.set(offsetX, offsetY, 0)
    }
  },
})
export default beat
