import type { Off } from '@diorama/core'
import { defineEffect } from '../define'
import type { Effect, Layer } from '../types'
import type { Phase } from './instance'
import type { LayerImpl } from './layer'
import { isMedia } from './media'
import type { World } from './world'

/** Draws the image unchanged. `layers()` gives it to bare media. */
export const image: Effect<Record<never, never>> = /*#__PURE__*/ defineEffect({
  name: 'image',
  media: true,
  setup({ surface }) {
    surface.segments(1)
  },
})

interface Query {
  readonly phase: Phase
  readonly selector: string
  readonly list: LayerImpl[]
  readonly items: Map<Element, Off>
}

/** Live `layers()` queries. Their lists follow the document after each reconcile. */
export class Queries {
  readonly #world: World
  readonly #all = new Set<Query>()

  constructor(world: World) {
    this.#world = world
  }

  add(phase: Phase, selector: string): readonly Layer[] {
    const query: Query = { phase, selector, list: [], items: new Map() }
    // Throws a SyntaxError on an invalid selector.
    phase.inst.rec.element.querySelectorAll(selector)
    this.#all.add(query)
    phase.offs.push(() => {
      this.#all.delete(query)
      for (const off of query.items.values()) off()
      query.items.clear()
      query.list.length = 0
    })
    this.#evaluate(query)
    return query.list
  }

  scanned(): void {
    for (const query of this.#all) this.#evaluate(query)
  }

  /**
   * Every match gets its own lease, and bare media also get `image` from this instance, so
   * removing another effect from a child never pulls it out of a pose.
   */
  #evaluate(query: Query): void {
    const world = this.#world
    const found = [...query.phase.inst.rec.element.querySelectorAll(query.selector)]
    const set = new Set(found)
    let changed = false
    for (const [el, off] of query.items) {
      if (set.has(el)) continue
      off()
      query.items.delete(el)
      changed = true
    }
    for (const el of found) {
      if (query.items.has(el)) continue
      const offs: Off[] = [world.lease(el)]
      if (isMedia(el)) offs.push(world.host.attach(el, image))
      query.items.set(el, () => {
        for (const off of offs) off()
      })
      changed = true
    }
    if (!changed) return
    query.list.length = 0
    for (const el of found) query.list.push(world.layers.get(el) as LayerImpl)
    world.invalidate()
  }
}
