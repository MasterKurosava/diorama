// Painter's order between layers: a drawing pipeline that sends every item of a layer to three's
// transparent list under the layer's key, so layers draw one after another in document order.
import type { AppScope } from '@dioramajs/core'
import { positionGeometry, vec4 } from 'three/tsl'
import {
  AlwaysDepth,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Object3D,
  PlaneGeometry,
  StandardDrawingPipeline,
  type WebGPURenderer,
} from 'three/webgpu'
import type { LayerImpl } from './layer'

type Clip = Parameters<StandardDrawingPipeline['project']>[4]

/**
 * Key step between two layers in document order. An effect's own Group renderOrder stays inside
 * ±STEP/2, and every key stays far below a draw level (`ABOVE` = 1e6, layer.ts).
 */
const STEP = 256
/** Last ranked layer: later visible layers share its key. */
const LAST = 1000
/** Offset of the band under every layer of a level, for content with a negative renderOrder. */
const UNDER = 400_000
/** Argument positions of `pushRenderItem`. */
const ITEM_OBJECT = 1
const ITEM_MATERIAL = 3
const ITEM_GROUP_ORDER = 4

/** A three render item, as far as the sort reads it. */
interface Item {
  readonly id: number | null
  readonly material: Material | null
  readonly groupOrder: number | null
  readonly renderOrder: number | null
  readonly z: number | null
}

/** Goes to three's transparent list on its own (RenderList.push). */
function seeThrough(material: Material): boolean {
  const optional = material as Material & {
    transmission?: number
    transmissionNode?: { isNode?: boolean } | null
    backdropNode?: { isNode?: boolean } | null
  }
  return (
    optional.transparent === true ||
    (optional.transmission ?? 0) > 0 ||
    optional.transmissionNode?.isNode === true ||
    optional.backdropNode?.isNode === true
  )
}

/**
 * Sort of the transparent list, which holds every layer: by key, then in a layer its opaque items
 * front to back before its transparent ones back to front, as three sorts its two lists.
 */
export function painterSort(a: Item, b: Item): number {
  const groups = (a.groupOrder as number) - (b.groupOrder as number)
  if (groups) return groups
  const orders = (a.renderOrder as number) - (b.renderOrder as number)
  if (orders) return orders
  const clear = seeThrough(a.material as Material)
  if (clear !== seeThrough(b.material as Material)) return clear ? 1 : -1
  const z = (a.z as number) - (b.z as number)
  if (z) return clear ? -z : z
  return (a.id as number) - (b.id as number)
}

/** What one layer drew in this projection. */
interface Seen {
  order: number
  tests: boolean
  writes: boolean
  readonly clip: Clip
}

/**
 * three draws all opaque objects before all transparent ones, so an opaque model would draw
 * before the copy of an element under it, and that copy, depth-tested at z = 0, would hide the
 * half of the model behind the page plane. Here every item of a layer goes to the transparent
 * list under the layer's key, so layers draw one after another in document order. Depth matters
 * only inside a layer: copies never test or write it, and a layer that tests depth after one
 * that wrote it starts with a depth reset.
 */
export class Painter extends StandardDrawingPipeline {
  /** Objects at the top of a layer (its root, viewport and overlay groups) and their key. */
  readonly keys: Map<Object3D, number> = new Map()
  /** Depth resets in the last projection. */
  resets = 0
  readonly #seen = new Map<number, Seen>()
  /** Depth reset meshes, sharing the first one's geometry and material. */
  readonly #pool: Mesh[] = []
  /** Key of the layer being projected. */
  #key: number | undefined
  #clip: Clip | undefined

  /** Keys of this frame: ghosts, then layers in document order. Hidden layers draw nothing. */
  rank(ghosts: Iterable<LayerImpl>, layers: Iterable<LayerImpl>): void {
    this.keys.clear()
    let rank = 0
    const add = (layer: LayerImpl): void => {
      if (!layer.visible) return
      const key = Math.min(rank++, LAST) * STEP
      this.keys.set(layer.root, key)
      for (const inst of layer.insts) {
        for (const phase of [inst.current, inst.next]) {
          if (phase?.viewport) this.keys.set(phase.viewport, key)
          if (phase?.overlay) this.keys.set(phase.overlay, key)
        }
      }
    }
    for (const layer of ghosts) add(layer)
    for (const layer of layers) add(layer)
  }

