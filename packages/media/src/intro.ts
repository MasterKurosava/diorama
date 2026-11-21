// Intro rules of the media effects: the site entry's index needs them before the map loads.

/** A pixelate reveal on the first screen plays behind a veil; hover and scroll start sharp. */
export const pixelate = (element: Element): boolean =>
  (element.getAttribute('data-dio-pixelate-trigger') ??
    element.getAttribute('data-dio-trigger') ??
    'view') === 'view' && !matchMedia('(prefers-reduced-motion: reduce)').matches

/** A curtain on the first screen opens behind a veil, so the bare picture never flashes first. */
export const curtain = (): boolean => !matchMedia('(prefers-reduced-motion: reduce)').matches
