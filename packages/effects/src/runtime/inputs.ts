import type { PointerState } from '@diorama/core'
import { uniform } from 'three/tsl'
import { type UniformNode, Vector2, Vector4 } from 'three/webgpu'
import type { Box, EffectInput } from '../types'

/** Built-in inputs plus the surface masks. */
export type LayerUniform =
  | 'pointer'
  | 'pointerWorld'
  | 'hover'
  | 'progress'
  | 'pin'
  | 'size'
  | 'time'
  | 'hoverTime'
  | 'opacity'
  | 'presence'
  | 'crop'
  | 'radius'
  | 'clip'

const VEC2 = new Set(['pointer', 'pointerWorld', 'size'])
const VEC4 = new Set(['crop', 'clip'])
/** No clip: the box UV never leaves this rectangle. */
const OPEN = [-1e4, -1e4, 1e4, 1e4] as const

export class Input implements EffectInput {
  x = 0
  y = 0
  width = 0
  height = 0
  visible = false
  readonly pointer: { x: number; y: number } = { x: 0.5, y: 0.5 }
  readonly pointerWorld: { x: number; y: number } = { x: 0, y: 0 }
  over = false
  progress = 0
  pin = 0
  #time = 0
  #hoverTime = 0
  delta = 0
  /** `time` was read on the GPU or CPU, so the effect animates while visible by default. */
  clock = false
  /** `hoverTime` was read, so the effect animates while hovered or hover decays. */
  hoverClock = false
  reducedMotion = false
  opacity = 1
  presence = 1
  /** `hover` was read, so its decay keeps frames coming. */
  hoverRead = false
  damped = 0
  /** The runtime's scroll velocity reader, set by `compute`. */
  speed: () => number = () => 0
  get hover(): number {
    this.hoverRead = true
    return this.damped
  }
  get time(): number {
    this.clock = true
    return this.#time
  }
  set time(time: number) {
    this.#time = time
  }
  get hoverTime(): number {
    this.hoverClock = true
    return this.#hoverTime
  }
  /** Advances clocks without counting as a read. Hover time moves only on hover or decay. */
  advance(delta: number): void {
    this.#time += delta
    if (this.over || this.damped > 0) this.#hoverTime += delta
  }
  /** Read on demand, since reading it keeps frames coming while scroll velocity decays. */
  get velocity(): number {
    return this.speed()
  }
}

export type Fit = 'cover' | 'contain' | 'fill'

const keyword: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }

/** Computed styles read when the anchor re-measures, not every frame. */
export class Styles {
  fit: Fit = 'fill'
  position: [number, number] = [0.5, 0.5]
  radius = 0
  /** Nearest ancestor that clips: overflow other than visible, or clip-path inset. */
  clip: Element | undefined
  /** Live computed styles of the element and its ancestors, for the opacity product. */
  chain: CSSStyleDeclaration[] = []
  nodes: Element[] = []
  /** May move without events the kernel sees (transform, will-change, opacity < 1, fixed). */
  moving = false

  read(element: Element, warn: (key: string, message: string) => void): void {
    const style = getComputedStyle(element)
    const fit = style.objectFit
    if (fit === 'none' || fit === 'scale-down')
      warn(`fit:${fit}`, `object-fit: ${fit} is drawn as contain`)
    this.fit =
      fit === 'cover' || fit === 'contain' ? fit : fit && fit !== 'fill' ? 'contain' : 'fill'
    const [px = 'center', py = 'center'] = (style.objectPosition || '').split(/\s+/).filter(Boolean)
    const axis = (token: string): number => {
      if (token in keyword) return keyword[token] as number
      if (token.endsWith('%')) return Number.parseFloat(token) / 100
      warn('position', `object-position: ${token} is drawn centred`)
      return 0.5
    }
    this.position = [axis(px), axis(py)]
    const radii = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].map((r) => {
      const value = Number.parseFloat(r || '0') || 0
      if (!r?.endsWith('%')) return value
      const box = element.getBoundingClientRect()
      return (Math.min(box.width, box.height) * value) / 100
    })
    this.radius = Math.max(...radii)
    if (radii.some((r) => r !== this.radius))
      warn('radius', 'corners differ: the largest radius is drawn')

