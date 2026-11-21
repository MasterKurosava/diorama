// The sound of a page's <audio> or <video> drawn in an element: live bars, a wave or a ring, or the
// waveform of the whole track with seeking.
import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp, ease, roundedBox } from '@dioramajs/effects/kit'
import {
  abs,
  atan,
  clamp,
  cos,
  float,
  floor,
  fwidth,
  length,
  max,
  min,
  mix,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
} from 'three/tsl'
import {
  DataTexture,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  type Node,
  PlaneGeometry,
  RGFormat,
} from 'three/webgpu'
import { audio, check, local, routed, running, source, sourceOf, wake } from './graph'

type Params = {
  for: string
  style: ChoiceParam<'bars' | 'wave' | 'ring' | 'peaks'>
  peaks: string
  bars: number
  color: ColorParam
  accent: ColorParam
  gap: number
  radius: number
  range: readonly [number, number]
  smooth: number
  mirror: boolean
  seek: boolean
  fps: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>

/** A colour param without the light entry's helper. */
const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** The spectrum the bars show, Hz, on a log scale. */
export const LOW = 40
export const HIGH = 16000
/** Most bars; the texture of levels is this wide. */
const MOST = 128
/** Points of the wave. */
export const POINTS = 256
/** Samples of the analyser: 4096 resolves the low bars to about 12 Hz. */
const FFT = 4096
/** Samples one wave shows: 1024 is about 21 ms at 48 kHz. */
const SPAN = 1024
/** Bars and the wave fall to rest over this after a pause, s. */
const FALL = 0.3
/** Falling levels ease down with this time constant while playing, s. */
const RELEASE = 0.08
/** A peaks bar takes this many CSS px with its gap. */
const STEP = 3
/** Most peaks bars, whatever the width. */
const PEAKS = 2048
/** Width of the wave ribbon, CSS px. */
const LINE = 2
/** Height of a bar at rest, CSS px: a row of dots rather than nothing. */
const DOT = 3
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Half-life of the wave following the sound, s. */
const WAVE_HALF_LIFE = 0.03
/** A touch that moved further than this, px, scrolls instead of seeking. */
const TAP_SLOP = 8

/** What the frame policy reads, by the phase's signal: the probe hands setup a proxy context. */
const rates = new WeakMap<AbortSignal, () => number>()

/** An error the runtime reports with its code, like its own EffectError. */
function fault(
  code: 'EFFECT_CORS' | 'EFFECT_TARGET' | 'EFFECT_PARAM',
  message: string,
  element: Element,
): Error {
  return Object.assign(new Error(`${code}: visualizer ${message}`), {
    name: 'EffectError',
    code,
    effect: 'visualizer',
    element,
  })
}

const corsError = (element: Element, media: HTMLMediaElement): Error =>
  fault(
    'EFFECT_CORS',
    `cannot listen to ${sourceOf(media) || 'its source'}: from another origin without CORS, Web Audio would mute it. Add crossorigin="anonymous" to the <${media.localName}> and serve the file with Access-Control-Allow-Origin, or use style "peaks"`,
    element,
  )

/** The player: `for`, else the closest audio or video before the element in its parent. */
function find(element: Element, selector: string): HTMLMediaElement {
  let found: Element | null | undefined = null
  if (selector) {
    try {
      found = document.querySelector(selector)
    } catch {
      throw fault('EFFECT_PARAM', `data-dio-for "${selector}" is not a selector`, element)
    }
  } else {
    for (
      let sibling = element.previousElementSibling;
      sibling && !found;
      sibling = sibling.previousElementSibling
    ) {
      found = sibling.matches('audio, video')
        ? sibling
        : [...sibling.querySelectorAll('audio, video')].pop()
    }
  }
  if (found?.localName !== 'audio' && found?.localName !== 'video') {
    const where = selector ? `"${selector}"` : 'before it in its parent'
    throw fault(
      'EFFECT_TARGET',
      `found no <audio> or <video> ${where}: name the player with data-dio-for`,
      element,
    )
  }
  return found as HTMLMediaElement
}

/**
 * Levels 0..1 of `count` bars from analyser bytes, on a log scale from LOW to HIGH. A band
 * narrower than a bin reads between its two nearest bins, a wider one takes its loudest bin.
 * `ring` lays the spectrum out twice, mirrored: bass at the bottom, treble at the top.
 */
export function bands(
  bins: ArrayLike<number>,
  rate: number,
  count: number,
  out: Float32Array,
  ring = false,
): void {
  const binHz = rate / (2 * bins.length)
  const ratio = HIGH / LOW
  const last = bins.length - 1
  /** The bins read at a fractional bin index, linearly. */
  const at = (bin: number): number => {
    const i = Math.min(last, Math.max(0, Math.floor(bin)))
    const j = Math.min(last, i + 1)
    const f = Math.min(1, Math.max(0, bin - i))
    return (bins[i] as number) + ((bins[j] as number) - (bins[i] as number)) * f
  }
  for (let bar = 0; bar < count; bar++) {
    // The bar's stretch of the spectrum, 0..1 on the log scale.
    let lo: number
    let hi: number
    if (ring) {
      // Bar k sits k / count of a turn from the top, clockwise.
      const middle = Math.abs(1 - (2 * bar) / count)
      const half = 1 / count
      lo = Math.max(0, middle - half)
      hi = Math.min(1, middle + half)
    } else {
      lo = bar / count
      hi = (bar + 1) / count
    }
    const fromBin = (LOW * ratio ** lo) / binHz
    const toBin = (LOW * ratio ** hi) / binHz
    let value: number
    if (toBin - fromBin < 1) value = at((fromBin + toBin) / 2)
    else {
      value = Math.max(at(fromBin), at(toBin))
      for (let bin = Math.ceil(fromBin); bin <= toBin && bin <= last; bin++)
        value = Math.max(value, bins[bin] as number)
    }
    out[bar] = value / 255
  }
}

/**
 * The wave of `POINTS` from analyser bytes: from the first rising zero crossing, so a steady tone
 * stands still, averaged down from SPAN samples and tapered to the middle line at both ends.
 */
export function trace(samples: ArrayLike<number>, out: Float32Array): void {
  const total = samples.length
  const span = Math.min(SPAN, total)
  let start = 0
  for (let k = 1; k <= total - span; k++) {
    if ((samples[k - 1] as number) < 128 && (samples[k] as number) >= 128) {
      start = k
      break
    }
  }
  const per = span / POINTS
  for (let i = 0; i < POINTS; i++) {
    let sum = 0
    const from = start + Math.floor(i * per)
    const to = Math.max(from + 1, start + Math.floor((i + 1) * per))
    for (let k = from; k < to; k++) sum += ((samples[k] as number) - 128) / 128
    out[i] = (sum / (to - from)) * taper(i / (POINTS - 1))
  }
}

/** 1 in the middle, easing to 0 over the outer 12 % at each end. */
const taper = (x: number): number => {
  const inner = Math.min(1, Math.min(x, 1 - x) / 0.12)
  return inner * inner * (3 - 2 * inner)
}

/** A calm shape for reduced motion: a low arch over the spectrum position 0..1. */
const calm = (f: number): number => 0.12 + 0.26 * Math.sin(Math.PI * f) ** 2

/** Peaks of the JSON: audiowaveform (v1, v2, any channels and bits), or an array of 0..1. */
export function readPeaks(json: unknown): { values: Float32Array; duration: number } | undefined {
  if (Array.isArray(json)) {
    const values = Float32Array.from(json, (v) => Math.min(1, Math.abs(Number(v)) || 0))
    return { values, duration: 0 }
  }
  const file = json as {
    data?: unknown
    channels?: number
    bits?: number
    sample_rate?: number
    samples_per_pixel?: number
  } | null
  if (!file || !Array.isArray(file.data)) return undefined
  const data = file.data as number[]
  const channels = Math.max(1, Math.round(file.channels ?? 1))
  // Each point holds a minimum and a maximum per channel.
  const length = Math.floor(data.length / (2 * channels))
  const values = new Float32Array(length)
  let loudest = 0
  for (let i = 0; i < length; i++) {
    let peak = 0
    for (let c = 0; c < 2 * channels; c++) {
      peak = Math.max(peak, Math.abs(Number(data[i * 2 * channels + c]) || 0))
    }
    values[i] = peak
    loudest = Math.max(loudest, peak)
  }
  // The loudest moment reaches the top: quiet speech still fills the row.
  if (loudest > 0) for (let i = 0; i < length; i++) values[i] = (values[i] as number) / loudest
  const duration = ((file.samples_per_pixel ?? 0) * length) / (file.sample_rate || Number.NaN)
  return { values, duration: Number.isFinite(duration) ? duration : 0 }
}

/** `count` bar heights from peaks: the loudest point of each bar's stretch, or between two. */
export function resample(values: Float32Array, count: number, out: Float32Array): void {
  const total = values.length
  for (let bar = 0; bar < count; bar++) {
    const from = (bar * total) / count
    const to = ((bar + 1) * total) / count
    let height = 0
    if (!total) height = 0
    else if (to - from < 1) {
      const middle = Math.min(total - 1, Math.max(0, (from + to) / 2 - 0.5))
      const i = Math.floor(middle)
      const j = Math.min(total - 1, i + 1)
      height =
        (values[i] as number) + ((values[j] as number) - (values[i] as number)) * (middle - i)
    } else
      for (let i = Math.floor(from); i < Math.ceil(to) && i < total; i++)
        height = Math.max(height, values[i] as number)
    out[bar] = height
  }
}

/** A 16-bit value per texel in RG8: the high byte in R. */
class Levels {
  readonly texture: DataTexture
  readonly #bytes: Uint8Array
  #dirty = true

  constructor(width: number) {
    this.#bytes = new Uint8Array(width * 2)
    this.texture = new DataTexture(this.#bytes, width, 1, RGFormat)
    this.texture.magFilter = this.texture.minFilter = NearestFilter
    this.texture.needsUpdate = true
  }

  /** Sets texel `i` to `value` 0..1. */
  set(i: number, value: number): void {
    const word = Math.round(Math.min(1, Math.max(0, value)) * 65535)
    const hi = word >> 8
    const lo = word & 255
    const bytes = this.#bytes
    if (bytes[2 * i] === hi && bytes[2 * i + 1] === lo) return
    bytes[2 * i] = hi
    bytes[2 * i + 1] = lo
    this.#dirty = true
  }

  /** Uploads the changes, if any. */
  flush(): void {
    if (!this.#dirty) return
    this.#dirty = false
    this.texture.needsUpdate = true
  }
}

/**
 * The sound of a page's <audio> or <video> made visible in a decorative element: live bars, a
 * wave or a ring, or the waveform of the whole track with seeking. The player stays the DOM.
 */
const visualizer: Effect<Params> = defineEffect({
  name: 'visualizer',
  params: {
    for: '',
    style: oneOf('bars', 'wave', 'ring', 'peaks'),
    peaks: '',
    bars: 48,
    color: color('#ffffff'),
    accent: color('#ff5a36'),
    gap: 0.3,
    radius: 2,
    range: [-90, -20],
    smooth: 0.75,
    mirror: false,
    seek: true,
    fps: 30,
  },
  on: ':not(img, video, audio, canvas)',
  quality: { low: { fps: 20, bars: 24 }, medium: { fps: 30 } },
  animate: { fps: (ctx) => rates.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, u, element } = ctx
    const style = params.style
    const media = find(element, params.for)
    const live = style !== 'peaks'
    let file: { values: Float32Array; duration: number } | undefined
    if (!live) {
      const url = params.peaks
      if (!url) throw fault('EFFECT_PARAM', 'style "peaks" needs data-dio-peaks', element)
      const response = await fetch(url, { signal })
      if (!response.ok)
        throw new Error(`visualizer: data-dio-peaks "${url}" answered ${response.status}`)
      file = readPeaks(await response.json())
      if (!file) {
        throw fault(
          'EFFECT_PARAM',
          `data-dio-peaks "${url}" is neither audiowaveform JSON nor an array of 0..1`,
          element,
        )
      }
      if (signal.aborted) return
    } else if (local(media) === false) throw corsError(element, media)

    const size = u.size as unknown as V2
    // This pixel in CSS px from the bottom left of the box.
    const pixel = uv().mul(size)
    // CSS px per device pixel: edges are one device pixel soft at any DPR.
    const devicePx = max(fwidth(pixel.x), 1e-4)
    const texels = style === 'wave' ? POINTS : style === 'peaks' ? 1 : MOST
    let levels = new Levels(texels)
    const map = texture(levels.texture)
    ctx.onDispose(() => map.value.dispose())
    /** Level `i` of `count` in the texture, 0..1, from its two bytes. */
    const level = (i: F, count: F | number): F => {
      const texel = map.sample(vec2(i.add(0.5).div(count), 0.5))
      return texel.r
        .mul(255 * 256)
        .add(texel.g.mul(255))
        .div(65535) as unknown as F
    }
    const mirror = u.mirror as unknown as F
    const radius = u.radius as unknown as F
    const gap = u.gap as unknown as F
    const boxHeight = size.y as unknown as F
    const boxWidth = size.x as unknown as F
    /** Coverage of a shape at signed distance `distance` px, soft over one device pixel. */
    const cover = (distance: F): F =>
      clamp(float(0.5).sub(distance.div(devicePx)), 0, 1) as unknown as F

    /**
     * A row of `count` rounded bars over the width, each `rest` px tall at least; returns the
     * coverage and the height share 0..1 the colour ramps over.
     */
    const row = (count: F, texelCount: F | number, rest: F): { alpha: F; heightShare: F } => {
      const step = boxWidth.div(count)
      const i = clamp(floor(pixel.x.div(step)), 0, count.sub(1)) as unknown as F
      const across = pixel.x.sub(i.add(0.5).mul(step))
      const halfWidth = max(step.mul(float(1).sub(gap)).mul(0.5), 0.5)
      const height = clamp(level(i, texelCount).mul(boxHeight), min(rest, boxHeight), boxHeight)
      const halfHeight = height.mul(0.5)
      // Standing on the bottom, or centred when mirrored.
      const centreY = mix(halfHeight, boxHeight.mul(0.5), mirror)
      const corner = min(radius, min(halfWidth, halfHeight)) as unknown as F
      const distance = roundedBox(
        vec2(across, pixel.y.sub(centreY)),
        vec2(halfWidth, halfHeight),
        corner,
      )
      const alpha = cover(distance)
      const heightShare = mix(
        pixel.y.div(boxHeight),
        abs(pixel.y.sub(boxHeight.mul(0.5))).div(boxHeight.mul(0.5)),
        mirror,
      ) as unknown as F
      return { alpha, heightShare }
    }

    let alpha: F
    let tint: Node<'vec3'>
    const played = uniform(0)
    const hover = uniform(-1)
    const count = uniform(1)
    const rest = min(float(DOT), radius.mul(2).max(2))
    if (style === 'bars') {
      const barCount = clamp(floor(u.bars as unknown as F), 8, MOST) as unknown as F
      const bar = row(barCount, MOST, rest as unknown as F)
      alpha = bar.alpha
      tint = mix(u.color, u.accent, smoothstep(0.35, 1, bar.heightShare)) as unknown as Node<'vec3'>
    } else if (style === 'peaks') {
      const bar = row(count as unknown as F, count as unknown as F, float(2))
      alpha = bar.alpha
      // Played in accent, split at the exact position; the stretch to the pointer half way.
      const leftOf = (x: F): F => clamp(x.sub(pixel.x).div(devicePx).add(0.5), 0, 1) as unknown as F
      const playedX = played.mul(boxWidth)
      const done = leftOf(playedX as unknown as F)
      const near = select(
        hover.greaterThanEqual(0),
        leftOf(max(hover, playedX) as unknown as F).sub(
          leftOf(min(hover, playedX) as unknown as F),
        ),
        0,
      )
      tint = mix(mix(u.color, u.accent, near.mul(0.45)), u.accent, done) as unknown as Node<'vec3'>
    } else if (style === 'ring') {
      const barCount = clamp(floor(u.bars as unknown as F), 8, MOST) as unknown as F
      const fromCentre = pixel.sub(size.mul(0.5))
      const outer = min(boxWidth, boxHeight).mul(0.5)
      // The circle the bars stand on, and how far out they may grow.
      const base = outer.mul(mix(0.58, 0.74, mirror))
      const reach = outer
        .sub(base)
        .sub(1)
        .mul(mix(1, 2, mirror))
      const turn = float(Math.PI * 2)
      const sector = turn.div(barCount)
      // From the top, clockwise.
      const angle = atan(fromCentre.x, fromCentre.y)
      const nearest = floor(angle.div(sector).add(0.5))
      const offAxis = angle.sub(nearest.mul(sector))
      const i = nearest.sub(floor(nearest.div(barCount)).mul(barCount))
      // This pixel in the bar's own frame: across it and out along it.
      const distanceOut = length(fromCentre)
      const across = distanceOut.mul(sin(offAxis))
      const along = distanceOut.mul(cos(offAxis))
      const halfWidth = max(base.mul(sector).mul(float(1).sub(gap)).mul(0.5), 0.5)
      const height = clamp(level(i as unknown as F, MOST).mul(reach), min(rest, reach), reach)
      const halfHeight = height.mul(0.5)
      const centre = mix(base.add(halfHeight), base, mirror)
      const corner = min(radius, min(halfWidth, halfHeight)) as unknown as F
      const distance = roundedBox(
        vec2(across, along.sub(centre)),
        vec2(halfWidth, halfHeight),
        corner,
      )
      alpha = cover(distance)
      const heightShare = abs(along.sub(base)).div(max(reach.mul(mix(1, 0.5, mirror)), 1))
      tint = mix(u.color, u.accent, smoothstep(0.3, 1, heightShare)) as unknown as Node<'vec3'>
    } else {
      // The wave: distance to the polyline through the tangent, so the ribbon keeps its width.
      const x = clamp(pixel.x.div(boxWidth), 0, 1).mul(POINTS - 1)
      const left = min(floor(x), POINTS - 2)
      const f = x.sub(left)
      const leftY = level(left as unknown as F, POINTS)
        .mul(2)
        .sub(1)
      const rightY = level(left.add(1) as unknown as F, POINTS)
        .mul(2)
        .sub(1)
      const amplitude = boxHeight.mul(0.5).sub(LINE)
      const y = mix(leftY, rightY, f).mul(amplitude)
      const slope = rightY
        .sub(leftY)
        .mul(amplitude)
        .div(boxWidth.div(POINTS - 1))
      const fromMiddle = pixel.y.sub(boxHeight.mul(0.5))
      const distance = abs(fromMiddle.sub(y)).div(sqrt(slope.mul(slope).add(1)))
      alpha = clamp(
        float(LINE / 2)
          .sub(distance)
          .div(devicePx)
          .add(0.5),
        0,
        1,
      ) as unknown as F
      const heightShare = abs(fromMiddle).div(max(amplitude, 1))
      tint = mix(u.color, u.accent, smoothstep(0.25, 0.9, heightShare)) as unknown as Node<'vec3'>
    }

    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    material.colorNode = tint
    material.opacityNode = alpha.mul(ctx.mask(uv()))
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.frustumCulled = false
    ctx.place(mesh, { replace: true })

    const reduced = (): boolean => ctx.app.stage.reducedMotion.peek()
    const listen = (target: EventTarget, type: string, fn: (e: Event) => void): void =>
      target.addEventListener(type, fn, { signal })
    const redraw = (): void => ctx.invalidate()
    let playing = !media.paused && !media.ended
    let broken: Error | undefined

    if (!live) {
      const data = file as { values: Float32Array; duration: number }
      const bars = new Float32Array(PEAKS)
      let laid = 0
      let shown = Number.NaN
      const duration = (): number =>
        Number.isFinite(media.duration) && media.duration > 0 ? media.duration : data.duration
      const position = (): number => {
        const total = duration()
        return total > 0 ? Math.min(1, Math.max(0, media.currentTime / total)) : 0
      }
      /** Resamples the peaks to as many bars as fit `width` px, when that number changes. */
      const lay = (width: number): void => {
        const barCount = Math.max(1, Math.min(PEAKS, Math.floor(width / STEP)))
        if (barCount === laid) return
        laid = barCount
        resample(data.values, barCount, bars)
        const next = new Levels(barCount)
        for (let i = 0; i < barCount; i++) next.set(i, bars[i] as number)
        next.flush()
        map.value.dispose()
        map.value = next.texture
        levels = next
        count.value = barCount
      }
      const box = (): DOMRect => element.getBoundingClientRect()
      const seek = (clientX: number): void => {
        const total = duration()
        if (!(total > 0)) return
        const rect = box()
        const share = (clientX - rect.left) / (rect.width || 1)
        media.currentTime = Math.min(1, Math.max(0, share)) * total
        redraw()
      }
      const touchable = (): boolean => {
        const action = getComputedStyle(element).touchAction
        return action === 'none' || (action.includes('pan-y') && !action.includes('pan-x'))
      }
      let grab: number | undefined
      let tap: { id: number; x: number; y: number } | undefined
      listen(element, 'pointerdown', (event) => {
        const e = event as PointerEvent
        if (e.button !== 0 || grab !== undefined || !params.seek) return
        if (e.pointerType === 'mouse' || touchable()) {
          grab = e.pointerId
          try {
            element.setPointerCapture(e.pointerId)
          } catch {}
          if (e.pointerType === 'mouse') e.preventDefault()
          seek(e.clientX)
        } else tap = { id: e.pointerId, x: e.clientX, y: e.clientY }
      })
      listen(element, 'pointermove', (event) => {
        const e = event as PointerEvent
        if (e.pointerId === grab) seek(e.clientX)
        else if (
          tap?.id === e.pointerId &&
          Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP
        ) {
          tap = undefined
        }
        if (e.pointerType !== 'mouse' || !params.seek) return
        hover.value = e.clientX - box().left
        redraw()
      })
      const release = (event: Event): void => {
        const e = event as PointerEvent
        if (e.pointerId === grab) grab = undefined
        if (tap?.id !== e.pointerId) return
        if (e.type === 'pointerup') seek(tap.x)
        tap = undefined
      }
      listen(element, 'pointerup', release)
      listen(element, 'pointercancel', release)
      listen(element, 'pointerleave', (event) => {
        if ((event as PointerEvent).pointerType !== 'mouse') return
        hover.value = -1
        redraw()
      })
      listen(element, 'dragstart', (e) => e.preventDefault())
      // Frames only as the position moves half a device pixel or more.
      const moved = (): void => {
        const deviceWidth = box().width * devicePixelRatio
        if (!(Math.abs(position() - shown) * deviceWidth < 0.5)) redraw()
      }
      for (const type of ['timeupdate', 'seeked', 'durationchange', 'loadedmetadata', 'emptied'])
        listen(media, type, moved)
      listen(media, 'playing', () => {
        playing = true
        redraw()
      })
      for (const type of ['pause', 'ended']) {
        listen(media, type, () => {
          playing = false
          moved()
        })
      }
      // While playing, frames as often as the position crosses a device pixel, at most fps.
      rates.set(signal, () => {
        const total = duration()
        if (!playing || !(total > 0)) return 0
        const pixels = (laid * STEP * devicePixelRatio * media.playbackRate) / total
        return Math.min(params.fps, pixels)
      })
      lay(element.getBoundingClientRect().width)
      return (input) => {
        lay(input.width)
        shown = position()
        played.value = shown
      }
    }

    // Live styles.
    // What the sound gives this frame, and what is drawn, easing toward it.
    const target = new Float32Array(style === 'wave' ? POINTS : MOST)
    const current = new Float32Array(target.length)
    let fall: { t: number; from: Float32Array } | undefined
    let analyser: AnalyserNode | undefined
    let rate = 48000
    let bins = new Uint8Array(0)
    let samples = new Uint8Array(0)
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
        node.connect(made)
        signal.addEventListener('abort', () => node.disconnect(made), { once: true })
        rate = graph.sampleRate
        bins = new Uint8Array(made.frequencyBinCount)
        samples = new Uint8Array(made.fftSize)
        analyser = made
      } catch (error) {
        broken = error as Error
      } finally {
        connecting = false
        redraw()
      }
    }
    listen(media, 'play', () => {
      wake()
      void connect()
    })
    listen(media, 'playing', () => {
      playing = true
      fall = undefined
      redraw()
    })
    for (const type of ['pause', 'ended', 'emptied']) {
      listen(media, type, () => {
        if (!playing) return
        playing = false
        fall = { t: 0, from: current.slice() }
        redraw()
      })
    }
    if (playing) void connect()

    rates.set(signal, () => ((playing && analyser) || fall ? params.fps : 0))

    let tuned = ''
    /** Applies `range` and `smooth` to the analyser when they change. */
    const tune = (node: AnalyserNode): void => {
      const [lo, hi] = params.range
      const smooth = Math.min(0.99, Math.max(0, params.smooth))
      const key = `${lo} ${hi} ${smooth}`
      if (key === tuned) return
      tuned = key
      // The analyser throws while its minimum is not below its maximum: set them in an order that
      // never crosses.
      if (lo < hi) {
        if (lo >= node.maxDecibels) {
          node.maxDecibels = hi
          node.minDecibels = lo
        } else {
          node.minDecibels = lo
          node.maxDecibels = hi
        }
      }
      node.smoothingTimeConstant = smooth
    }

    return (input) => {
      if (broken) throw broken
      const dt = Math.min(input.delta, MAX_STEP)
      const levelCount =
        style === 'wave' ? POINTS : Math.min(MOST, Math.max(8, Math.floor(params.bars)))
      // The wave rests on the middle line, the bars at 0.
      const middle = style === 'wave' ? 0.5 : 0
      if (input.reducedMotion) {
        fall = undefined
        for (let i = 0; i < levelCount; i++) {
          const spot =
            style === 'ring' ? Math.abs(1 - (2 * i) / levelCount) : (i + 0.5) / levelCount
          current[i] =
            style === 'wave'
              ? 0.5 + 0.22 * Math.sin((i / (POINTS - 1)) * Math.PI * 4) * taper(i / (POINTS - 1))
              : calm(spot)
        }
      } else if (fall) {
        fall.t += dt
        const remaining = 1 - ease('quartOut', Math.min(1, fall.t / FALL))
        for (let i = 0; i < levelCount; i++) {
          const from = (fall.from[i] as number) - middle
          current[i] = from * remaining + middle
        }
        if (fall.t >= FALL) fall = undefined
      } else if (playing && analyser) {
        tune(analyser)
        if (style === 'wave') {
          analyser.getByteTimeDomainData(samples)
          trace(samples, target)
          for (let i = 0; i < POINTS; i++) {
            // A soft limit keeps loud passages inside the box.
            const value = Math.tanh((target[i] as number) * 1.6) * 0.5 + 0.5
            current[i] = damp(current[i] || 0.5, value, WAVE_HALF_LIFE, dt)
          }
        } else {
          analyser.getByteFrequencyData(bins)
          bands(bins, rate, levelCount, target, style === 'ring')
          // Bars jump up and ease down.
          for (let i = 0; i < levelCount; i++) {
            const value = target[i] as number
            const was = current[i] as number
            current[i] = value >= was ? value : damp(was, value, RELEASE, dt)
          }
        }
      } else current.fill(middle)
      for (let i = 0; i < levelCount; i++) levels.set(i, current[i] as number)
      levels.flush()
      // Reduced motion turned off while playing: start listening.
      if (!input.reducedMotion && playing && !analyser) void connect()
    }
  },
})
export default visualizer
