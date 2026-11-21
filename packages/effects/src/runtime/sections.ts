// Sections: `[data-dio-section]` ancestors (or the parent of a sticky stage) that layers take
// scroll `progress` and `pin` from. Also tells the stage when a sticky stage is pinned on screen.
import type { Anchor, AnchorsApi } from '@dioramajs/core'

const SECTION_SELECTOR = '[data-dio-section]'
/** A stage this close to its sticky `top`, in px, counts as stuck. */
const STUCK_TOLERANCE = 0.5

/** The marked section a layer takes `progress` and `pin` from, never the element itself. */
export const marked = (element: Element): Element | undefined => {
  const found = element.closest(SECTION_SELECTOR)
  return found && found !== element ? found : undefined
}

/** `ctx.section()`: the marked section, else the parent of the closest sticky, else the element. */
export function sectionOf(element: Element): Element {
  const found = element.closest(SECTION_SELECTOR)
  if (found) return found
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).position === 'sticky') return node.parentElement ?? element
  }
  return element
}

/** A sticky child of a section and its computed `top`, px. */
interface Stage {
  readonly element: Element
  readonly anchor: Anchor
  readonly top: number
}

/** A section anchor and the holds on it. */
interface Held {
  readonly anchor: Anchor
  count: number
  /** The section's anchor version its stages were looked up at. */
  version: number
  stages: Stage[]
}

/** Section anchors: one per section element, shared by its layers and phases, counted. */
export class Sections {
  readonly #anchors: AnchorsApi
  readonly #held = new Map<Element, Held>()
  /**
   * A sticky stage of a held section is stuck and fills half the viewport or more, as of the
   * last `measure`. The stage canvas stops following scroll meanwhile (`stage.hold`).
   */
  pinned = false

  constructor(anchors: AnchorsApi) {
    this.#anchors = anchors
  }

  /** Moves a hold from the section of `from` to `to`. Returns the anchor of `to`. */
  swap(from: Anchor | undefined, to: Element | undefined): Anchor | undefined {
    if (from?.element === to) return from
    if (from) this.release(from)
    if (!to) return undefined
    const held = this.#held.get(to)
    if (held) {
      held.count++
      return held.anchor
    }
    // A section is the tall box around a sticky stage, not inside one: layout tracking is enough.
    const anchor = this.#anchors.track(to, { live: false })
    this.#held.set(to, { anchor, count: 1, version: -1, stages: [] })
    return anchor
  }

  release(anchor: Anchor): void {
    const held = this.#held.get(anchor.element)
    if (held?.anchor !== anchor || --held.count) return
    this.#held.delete(anchor.element)
    anchor.dispose()
    for (const stage of held.stages) stage.anchor.dispose()
  }

  /**
   * Sets `pinned` after the anchors pass. A stage is stuck while its box sits at its sticky
   * `top`. Stages are the sticky children of a section, looked up when the section re-measures.
   */
  measure(viewport: number): void {
    let pinned = false
    for (const held of this.#held.values()) {
      if (held.version !== held.anchor.version) this.#stages(held)
      for (const { anchor, top } of held.stages) {
        const stuck = Math.abs(anchor.y - top) < STUCK_TOLERANCE
        if (stuck && anchor.height >= viewport / 2) pinned = true
      }
    }
    this.pinned = pinned
  }

  /** Looks up the sticky children of a section again, keeping the anchors of those that stay. */
  #stages(held: Held): void {
    held.version = held.anchor.version
    const stages: Stage[] = []
    for (const element of held.anchor.element.children) {
      const style = getComputedStyle(element)
      // A stage pinned by its bottom (`top: auto`) is not followed.
      const top = Number.parseFloat(style.top)
      if (style.position !== 'sticky' || Number.isNaN(top)) continue
      const anchor =
        held.stages.find((stage) => stage.element === element)?.anchor ??
        this.#anchors.track(element)
      stages.push({ element, anchor, top })
    }
    for (const { anchor } of held.stages) {
      if (!stages.some((stage) => stage.anchor === anchor)) anchor.dispose()
    }
    held.stages = stages
  }
}
