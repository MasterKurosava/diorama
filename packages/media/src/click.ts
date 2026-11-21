// The click a drag ends with, for effects that take both clicks and drags on one element. A
// mouse drag ends with a click on the element, a touch drag ends with none, so a flag that waits
// for that click outlives a touch drag and eats a later one.

/** A mouse sends the click at once, a touch within its double-tap delay, ms. */
const SOON = 500
/** At the point where the drag let go, give or take a touch's slop, px. */
const NEAR = 24

/** Tells the click that ends a drag from a tap. */
export interface AfterDrag {
  /** The press this pointerup ends was a drag: the click it may bring is not a tap. */
  arm(up: PointerEvent): void
  /** Whether `click` is the one the armed drag ends with. True once: any click disarms. */
  ends(click: MouseEvent): boolean
}

/**
 * Only the next click on `el`, within `SOON` and `NEAR` of the pointerup that armed the guard,
 * counts as the drag's. The next press and a cancel disarm it, and clicks elsewhere on the page
 * never reach it.
 */
export function afterDrag(el: Element, signal: AbortSignal): AfterDrag {
  let up: { time: number; x: number; y: number } | undefined
  const disarm = (): void => {
    up = undefined
  }
  // Capture: an effect's handler that stops the event cannot leave the guard armed.
  for (const type of ['pointerdown', 'pointercancel'])
    el.addEventListener(type, disarm, { signal, capture: true })
  return {
    arm: (e) => {
      up = { time: e.timeStamp, x: e.clientX, y: e.clientY }
    },
    ends: (e) => {
      const last = up
      up = undefined
      return (
        !!last &&
        e.timeStamp - last.time <= SOON &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) <= NEAR
      )
    },
  }
}
