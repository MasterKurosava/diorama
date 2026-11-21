import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { ease } from '@dioramajs/effects/kit'
import { mix, step, uniform, vec3, vec4 } from 'three/tsl'
import { type Node, SRGBColorSpace, Texture, VideoTexture } from 'three/webgpu'
import { framing } from './slots'

type Params = {
  src: string
  scrub: ChoiceParam<'off' | 'pointer'>
  duration: number
  delay: number
  from: number
  loop: boolean
}

/** Height of the scrub bar, px. */
const BAR = 3
/** Scrubbing stops this far before the end, s, so the last position never ends the video. */
const TAIL = 0.05

const TYPES: Readonly<Record<string, string>> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
}

/** `<source>` elements for URLs separated by spaces or commas, typed by their extensions. */
export function sources(list: string): HTMLSourceElement[] {
  return list
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((url) => {
      const source = document.createElement('source')
      source.src = url
      const type = TYPES[/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? '']
      if (type) source.type = type
      return source
    })
}

/** :focus-visible, or :focus where the engine does not know it. */
function keyboard(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * A thumbnail plays a short muted video while the pointer rests on it or its link has keyboard
 * focus, crossfading from the image and back. The video loads only then. With `scrub` the pointer's
 * x picks the moment instead of playing. At rest the image is the DOM and nothing is drawn.
 */
const videoHover: Effect<Params> = defineEffect({
  name: 'video-hover',
  params: {
    src: '',
    scrub: oneOf('off', 'pointer'),
    duration: 0.3,
    delay: 0.15,
    from: 0,
    loop: true,
  },
  media: true,
  when: '(hover: hover) and (pointer: fine)',
  reducedMotion: 'off',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u } = ctx
    const img = ctx.element as HTMLImageElement
    ctx.showDom(true)
    if (!params.src.trim()) {
      app.log.warn('video-hover: no src, the image stays as it is', img)
      return
    }
    // The link or button around the image plays the preview too: a card is hovered as a whole.
    const target = (img.closest('a[href], button, [tabindex]') as HTMLElement | null) ?? img
    const video = document.createElement('video')
    video.muted = video.defaultMuted = true
    video.playsInline = true
    video.preload = 'none'
    // In CORS mode a file from another origin without CORS headers fails to load instead of
    // loading into a texture the GPU may not read.
    video.crossOrigin = img.crossOrigin === 'use-credentials' ? 'use-credentials' : 'anonymous'
    const map = new VideoTexture(video)
    map.colorSpace = SRGBColorSpace
    ctx.onDispose(() => {
      map.dispose()
      video.pause()
      video.replaceChildren()
      if (started) video.load()
    })

    const fit = ctx.fit(map, { fit: 'cover', position: framing(img).position })
    const shown = uniform(0)
    const at = uniform(0)
    const scrub = params.scrub === 'pointer'
    ctx.surface.color((color, { uv, box, radius }) => {
      let rgb = fit.sample(uv).rgb as Node<'vec3'>
      if (scrub) {
        // A thin bar along the bottom edge: played white, the rest of the track dimmed.
        const bar = step(box.y.mul(u.size.y), BAR)
        const played = step(box.x, at)
        rgb = mix(rgb, mix(rgb.mul(0.4), vec3(1), played), bar) as Node<'vec3'>
      }
      return vec4(mix(color.rgb, rgb, shown), mix(color.a, radius, shown))
    })

    let hovered = false
    let focused = false
    let started = false
    /** A frame of this run is presented: the crossfade may start. */
    let fresh = false
    let ended = false
    let failed = false
    /** The crossfade, linear 0..1. */
    let crossfade = 0
    let dom = true
    /** The GPU holds a frame of the video. */
    let held = false
    let timer: ReturnType<typeof setTimeout> | undefined
    /** The pointer across the image, 0..1. */
    let pointerX = 0.5
    let pending: number | undefined
    let frame = 0
    const wake = (): void => ctx.invalidate()
    const want = (): boolean => (hovered || focused) && !failed
    const scrubbing = (): boolean => scrub && hovered
    const on = <E extends Event>(el: EventTarget, type: string, handler: (e: E) => void): void =>
      el.addEventListener(type, handler as EventListener, { signal })
    ctx.onDispose(() => clearTimeout(timer))

    const span = (): [number, number] => {
      const duration = video.duration
      const end = Number.isFinite(duration) ? duration : 0
      const from = Math.max(0, params.from)
      return [from < end ? from : 0, end]
    }
    const seek = (time: number): void => {
      if (video.seeking) {
        pending = time
        return
      }
      pending = undefined
      video.currentTime = time
    }
    const seen = (): void => {
      fresh = true
      wake()
    }
    /** The time to show from: the pointer's when scrubbing, else `from`. */
    const restart = (): void => {
      if (video.readyState < 1) return
      const [from, end] = span()
      const time = scrubbing() ? from + pointerX * Math.max(0, end - TAIL - from) : from
      // No seek, no new frame: the one held is already the right one.
      if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) {
        map.needsUpdate = true
        seen()
      } else seek(time)
    }
    const rvfc = typeof video.requestVideoFrameCallback === 'function'
    /** Watches for presented frames while the preview is wanted or shown. */
    const watch = (): void => {
      if (!rvfc || frame) return
      frame = video.requestVideoFrameCallback(() => {
        frame = 0
        if (signal.aborted) return
        seen()
        if (want() || crossfade > 0) watch()
      })
    }
    ctx.onDispose(() => {
      if (frame) video.cancelVideoFrameCallback(frame)
    })
    /** Plays or pauses the video for what is wanted now. */
    const sync = (): void => {
      if (!started || video.readyState < 1) return
      video.loop = params.loop
      if (want() && !ended && !scrubbing()) {
        if (video.paused) video.play().catch(() => {})
      } else if (!video.paused && (scrubbing() || !crossfade)) video.pause()
    }
    const fail = (): void => {
      if (failed) return
      failed = true
      app.log.warn(
        `EFFECT_MEDIA: video-hover: cannot load ${params.src}: check the URL and its type; a file from another origin needs Access-Control-Allow-Origin`,
        img,
      )
      wake()
    }
    const begin = (): void => {
      timer = undefined
      if (!want()) return
      if (!started) {
        started = true
        const list = sources(params.src)
        list.at(-1)?.addEventListener('error', fail, { signal })
        video.append(...list)
        video.preload = 'auto'
        video.load()
      }
      if (!crossfade) {
        fresh = false
        ended = false
        restart()
      }
      watch()
      sync()
      wake()
    }
    /** Hover or focus began: after `delay`, or at once while the preview still shows. */
    const intent = (): void => {
      if (failed) return
      if (crossfade > 0) begin()
      else timer ??= setTimeout(begin, Math.max(0, params.delay) * 1000)
    }
    const changed = (): void => {
      if (!want() && timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (started && scrubbing() && video.readyState >= 1) restart()
      sync()
      wake()
    }
    const point = (e: PointerEvent): void => {
      const rect = img.getBoundingClientRect()
      pointerX = rect.width ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0.5
      at.value = pointerX
    }

    on(video, 'loadedmetadata', () => {
      if (want() || crossfade > 0) restart()
      sync()
    })
    for (const type of ['loadeddata', 'seeked']) {
      on(video, type, () => {
        if (pending !== undefined) return seek(pending)
        // Without frame callbacks the data or the seek is the new frame.
        if (!rvfc && !video.seeking && video.readyState >= 2 && (want() || crossfade > 0)) seen()
      })
    }
    if (!rvfc) on(video, 'timeupdate', () => (want() || crossfade > 0) && seen())
    on(video, 'ended', () => {
      if (scrubbing()) return
      ended = true
      wake()
    })

    on<PointerEvent>(target, 'pointerenter', (e) => {
      if (e.pointerType === 'touch') return
      hovered = true
      point(e)
      intent()
      changed()
    })
    on<PointerEvent>(target, 'pointermove', (e) => {
      if (e.pointerType === 'touch' || !scrub) return
      hovered = true
      point(e)
      if (started && video.readyState >= 1) restart()
      if (crossfade > 0) wake()
    })
    on<PointerEvent>(target, 'pointerleave', (e) => {
      if (e.pointerType === 'touch') return
      hovered = false
      changed()
    })
    on<FocusEvent>(target, 'focusin', (e) => {
      if (!keyboard(e.target as Element)) return
      focused = true
      intent()
      changed()
    })
    on<FocusEvent>(target, 'focusout', (e) => {
      if (e.relatedTarget instanceof Element && target.contains(e.relatedTarget)) return
      focused = false
      changed()
    })
    // Under the pointer already when the effect starts: no pointerenter comes.
    try {
      if (target.matches(':hover')) {
        hovered = true
        intent()
      }
    } catch {}

    return (input): boolean => {
      const goal = want() && fresh && !ended ? 1 : 0
      if (goal && dom) {
        dom = false
        ctx.showDom(false)
        // A frame presented now goes into a fresh texture: one left by an upload before the first
        // frame could be extracted stays black on WebGPU.
        if (!held && video.readyState >= 2) {
          Texture.prototype.dispose.call(map)
          map.needsUpdate = true
        }
        held = true
      }
      if (crossfade !== goal) {
        const step = input.delta / Math.max(params.duration, 1e-3)
        crossfade = goal ? Math.min(1, crossfade + step) : Math.max(0, crossfade - step)
      }
      shown.value = ease('cubicInOut', crossfade)
      const fading = crossfade !== goal || (!rvfc && !video.paused)
      if (!crossfade && !goal) {
        if (!dom) {
          dom = true
          ctx.showDom(true)
        }
        if (!video.paused) video.pause()
        // Faded out: the video frame leaves the GPU. The texture and its nodes stay valid.
        if (held) {
          held = false
          Texture.prototype.dispose.call(map)
        }
      }
      return fading
    }
  },
})
export default videoHover
