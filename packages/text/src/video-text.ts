import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, ease } from '@dioramajs/effects/kit'
import {
  clamp,
  max,
  mix,
  positionGeometry,
  sRGBTransferEOTF,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  CanvasTexture,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
  Vector4,
  VideoTexture,
} from 'three/webgpu'
import { fonts, type Raster, raster, unsupported } from './raster'

type Fit = 'cover' | 'contain' | 'fill'
type Params = {
  src: string
  fit: ChoiceParam<Fit>
  fps: number
  loop: boolean
  dim: number
}

/** Length of the change from the text's own colour to the picture, s. */
const INTRO = 0.6
/** Time frames a second while the picture fades in. */
const SMOOTH = 60
/** Milliseconds after a change of the text, its width or the fonts before it is laid out again. */
const RELAYOUT_DELAY = 150
/** A paused video may present no frame: the one it holds is taken after this many ms. */
const PAUSED_FRAME_DELAY = 300

const VIDEO = /\.(mp4|m4v|webm|mov|ogv)(?:[?#]|$)/i
const TYPES: Readonly<Record<string, string>> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
}

/** Time frames a second each phase asks for. */
const rates = new WeakMap<AbortSignal, () => number>()

/**
 * The letters of a headline are a window onto a video or a picture: it plays inside the glyphs,
 * framed over the text's own bounds, and the page shows around them. The DOM text stays for
 * screen readers, search and selection; the copy covers it only while drawn.
 */
const videoText: Effect<Params> = defineEffect({
  name: 'video-text',
  params: {
    src: '',
    fit: oneOf('cover', 'contain', 'fill'),
    fps: 30,
    loop: true,
    dim: 0,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  quality: { low: { fps: 24 } },
  animate: { fps: (ctx) => rates.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, signal, app } = ctx
    ctx.showDom(true)
    const src = params.src.trim()
    const reason = src ? (unsupported(element) ?? (await fonts(element))) : 'a heading without src'
    if (signal.aborted) return
    if (reason) {
      if (DEV)
        app.log.warn(`video-text: ${reason} cannot be drawn, the text stays as it is`, element)
      return
    }
    // The device px per CSS px of the raster: a tier change rebuilds with the new one.
    const ratio = ctx.quality === 'low' ? 1 : 2
    let layout = raster(element, 'line', ratio)
    if (!layout) return

    const urls = src.split(/[\s,]+/).filter(Boolean)
    const moving = urls.some((url) => VIDEO.test(url))
    let video: HTMLVideoElement | undefined
    let map: Texture
    if (moving) {
      const player = videoOf(urls)
      video = player
      map = new VideoTexture(player)
      map.colorSpace = SRGBColorSpace
      ctx.onDispose(() => {
        map.dispose()
        player.pause()
        player.replaceChildren()
        player.load()
      })
    } else {
      try {
        map = await ctx.texture(urls[0] as string)
      } catch (error) {
        app.log.warn(`EFFECT_MEDIA: video-text: cannot load ${src}`, error)
        return
      }
      if (signal.aborted) return
    }

    // A quad over the raster's frame: the glyphs in the text's own colour, turning into the
    // picture framed by `crop` as `shown` goes to 1.
    // The canvas in box px, and the picture's frame over it.
    const frame = uniform(new Vector4(...layout.frame))
    const crop = uniform(new Vector4(1, 1, 0, 0))
    // 0 shows the text in its own colour, 1 the picture.
    const shown = uniform(0)
    const frameNode = frame as unknown as Node<'vec4'>
    const cropNode = crop as unknown as Node<'vec4'>
    const corner = positionGeometry.xy.add(0.5)
    const x = frameNode.x.add(corner.x.mul(frameNode.z))
    const y = frameNode.y.add(corner.y.oneMinus().mul(frameNode.w))
    const half = u.size.mul(0.5)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(x.sub(half.x), half.y.sub(y), 0)
    const boxUV = varying(vec2(x.div(u.size.x), y.div(u.size.y).oneMinus()))
    const glyphs = texture(atlas(layout), uv())
    const pictureUV = uv().mul(cropNode.xy).add(cropNode.zw)
    const picture = texture(map, clamp(pictureUV, 0, 1))
    // contain leaves bands of the frame without picture: the letters are empty there.
    const inside = step(0, pictureUV.x).mul(
      step(pictureUV.x, 1),
      step(0, pictureUV.y),
      step(pictureUV.y, 1),
    )
    const ink = sRGBTransferEOTF(glyphs.rgb.div(max(glyphs.a, 1e-4))) as Node<'vec3'>
    const rgb = mix(ink, picture.rgb.mul(u.dim.oneMinus()), shown)
    const alpha = glyphs.a.mul(mix(1, inside, shown), ctx.mask(boxUV.clamp(0, 1)))
    material.colorNode = vec4(rgb, alpha)
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    // The vertices are placed by the shader, away from the unit plane the bounds are made of.
    mesh.frustumCulled = false
    ctx.onDispose(() => (glyphs.value as Texture).dispose())
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const use = (next: Raster): void => {
      const old = glyphs.value as Texture
      glyphs.value = atlas(next)
      old.dispose()
      frame.value.set(...next.frame)
      layout = next
    }
    // Raster again shortly after the text, its width or the loaded fonts change.
    const relayout = async (): Promise<void> => {
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (!next) return
      use(next)
      ctx.invalidate()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void relayout()
      }, RELAYOUT_DELAY)
    }
    ctx.onDispose(() => clearTimeout(timer))
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

    /** The picture has something to show. */
    let ready = !video
    // The fade from the text's colour to the picture, 0..1.
    let intro = 0
    let playing = false
    let visible = true
    const calm = matchMedia('(prefers-reduced-motion: reduce)')
    const wake = (): void => ctx.invalidate()
    /** Plays while on screen, in a visible tab, with motion allowed and fps above 0. */
    const sync = (): void => {
      if (!video) return
      video.loop = params.loop
      const go = visible && !document.hidden && !calm.matches && params.fps > 0
      if (go && video.paused && !(video.ended && !params.loop)) video.play().catch(() => {})
      else if (!go && !video.paused) video.pause()
    }
    if (video) {
      const player = video
      const on = (type: string, listener: () => void): void =>
        player.addEventListener(type, listener, { signal })
      const show = (): void => {
        if (signal.aborted || player.readyState < 2) return
        // The first frame goes into a texture made for it: one made from an earlier, failed
        // upload keeps the letters black on WebGPU.
        if (!ready) Texture.prototype.dispose.call(map)
        ready = true
        map.needsUpdate = true
        wake()
      }
      // The frame is ready for the GPU once presented: at `loadeddata` WebGPU may not extract it
      // yet. A paused video may present none, so the frame it holds is taken a little later.
      let timer: ReturnType<typeof setTimeout> | undefined
      const presented = (): void => {
        if (player.seeking) return
        if (typeof player.requestVideoFrameCallback !== 'function') {
          show()
          return
        }
        player.requestVideoFrameCallback(show)
        clearTimeout(timer)
        if (player.paused) timer = setTimeout(show, PAUSED_FRAME_DELAY)
      }
      ctx.onDispose(() => clearTimeout(timer))
      on('loadeddata', presented)
      on('seeked', presented)
      on('playing', () => {
        playing = true
        wake()
      })
      for (const type of ['pause', 'ended', 'waiting', 'emptied']) on(type, () => (playing = false))
      player.lastElementChild?.addEventListener(
        'error',
        () => app.log.warn(`EFFECT_MEDIA: video-text: cannot load ${src}`, element),
        { signal },
      )
      calm.addEventListener?.(
        'change',
        () => {
          // Reduced motion shows the first frame and holds it.
          if (calm.matches && player.readyState >= 1) player.currentTime = 0
          sync()
        },
        { signal } as AddEventListenerOptions,
      )
      document.addEventListener('visibilitychange', sync, { signal })
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true
          sync()
        })
        io.observe(element)
        ctx.onDispose(() => io.disconnect())
      }
      player.load()
      sync()
    }
    rates.set(signal, () =>
      ready && intro < 1 ? SMOOTH : playing && !calm.matches ? Math.max(0, params.fps) : 0,
    )

    let dom = true
    return (input) => {
      const frameWidth = layout?.frame[2] ?? 0
      const frameHeight = layout?.frame[3] ?? 0
      if (video) {
        video.loop = params.loop
        const [width, height] = [video.videoWidth, video.videoHeight]
        framed(params.fit, width, height, frameWidth, frameHeight, crop.value)
      } else {
        const image = map.image as { width?: number; height?: number } | undefined
        const [width, height] = [image?.width ?? 0, image?.height ?? 0]
        framed(params.fit, width, height, frameWidth, frameHeight, crop.value)
      }
      if (!ready) return
      if (dom) {
        dom = false
        ctx.showDom(false)
      }
      if (intro < 1) intro = Math.min(1, intro + input.delta / INTRO)
      shown.value = ease('cubicInOut', intro)
    }
  },
})
export default videoText

/**
 * object-fit of a picture of `imageWidth` by `imageHeight` in a `width` by `height` frame as
 * (scale u, scale v, offset u, offset v) of the frame's UV.
 */
export function framed(
  fit: Fit,
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  out: Vector4,
): Vector4 {
  const scale =
    !imageWidth || !imageHeight || !width || !height || fit === 'fill'
      ? 0
      : fit === 'cover'
        ? Math.max(width / imageWidth, height / imageHeight)
        : Math.min(width / imageWidth, height / imageHeight)
  const x = scale ? width / (imageWidth * scale) : 1
  const y = scale ? height / (imageHeight * scale) : 1
  return out.set(x, y, (1 - x) / 2, (1 - y) / 2)
}

/** A muted inline video with a source per url. */
function videoOf(urls: readonly string[]): HTMLVideoElement {
  const video = document.createElement('video')
  video.muted = video.defaultMuted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  for (const url of urls) {
    const source = document.createElement('source')
    source.src = url
    const type = TYPES[/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? '']
    if (type) source.type = type
    video.append(source)
  }
  return video
}

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
function atlas(layout: Raster): CanvasTexture {
  const map = new CanvasTexture(layout.canvas)
  map.premultiplyAlpha = true
  return map
}
