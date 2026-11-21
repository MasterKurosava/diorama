import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { radii, roundedBox } from '@dioramajs/effects/kit'
import {
  clamp,
  exp,
  fwidth,
  max,
  min,
  positionLocal,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import {
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three/webgpu'

type V2 = Node<'vec2'>
type Params = {
  style: ChoiceParam<'glow' | 'shadow'>
  strength: number
  spread: number
  blur: number
  saturation: number
  fps: number
  ease: number
  resolution: number
}
type Media = HTMLVideoElement | HTMLImageElement

/** Longest reach of the glow past the box, px: also the visibility bleed. */
const REACH = 240
/** Time frames a second while colours settle at fps 0. */
const SETTLE = 10
/** Distance to the new colours at which the flow ends, out of 1: one step of the texture. */
const SETTLED = 1 / 255

/** Time frames a second each phase asks for now. */
const rates = new WeakMap<AbortSignal, () => number>()

/** The video's poster URL, '' without one: an empty attribute would name the page itself. */
const posterOf = (video: HTMLVideoElement): string =>
  video.getAttribute('poster') ? video.poster : ''

/**
 * Resolves once the element has a picture to read, or the phase ends. A video with a poster waits
 * for nothing: its poster stands in until it has a frame.
 */
const loaded = (el: Media, video: boolean, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const ready = video
      ? (el as HTMLVideoElement).readyState >= 2 || !!posterOf(el as HTMLVideoElement)
      : (el as HTMLImageElement).complete && !!el.currentSrc
    if (ready || signal.aborted) return resolve()
    const options = { once: true, signal }
    el.addEventListener(video ? 'loadeddata' : 'load', () => resolve(), options)
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

/**
 * Two box blur passes over an RGB grid, `radius` cells (fractional: the outer cells weigh its
 * fraction). `spare` is scratch space of the grid's size.
 */
function blur(
  rgb: Float32Array,
  cols: number,
  rows: number,
  radius: number,
  spare: Float32Array,
): void {
  const whole = Math.floor(radius)
  const part = radius - whole
  const total = 2 * whole + 1 + 2 * part
  // One pass along rows (`across`) or columns.
  const pass = (from: Float32Array, to: Float32Array, across: boolean): void => {
    const [length, lines] = across ? [cols, rows] : [rows, cols]
    const index = (line: number, i: number) => 3 * (across ? line * cols + i : i * cols + line)
    for (let line = 0; line < lines; line++) {
      for (let i = 0; i < length; i++) {
        for (let channel = 0; channel < 3; channel++) {
          let sum = 0
          for (let offset = -whole - 1; offset <= whole + 1; offset++) {
            const weight = Math.abs(offset) <= whole ? 1 : part
            if (!weight) continue
            const at = Math.min(length - 1, Math.max(0, i + offset))
            sum += weight * (from[index(line, at) + channel] as number)
          }
          to[index(line, i) + channel] = sum / total
        }
      }
    }
  }
  for (let twice = 0; twice < 2; twice++) {
    pass(rgb, spare, true)
    pass(spare, rgb, false)
  }
}

/** Why the glow cannot read a cross-origin source: the runtime's EFFECT_CORS, by name and code. */
function corsError(el: Media, url: string, cause: unknown): Error {
  const message = `EFFECT_CORS: ambient cannot read ${url} (cross-origin without CORS): add crossorigin="anonymous" and serve it with Access-Control-Allow-Origin`
  return Object.assign(new Error(message, { cause }), {
    name: 'EffectError',
    code: 'EFFECT_CORS',
    effect: 'ambient',
    element: el,
  })
}

/**
 * A soft glow around a video or image in the colours of its frame, like YouTube's ambient mode.
 * Colours are read on the CPU from a tiny copy of the frame, at most `fps` times a second while
 * the video plays, and flow into each other. A video without a frame lights in its poster's
 * colours, or not at all. As a `shadow` the light falls below the box instead, like a drop shadow
 * in the picture's colours. The element itself stays DOM.
 */
const ambient: Effect<Params> = defineEffect({
  name: 'ambient',
  params: {
    style: oneOf('glow', 'shadow'),
    strength: 0.5,
    spread: 0.35,
    blur: 0.6,
    saturation: 1.2,
    fps: 10,
    ease: 0.5,
    resolution: 16,
  },
  rebuild: ['resolution'],
  on: 'video, img',
  bleed: REACH,
  presence: 'fade',
  quality: { low: { fps: 4, resolution: 8 }, medium: { fps: 8 } },
  animate: { fps: (ctx) => rates.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, u } = ctx
    const el = ctx.element as Media
    const video = el.localName === 'video' ? (el as HTMLVideoElement) : undefined
    await loaded(el, !!video, signal)
    if (signal.aborted) return

    // A grid `cols` wide in the picture's proportions; the browser shrinks the picture into it.
    const cols = Math.max(2, Math.round(params.resolution))
    // 16:9 while the picture's size is unknown.
    const rowsOf = (width: number, height: number): number =>
      width && height
        ? Math.min(64, Math.max(1, Math.round((cols * height) / width)))
        : Math.round(cols * 0.5625)
    let rows = 0
    let canvas: OffscreenCanvas | HTMLCanvasElement | undefined
    let pen: Pick<CanvasRenderingContext2D, 'clearRect' | 'drawImage' | 'getImageData'> | null =
      null
    // RGB per cell, 0..1: as read, as derived (saturated and blurred), as shown, and scratch.
    let raw = new Float32Array(0)
    let goal = raw
    let now = raw
    let spare = raw
    let colors: DataTexture | undefined
    let first = true
    let calm = false
    /** The grid holds colours to show; without them no glow is drawn. */
    let lit = false
    /** The video has shown a frame since its source was last reset. */
    let framed = false
    let broken: Error | undefined
    const map = texture(new DataTexture(new Uint8Array(4), 1, 1))
    const grid = (rowCount: number): void => {
      rows = rowCount
      const size = cols * rows * 3
      raw = new Float32Array(size)
      goal = new Float32Array(size)
      now = new Float32Array(size)
      spare = new Float32Array(size)
      const next = new DataTexture(new Uint8Array(cols * rows * 4), cols, rows)
      next.colorSpace = SRGBColorSpace
      next.magFilter = next.minFilter = LinearFilter
      next.needsUpdate = true
      map.value.dispose()
      map.value = next
      colors = next
      first = true
    }
    ctx.onDispose(() => map.value.dispose())

    // The frame's colours with the saturation and blur they were derived with.
    let derived = [Number.NaN, Number.NaN]
    const derive = (): void => {
      const saturation = params.saturation
      const saturate = (channel: number, luma: number): number =>
        Math.min(1, Math.max(0, luma + (channel - luma) * saturation))
      for (let i = 0; i < raw.length; i += 3) {
        const [r, g, b] = [raw[i] as number, raw[i + 1] as number, raw[i + 2] as number]
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
        goal[i] = saturate(r, luma)
        goal[i + 1] = saturate(g, luma)
        goal[i + 2] = saturate(b, luma)
      }
      // Blur 1 is three cells.
      blur(goal, cols, rows, Math.max(0, params.blur) * 3, spare)
      derived = [saturation, params.blur]
      calm = false
    }

    /**
     * Shrinks a picture into the canvas and returns its pixels, sizing the grid to them, or
     * nothing if it drew none: then the grid keeps what it holds.
     */
    const read = (
      source: CanvasImageSource,
      width: number,
      height: number,
      url: string,
    ): ArrayLike<number> | undefined => {
      const rowCount = rowsOf(width, height)
      if (!canvas) {
        canvas =
          typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(cols, rowCount)
            : Object.assign(document.createElement('canvas'), { width: cols, height: rowCount })
        pen = canvas.getContext('2d', { willReadFrequently: true }) as typeof pen
      } else if (canvas.height !== rowCount) canvas.height = rowCount
      else pen?.clearRect(0, 0, cols, rowCount)
      let data: ArrayLike<number> = []
      try {
        pen?.drawImage(source, 0, 0, cols, rowCount)
        data = pen?.getImageData(0, 0, cols, rowCount).data ?? []
      } catch (error) {
        // A broken picture: nothing to read this time.
        if ((error as { name?: string }).name === 'SecurityError') throw corsError(el, url, error)
      }
      // Behind a poster Chromium draws no frame until the video plays, whatever its readyState.
      let alpha = 0
      for (let i = 3; i < data.length && !alpha; i += 4) alpha = data[i] as number
      if (!alpha) return undefined
      if (rowCount !== rows) grid(rowCount)
      return data
    }

    const wake = (): void => ctx.invalidate()
    const once = (): void => {
      try {
        take()
      } catch (error) {
        broken = error as Error
      }
      wake()
    }

    // The poster as an image in the video's CORS mode, so it taints the canvas as the video would.
    let started = false
    let poster: HTMLImageElement | undefined
    let posterUrl = ''
    let posterReady = Promise.resolve()
    /** The decoded poster. A new poster URL starts decoding, which reads again when done. */
    const posterImage = (): HTMLImageElement | undefined => {
      const url = video ? posterOf(video) : ''
      if (url === posterUrl) return poster
      posterUrl = url
      poster = undefined
      if (!url) return undefined
      const image = new Image()
      const mode = video?.crossOrigin
      if (mode) image.crossOrigin = mode
      image.src = url
      posterReady = image.decode().then(
        () => {
          if (posterUrl !== url || signal.aborted) return
          poster = image
          if (started && !framed) once()
        },
        () => {},
      )
      return undefined
    }

    let asked = false
    /**
     * Reads again once a playing video presents its first frame, which Chromium decodes behind a
     * poster only after `playing`. A paused one is not asked: that would decode a frame the poster
     * hides.
     */
    const ask = (): void => {
      if (asked || !video?.requestVideoFrameCallback || video.paused) return
      asked = true
      video.requestVideoFrameCallback(() => {
        asked = false
        if (!signal.aborted) once()
      })
    }

    /**
     * Reads the video's frame, else its poster, else leaves no colours: an empty frame is never
     * black. A cross-origin source without CORS throws EFFECT_CORS.
     */
    const take = (): void => {
      let data: ArrayLike<number> | undefined
      if (!video) {
        const image = el as HTMLImageElement
        data = read(image, image.naturalWidth, image.naturalHeight, image.currentSrc)
      } else {
        // A video without a current frame is never drawn.
        if (video.readyState >= 2) {
          data = read(video, video.videoWidth, video.videoHeight, video.currentSrc)
          if (!data) ask()
        }
        if (data) framed = true
        // The last frame stays through a seek or a stall.
        else if (framed) return
        else {
          const image = posterImage()
          if (image) data = read(image, image.naturalWidth, image.naturalHeight, image.src)
        }
      }
      if (!data) {
        lit = false
        calm = true
        return
      }
      // RGBA bytes to RGB 0..1.
      for (let byte = 0, i = 0; i < raw.length; byte += 4) {
        raw[i++] = (data[byte] ?? 0) / 255
        raw[i++] = (data[byte + 1] ?? 0) / 255
        raw[i++] = (data[byte + 2] ?? 0) / 255
      }
      // Colours after none stand at once, like the first.
      if (!lit) first = true
      lit = true
      derive()
    }
    take()
    if (!lit && posterUrl) {
      await posterReady
      if (signal.aborted) return
      take()
    }

    // Inside the box nothing is drawn: over the page the glow never covers the picture.
    const radius = uniform(0)
    const size = u.size as unknown as V2
    const reach = min(u.spread.mul(min(size.x, size.y)), REACH)
    const full = size.add(reach.mul(2))
    // The plane's point in px from the box centre.
    const point = uv().sub(0.5).mul(full)
    // The frame's edges spread outwards: the box maps a little inside the colour grid.
    const gridUv = clamp(point.div(max(size, 1)).mul(0.9).add(0.5), 0, 1)
    // Signed distance in px from a rounded box of half size `half` around `at`.
    const box = (at: V2, half: V2) =>
      roundedBox(at, half, min(radius, min(half.x, half.y)) as unknown as Node<'float'>)
    const fromBox = box(point, size.mul(0.5))
    const outside = clamp(fromBox.div(max(fwidth(fromBox), 1e-4)).add(0.5), 0, 1)
    // A shadow comes from a box 0.3 of the reach lower and smaller than the element, mostly
    // hidden under it, and fades over 0.7 of the reach: it shows below, tapers up the sides and
    // ends inside the plane.
    const shadow = () =>
      box(
        point.add(vec2(0, reach.mul(0.3))),
        size.mul(0.5).sub(vec2(reach.mul(0.25), reach.mul(0.15))),
      ).div(max(reach.mul(0.7), 1e-3))
    // 0 at the light's source, 1 where it has faded out.
    const falloff = clamp(
      params.style === 'shadow' ? shadow() : fromBox.div(max(reach, 1e-3)),
      0,
      1,
    )
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    material.positionNode = vec3(positionLocal.xy.mul(full.div(max(size, 1))), 0)
    material.colorNode = map.sample(vec2(gridUv.x, gridUv.y.oneMinus())).rgb
    material.opacityNode = u.strength.mul(
      smoothstep(0, 1, falloff).oneMinus(),
      exp(falloff.negate()),
      outside,
      u.opacity,
    )
    const glow = new Mesh(new PlaneGeometry(1, 1), material)
    glow.frustumCulled = false
    // Under the copies of other elements, which draw over the glow.
    glow.renderOrder = -1
    glow.visible = lit
    ctx.place(glow)

    let playing = !!video && !video.paused && !video.ended && video.readyState > 2
    let since = 0
    const on = (type: string, handler: () => void): void =>
      el.addEventListener(type, handler, { signal })
    if (video) {
      // A new source: its poster stands in until it has a frame.
      on('emptied', () => {
        framed = false
        playing = false
        once()
      })
      on('playing', () => {
        playing = true
        once()
      })
      for (const type of ['pause', 'ended']) {
        on(type, () => {
          playing = false
          once()
        })
      }
      on('waiting', () => {
        playing = false
      })
      on('loadeddata', once)
      // At `seeked` Chromium may still draw the frame from before the seek: read it again once
      // the new one is presented. If it already is, no callback comes and the first read holds.
      on('seeked', () => {
        once()
        video.requestVideoFrameCallback?.(() => {
          if (!signal.aborted) once()
        })
      })
    } else on('load', once)
    rates.set(signal, () => ((playing && params.fps > 0) || !calm ? params.fps || SETTLE : 0))
    started = true

    let radiusFor = ''
    /** The element's largest corner radius, px, read again when it or the box changes. */
    const restyle = (width: number, height: number): void => {
      const style = getComputedStyle(el)
      const key = `${style.borderRadius}|${width}|${height}`
      if (key === radiusFor) return
      radiusFor = key
      radius.value = Math.max(...radii(el, width, height))
    }

    /** Moves the shown colours towards the goal by a frame and uploads them. */
    const flow = (delta: number, reduced: boolean): void => {
      const step = first
        ? 1
        : 1 - Math.exp((-3 * delta) / Math.max(reduced ? 1 : params.ease, 1e-3))
      first = false
      let far = 0
      for (let i = 0; i < now.length; i++) {
        const value = (now[i] as number) + ((goal[i] as number) - (now[i] as number)) * step
        now[i] = value
        far = Math.max(far, Math.abs((goal[i] as number) - value))
      }
      if (far < SETTLED) {
        now.set(goal)
        calm = true
      }
      const bytes = colors?.image.data as Uint8Array
      for (let i = 0, byte = 0; i < now.length; byte += 4) {
        bytes[byte] = Math.round((now[i++] as number) * 255)
        bytes[byte + 1] = Math.round((now[i++] as number) * 255)
        bytes[byte + 2] = Math.round((now[i++] as number) * 255)
        bytes[byte + 3] = 255
      }
      if (colors) colors.needsUpdate = true
    }

    return (input) => {
      if (broken) throw broken
      restyle(input.width, input.height)
      const reduced = input.reducedMotion
      // While playing: a new reading at most fps times a second, the time frames of the policy.
      // The 8 ms margin keeps a frame that comes a little early from skipping a reading.
      if (playing && !reduced && params.fps > 0) {
        since += input.delta
        if (since >= 1 / params.fps - 0.008) {
          since = 0
          take()
        }
      }
      glow.visible = lit
      if (!lit) return
      if (params.saturation !== derived[0] || params.blur !== derived[1]) derive()
      if (calm) return
      flow(input.delta, reduced)
      // Reduced motion has no time frames: the flow to new colours asks for its own.
      if (reduced && !calm) wake()
    }
  },
})
export default ambient
