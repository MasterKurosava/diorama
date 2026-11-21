import type { ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { DEV, damp, ease } from '@dioramajs/effects/kit'
import {
  abs,
  asin,
  atan,
  attribute,
  clamp,
  dFdx,
  dFdy,
  Fn,
  float,
  If,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  RepeatWrapping,
  type Texture,
  type TextureNode,
  type UniformNode,
  Vector2,
  Vector3,
} from 'three/webgpu'
import { type Picture, picture } from './bitmap'
import { afterDrag } from './click'
import { boxRing, circle, ringStyle } from './focus'

type Params = {
  src: string
  preview: string
  yaw: number
  pitch: number
  fov: number
  range: readonly [number, number]
  spin: number
  drag: boolean
  zoom: boolean
  gyro: boolean
  markers: string
  marker: ColorParam
  markerSize: number
  fps: number
  resolution: number
}

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>

const DEG = Math.PI / 180
const TAU = Math.PI * 2
/** Pitch limit of the view. */
const PITCH = 85 * DEG
/** One arrow key press. */
const STEP = 10 * DEG
/** One `+` or `-` press, on the tangent of half the field of view. */
const ZOOM = 1.25
/** Crossfade from the preview to the full panorama, s. */
const FADE = 0.4
/** Turn to a hotspot or to new yaw and pitch params, s. */
const TURN = 0.8
/** Spin waits this long after the visitor lets go, ms. */
const PAUSE = 5000
/** The width of the view never takes more than 110°, so a wide box does not stretch its edges. */
const ACROSS = Math.tan(55 * DEG)
/** Below this a motion counts as settled. */
const EPSILON = 1e-4

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** A hotspot: its element, its direction and where it was last drawn. */
interface Marker {
  readonly element: Element
  readonly id: string | null
  readonly yaw: number
  readonly pitch: number
  readonly dir: Vector3
  /** Box UV of the last frame, NaN while behind the viewer. */
  x: number
  y: number
  /** Highlight, eased 0..1. */
  lit: number
}

/** What the frame policy reads, by the phase's signal: the probe hands setup a proxy context. */
interface Motion {
  /** Drag, inertia, a turn, a zoom, a fade or a highlight: full rate. */
  fast: boolean
  /** Turning by itself: at most `fps`. */
  spinning: boolean
}
const motions = new WeakMap<AbortSignal, Motion>()

const PANORAMAS = '[data-dio~="panorama"]'

/** A number attribute within ±limit, or NaN; `fallback` when it is missing. */
function degrees(value: string | null, limit: number, fallback = Number.NaN): number {
  if (value === null || !value.trim()) return fallback
  const number = Number(value)
  return Math.abs(number) <= limit ? number : Number.NaN
}

/** Unit direction of a yaw and pitch in radians: yaw 0 looks along -z, yaw 90° along +x. */
const direction = (yaw: number, pitch: number, out = new Vector3()): Vector3 =>
  out.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw))

/** Hotspots from elements: inside the panorama, else anywhere outside every panorama. */
function readMarkers(el: Element, selector: string): { found: Marker[]; bad: Element[] } {
  let nodes = [...el.querySelectorAll(selector)]
  if (!nodes.length) {
    nodes = [...document.querySelectorAll(selector)].filter((node) => !node.closest(PANORAMAS))
  }
  const found: Marker[] = []
  const bad: Element[] = []
  for (const node of nodes) {
    const yaw = degrees(node.getAttribute('data-dio-yaw'), 360)
    const pitch = degrees(node.getAttribute('data-dio-pitch'), 90, 0)
    if (Number.isNaN(yaw) || Number.isNaN(pitch)) {
      bad.push(node)
      continue
    }
    const dir = direction(yaw * DEG, pitch * DEG)
    found.push({ element: node, id: node.id || null, yaw, pitch, dir, x: Number.NaN, y: 0, lit: 0 })
  }
  return { found, bad }
}

/** The nearest equivalent of `angle` to `from`, for turns along the shortest way. */
const nearest = (angle: number, from: number): number =>
  from + ((((angle - from) % TAU) + TAU + Math.PI) % TAU) - Math.PI

/**
 * Tangents of half the view across and up a box `width` by `height` for a vertical field of view
 * `fov` in degrees. A portrait box sees a little wider, so a phone is not looking through a slit;
 * the width never takes more than 110°.
 */
export function halves(fov: number, width: number, height: number): [number, number] {
  const aspect = width > 0 && height > 0 ? width / height : 1
  const portrait = Math.max(1, Math.sqrt(0.75 / aspect))
  const up = Math.min(
    Math.tan((Math.min(170, Math.max(1, fov)) * DEG) / 2) * portrait,
    ACROSS / aspect,
  )
  return [up * aspect, up]
}

