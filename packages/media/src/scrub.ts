import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { approach, damp } from '@dioramajs/effects/kit'
import { mix, uniform, vec4 } from 'three/tsl'
import { DataTexture, LinearFilter, SRGBColorSpace, Texture } from 'three/webgpu'
import { cap, shrink } from './bitmap'
import { framing } from './slots'

type Params = {
  by: ChoiceParam<'pin' | 'progress' | 'manual'>
  start: number
  end: number
  position: number
  from: number
  to: 'auto'
  ease: number
  blend: number
  resolution: number
}

/** Requested times closer than this are the same frame: half a frame at 60 fps, s. */
const SAME = 1 / 120
/** The last position stays this far before the end: at the very end some decoders show nothing, s. */
const TAIL = 0.02

/** Copies grow and shrink in steps of this many px on the long side. */
const STEP = 64

/** Resolves once the video knows its duration, or the phase ends; false if it failed to load. */
const metadata = (video: HTMLVideoElement, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (video.readyState >= 1) return resolve(true)
    if (video.error) return resolve(false)
    const options = { once: true, signal }
    video.addEventListener('loadedmetadata', () => resolve(true), options)
    video.addEventListener('error', () => resolve(false), options)
    // A failed <source> fires its error on itself, not on the video.
    video.lastElementChild?.addEventListener('error', () => resolve(false), options)
    signal.addEventListener('abort', () => resolve(false), { once: true })
  })

/** A cross-origin frame without CORS can be drawn into a canvas but not read back or uploaded. */
function readable(bitmap: ImageBitmap): boolean {
  try {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, 1)
        : Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
    const pen = canvas.getContext('2d') as CanvasRenderingContext2D | null
    pen?.drawImage(bitmap, 0, 0, 1, 1)
    pen?.getImageData(0, 0, 1, 1)
    return true
  } catch (error) {
    return (error as { name?: string }).name !== 'SecurityError'
  }
}

/**
 * A `<video>` scrubbed by scroll: its time follows the pin of the sticky section it plays in, both
 * ways, like the product films on Apple's pages. Seeks never queue: while one runs only the latest
 * wanted time waits, so a long GOP stalls instead of piling up. Each decoded frame is copied into
 * one of two textures and crossfades from the one before over the time the frames take to come,
 * at most `blend`, so the picture moves smoothly between slow seeks and stays sharp when they are
 * quick. At rest the video is the DOM; under reduced motion it keeps its poster.
 */
