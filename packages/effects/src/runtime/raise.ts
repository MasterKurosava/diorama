// Lifts the render canvas above the page while something must draw over it (a flight from an
// element, `ctx.raise()`), using the browser's top layer.
import type { Off } from '@dioramajs/core'

/** Inline styles that beat the UA styles of `[popover]`; size and inset stay the stage's. */
const POPOVER = { margin: '0', border: '0', padding: '0', background: 'none', overflow: 'visible' }
/** The highest `z-index`, where the Popover API is missing. */
const TOP_Z_INDEX = '2147483647'

/** A raised canvas and the raises holding it. */
interface Raised {
  count: number
  /** The inline values the raise overwrote, put back when it ends. */
  readonly saved: Record<string, string>
  readonly popover: boolean
  /** Where the canvas was when shown. Leaving the document hides a popover. */
  parent: ParentNode | null
}
const raised = new WeakMap<HTMLElement, Raised>()

/**
 * Lifts `canvas` into the browser's top layer as a manual popover, counted: the first call shows
 * it, the last `Off` hides it and restores its styles. Without the Popover API it takes the
 * highest `z-index` instead. A modal dialog shown later still lies above it.
 */
export function raise(canvas: HTMLElement): Off {
  let held = raised.get(canvas)
  if (held) held.count++
  else {
    const popover = typeof canvas.showPopover === 'function'
    const style = canvas.style as unknown as Record<string, string>
    const applied: Record<string, string> = popover ? POPOVER : { zIndex: TOP_Z_INDEX }
    const saved = Object.fromEntries(Object.keys(applied).map((key) => [key, style[key] ?? '']))
    Object.assign(style, applied)
    if (popover) {
      canvas.setAttribute('popover', 'manual')
      canvas.showPopover()
    }
    held = { count: 1, saved, popover, parent: canvas.parentNode }
    raised.set(canvas, held)
  }
  const entry = held
  let done = false
  return () => {
    if (done) return
    done = true
    if (--entry.count > 0) return
    raised.delete(canvas)
    if (entry.popover) {
      try {
        canvas.hidePopover()
      } catch {
        // Detached meanwhile: it left the top layer with the DOM.
      }
      canvas.removeAttribute('popover')
    }
    Object.assign(canvas.style, entry.saved)
  }
}

/** Shows a raised canvas again once it is back in the document, e.g. moved into a new <body>. */
export function keep(canvas: HTMLElement): void {
  const held = raised.get(canvas)
  if (!held?.popover || !canvas.isConnected || canvas.parentNode === held.parent) return
  held.parent = canvas.parentNode
  try {
    canvas.showPopover()
  } catch {
    // Still shown.
  }
}
