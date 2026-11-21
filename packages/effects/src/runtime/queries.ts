// `ctx.layers(selector)`: live lists of the layers of matching descendants, re-evaluated after
// each reconcile. Each match is leased, and bare media get the `image` effect to draw them.
import type { Off } from '@dioramajs/core'
import { defineEffect } from '../effect'
import type { Effect, Layer } from '../types'
import type { Phase } from './instance'
import type { LayerImpl } from './layer'
import { isMedia } from './media'
import type { World } from './world'

/** Draws the image unchanged. `layers()` gives it to bare media. */
export const image: Effect<Record<never, never>> = /*#__PURE__*/ defineEffect({
  name: 'image',
  media: true,
  quality: {},
  setup({ surface }) {
    surface.segments(1)
  },
})

/** One `layers()` call: the list it returned, kept live, and a release per match. */
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
    const matched = new Set(found)
    let changed = false
    for (const [element, off] of query.items) {
      if (matched.has(element)) continue
      off()
      query.items.delete(element)
      changed = true
    }
    for (const element of found) {
      if (query.items.has(element)) continue
      const offs: Off[] = [world.lease(element)]
      if (isMedia(element)) offs.push(world.host.attach(element, image))
      query.items.set(element, () => {
        for (const off of offs) off()
      })
      changed = true
    }
    if (!changed) return
    query.list.length = 0
    for (const element of found) query.list.push(world.layers.get(element) as LayerImpl)
    world.invalidate()
  }
}
