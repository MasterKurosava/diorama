import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, maxTextureSize } from '@dioramajs/effects/kit'
import {
  max,
  min,
  mod,
  positionGeometry,
  select,
  smoothstep,
  sRGBTransferEOTF,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  CanvasTexture,
  Color,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { fonts, raster, unsupported } from './raster'

type Params = {
  direction: ChoiceParam<'left' | 'right'>
  speed: number
  gap: number
  boost: number
  skew: number
  reverse: boolean
  pause: boolean
  fade: number
}

/** Scroll px a second at velocity 1 (the runtime's scale). */
const FULL = 3000
/** Widest strip in device px. */
const WIDEST = 8192
/** Milliseconds after a change of the content, the box or the fonts before it is drawn again. */
const REDRAW_DELAY = 150
/** Longest frame step, s: a stalled tab does not jump the strip. */
const MAX_STEP = 0.1
/** Frames a second while the strip moves. */
const FPS = 60

/** One copy of the content drawn into a canvas, and where it sits in the box. */
export interface Strip {
  readonly canvas: HTMLCanvasElement
  /** The canvas in box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  /** Width of the content in px, from its left edge to its right edge. */
  readonly content: number
  /** Space after the content before the next copy: the row's CSS gap, or 1em for plain text. */
  readonly trailing: number
  /** Box width and height the strip was drawn at. */
  readonly width: number
  readonly height: number
  /** An image from another origin without CORS made the canvas unreadable. */
  readonly tainted: boolean
}

/** A descendant the strip draws besides the text: a painted box, or an image or inline SVG. */
type Part =
  | { readonly kind: 'box'; readonly el: Element; readonly rect: DOMRect }
  | {
      readonly kind: 'image'
      readonly el: Element
      readonly rect: DOMRect
      image?: HTMLImageElement
    }

/** Computed paint copied onto each node of an inline SVG drawn as an image. */
const PAINT = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'display',
  'visibility',
  'stop-color',
  'stop-opacity',
]

/** Frames a second each phase wants: FPS while the strip moves, 0 at a standstill. */
const pacing = new WeakMap<AbortSignal, () => number>()

/**
 * The element's content runs past in an endless horizontal loop: text, logos and inline images
 * drawn once and repeated by the GPU. It speeds up and leans with the scroll, may turn around when
 * the page scrolls up, and slows to a stop under the pointer or keyboard focus. The DOM content
 * stays where it is, once, for screen readers.
 */
