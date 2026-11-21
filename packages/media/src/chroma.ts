import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import {
  clamp,
  dot,
  length,
  max,
  pow,
  select,
  sRGBTransferEOTF,
  sRGBTransferOETF,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { DataTexture, type Node, SRGBColorSpace, Texture, VideoTexture } from 'three/webgpu'
import { framing } from './slots'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type Params = {
  by: ChoiceParam<'color' | 'auto'>
  screen: ColorParam
  similarity: number
  softness: number
  spill: number
  blur: number
  crop: readonly [number, number, number, number]
}

/** How far in from the top corners `auto` reads the screen, out of the frame. */
const CORNER = 0.04

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** The video's poster URL, '' without one: an empty attribute would name the page itself. */
const posterOf = (video: HTMLVideoElement): string => {
  const url = video.getAttribute('poster')
  return url ? new URL(url, document.baseURI).href : ''
}

/** Cb and Cr of an sRGB colour (BT.601, full range, centred on 0). */
const chroma = (rgb: V3): V2 =>
  vec2(dot(rgb, vec3(-0.168736, -0.331264, 0.5)), dot(rgb, vec3(0.5, -0.418688, -0.081312)))

/** Luma of an sRGB colour (BT.601). */
const luma = (rgb: V3): F => dot(rgb, vec3(0.299, 0.587, 0.114))

/**
 * Chroma over luma: the screen's colour in its shadows and in its light alike, while white, grey
 * and black stay far from any key. Plain chroma distance would key a white label off a dark green
 * screen.
 */
const shade = (rgb: V3): V2 => chroma(rgb).div(luma(rgb).add(0.25))

/**
 * A video shot on a green or blue screen, composited over the page with the screen keyed out:
 * a "transparent" product or presenter video in every browser, from one ordinary MP4 or WebM.
 * Keys by the distance of each pixel's chroma over luma from the screen colour, takes the
 * key's hue out of the edges (spill) and averages the key over a few taps (blur). With `auto`
 * the key is read from the frame's top corners every frame. The `<video>` stays the source of
 * truth: the site plays and pauses it; the copy draws its keyed frames while it plays and its
 * keyed poster before it does.
 */
const chromaKey: Effect<Params> = defineEffect({
  name: 'chroma',
  params: {
    by: oneOf('color', 'auto'),
    screen: color('#00b140'),
    similarity: 0.45,
    softness: 0.1,
    spill: 0.5,
    blur: 1,
    crop: [0, 0, 0, 0],
  },
  on: 'video',
  quality: { low: { blur: 0 } },
  setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u } = ctx
    const video = ctx.element as HTMLVideoElement
    if (video.controls || video.querySelector('track')) {
      app.log.warn(
        'chroma: the copy hides the video, its native controls and captions with it: give it buttons and captions of your own',
        video,
      )
    }
    // The runtime keys nothing until the video has a frame: `none` would show the green poster.
    if (video.preload === 'none') video.preload = 'metadata'
    const wake = (): void => ctx.invalidate()
    const blank = new DataTexture(new Uint8Array(4), 1, 1)
    blank.needsUpdate = true
    const map = new VideoTexture(video)
    map.colorSpace = SRGBColorSpace
    let poster: Texture | undefined
    ctx.onDispose(() => {
      blank.dispose()
      map.dispose()
      poster?.dispose()
    })

    const fit = ctx.fit(blank, framing(video))
    // The same picture in texture UV, for the corners `auto` reads.
    const raw = texture(blank)
    raw.mergeable = false
    /** 1 once there is a picture to key, the poster or a frame. */
    const lit = uniform(0)
    const auto = params.by === 'auto'
    ctx.surface.color((_color, { uv, radius }) => {
      const crop = u.crop as unknown as Node<'vec4'>
      const srgb = (at: V2): V3 => sRGBTransferOETF(fit.sample(at).rgb) as unknown as V3
      // The key: the screen param, or the more saturated of the two top corners inside the crop,
      // so a subject reaching into one corner does not darken the key.
      const corner = (x: F): V3 =>
        sRGBTransferOETF(raw.sample(vec2(x, crop.x.add(CORNER).oneMinus())).rgb) as unknown as V3
      let key = sRGBTransferOETF(u.screen.rgb) as unknown as V3
      if (auto) {
        const left = corner(crop.w.add(CORNER))
        const right = corner(crop.y.add(CORNER).oneMinus())
        key = select(
          length(shade(left)).greaterThan(length(shade(right))),
          left,
          right,
        ) as unknown as V3
      }
      const keyChroma = chroma(key)
      const hue = shade(key)
      // Relative to the key's own saturation: a dim or a blue screen keys like a bright green one.
      const reach = max(length(hue), 1e-3)
      const far = (rgb: V3): F => length(shade(rgb).sub(hue)).div(reach)
      const sample = fit.sample(uv)
      const rgb = sRGBTransferOETF(sample.rgb) as unknown as V3
      // Distance averaged with four diagonal taps `blur` px away: smoother, less noisy edges.
      const tap = vec2(u.blur).div(max(u.size as unknown as V2, 1))
      const distance = far(rgb)
        .add(far(srgb(uv.add(tap))))
        .add(far(srgb(uv.sub(tap))))
        .add(far(srgb(uv.add(vec2(tap.x, tap.y.negate())))))
        .add(far(srgb(uv.add(vec2(tap.x.negate(), tap.y)))))
        .div(5)
      const base = distance.sub(u.similarity)
      const alpha = pow(clamp(base.div(max(u.softness, 1e-4)), 0, 1), 1.5)
      // Spill: the screen's hue leaves the pixel's chroma, `spill` of it in the subject and all of
      // it in the see-through edge; brightness stays, and hues away from the screen's are untouched.
      const keyDirection = keyChroma.div(max(length(keyChroma), 1e-4))
      const pixelChroma = chroma(rgb)
      const removed = max(dot(pixelChroma, keyDirection), 0).mul(
        clamp(u.spill.add(alpha.oneMinus()), 0, 1),
      )
      const cleaned = pixelChroma.sub(keyDirection.mul(removed))
      // Back from luma and chroma to sRGB (BT.601).
      const pixelLuma = luma(rgb)
      const out = vec3(
        pixelLuma.add(cleaned.y.mul(1.402)),
        pixelLuma.sub(cleaned.x.mul(0.344136)).sub(cleaned.y.mul(0.714136)),
        pixelLuma.add(cleaned.x.mul(1.772)),
      )
      // The crop, top right bottom left like CSS, cuts the frame's edges: stands, the screen's end.
      const frameUv = fit.uv(uv)
      const inside = step(crop.w, frameUv.x).mul(
        step(frameUv.x, crop.y.oneMinus()),
        step(crop.z, frameUv.y),
        step(frameUv.y, crop.x.oneMinus()),
      )
      return vec4(
        sRGBTransferEOTF(clamp(out, 0, 1)) as unknown as V3,
        sample.a.mul(alpha, inside, fit.mask(uv), radius, lit),
      )
    })

    /** The site's poster shows until the video plays or seeks, as the browser shows it. */
    let fresh = true
    let source: Texture = blank
    const show = (next: Texture): void => {
      if (next === source) return
      source = next
      fit.set(next, framing(video))
      raw.value = next
      lit.value = next === blank ? 0 : 1
    }
    const url = posterOf(video)
    /** A poster is on its way: until it is in, a fresh video shows nothing rather than green. */
    let awaited = !!url
    const refresh = (): void => {
      // A frame shown stays through a seek or a stall, when readyState drops for a moment.
      if ((video.readyState >= 2 || source === map) && (!fresh || !awaited)) show(map)
      else show(poster ?? blank)
      wake()
    }

    if (url) {
      const image = new Image()
      if (video.crossOrigin) image.crossOrigin = video.crossOrigin
      image.src = url
      image.decode().then(
        () => {
          if (signal.aborted) return
          poster = new Texture(image)
          poster.colorSpace = SRGBColorSpace
          poster.needsUpdate = true
          refresh()
        },
        () => {
          if (signal.aborted) return
          awaited = false
          app.log.warn(`chroma: the poster ${url} did not load`, video)
          refresh()
        },
      )
    }

    const on = (type: string, handler: () => void): void =>
      video.addEventListener(type, handler, { signal })
    const away = (): void => {
      fresh = false
      refresh()
    }
    on('playing', away)
    on('seeked', away)
    on('loadeddata', refresh)
    on('emptied', () => {
      fresh = true
      show(blank)
      refresh()
    })
    // Frames while it plays: one per presented frame, at the video's own rate.
    const rvfc = typeof video.requestVideoFrameCallback === 'function'
    let frame = 0
    // Without frame callbacks a playing video draws every frame.
    let playing = false
    if (rvfc) {
      const watch = (): void => {
        frame = video.requestVideoFrameCallback(() => {
          frame = 0
          if (signal.aborted) return
          if (fresh && video.currentTime > 0) fresh = false
          refresh()
          watch()
        })
      }
      watch()
      ctx.onDispose(() => frame && video.cancelVideoFrameCallback(frame))
    } else {
      const sync = (): void => {
        playing = !video.paused
        wake()
      }
      on('play', sync)
      on('pause', sync)
      on('timeupdate', () => {
        if (fresh && video.currentTime > 0) away()
      })
    }
    if (video.currentTime > 0 || !video.paused) fresh = false
    refresh()
    return (): boolean => playing
  },
})
export default chromaKey