    this.chain = []
    this.nodes = []
    this.clip = undefined
    this.moving = false
    const body = element.ownerDocument.body
    for (let node: Element | null = element; node; node = node.parentElement) {
      const s = node === element ? style : getComputedStyle(node)
      this.chain.push(s)
      this.nodes.push(node)
      const transform = s.transform && s.transform !== 'none'
      const opacity = Number.parseFloat(s.opacity)
      if (
        transform ||
        /transform|opacity/.test(s.willChange) ||
        opacity < 1 ||
        s.position === 'fixed'
      ) {
        this.moving = true
      }
      // Overflow on html/body clips the viewport, not a box.
      if (node === element || this.clip || node === body || node === body?.parentElement) continue
      const clips =
        (s.overflowX && s.overflowX !== 'visible') || (s.overflowY && s.overflowY !== 'visible')
      if (clips || s.clipPath?.startsWith('inset(')) this.clip = node
    }
  }

  /** Product of the computed opacities of the element and its ancestors. `seen` shares reads. */
  opacity(seen?: Map<Element, number>): number {
    let product = 1
    for (let k = 0; k < this.chain.length; k++) {
      const node = this.nodes[k] as Element
      let value = seen?.get(node)
      if (value === undefined) {
        value = Number.parseFloat((this.chain[k] as CSSStyleDeclaration).opacity)
        if (!Number.isFinite(value)) value = 1
        seen?.set(node, value)
      }
      product *= value
    }
    return product
  }
}

export interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** `render.toWorld`. Writes into `out` when given. */
export type ToWorld = (
  x: number,
  y: number,
  out?: { x: number; y: number },
) => { x: number; y: number }

/** Owner overrides of a taken copy. */
export interface Taken {
  readonly box: { readonly x: number } | undefined
  readonly radius: number | undefined
  /** Viewport box the copy is cut to instead of the ancestor's clip. */
  readonly clip: Box | undefined
  readonly opacity: number
  readonly presence: number
  /** No effect of the layer reads presence itself, so it multiplies the alpha. */
  readonly fade: boolean
}

export interface FrameInputs {
  delta: number
  reduced: boolean
  /** 0 under reduced motion. Reading it keeps frames coming. */
  readonly velocity: () => number
  readonly pointer: PointerState
  readonly toWorld: ToWorld
  /** Opacity reads of this frame, shared by layers with common ancestors. */
  readonly opacities?: Map<Element, number>
}

/** Inputs, lazy uniforms and the masks' values of one layer. */
export class Inputs {
  readonly input: Input = new Input()
  readonly styles: Styles = new Styles()
  /** Clip drawn in box UV as (min u, min v, max u, max v), the owner's or the ancestor's. */
  readonly clip: number[] = [...OPEN]
  /** `clip` actually cuts the box. */
  #clipped = false
  /** Clipping ancestor's box in box UV as last read. A held box or a ghost keeps it. */
  readonly #seen: number[] = [...OPEN]
  #open = true
  readonly #uniforms = new Map<LayerUniform, UniformNode<'float' | 'vec2' | 'vec4'>>()
  /** Opacity changed since the previous frame. Frames keep coming until it settles. */
  fading = false
  /** CSS opacity product as last read. A ghost keeps it. */
  css = 1
  /** border-radius drawn, the copy's override or the element's. */
  radius = 0
  /** Box size for `u.size` and the masks, the posed size once compose has posed the layer. */
  readonly size: [number, number] = [0, 0]

  uniform(name: LayerUniform): UniformNode<'float' | 'vec2' | 'vec4'> {
    let node = this.#uniforms.get(name)
    if (!node) {
      if (name === 'hover') this.input.hoverRead = true
      node = VEC2.has(name)
        ? uniform(new Vector2())
        : VEC4.has(name)
          ? uniform(name === 'clip' ? new Vector4(...OPEN) : new Vector4(1, 1, 0, 0))
          : uniform(name === 'opacity' || name === 'presence' ? 1 : 0)
      this.#uniforms.set(name, node)
      this.#write(name, node)
    }
    return node
  }

