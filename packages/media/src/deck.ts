// Shared by the effects that lay the images of a container out as cards in space (coverflow,
// carousel, polaroids). One quad per card with its own picture framed like CSS object-fit, a
// paper border, a floor reflection, a drop shadow and the focus ring; the pose is set on the CPU,
// and the same maths on the CPU tells which card is under the pointer.
import type { EffectContext, FitOptions } from '@dioramajs/effects'
import { roundedBox } from '@dioramajs/effects/kit'
import {
  clamp,
  cos,
  float,
  frontFacing,
  max,
  mix,
  positionGeometry,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  type TextureNode,
  type UniformNode,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { ringStyle } from './focus'
import { offaxisNode } from './offaxis'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/** Colour of a picture that is not in yet. */
const EMPTY = vec3(0.86, 0.85, 0.83)

/** Where a card is: px from the box centre (y up, z towards the viewer), turns in radians. */
export interface Pose {
  x: number
  y: number
  z: number
  /** Turn about the vertical axis, positive turns the right edge away. */
  yaw: number
  /** Turn about the horizontal axis, positive tips the top towards the viewer. */
  pitch: number
  /** Turn in the page plane, positive is counterclockwise. */
  roll: number
  scale: number
}

/** One drawn card. Write its fields, then `apply()`. */
export interface Card {
  readonly mesh: Mesh
  readonly pose: Pose
  /** Card size in px. */
  readonly size: { w: number; h: number }
  /** Corner radius in px of `size`. */
  radius: number
  alpha: number
  /** 1 as is, lower darker. */
  bright: number
  /** 0 on the table, 1 held up: a longer, softer shadow. */
  lift: number
  /** Draws the focus ring around this card while focus is visible. */
  ring: boolean
  /** The picture and how it is framed; undefined shows the empty card. */
  show(texture: Texture | undefined, frame?: FitOptions): void
  /** Writes the fields to the uniforms. */
  apply(): void
}

/** Looks shared by every card of a deck. */
export interface DeckLook {
  /** CSS-like perspective, px. */
  perspective: number
  /** The whole scene turned about the horizontal axis through `pivot` px deep, radians. */
  tilt: number
  pivot: number
  /** Paper border at the sides and top, and at the bottom, px. 0 for a bare picture. */
  border: number
  bottom: number
  /** Drop shadow strength, 0 for none. */
  shadow: number
  /** Floor reflection opacity, 0 for none, and its length as a fraction of the card's height. */
  reflection: number
  reach: number
}

/** The cards of an effect and their shared looks. */
export interface Deck {
  readonly group: Group
  readonly cards: readonly Card[]
  readonly look: DeckLook
  /** Paper colour as CSS. */
  paper(color: string): void
  /** A new card, added to the group. */
  add(): Card
  /** Call once per frame before drawing: box centre, camera, shared looks. */
  frame(input: { x: number; y: number; width: number; height: number }): void
  /** The corners of a card as seen, px from the box centre, y up. */
  corners(card: Card): [number, number][]
  /** Depth of a card's centre after the scene tilt, for draw order. */
  depth(card: Card): number
  /** The visible card under a point px from the box centre (y up), the frontmost drawn. */
  hit(x: number, y: number): Card | undefined
}

/**
 * object-fit of an `imageWidth` x `imageHeight` picture in a `width` x `height` frame, as
 * (scale u, scale v, offset u, offset v).
 */
export function crop(
  fit: FitOptions['fit'],
  position: readonly [number, number],
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  out: Vector4,
): Vector4 {
  if (!imageWidth || !imageHeight || !width || !height) return out.set(1, 1, 0, 0)
  const scale =
    fit === 'cover'
      ? Math.max(width / imageWidth, height / imageHeight)
      : fit === 'contain'
        ? Math.min(width / imageWidth, height / imageHeight)
        : fit === 'none'
          ? 1
          : fit === 'scale-down'
            ? Math.min(1, width / imageWidth, height / imageHeight)
            : 0
  // The picture's drawn size (fill: the frame) and its offset in the frame, px.
  const drawnWidth = scale ? imageWidth * scale : width
  const drawnHeight = scale ? imageHeight * scale : height
  const offsetX = (width - drawnWidth) * position[0]
  const offsetY = (height - drawnHeight) * position[1]
  const scaleV = height / drawnHeight
  return out.set(
    width / drawnWidth,
    scaleV,
    -offsetX / drawnWidth,
    1 - scaleV + offsetY / drawnHeight,
  )
}

/**
 * A point of a card in px from its centre, posed: scale, roll, pitch, yaw, then moved, then the
 * scene tilt about `pivot`. Mirrors the vertex graph.
 */
export function posed(
  pose: Pose,
  localX: number,
  localY: number,
  tilt: number,
  pivot: number,
): [number, number, number] {
  const scaledX = localX * pose.scale
  const scaledY = localY * pose.scale
  const cosRoll = Math.cos(pose.roll)
  const sinRoll = Math.sin(pose.roll)
  const rolledX = scaledX * cosRoll - scaledY * sinRoll
  const rolledY = scaledX * sinRoll + scaledY * cosRoll
  const pitchedY = rolledY * Math.cos(pose.pitch)
  const pitchedZ = rolledY * Math.sin(pose.pitch)
  const cosYaw = Math.cos(pose.yaw)
  const sinYaw = Math.sin(pose.yaw)
  const x = rolledX * cosYaw + pitchedZ * sinYaw + pose.x
  const y = pitchedY + pose.y
  const z = -rolledX * sinYaw + pitchedZ * cosYaw + pose.z - pivot
  const cosTilt = Math.cos(tilt)
  const sinTilt = Math.sin(tilt)
  return [x, y * cosTilt - z * sinTilt, y * sinTilt + z * cosTilt + pivot]
}

/** Where a point px deep shows with CSS-like `perspective` from the box centre. */
export const seen = (x: number, y: number, z: number, perspective: number): [number, number] => {
  const scale = perspective / Math.max(perspective - z, 1)
  return [x * scale, y * scale]
}

/** Inside a convex quad, either winding. */
function within(quad: readonly [number, number][], x: number, y: number): boolean {
  let sign = 0
  for (let i = 0; i < quad.length; i++) {
    const [ax, ay] = quad[i] as [number, number]
    const [bx, by] = quad[(i + 1) % quad.length] as [number, number]
    // Which side of the edge a to b the point is on.
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (cross === 0) continue
    if (sign && Math.sign(cross) !== sign) return false
    sign = Math.sign(cross)
  }
  return true
}

/**
 * The focus ring of a container whose links or own box take focus: on while it or an element in
 * it matches :focus-visible, in that element's focus style. `changed` runs with the element.
 */
function ringOf(
  ctx: Pick<EffectContext, 'signal' | 'invalidate'>,
  el: Element,
  changed: (focused: Element | null) => void,
) {
  const on = uniform(0)
  const color = uniform(new Color())
  const width = uniform(2)
  const offset = uniform(0)
  const visible = (node: Element): boolean => {
    try {
      return node.matches(':focus-visible')
    } catch {
      return node.matches(':focus')
    }
  }
  let last: Element | null = null
  const check = (): void => {
    const active = document.activeElement
    const focused = active && el.contains(active) && visible(active) ? active : null
    if (focused) {
      const style = ringStyle(focused)
      color.value.setStyle(style.color)
      width.value = style.width
      offset.value = style.offset
    }
    on.value = focused ? 1 : 0
    if (focused === last) return
    last = focused
    changed(focused)
    ctx.invalidate()
  }
  for (const type of ['focusin', 'focusout', 'keydown', 'keyup'])
    el.addEventListener(type, () => queueMicrotask(check), { signal: ctx.signal })
  check()
  const onNode = on as unknown as F
  const widthNode = width as unknown as F
  const offsetNode = offset as unknown as F
  return {
    color: color as unknown as V3,
    // A 1 px antialiased band from `offset` to `offset + width` outside the edge.
    alpha: (edge: F): F =>
      clamp(edge.sub(offsetNode).add(0.5), 0, 1).mul(
        clamp(offsetNode.add(widthNode).sub(edge).add(0.5), 0, 1),
        onNode,
      ) as F,
    pad: (): number => offset.value + width.value + 2,
  }
}

/**
 * Cards for `ctx.place(deck.group, { replace: true, fit: 'none' })`. `focused` runs when focus
 * inside the container moves, with the focused element or null.
 */
export function deck(
  ctx: Pick<EffectContext, 'signal' | 'invalidate' | 'onDispose' | 'layer' | 'render'> & {
    readonly u: { readonly size: UniformNode<'vec2'>; readonly opacity: UniformNode<'float'> }
  },
  el: Element,
  focused: (element: Element | null) => void = () => {},
): Deck {
  const { u, render } = ctx
  const box = u.size as unknown as V2
  const opacity = u.opacity as unknown as F
  const layer = ctx.layer as unknown as { clipMask?(at: V2): F }
  const clip = (at: V2): F => layer.clipMask?.(at) ?? (float(1) as unknown as F)
  const ring = ringOf(ctx, el, focused)

  const look: DeckLook = {
    perspective: 1000,
    tilt: 0,
    pivot: 0,
    border: 0,
    bottom: 0,
    shadow: 0,
    reflection: 0,
    reach: 0.4,
  }
  // Box centre in world px, perspective, camera distance.
  const view = uniform(new Vector4(0, 0, 1000, 1000))
  // cos and sin of the scene tilt, its pivot depth, the room around a card.
  const scene = uniform(new Vector4(1, 0, 0, 8))
  // Border at the sides and top, at the bottom, shadow.
  const paper = uniform(new Vector3())
  // Reflection opacity and length.
  const mirror = uniform(new Vector2())
  const paperColor = uniform(new Color('#fbfaf6'))
  const viewNode = view as unknown as V4
  const sceneNode = scene as unknown as V4
  const cosTilt = sceneNode.x
  const sinTilt = sceneNode.y
  const pivot = sceneNode.z
  const paperNode = paper as unknown as V3
  const border = paperNode.x
  const bottomBorder = paperNode.y
  const mirrorNode = mirror as unknown as V2
  const reflection = mirrorNode.x
  const reflectionReach = mirrorNode.y
  const paperTint = paperColor as unknown as V3

  const blank = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
  blank.colorSpace = SRGBColorSpace
  blank.needsUpdate = true
  ctx.onDispose(() => blank.dispose())

  const group = new Group()
  const cards: Card[] = []
  const world = { x: 0, y: 0 }

  const add = (): Card => {
    const place = uniform(new Vector4())
    const turn = uniform(new Vector4(0, 0, 1, 0))
    const state = uniform(new Vector4(1, 1, 0, 0))
    // Width, height, corner radius.
    const dims = uniform(new Vector3(1, 1, 0))
    const framed = uniform(new Vector4(1, 1, 0, 0))
    const node = texture(blank) as unknown as TextureNode
    // Its own binding: cards compiled on the same texture would otherwise share one.
    ;(node as unknown as { mergeable: boolean }).mergeable = false
    // (x, y, z, yaw), (pitch, roll, scale, ring on), (alpha, brightness, picture in, lift).
    const placeNode = place as unknown as V4
    const turnNode = turn as unknown as V4
    const stateNode = state as unknown as V4
    const scale = turnNode.z
    const dimsNode = dims as unknown as V3
    const size = dimsNode.xy as unknown as V2
    const frameCrop = framed as unknown as V4

    // The quad: the card, room for its shadow and ring, and its reflection below.
    const pad = sceneNode.w
    const below = max(pad, step(0.001, reflection).mul(reflectionReach, size.y))
    const low = vec2(size.x.mul(-0.5).sub(pad), size.y.mul(-0.5).sub(below))
    const high = vec2(size.x.mul(0.5).add(pad), size.y.mul(0.5).add(pad))
    const vertex = mix(low, high, positionGeometry.xy.add(0.5)) as unknown as V2
    // The pose of `posed`: scale, roll, pitch, yaw, move, then the scene tilt about the pivot.
    const scaled = vertex.mul(scale)
    const cosRoll = cos(turnNode.y)
    const sinRoll = sin(turnNode.y)
    const rolledX = scaled.x.mul(cosRoll).sub(scaled.y.mul(sinRoll))
    const rolledY = scaled.x.mul(sinRoll).add(scaled.y.mul(cosRoll))
    const pitchedY = rolledY.mul(cos(turnNode.x))
    const pitchedZ = rolledY.mul(sin(turnNode.x))
    const cosYaw = cos(placeNode.w)
    const sinYaw = sin(placeNode.w)
    const x = rolledX.mul(cosYaw).add(pitchedZ.mul(sinYaw)).add(placeNode.x)
    const y = pitchedY.add(placeNode.y)
    const z = rolledX.negate().mul(sinYaw).add(pitchedZ.mul(cosYaw)).add(placeNode.z).sub(pivot)
    const flat = vec3(
      x,
      y.mul(cosTilt).sub(z.mul(sinTilt)),
      y.mul(sinTilt).add(z.mul(cosTilt)).add(pivot),
    )
    const drawn = offaxisNode(flat as unknown as V3, viewNode.xy, viewNode.z as F, viewNode.w as F)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    // One pass: a transparent double-sided material would otherwise draw its sides apart.
    material.forceSinglePass = true
    material.positionNode = drawn

    const lift = stateNode.w
    const at = varying(vertex) as unknown as V2
    // Seen from behind, the picture still reads the right way round.
    const facingX = select(frontFacing, at.x, at.x.negate())
    const edge = size.y.mul(-0.5)
    // Below the card is its reflection only while there is one: else its shadow and ring.
    const mirrored = at.y.lessThan(edge).and(reflection.greaterThan(0))
    const mirroredY = select(mirrored, size.y.negate().sub(at.y), at.y)
    const point = vec2(facingX, mirroredY) as unknown as V2
    const half = size.mul(0.5) as unknown as V2
    const radius = dimsNode.z
    const inside = clamp(float(0.5).sub(roundedBox(point, half, radius)), 0, 1)
    // The picture inside the border; the bottom border of a print is wider.
    const photoLow = vec2(half.x.negate().add(border), half.y.negate().add(bottomBorder))
    const photoHigh = vec2(half.x.sub(border), half.y.sub(border))
    const area = max(photoHigh.sub(photoLow), vec2(1, 1))
    // The photo's own corners: the card's radius without a border, 1.5 px inside one.
    const innerRadius = max(radius.sub(border), 0)
      .mul(step(border, 0.5))
      .add(step(0.5, border).mul(1.5))
    const photoCentre = photoLow.add(photoHigh).mul(0.5)
    const photoEdge = roundedBox(
      point.sub(photoCentre) as V2,
      area.mul(0.5) as V2,
      innerRadius as F,
    )
    const inPhoto = clamp(float(0.5).sub(photoEdge), 0, 1)
    const photoUv = point.sub(photoLow).div(area).mul(frameCrop.xy).add(frameCrop.zw)
    const picture = node.sample(clamp(photoUv, 0, 1)) as unknown as V4
    // The picture where it covers the frame (contain leaves bands) and once it is in.
    const covered = step(0, photoUv.x).mul(
      step(photoUv.x, 1),
      step(0, photoUv.y),
      step(photoUv.y, 1),
      picture.a,
      stateNode.z,
    )
    const photo = mix(EMPTY, picture.rgb, covered)
    const rgb = mix(paperTint, photo, inPhoto).mul(stateNode.y)
    const fall = clamp(edge.sub(at.y).div(max(reflectionReach.mul(size.y), 1)), 0, 1).oneMinus()
    const cardAlpha = inside.mul(select(mirrored, reflection.mul(fall, fall), float(1)))
    // A soft shadow below the card on screen, longer and softer while it is lifted.
    const drop = lift.mul(10).add(3)
    const blur = lift.mul(18).add(10)
    const under = vec2(sinRoll.negate(), cosRoll.negate()).mul(drop)
    const shadowEdge = roundedBox(at.sub(under) as V2, half, radius)
    const shade = smoothstep(blur, blur.mul(-0.4), shadowEdge)
      .mul(paperNode.z, lift.mul(0.5).add(1), 0.6)
      .mul(select(mirrored, float(0), float(1)))
    const shadeAlpha = shade.mul(cardAlpha.oneMinus())
    // Card over shadow, then the ring over both.
    const baseAlpha = cardAlpha.add(shadeAlpha)
    const baseColor = rgb.mul(cardAlpha).div(max(baseAlpha, 1e-4))
    // The ring keeps its width on a card drawn larger or smaller.
    const ringAlpha = ring.alpha(roundedBox(at, half, radius).mul(scale) as F).mul(turnNode.w)
    const alpha = ringAlpha.add(baseAlpha.mul(ringAlpha.oneMinus()))
    const color = ring.color
      .mul(ringAlpha)
      .add(baseColor.mul(baseAlpha, ringAlpha.oneMinus()))
      .div(max(alpha, 1e-4))
    const boxAt = (varying(drawn.xy) as unknown as V2).div(box).add(0.5) as unknown as V2
    material.colorNode = vec4(color, alpha.mul(stateNode.x, opacity, clip(boxAt)))
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.frustumCulled = false

    let fit: FitOptions = {}
    const card: Card = {
      mesh,
      pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, scale: 1 },
      size: { w: 1, h: 1 },
      radius: 0,
      alpha: 1,
      bright: 1,
      lift: 0,
      ring: false,
      show(map, frame) {
        node.value = map ?? blank
        ;(state.value as Vector4).z = map ? 1 : 0
        fit = frame ?? {}
      },
      apply() {
        const { pose, size } = card
        ;(place.value as Vector4).set(pose.x, pose.y, pose.z, pose.yaw)
        ;(turn.value as Vector4).set(pose.pitch, pose.roll, pose.scale, card.ring ? 1 : 0)
        const stateValue = state.value as Vector4
        stateValue.set(card.alpha, card.bright, stateValue.z, card.lift)
        ;(dims.value as Vector3).set(size.w, size.h, card.radius)
        const image = node.value.image as { width?: number; height?: number } | undefined
        // The photo inside the paper border.
        const photoWidth = size.w - 2 * look.border
        const photoHeight = size.h - look.border - look.bottom
        crop(
          fit.fit ?? 'cover',
          fit.position ?? [0.5, 0.5],
          image?.width ?? 0,
          image?.height ?? 0,
          photoWidth,
          photoHeight,
          framed.value as Vector4,
        )
        mesh.visible = card.alpha > 0.001
      },
    }
    group.add(mesh)
    cards.push(card)
    return card
  }

  const corners = (card: Card): [number, number][] => {
    const { w, h } = card.size
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(([localX, localY]) => {
      const [x, y, z] = posed(card.pose, localX as number, localY as number, look.tilt, look.pivot)
      return seen(x, y, z, look.perspective)
    })
  }

  return {
    group,
    cards,
    look,
    paper: (color) => {
      paperColor.value.setStyle(color)
    },
    add,
    frame(input) {
      render.toWorld(input.x + input.width / 2, input.y + input.height / 2, world)
      ;(view.value as Vector4).set(
        world.x,
        world.y,
        Math.max(look.perspective, 1),
        render.camera.position.z || 1000,
      )
      const room = Math.max(ring.pad(), look.shadow > 0 ? 48 : 0)
      ;(scene.value as Vector4).set(Math.cos(look.tilt), Math.sin(look.tilt), look.pivot, room)
      ;(paper.value as Vector3).set(look.border, look.bottom, look.shadow)
      ;(mirror.value as Vector2).set(look.reflection, look.reach)
    },
    corners,
    depth: (card) => posed(card.pose, 0, 0, look.tilt, look.pivot)[2],
    hit(x, y) {
      const order = cards
        .filter((card) => card.mesh.visible && card.alpha > 0.5)
        .sort((a, b) => b.mesh.renderOrder - a.mesh.renderOrder)
      return order.find((card) => within(corners(card), x, y))
    },
  }
}

