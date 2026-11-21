// The inputs of one layer: `ctx.input` (box, pointer, scroll progress, clocks), the computed
// styles read when the element re-measures, and the lazily made uniforms of `ctx.u` and the
// surface masks, written once per frame.
import type { PointerState } from '@dioramajs/core'
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

export type Fit = 'cover' | 'contain' | 'fill'

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

/** What one frame gives every layer's inputs. */
export interface FrameInputs {
  delta: number
  reduced: boolean
  /** 0 under reduced motion. Reading it keeps frames coming. */
  readonly velocity: () => number
  readonly pointer: PointerState
  /** Invalidates: a layer read the pointer for the first time. */
  readonly wake: () => void
  readonly toWorld: ToWorld
  /** Opacity reads of this frame, shared by layers with common ancestors. */
  readonly opacities?: Map<Element, number>
}

type UniformKind = UniformNode<'float' | 'vec2' | 'vec4'>

const VEC2 = new Set(['pointer', 'pointerWorld', 'size'])
const VEC4 = new Set(['crop', 'clip'])
/** Uniforms whose reading makes the layer read the pointer. */
const POINTED = new Set(['pointer', 'pointerWorld', 'hover', 'hoverTime'])
/** No clip: the box UV never leaves this rectangle. */
const OPEN = [-1e4, -1e4, 1e4, 1e4] as const
/** `object-position` keywords as fractions of the free space. */
const POSITION_KEYWORDS: Record<string, number> = {
  left: 0,
  top: 0,
  center: 0.5,
  right: 1,
  bottom: 1,
}
/** Rate of the hover easing, per second. */
const HOVER_RATE = 8
/** Hover this close to its target snaps to it. */
const HOVER_SNAP = 1e-3

/** `ctx.input`. Getters record which inputs an effect reads, so the frame policy can follow. */
export class Input implements EffectInput {
  x = 0
  y = 0
  width = 0
  height = 0
  visible = false
  /** The pointer in box UV and in world units, written without counting as a read. */
  readonly at: { x: number; y: number } = { x: 0.5, y: 0.5 }
  readonly atWorld: { x: number; y: number } = { x: 0, y: 0 }
  isOver = false
  /**
   * An effect of the layer reads the pointer (position, over, hover, hover time), so the frame
   * reads it too. Unread, a pointer move draws nothing.
   */
  pointed = false
  /** Asks for the frame that first reads the pointer for this layer. */
  wake: () => void = () => {}
  progress = 0
  pin = 0
  /** `time` or `delta` was read, so the effect animates while visible by default. */
  clock = false
  /** `hoverTime` was read, so the effect animates while hovered or hover decays. */
  hoverClock = false
  reducedMotion = false
  opacity = 1
  presence = 1
  /** `hover` was read, so its decay keeps frames coming. */
  hoverRead = false
  /** Hover eased toward `isOver`, the value `hover` reads. */
  damped = 0
  /** The runtime's scroll velocity reader, set by `compute`. */
  speed: () => number = () => 0
  #time = 0
  #hoverTime = 0
  #delta = 0

  /** Marks the pointer as read by this layer. */
  point(): void {
    if (this.pointed) return
    this.pointed = true
    this.wake()
  }

  get pointer(): { readonly x: number; readonly y: number } {
    this.point()
    return this.at
  }

  get pointerWorld(): { readonly x: number; readonly y: number } {
    this.point()
    return this.atWorld
  }

  get over(): boolean {
    this.point()
    return this.isOver
  }

  get hover(): number {
    this.hoverRead = true
    this.point()
    return this.damped
  }

  get time(): number {
    this.clock = true
    return this.#time
  }

  set time(time: number) {
    this.#time = time
  }

  /** A clock too: `angle += input.delta` in update animates like reading `time`. */
  get delta(): number {
    this.clock = true
    return this.#delta
  }

  set delta(delta: number) {
    this.#delta = delta
  }

  get hoverTime(): number {
    this.hoverClock = true
    this.point()
    return this.#hoverTime
  }