const scrub: Effect<Params> = defineEffect({
  name: 'scrub',
  params: {
    by: oneOf('pin', 'progress', 'manual'),
    start: 0,
    end: 1,
    position: 0,
    from: 0,
    to: 'auto',
    ease: 0.1,
    blend: 0.12,
    resolution: 1920,
  },
  rebuild: ['resolution'],
  on: 'video',
  reducedMotion: 'off',
  quality: { low: { resolution: 960 }, medium: { resolution: 1440 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app } = ctx
    const video = ctx.element as HTMLVideoElement
    ctx.showDom(true)
    const on = (type: string, fn: () => void): void => video.addEventListener(type, fn, { signal })
    // Scroll drives the time: the video never plays.
    video.pause()
    on('play', () => video.pause())
    if (video.preload !== 'auto') video.preload = 'auto'
    if (!(await metadata(video, signal))) {
      if (!signal.aborted)
        app.log.warn(
          `EFFECT_MEDIA: scrub: cannot load ${video.currentSrc || 'the video'}, it stays as it is`,
          video,
        )
      return
    }
    if (signal.aborted) return

    const wake = (): void => ctx.invalidate()
    const longest = cap(ctx, params.resolution)
    // Two frames in two textures: `weight` is the share of slot 1.
    const blank = new DataTexture(new Uint8Array(4), 1, 1)
    blank.needsUpdate = true
    const slots: (Texture | undefined)[] = [undefined, undefined]
    const fits = [ctx.fit(blank, framing(video)), ctx.fit(blank, framing(video))] as const
    const weight = uniform(1)
    let goal = 1
    ctx.surface.color((_color, { uv, radius }) => {
      const color = mix(fits[0].sample(uv), fits[1].sample(uv), weight)
      return vec4(color.rgb, color.a.mul(fits[0].mask(uv), radius))
    })
    ctx.onDispose(() => {
      blank.dispose()
      for (const slot of slots) {
        ;(slot?.image as ImageBitmap | undefined)?.close?.()
        slot?.dispose()
      }
    })

    let shown = false
    let broken: Error | undefined
    /** Driver time the last frame landed at, ms, and how long the fade towards it lasts, s. */
    let landed = Number.NEGATIVE_INFINITY
    let fade = 0
    /** Puts a decoded frame into the less visible slot and fades towards it. */
    const put = (bitmap: ImageBitmap): void => {
      // The fade lasts as long as the frames take to come, up to blend: while seeks keep up with
      // scroll each frame is in full before the next lands, so the picture follows without lag or
      // a double image, and a slow seek after a rest still dissolves.
      const now = app.loop.driver.now()
      fade = Math.min(params.blend, (now - landed) / 1000)
      landed = now
      const slot = shown ? (weight.value < 0.5 ? 1 : 0) : 1
      const old = slots[slot]
      const image = old?.image as ImageBitmap | undefined
      if (old && image?.width === bitmap.width && image.height === bitmap.height) {
        old.image = bitmap
        old.needsUpdate = true
      } else {
        const upload = new Texture(bitmap)
        // Decoded flipped already, so both backends upload it as is.
        upload.flipY = false
        // Like a VideoTexture: no mipmaps to rebuild for every frame.
        upload.generateMipmaps = false
        upload.minFilter = LinearFilter
        upload.colorSpace = SRGBColorSpace
        upload.needsUpdate = true
        fits[slot].set(upload, framing(video))
        slots[slot] = upload
        old?.dispose()
      }
      image?.close?.()
      goal = slot
      if (!shown || fade <= 0) weight.value = slot
      if (!shown) {
        shown = true
        ctx.showDom(false)
      }
      wake()
    }

    /** The box in CSS px, from the last update. */
    let box: [number, number] = [0, 0]
    /**
     * The long side a copy needs to fill the box at the device's pixel ratio: the GPU shrinks it
     * well, a texture sampled smaller than its size would shimmer. In steps, so a resize by a few
     * px keeps the textures.
     */
    const fitted = (width: number, height: number): number => {
      const scale = Math.max(box[0] / width, box[1] / height) * (globalThis.devicePixelRatio || 1)
      if (!(scale > 0)) return longest
      return Math.min(longest, Math.ceil((Math.max(width, height) * scale) / STEP) * STEP)
    }
    let taken = 0
    let applied = 0
    let checked = false
    /** Copies the frame the video shows now. Copies that finish out of order are dropped. */
    const take = (): void => {
      if (video.readyState < 2 || !video.videoWidth || broken) return
      const copy = ++taken
      const width = video.videoWidth
      const height = video.videoHeight
      createImageBitmap(video, shrink(width, height, fitted(width, height))).then(
        (bitmap) => {
          if (signal.aborted || copy < applied) return bitmap.close()
          applied = copy
          if (!checked) {
            checked = true
            if (!readable(bitmap)) {
              bitmap.close()
              broken = Object.assign(
                new Error(
                  `EFFECT_CORS: scrub cannot read ${video.currentSrc} (cross-origin without CORS): add crossorigin="anonymous" and serve it with Access-Control-Allow-Origin`,
                ),
                { name: 'EffectError', code: 'EFFECT_CORS', effect: 'scrub', element: video },
              )
              wake()
              return
            }
          }
          put(bitmap)
        },
        () => {},
      )
    }

    // A presented frame is the one to copy: at `seeked` Chromium may still show the one before.
    const rvfc = typeof video.requestVideoFrameCallback === 'function'
    let frame = 0
    const watch = (): void => {
      frame = video.requestVideoFrameCallback(() => {
        frame = 0
        if (signal.aborted) return
        take()
        watch()
      })
    }
    if (rvfc) {
      watch()
      ctx.onDispose(() => frame && video.cancelVideoFrameCallback(frame))
    }

    /** The time last asked of the video, and the latest one wanted while a seek runs. */
    let asked = video.currentTime
    let pending: number | undefined
    const seek = (seconds: number): void => {
      if (Math.abs(seconds - (pending ?? asked)) < SAME) return
      if (video.seeking) {
        pending = seconds
        return
      }
      pending = undefined
      asked = seconds
      video.currentTime = seconds
    }
    on('seeked', () => {
      if (!rvfc) take()
      if (pending === undefined) return
      const next = pending
      pending = undefined
      if (Math.abs(next - video.currentTime) >= SAME) {
        asked = next
        video.currentTime = next
      }
    })
    // A new source: its frames are copied again from the next seek.
    on('emptied', () => {
      asked = 0
      pending = undefined
    })

    let warned = false
    /** The scrubbed span of the video, s; empty without a duration. */
    const span = (): [number, number] => {
      const duration = video.duration
      const end = params.to === 'auto' ? duration : Math.min(Math.max(0, params.to), duration)
      if (!Number.isFinite(end)) {
        if (!warned) {
          warned = true
          app.log.warn(
            'scrub: the video has no duration (a stream, or a WebM without one): set data-dio-to, or remux the file',
            video,
          )
        }
        return [0, 0]
      }
      return [Math.min(Math.max(0, params.from), end), end]
    }

    let time = -1
    // Still seeking or fading, so the update asks for the next frame.
    let busy = false
    return (input): boolean => {
      if (broken) throw broken
      box = [input.width, input.height]
      const [from, to] = span()
      if (to <= 0) return busy
      let progress = params.position
      if (params.by !== 'manual') {
        const scroll = params.by === 'pin' ? ctx.section().pin : input.progress
        const range = params.end - params.start
        progress = range ? (scroll - params.start) / range : scroll < params.start ? 0 : 1
      }
      const last = Math.max(0, video.duration - TAIL)
      const target = Math.min(last, from + (to - from) * Math.min(1, Math.max(0, progress)))
      time = time < 0 ? target : damp(time, target, params.ease, input.delta, 1e-3)
      // Until the first copy the DOM shows the poster: the first frame away from it starts the copy.
      seek(time)
      const shownWeight = weight.value
      if (shownWeight !== goal) {
        weight.value = approach(shownWeight, goal, fade > 0 ? input.delta / fade : 1)
      }
      busy = time !== target || weight.value !== goal
      return busy
    }
  },
})
export default scrub