const marquee: Effect<Params> = defineEffect({
  name: 'marquee',
  params: {
    direction: oneOf('left', 'right'),
    speed: 60,
    gap: 0,
    boost: 0.3,
    skew: 6,
    reverse: false,
    pause: true,
    fade: 0.08,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const reason = unsupported(element) ?? (await fonts(element))
    if (signal.aborted) return
    if (reason) {
      if (DEV)
        app.log.warn(`marquee: ${reason} cannot be drawn, the content stays as it is`, element)
      ctx.showDom(true)
      return
    }
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    // Drawn at the screen's density: the strip is sampled 1:1, without mip levels.
    const ratio = ctx.quality === 'low' ? 1 : Math.min(2, Math.max(1, dpr))
    const widest = Math.min(WIDEST, maxTextureSize(ctx))
    let current = await strip(element, ratio, widest)
    if (signal.aborted) return
    if (!current || current.tainted) {
      if (DEV && current)
        app.log.warn(
          'marquee: an image from another origin without CORS cannot be drawn, the content stays as it is',
          element,
        )
      ctx.showDom(true)
      return
    }

    // The quad over the box: each pixel reads the strip at its x plus the travel, sheared by the
    // lean and wrapped every period, over the element's own background.

    // The canvas in box px, the period of the copies and the travel, both px.
    const frame = uniform(new Vector4(...current.frame))
    const period = uniform(1)
    const offset = uniform(0)
    // tan of the lean; positive leans the top to the left.
    const shear = uniform(0)
    const fill = uniform(backdrop(element))
    const corner = positionGeometry.xy.add(0.5)
    const width = u.size.x
    const height = u.size.y
    // The quad spans the box and any ink past its top or bottom.
    const top = min(0, frame.y)
    const bottom = max(height, frame.y.add(frame.w))
    const x = corner.x.mul(width)
    const y = top.add(corner.y.oneMinus().mul(bottom.sub(top)))
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(x.sub(width.mul(0.5)), height.mul(0.5).sub(y), 0)
    const point = varying(vec2(x, y))
    const stripX = point.x.add(offset).add(height.mul(0.5).sub(point.y).mul(shear))
    const inPeriod = mod(stripX.sub(frame.x), period)
    const stripV = point.y.sub(frame.y).div(frame.w)
    const onStrip = select(
      inPeriod.lessThan(frame.z).and(stripV.greaterThanEqual(0)).and(stripV.lessThanEqual(1)),
      1,
      0,
    ) as unknown as Node<'float'>
    const map = texture(
      stripTexture(current.canvas),
      vec2(inPeriod.div(frame.z), stripV.oneMinus()),
    )
    const boxUV = vec2(point.x.div(width), point.y.div(height).oneMinus())
    // Soft edges at both sides, `fade` of the width each.
    const edge = min(boxUV.x, boxUV.x.oneMinus())
    const soft = select(u.fade.greaterThan(0), smoothstep(0, max(u.fade, 1e-4), edge), 1)
    const contentAlpha = map.a.mul(onStrip).mul(soft)
    const rgb = sRGBTransferEOTF(map.rgb.div(max(map.a, 1e-4))) as Node<'vec3'>
    // The element's own background stays put under the moving content, inside the box only.
    const band = select(boxUV.y.greaterThanEqual(0).and(boxUV.y.lessThanEqual(1)), fill.w, 0)
    const under = band.mul(contentAlpha.oneMinus())
    const alpha = contentAlpha.add(under)
    material.colorNode = vec4(
      rgb.mul(contentAlpha).add(fill.xyz.mul(under)).div(max(alpha, 1e-4)),
      alpha.mul(ctx.mask(boxUV.clamp(0, 1))),
    )
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.frustumCulled = false
    ctx.onDispose(() => (map.value as Texture).dispose())
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const use = (next: Strip): void => {
      const old = map.value as Texture
      map.value = stripTexture(next.canvas)
      old.dispose()
      frame.value.set(...next.frame)
      fill.value.copy(backdrop(element))
      current = next
      ctx.invalidate()
    }
    // Draw again a moment after the content, its images, its fonts or the box change.
    const redraw = async (): Promise<void> => {
      // Content that cannot be drawn like the DOM keeps the last strip.
      if (await fonts(element)) return
      const next = await strip(element, ratio, widest)
      if (signal.aborted || !next || next.tainted) return
      use(next)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void redraw()
      }, REDRAW_DELAY)
    }
    ctx.onDispose(() => clearTimeout(timer))
    const changes = new MutationObserver(schedule)
    changes.observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'class', 'style'],
    })
    ctx.onDispose(() => changes.disconnect())
    const resize = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      const last = current
      if (
        Math.abs(rect.width - (last?.width ?? rect.width)) > 0.5 ||
        Math.abs(rect.height - (last?.height ?? rect.height)) > 0.5
      )
        schedule()
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })
    for (const img of element.querySelectorAll('img'))
      img.addEventListener('load', schedule, { signal })

    // Under a mouse or keyboard focus the base speed eases to 0; scrolling still moves it.
    let hovered = false
    let focused = false
    const hold = (): void => ctx.invalidate()
    element.addEventListener(
      'pointerenter',
      (e) => {
        if ((e as PointerEvent).pointerType === 'touch') return
        hovered = true
        hold()
      },
      { signal },
    )
    element.addEventListener(
      'pointerleave',
      () => {
        hovered = false
        hold()
      },
      { signal },
    )
    element.addEventListener(
      'focusin',
      () => {
        focused = true
        hold()
      },
      { signal },
    )
    element.addEventListener(
      'focusout',
      (e) => {
        focused = element.contains((e as FocusEvent).relatedTarget as Element | null)
        hold()
      },
      { signal },
    )

    const direction = params.direction === 'right' ? -1 : 1
    // Px travelled within one period, and the current speed in px/s.
    let travel = 0
    let pace = params.speed
    // Smoothed scroll speed, the lean in degrees, the way the scroll turns the strip, and the
    // share of the base speed left under the pointer.
    let flow = 0
    let lean = 0
    let heading = 1
    let factor = 1
    let moving = false
    pacing.set(signal, () => (moving ? FPS : 0))
    return (input) => {
      const live = ctx.params
      const dt = Math.min(input.delta, MAX_STEP)
      const reduced = input.reducedMotion
      const velocity = reduced ? 0 : input.velocity
      if (!live.reverse) heading = 1
      else if (Math.abs(velocity) > 0.02) heading = velocity < 0 ? -1 : 1
      factor = damp(factor, live.pause && (hovered || focused) ? 0 : 1, 0.25, dt)
      flow = damp(flow, Math.abs(velocity), 0.15, dt)
      const target = reduced ? 0 : heading * (live.speed * factor + live.boost * flow * FULL)
      pace = reduced ? 0 : damp(pace, target, 0.2, dt)
      // One copy and the space after it; never shorter than the drawn strip.
      const repeat = Math.max(
        (current?.content ?? 1) + (current?.trailing ?? 0) + Math.max(live.gap, 0),
        current?.frame[2] ?? 1,
      )
      travel = (((travel + pace * dt) % repeat) + repeat) % repeat
      const goal = reduced ? 0 : Math.sign(pace) * Math.min(1, flow * 2) * live.skew
      lean = damp(lean, goal, 0.15, dt)
      period.value = repeat
      offset.value = direction * travel
      shear.value = Math.tan((lean * Math.PI) / 180) * direction
      moving =
        !reduced && (Math.abs(pace) > 0.5 || Math.abs(target) > 0.5 || Math.abs(lean - goal) > 0.01)
    }
  },
})
export default marquee

