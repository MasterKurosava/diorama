import type { Off } from '@dioramajs/core'
import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  Fit,
  FitOptions,
  Layer,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, ease, flags } from '@dioramajs/effects/kit'
import { image } from '@dioramajs/effects/runtime'
import { mix, uniform, uv } from 'three/tsl'
import {
  Color,
  ConstantColorFactor,
  CustomBlending,
  DataTexture,
  DstAlphaFactor,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  OneFactor,
  OneMinusDstAlphaFactor,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector4,
  ZeroFactor,
} from 'three/webgpu'
import { hold, Pointers, source, View } from './inspect'
import { framing, leases } from './slots'

type V2 = Node<'vec2'>
type V4 = Node<'vec4'>
type Motion = 'lift' | 'fly' | 'zoom' | 'flip' | 'fade'
type Params = {
  index: number
  items: string
  motion: ChoiceParam<Motion>
  margin: number
  zoom: number
  duration: number
  backdrop: ColorParam
  dim: number
  loop: boolean
  swipe: boolean
  close: string
  controls: string
  labels: string
  resolution: number
}

/** Gestures that close, and parts of the dialog shown. */
const CLOSE = ['esc', 'backdrop', 'swipe', 'scroll', 'button'] as const
const CONTROLS = ['arrows', 'counter', 'caption', 'close'] as const
type Closer = (typeof CLOSE)[number]
type Control = (typeof CONTROLS)[number]

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Space between two pictures while paging, px. */
const GAP = 32
/** Fades under reduced motion, s. */
const CALM = 0.15
/** The large picture fades in after the flight, and out before the flight back, s. */
const CROSS = 0.2
const OUT = 0.12
/** Time constant of paging and of a picture settling back after a drag, s. */
const SLIDE = 0.09
/** Time constant of the open box following the size of a large picture that just came in, s. */
const RESIZE = 0.08
/** Share of `duration` a picture takes to fade with a scale where its preview is off screen. */
const DISSOLVE = 0.6
/**
 * Scroll of the page that closes the viewer, px, counted from the first scroll that starts after
 * the picture lands and the page stood still this long, ms: the tail of a smooth scroll (focus on
 * a link far down, then Enter) never closes it.
 */
const SCROLL = 40
const QUIET = 200
/** Pointer travel that still counts as a tap, px, and the gap of a double tap, ms. */
const TAP = 10
const DOUBLE = 300
/** A fling past this speed pages or closes, px/s; a drag down past this closes, px. */
const FLICK = 500
const DROP = 120
/** A drag pages once it covers this share of the viewport width. */
const SWIPE = 0.2
/**
 * renderOrder of the backdrop, which lives in the scene itself: above the copies of the page
 * (level 0) and of level 1 (from 1e6), under the open picture at level 2 and the band under it
 * (from 1.6e6). In a group of the layer it would rise with the pose when the image is the element.
 */
const BACKDROP = 1.5e6

const unit = (value: number): number => Math.min(1, Math.max(0, value))

/** The sRGB transfer, 0..1: an encoded value to linear light, and back. */
const linear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const encoded = (value: number): number =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
/** Tones, sRGB, where the copies under the backdrop match the page exactly (see `veil`). */
const TONES = [0.125, 0.81] as const

/**
 * How the backdrop dims one channel of what the canvas drew under it. The browser lays the
 * canvas over the page in sRGB, so there the page turns into `(1 - a) * page + a * b` for a
 * backdrop channel `b` (sRGB) at opacity `a`. The canvas blends in linear light, where a pass can
 * only scale and add: a channel `c` turns into `c * gain + add`, the line through that sRGB mix
 * at two tones. The darkest tones stay off by at most 4 levels of 255 at opacity 0.92, 13 at 0.5.
 */
export function veil(a: number, b: number): [gain: number, add: number] {
  const [dark, light] = TONES
  // What the browser shows for a page tone under the backdrop, in linear light.
  const mixed = (tone: number): number => linear((1 - a) * tone + a * b)
  const darkLinear = linear(dark)
  const gain = unit((mixed(light) - mixed(dark)) / (linear(light) - darkLinear))
  return [gain, Math.max(0, mixed(dark) - gain * darkLinear)]
}

/** Flight lift at mid-flight: towards the viewer, up, tipped back and leaning into the move. */
const LIFT = { z: 140, y: 36, tip: 0.28, lean: 0.07 }
/** How far the other pictures sink back while one is open, px. */
const RECEDE = 260

/** Offsets and turns of a flying picture as seen, px and radians, on top of its box. */
interface Bend {
  y: number
  z: number
  rx: number
  ry: number
  rz: number
}
const FLAT: Readonly<Bend> = { y: 0, z: 0, rx: 0, ry: 0, rz: 0 }
/**
 * A pose blends its rotation from the element's by slerp, the short way, so the angle it aims
 * for stays under half a turn on each axis. Near the ends of a flight the turn shown lags a little.
 */
const CAP = { rx: LIFT.tip * 6, ry: 3.1, rz: LIFT.lean * 6 }
/** The angle a pose at `weight` aims for so that it shows `angle`. */
const aim = (angle: number, weight: number, cap: number): number =>
  weight > 1e-4 ? Math.max(-cap, Math.min(cap, angle / weight)) : 0

// The dialog: one per document, made at the first opening, removed with the last instance.

interface Viewer {
  readonly dialog: HTMLDialogElement
  readonly close: HTMLButtonElement
  readonly prev: HTMLButtonElement
  readonly next: HTMLButtonElement
  readonly counter: HTMLElement
  readonly caption: HTMLElement
  readonly live: HTMLElement
}

const PAGE_CSS =
  'dialog.dio-lightbox{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:none;overflow:hidden;touch-action:none;outline:none;color:#fff;user-select:none;-webkit-user-select:none}dialog.dio-lightbox::backdrop{background:none}'
