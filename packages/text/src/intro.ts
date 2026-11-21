// Intro rules of the text effects: the site entry's index needs them before the map loads.

/**
 * Hidden until drawn when in view at mount, so a heading on the first screen plays too. A
 * scrubbed one has nothing to play before a scroll.
 */
export const textReveal = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') !== 'scroll'

/** Like text-reveal; a hovered label starts as DOM text. */
export const scramble = (element: Element): boolean => {
  const mode = element.getAttribute('data-dio-trigger')
  return mode !== 'scroll' && mode !== 'hover'
}

/** A board that flips in on view; one that flips only on changes shows its text at once. */
export const splitFlap = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') !== 'change'

export const assemble = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') !== 'scroll'

export const counter = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') !== 'scroll'

export const inflate = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') !== 'hover'

export const ribbon = (element: Element): boolean => element.hasAttribute('data-dio-color')

export const voxel = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') !== 'scroll' &&
  (element.getAttribute('data-dio-style') === 'pixels' ||
    typeof matchMedia !== 'function' ||
    !matchMedia('(prefers-reduced-motion: reduce)').matches)

export const shatter = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') === 'view' &&
  (typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches)

export const unfold = (element: Element): boolean => {
  const mode = element.getAttribute('data-dio-trigger')
  return mode !== 'scroll' && mode !== 'hover'
}

export const smoke = (element: Element): boolean =>
  (element.getAttribute('data-dio-trigger') ?? 'view') === 'view'

export const blinds = (element: Element): boolean =>
  element.getAttribute('data-dio-trigger') !== 'scroll'

export const physics = (element: Element): boolean =>
  element.getAttribute('data-dio-style') === 'stack' &&
  !['click', 'hover'].includes(element.getAttribute('data-dio-trigger') ?? 'view') &&
  (typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches)
