// Sections: `[data-dio-section]` ancestors (or the parent of a sticky stage) that layers take
// scroll `progress` and `pin` from. Also tells the stage when a sticky stage is pinned on screen.
import type { Anchor, AnchorsApi, ScrollSpan } from '@dioramajs/core'

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
  /** Page y of its top in the flow, unstuck, px. Exact once seen below its sticky `top`. */
  natural: number
  /** Section border and padding plus the stage's own margin under it, px. */
  readonly after: number
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
   * Page scroll spans over which a sticky stage of a held section, half the viewport tall or
   * more, is stuck, as of the last `measure`. The stage canvas stands still in them (`stage.pin`).
   */
  spans: ScrollSpan[] = []

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
   * Sets `spans` after the anchors pass. A stage sticks once the page scrolls its flow position
   * up to its sticky `top`, and lets go once its bottom meets the section's content bottom.
   * Stages are the sticky children of a section, looked up when the section re-measures.
   */
  measure(viewport: number, scrollY: number): void {
    const spans: ScrollSpan[] = []
    for (const held of this.#held.values()) {
      if (held.version !== held.anchor.version) this.#stages(held, scrollY)
      const bottom = held.anchor.y + held.anchor.height + scrollY
      for (const stage of held.stages) {
        const { anchor, top } = stage
        if (anchor.height < viewport / 2) continue
        if (anchor.y > top + STUCK_TOLERANCE) stage.natural = anchor.y + scrollY
        const start = stage.natural - top
        const end = bottom - stage.after - anchor.height - top
        if (end > start) spans.push([start, end])
      }
    }
    this.spans = spans
  }

  /** Looks up the sticky children of a section again, keeping the anchors of those that stay. */
  #stages(held: Held, scrollY: number): void {
    held.version = held.anchor.version
    const section = held.anchor.element
    const stages: Stage[] = []
    let box: CSSStyleDeclaration | undefined
    for (const element of section.children) {
      const style = getComputedStyle(element)
      // A stage pinned by its bottom (`top: auto`) is not followed.
      const top = Number.parseFloat(style.top)
      if (style.position !== 'sticky' || Number.isNaN(top)) continue
      box ??= getComputedStyle(section)
      const kept = held.stages.find((stage) => stage.element === element)
      const anchor = kept?.anchor ?? this.#anchors.track(element)
      const after = px(box.borderBottomWidth) + px(box.paddingBottom) + px(style.marginBottom)
      const natural = flowTop(element, section, style, box) + scrollY
      stages.push({ element, anchor, top, natural, after })
    }
    for (const { anchor } of held.stages) {
      if (!stages.some((stage) => stage.anchor === anchor)) anchor.dispose()
    }
    held.stages = stages
  }
}

const px = (value: string): number => Number.parseFloat(value) || 0

/**
 * Viewport y of a sticky stage's top as if it were not stuck, from what comes before it: the
 * previous sibling, or the section's content top. Used until the stage is seen unstuck.
 */
function flowTop(
  element: Element,
  section: Element,
  style: CSSStyleDeclaration,
  box: CSSStyleDeclaration,
): number {
  const margin = px(style.marginTop)
  const previous = element.previousElementSibling
  if (previous) {
    const gap = Math.max(margin, px(getComputedStyle(previous).marginBottom))
    return previous.getBoundingClientRect().bottom + gap
  }
  const inset = px(box.borderTopWidth) + px(box.paddingTop)
  // Without border or padding a block's first child margin collapses through it.
  const collapsed = inset === 0 && box.display === 'block'
  return section.getBoundingClientRect().top + inset + (collapsed ? 0 : margin)
}
