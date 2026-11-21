import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { radii, rng, roundedBox } from '@dioramajs/effects/kit'
import {
  clamp,
  cos,
  float,
  max,
  mix,
  positionGeometry,
  sin,
  smoothstep,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type Texture,
  type UniformNode,
  Vector4,
} from 'three/webgpu'
import { afterDrag } from './click'
import { boxRing } from './focus'
import { framing, leases } from './slots'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V4 = Node<'vec4'>
/** How the cards lie under the top one. */
export type StackStyle = 'pile' | 'fan' | 'cascade'
type Params = {
  index: number
  style: ChoiceParam<StackStyle>
  rotate: number
  offset: number
  duration: number
  shadow: number
  loop: boolean
  swipe: boolean
  click: boolean
  items: string
  seed: number
}

/** Cards drawn behind the top one. */
const BEHIND = 3
/** Room around a card for its shadow, px. */
const PAD = 48
/** Pointer travel that still counts as a tap, px. */
const TAP = 8
/** Release speed that throws the card however far it went, px/ms. */
const FLICK = 0.5
/** Colour of a card whose picture is not in. */
const PAPER = vec3(0.93, 0.92, 0.9)
/** A click or a key throws the card to the left and a little up. */
const LEFT = { x: -0.97, y: 0.24 }

/** Where a card sits: x, y px from the box centre (y up), angle in radians, scale. */
export interface Pose {
  x: number
  y: number
  angle: number
  scale: number
}

/** Scatter of a card in the pile, each part -1..1, the same for a card on every load. */
export function scatter(seed: number, card: number): [number, number, number] {
  const random = rng(Math.imul(seed, 7919) + card * 104729 + 1)
  return [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]
}

/**
 * The pose of a card at a whole depth in the pile: 0 is the top, which sits on the box. `width`
 * and `height` are the box, `rotate` in degrees, `offset` in px.
 */
