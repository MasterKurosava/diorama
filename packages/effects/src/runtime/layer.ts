// A layer is an element's place in the scene: one per element with a live effect or a lease. It
// holds the groups placed at the element's box (plus pose), the layer's inputs and masks, its
// shared media and surface, and the box it last drew.
import type { Anchor } from '@dioramajs/core'
import { abs, clamp, float, length, max, min, step, uv, vec2 } from 'three/tsl'
import {
  Euler,
  Group,
  type Node,
  type Object3D,
  Quaternion,
  type UniformNode,
  Vector3,
} from 'three/webgpu'
import type { Box, DrawnBox, EffectInput, Layer, PosedBox, PoseTarget } from '../types'
import type { Adrift } from './adrift'
import type { CopyImpl } from './copy'
import { Inputs, type LayerUniform, type Rect, type ToWorld } from './inputs'
import type { Inst } from './instance'
import type { Media } from './media'
import type { SurfaceImpl } from './surface'

type Vec2Node = Node<'vec2'>
type FloatNode = Node<'float'>
type DrawState = 'live' | 'drawn' | undefined

/** renderOrder offset of each draw level (`above`). */
const ABOVE = 1e6
/** Scale of an empty box: three cannot invert a zero scale. */
const MIN_SCALE = 1e-6

const scratchPosition = new Vector3()
const scratchRotation = new Quaternion()
const scratchEuler = new Euler()
const scratchCentre = { x: 0, y: 0 }
const scratchAimCentre = { x: 0, y: 0 }

export class LayerImpl implements Layer {
  readonly element: Element
  /** Box centre plus pose. */
  readonly root: Group = new Group()
  /** Scaled to the posed box. Holds the surface mesh and `place(obj, { fit: 'box' })`. */
  readonly box: Group = new Group()
  /** Scaled uniformly by min(width, height), for `place(obj, { fit: 'contain' })`. */
  readonly contain: Group = new Group()
  readonly inputs: Inputs = new Inputs()
  /** Instances in effect order. */
  insts: Inst[] = []
  /** `layers()` leases that keep the layer without an effect. */
  readonly leases: Set<object> = new Set()
  anchor: Anchor
  /** The closest `[data-dio-section]` ancestor's anchor: `progress` and `pin` come from it. */
  section: Anchor | undefined
  /** Anchor version whose styles were read. */
  version = -1
  mode: 'live' | 'layout' | 'frame' = 'live'
  /** Box of the clipping ancestor in page px, cached for 'layout' tracking. */
  clip: Rect | undefined
  surface: SurfaceImpl | undefined
  media: Media | undefined
  /** Last compile queued with this layer's objects. The media is disposed after it. */
  compiling: Promise<unknown> | undefined
  /** Pose of this frame, reset in compose. */
  pose: { readonly target: PoseTarget; readonly weight: number; readonly owner: Inst } | undefined
  /** Pose weight of the previous frame. A posed layer stays visible. */
  posed = 0
  visible = false
  /** Runtime-owned `data-dio-state`. */
  state: DrawState
  taken: CopyImpl | undefined
  /** The box of the last drawn frame (`copy.drawn`). */
  drawn: DrawnBox | undefined
  /** A ghost's box when its owner sets none. The last drawn one, else the last laid out. */
  rest: Box | undefined
  /** A burst flies on from the last box: the element is hidden or gone (an orphan). */
  adrift: Adrift | undefined
  /** Where this frame's pose puts the element's box, a taken copy's `box` aside (`copy.posed`). */
  aim: PosedBox | undefined
  /** Viewport box after the pose of this frame (x, y, z and rotation aside). */
  x = 0
  y = 0
  width = 0
  height = 0
  /** Groups lifted by the draw level with their original renderOrder. */
  readonly #lifted = new Map<Object3D, number>()
  /** renderOrder offset of the lifted groups. */
  #lift = 0
  #present: (state: DrawState) => void

  constructor(element: Element, anchor: Anchor, present: (state: DrawState) => void) {
    this.element = element
    this.anchor = anchor
    this.#present = present
    this.root.add(this.box, this.contain)
    this.root.visible = false
  }