  override beginRenderList(renderList: unknown): void {
    this.#seen.clear()
    super.beginRenderList(renderList)
  }

  override project(
    object: Object3D,
    camera: Parameters<StandardDrawingPipeline['project']>[1],
    groupOrder: number,
    renderList: unknown,
    clip: Clip,
  ): void {
    const key = this.keys.get(object)
    if (key === undefined) {
      super.project(object, camera, groupOrder, renderList, clip)
      return
    }
    const outer = this.#key
    this.#key = key
    this.#clip = clip
    try {
      super.project(object, camera, groupOrder, renderList, clip)
    } finally {
      this.#key = outer
    }
  }

  override pushRenderItem(...args: Parameters<StandardDrawingPipeline['pushRenderItem']>): void {
    const key = this.#key
    const material = args[ITEM_MATERIAL]
    if (key === undefined) {
      super.pushRenderItem(...args)
      return
    }
    // A negative renderOrder (ambient's glow) draws under every layer of its level, by key.
    if (args[ITEM_OBJECT].renderOrder < 0) args[ITEM_GROUP_ORDER] += key - UNDER
    else {
      args[ITEM_GROUP_ORDER] += key
      const order = args[ITEM_GROUP_ORDER]
      let seen = this.#seen.get(key)
      if (!seen) {
        seen = { order, tests: false, writes: false, clip: this.#clip as Clip }
        this.#seen.set(key, seen)
      }
      seen.order = Math.min(seen.order, order)
      seen.tests ||= material.depthTest
      seen.writes ||= material.depthWrite
    }
    if (seeThrough(material)) {
      super.pushRenderItem(...args)
      return
    }
    // Into the transparent list with the rest of its layer. The flag is read only by the push.
    material.transparent = true
    try {
      super.pushRenderItem(...args)
    } finally {
      material.transparent = false
    }
  }

  override finishRenderList(renderList: unknown): void {
    this.resets = 0
    if (this.#seen.size > 1) {
      // Depth written by an earlier layer and not reset yet.
      let dirty = false
      for (const seen of [...this.#seen.values()].sort((a, b) => a.order - b.order)) {
        if (seen.tests && dirty) {
          const reset = this.#reset(this.resets++)
          super.pushRenderItem(
            renderList,
            reset,
            reset.geometry,
            reset.material as Material,
            seen.order,
            0,
            null,
            seen.clip,
          )
          dirty = false
        }
        dirty ||= seen.writes
      }
    }
    super.finishRenderList(renderList)
  }

  override dispose(): void {
    const first = this.#pool[0]
    first?.geometry.dispose()
    ;(first?.material as Material | undefined)?.dispose()
    this.#pool.length = 0
    super.dispose()
  }

  /** A full-screen draw that writes the far depth and no colour, first in its layer. */
  #reset(index: number): Mesh {
    let mesh = this.#pool[index]
    if (mesh) return mesh
    const first = this.#pool[0]
    let material = first?.material as MeshBasicNodeMaterial | undefined
    if (!material) {
      material = new MeshBasicNodeMaterial({
        transparent: true,
        colorWrite: false,
        depthFunc: AlwaysDepth,
      })
      material.vertexNode = vec4(positionGeometry.xy, 1, 1)
    }
    mesh = new Mesh(first?.geometry ?? new PlaneGeometry(2, 2), material)
    mesh.frustumCulled = false
    mesh.renderOrder = -Number.MAX_SAFE_INTEGER
    this.#pool.push(mesh)
    return mesh
  }
}

/**
 * Puts a painter on the renderer, undone with the scope. Undefined on a renderer without a
 * drawing pipeline (the test fake).
 */
export function paint(renderer: WebGPURenderer, scope: AppScope): Painter | undefined {
  const previous = (renderer as Partial<WebGPURenderer>).drawingPipeline
  if (!previous || typeof renderer.setTransparentSort !== 'function') return undefined
  const painter = new Painter()
  renderer.drawingPipeline = painter
  renderer.setTransparentSort(painterSort)
  scope.onDispose(() => {
    if (renderer.drawingPipeline === painter) {
      renderer.drawingPipeline = previous
      renderer.setTransparentSort(null)
    }
    painter.dispose()
  })
  return painter
}