/**
 * Whether `preview`, seen at `fov` in the element, would show fewer pixels across than the poster
 * image inside it. An unloaded poster shows none.
 */
function blurrier(preview: Texture, el: HTMLElement, fov: number): boolean {
  const poster = el.querySelector('img')
  const width = el.clientWidth || el.getBoundingClientRect().width
  if (!poster?.naturalWidth || !width) return false
  const screen = width * (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  const [halfX] = halves(fov, width, el.clientHeight || el.getBoundingClientRect().height)
  // Preview pixels across the view: its share of the full turn.
  const across = ((preview.image as { width?: number }).width ?? 0) * ((2 * Math.atan(halfX)) / TAU)
  return Math.min(across, screen) < Math.min(poster.naturalWidth, screen)
}

/** A texture read of the panorama: the picture and whether its rows run from the top (KTX2). */
interface Slot {
  readonly node: TextureNode
  readonly top: UniformNode<'float'>
  texture: Texture
}

/** A slot reads `map`: bitmaps come flipped, KTX2 keeps the file's top-left origin. */
function show(slot: Slot, map: Texture, url: string): void {
  slot.texture = map
  slot.node.value = map
  slot.top.value = /\.ktx2([?#]|$)/i.test(url) ? 1 : 0
}

/**
 * A 360° photo in the element's box, turned by drag, keys and the phone's gyroscope, with
 * hotspots that follow their links. Without WebGL the poster and the links stay.
 */
const panorama: Effect<Params> = defineEffect({
  name: 'panorama',
  params: {
    src: '',
    preview: '',
    yaw: 0,
    pitch: 0,
    fov: 75,
    range: [35, 100],
    spin: 0,
    drag: true,
    zoom: true,
    gyro: false,
    markers: '[data-dio-yaw]',
    marker: color('#ffffff'),
    markerSize: 28,
    fps: 30,
    resolution: 4096,
  },
  rebuild: ['resolution'],
  on: ':not(img, video, canvas)',
  quality: { low: { resolution: 2048, fps: 20 }, medium: { resolution: 4096 } },
  // Spin no faster than `fps`; drag, inertia, turns and fades at full rate (an infinite rate asks
  // for the next frame, where 60 would wait for a timer); nothing at rest.
  animate: {
    fps: (ctx) => {
      const motion = motions.get(ctx.signal)
      return motion?.fast ? Number.POSITIVE_INFINITY : motion?.spinning ? ctx.params.fps : 0
    },
  },
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, app } = ctx
    const params = ctx.params
    const el = ctx.element as HTMLElement
    const src = params.src.trim()
    const previewUrl = params.preview.trim()
    if (!src && !previewUrl) {
      app.log.warn('panorama: no data-dio-src, the poster stays')
      return
    }

    // The preview first at high priority, the full picture behind it; both count into the loader.
    const lease = (url: string, priority: 'high' | 'normal'): Picture => {
      const leased = picture(ctx, url, { resolution: params.resolution, priority })
      ctx.onDispose(() => leased.release())
      return leased
    }
    const note = (message: string, error?: unknown): void => {
      if (!signal.aborted) app.log.warn(`EFFECT_MEDIA: panorama: ${message}`, error)
    }
    let preview = previewUrl ? lease(previewUrl, 'high') : undefined
    const full = src ? lease(src, 'normal') : undefined
    let first: Texture
    let firstUrl = previewUrl || src
    try {
      try {
        first = await (preview ?? (full as Picture)).ready
      } catch (error) {
        if (!preview || !full) throw error
        note(`${previewUrl} did not load, waiting for ${src}`, error)
        preview.release()
        preview = undefined
        firstUrl = src
        first = await full.ready
      }
    } catch (error) {
      // Nothing to show: the poster stays, like without WebGL.
      note(`${firstUrl} did not load, the poster stays`, error)
      return
    }
    // A poster sharper than the preview stays until the full picture is in: a blurry preview over
    // it would read as a drop in quality. Reaching for the view (a press, a key, focus) takes the
    // preview at once, and the press is handed on, so the first drag turns the view.
    let pressed: PointerEvent | undefined
    if (preview && full && blurrier(first, el, params.fov)) {
      const reached = new Promise<void>((resolve) => {
        const off = new AbortController()
        signal.addEventListener('abort', () => off.abort())
        const reach = (e: Event): void => {
          if (e.type === 'pointerdown') pressed = e as PointerEvent
          off.abort()
          resolve()
        }
        for (const type of ['pointerdown', 'keydown', 'focusin'])
          el.addEventListener(type, reach, { signal: off.signal })
        void full.ready.then(
          () => off.abort(),
          () => off.abort(),
        )
      })
      const sharp = await Promise.race([
        full.ready.catch(() => undefined),
        reached.then(() => undefined),
      ])
      if (signal.aborted) return
      if (sharp) {
        preview.release()
        preview = undefined
        first = sharp
        firstUrl = src
        pressed = undefined
      }
    }
    if (DEV) {
      const { width, height } = first.image as { width: number; height: number }
      if (Math.abs(width / height - 2) > 0.02)
        app.log.warn(`panorama: ${firstUrl} is ${width} x ${height}, not 2:1 like a 360° photo`)
    }
    // Longitude wraps: filtering across the back seam reads the other edge.
    const wrap = (map: Texture): Texture => {
      map.wrapS = RepeatWrapping
      return map
    }
    wrap(first)

    // The view: the ray of each pixel turned by yaw and pitch, read in the equirectangular
    // picture with gradients of the continuous direction, so neither the seam at ±180° nor the
    // poles pick a wrong mip level.
    const rotation = uniform(new Matrix3())
    const half = uniform(new Vector2(1, 1))
    const fade = uniform(1)
    const slot = (): Slot => {
      const node = texture(first)
      node.mergeable = false
      const created = { node, top: uniform(0) as unknown as UniformNode<'float'>, texture: first }
      show(created, first, firstUrl)
      return created
    }
    const from = slot()
    const to = slot()
    ctx.surface.color((_, { uv: at, radius }) => {
      const turned = (rotation as unknown as Node<'mat3'>).mul(
        vec3(
          at
            .sub(0.5)
            .mul(2)
            .mul(half as unknown as V2),
          -1,
        ),
      )
      return Fn(() => {
        const ray = normalize(turned as V3).toVar()
        // Squared distance of the ray from the vertical axis.
        const ring = max(ray.x.mul(ray.x).add(ray.z.mul(ray.z)), 1e-8).toVar()
        // Longitude and latitude, 0..1.
        const lonLat = vec2(
          atan(ray.x, ray.z.negate()).div(TAU).add(0.5),
          asin(clamp(ray.y, -1, 1))
            .div(Math.PI)
            .add(0.5),
        )
        // d(longitude) and d(latitude) from the screen derivatives of the direction.
        const slope = (rayDelta: V3): V2 =>
          vec2(
            ray.x.mul(rayDelta.z).sub(ray.z.mul(rayDelta.x)).div(ring).div(TAU),
            rayDelta.y.div(sqrt(ring)).div(Math.PI),
          )
        const gradX = slope(dFdx(ray)).toVar()
        const gradY = slope(dFdy(ray)).toVar()
        const read = (slot: Slot): Node<'vec4'> => {
          const top = slot.top as unknown as F
          const sign = top.mul(-2).add(1)
          const at = vec2(lonLat.x, mix(lonLat.y, lonLat.y.oneMinus(), top))
          return (slot.node.sample(at) as TextureNode).grad(
            vec2(gradX.x, gradX.y.mul(sign)),
            vec2(gradY.x, gradY.y.mul(sign)),
          ) as unknown as Node<'vec4'>
        }
        const color = read(to).toVar()
        // The second read only while the preview fades out.
        If((fade as unknown as F).lessThan(1), () => {
          color.assign(mix(read(from), color, fade as unknown as F))
        })
        return vec4(color.rgb, radius)
      })()
    })

    // The full picture: uploaded before it fades in, the preview released once it is out.
    let fading = false
    if (full && preview) {
      full.ready.then(
        (loaded) => {
          if (signal.aborted) return
          wrap(loaded)
          const renderer = ctx.render.renderer as unknown as {
            initTexture?(texture: Texture): void
          }
          renderer.initTexture?.(loaded)
          show(from, first, firstUrl)
          show(to, loaded, src)
          fade.value = 0
          fading = true
          ctx.invalidate()
        },
        (error) => note(`${src} did not load, the preview stays`, error),
      )
    }
    const faded = (): void => {
      fading = false
      fade.value = 1
      show(from, to.texture, src)
      preview?.release()
      preview = undefined
    }

    // Hotspots: rings at the projection of each point, instances of one quad in the box.
    const spot = attribute('spot', 'vec4') as unknown as Node<'vec4'>
    const size = u.size as unknown as V2
    const markerSize = u.markerSize as unknown as F
    const reach = markerSize.mul(0.65).add(14)
    const pins = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    pins.positionNode = vec3(
      spot.xy.sub(0.5).add(positionGeometry.xy.mul(reach.mul(2)).div(size)),
      0,
    )
    // The focus ring of a hotspot link inside the panorama, which the copy hides.
    const focusColor = uniform(new Color())
    const focusWidth = uniform(2)
    const focusOffset = uniform(0)
    {
      // A ring with a soft dark halo, a faint fill and a dot that grows when lit.
      const offset = positionGeometry.xy.mul(reach.mul(2)) as unknown as V2
      const lit = spot.z
      const distance = length(offset)
      const radius = markerSize.mul(0.5).mul(lit.mul(0.15).add(1))
      const stroke = max(markerSize.mul(0.09), 2)
      const band = (width: Node<'float'>): F =>
        clamp(
          width
            .mul(0.5)
            .sub(abs(distance.sub(radius)))
            .add(0.5),
          0,
          1,
        ) as unknown as F
      const disc = (discRadius: Node<'float'>): F =>
        clamp(discRadius.sub(distance).add(0.5), 0, 1) as unknown as F
      const tint = u.marker as unknown as V3
      // Painted back to front, premultiplied.
      let rgb: V3 = vec3(0)
      let alpha: F = float(0)
      const over = (color: V3, coverage: F): void => {
        rgb = color.mul(coverage).add(rgb.mul(coverage.oneMinus())) as V3
        alpha = coverage.add(alpha.mul(coverage.oneMinus())) as F
      }
      over(vec3(0), band(stroke.add(3)).mul(0.3) as F)
      over(tint, disc(radius).mul(lit.mul(0.25).add(0.12)) as F)
      over(tint, band(stroke))
      over(tint, disc(radius.mul(0.28)).mul(lit) as F)
      const edge = circle(offset, radius.add(stroke.mul(0.5)))
      const inner = clamp(edge.sub(focusOffset).add(0.5), 0, 1)
      const outer = clamp(focusOffset.add(focusWidth).sub(edge).add(0.5), 0, 1)
      over(focusColor as unknown as V3, inner.mul(outer).mul(spot.w) as F)
      const box = spot.xy.add(offset.div(size)) as V2
      pins.colorNode = vec4(rgb.div(max(alpha, 1e-4)), alpha.mul(ctx.mask(box)))
    }
    const base = new PlaneGeometry(1, 1)
    // Per hotspot: (box UV x, y, highlight, focus ring on).
    const geometryOf = (count: number): InstancedBufferGeometry => {
      const geometry = new InstancedBufferGeometry()
      geometry.setIndex(base.getIndex())
      geometry.setAttribute('position', base.getAttribute('position'))
      geometry.setAttribute(
        'spot',
        new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4).setUsage(
          DynamicDrawUsage,
        ),
      )
      geometry.instanceCount = count
      return geometry
    }
    const pinMesh = new Mesh(geometryOf(0), pins)
    pinMesh.frustumCulled = false
    pinMesh.visible = false
    // After the panorama in the layer's own order.
    pinMesh.renderOrder = 1
    ctx.place(pinMesh)
    ctx.onDispose(() => base.dispose())

    // The focus ring of the panorama itself, around its box.
    const outline = boxRing(ctx, el)
    ctx.place(outline.mesh)

    // Points: read again on DOM changes before the next drawn frame.
    let points: Marker[] = []
    let spots = pinMesh.geometry.getAttribute('spot') as InstancedBufferAttribute
    let warned = false
    const scan = (): void => {
      const { found, bad } = readMarkers(el, params.markers)
      if (DEV && bad.length && !warned) {
        warned = true
        app.log.warn(
          'EFFECT_PARAM: panorama skips points without a yaw in -360..360 and a pitch in -90..90',
          ...bad,
        )
      }
      const same =
        found.length === points.length &&
        found.every(
          (marker, i) =>
            marker.element === points[i]?.element &&
            marker.yaw === points[i]?.yaw &&
            marker.pitch === points[i]?.pitch,
        )
      if (same) return
      // The new marker of the same element, so hover, legend and focus survive a rescan.
      const keep = (marker: Marker | undefined): Marker | undefined =>
        marker && found.find((other) => other.element === marker.element)
      for (const marker of found) {
        marker.lit =
          keep(marker)?.lit ?? points.find((old) => old.element === marker.element)?.lit ?? 0
      }
      hovered = keep(hovered)
      legend = keep(legend)
      focused = keep(focused)
      points = found
      const geometry = geometryOf(points.length)
      pinMesh.geometry.dispose()
      pinMesh.geometry = geometry
      spots = geometry.getAttribute('spot') as InstancedBufferAttribute
      light()
    }
    let dirty = false
    const observer = new MutationObserver(() => {
      dirty = true
      ctx.invalidate()
    })
    observer.observe(el.querySelector(params.markers) ? el : document.body, {
      attributes: true,
      attributeFilter: ['data-dio-yaw', 'data-dio-pitch', 'id'],
      childList: true,
      subtree: true,
    })
    ctx.onDispose(() => observer.disconnect())

    // Lit hotspot: the pointer over one or over a legend item, else the focused one.
    let hovered: Marker | undefined
    let legend: Marker | undefined
    let focused: Marker | undefined
    let lit: Marker | undefined
    const light = (): void => {
      const next = hovered ?? legend ?? focused
      if (next === lit) return
      lit = next
      ctx.invalidate()
      el.dispatchEvent(
        new CustomEvent('dio:marker', {
          detail: { marker: next?.element ?? null, id: next?.id ?? null },
          bubbles: true,
        }),
      )
    }
    /** The point whose element holds `node`, if any. */
    const pointOf = (node: unknown): Marker | undefined =>
      node instanceof Element ? points.find((marker) => marker.element.contains(node)) : undefined

    // The view: yaw and pitch in radians, the vertical field of view in degrees.
    const prefersReduced = (): boolean => app.stage.reducedMotion.peek()
    const limits = (): [number, number] => {
      const [a, b] = params.range
      return [Math.max(1, Math.min(a, b)), Math.min(170, Math.max(a, b))]
    }
    const zoomed = (fov: number): number => {
      const [narrowest, widest] = limits()
      return Math.min(widest, Math.max(narrowest, fov))
    }
    let yaw = params.yaw * DEG
    let pitch = Math.max(-PITCH, Math.min(PITCH, params.pitch * DEG))
    let fov = zoomed(params.fov)
    let fovAim = fov
    let yawParam = params.yaw
    let pitchParam = params.pitch
    let fovParam = params.fov
    let rangeParam = `${params.range}`
    let turn:
      | { yaw: number; pitch: number; fromYaw: number; fromPitch: number; t: number }
      | undefined
    let vYaw = 0
    let vPitch = 0
    let nudgeYaw = 0
    let nudgePitch = 0
    const turnTo = (toYaw: number, toPitch: number): void => {
      const target = { yaw: nearest(toYaw, yaw), pitch: Math.max(-PITCH, Math.min(PITCH, toPitch)) }
      vYaw = vPitch = nudgeYaw = nudgePitch = 0
      if (prefersReduced()) {
        yaw = target.yaw
        pitch = target.pitch
        turn = undefined
      } else turn = { ...target, fromYaw: yaw, fromPitch: pitch, t: 0 }
      ctx.invalidate()
    }
    /** Radians a pixel of the box turns the view by at its centre. */
    const rate = (): number =>
      (2 * halves(fov, ctx.input.width, ctx.input.height)[1]) / Math.max(1, ctx.input.height)

    // Spin stops while the pointer is over the panorama, while it is held or a point is focused,
    // and starts again `PAUSE` after the last of them.
    let over = false
    let waiting = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pause = (): void => {
      clearTimeout(timer)
      waiting = true
      timer = setTimeout(() => {
        timer = undefined
        waiting = false
        ctx.invalidate()
      }, PAUSE)
    }
    signal.addEventListener('abort', () => clearTimeout(timer))

    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options: AddEventListenerOptions = {},
    ): void =>
      target.addEventListener(type, handler as (event: Event) => void, { signal, ...options })
    const action = (): string => getComputedStyle(el).touchAction || 'auto'
    // A finger turns only where the site gave the gesture to the page: pan-y turns sideways,
    // none turns both ways and pinches.
    const touchable = (): boolean => {
      const touchAction = action()
      return (
        touchAction === 'none' || (touchAction.includes('pan-y') && !touchAction.includes('pan-x'))
      )
    }

    // iOS asks for the motion sensors in the handler of a user activation, once.
    let asked = false
    const ask = (): void => {
      if (asked || !params.gyro) return
      asked = true
      const request = (
        globalThis.DeviceOrientationEvent as unknown as
          | { requestPermission?: () => Promise<string> }
          | undefined
      )?.requestPermission
      if (typeof request === 'function') void request().catch(() => {})
    }

    /** A drag: its pointer, last point and time, the point it started at, and whether it tilts. */
    type Grab = {
      id: number
      x: number
      y: number
      t: number
      sx: number
      sy: number
      tilt: boolean
    }
    let grab: Grab | undefined
    /** The press moved: a drag, whose click is not a tap. */
    let moved = false
    const drags = afterDrag(el, signal)
    let routing = false
    const fingers = new Map<number, { x: number; y: number }>()
    let pinch: { distance: number; fov: number } | undefined
    const spread = (): number => {
      const [first, second] = [...fingers.values()]
      return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0
    }
    /** Field of view whose half tangent is `factor` times that of `fov`. */
    const scaled = (fov: number, factor: number): number =>
      (2 * Math.atan(Math.tan((fov * DEG) / 2) * factor)) / DEG

    listen(el, 'pointerdown', (e) => {
      moved = false
      if (e.button !== 0) return
      const touch = e.pointerType !== 'mouse'
      if (touch && !touchable()) return
      if (touch) {
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (fingers.size === 2 && action() === 'none' && params.zoom) {
          pinch = { distance: spread(), fov: fovAim }
          grab = undefined
          return
        }
      }
      if (grab || !params.drag || pinch) return
      const { pointerId: id, clientX: x, clientY: y, timeStamp: t } = e
      grab = { id, x, y, t, sx: x, sy: y, tilt: !touch || action() === 'none' }
      vYaw = vPitch = 0
      turn = undefined
      clearTimeout(timer)
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
      // No text selection and no native drag of the poster.
      if (!touch) e.preventDefault()
      ctx.invalidate()
    })
    listen(el, 'pointermove', (e) => {
      if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pinch) {
        const now = spread()
        if (now > 0 && pinch.distance > 0) {
          fovAim = zoomed(scaled(pinch.fov, pinch.distance / now))
          ctx.invalidate()
        }
        return
      }
      if (e.pointerId === grab?.id) {
        // The point under the pointer follows it.
        const perPixel = rate()
        const dx = (e.clientX - grab.x) * perPixel
        const dy = grab.tilt ? (e.clientY - grab.y) * perPixel : 0
        const seconds = Math.max(1, e.timeStamp - grab.t) / 1000
        vYaw = vYaw * 0.2 + (-dx / seconds) * 0.8
        vPitch = vPitch * 0.2 + (dy / seconds) * 0.8
        yaw -= dx
        pitch = Math.max(-PITCH, Math.min(PITCH, pitch + dy))
        moved ||= Math.hypot(e.clientX - grab.sx, e.clientY - grab.sy) > 4
        grab = { ...grab, x: e.clientX, y: e.clientY, t: e.timeStamp }
        ctx.invalidate()
        return
      }
      // No hover on touch: a tap is a click.
      if (e.pointerType !== 'mouse' || grab) return
      hovered = hit(e.clientX, e.clientY)
      light()
    })
    const release = (e: PointerEvent): void => {
      // A touch's pointerup is a user activation, its pointerdown is not.
      if (e.type === 'pointerup') ask()
      fingers.delete(e.pointerId)
      if (pinch && fingers.size < 2) pinch = undefined
      if (e.pointerId !== grab?.id) return
      if (moved && e.type === 'pointerup') drags.arm(e)
      // Held still before letting go, cancelled by a scroll, or no motion wanted: no coasting.
      if (e.type !== 'pointerup' || e.timeStamp - grab.t > 80 || prefersReduced()) {
        vYaw = vPitch = 0
      }
      vYaw = Math.max(-TAU, Math.min(TAU, vYaw))
      vPitch = Math.max(-Math.PI, Math.min(Math.PI, vPitch))
      grab = undefined
      pause()
      ctx.invalidate()
    }
    listen(el, 'pointerup', release)
    listen(el, 'pointercancel', release)
    listen(el, 'dragstart', (e) => e.preventDefault())
    listen(el, 'pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return
      over = true
      clearTimeout(timer)
    })
    listen(el, 'pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return
      over = false
      hovered = undefined
      pause()
      light()
      ctx.invalidate()
    })
    // The wheel scrolls the page; with Ctrl or ⌘ (and a trackpad pinch in Chrome) it zooms.
    listen(
      el,
      'wheel',
      (e) => {
        // Without zoom the browser keeps Ctrl + wheel: the page zooms.
        if ((!e.ctrlKey && !e.metaKey) || !params.zoom) return
        e.preventDefault()
        const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1
        fovAim = zoomed(scaled(fovAim, Math.exp(e.deltaY * lines * 0.002)))
        pause()
        ctx.invalidate()
      },
      { passive: false },
    )
    // A pointer click lands on the hotspot under it, except the one a drag ends with; keyboard
    // clicks (detail 0) stay native, which is also how the click handed to a point's link passes
    // through here.
    listen(
      el,
      'click',
      (e) => {
        if (routing || e.detail === 0) return
        // Hidden content inside the panorama must not take clicks meant for the panorama.
        if (e.target !== el) {
          e.preventDefault()
          e.stopPropagation()
        }
        if (drags.ends(e)) return
        const marker = hit(e.clientX, e.clientY)
        if (!marker) return
        hovered = marker
        light()
        const link = marker.element.matches('a, button')
          ? marker.element
          : marker.element.querySelector('a, button')
        routing = true
        try {
          ;((link ?? marker.element) as HTMLElement).click()
        } finally {
          routing = false
        }
      },
      { capture: true },
    )
    listen(el, 'keydown', (e) => {
      if (!el.hasAttribute('tabindex') || e.altKey || e.ctrlKey || e.metaKey) return
      const across = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      const up = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0
      const zoom = !params.zoom
        ? 0
        : e.key === '+' || e.key === '='
          ? 1 / ZOOM
          : e.key === '-' || e.key === '_'
            ? ZOOM
            : 0
      if (!across && !up && !zoom) return
      e.preventDefault()
      turn = undefined
      vYaw = vPitch = 0
      nudgeYaw += across * STEP
      nudgePitch += up * STEP
      if (zoom) fovAim = zoomed(scaled(fovAim, zoom))
      pause()
      ctx.invalidate()
    })
    // Legend items outside the panorama light their point; focus anywhere in a point turns to it.
    listen(document, 'pointerover', (e) => {
      const marker = pointOf(e.target)
      if (!marker || el.contains(marker.element)) return
      legend = marker
      light()
    })
    listen(document, 'pointerout', (e) => {
      if (!legend || legend.element.contains(e.relatedTarget as Element | null)) return
      legend = undefined
      light()
    })
    let ringed: Element | undefined
    listen(document, 'focusin', (e) => {
      const marker = pointOf(e.target)
      if (!marker) return
      clearTimeout(timer)
      // A point inside the panorama is hidden with it: the effect draws the ring of its link.
      const target = e.target as Element
      ringed = el.contains(marker.element) ? target : undefined
      if (ringed) {
        const style = ringStyle(ringed)
        focusColor.value.setStyle(style.color)
        focusWidth.value = style.width
        focusOffset.value = style.offset
      }
      if (marker === focused) return
      focused = marker
      turnTo(marker.yaw * DEG, marker.pitch * DEG)
      light()
    })
    listen(document, 'focusout', (e) => {
      if (!focused || pointOf(e.relatedTarget)) return
      focused = undefined
      ringed = undefined
      pause()
      light()
      ctx.invalidate()
    })
    const visible = (node: Element): boolean => {
      try {
        return node.matches(':focus-visible')
      } catch {
        return node.matches(':focus')
      }
    }

    // The phone's tilt: its turns since the last reading, added to the view.
    const orientation = new Euler()
    const device = new Matrix4()
    const back = new Matrix4().makeRotationX(-Math.PI / 2)
    const roll = new Matrix4()
    const ahead = new Vector3()
    let sensed: { yaw: number; pitch: number } | undefined
    window.addEventListener(
      'deviceorientation',
      (e) => {
        if (!params.gyro || e.alpha === null || e.beta === null || e.gamma === null) {
          sensed = undefined
          return
        }
        // As three's old DeviceOrientationControls: the camera looks out of the back of the phone.
        const turned = (globalThis.screen?.orientation?.angle ?? 0) * DEG
        orientation.set(e.beta * DEG, e.alpha * DEG, -e.gamma * DEG, 'YXZ')
        device.makeRotationFromEuler(orientation).multiply(back)
        device.multiply(roll.makeRotationZ(-turned))
        ahead.set(0, 0, -1).transformDirection(device)
        const next = {
          yaw: Math.atan2(ahead.x, -ahead.z),
          pitch: Math.asin(Math.max(-1, Math.min(1, ahead.y))),
        }
        const last = sensed
        sensed = next
        // Near straight up or down the heading is noise.
        if (!last || Math.abs(next.pitch) > 80 * DEG) return
        const dYaw = nearest(next.yaw, last.yaw) - last.yaw
        const dPitch = next.pitch - last.pitch
        if (Math.abs(dYaw) + Math.abs(dPitch) < 0.05 * DEG) {
          sensed = last
          return
        }
        turn = undefined
        yaw += dYaw
        pitch = Math.max(-PITCH, Math.min(PITCH, pitch + dPitch))
        pause()
        ctx.invalidate()
      },
      { signal },
    )

    /** The hotspot under a viewport point: the nearest one within `markerSize / 2 + 8` px. */
    const hit = (x: number, y: number): Marker | undefined => {
      const box = el.getBoundingClientRect()
      let best: Marker | undefined
      let reachPx = params.markerSize / 2 + 8
      for (const marker of points) {
        if (Number.isNaN(marker.x)) continue
        const distance = Math.hypot(
          box.left + marker.x * box.width - x,
          box.top + (1 - marker.y) * box.height - y,
        )
        if (distance < reachPx) {
          reachPx = distance
          best = marker
        }
      }
      return best
    }

    scan()
    // The press that took the preview in starts its drag.
    if (pressed) {
      const { pointerId, pointerType, button, clientX, clientY } = pressed
      const init = { pointerId, pointerType, button, clientX, clientY, bubbles: true }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...init, cancelable: true }))
    }
    const motion: Motion = { fast: false, spinning: false }
    motions.set(signal, motion)
    ctx.onDispose(() => motions.delete(signal))
    const view = new Matrix4()
    const inverse = new Matrix4()
    const euler = new Euler()
    const local = new Vector3()
    /** What is left of a nudge after a frame of easing it out. */
    const pull = (value: number, reduced: boolean, dt: number): number => {
      return reduced ? 0 : damp(value, 0, 0.08, dt, EPSILON)
    }

    return (input) => {
      const reduced = input.reducedMotion
      const dt = Math.min(input.delta, 0.1)
      if (dirty) {
        dirty = false
        scan()
      }
      if (params.yaw !== yawParam || params.pitch !== pitchParam) {
        yawParam = params.yaw
        pitchParam = params.pitch
        turnTo(params.yaw * DEG, params.pitch * DEG)
      }
      if (params.fov !== fovParam || `${params.range}` !== rangeParam) {
        fovParam = params.fov
        rangeParam = `${params.range}`
        fovAim = zoomed(params.fov)
      }
      // Without zoom the view keeps the field of view of the param.
      fovAim = zoomed(params.zoom ? fovAim : params.fov)
      const held = over || grab !== undefined || pinch !== undefined || focused !== undefined
      const spins = !reduced && params.spin !== 0
      if (spins && !held && !waiting) yaw += params.spin * DEG * dt
      if ((vYaw || vPitch) && !grab) {
        yaw += vYaw * dt
        pitch = Math.max(-PITCH, Math.min(PITCH, pitch + vPitch * dt))
        vYaw = reduced || Math.abs(vYaw) < 0.01 ? 0 : damp(vYaw, 0, 0.45, dt)
        vPitch = reduced || Math.abs(vPitch) < 0.01 ? 0 : damp(vPitch, 0, 0.45, dt)
      }
      if (turn) {
        turn.t = reduced ? 1 : Math.min(1, turn.t + dt / TURN)
        const eased = ease('cubicInOut', turn.t)
        yaw = turn.fromYaw + (turn.yaw - turn.fromYaw) * eased
        pitch = turn.fromPitch + (turn.pitch - turn.fromPitch) * eased
        if (turn.t === 1) turn = undefined
      }
      // Arrow keys ease to the next step, or jump to it under reduced motion.
      if (nudgeYaw || nudgePitch) {
        const yawLeft = pull(nudgeYaw, reduced, dt)
        const pitchLeft = pull(nudgePitch, reduced, dt)
        yaw += nudgeYaw - yawLeft
        pitch = Math.max(-PITCH, Math.min(PITCH, pitch + nudgePitch - pitchLeft))
        nudgeYaw = yawLeft
        nudgePitch = pitchLeft
      }
      if (fov !== fovAim) {
        fov = reduced ? fovAim : damp(fov, fovAim, 0.08, dt, 1e-3)
      }
      // Keep the angles small so float precision holds after many turns.
      if (Math.abs(yaw) > TAU) {
        const turns = Math.trunc(yaw / TAU) * TAU
        yaw -= turns
        if (turn) {
          turn.yaw -= turns
          turn.fromYaw -= turns
        }
      }
      // Under reduced motion the runtime draws no timed frames: the full picture comes in at once.
      if (fading) {
        fade.value = reduced ? 1 : Math.min(1, fade.value + dt / FADE)
        if (fade.value >= 1) faded()
      }

      // The view: rotation and half tangents for the shader, projections for the hotspots.
      const [halfX, halfY] = halves(fov, input.width, input.height)
      ;(half.value as Vector2).set(halfX, halfY)
      view.makeRotationFromEuler(euler.set(pitch, -yaw, 0, 'YXZ'))
      ;(rotation.value as Matrix3).setFromMatrix4(view)
      inverse.copy(view).transpose()
      let easing = false
      const data = spots.array as Float32Array
      for (const [i, marker] of points.entries()) {
        local.copy(marker.dir).applyMatrix4(inverse)
        // In front of the viewer: projected into box UV.
        if (local.z < -1e-3) {
          marker.x = 0.5 + (0.5 * local.x) / (-local.z * halfX)
          marker.y = 0.5 + (0.5 * local.y) / (-local.z * halfY)
        } else marker.x = Number.NaN
        const target = marker === lit ? 1 : 0
        if (marker.lit !== target) {
          marker.lit = reduced ? target : damp(marker.lit, target, 0.08, dt, 1e-3)
          easing ||= marker.lit !== target
        }
        const ringOn = ringed !== undefined && marker === focused && visible(ringed) ? 1 : 0
        // Behind the viewer: placed far outside the box.
        data.set([Number.isNaN(marker.x) ? -10 : marker.x, marker.y, marker.lit, ringOn], i * 4)
      }
      spots.needsUpdate = points.length > 0
      pinMesh.visible = points.length > 0
      outline.update()

      motion.fast =
        grab !== undefined ||
        pinch !== undefined ||
        vYaw !== 0 ||
        vPitch !== 0 ||
        turn !== undefined ||
        nudgeYaw !== 0 ||
        nudgePitch !== 0 ||
        fov !== fovAim ||
        fading ||
        easing
      motion.spinning = spins && !held && !waiting
    }
  },
})
export default panorama