  get input(): EffectInput {
    return this.inputs.input
  }

  present(state: DrawState): void {
    if (state === this.state) return
    this.state = state
    this.#present(state)
  }

  /** A ghost never writes the element's state again. */
  detach(): void {
    this.#present = () => {}
  }

  /** Records what this frame drew, allocating only when it changed. */
  snapshot(): void {
    const { x, y, width, height } = this
    const { opacity } = this.input
    const { radius } = this.inputs
    const clip = this.inputs.viewportClip(this)
    const last = this.drawn
    const unchanged =
      last?.x === x &&
      last.y === y &&
      last.width === width &&
      last.height === height &&
      last.opacity === opacity &&
      last.radius === radius &&
      sameBox(last.clip, clip)
    if (unchanged) return
    const drawn = { x, y, width, height, opacity, radius }
    this.drawn = Object.freeze(clip ? { ...drawn, clip: Object.freeze(clip) } : drawn)
  }

  /** No effect of the layer reads `presence` itself. */
  fades(): boolean {
    return this.insts.every((inst) => {
      const def = (inst.current ?? inst.next)?.def
      return !def || (inst.rec.presence ?? def.presence) !== 'custom'
    })
  }

  /** Has a running, unparked instance, so the layer is at least `live`. */
  running(): boolean {
    return this.insts.some((inst) => inst.current?.state === 'active' && !inst.parked)
  }

  /** A running `place(obj, { replace: true })` object stands in for the element. */
  replaced(): boolean {
    return this.insts.some((inst) => {
      const phase = inst.current
      return phase?.state === 'active' && !inst.parked && !!phase.replace && !phase.dom
    })
  }

  /** The element has a GL copy ready to draw. */
  copy(): boolean {
    return this.replaced() || !!this.surface?.drawable
  }

  /** The largest `bleed` among the layer's effects, in CSS px. */
  bleed(): number {
    let bleed = 0
    for (const inst of this.insts) {
      bleed = Math.max(bleed, (inst.current ?? inst.next)?.def.bleed ?? 0)
    }
    return bleed
  }

  uniform(name: LayerUniform): UniformNode<'float'> {
    return this.inputs.uniform(name) as unknown as UniformNode<'float'>
  }

  // Masks

  coverUV(at: Vec2Node = uv()): Vec2Node {
    const crop = this.inputs.uniform('crop') as unknown as Node<'vec4'>
    return at.mul(crop.xy).add(crop.zw)
  }

  /** Zero outside the media under object-fit: contain. */
  containMask(at: Vec2Node): FloatNode {
    const media = this.coverUV(at)
    return step(0, media.x).mul(step(media.x, 1), step(0, media.y), step(media.y, 1))
  }

  /** border-radius as an anti-aliased rounded-box SDF in CSS px. */
  radiusMask(at: Vec2Node): FloatNode {
    const size = this.uniform('size') as unknown as Vec2Node
    const r = this.uniform('radius')
    const q = abs(at.sub(0.5).mul(size)).sub(size.mul(0.5)).add(r)
    const d = length(max(q, vec2(0)))
      .add(min(max(q.x, q.y), 0))
      .sub(r)
    return clamp(float(0.5).sub(d), 0, 1)
  }

  /** The nearest clipping ancestor's box. */
  clipMask(at: Vec2Node): FloatNode {
    const clip = this.inputs.uniform('clip') as unknown as Node<'vec4'>
    return step(clip.x, at.x).mul(step(at.x, clip.z), step(clip.y, at.y), step(at.y, clip.w))
  }

  opacity(): FloatNode {
    return this.uniform('opacity')
  }

  mask(at: Vec2Node = uv()): FloatNode {
    return this.containMask(at).mul(this.radiusMask(at), this.clipMask(at), this.opacity())
  }