  /** Read on demand, since reading it keeps frames coming while scroll velocity decays. */
  get velocity(): number {
    return this.speed()
  }

  /** Advances clocks without counting as a read. Hover time moves only on hover or decay. */
  advance(delta: number): void {
    this.#time += delta
    if (this.isOver || this.damped > 0) this.#hoverTime += delta
  }
}

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
    this.#readFit(style, warn)
    this.#readRadius(element, style, warn)
    this.#readAncestors(element, style)
  }

  /** Product of the computed opacities of the element and its ancestors. `seen` shares reads. */
  opacity(seen?: Map<Element, number>): number {
    let product = 1
    for (let index = 0; index < this.chain.length; index++) {
      const node = this.nodes[index] as Element
      let value = seen?.get(node)
      if (value === undefined) {
        value = Number.parseFloat((this.chain[index] as CSSStyleDeclaration).opacity)
        if (!Number.isFinite(value)) value = 1
        seen?.set(node, value)
      }
      product *= value
    }
    return product
  }

  #readFit(style: CSSStyleDeclaration, warn: (key: string, message: string) => void): void {
    const fit = style.objectFit
    if (fit === 'none' || fit === 'scale-down') {
      warn(`fit:${fit}`, `object-fit: ${fit} is drawn as contain`)
    }
    this.fit =
      fit === 'cover' || fit === 'contain' ? fit : fit && fit !== 'fill' ? 'contain' : 'fill'
    const [x = 'center', y = 'center'] = (style.objectPosition || '').split(/\s+/).filter(Boolean)
    const axis = (token: string): number => {
      if (token in POSITION_KEYWORDS) return POSITION_KEYWORDS[token] as number
      if (token.endsWith('%')) return Number.parseFloat(token) / 100
      warn('position', `object-position: ${token} is drawn centred`)
      return 0.5
    }
    this.position = [axis(x), axis(y)]
  }

  /** The largest corner radius in px, at most half the shorter side as in CSS. */
  #readRadius(
    element: Element,
    style: CSSStyleDeclaration,
    warn: (key: string, message: string) => void,
  ): void {
    // Measured only when a radius needs it.
    let side: number | undefined
    const shorter = (): number => {
      if (side === undefined) {
        const box = element.getBoundingClientRect()
        side = Math.min(box.width, box.height)
      }
      return side
    }
    const corners = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ]
    const radii = corners.map((corner) => {
      const px = cornerPx(corner, shorter)
      if (px <= 0) return 0
      // Like CSS, a corner never takes more than half the shorter side (a 999px pill).
      // An unmeasured box (not laid out yet) keeps the written radius.
      return shorter() > 0 ? Math.min(px, shorter() / 2) : px
    })
    this.radius = Math.max(...radii)
    if (radii.some((radius) => radius !== this.radius)) {
      warn('radius', 'corners differ: the largest radius is drawn')
    }
  }

  /** The opacity chain, whether the element may move unseen, and the clipping ancestor. */
  #readAncestors(element: Element, style: CSSStyleDeclaration): void {
    this.chain = []
    this.nodes = []
    this.clip = undefined
    this.moving = false
    const body = element.ownerDocument.body
    for (let node: Element | null = element; node; node = node.parentElement) {
      const computed = node === element ? style : getComputedStyle(node)
      this.chain.push(computed)
      this.nodes.push(node)
      if (movesUnseen(computed)) this.moving = true
      // Overflow on html/body clips the viewport, not a box.
      if (node === element || this.clip || node === body || node === body?.parentElement) continue
      if (clips(computed)) this.clip = node
    }
  }
}