/**
 * The element's content laid out as the browser did, drawn once: backgrounds and borders of its
 * descendants, images and inline SVGs, then the text. Undefined when there is nothing to draw.
 */
export async function strip(
  element: Element,
  ratio: number,
  widest: number,
): Promise<Strip | undefined> {
  // The descendants drawn besides the text, their images loaded.
  const parts: Part[] = []
  for (const el of element.querySelectorAll('*')) {
    // An SVG's own children are drawn with it.
    if (el.parentElement?.closest('svg') && element.contains(el.parentElement.closest('svg')))
      continue
    const rect = el.getBoundingClientRect()
    if (!visible(rect)) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    if (
      !clear(style.backgroundColor) ||
      (px(style.borderTopWidth) > 0 && !clear(style.borderTopColor))
    )
      parts.push({ kind: 'box', el, rect })
    if (el instanceof HTMLImageElement || el.tagName.toLowerCase() === 'svg')
      parts.push({ kind: 'image', el, rect })
  }
  await Promise.all(
    parts.map(async (part) => {
      if (part.kind !== 'image') return
      part.image =
        part.el instanceof HTMLImageElement
          ? await ready(part.el)
          : await svgImage(part.el as SVGSVGElement, part.rect)
    }),
  )
  const box = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const text = unsupported(element) ? undefined : raster(element, 'line', ratio, widest)
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  const grow = (x: number, y: number, width: number, height: number): void => {
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x + width)
    bottom = Math.max(bottom, y + height)
  }
  for (const part of parts) {
    if (part.kind === 'image' && !part.image) continue
    grow(part.rect.left - box.left, part.rect.top - box.top, part.rect.width, part.rect.height)
  }
  // The raster's own frame carries two px of margin.
  if (text?.quads.length) {
    const [textX, textY, textWidth, textHeight] = text.frame
    grow(textX + 2, textY + 2, textWidth - 4, textHeight - 4)
  }
  if (!(right > left)) return undefined
  const content = right - left
  // Two px to spare around the content.
  const frameX = Math.floor(left) - 2
  const frameY = Math.floor(top) - 2
  const width = Math.ceil(right) + 2 - frameX
  const height = Math.ceil(bottom) + 2 - frameY
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const scale = Math.min(ratio, widest / width, widest / Math.max(height, 1))
  canvas.width = Math.max(1, Math.ceil(width * scale))
  canvas.height = Math.max(1, Math.ceil(height * scale))
  ctx.setTransform(scale, 0, 0, scale, -frameX * scale, -frameY * scale)
  for (const part of parts) {
    const { filter, alpha } = layerLook(part.el, element)
    ctx.globalAlpha = alpha
    ctx.filter = filter
    const rect = {
      x: part.rect.left - box.left,
      y: part.rect.top - box.top,
      width: part.rect.width,
      height: part.rect.height,
    }
    if (part.kind === 'box') {
      // The background and the top border, with the top left corner radius all round.
      const boxStyle = getComputedStyle(part.el)
      const radius = Math.min(
        boxStyle.borderTopLeftRadius.endsWith('%')
          ? (px(boxStyle.borderTopLeftRadius) / 100) * rect.width
          : px(boxStyle.borderTopLeftRadius),
        rect.width / 2,
        rect.height / 2,
      )
      const border = px(boxStyle.borderTopWidth)
      ctx.beginPath()
      if (ctx.roundRect) ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius)
      else ctx.rect(rect.x, rect.y, rect.width, rect.height)
      if (!clear(boxStyle.backgroundColor)) {
        ctx.fillStyle = boxStyle.backgroundColor
        ctx.fill()
      }
      if (border > 0 && !clear(boxStyle.borderTopColor)) {
        // The stroke runs along the middle of the border.
        ctx.beginPath()
        const inset = border / 2
        const inner = Math.max(0, radius - inset)
        const width = rect.width - border
        const height = rect.height - border
        if (ctx.roundRect) ctx.roundRect(rect.x + inset, rect.y + inset, width, height, inner)
        else ctx.rect(rect.x + inset, rect.y + inset, width, height)
        ctx.lineWidth = border
        ctx.strokeStyle = boxStyle.borderTopColor
        ctx.stroke()
      }
    } else if (part.image) place(ctx, part.image, rect, getComputedStyle(part.el).objectFit)
  }
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  if (text?.quads.length) {
    const [textX, textY, textWidth, textHeight] = text.frame
    ctx.drawImage(text.canvas, textX, textY, textWidth, textHeight)
  }
  let tainted = false
  try {
    ctx.getImageData(0, 0, 1, 1)
  } catch {
    tainted = true
  }
  const row = /flex|grid/.test(style.display)
  const trailing = row ? px(style.columnGap) : px(style.fontSize) || 16
  return {
    canvas,
    frame: [frameX, frameY, width, height],
    content,
    trailing,
    width: box.width,
    height: box.height,
    tainted,
  }
}

