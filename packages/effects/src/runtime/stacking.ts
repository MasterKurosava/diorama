// Where an element paints among the page's stacking contexts, so copies draw in the order the
// browser paints their elements: a heading with `position: relative; z-index: 1` over a picture that
// comes later in the document draws above it, as the DOM does.

/** A stacking context around an element and its z-index, `auto` as 0. */
interface Context {
  readonly element: Element
  readonly z: number
}

/** The stacking contexts around an element, outermost first, and its own level in the last. */
export interface Stacking {
  readonly contexts: readonly Context[]
  /** 0 when the element paints with positioned content, `FLOW` in the normal flow under it. */
  readonly level: number
}

/** In-flow content paints under positioned content and above negative z-indices. */
const FLOW = -0.5

export const UNSTACKED: Stacking = { contexts: [], level: FLOW }

const CONTAINS = /\b(layout|paint|strict|content)\b/
const WILL_CHANGE =
  /\b(opacity|transform|translate|rotate|scale|filter|perspective|clip-path|mask|isolation|z-index|position)\b/

/**
 * Walks from the element to the root. The element's own filter is left out: the runtime hides a
 * drawn element with one, which would make every drawn element a stacking context.
 */
export function stackingOf(element: Element): Stacking {
  const contexts: Context[] = []
  let positioned = false
  const root = element.ownerDocument.documentElement
  for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
    const style = getComputedStyle(node)
    const position = style.position || 'static'
    const parent = node.parentElement
    // z-index also applies to flex and grid items that are not positioned.
    const z = Number.parseInt(style.zIndex, 10)
    const zSet =
      !Number.isNaN(z) &&
      (position !== 'static' || (!!parent && /flex|grid/.test(getComputedStyle(parent).display)))
    const context =
      zSet ||
      position === 'fixed' ||
      position === 'sticky' ||
      Number.parseFloat(style.opacity) < 1 ||
      set(style.transform) ||
      set(style.translate) ||
      set(style.rotate) ||
      set(style.scale) ||
      (node !== element && set(style.filter)) ||
      set(style.backdropFilter) ||
      set(style.perspective) ||
      set(style.clipPath) ||
      set(style.maskImage) ||
      style.isolation === 'isolate' ||
      set(style.mixBlendMode, 'normal') ||
      CONTAINS.test(style.contain || '') ||
      WILL_CHANGE.test(style.willChange || '')
    if (context) contexts.push({ element: node, z: zSet ? z : 0 })
    // Below the innermost context, a positioned ancestor lifts the element with it.
    else if (!contexts.length && position !== 'static') positioned = true
  }
  contexts.reverse()
  return { contexts, level: positioned ? 0 : FLOW }
}

/** A computed value other than its initial one; engines without the property give ''. */
const set = (value: string | undefined, initial = 'none'): boolean => !!value && value !== initial

/**
 * Negative when `a` paints under `b`, positive above, 0 when the stacking does not tell them apart
 * and document order decides. Neither element may contain the other.
 */
export function compareStacking(a: Stacking, b: Stacking): number {
  const depth = Math.max(a.contexts.length, b.contexts.length)
  for (let i = 0; i < depth; i++) {
    const ca = a.contexts[i]
    const cb = b.contexts[i]
    if (ca && cb && ca.element === cb.element) continue
    return (ca ? ca.z : a.level) - (cb ? cb.z : b.level)
  }
  return a.level - b.level
}

/** Whether the stacking changed, so the paint order sorts again. */
export function sameStacking(a: Stacking, b: Stacking): boolean {
  return (
    a.level === b.level &&
    a.contexts.length === b.contexts.length &&
    a.contexts.every((c, i) => c.element === b.contexts[i]?.element && c.z === b.contexts[i]?.z)
  )
}