const VIEW_CSS =
  ':host{position:absolute;inset:0;font:15px/1.4 system-ui,sans-serif}button{position:absolute;display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:rgb(0 0 0/.4);color:inherit;cursor:pointer}button:focus-visible{outline:2px solid currentColor;outline-offset:2px}[hidden]{display:none}button:disabled{opacity:.35;cursor:default}svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}[part=close]{top:12px;right:12px}[part=prev],[part=next]{top:calc(50% - 22px)}[part=prev]{left:12px}[part=next]{right:12px}p{position:absolute;margin:0;text-shadow:0 1px 3px rgb(0 0 0/.6)}[part=counter]{top:12px;left:16px;line-height:44px;font-variant-numeric:tabular-nums}[part=caption]{left:72px;right:72px;bottom:16px;text-align:center}.live{width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}'
const icon = (d: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`

let viewer: Viewer | undefined
let users = 0
let styled = false
/** Shuts the open viewer of the page, whichever instance owns it. */
let opened: ((now?: boolean) => void) | undefined

/** Adds a stylesheet to a document or a shadow root: a constructed one where it can. */
function adopt(root: Document | ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  } catch {
    const style = document.createElement('style')
    style.textContent = css
    ;(root instanceof Document ? root.head : root).append(style)
  }
}

function makeViewer(): Viewer {
  const dialog = document.createElement('dialog')
  dialog.className = 'dio-lightbox'
  // Takes focus itself when the close button is hidden.
  dialog.tabIndex = -1
  const host = document.createElement('div')
  dialog.append(host)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML =
    `<button part="close" type="button">${icon('M6 6l12 12M18 6 6 18')}</button>` +
    `<button part="prev" type="button">${icon('M15 5l-7 7 7 7')}</button>` +
    `<button part="next" type="button">${icon('M9 5l7 7-7 7')}</button>` +
    '<p part="counter" aria-hidden="true"></p><p part="caption"></p>' +
    '<p class="live" aria-live="polite"></p>'
  adopt(root, VIEW_CSS)
  if (!styled) adopt(document, PAGE_CSS)
  styled = true
  const part = <T extends HTMLElement>(name: string): T => root.querySelector(`[part=${name}]`) as T
  return {
    dialog,
    close: part('close'),
    prev: part('prev'),
    next: part('next'),
    counter: part('counter'),
    caption: part('caption'),
    live: root.querySelector('.live') as HTMLElement,
  }
}

// Geometry

/** Where a picture lies on screen: centre and size in viewport px. */
interface Place {
  x: number
  y: number
  w: number
  h: number
}

/**
 * (scale u, scale v, offset u, offset v) of a box's UV that frames a picture in a `boxWidth` x
 * `boxHeight` box like object-fit: cover at `position`, or stretched like fill.
 */
function crop(
  texture: Texture | undefined,
  boxWidth: number,
  boxHeight: number,
  style: FitOptions,
  out: Vector4,
): void {
  const { width = 0, height = 0 } =
    (texture?.image as { width?: number; height?: number } | undefined) ?? {}
  if (style.fit === 'fill' || !width || !height || !boxWidth || !boxHeight) {
    out.set(1, 1, 0, 0)
    return
  }
  const [positionX, positionY] = style.position ?? [0.5, 0.5]
  const scale = Math.max(boxWidth / width, boxHeight / height)
  const scaleU = boxWidth / (width * scale)
  const scaleV = boxHeight / (height * scale)
  out.set(scaleU, scaleV, (1 - scaleU) * positionX, (1 - scaleV) * (1 - positionY))
}

/** A picture the effect draws itself in the overlay: the large one, or the preview until it comes. */
interface Plane {
  readonly mesh: Mesh
  readonly lo: Fit
  readonly hi: Fit
  /** Crops of the preview and of the large picture. */
  readonly crops: readonly [Vector4, Vector4]
  /** (share of the large picture, alpha). */
  readonly look: Vector2
  /** Item shown, -1 for none. */
  item: number
  /** The large picture in, 0..1. */
  fade: number
}

const COVER: FitOptions = { fit: 'cover' }

/**
 * A full-screen viewer: a click flies the image's copy out of the grid to the center, where it
 * pages, zooms and loads in high resolution, then flies back. Links keep working without WebGL.
 */
const lightbox: Effect<Params> = defineEffect({
  name: 'lightbox',
  params: {
    index: -1,
    items: 'img',
    motion: oneOf('lift', 'fly', 'zoom', 'flip', 'fade'),
    margin: 24,
    zoom: 3,
    duration: 0.45,
    backdrop: color('#0b0b0c'),
    dim: 0.92,
    loop: false,
    swipe: true,
    close: 'esc backdrop swipe scroll button',
    controls: 'arrows counter caption close',
    labels: 'Close|Previous|Next|{i} / {n}|Image viewer',
    resolution: 4096,
  },
  rebuild: ['resolution'],
  quality: { low: { resolution: 2048 }, medium: { resolution: 3072 } },
  // The viewer belongs to its gallery: removed mid flight, it closes instead of flying on.
  burst: false,
  setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u, render } = ctx
    const el = ctx.element as HTMLElement
    const single = el.localName === 'img'
    // One image is its own item; its copy is the built-in image, as a child's would be.
    if (single) ctx.attach(el, image)
    const list: readonly Layer[] = single ? [ctx.layer] : ctx.layers(params.items)
    const imgOf = (item: number): HTMLImageElement | undefined =>
      list[item]?.element as HTMLImageElement | undefined
    /** What the keyboard reaches for an item, and where focus returns. */
    const controlOf = (img: Element): HTMLElement | undefined => {
      const control = img.closest<HTMLElement>('a[href], button')
      if (control && (single || el.contains(control))) return control
      return (img as HTMLElement).tabIndex >= 0 ? (img as HTMLElement) : undefined
    }
    const [closeLabel, prevLabel, nextLabel, counterLabel, dialogLabel] = params.labels.split('|')
    // The switch lists, read again when they change. Escape always closes a modal dialog.
    let switches:
      | { key: string; close: ReadonlySet<Closer>; controls: ReadonlySet<Control> }
      | undefined
    let unknownNoted = false
    let escNoted = false
    const lists = (): NonNullable<typeof switches> => {
      const key = `${params.close}\n${params.controls}`
      if (switches?.key === key) return switches
      const close = flags(params.close, CLOSE)
      const controls = flags(params.controls, CONTROLS)
      const unknown = [...close.unknown, ...controls.unknown]
      if (DEV && unknown.length && !unknownNoted) {
        unknownNoted = true
        app.log.warn(
          `lightbox: unknown names left out: ${unknown.join(', ')} (close takes ${CLOSE.join(', ')}; controls ${CONTROLS.join(', ')})`,
          el,
        )
      }
      if (DEV && !close.on.has('esc') && !escNoted) {
        escNoted = true
        app.log.warn('lightbox: Escape always closes the viewer, a modal dialog', el)
      }
      switches = { key, close: close.on, controls: controls.on }
      return switches
    }
    const closes = (name: Closer): boolean => lists().close.has(name)
    const zoomable = (): boolean => params.zoom > 0
    lists()
    const assets = !!app.assets
    const pictures = assets ? hold(ctx, params.resolution) : undefined
    const previews = assets ? leases(ctx, (img: HTMLImageElement) => img) : undefined
    users++
    ctx.onDispose(() => {
      if (--users || !viewer) return
      viewer.dialog.remove()
      viewer = undefined
    })

    // The backdrop, in the scene itself (see BACKDROP), in two passes so that it dims the copies
    // as the browser dims the page: the first takes what the canvas drew to `colour * gain +
    // add` (veil) and leaves it clear where it was, the second lays the backdrop at its opacity
    // only where the canvas is clear.
    const blank = new DataTexture(new Uint8Array(4), 1, 1)
    blank.colorSpace = SRGBColorSpace
    blank.needsUpdate = true
    const dimmed = uniform(0)
    const added = new Color()
    const pass = (): MeshBasicNodeMaterial => {
      const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      material.blending = CustomBlending
      return material
    }
    const veiling = pass()
    veiling.colorNode = uniform(added)
    veiling.blendSrc = DstAlphaFactor
    veiling.blendDst = ConstantColorFactor
    veiling.blendSrcAlpha = ZeroFactor
    veiling.blendDstAlpha = OneFactor
    const covering = pass()
    covering.colorNode = u.backdrop.mul(dimmed)
    covering.opacityNode = dimmed
    covering.blendSrc = covering.blendSrcAlpha = OneMinusDstAlphaFactor
    covering.blendDst = covering.blendDstAlpha = OneFactor
    const quad = new PlaneGeometry(1, 1)
    const backdrop = new Group()
    backdrop.renderOrder = BACKDROP
    backdrop.visible = false
    for (const [order, material] of [veiling, covering].entries()) {
      const mesh = new Mesh(quad, material)
      mesh.frustumCulled = false
      mesh.renderOrder = order
      backdrop.add(mesh)
    }
    render.scene.add(backdrop)
    ctx.onDispose(() => {
      backdrop.removeFromParent()
      quad.dispose()
      veiling.dispose()
      covering.dispose()
      blank.dispose()
    })

    // Two planes in the overlay: the large picture over a flying copy, or the whole picture where
    // nothing flies (reduced motion, a preview off screen). The second one pages in.
    const plane = (): Plane => {
      const lo = ctx.fit(blank, { fit: 'fill' })
      const hi = ctx.fit(blank, { fit: 'fill' })
      const crops = [new Vector4(1, 1, 0, 0), new Vector4(1, 1, 0, 0)] as const
      const look = new Vector2()
      const previewCrop = uniform(crops[0]) as unknown as V4
      const largeCrop = uniform(crops[1]) as unknown as V4
      const lookNode = uniform(look) as unknown as V2
      const at = uv()
      const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      const color = mix(
        lo.sample(at.mul(previewCrop.xy).add(previewCrop.zw)),
        hi.sample(at.mul(largeCrop.xy).add(largeCrop.zw)),
        lookNode.x,
      )
      material.colorNode = color.rgb
      material.opacityNode = color.a.mul(lookNode.y)
      const mesh = new Mesh(new PlaneGeometry(1, 1), material)
      mesh.frustumCulled = false
      mesh.visible = false
      ctx.overlay.add(mesh)
      return { mesh, lo, hi, crops, look, item: -1, fade: 0 }
    }
    const planes = [plane(), plane()] as [Plane, Plane]

    // State. `current` is the open picture, -1 when closed; `progress` how far it is open, 0..1,
    // flying or fading; `direction` where progress goes. `incoming` pages in from `side` (1: from
    // the right) while `shift` moves the pair sideways towards `shiftGoal`, or crossfades by
    // `crossfade` under reduced motion; `drop` moves the open picture down while a finger drags it.
    let current = -1
    let progress = 0
    let direction = 0
    let fly = true
    let incoming = -1
    let side = 1
    let paging = false
    let crossfade = -1
    let shift = 0
    let shiftGoal = 0
    let drop = 0
    let dropGoal = 0
    /** Something still moves, so the update asks for the next frame. */
    let moving = false
    /** The open picture's box when the flight back started. */
    let flightFrom: Place | undefined
    let unraise: Off | undefined
    // Scroll mark of the open viewer, the scroll last seen and when it last moved; `counting` once
    // a scroll starts after the landing and a still moment (QUIET).
    let scrollMark = 0
    let scrollSeen = 0
    let scrolledAt = 0
    let counting = false
    /** The index last written or followed. */
    let lastIndex = -1
    let session: AbortController | undefined
    let noted = false
    let disposing = false
    const view = new View()
    const size = { w: 0, h: 0 }
    const shown: Place = { x: 0, y: 0, w: 0, h: 0 }
    const other: Place = { x: 0, y: 0, w: 0, h: 0 }
    const world = { x: 0, y: 0 }
    const styles = new WeakMap<Element, FitOptions>()
    const styleOf = (img: Element): FitOptions => {
      let style = styles.get(img)
      if (!style) {
        style = framing(img)
        styles.set(img, style)
      }
      return style
    }

    const viewportWidth = (): number => app.stage.width.peek()
    const viewportHeight = (): number => app.stage.height.peek()
    const count = (): number => list.length
    /** The item `by` steps from `from`, -1 past the ends without `loop`. */
    const step = (from: number, by: number): number => {
      const total = count()
      const to = from + by
      if (params.loop && total > 1) return ((to % total) + total) % total
      return to >= 0 && to < total ? to : -1
    }
    const largeUrl = (item: number): string | undefined => {
      const img = imgOf(item)
      return img ? source(img) || undefined : undefined
    }
    /** The large picture of `item`, once in. Only for the items the effect keeps. */
    const textureOf = (item: number): Texture | undefined => {
      const url = largeUrl(item)
      return url ? pictures?.peek(url)?.texture : undefined
    }
    /**
     * The band the shown caption takes at the bottom or the top of the viewport, px: up to the
     * caption and as far again as it sits from the edge. 0 without a caption or across the
     * middle; at most a third of the height. Measured once per text and viewport size.
     */
    let band = { key: '', px: 0 }
    const captionBand = (): number => {
      const ui = viewer
      const text = ui?.dialog.open && !ui.caption.hidden ? ui.caption.textContent : ''
      if (!ui || !text) return 0
      const height = viewportHeight()
      const key = `${text}\n${viewportWidth()}x${height}`
      if (band.key !== key) {
        const rect = ui.caption.getBoundingClientRect()
        const px = !rect.height
          ? 0
          : rect.top >= height / 2
            ? 2 * height - rect.top - rect.bottom
            : rect.bottom <= height / 2
              ? rect.top + rect.bottom
              : 0
        band = { key, px: Math.min(Math.max(0, px), height / 3) }
      }
      return band.px
    }
    /** `item` open at zoom 1: inside the viewport less margins and the caption, at most 1:1. */
    const fitted = (item: number): { w: number; h: number; full: number } => {
      const img = imgOf(item)
      const texture = textureOf(item)
      const { width: largeWidth = 0, height: largeHeight = 0 } =
        (texture?.image as { width?: number; height?: number } | undefined) ?? {}
      const width = largeWidth || img?.naturalWidth || list[item]?.input.width || 1
      const height = largeHeight || img?.naturalHeight || list[item]?.input.height || 1
      const margin = Math.max(0, params.margin)
      // As much again above as the caption takes below, so the picture stays centred.
      const marginY = Math.max(margin, captionBand())
      const room = Math.max(
        0,
        Math.min((viewportWidth() - 2 * margin) / width, (viewportHeight() - 2 * marginY) / height),
      )
      // Until the large picture is in its size is not known: the preview fills the room.
      const scale = largeWidth ? Math.min(room, 1) : room
      // The zoom limit reaches 1:1 of the large picture at least.
      const full = largeWidth ? largeWidth / Math.max(width * scale, 1) : 1
      return { w: width * scale, h: height * scale, full }
    }
    const onScreen = (item: number): boolean => {
      const box = list[item]?.input
      return (
        !!box &&
        box.width > 0 &&
        box.y < viewportHeight() &&
        box.y + box.height > 0 &&
        box.x < viewportWidth() &&
        box.x + box.width > 0
      )
    }
    const emit = (type: string, index: number): void =>
      void el.dispatchEvent(new CustomEvent(type, { detail: { index }, bubbles: true }))
    const write = (index: number): void => {
      lastIndex = index
      if (!disposing) ctx.set({ index })
    }

    /**
     * Leases the large pictures of the open item, the incoming one and the neighbours, at most 3,
     * and the previews drawn.
     */
    const keep = (): void => {
      if (current < 0) {
        pictures?.keep()
        previews?.keep()
        return
      }
      const urls = [current, incoming, step(current, 1), step(current, -1)]
        .filter((item) => item >= 0)
        .map(largeUrl)
        .filter((url): url is string => !!url)
      const held = [...new Set(urls)].slice(0, 3)
      pictures?.keep(...held)
      const imgs = [current, incoming].map(imgOf).filter((img): img is HTMLImageElement => !!img)
      previews?.keep(...imgs)
      const wake = (): void => ctx.invalidate()
      for (const url of held) {
        const picture = pictures?.get(url)
        if (!picture || picture.texture || picture.failed) continue
        // Uploaded in the task of its decode: the frame that first shows it only binds it.
        void picture.ready.then(() => {
          if (picture.texture && pictures?.peek(url) === picture)
            render.renderer.initTexture(picture.texture)
          wake()
        })
      }
      for (const img of imgs) {
        const lease = previews?.get(img)
        if (lease && !lease.texture && !lease.failed) void lease.ready.then(wake)
      }
    }

    const label = (item: number, announce: boolean): void => {
      const ui = viewer
      if (!ui) return
      const img = imgOf(item)
      const figure = img?.closest('figure')
      const caption =
        (figure && (single || el.contains(figure))
          ? figure.querySelector('figcaption')?.textContent?.trim()
          : '') ||
        img?.alt ||
        ''
      const counter = (counterLabel || '{i} / {n}')
        .replace('{i}', String(item + 1))
        .replace('{n}', `${count()}`)
      const many = count() > 1
      const { close, controls } = lists()
      ui.counter.textContent = many ? counter : ''
      ui.caption.textContent = caption
      ui.prev.hidden = ui.next.hidden = !many || !controls.has('arrows')
      ui.counter.hidden = !controls.has('counter')
      ui.caption.hidden = !controls.has('caption')
      ui.close.hidden = !close.has('button') || !controls.has('close')
      ui.prev.disabled = step(item, -1) < 0
      ui.next.disabled = step(item, 1) < 0
      if (announce) ui.live.textContent = many ? `${caption}, ${counter}` : caption
    }

    const open = (item: number): void => {
      if (item < 0 || item >= count() || !imgOf(item)) {
        write(direction < 0 ? -1 : current)
        return
      }
      // Another picture of this viewer still flies back: it lands at once.
      if (current >= 0 && current !== item) finish()
      if (opened && current < 0) opened(true)
      warm()
      const back = current >= 0
      current = item
      write(item)
      fly = !ctx.input.reducedMotion && params.motion !== 'fade' && (back ? fly : onScreen(item))
      if (!back) progress = 0
      direction = 1
      flightFrom = undefined
      incoming = -1
      paging = false
      crossfade = -1
      shift = shiftGoal = drop = dropGoal = 0
      view.reset()
      scrollMark = scrollSeen = app.scroll.state.y
      scrolledAt = app.loop.driver.now()
      counting = false
      unraise ??= ctx.raise()
      opened = shut
      show(item)
      // After show: the box leaves room for the caption the dialog now shows.
      const fit = fitted(item)
      size.w = fit.w
      size.h = fit.h
      keep()
      emit('dio:open', item)
      ctx.invalidate()
    }

    /** Pages to `item`, coming in from side `from` (1: from the right). */
    const go = (item: number, from: number): void => {
      // A picture still sliding in takes the place first, so the next page starts from it.
      if (current >= 0 && direction === 0 && incoming >= 0 && paging) settle()
      if (current < 0 || direction !== 0 || item < 0 || item === current || item >= count()) {
        write(direction < 0 ? -1 : current)
        return
      }
      incoming = item
      side = from
      paging = true
      write(item)
      if (!fly && ctx.input.reducedMotion) {
        crossfade = 0
        shift = shiftGoal = 0
      } else shiftGoal = -from * (viewportWidth() + GAP)
      planes[1].fade = 0
      label(item, true)
      keep()
      emit('dio:index', item)
      ctx.invalidate()
    }

    /**
     * Ends paging: the incoming picture is the open one, and its plane the first. It keeps the
     * offset it still has, and slides the rest of the way.
     */
    const settle = (): void => {
      if (incoming < 0) return
      planes.reverse()
      current = incoming
      incoming = -1
      paging = false
      shift = crossfade < 0 ? shift - shiftGoal : 0
      shiftGoal = 0
      crossfade = -1
      view.reset()
      const fit = fitted(current)
      size.w = fit.w
      size.h = fit.h
      keep()
    }

    /** Closes: flies back, dissolves where the preview is off screen, or at once with `now`. */
    const shut = (now = false): void => {
      if (current < 0 || (direction < 0 && !now)) return
      if (incoming >= 0 && paging && Math.abs(shift - shiftGoal) < (viewportWidth() + GAP) / 2) {
        // The flight back starts where the incoming picture was drawn.
        Object.assign(shown, other)
        settle()
      }
      const was = current
      incoming = -1
      paging = false
      crossfade = -1
      write(-1)
      hide(was)
      emit('dio:close', was)
      if (opened === shut) opened = undefined
      if (now) {
        finish()
        return
      }
      direction = -1
      if (fly && !onScreen(current)) fly = false
      flightFrom = { ...shown }
      ctx.invalidate()
    }

    const finish = (): void => {
      current = incoming = -1
      progress = direction = 0
      paging = false
      crossfade = -1
      shift = shiftGoal = drop = dropGoal = 0
      flightFrom = undefined
      view.reset()
      unraise?.()
      unraise = undefined
      for (const plane of planes) {
        plane.mesh.visible = false
        plane.item = -1
        plane.fade = 0
        plane.lo.set(blank, { fit: 'fill' })
        plane.hi.set(blank, { fit: 'fill' })
      }
      backdrop.visible = false
      keep()
      moving = false
    }
    ctx.onDispose(() => {
      disposing = true
      if (current >= 0) shut(true)
    })

    // The dialog while open: buttons, keys, wheel, pointers.
    const pointers = new Pointers()
    type Drag = {
      axis?: 'x' | 'y' | 'pan' | 'pinch'
      x: number
      y: number
      vx: number
      vy: number
      t: number
    }
    let drag: Drag | undefined
    let tapped: { x: number; y: number; t: number } | undefined

    const show = (item: number): void => {
      viewer ??= makeViewer()
      const ui = viewer
      if (!ui.dialog.isConnected) document.body.append(ui.dialog)
      ui.dialog.setAttribute('aria-label', dialogLabel || 'Image viewer')
      ui.close.setAttribute('aria-label', closeLabel || 'Close')
      ui.prev.setAttribute('aria-label', prevLabel || 'Previous')
      ui.next.setAttribute('aria-label', nextLabel || 'Next')
      label(item, false)
      ui.live.textContent = ''
      session?.abort()
      session = new AbortController()
      listen(ui, session.signal)
      // After the raise: a modal dialog lies above the raised canvas in the top layer.
      if (!ui.dialog.open) ui.dialog.showModal()
      ;(ui.close.hidden ? ui.dialog : ui.close).focus()
    }
    const hide = (item: number): void => {
      session?.abort()
      session = undefined
      pointers.clear()
      drag = undefined
      tapped = undefined
      const ui = viewer
      if (ui?.dialog.open) ui.dialog.close()
      const img = imgOf(item)
      const control = img && controlOf(img)
      if (control?.isConnected) control.focus({ preventScroll: true })
    }

    /** The point is over the open picture. */
    const over = (x: number, y: number): boolean =>
      Math.abs(x - shown.x) <= shown.w / 2 && Math.abs(y - shown.y) <= shown.h / 2
    /** A client point from the open picture's centre at zoom 1, where the view zooms about. */
    const fromCentreX = (x: number): number => x - viewportWidth() / 2 - shift
    const fromCentreY = (y: number): number => y - viewportHeight() / 2 - drop
    /** Zooms to `z` keeping the client point (x, y) still. */
    const zoomTo = (z: number, x: number, y: number): void => {
      view.zoomTo(z, fromCentreX(x), fromCentreY(y), ctx.input.reducedMotion)
      ctx.invalidate()
    }
    const page = (by: number): void => {
      // Counted from the picture paging in, so quick presses go on past it.
      const item = step(incoming >= 0 && paging ? incoming : current, by)
      if (item >= 0) go(item, by)
    }
    const ready = (): boolean => current >= 0 && direction >= 0

    function listen(ui: Viewer, off: AbortSignal): void {
      const on = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement,
        type: K,
        handler: (e: HTMLElementEventMap[K]) => void,
        passive = true,
      ): void => target.addEventListener(type, handler, { signal: off, passive })
      const dialog = ui.dialog
      on(ui.close, 'click', () => shut())
      on(ui.prev, 'click', () => page(-1))
      on(ui.next, 'click', () => page(1))
      // Escape closes the dialog natively.
      on(dialog, 'close', () => shut())
      on(
        dialog,
        'keydown',
        (e) => {
          if (e.altKey || e.ctrlKey || e.metaKey || !ready()) return
          const centreX = viewportWidth() / 2 + view.x + shift
          const centreY = viewportHeight() / 2 + view.y + drop
          if (e.key === 'ArrowRight') page(1)
          else if (e.key === 'ArrowLeft') page(-1)
          else if (!zoomable()) return
          else if (e.key === '+' || e.key === '=') zoomTo(view.z * 1.5, centreX, centreY)
          else if (e.key === '-') zoomTo(view.z / 1.5, centreX, centreY)
          else if (e.key === '0') zoomTo(1, centreX, centreY)
          else return
          e.preventDefault()
        },
        false,
      )
      on(
        dialog,
        'wheel',
        (e) => {
          e.preventDefault()
          if (!ready() || !zoomable()) return
          // Line and page deltas are coarser than pixels.
          const factor = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002))
          view.zoomAt(factor, fromCentreX(e.clientX), fromCentreY(e.clientY))
          ctx.invalidate()
        },
        false,
      )
      on(dialog, 'pointerdown', (e) => {
        if (e.composedPath().some((node) => (node as Element).localName === 'button')) return
        if (e.pointerType === 'mouse' && e.button !== 0) return
        pointers.down(e)
        try {
          dialog.setPointerCapture(e.pointerId)
        } catch {
          // A pointer the browser no longer knows.
        }
        if (pointers.count === 1) {
          drag = { x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: e.timeStamp }
        } else if (drag) drag.axis = 'pinch'
      })
      on(dialog, 'pointermove', (e) => {
        const moved = pointers.move(e)
        if (!moved || !drag || !ready()) return
        if (pointers.count > 1) {
          drag.axis = 'pinch'
          if (!zoomable()) return
          view.zoomAt(moved.k, fromCentreX(moved.x), fromCentreY(moved.y))
          view.pan(moved.dx, moved.dy)
          ctx.invalidate()
          return
        }
        if (drag.axis === 'pinch') return
        const elapsed = (e.timeStamp - drag.t) / 1000
        drag.t = e.timeStamp
        if (elapsed > 0) {
          drag.vx = drag.vx * 0.5 + (moved.dx / elapsed) * 0.5
          drag.vy = drag.vy * 0.5 + (moved.dy / elapsed) * 0.5
        }
        let dx = moved.dx
        let dy = moved.dy
        if (!drag.axis) {
          // The moves under the threshold count once it is passed.
          dx = e.clientX - drag.x
          dy = e.clientY - drag.y
          if (Math.hypot(dx, dy) < TAP) return
          drag.axis = dragAxis(dx, dy)
        }
        if (drag.axis === 'pan') view.pan(dx, dy)
        else if (drag.axis === 'x') {
          // Past the ends the picture only gives a little.
          shift += step(current, shift + dx < 0 ? 1 : -1) >= 0 ? dx : dx * 0.35
          shiftGoal = shift
          side = shift < 0 ? 1 : -1
          const item = step(current, side)
          if (item !== incoming) {
            incoming = item
            if (item >= 0) keep()
          }
        } else {
          drop += dy
          dropGoal = drop
        }
        ctx.invalidate()
      })
      on(dialog, 'pointerup', (e) => release(e, false))
      on(dialog, 'pointercancel', (e) => release(e, true))
    }

    /**
     * What a drag that passed the tap threshold does: pans a zoomed picture, pages along x, or
     * along y closes by a swipe.
     */
    const dragAxis = (dx: number, dy: number): Drag['axis'] => {
      if (!view.fitted || !params.swipe || direction !== 0 || paging) return 'pan'
      if (Math.abs(dx) > Math.abs(dy)) return 'x'
      return closes('swipe') ? 'y' : 'pan'
    }
    /** The last pointer let go: the drag ends in a fling, a page, a close or a tap. */
    const release = (e: PointerEvent, cancel: boolean): void => {
      pointers.up(e)
      if (pointers.count || !drag) return
      const ended = drag
      drag = undefined
      if (!ready()) return
      const reduced = ctx.input.reducedMotion
      if (ended.axis === 'pan') {
        if (!reduced) view.fling(ended.vx, ended.vy)
      } else if (ended.axis === 'x') {
        const toward = shift < 0 ? 1 : -1
        const item = step(current, toward)
        const far =
          Math.abs(shift) > viewportWidth() * SWIPE ||
          (Math.abs(ended.vx) > FLICK && ended.vx * toward < 0)
        if (item >= 0 && far) {
          incoming = -1
          go(item, toward)
          if (reduced) {
            shift = shiftGoal
            settle()
          }
        } else {
          shiftGoal = 0
          if (reduced) shift = 0
        }
      } else if (ended.axis === 'y') {
        if (drop > DROP || ended.vy > FLICK) shut()
        else {
          dropGoal = 0
          if (reduced) drop = 0
        }
      } else if (!ended.axis && !cancel) tap(e)
      ctx.invalidate()
    }
    /** A double tap on the picture zooms in or out; a tap on the backdrop closes. */
    const tap = (e: PointerEvent): void => {
      const now = e.timeStamp
      const inside = over(e.clientX, e.clientY)
      const prior = tapped
      tapped = { x: e.clientX, y: e.clientY, t: now }
      if (
        prior &&
        inside &&
        zoomable() &&
        now - prior.t < DOUBLE &&
        Math.hypot(e.clientX - prior.x, e.clientY - prior.y) < 3 * TAP
      ) {
        tapped = undefined
        zoomTo(view.fitted ? view.max : 1, e.clientX, e.clientY)
      } else if (!inside && closes('backdrop')) shut()
    }

    // Clicks on the page open the viewer; with a modifier or another button the link does what
    // links do. Only a running instance listens, so without one the link opens the file.
    const indexOf = (target: Element): number => {
      const control = target.closest('a, button')
      for (let item = 0; item < count(); item++) {
        const img = imgOf(item)
        if (!img) continue
        if (img === target || img.contains(target)) return item
        if (control?.contains(img) && (single || el.contains(control))) return item
      }
      return -1
    }
    const clickable = single ? (controlOf(el) ?? el) : el
    // The dialog's backdrop is hidden until the first opening: its pipelines build off the frame
    // as soon as the visitor reaches for a picture, or when the page is idle, not in the flight.
    let warmed = false
    // The backdrop waits for its pipelines: an opening at once fades it in a few frames late.
    let dark = false
    const warm = (): void => {
      if (warmed) return
      warmed = true
      const compiled = (): void => {
        dark = true
        // A frame only for an opening that waits for it: none at rest.
        if (current >= 0) ctx.invalidate()
      }
      ctx.compile(backdrop).then(compiled, compiled)
    }
    for (const type of ['pointerover', 'focusin', 'touchstart'] as const) {
      clickable.addEventListener(type, warm, { signal, passive: true })
    }
    // Or once the page is idle, so even a first opening at once finds them built.
    const idle = (globalThis as { requestIdleCallback?: typeof requestIdleCallback })
      .requestIdleCallback
    if (idle) {
      const id = idle(warm, { timeout: 3000 })
      signal.addEventListener('abort', () => cancelIdleCallback(id))
    } else {
      const id = setTimeout(warm, 1000)
      signal.addEventListener('abort', () => clearTimeout(id))
    }
    clickable.addEventListener(
      'click',
      (e) => {
        if (e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
          return
        }
        const item = indexOf(e.target as Element)
        if (item < 0) return
        e.preventDefault()
        open(item)
      },
      { signal },
    )

    const posed = (item: number, box: Place, weight: number, bend: Readonly<Bend> = FLAT): void => {
      const layer = list[item]
      if (!layer) return
      const { x, y } = render.toWorld(box.x, box.y, world)
      // The pose blends from the element by `weight`; dividing keeps the bend at `bend` itself.
      const unblend = weight > 1e-4 ? 1 / weight : 0
      ctx.pose(
        layer,
        {
          x,
          y: y + bend.y * unblend,
          z: bend.z * unblend,
          rotateX: aim(bend.rx, weight, CAP.rx),
          rotateY: aim(bend.ry, weight, CAP.ry),
          rotateZ: aim(bend.rz, weight, CAP.rz),
          width: box.w,
          height: box.h,
          radius: 0,
          clip: false,
          above: 2,
        },
        weight,
      )
    }
    const draw = (
      plane: Plane,
      item: number,
      box: Place,
      alpha: number,
      scale: number,
      bend: Readonly<Bend> = FLAT,
      weight = 1,
    ): void => {
      const img = imgOf(item)
      if (!img || alpha <= 0) {
        plane.mesh.visible = false
        return
      }
      if (plane.item !== item) {
        plane.item = item
        plane.lo.set(blank, { fit: 'fill' })
        plane.hi.set(blank, { fit: 'fill' })
      }
      const preview = previews?.peek(img)?.texture
      const large = textureOf(item)
      if (preview) plane.lo.set(preview, { fit: 'fill' })
      if (large) plane.hi.set(large, { fit: 'fill' })
      crop(preview, box.w, box.h, styleOf(img), plane.crops[0])
      crop(large, box.w, box.h, COVER, plane.crops[1])
      // Over a flying copy only the large picture; else the preview until it comes.
      const shows = fly ? !!large : !!(preview || large)
      plane.look.set(fly ? 1 : large ? plane.fade : 0, alpha)
      const { x, y } = render.toWorld(box.x, box.y, world)
      // Bent like the copy under it (posed), so the two never show apart.
      plane.mesh.position.set(x, y + bend.y, bend.z)
      plane.mesh.rotation.set(
        aim(bend.rx, weight, CAP.rx) * weight,
        aim(bend.ry, weight, CAP.ry) * weight,
        aim(bend.rz, weight, CAP.rz) * weight,
      )
      plane.mesh.scale.set(box.w * scale || 1e-6, box.h * scale || 1e-6, 1)
      plane.mesh.visible = shows
    }

    const bent: Bend = { ...FLAT }
    /**
     * The bend of the open picture at flight time `time` (0 at rest) and `weight`. lift: an arc
     * towards the viewer, tipped back and leaning into the move. flip: a card turn about y, swapped
     * edge-on at mid-flight so the picture never shows mirrored. fly and zoom go straight.
     */
    const bendAt = (motion: Motion, time: number, weight: number): Readonly<Bend> => {
      if (!time || motion === 'fly' || motion === 'zoom') return FLAT
      // The box the runtime measured this frame: no layout read per frame of the flight.
      const box = list[current]?.input
      const lean = box?.width ? Math.sign(shown.x - (box.x + box.width / 2)) : 0
      Object.assign(bent, FLAT)
      if (motion === 'flip') {
        bent.ry = (lean || 1) * Math.PI * (weight < 0.5 ? weight : weight - 1)
      } else {
        const arc = Math.sin(Math.PI * time)
        bent.y = LIFT.y * arc
        bent.z = LIFT.z * arc
        bent.rx = -LIFT.tip * arc
        bent.rz = -lean * LIFT.lean * arc
      }
      return bent
    }

    // The steps of a frame.

    /** Warns once when an item has no link or button the keyboard reaches. */
    const noteControls = (): void => {
      if (noted || !count()) return
      noted = true
      if (list.some((layer) => !controlOf(layer.element))) {
        app.log.warn(
          'lightbox: put each image in a link to its large file or a <button>, so the keyboard reaches it',
          el,
        )
      }
    }
    /** Opens, pages or closes when the site or a tween writes `index`. */
    const followIndex = (): void => {
      const wanted = Math.round(params.index)
      if (wanted === lastIndex) return
      lastIndex = wanted
      if (wanted < 0) shut()
      else if (current < 0 || direction < 0) open(wanted)
      else go(wanted, wanted > current ? 1 : -1)
    }
    /** Closes on a page scroll past SCROLL from the mark. */
    const watchScroll = (): void => {
      const y = app.scroll.state.y
      if (y !== scrollSeen) {
        const now = app.loop.driver.now()
        if (direction === 0 && now - scrolledAt >= QUIET) counting = true
        // A scroll under way since before the landing carries the mark along.
        if (!counting) scrollMark += y - scrollSeen
        scrollSeen = y
        scrolledAt = now
      }
      if (direction >= 0 && closes('scroll') && Math.abs(y - scrollMark) > SCROLL) shut()
    }
    /** Moves the flight or the fade on. False when a closing ended. */
    const advance = (delta: number, reduced: boolean): boolean => {
      if (!direction) return true
      const span = fly ? params.duration : reduced ? CALM : params.duration * DISSOLVE
      // A picture that fades in waits until there is something to show.
      const img = imgOf(current)
      const waiting =
        !fly &&
        direction > 0 &&
        assets &&
        !(img && previews?.peek(img)?.texture) &&
        !textureOf(current)
      if (!waiting) progress = unit(progress + (direction * delta) / Math.max(span, 1e-3))
      if (direction > 0 && progress >= 1) direction = 0
      else if (direction < 0 && progress <= 0) {
        finish()
        return false
      }
      return true
    }
    /** The open size follows the picture's own once the large file is in. True while moving. */
    const resize = (delta: number, reduced: boolean): boolean => {
      let busy = false
      const fit = fitted(current)
      size.w = damp(size.w, fit.w, reduced ? 0 : RESIZE, delta)
      size.h = damp(size.h, fit.h, reduced ? 0 : RESIZE, delta)
      if (Math.abs(size.w - fit.w) + Math.abs(size.h - fit.h) < 0.05) {
        size.w = fit.w
        size.h = fit.h
      } else busy = true
      const limit = zoomable() ? Math.max(params.zoom, fit.full) : 1
      view.frame(size.w, size.h, viewportWidth(), viewportHeight(), limit)
      if (view.step(reduced ? 1 : delta)) busy = true
      return busy
    }
    /** Eases the paging shift and the drop, and ends paging. True while moving. */
    const slide = (delta: number, reduced: boolean): boolean => {
      let busy = false
      if (drag?.axis !== 'x') {
        shift = reduced ? shiftGoal : damp(shift, shiftGoal, SLIDE, delta, 0.5)
        if (shift !== shiftGoal) busy = true
      }
      if (drag?.axis !== 'y') {
        drop = reduced ? dropGoal : damp(drop, dropGoal, SLIDE, delta, 0.5)
        if (drop !== dropGoal) busy = true
      }
      if (incoming >= 0 && !drag) {
        if (crossfade >= 0) {
          crossfade = Math.min(1, crossfade + delta / CALM)
          busy = true
          if (crossfade >= 1) settle()
        } else if (paging && shift === shiftGoal) settle()
        else if (!paging && shift === 0) incoming = -1
      }
      return busy
    }
    /** The boxes of the open picture, frozen for the flight back, and of the incoming one. */
    const layout = (): void => {
      if (flightFrom && direction < 0) Object.assign(shown, flightFrom)
      else {
        shown.w = size.w * view.z
        shown.h = size.h * view.z
        shown.x = viewportWidth() / 2 + view.x + shift
        shown.y = viewportHeight() / 2 + view.y + drop
      }
      if (incoming < 0) return
      const fit = fitted(incoming)
      other.x = viewportWidth() / 2 + (crossfade >= 0 ? 0 : shift + side * (viewportWidth() + GAP))
      other.y = viewportHeight() / 2
      other.w = fit.w
      other.h = fit.h
    }
    /** The large pictures come in after the flight lands and leave first on the way back. */
    const fadePlanes = (delta: number, reduced: boolean): boolean => {
      let busy = false
      for (const [index, plane] of planes.entries()) {
        const item = index ? incoming : current
        const wanted =
          item >= 0 && !!textureOf(item) && (index || !fly || (progress >= 1 && direction >= 0))
        const was = plane.fade
        plane.fade = wanted
          ? reduced
            ? 1
            : Math.min(1, plane.fade + delta / CROSS)
          : Math.max(0, plane.fade - (reduced ? 1 : delta / OUT))
        if (plane.fade !== was) busy = true
      }
      return busy
    }
    /** Copies fly; where they do not, the planes draw the pictures. */
    const drawPictures = (weight: number, reduced: boolean): void => {
      const [first, second] = planes
      if (fly) {
        const motion = params.motion
        const bend = bendAt(motion, reduced || !direction ? 0 : progress, weight)
        posed(current, shown, weight, bend)
        if (incoming >= 0) posed(incoming, other, 1)
        // The rest of the gallery sinks back while the picture is up.
        if (!reduced && (motion === 'lift' || motion === 'zoom')) {
          for (let item = 0; item < list.length; item++) {
            const layer = list[item]
            if (item !== current && item !== incoming && layer) {
              ctx.pose(layer, { z: -RECEDE }, weight)
            }
          }
        }
        draw(first, current, shown, first.fade, 1, bend, weight)
        draw(second, incoming, other, second.fade, 1)
        return
      }
      const scale = reduced ? 1 : 0.96 + 0.04 * progress
      const incomingAlpha = crossfade >= 0 ? crossfade : 1
      draw(first, current, shown, weight * (crossfade >= 0 ? 1 - crossfade : 1), scale)
      draw(second, incoming, other, weight * incomingAlpha, scale)
    }
    /** The backdrop at `dim`, lighter while the picture is dragged down. */
    const drawBackdrop = (weight: number): void => {
      const dropped = 1 - Math.min(1, Math.abs(drop) / (viewportHeight() * 0.6)) * 0.7
      const opacity = unit(params.dim) * weight * dropped
      dimmed.value = opacity
      if (opacity > 0) {
        const backdropColor = u.backdrop.value as Color
        const gains = veiling.blendColor
        for (const channel of ['r', 'g', 'b'] as const) {
          const [gain, add] = veil(opacity, encoded(backdropColor[channel]))
          gains[channel] = gain
          added[channel] = add
        }
      }
      backdrop.scale.set(viewportWidth() || 1e-6, viewportHeight() || 1e-6, 1)
      backdrop.visible = opacity > 0 && dark
    }

    return (input): boolean => {
      const delta = input.delta
      const reduced = input.reducedMotion
      noteControls()
      followIndex()
      if (current < 0) return moving
      if (!list[current] || input.presence < 1) {
        shut(true)
        return moving
      }
      watchScroll()
      let busy = direction !== 0
      if (!advance(delta, reduced)) return moving
      const weight = fly ? ease('cubicInOut', progress) : progress
      if (resize(delta, reduced)) busy = true
      if (slide(delta, reduced)) busy = true
      layout()
      if (fadePlanes(delta, reduced)) busy = true
      drawPictures(weight, reduced)
      drawBackdrop(weight)
      moving = busy
      return moving
    }
  },
})
export default lightbox