export function slot(
  style: StackStyle,
  depth: number,
  jitter: readonly [number, number, number],
  width: number,
  height: number,
  rotate: number,
  offset: number,
): Pose {
  if (depth <= 0) return { x: 0, y: 0, angle: 0, scale: 1 }
  const radians = (rotate * Math.PI) / 180
  if (style === 'fan') {
    // Alternate sides and open wider with depth, about a pivot under the bottom edge.
    const angle = (depth % 2 ? -1 : 1) * Math.ceil(depth / 2) * radians
    const reach = height / 2 + 4 * offset
    return {
      x: -Math.sin(angle) * reach,
      y: -reach + Math.cos(angle) * reach,
      angle,
      scale: 1,
    }
  }
  if (style === 'cascade') {
    // Smaller and higher, each top edge `offset` above the one in front.
    const scale = Math.max(0.6, 1 - 0.06 * depth)
    return { x: 0, y: (height / 2) * (1 - scale) + offset * depth, angle: 0, scale }
  }
  return {
    x: jitter[0] * offset,
    y: jitter[1] * offset * (height / Math.max(width, 1)) ** 0.5,
    angle: jitter[2] * radians,
    scale: 1,
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const outCubic = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

/** A touch or pen drag needs the site to keep pans from the page. */
const ownsPan = (el: Element): boolean =>
  !/auto|manipulation/.test(getComputedStyle(el).touchAction || 'auto')

/** One drawn card: its picture swaps without a recompile. */
interface Card {
  readonly mesh: Mesh
  /** x, y, angle, scale. */
  readonly pose: UniformNode<'vec4'>
  /** alpha, brightness, lift 0..1, picture in 0/1. */
  readonly look: UniformNode<'vec4'>
  set(texture: Texture | undefined, picture: number): void
}

/**
 * The images of a container as a pile of cards. A drag, a swipe, a click or a key throws the top
 * card off and brings the next one forward. Fires `dio:index` on the container when a card is on
 * top.
 */
const stack: Effect<Params> = defineEffect({
  name: 'stack',
  params: {
    index: 0,
    style: oneOf('pile', 'fan', 'cascade'),
    rotate: 6,
    offset: 12,
    duration: 0.6,
    shadow: 0.35,
    loop: true,
    swipe: true,
    click: true,
    items: 'img',
    seed: 1,
  },
  on: ':not(img, video, canvas)',
  // Cards behind the top one and their shadows reach past the box.
  bleed: 160,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u } = ctx
    const el = ctx.element as HTMLElement
    const items = [...el.querySelectorAll(params.items)].filter(
      (node): node is HTMLImageElement => node.localName === 'img',
    )
    const count = items.length
    if (!count) {
      app.log.warn(`stack: no images match "${params.items}", the container stays as it is`)
      return
    }
    const style = params.style
    const wrap = (i: number): number => ((i % count) + count) % count
    const bound = (i: number): number => (params.loop ? i : Math.min(count - 1, Math.max(0, i)))
    const exists = (i: number): boolean => params.loop || (i >= 0 && i < count)
    const pictures = leases(ctx, (i: number) => items[i] as HTMLImageElement)
    // A card is framed like its image, cut to the box unless the image asks for contain.
    const frameOf = (i: number) => {
      const framed = framing(items[i] as Element)
      const fit = framed.fit === 'contain' || framed.fit === 'scale-down' ? framed.fit : 'cover'
      return { ...framed, fit } as const
    }

    let pos = bound(Number.isFinite(params.index) ? params.index : 0)
    /** The cards around `topCard`: the one thrown before it, it, and the pile under it. */
    const wanted = (topCard: number): number[] => {
      const out: number[] = []
      for (let depth = -1; depth <= BEHIND + 1; depth++) {
        const place = topCard + depth
        if (exists(place) && !out.includes(wrap(place))) out.push(wrap(place))
      }
      // The top card first: it leases at high priority.
      const first = wrap(topCard)
      return out.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0))
    }
    let held = Math.floor(pos)
    pictures.keep(...wanted(held))
    // The top card and the pile in before the copy shows.
    await Promise.all(wanted(held).map((i) => pictures.get(i).ready))
    if (signal.aborted) return
    const top = pictures.peek(wrap(held))
    if (!top?.texture) throw new Error(`stack: card ${wrap(held)} did not load`)
    for (const i of wanted(held)) {
      const lease = pictures.peek(i)
      if (lease && !lease.texture && !lease.failed) void lease.ready.then(() => ctx.invalidate())
    }

    const box = u.size as unknown as V2
    const radius = uniform(0)
    const shadow = u.shadow as unknown as F
    const opacity = u.opacity as unknown as F
    // The nearest clipping ancestor at box UV: thrown cards leave the box, where `ctx.mask` is 0.
    const layer = ctx.layer as unknown as { clipMask?(at: V2): F }
    const clip = (at: V2): F => layer.clipMask?.(at) ?? (float(1) as unknown as F)

    const card = (): Card => {
      const fit = ctx.fit(top.texture as Texture, frameOf(wrap(held)))
      const pose = uniform(new Vector4(0, 0, 0, 1))
      const look = uniform(new Vector4(0, 1, 0, 1))
      const poseNode = pose as unknown as V4
      const lookNode = look as unknown as V4
      const lift = lookNode.z
      const quad = box.add(PAD * 2)
      const local = positionGeometry.xy.mul(quad).mul(poseNode.w)
      const cosAngle = cos(poseNode.z)
      const sinAngle = sin(poseNode.z)
      const placed = vec2(
        local.x.mul(cosAngle).sub(local.y.mul(sinAngle)),
        local.x.mul(sinAngle).add(local.y.mul(cosAngle)),
      ).add(poseNode.xy)
      const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      material.positionNode = vec3(placed, 0)
      // px from the card's centre in its own frame, and its picture.
      const point = uv().sub(0.5).mul(quad) as unknown as V2
      const cornerRadius = radius as unknown as F
      const edge = roundedBox(point, box.mul(0.5) as V2, cornerRadius)
      const inside = clamp(float(0.5).sub(edge), 0, 1)
      const at = point.div(box).add(0.5) as unknown as V2
      const picture = fit.sample(at)
      const covered = fit.mask(at).mul(picture.a, lookNode.w)
      const rgb = mix(PAPER, picture.rgb, covered).mul(lookNode.y)
      // A soft shadow below the card on screen, longer and softer while it is lifted.
      const drop = lift.mul(8).add(4)
      const blur = lift.mul(14).add(14)
      const below = vec2(sinAngle.mul(drop).negate(), cosAngle.mul(drop).negate())
      const shadowEdge = roundedBox(point.sub(below) as V2, box.mul(0.5) as V2, cornerRadius)
      const shade = smoothstep(blur, blur.mul(-0.4), shadowEdge).mul(
        shadow,
        lift.mul(0.5).add(1),
        0.6,
      )
      const alpha = inside.add(shade.mul(inside.oneMinus()))
      const boxAt = (varying(placed) as unknown as V2).div(box).add(0.5) as unknown as V2
      material.colorNode = vec4(
        rgb.mul(inside).div(max(alpha, 1e-4)),
        alpha.mul(lookNode.x, opacity, clip(boxAt)),
      )
      const mesh = new Mesh(new PlaneGeometry(1, 1), material)
      mesh.frustumCulled = false
      let shown = -2
      return {
        mesh,
        pose: pose as unknown as UniformNode<'vec4'>,
        look: look as unknown as UniformNode<'vec4'>,
        set(texture, i) {
          ;(look.value as Vector4).w = texture ? 1 : 0
          if (!texture || i === shown) return
          shown = i
          fit.set(texture, frameOf(i))
        },
      }
    }
    // The pile from the deepest card up, then the card in flight.
    const cards = Array.from({ length: BEHIND + 2 }, card)
    const ring = boxRing(ctx, el)
    ring.mesh.renderOrder = 20
    const group = new Group()
    group.add(...cards.map((drawn) => drawn.mesh), ring.mesh)
    ctx.place(group, { replace: true, fit: 'none' })

    // State: pos is the top card, a fraction while one is in flight.
    let aim = Number.isInteger(params.index) ? params.index : Math.round(pos)
    let reached = Number.isInteger(pos) ? pos : Number.NaN
    /** The eased move to `index`: `t` its progress 0..1, `length` its duration in s. */
    let easing: { from: number; to: number; t: number; length: number } | undefined
    /** A card let go short of a throw, springing back from (x, y) px. */
    let spring: { x: number; y: number; t: number } | undefined
    /**
     * The top card in hand: `k` the card, `x` and `y` the press, `v` its offset from its place
     * (px, y up), `speed` px/ms and the latest sample.
     */
    let drag:
      | {
          id: number
          k: number
          x: number
          y: number
          v: { x: number; y: number }
          speed: { x: number; y: number }
          last: { x: number; y: number; at: number }
        }
      | undefined
    let press: { id: number; x: number; y: number; pan: boolean } | undefined
    /** Unit direction each thrown card flew, by its place in the deck. */
    const dirs = new Map<number, { x: number; y: number }>()
    const drags = afterDrag(el, signal)
    let size = { w: 0, h: 0 }

    const step = (by: number, dir = LEFT): void => {
      if (drag) return
      const i = Math.round(params.index)
      if (!params.loop && (i + by < 0 || i + by > count - 1)) return
      for (let thrown = i; thrown < i + by; thrown++) dirs.set(thrown, dir)
      // Forget old throws, keeping those near the top.
      if (dirs.size > 64) {
        for (const thrown of dirs.keys()) if (Math.abs(thrown - i) > 8) dirs.delete(thrown)
      }
      ctx.set({ index: i + by })
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler, { signal })
    // The cards' images are the site's; dragging one would pick it up.
    listen('dragstart', (e) => e.preventDefault())
    listen('pointerdown', (e) => {
      if (e.button !== 0 || drag) return
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        pan: e.pointerType === 'mouse' || ownsPan(el),
      }
    })
    listen('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return
      const dx = e.clientX - press.x
      const dy = e.clientY - press.y
      if (!drag) {
        if (!params.swipe || !press.pan || easing || spring || ctx.input.reducedMotion) return
        if (Math.hypot(dx, dy) < TAP || !Number.isInteger(pos)) return
        drag = {
          id: press.id,
          k: pos,
          x: press.x,
          y: press.y,
          v: { x: 0, y: 0 },
          speed: { x: 0, y: 0 },
          last: { x: e.clientX, y: e.clientY, at: e.timeStamp },
        }
        try {
          // Moves past the box still carry the card.
          el.setPointerCapture(e.pointerId)
        } catch {
          // The pointer is gone already: its up or cancel follows.
        }
      }
      // The last card without loop stays: it follows the pointer only a little.
      const give = !params.loop && drag.k >= count - 1 ? 0.2 : 1
      drag.v = { x: dx * give, y: -dy * give }
      const elapsed = e.timeStamp - drag.last.at
      if (elapsed > 0) {
        const speedX = (e.clientX - drag.last.x) / elapsed
        const speedY = -(e.clientY - drag.last.y) / elapsed
        drag.speed = {
          x: drag.speed.x * 0.5 + speedX * 0.5,
          y: drag.speed.y * 0.5 + speedY * 0.5,
        }
        drag.last = { x: e.clientX, y: e.clientY, at: e.timeStamp }
      }
      ctx.invalidate()
    })
    const release = (e: PointerEvent, cancelled: boolean): void => {
      const from = press
      if (from?.id === e.pointerId) {
        press = undefined
        const dx = e.clientX - from.x
        const dy = e.clientY - from.y
        // A press that moved is a drag or a swipe: its click throws nothing.
        if (!cancelled && Math.hypot(dx, dy) > TAP) {
          drags.arm(e)
          // Without the card in hand (reduced motion), a swipe still throws it.
          const length = Math.hypot(dx, dy)
          if (!drag && params.swipe && from.pan && length > 40) {
            step(1, { x: dx / length, y: -dy / length })
          }
        }
      }
      const ended = drag
      if (!ended || e.pointerId !== ended.id) return
      drag = undefined
      const distance = Math.hypot(ended.v.x, ended.v.y)
      const { w, h } = size
      const fresh = e.timeStamp - ended.last.at < 100
      // The release speed along the way the card moved.
      const along =
        (ended.speed.x * ended.v.x + ended.speed.y * ended.v.y) / Math.max(distance, 1e-6)
      const flick = fresh && along > FLICK
      const last = !params.loop && ended.k >= count - 1
      if (!cancelled && !last && distance > 0 && (distance > 0.35 * w || flick)) {
        dirs.set(ended.k, { x: ended.v.x / distance, y: ended.v.y / distance })
        pos = ended.k + Math.min(distance / travel(w, h), 0.95)
        ctx.set({ index: ended.k + 1 })
      } else spring = { x: ended.v.x, y: ended.v.y, t: 0 }
      ctx.invalidate()
    }
    listen('pointerup', (e) => release(e, false))
    listen('pointercancel', (e) => release(e, true))
    listen('click', (e) => {
      if (!params.click || drags.ends(e)) return
      // Flicked from the side that was clicked: away from the pointer.
      const rect = el.getBoundingClientRect()
      const x = e.clientX < rect.left + rect.width / 2 ? -LEFT.x : LEFT.x
      step(1, { x, y: LEFT.y })
    })
    listen('keydown', (e) => {
      if (e.target !== el || e.altKey || e.ctrlKey || e.metaKey) return
      const i = Math.round(params.index)
      const lap = i - wrap(i)
      const by =
        e.key === 'ArrowRight' || e.key === 'PageDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'PageUp'
            ? -1
            : e.key === 'Home'
              ? (params.loop ? lap : 0) - i
              : e.key === 'End'
                ? (params.loop ? lap : 0) + count - 1 - i
                : undefined
      if (by === undefined) return
      e.preventDefault()
      if (by) step(by)
    })

    const pose: Pose = { x: 0, y: 0, angle: 0, scale: 1 }
    /** The pose of card `place` at a fractional depth: between the slots either side. */
    const at = (place: number, depth: number, width: number, height: number): Pose => {
      const jitter = scatter(params.seed, wrap(place))
      const whole = Math.floor(depth)
      const above = slot(style, whole, jitter, width, height, params.rotate, params.offset)
      const below = slot(style, whole + 1, jitter, width, height, params.rotate, params.offset)
      const t = depth - whole
      pose.x = lerp(above.x, below.x, t)
      pose.y = lerp(above.y, below.y, t)
      pose.angle = lerp(above.angle, below.angle, t)
      pose.scale = lerp(above.scale, below.scale, t)
      return pose
    }
    const show = (
      target: Card,
      place: number,
      placed: Pose,
      alpha: number,
      bright: number,
      lift = 0,
    ) => {
      const i = wrap(place)
      const lease = pictures.peek(i)
      target.set(lease?.texture, i)
      ;(target.pose.value as Vector4).set(placed.x, placed.y, placed.angle, placed.scale)
      const look = target.look.value as Vector4
      look.set(alpha, bright, lift, look.w)
      target.mesh.visible = alpha > 0.001
    }

    return (input): boolean => {
      const { width, height } = input
      if (width !== size.w || height !== size.h) {
        size = { w: width, h: height }
        radius.value = radii(el, width, height)[0]
      }
      const calm = input.reducedMotion
      const wantedIndex = params.index
      if (!Number.isInteger(wantedIndex)) {
        // Scrubbed (a tween): the card exactly that far in flight.
        pos = bound(wantedIndex)
        aim = Number.NaN
        easing = undefined
      } else if (wantedIndex !== aim) {
        aim = wantedIndex
        const to = bound(wantedIndex)
        const span = Math.abs(to - pos)
        if (calm || span === 0) {
          pos = to
          easing = undefined
        } else {
          // Longer moves take longer, but less than in proportion.
          const length = params.duration * (span <= 1 ? Math.max(span, 0.2) : Math.sqrt(span))
          easing = { from: pos, to, t: 0, length }
        }
      }
      if (easing) {
        easing.t += calm ? 1 : input.delta / Math.max(easing.length, 1e-3)
        pos = lerp(easing.from, easing.to, outCubic(easing.t))
        if (easing.t >= 1) {
          pos = easing.to
          easing = undefined
        }
      }
      if (spring) {
        spring.t += calm ? 1 : input.delta / 0.35
        if (spring.t >= 1) spring = undefined
      }
      const moving = !!(easing || spring)

      const topCard = Math.floor(pos)
      if (topCard !== held) {
        held = topCard
        pictures.keep(...wanted(topCard))
        for (const i of wanted(topCard)) {
          const lease = pictures.peek(i)
          if (lease && !lease.texture && !lease.failed)
            void lease.ready.then(() => ctx.invalidate())
        }
      }
      // The card in flight: by the pointer, springing back, or along the way it was thrown.
      const far = travel(width, height)
      // The offset of the card in flight from its place, px.
      let offsetX = 0
      let offsetY = 0
      if (drag) {
        offsetX = drag.v.x
        offsetY = drag.v.y
      } else if (spring) {
        const left = 1 - outCubic(spring.t)
        offsetX = spring.x * left
        offsetY = spring.y * left
      } else {
        const thrown = pos - topCard
        const dir = dirs.get(topCard) ?? LEFT
        offsetX = dir.x * far * thrown
        offsetY = dir.y * far * thrown
      }
      const distance = Math.hypot(offsetX, offsetY)
      // The pile moves up a place while the card clears about a box's length.
      const risen = Math.min(1, distance / (0.6 * Math.max(width, height, 1)))
      const deepest = params.loop ? Math.min(BEHIND, count - 1) : BEHIND
      const last = params.loop ? Math.min(BEHIND + 1, count) : BEHIND + 1
      for (let depth = last + 1; depth <= BEHIND + 1; depth++)
        (cards[BEHIND + 1 - depth] as Card).mesh.visible = false
      for (let place = last; place >= 1; place--) {
        const target = cards[BEHIND + 1 - place] as Card
        const item = topCard + place
        target.mesh.renderOrder = 10 - place
        if (!exists(item)) {
          target.mesh.visible = false
          continue
        }
        const depth = place - risen
        const alpha = Math.min(1, Math.max(0, deepest + 1 - depth))
        show(target, item, at(item, depth, width, height), alpha, 1 - 0.05 * depth)
      }
      const flying = cards[BEHIND + 1] as Card
      flying.mesh.renderOrder = 11
      if (exists(topCard)) {
        const lift = Math.min(1, distance / 40)
        pose.x = offsetX
        pose.y = offsetY
        // Tilted by the sideways move, at most 0.7 rad.
        pose.angle = Math.max(-0.7, Math.min(0.7, (-offsetX / Math.max(width, 1)) * 0.3))
        pose.scale = 1 + 0.03 * lift
        const alpha = 1 - smooth(0.45 * far, far, distance)
        show(flying, topCard, pose, alpha, 1, lift)
      } else flying.mesh.visible = false
      ring.update()
      ring.mesh.scale.set(width || 1, height || 1, 1)

      if (!drag && !spring && !easing && Number.isInteger(pos) && pos !== reached) {
        reached = pos
        el.dispatchEvent(
          new CustomEvent('dio:index', { detail: { index: wrap(pos) }, bubbles: true }),
        )
      }
      return moving
    }
  },
})
export default stack

/** How far a thrown card flies before it is gone, px. */
export const travel = (width: number, height: number): number => 1.5 * Math.max(width, height) + 100

/** smoothstep: 0 at `a`, 1 at `b`, eased between. */
function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
