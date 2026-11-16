import type { Group, Mesh, Object3D } from 'three/webgpu'
import { DEV } from '../define'
import { EffectError } from '../errors'
import type { InstanceStatus, TakeOptions } from '../types'
import { type CopyHost, CopyImpl } from './copy'
import type { LayerImpl } from './layer'
import type { World } from './world'

/** renderOrder offset of each `above` level. */
const ABOVE = 1e6
/** Statuses after which an element's copy will not become drawable. */
const DEAD: ReadonlySet<InstanceStatus> = new Set(['failed', 'off', 'unavailable'])

/** Taken copies and ghosts, i.e. layers under an owner that may outlive their element. */
export class Copies {
  /** Taken copies of elements in the document, or with no layer yet. */
  readonly taken: Map<Element, CopyImpl> = new Map()
  /** Layers whose element left while the copy was taken. Owned by the taker. */
  readonly ghosts: Set<LayerImpl> = new Set()
  /** Placed objects compiling under a veil. Their dispose waits for the compile. */
  readonly compiling: WeakMap<Object3D, Promise<void>> = new WeakMap()
  readonly #world: World
  readonly #host: CopyHost
  /** Removed elements decided in this reconcile, so the hook runs once per element and pass. */
  #declined = new WeakSet<Element>()

  constructor(world: World) {
    this.#world = world
    const { host } = world
    this.#host = {
      invalidate: () => world.invalidate(),
      veil: (element, on) => host.veil(element, on),
      release: (copy) => this.#free(copy),
      drawable: (copy) => this.#drawable(copy),
      abandoned: (copy) => {
        if (DEV) {
          const { element } = copy
          const error = new EffectError('EFFECT_TARGET', 'a taken copy was abandoned', { element })
          host.warn('abandoned', error)
        }
        copy.release()
      },
    }
  }

  take(element: Element, options: TakeOptions = {}): CopyImpl {
    const copy = new CopyImpl(element, this.#host, options)
    this.taken.set(element, copy)
    const layer = this.#world.layers.get(element)
    if (layer) this.adopt(layer, copy)
    if (options.veil) copy.veil = true
    if (options.signal?.aborted) copy.release()
    this.decide(copy)
    return copy
  }

  adopt(layer: LayerImpl, copy: CopyImpl): void {
    layer.taken = copy
    copy.layer = layer
  }

  handover(element: Element): boolean {
    const layer = this.#world.layers.get(element)
    if (!layer) return false
    const copy = layer.taken
    if (copy) {
      if (copy.leave === 'ghost') return true
      copy.release()
      // The element's other running records must not offer the released copy to the hook.
      this.#declined.add(element)
      return false
    }
    const drawn = layer.drawn
    if (!drawn || !layer.copy() || this.#declined.has(element)) return false
    let open = true
    let taken: CopyImpl | undefined
    this.#world.app.callHook('effects:release', {
      element,
      drawn,
      visible: layer.visible,
      take: (options) => {
        if (taken || !open) return undefined
        taken = this.take(element, { signal: options?.signal })
        return taken
      },
    })
    open = false
    // Other running records of the element ask again in this pass. The answer stands.
    if (!taken) this.#declined.add(element)
    return !!taken && !taken.released
  }

  /** The element left with its copy taken. The layer lives on as a ghost. */
  haunt(layer: LayerImpl, copy: CopyImpl): void {
    const world = this.#world
    const { element, input } = layer
    world.layers.delete(element)
    this.taken.delete(element)
    this.ghosts.add(layer)
    world.reorder()
    layer.detach()
    layer.rest = layer.drawn ?? { x: input.x, y: input.y, width: input.width, height: input.height }
    layer.anchor.dispose()
    layer.media?.freeze()
    copy.haunt()
  }

  /** A ghost failed. Release it with a warning, its records may already live a new life. */
  fault(layer: LayerImpl, error: EffectError): void {
    if (DEV) {
      const message = `a ghost failed and was released: ${error.message}`
      const { element } = layer
      this.#world.host.warn('ghost', new EffectError('EFFECT_TARGET', message, { element }))
    }
    layer.taken?.release()
  }

  /** A layer goes away. Its copy leaves with it or waits for a new layer. */
  drop(layer: LayerImpl): void {
    const copy = layer.taken
    if (!copy) return
    layer.taken = undefined
    copy.layer = undefined
    this.#lower(copy)
    // With `leave: 'release'` the copy goes with its records, otherwise it waits for a layer.
    if (copy.leave === 'release' && !layer.element.isConnected) copy.release()
    else copy.decide(false)
  }

  /** End of a reconcile pass. Removed elements may be offered again and pending copies decide. */
  scanned(): void {
    this.#declined = new WeakSet()
    for (const copy of this.taken.values()) this.decide(copy, true)
  }

  /** Settles `ready` once the answer is known. "No records" counts only at the end of a reconcile. */
  decide(copy: CopyImpl, scanned = false): void {
    if (!copy.pending) return
    if (copy.drawable) {
      copy.decide(true)
      return
    }
    const records = this.#world.host.instancesOf(copy.element)
    const dead = records.length
      ? records.every((r) => DEAD.has(r.status))
      : scanned && copy.element.isConnected
    if (dead) copy.decide(false)
  }

  /** Applies `above` as an offset on every group of the layer, keeping the author's order inside. */
  lift(layer: LayerImpl, copy: CopyImpl): void {
    const by = ABOVE * copy.above
    if (by !== copy.lift) this.#lower(copy)
    copy.lift = by
    if (!by) return
    const lift = (object: Object3D): void => {
      if (!(object as Group).isGroup || copy.lifted.has(object)) return
      copy.lifted.set(object, object.renderOrder)
      object.renderOrder += by
    }
    layer.root.traverse(lift)
    for (const inst of layer.insts) {
      for (const phase of [inst.current, inst.next]) phase?.viewport?.traverse(lift)
    }
  }

  /** Called in present. Veiled copies warm up, then pending ones decide, ghosts included. */
  present(): void {
    this.#warm()
    for (const copy of this.taken.values()) this.decide(copy)
    for (const layer of this.ghosts) if (layer.taken) this.decide(layer.taken)
  }

  dispose(): void {
    for (const copy of [...this.taken.values()]) copy.release()
    for (const layer of [...this.ghosts]) layer.taken?.release()
  }

  /** The only way a ghost ends: its instances close, then its layer. */
  #bury(layer: LayerImpl): void {
    const world = this.#world
    world.later(() => {
      for (const inst of [...layer.insts]) world.close(inst)
      world.release(layer)
    })
  }

  /** A ghost goes, a connected element's layer returns to its DOM life. */
  #free(copy: CopyImpl): void {
    const { element, layer } = copy
    // The owner may still hold the released copy, so drop its scene references.
    copy.layer = undefined
    this.#lower(copy)
    if (copy.ghost) {
      if (layer) this.#bury(layer)
      return
    }
    if (this.taken.get(element) === copy) this.taken.delete(element)
    if (layer) layer.taken = undefined
    this.#world.invalidate()
  }

  /** A veiled copy also waits for its placed objects to compile. */
  #drawable(copy: CopyImpl): boolean {
    const layer = copy.layer
    if (!layer?.copy()) return false
    if (!copy.veil || copy.ghost) return true
    for (const inst of layer.insts) {
      for (const { object } of inst.current?.placed ?? []) {
        if (copy.compiled.get(object) !== true) return false
      }
    }
    return true
  }

  #lower(copy: CopyImpl): void {
    for (const [object, order] of copy.lifted) object.renderOrder = order
    copy.lifted.clear()
    copy.lift = 0
  }

  /** Gets veiled copies ready before they show: texture uploaded, placed objects compiled. */
  #warm(): void {
    const world = this.#world
    let uploads = 1
    for (const copy of this.taken.values()) {
      const layer = copy.layer
      if (!copy.veil || !layer) continue
      const texture = layer.media?.state === 'ready' ? layer.media.texture : undefined
      if (texture && copy.uploaded !== texture.image) {
        // One upload per frame, each copies pixels on the main thread.
        if (uploads-- > 0) {
          world.render.renderer.initTexture(texture)
          copy.uploaded = texture.image
        } else world.invalidate()
      }
      for (const inst of layer.insts) {
        const phase = inst.current
        if (phase?.state !== 'active') continue
        for (const { object } of phase.placed) {
          if (copy.compiled.has(object)) continue
          copy.compiled.set(object, false)
          // Compile the object itself, since projection would skip its hidden parents. The queue
          // may hold it past the phase, so objects of a closed phase are skipped.
          const job: Promise<void> = world
            .compileWith(layer, object as Mesh, () => phase.state === 'active')
            // A later copy may queue the object again, and only the last job counts.
            .then(() => {
              if (this.compiling.get(object) === job) this.compiling.delete(object)
              copy.compiled.set(object, true)
              world.invalidate()
            })
          this.compiling.set(object, job)
        }
      }
    }
  }
}