  /**
   * Per-frame inputs of a visible layer whose box is already in `input`. `clipBox` false keeps
   * the ancestor's clip as last read, relative to the box. A copy's `clip` overrides it.
   * `frozen` keeps the last CSS opacity, since a ghost has no styles.
   */
  compute(
    frame: FrameInputs,
    progress: number,
    pin: number,
    clipBox: Rect | undefined | false,
    copy?: Taken,
    frozen = false,
  ): void {
    const i = this.input
    const { x: px, y: py, inside } = frame.pointer
    const w = i.width || 1
    const h = i.height || 1
    if (inside) {
      i.pointer.x = (px - i.x) / w
      i.pointer.y = 1 - (py - i.y) / h
      const world = frame.toWorld(px, py, i.pointerWorld)
      i.pointerWorld.x = world.x
      i.pointerWorld.y = world.y
    }
    i.over = inside && px >= i.x && px <= i.x + i.width && py >= i.y && py <= i.y + i.height
    const target = i.over ? 1 : 0
    const next = i.damped + (target - i.damped) * (1 - Math.exp(-8 * frame.delta))
    i.damped = frame.reduced ? 0 : Math.abs(target - next) < 1e-3 ? target : next
    i.speed = frame.velocity
    i.progress = progress
    i.pin = Math.min(1, Math.max(0, pin))
    if (!frame.reduced) i.advance(frame.delta)
    i.delta = frame.delta
    i.reducedMotion = frame.reduced
    // Read under a held box too, so an owner lands a copy at the opacity the page has now.
    if (!frozen && this.styles.chain.length) this.css = this.styles.opacity(frame.opacities)
    const presence = copy?.presence ?? 1
    let opacity = copy?.box ? 1 : this.css
    if (copy) opacity *= copy.opacity * (copy.fade ? presence : 1)
    this.fading = opacity !== i.opacity || presence !== i.presence
    i.opacity = opacity
    i.presence = presence
    this.radius = copy?.radius ?? this.styles.radius
    this.size[0] = i.width
    this.size[1] = i.height
    const seen = this.#seen
    if (clipBox !== false) {
      this.#open = !clipBox
      if (clipBox) this.#cut(seen, clipBox.left, clipBox.top, clipBox.right, clipBox.bottom)
      else for (let k = 0; k < 4; k++) seen[k] = OPEN[k] as number
    }
    const own = copy?.clip
    if (own) this.#cut(this.clip, own.x, own.y, own.x + own.width, own.y + own.height)
    else for (let k = 0; k < 4; k++) this.clip[k] = seen[k] as number
    this.#clipped = !!own || !this.#open
    for (const [name, node] of this.#uniforms) this.#write(name, node)
  }

  /** Converts a viewport rectangle to the box UV of `input`. */
  #cut(uv: number[], left: number, top: number, right: number, bottom: number): void {
    const { x, y } = this.input
    const w = this.input.width || 1
    const h = this.input.height || 1
    uv[0] = (left - x) / w
    uv[1] = 1 - (bottom - y) / h
    uv[2] = (right - x) / w
    uv[3] = 1 - (top - y) / h
  }

  /** The clip drawn as a viewport box, undefined when open. */
  viewportClip(): Box | undefined {
    if (!this.#clipped) return undefined
    const { x, y, width, height } = this.input
    const [u0, v0, u1, v1] = this.clip as [number, number, number, number]
    return {
      x: x + u0 * width,
      y: y + (1 - v1) * height,
      width: (u1 - u0) * width,
      height: (v1 - v0) * height,
    }
  }

  /** Sets the posed size, so `u.size`, the masks and the crop follow the box drawn. */
  resize(width: number, height: number): void {
    this.size[0] = width
    this.size[1] = height
    for (const name of ['size', 'crop'] as const) {
      const node = this.#uniforms.get(name)
      if (node) this.#write(name, node)
    }
  }

  /** Hover is still easing toward its target and someone reads it. */
  get easing(): boolean {
    return (
      this.input.hoverRead &&
      this.input.damped !== (this.input.over && !this.input.reducedMotion ? 1 : 0)
    )
  }

  /** Media crop set by `media.ts` as (scale u, scale v, offset u, offset v). */
  readonly crop: number[] = [1, 1, 0, 0]

  #write(name: LayerUniform, node: UniformNode<'float' | 'vec2' | 'vec4'>): void {
    const i = this.input
    const v = node.value as number | Vector2 | Vector4
    switch (name) {
      case 'pointer':
        ;(v as Vector2).set(i.pointer.x, i.pointer.y)
        return
      case 'pointerWorld':
        ;(v as Vector2).set(i.pointerWorld.x, i.pointerWorld.y)
        return
      case 'size':
        ;(v as Vector2).set(this.size[0], this.size[1])
        return
      case 'crop':
        ;(v as Vector4).fromArray(this.crop)
        return
      case 'clip':
        ;(v as Vector4).fromArray(this.clip)
        return
      case 'radius':
        node.value = this.radius
        return
      case 'hover':
        node.value = i.damped
        return
      default:
        node.value = i[name]
    }
  }
}
