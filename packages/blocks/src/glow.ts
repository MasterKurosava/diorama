import type { ChoiceParam, ColorParam, Effect, EffectContext, Layer } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { cornerRadius, damp, radii, roundedBox } from '@dioramajs/effects/kit'
import {
  attribute,
  clamp,
  exp,
  float,
  fwidth,
  length,
  max,
  min,
  positionGeometry,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  Vector2,
} from 'three/webgpu'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Params = {
  mode: ChoiceParam<'border' | 'fill' | 'both'>
  cards: string
  color: ColorParam
  radius: number
  border: number
  fill: number
  ease: number
}
type Point = { x: number; y: number }

/** Cards one instance lights: one instanced draw. */
export const MAX_CARDS = 64
/** px drawn around each card for the halo of the lit border. */
const PAD = 12
/** Fall-off of the halo outside the border, px. */
const HALO = 5
/** The light fades in and out over this time, s. */
const FADE = 0.22

/** Distance in px from a point to a box, 0 inside. */
export function distanceTo(p: Point, x: number, y: number, width: number, height: number): number {
  const dx = Math.max(x - p.x, 0, p.x - (x + width))
  const dy = Math.max(y - p.y, 0, p.y - (y + height))
  return Math.hypot(dx, dy)
}

/**
 * A soft light follows the pointer over a grid of cards and lights their borders, and in the
 * fill modes their surfaces, wherever it is near: across the gaps onto the neighboring cards.
 * The cards stay DOM; the light draws over them.
 */