/** Inputs, lazy uniforms and the masks' values of one layer. */
export class Inputs {
  readonly input: Input = new Input()
  readonly styles: Styles = new Styles()
  /** Clip drawn in box UV as (min u, min v, max u, max v), the owner's or the ancestor's. */
  readonly clip: number[] = [...OPEN]
  /** Media crop set by `media.ts` as (scale u, scale v, offset u, offset v). */
  readonly crop: number[] = [1, 1, 0, 0]
  /** Box size for `u.size` and the masks, the posed size once compose has posed the layer. */
  readonly size: [number, number] = [0, 0]
  /** Opacity changed since the previous frame. Frames keep coming until it settles. */
  fading = false
  /** CSS opacity product as last read. A ghost keeps it. */
  css = 1
  /** border-radius drawn, the copy's override or the element's. */
  radius = 0
  /** `clip` actually cuts the box. */
  #clipped = false
  /** Clipping ancestor's box in box UV as last read. A held box or a ghost keeps it. */
  readonly #seen: number[] = [...OPEN]
  /** No clipping ancestor, as last read. */
  #open = true
  readonly #uniforms = new Map<LayerUniform, UniformKind>()

  /** Hover is still easing toward its target and someone reads it. */
  get easing(): boolean {
    const { input } = this
    return input.hoverRead && input.damped !== (input.isOver && !input.reducedMotion ? 1 : 0)
  }

  uniform(name: LayerUniform): UniformKind {
    let node = this.#uniforms.get(name)
    if (node) return node
    if (name === 'hover') this.input.hoverRead = true
    if (POINTED.has(name)) this.input.point()
    node = newUniform(name)
    this.#uniforms.set(name, node)
    this.#write(name, node)
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
    const input = this.input
    input.wake = frame.wake
    // Reading the pointer makes moves draw frames, so only layers that use it read it.
    if (input.pointed) this.#readPointer(frame)
    const target = input.isOver ? 1 : 0
    const next = input.damped + (target - input.damped) * (1 - Math.exp(-HOVER_RATE * frame.delta))
    input.damped = frame.reduced ? 0 : Math.abs(target - next) < HOVER_SNAP ? target : next
    input.speed = frame.velocity
    input.progress = progress
    input.pin = Math.min(1, Math.max(0, pin))
    if (!frame.reduced) input.advance(frame.delta)
    input.delta = frame.delta
    input.reducedMotion = frame.reduced
    // Read under a held box too, so an owner lands a copy at the opacity the page has now.
    if (!frozen && this.styles.chain.length) this.css = this.styles.opacity(frame.opacities)
    const presence = copy?.presence ?? 1
    let opacity = copy?.box ? 1 : this.css
    if (copy) opacity *= copy.opacity * (copy.fade ? presence : 1)
    this.fading = opacity !== input.opacity || presence !== input.presence
    input.opacity = opacity
    input.presence = presence
    this.radius = copy?.radius ?? this.styles.radius
    this.size[0] = input.width
    this.size[1] = input.height
    this.#updateClip(clipBox, copy?.clip)
    for (const [name, node] of this.#uniforms) this.#write(name, node)
  }

  /** The clip drawn on `box` (the posed one, else layout) as a viewport box, undefined when open. */
  viewportClip({ x, y, width, height }: Box = this.input): Box | undefined {
    if (!this.#clipped) return undefined
    const [u0, v0, u1, v1] = this.clip as [number, number, number, number]
    return {
      x: x + u0 * width,
      y: y + (1 - v1) * height,
      width: (u1 - u0) * width,
      height: (v1 - v0) * height,
    }
  }

  /** A pose with `clip: false`: no clip in this frame, nor for a box held from it. */
  open(): void {
    this.#open = true
    this.#clipped = false
    for (let index = 0; index < 4; index++) {
      this.clip[index] = this.#seen[index] = OPEN[index] as number
    }
  }

  /** Writes the pose: `u.size`, the masks and the crop follow the box drawn. */
  resize(width: number, height: number): void {
    this.size[0] = width
    this.size[1] = height
    for (const name of ['size', 'crop', 'radius', 'clip'] as const) {
      const node = this.#uniforms.get(name)
      if (node) this.#write(name, node)
    }
  }

  #readPointer(frame: FrameInputs): void {
    const input = this.input
    const { x, y, inside } = frame.pointer
    if (inside) {
      input.at.x = (x - input.x) / (input.width || 1)
      input.at.y = 1 - (y - input.y) / (input.height || 1)
      const world = frame.toWorld(x, y, input.atWorld)
      input.atWorld.x = world.x
      input.atWorld.y = world.y
    }
    input.isOver =
      inside &&
      x >= input.x &&
      x <= input.x + input.width &&
      y >= input.y &&
      y <= input.y + input.height
  }

  /** The ancestor's clip (unless kept as last read), then the copy's `clip` over it. */
  #updateClip(clipBox: Rect | undefined | false, own: Box | undefined): void {
    const seen = this.#seen
    if (clipBox !== false) {
      this.#open = !clipBox
      if (clipBox) this.#cut(seen, clipBox.left, clipBox.top, clipBox.right, clipBox.bottom)
      else for (let index = 0; index < 4; index++) seen[index] = OPEN[index] as number
    }
    if (own) this.#cut(this.clip, own.x, own.y, own.x + own.width, own.y + own.height)
    else for (let index = 0; index < 4; index++) this.clip[index] = seen[index] as number
    this.#clipped = !!own || !this.#open
  }

