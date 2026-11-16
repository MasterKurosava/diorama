import type { Anchor } from '@diorama/core'
import { abs, clamp, float, length, max, min, step, uv, vec2 } from 'three/tsl'
import { Euler, Group, type Node, Quaternion, type UniformNode, Vector3 } from 'three/webgpu'
import type { Box, DrawnBox, EffectInput, Layer, PoseTarget } from '../types'
import type { CopyImpl } from './copy'
import { Inputs, type LayerUniform, type Rect, type ToWorld } from './inputs'
import type { Inst } from './instance'
import type { Media } from './media'
import type { SurfaceImpl } from './surface'

type V2 = Node<'vec2'>
type F = Node<'float'>

const position = new Vector3()
const rotation = new Quaternion()
const euler = new Euler()
const point = { x: 0, y: 0 }
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const same = (a: Box | undefined, b: Box | undefined): boolean =>
  a === b ||
  (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

/** One per element with a live effect or a lease: its place in the scene. */
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
  readonly leases: Set<object> = new Set()
  anchor: Anchor
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
  state: 'live' | 'drawn' | undefined
  taken: CopyImpl | undefined
  /** The box of the last drawn frame (`copy.drawn`). */
  drawn: DrawnBox | undefined
  /** A ghost's box when its owner sets none. The last drawn one, else the last laid out. */
  rest: Box | undefined
  /** Box size after the pose of this frame. */
  width = 0
  height = 0
  #present: (state: 'live' | 'drawn' | undefined) => void

  constructor(
    element: Element,
    anchor: Anchor,
    present: (state: 'live' | 'drawn' | undefined) => void,
  ) {
    this.element = element
    this.anchor = anchor
    this.#present = present
    this.root.add(this.box, this.contain)
    this.root.visible = false
  }

  get input(): EffectInput {
    return this.inputs.input
  }

  present(state: 'live' | 'drawn' | undefined): void {
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
    const { x, y, width, height, opacity } = this.input
    const { radius } = this.inputs
    const clip = this.inputs.viewportClip()
    const d = this.drawn
    if (
      d?.x === x &&
      d.y === y &&
      d.width === width &&
      d.height === height &&
      d.opacity === opacity &&
      d.radius === radius &&
      same(d.clip, clip)
    ) {
      return
    }
    const drawn = { x, y, width, height, opacity, radius }
    this.drawn = Object.freeze(clip ? { ...drawn, clip: Object.freeze(clip) } : drawn)
  }

  /** No effect of the layer reads `presence` itself. */
  fades(): boolean {
    return this.insts.every((i) => (i.current ?? i.next)?.def.presence !== 'custom')
  }

  /** Has a running, unparked instance, so the layer is at least `live`. */
  running(): boolean {
    return this.insts.some((i) => i.current?.state === 'active' && !i.parked)
  }

  /** A running `place(obj, { replace: true })` object stands in for the element. */
  replaced(): boolean {
    return this.insts.some((i) => i.current?.state === 'active' && !i.parked && !!i.current.replace)
  }

  /** The element has a GL copy ready to draw. */
  copy(): boolean {
    return this.replaced() || !!this.surface?.drawable
  }

  bleed(): number {
    let bleed = 0
    for (const i of this.insts) bleed = Math.max(bleed, (i.current ?? i.next)?.def.bleed ?? 0)
    return bleed
  }

  uniform(name: LayerUniform): UniformNode<'float'> {
    return this.inputs.uniform(name) as unknown as UniformNode<'float'>
  }

  // Masks

  coverUV(at: V2 = uv()): V2 {
    const crop = this.inputs.uniform('crop') as unknown as Node<'vec4'>
    return at.mul(crop.xy).add(crop.zw)
  }

  /** Zero outside the media under object-fit: contain. */
  containMask(at: V2): F {
    const t = this.coverUV(at)
    return step(0, t.x).mul(step(t.x, 1), step(0, t.y), step(t.y, 1))
  }

  /** border-radius as an anti-aliased rounded-box SDF in CSS px. */
  radiusMask(at: V2): F {
    const size = this.uniform('size') as unknown as V2
    const r = this.uniform('radius')
    const q = abs(at.sub(0.5).mul(size)).sub(size.mul(0.5)).add(r)
    const d = length(max(q, vec2(0)))
      .add(min(max(q.x, q.y), 0))
      .sub(r)
    return clamp(float(0.5).sub(d), 0, 1)
  }

  /** The nearest clipping ancestor's box. */
  clipMask(at: V2): F {
    const c = this.inputs.uniform('clip') as unknown as Node<'vec4'>
    return step(c.x, at.x).mul(step(at.x, c.z), step(c.y, at.y), step(at.y, c.w))
  }

  opacity(): F {
    return this.uniform('opacity')
  }

  mask(at: V2 = uv()): F {
    return this.containMask(at).mul(this.radiusMask(at), this.clipMask(at), this.opacity())
  }

  /** Places root at layout plus pose and gives the box groups the posed size. Runs in compose. */
  place(toWorld: ToWorld): void {
    const i = this.input
    const centre = toWorld(i.x + i.width / 2, i.y + i.height / 2, point)
    let width = i.width
    let height = i.height
    this.root.position.set(centre.x, centre.y, 0)
    this.root.quaternion.identity()
    const k = Math.min(1, Math.max(0, this.pose?.weight ?? 0))
    if (this.pose && k > 0) {
      const t = this.pose.target
      this.root.position.lerp(position.set(t.x ?? centre.x, t.y ?? centre.y, t.z ?? 0), k)
      euler.set(t.rotateX ?? 0, t.rotateY ?? 0, t.rotateZ ?? 0)
      this.root.quaternion.slerp(rotation.setFromEuler(euler), k)
      const scale = lerp(1, t.scale ?? 1, k)
      width = lerp(width, t.width ?? width, k) * scale
      height = lerp(height, t.height ?? height, k) * scale
    }
    this.box.scale.set(width || 1e-6, height || 1e-6, 1)
    const m = Math.min(width, height) || 1e-6
    this.contain.scale.set(m, m, m)
    this.width = width
    this.height = height
    this.posed = k
    this.pose = undefined
    this.root.visible = this.visible
  }
}