  /**
   * Places root at layout plus pose and gives the box groups the posed size. Runs in compose.
   * A taken copy's box beats the pose, its radius, clip and level beat the pose's.
   */
  place(toWorld: ToWorld): void {
    const input = this.input
    const centre = toWorld(input.x + input.width / 2, input.y + input.height / 2, scratchCentre)
    let width = input.width
    let height = input.height
    const { root, pose, taken, inputs } = this
    const position = root.position.set(centre.x, centre.y, 0)
    root.quaternion.identity()
    this.x = input.x
    this.y = input.y
    const weight = Math.min(1, Math.max(0, pose?.weight ?? 0))
    // A taken copy's box replaces the posed box, so the pose moves nothing.
    const applied = taken?.box ? 0 : weight
    if (pose && applied > 0) {
      const target = pose.target
      const posed = scratchPosition.set(target.x ?? centre.x, target.y ?? centre.y, target.z ?? 0)
      position.lerp(posed, applied)
      scratchEuler.set(target.rotateX ?? 0, target.rotateY ?? 0, target.rotateZ ?? 0)
      root.quaternion.slerp(scratchRotation.setFromEuler(scratchEuler), applied)
      const scale = lerp(1, target.scale ?? 1, applied)
      width = lerp(width, target.width ?? width, applied) * scale
      height = lerp(height, target.height ?? height, applied) * scale
      this.x += (input.width - width) / 2 + position.x - centre.x
      this.y += (input.height - height) / 2 + centre.y - position.y
      if (target.radius !== undefined && taken?.radius === undefined) {
        inputs.radius = lerp(inputs.radius, target.radius, applied)
      }
      if (target.clip === false && !taken?.clip) inputs.open()
    }
    this.box.scale.set(width || MIN_SCALE, height || MIN_SCALE, 1)
    const side = Math.min(width, height) || MIN_SCALE
    this.contain.scale.set(side, side, side)
    this.width = width
    this.height = height
    this.posed = applied
    this.lift(taken?.above || (weight && pose?.target.above) || 0)
    this.aim =
      pose && weight > 0 && !taken?.ghost
        ? this.#aim(toWorld, pose.target, weight, taken?.box ? this.anchor : input)
        : undefined
    this.pose = undefined
    root.visible = this.visible
  }

  /** Offsets every group of the layer by the draw level, keeping the author's order inside. */
  lift(level: number): void {
    const offset = ABOVE * level
    if (offset !== this.#lift) this.lower()
    this.#lift = offset
    if (!offset) return
    const lift = (object: Object3D): void => {
      if (!(object as Group).isGroup || this.#lifted.has(object)) return
      this.#lifted.set(object, object.renderOrder)
      object.renderOrder += offset
    }
    this.root.traverse(lift)
    for (const inst of this.insts) {
      for (const phase of [inst.current, inst.next]) phase?.viewport?.traverse(lift)
    }
  }

  /** Gives the lifted groups their renderOrder back. */
  lower(): void {
    for (const [object, order] of this.#lifted) object.renderOrder = order
    this.#lifted.clear()
    this.#lift = 0
  }

  /** The pose of the element's box `base` at `weight`, kept while unchanged. */
  #aim(toWorld: ToWorld, target: PoseTarget, weight: number, base: Box): PosedBox {
    const centre = toWorld(base.x + base.width / 2, base.y + base.height / 2, scratchAimCentre)
    const scale = lerp(1, target.scale ?? 1, weight)
    const width = lerp(base.width, target.width ?? base.width, weight) * scale
    const height = lerp(base.height, target.height ?? base.height, weight) * scale
    const x = base.x + (base.width - width) / 2 + weight * ((target.x ?? centre.x) - centre.x)
    const y = base.y + (base.height - height) / 2 - weight * ((target.y ?? centre.y) - centre.y)
    const styled = this.inputs.styles.radius
    const radius = target.radius === undefined ? styled : lerp(styled, target.radius, weight)
    const clip = target.clip !== false
    const last = this.aim
    const unchanged =
      last?.x === x &&
      last.y === y &&
      last.width === width &&
      last.height === height &&
      last.radius === radius &&
      last.clip === clip
    return unchanged ? last : Object.freeze({ x, y, width, height, radius, clip })
  }
}

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t

const sameBox = (a: Box | undefined, b: Box | undefined): boolean =>
  a === b ||
  (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
