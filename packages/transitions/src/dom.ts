// Document queries a transition needs: keyed and named elements, effect elements, and whether a
// browser view transition is running.
import type { EffectsApi } from '@dioramajs/effects'

/** Seconds of the browser's default root crossfade in a view transition. */
export const NATIVE = 0.25

/** Elements a view-transition-name may key. Matched in document order like any selector list. */
export const NAMEABLE = '[data-dio-key],[data-dio],img,video'

/** Computed view-transition-name values that name nothing. */
const NOT_NAMES = new Set(['', 'none', 'auto', 'match-element'])

/** `compareDocumentPosition` bit for a node that comes before the reference node. */
const PRECEDING = 2

/** Selector for the elements with `data-dio-key` set to `key`. */
export const keySelector = (key: string): string => `[data-dio-key="${CSS.escape(key)}"]`

/** The node itself if it matches, plus matching descendants. */
export const within = (node: Element, selector: string): Element[] => [
  ...(node.matches(selector) ? [node] : []),
  ...node.querySelectorAll(selector),
]

/** The element's view-transition-name, if it has a real one. */
export const viewTransitionName = (element: Element): string | undefined => {
  const name = getComputedStyle(element).getPropertyValue('view-transition-name').trim()
  return NOT_NAMES.has(name) ? undefined : name
}

/** Inside a browser view transition. Browsers that don't know the selector throw on it. */
export const nativeActive = (): boolean => {
  try {
    return document.documentElement.matches(':active-view-transition')
  } catch {
    return false
  }
}

export const isViewTransition = (value: unknown): value is ViewTransition =>
  typeof ViewTransition === 'function' && value instanceof ViewTransition

/** Elements with effects: marked up, or attached from code. */
export const effectElements = (effects: EffectsApi): Element[] => [
  ...document.querySelectorAll('[data-dio]'),
  ...effects.instances().map((instance) => instance.element),
]

/** Sort comparator for document order. */
export const inDocumentOrder = (a: Element, b: Element): number =>
  a.compareDocumentPosition(b) & PRECEDING ? 1 : -1
