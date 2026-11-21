import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp, ease, roundedBox } from '@dioramajs/effects/kit'
import {
  abs,
  clamp,
  cos,
  dot,
  max,
  min,
  mix,
  positionLocal,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import {
  DataTexture,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { leases, slots } from './slots'

type V2 = Node<'vec2'>
type V4 = Node<'vec4'>
type Params = {
  mode: ChoiceParam<'follow' | 'beside' | 'fixed'>
  items: string
  width: number
  ratio: 'auto'
  ease: number
  stretch: number
  tilt: number
  duration: number
  offset: readonly [number, number]
  radius: number
}

/** Pointer speed in px/s at which the stretch and the tilt are full. */
const FULL = 2000
/** Gap between a focused item's text and its picture, px. */
const GAP = 24
/** Pictures leased at once: the item, its neighbours and the latest ones. */
const HELD = 8
/** Appear and crossfade under reduced motion, s. */
const CALM = 0.15

const sizeOf = (texture: Texture | undefined): { width?: number; height?: number } =>
  (texture?.image as { width?: number; height?: number } | undefined) ?? {}

const clampSigned = (value: number): number => Math.max(-1, Math.min(1, value))
/** Between two aspects, or the one that is known. */
const between = (a: number, b: number, t: number): number => (a && b ? a + (b - a) * t : a || b)

/** Height over width of a picture, 0 while unknown. */
function aspect(texture: Texture | undefined): number {
  const { width, height } = sizeOf(texture)
  return width && height ? height / width : 0
}

/**
 * object-fit: cover of a picture in a `frameWidth` x `frameHeight` frame, centred and zoomed by
 * `zoom`, as (scale u, scale v, offset u, offset v) of the frame's UV.
 */
function cover(
  texture: Texture | undefined,
  frameWidth: number,
  frameHeight: number,
  zoom: number,
  out: Vector4,
) {
  const { width = 0, height = 0 } = sizeOf(texture)
  const scale =
    width && height && frameWidth && frameHeight
      ? Math.max(frameWidth / width, frameHeight / height)
      : 0
  const scaleU = scale ? frameWidth / (width * scale) / zoom : 1 / zoom
  const scaleV = scale ? frameHeight / (height * scale) / zoom : 1 / zoom
  out.set(scaleU, scaleV, (1 - scaleU) / 2, (1 - scaleV) / 2)
}

/** Where a focused item shows its picture: past the right edge of its text, at its middle. */
function beside(item: Element): { x: number; y: number } {
  const box = item.getBoundingClientRect()
  const range = document.createRange()
  range.selectNodeContents(item)
  const text = range.getBoundingClientRect()
  return { x: (text.width ? text.right : box.right) + GAP, y: box.top + box.height / 2 }
}

/**
 * Over a list of links, the picture of the item under the pointer follows it: it appears, trails
 * with a stretch from the pointer's speed and crossfades between items. In `beside` it stands next
 * to the item's text instead, in `fixed` at the middle of the list. Keyboard focus shows the
 * picture beside the focused item. The list itself stays DOM.
 */
const hoverPreview: Effect<Params> = defineEffect({
  name: 'hover-preview',
  params: {
    mode: oneOf('follow', 'beside', 'fixed'),
    items: ':scope > *',
    width: 320,
    ratio: 'auto',
    ease: 0.15,
    stretch: 0.4,
    tilt: 6,
    duration: 0.35,
    offset: [0, 0],
    radius: 0,
  },
  on: ':not(img, video, canvas)',
  when: '(hover: hover) and (pointer: fine)',
  presence: 'fade',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u, render } = ctx
    const list = ctx.element as HTMLElement
    const images = new Map<string, HTMLImageElement>()
    const pictures = leases(ctx, (url: string) => images.get(url) ?? url)
    // Items are looked up again after the list changes, when next needed.
    let found: Element[] | undefined
    const items = (): Element[] => {
      found ??= [...list.querySelectorAll(params.items)]
      return found
    }
    const itemOf = (target: EventTarget | null): Element | undefined =>
      target instanceof Element ? items().find((item) => item.contains(target)) : undefined
    /** The item's picture: data-dio-src, else the current source of its first <img>. */
    const sourceOf = (item: Element | undefined): string | undefined => {
      if (!item) return undefined
      const src = item.getAttribute('data-dio-src')?.trim()
      if (src) return src
      const img = item.querySelector('img')
      const url = img?.currentSrc || img?.src
      if (!img || !url) return undefined
      images.set(url, img)
      return url
    }

    // Until a picture comes: same colour space as the pictures, so swapping never recompiles.
    const blank = new DataTexture(new Uint8Array(4), 1, 1)
    blank.colorSpace = SRGBColorSpace
    blank.needsUpdate = true
    ctx.onDispose(() => blank.dispose())
    // The slots fill the frame as is; the cover crop of each picture is ours, since the frame is
    // not the list's box.
    const pair = slots(ctx, blank, { fit: 'fill' })
    const crop = [uniform(new Vector4(1, 1, 0, 0)), uniform(new Vector4(1, 1, 0, 0))] as const
    const frame = uniform(new Vector2(params.width, params.width))
    // (direction x, y in the mesh's frame, stretch amount, 0) and (crossfade, opacity).
    const warp = uniform(new Vector4())
    const state = uniform(new Vector2())
    const frameSize = frame as unknown as V2
    const warpNode = warp as unknown as V4
    const stateNode = state as unknown as V2

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const direction = warpNode.xy
    const normal = vec2(direction.y.negate(), direction.x)
    const local = positionLocal.xy.mul(frameSize)
    const along = dot(local, direction)
    const across = dot(local, normal)
    const stretch = warpNode.z
    // Longer along the motion, thinner across it, the middle bowed back like paper in a draught.
    const bow = cos(across.div(max(dot(abs(normal), frameSize), 1)).mul(Math.PI)).mul(
      stretch,
      min(frameSize.x, frameSize.y),
      0.08,
    )
    material.positionNode = vec3(
      local
        .add(direction.mul(along.mul(stretch).mul(0.35)))
        .sub(normal.mul(across.mul(stretch).mul(0.12)))
        .sub(direction.mul(bow)),
      0,
    )
    const meshUv = uv()
    const framed = (cropNode: V4): V2 => meshUv.mul(cropNode.xy).add(cropNode.zw)
    const color = mix(
      pair.pick(pair.a, framed(crop[0] as unknown as V4)),
      pair.pick(pair.b, framed(crop[1] as unknown as V4)),
      stateNode.x,
    )
    // Signed distance to the rounded frame, px: negative inside.
    const radius = min(u.radius, min(frameSize.x, frameSize.y).mul(0.5))
    const edge = roundedBox(meshUv.sub(0.5).mul(frameSize), frameSize.mul(0.5), radius)
    material.colorNode = color.rgb
    material.opacityNode = color.a.mul(clamp(edge.negate().add(0.5), 0, 1), stateNode.y, u.opacity)
    const mesh = new Mesh(new PlaneGeometry(1, 1, 16, 16), material)
    mesh.frustumCulled = false
    ctx.overlay.add(mesh)
    // Compiled now, so the first hover does not wait for its shader.
    await ctx.compile(mesh)
    mesh.visible = false
    if (signal.aborted) return

    // Picture in slot a, and the one coming into slot b with the crossfade's progress.
    let shown: string | undefined
    let textures: [Texture | undefined, Texture | undefined] = [undefined, undefined]
    let incoming: string | undefined
    let crossfade = 0
    // Appearance: value, goal, start value and time since the goal changed.
    let visibility = 0
    let goal = 0
    let from = 0
    let clock = 0
    let snap = true
    let wanted: string | undefined
    let waiting: string | undefined
    let recent: string[] = []
    // Where the picture is headed, where it is and how fast it moves, in viewport px.
    const aim = new Vector2()
    const position = new Vector2()
    const velocity = new Vector2()
    const worldPoint = { x: 0, y: 0 }

    let over = false
    let pointing = true
    let hovered: Element | undefined
    let focused: Element | undefined
    const wake = (): void => ctx.invalidate()
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => list.addEventListener(type, handler, { signal })
    listen('pointerover', (e) => {
      if (e.pointerType === 'touch') return
      // Between items the picture of the last one stays.
      const item = itemOf(e.target) ?? hovered
      // Away from the pointer, entering a child of the same item changes nothing to draw.
      const same = over && pointing && item === hovered && params.mode !== 'follow'
      over = true
      pointing = true
      hovered = item
      if (!same) wake()
    })
    // Moving the pointer over the list takes over from the keyboard.
    listen('pointermove', (e) => {
      if (e.pointerType === 'touch' || pointing) return
      over = pointing = true
      hovered = itemOf(e.target) ?? hovered
      wake()
    })
    listen('pointerleave', (e) => {
      if (e.pointerType === 'touch') return
      over = false
      wake()
    })
    listen('focusin', (e) => {
      const item = itemOf(e.target)
      if (!item) return
      focused = item
      pointing = false
      wake()
    })
    listen('focusout', (e) => {
      if (e.relatedTarget instanceof Element && list.contains(e.relatedTarget)) return
      focused = undefined
      wake()
    })
    const observer = new MutationObserver(() => {
      found = undefined
      if (visibility || goal) wake()
    })
    observer.observe(list, { attributes: true, childList: true, subtree: true })
    ctx.onDispose(() => observer.disconnect())

    const show = (url: string, texture: Texture): void => {
      pair.show(texture)
      textures = [texture, texture]
      shown = url
      incoming = undefined
      crossfade = 0
    }
    const appear = (to: number): void => {
      if (goal === to) return
      goal = to
      from = visibility
      clock = 0
    }
    /** Leases the item's picture first, then its neighbours and the latest ones, at most HELD. */
    const hold = (url: string, item: Element): void => {
      recent = [url, ...recent.filter((other) => other !== url)].slice(0, HELD)
      const all = items()
      const i = all.indexOf(item)
      const near = i < 0 ? [] : [1, -1, 2, -2].map((step) => sourceOf(all[i + step]))
      const keep = [url, shown, incoming, ...near, ...recent].filter((key): key is string => !!key)
      pictures.keep(...[...new Set(keep)].slice(0, HELD))
    }
    /** Shows the wanted picture once it is in, or crossfades to it from the one shown. */
    const pick = (url: string | undefined): void => {
      const lease = url ? pictures.get(url) : undefined
      const texture = lease?.texture
      if (lease && !texture && !lease.failed && waiting !== url) {
        waiting = url
        void lease.ready.then(wake)
      }
      if (url && texture) {
        waiting = undefined
        if (!shown || (!visibility && !goal)) {
          show(url, texture)
          snap = true
        } else if (url !== shown && !incoming) {
          pair.next(texture)
          textures[1] = texture
          incoming = url
          crossfade = 0
        }
        if (url === shown || incoming) appear(1)
      } else if (!url || lease?.failed) appear(0)
    }
    /**
     * Where the picture goes. follow: the pointer while it is over the list or the picture
     * leaves, else beside the focused item; only then is the pointer read, so moves elsewhere on
     * the page draw nothing. beside: next to the item's text. fixed: the list's middle.
     */
    const place = (item: Element | undefined, width: number, height: number): void => {
      const [offsetX, offsetY] = params.offset
      const mode = params.mode
      if (mode === 'fixed') {
        const rect = list.getBoundingClientRect()
        aim.set(rect.left + rect.width / 2 + offsetX, rect.top + rect.height / 2 + offsetY)
        return
      }
      if (pointing && mode === 'follow') {
        const { x, y } = app.pointer.state
        aim.set(x + offsetX, y + offsetY)
        return
      }
      // Shown last: hidden, the item stays where it was while the picture fades out.
      const target = item ?? (pointing ? hovered : focused)
      if (!target || !list.contains(target)) return
      const at = beside(target)
      const viewportWidth = app.stage.width.peek()
      const viewportHeight = app.stage.height.peek()
      const x = at.x + width / 2 + (mode === 'beside' ? offsetX : 0)
      const y = at.y + (mode === 'beside' ? offsetY : 0)
      aim.set(
        Math.max(width / 2, Math.min(viewportWidth - width / 2, x)),
        Math.max(height / 2, Math.min(viewportHeight - height / 2, y)),
      )
    }
    /** Eases the picture towards the aim and measures its speed. */
    const follow = (delta: number, calm: boolean): void => {
      if (snap || calm) {
        position.copy(aim)
        velocity.set(0, 0)
        snap = false
      } else if (delta > 0) {
        const { x, y } = position
        position.set(damp(x, aim.x, params.ease, delta), damp(y, aim.y, params.ease, delta))
        velocity.set(
          damp(velocity.x, (position.x - x) / delta, 0.1, delta),
          damp(velocity.y, (position.y - y) / delta, 0.1, delta),
        )
      }
    }

    return (input): boolean => {
      const delta = input.delta
      const calm = input.reducedMotion
      const item = pointing ? (over ? hovered : undefined) : focused
      const url = item && list.contains(item) ? sourceOf(item) : undefined
      if (url && item && url !== wanted) hold(url, item)
      wanted = url
      pick(url)
      if (visibility !== goal) {
        clock += delta
        const span = calm ? CALM : goal ? params.duration : 0.6 * params.duration
        const progress = clock / Math.max(span, 1e-3)
        visibility =
          progress >= 1
            ? goal
            : from + (goal - from) * (calm ? progress : ease('expoOut', progress))
      }
      // Hidden: nothing drawn, and the pointer is not read, so its moves draw no frames.
      if (!visibility && !goal) {
        mesh.visible = false
        return false
      }
      if (incoming) {
        crossfade += delta / Math.max(calm ? CALM : params.duration, 1e-3)
        const done = pictures.peek(incoming)?.texture
        if (crossfade >= 1 && done) show(incoming, done)
      }
      const fade = calm ? Math.min(crossfade, 1) : ease('cubicInOut', crossfade)

      const width = params.width
      const [fromTexture, toTexture] = textures
      const ratio =
        params.ratio === 'auto'
          ? between(aspect(fromTexture), aspect(toTexture), fade) || 0.75
          : 1 / Math.max(params.ratio, 0.1)
      const height = width * ratio
      place(item, width, height)
      follow(delta, calm)
      const speed = Math.hypot(velocity.x, velocity.y)
      const resting = speed < 1 && position.distanceTo(aim) < 0.1
      if (resting) {
        position.copy(aim)
        velocity.set(0, 0)
      }

      const amount = resting ? 0 : params.stretch * Math.min(1, speed / FULL)
      // Turned clockwise moving right; the stretch direction is given in the turned frame.
      const angle = resting ? 0 : -((params.tilt * Math.PI) / 180) * clampSigned(velocity.x / FULL)
      const cosAngle = Math.cos(angle)
      const sinAngle = Math.sin(angle)
      const directionX = speed ? velocity.x / speed : 0
      const directionY = speed ? -velocity.y / speed : 0
      ;(warp.value as Vector4).set(
        directionX * cosAngle + directionY * sinAngle,
        directionY * cosAngle - directionX * sinAngle,
        amount,
        0,
      )
      mesh.rotation.z = angle
      ;(frame.value as Vector2).set(width, height)
      cover(fromTexture, width, height, 1, crop[0].value as Vector4)
      // The incoming picture settles from a slight zoom.
      const settle = calm ? 1 : 1.04 - 0.04 * ease('expoOut', crossfade)
      cover(toTexture, width, height, settle, crop[1].value as Vector4)
      ;(state.value as Vector2).set(fade, visibility)
      const world = render.toWorld(position.x, position.y, worldPoint)
      mesh.position.set(world.x, world.y, 0)
      mesh.scale.setScalar(calm ? 1 : 0.85 + 0.15 * visibility)
      mesh.visible = visibility > 0
      return visibility !== goal || !!incoming || !resting
    }
  },
})
export default hoverPreview