const visible = (rect: DOMRect): boolean => rect.width > 0 && rect.height > 0
const px = (value: string): number => Number.parseFloat(value) || 0
const clear = (color: string): boolean =>
  !color || color === 'transparent' || /,\s*0\)$|\/\s*0\)$/.test(color)

/** CSS filters and opacity from `el` up to the marquee, which applies its own. */
function layerLook(el: Element, root: Element): { filter: string; alpha: number } {
  const filters: string[] = []
  let alpha = 1
  for (let at: Element | null = el; at && at !== root; at = at.parentElement) {
    const style = getComputedStyle(at)
    alpha *= Number.parseFloat(style.opacity) || (style.opacity === '0' ? 0 : 1)
    if (style.filter && style.filter !== 'none') filters.push(style.filter)
  }
  return { filter: filters.join(' ') || 'none', alpha }
}

/** An inline SVG as an image, with its computed paint written in so page CSS still applies. */
async function svgImage(svg: SVGSVGElement, rect: DOMRect): Promise<HTMLImageElement | undefined> {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const from = [svg, ...svg.querySelectorAll('*')]
  const to = [copy, ...copy.querySelectorAll('*')]
  from.forEach((el, i) => {
    const target = to[i] as SVGElement | undefined
    if (!target?.style) return
    const style = getComputedStyle(el)
    for (const name of PAINT) target.style.setProperty(name, style.getPropertyValue(name))
  })
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  copy.setAttribute('width', String(rect.width))
  copy.setAttribute('height', String(rect.height))
  copy.style.setProperty('color', getComputedStyle(svg).color)
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
  try {
    await image.decode()
    return image
  } catch {
    return undefined
  }
}

async function ready(img: HTMLImageElement): Promise<HTMLImageElement | undefined> {
  // A lazy image the marquee clips may never load by itself.
  if (img.loading === 'lazy') img.loading = 'eager'
  if (!(img.complete && img.naturalWidth > 0)) await img.decode().catch(() => undefined)
  return img.naturalWidth > 0 ? img : undefined
}

/** Draws `image` into `rect` the way its object-fit does, clipped to the rect. */
function place(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  rect: { x: number; y: number; width: number; height: number },
  fit: string,
): void {
  const naturalWidth = image.naturalWidth || rect.width
  const naturalHeight = image.naturalHeight || rect.height
  let { x, y, width, height } = rect
  if (fit === 'contain' || fit === 'scale-down' || fit === 'cover') {
    const cover = Math.max(width / naturalWidth, height / naturalHeight)
    const contain = Math.min(width / naturalWidth, height / naturalHeight)
    let scale = fit === 'cover' ? cover : contain
    if (fit === 'scale-down') scale = Math.min(scale, 1)
    x += (width - naturalWidth * scale) / 2
    y += (height - naturalHeight * scale) / 2
    width = naturalWidth * scale
    height = naturalHeight * scale
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()
  ctx.drawImage(image, x, y, width, height)
  ctx.restore()
}

/** The element's own background colour in linear RGB with alpha; transparent when it has none. */
function backdrop(element: Element): Vector4 {
  const value = getComputedStyle(element).backgroundColor
  if (clear(value)) return new Vector4(0, 0, 0, 0)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return new Vector4(0, 0, 0, 0)
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data
  const color = new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace)
  return new Vector4(color.r, color.g, color.b, a / 255)
}

function stripTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  // The copies wrap in the shader: mip levels would pick the smallest level at the seam.
  map.generateMipmaps = false
  map.minFilter = LinearFilter
  return map
}