  /** Converts a viewport rectangle to the box UV of `input`. */
  #cut(uv: number[], left: number, top: number, right: number, bottom: number): void {
    const { x, y } = this.input
    const width = this.input.width || 1
    const height = this.input.height || 1
    uv[0] = (left - x) / width
    uv[1] = 1 - (bottom - y) / height
    uv[2] = (right - x) / width
    uv[3] = 1 - (top - y) / height
  }

  #write(name: LayerUniform, node: UniformKind): void {
    const input = this.input
    const value = node.value as number | Vector2 | Vector4
    switch (name) {
      case 'pointer':
        ;(value as Vector2).set(input.at.x, input.at.y)
        return
      case 'pointerWorld':
        ;(value as Vector2).set(input.atWorld.x, input.atWorld.y)
        return
      case 'size':
        ;(value as Vector2).set(this.size[0], this.size[1])
        return
      case 'crop':
        ;(value as Vector4).fromArray(this.crop)
        return
      case 'clip':
        ;(value as Vector4).fromArray(this.clip)
        return
      case 'radius':
        node.value = this.radius
        return
      case 'hover':
        node.value = input.damped
        return
      default:
        node.value = input[name]
    }
  }
}

function newUniform(name: LayerUniform): UniformKind {
  if (VEC2.has(name)) return uniform(new Vector2())
  if (VEC4.has(name)) {
    return uniform(name === 'clip' ? new Vector4(...OPEN) : new Vector4(1, 1, 0, 0))
  }
  return uniform(name === 'opacity' || name === 'presence' ? 1 : 0)
}

/**
 * A computed corner radius in px. Mid-transition between px and % the computed value is
 * calc(Apx + B%), so the terms are summed.
 */
function cornerPx(corner: string, shorter: () => number): number {
  let px = 0
  for (const [, number, unit] of (corner || '').matchAll(/(-?[\d.]+(?:e-?\d+)?)(px|%)?/g)) {
    const value = Number.parseFloat(number as string) || 0
    px += unit === '%' ? (shorter() * value) / 100 : value
    if (!corner?.startsWith('calc(')) break
  }
  return px
}

/** Transforms, will-change, opacity below 1 and fixed position move a box without events. */
function movesUnseen(style: CSSStyleDeclaration): boolean {
  const transform = style.transform && style.transform !== 'none'
  return (
    !!transform ||
    /transform|opacity/.test(style.willChange) ||
    Number.parseFloat(style.opacity) < 1 ||
    style.position === 'fixed'
  )
}

/** Overflow other than visible, or a clip-path inset. */
function clips(style: CSSStyleDeclaration): boolean {
  const overflows =
    (style.overflowX && style.overflowX !== 'visible') ||
    (style.overflowY && style.overflowY !== 'visible')
  return !!overflows || !!style.clipPath?.startsWith('inset(')
}
