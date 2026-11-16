import type { Object3D } from 'three/webgpu'
import type { Box, Copy, CopyState, Crop, DrawnBox, TakeOptions } from '../types'
import type { Taken } from './inputs'
import type { LayerImpl } from './layer'

export interface CopyHost {
  invalidate(): void
  veil(element: Element, on: boolean): void
  /** A ghost goes through its single exit, a connected copy returns to its DOM life. */
  release(copy: CopyImpl): void
  drawable(copy: CopyImpl): boolean
  /** Nobody wrote to a ghost or veil without a signal for 10 s. */
  abandoned(copy: CopyImpl): void
}

/** ms without writes after which an unsignalled ghost or veil is abandoned. */
const NET = 10_000

/** An element's GL copy under an owner. */
export class CopyImpl implements Copy, Taken {
  readonly element: Element
  readonly ready: Promise<boolean>
  layer: LayerImpl | undefined
  /** The element left and the layer lives on in the runtime's ghosts. */
  ghost = false
  released = false
  /** Placed objects compiled under the veil, false while compiling. */
  readonly compiled: WeakMap<Object3D, boolean> = new WeakMap()
  /** The image last uploaded under the veil. */
  uploaded: unknown
  /** Groups lifted by `above` with their original renderOrder. `lift` is the offset. */
  readonly lifted: Map<Object3D, number> = new Map()
  lift = 0
  readonly #host: CopyHost
  readonly #signal: AbortSignal | undefined
  #settle: ((ready: boolean) => void) | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #box: Box | undefined
  #radius: number | undefined
  #clip: Box | undefined
  #opacity = 1
  #presence = 1
  #veil = false
  #above = 0
  #crop: Crop | undefined
  #leave: 'ghost' | 'release'

  constructor(element: Element, host: CopyHost, options: TakeOptions) {
    this.element = element
    this.#host = host
    this.#leave = options.leave ?? 'ghost'
    this.#signal = options.signal
    this.ready = new Promise((resolve) => {
      this.#settle = resolve
    })
    this.#signal?.addEventListener('abort', this.#abort, { once: true })
  }

  readonly #abort = (): void => this.release()

  get state(): CopyState {
    return this.released ? 'released' : this.ghost ? 'ghost' : this.drawable ? 'ready' : 'none'
  }
  get drawable(): boolean {
    return !this.released && this.#host.drawable(this)
  }
  get drawn(): DrawnBox | undefined {
    return this.layer?.drawn
  }
  get source(): string {
    return this.layer?.media?.src ?? ''
  }
  get effects(): readonly string[] {
    return this.layer?.insts.map((i) => i.rec.name) ?? []
  }
  get cssOpacity(): number {
    return this.layer?.inputs.css ?? 1
  }
  get fade(): boolean {
    return this.layer?.fades() ?? true
  }
  /** `ready` is not settled yet. */
  get pending(): boolean {
    return this.#settle !== undefined
  }

  get box(): Box | undefined {
    return this.#box
  }
  set box(box: Box | undefined) {
    if (this.released) return
    this.#box = box
    this.#write()
  }
  get radius(): number | undefined {
    return this.#radius
  }
  set radius(radius: number | undefined) {
    if (this.released) return
    this.#radius = radius
    this.#write()
  }
  get clip(): Box | undefined {
    return this.#clip
  }
  set clip(clip: Box | undefined) {
    if (this.released) return
    this.#clip = clip
    this.#write()
  }
  get opacity(): number {
    return this.#opacity
  }
  set opacity(opacity: number) {
    if (this.released) return
    this.#opacity = Math.min(1, Math.max(0, opacity))
    this.#write()
  }
  get presence(): number {
    return this.#presence
  }
  set presence(presence: number) {
    if (this.released) return
    this.#presence = Math.min(1, Math.max(0, presence))
    this.#write()
  }
  get veil(): boolean {
    return this.#veil
  }
  set veil(on: boolean) {
    if (this.released || on === this.#veil) return
    this.#veil = on
    // A ghost has no DOM, so its veil hides only the copy.
    if (!this.ghost) this.#host.veil(this.element, on)
    this.#write()
  }
  get above(): number {
    return this.#above
  }
  set above(level: number) {
    if (this.released) return
    this.#above = Math.max(0, level)
    this.#write()
  }
  get crop(): Crop | undefined {
    return this.#crop
  }
  set crop(crop: Crop | undefined) {
    if (this.released) return
    this.#crop = crop
    this.#write()
  }
  cropAt(box: Box): Crop | undefined {
    const layer = this.layer
    const media = layer?.media
    const [iw, ih] = media?.size() ?? [0, 0]
    if (!layer || !media || !iw || !ih || !box.width || !box.height) return undefined
    const c = [1, 1, 0, 0]
    media.fit(layer.inputs.styles, box.width, box.height, c)
    const [width = 1, height = 1, x = 0, y = 0] = c
    return { x, y, width, height }
  }
  get leave(): 'ghost' | 'release' {
    return this.#leave
  }
  set leave(leave: 'ghost' | 'release') {
    if (!this.released) this.#leave = leave
  }

  decide(ready: boolean): void {
    this.#settle?.(ready)
    this.#settle = undefined
  }

  /** The element left. Its DOM veil goes with it, the copy lives on. */
  haunt(): void {
    this.ghost = true
    if (this.#veil) this.#host.veil(this.element, false)
    this.#arm()
  }

  release(): void {
    if (this.released) return
    this.released = true
    clearTimeout(this.#timer)
    this.#signal?.removeEventListener('abort', this.#abort)
    if (this.#veil && !this.ghost) this.#host.veil(this.element, false)
    this.#host.release(this)
    this.#box = this.#radius = this.#clip = this.#crop = undefined
    this.#opacity = this.#presence = 1
    this.#veil = false
    this.#above = 0
    this.#leave = 'ghost'
    this.decide(false)
  }

  dispose(): void {
    this.release()
  }

  #write(): void {
    this.#arm()
    this.#host.invalidate()
  }

  /** Restarts the safety net of a copy whose owner gave no signal. */
  #arm(): void {
    clearTimeout(this.#timer)
    this.#timer =
      !this.#signal && (this.ghost || this.#veil)
        ? setTimeout(() => this.#host.abandoned(this), NET)
        : undefined
  }
}