/** A point of the page in px from the box centre of `el`, y up. */
export function local(el: Element, clientX: number, clientY: number): [number, number] {
  const rect = el.getBoundingClientRect()
  return [clientX - rect.left - rect.width / 2, rect.top + rect.height / 2 - clientY]
}

/** The rendered size of an image and its centre in px from the box centre of `el`, y up. */
export function measure(el: Element, img: Element): { w: number; h: number; x: number; y: number } {
  const container = el.getBoundingClientRect()
  const image = img.getBoundingClientRect()
  return {
    w: image.width,
    h: image.height,
    x: image.left + image.width / 2 - container.left - container.width / 2,
    y: container.top + container.height / 2 - image.top - image.height / 2,
  }
}

/** The link or button an image of the container stands for, if any. */
export const linkOf = (el: Element, img: Element): HTMLElement | null => {
  const link = img.closest<HTMLElement>('a[href], button')
  return link && el.contains(link) && link !== el ? link : null
}

/**
 * Activates a link or button as the click `e` would have, modifier keys included, while the
 * effect lets that click through.
 */
export function follow(target: HTMLElement, e: MouseEvent, passing: { on: boolean }): void {
  passing.on = true
  try {
    target.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        button: e.button,
      }),
    )
  } finally {
    passing.on = false
  }
}

/** A touch or pen drag needs the site to keep horizontal pans from the page. */
export const ownsPan = (el: Element): boolean =>
  !/auto|manipulation|pan-x/.test(getComputedStyle(el).touchAction || 'auto')