const glow: Effect<Params> = defineEffect({
  name: 'glow',
  params: {
    mode: oneOf('border', 'fill', 'both'),
    cards: '',
    color: Object.freeze({ '~kind': 'color', value: '#ffffff' }) as ColorParam,
    radius: 320,
    border: 1,
    fill: 0.12,
    ease: 0.1,
  },
  when: 'hover',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, render, u, element, app } = ctx
    const selector = params.cards.trim()
    let list: readonly Layer[] = [ctx.layer]
    if (selector) {
      try {
        list = ctx.layers(selector)
      } catch (error) {
        app.log.warn(`glow: data-dio-cards="${selector}" is not a valid selector`, error)
      }
    }
    const edge = params.mode !== 'fill'
    const surface = params.mode !== 'border'

    // Per card: centre in world px and half size; its corner radii.
    const boxes = new Float32Array(MAX_CARDS * 4)
    const corners = new Float32Array(MAX_CARDS * 4)
    const quad = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))
    quad.dispose()
    const boxAttr = new InstancedBufferAttribute(boxes, 4).setUsage(DynamicDrawUsage)
    const cornerAttr = new InstancedBufferAttribute(corners, 4).setUsage(DynamicDrawUsage)
    geometry.setAttribute('box', boxAttr)
    geometry.setAttribute('corner', cornerAttr)
    geometry.instanceCount = 0

    const light = uniform(new Vector2())
    const brightness = uniform(0)
    const box = attribute('box', 'vec4')
    const corner = attribute('corner', 'vec4')
    const half = box.zw as unknown as Vec2
    // Px from the card's centre, over the card and its halo padding.
    const local = varying(positionGeometry.xy.mul(half.add(PAD).mul(2))) as unknown as Vec2
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(box.xy.add(local), 0)

    const distance = roundedBox(local, half, cornerRadius(local, corner as unknown as Node<'vec4'>))
    const pixel = max(fwidth(distance), 1e-4)
    const inside = clamp(distance.negate().div(pixel).add(0.5), 0, 1)
    const fromLight = length((box.xy as unknown as Vec2).add(local).sub(light))
    const near = clamp(fromLight.div(max(u.radius, 1)).oneMinus(), 0, 1)
    let alpha: Float = float(0)
    if (edge) {
      // The border ring inside the card's edge and a short halo outside it.
      const width = u.border as unknown as Float
      const ring = clamp(distance.add(width).div(pixel).add(0.5), 0, 1).mul(inside)
      const halo = inside
        .oneMinus()
        .mul(exp(max(distance, 0).negate().div(HALO)))
        .mul(min(width, 1), 0.3)
      alpha = alpha.add(ring.add(halo).mul(smoothstep(0, 1, near)))
    }
    if (surface) alpha = alpha.add(inside.mul(near, near, u.fill))
    material.colorNode = vec4(u.color, clamp(alpha, 0, 1).mul(brightness, u.opacity, u.presence))
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    ctx.overlay.add(mesh)
    await ctx.compile(mesh)
    mesh.visible = false
    if (signal.aborted) return

    // The pointer in client px while it is on the page; touch never lights.
    let client: Point | undefined
    let strength = 0
    let lightX = 0
    let lightY = 0
    /** Cards whose radii were read last, or -1 before the first read. */
    let measured = -1
    // A light over the element alone also wakes when the pointer comes within its radius.
    const reach = (): number => (selector ? 0 : Math.max(0, params.radius))
    const nearNow = (at: Point): boolean => {
      const rect = element.getBoundingClientRect()
      return distanceTo(at, rect.left, rect.top, rect.width, rect.height) <= reach()
    }
    const wake = (): void => {
      if (strength > 0 || (client && nearNow(client))) ctx.invalidate()
    }
    const listen = (target: EventTarget, type: string, fn: (e: Event) => void): void =>
      target.addEventListener(type, fn, { signal, passive: true, capture: type === 'scroll' })
    listen(document, 'pointermove', (e) => {
      const move = e as PointerEvent
      if (move.pointerType === 'touch') return
      client = { x: move.clientX, y: move.clientY }
      wake()
    })
    listen(document, 'pointerout', (e) => {
      if ((e as PointerEvent).relatedTarget) return
      client = undefined
      if (strength > 0) ctx.invalidate()
    })
    // The page scrolls under a still pointer: the light stays with the pointer.
    listen(window, 'scroll', wake)

    const world = { x: 0, y: 0 }
    return (input): boolean => {
      const still = input.reducedMotion
      const dt = input.delta
      const goal =
        client && distanceTo(client, input.x, input.y, input.width, input.height) <= reach() ? 1 : 0
      if (client) {
        // Entering, the light starts at the pointer instead of trailing in from where it left.
        if (strength < 0.01 || still) {
          lightX = client.x
          lightY = client.y
        } else {
          lightX = damp(lightX, client.x, params.ease, dt)
          lightY = damp(lightY, client.y, params.ease, dt)
        }
      }
      strength = still ? goal : damp(strength, goal, FADE, dt, 0.004)
      const trailing = !!client && Math.abs(lightX - client.x) + Math.abs(lightY - client.y) > 0.3
      const moving = strength !== goal || (goal === 1 && trailing)

      const count = Math.min(MAX_CARDS, list.length)
      mesh.visible = strength > 0 && count > 0
      if (!mesh.visible) return moving
      // Radii are read as the light comes on and whenever the set of cards changes.
      const fresh = measured !== count || brightness.value === 0
      for (let i = 0; i < count; i++) {
        const card = (list[i] as Layer).input
        const center = render.toWorld(card.x + card.width / 2, card.y + card.height / 2, world)
        const offset = i * 4
        boxes[offset] = center.x
        boxes[offset + 1] = center.y
        boxes[offset + 2] = card.width / 2
        boxes[offset + 3] = card.height / 2
        if (fresh) {
          corners.set(radii((list[i] as Layer).element, card.width, card.height), offset)
        }
      }
      boxAttr.needsUpdate = true
      if (fresh) cornerAttr.needsUpdate = true
      measured = count
      geometry.instanceCount = count
      const at = render.toWorld(lightX, lightY, world)
      ;(light.value as Vector2).set(at.x, at.y)
      brightness.value = strength
      return moving
    }
  },
})
export default glow
