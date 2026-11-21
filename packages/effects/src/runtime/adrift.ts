// Bursts that outlive their element's box. An effect that still asks for frames itself (its
// update returned true, or its `animate` function says so) keeps drawing its overlay after the
// element is hidden (adrift) or removed (an orphan).
import type { Box } from '../types'
import type { Inst, Phase } from './instance'
import type { LayerImpl } from './layer'

/** Longest life of a burst without its element's box, in ms. */
export const ADRIFT_MAX = 15_000
/** Fade of orphans when the page leaves, in ms. */
export const ADRIFT_FADE = 300

/** A burst flying on without its element's box: hidden, or an orphan. */
export interface Adrift {
  /** The element's last box. */
  readonly box: Box
  /** Driver ms the box was lost: the first frame of a hidden element, the removal of an orphan. */
  since: number
  /** Driver ms the page-leave fade began: NaN from the next frame, Infinity when the page stays. */
  leave: number
}

/** Window after a page change in which a removed element belongs to it, in ms. */
export const TURN = 1000

/**
 * The phase draws in the overlay and says itself when it stops: its update answers with a
 * boolean, or its `animate` is a function.
 */
export const bursts = (phase: Phase | undefined): boolean =>
  !!phase?.overlay?.children.length &&
  phase.def.burst !== false &&
  (phase.answers || typeof phase.def.animate === 'function')

/**
 * A burst under way: the last update asked for the next frame, or the `animate` function asks
 * now. Only the function answers between frames, for a click that starts a burst and removes
 * its element in the same task.
 */
export function flies(inst: Inst): boolean {
  const phase = inst.current
  if (phase?.state !== 'active' || inst.parked || !bursts(phase)) return false
  if (phase.more) return true
  const animate = phase.def.animate
  if (typeof animate !== 'function') return false
  try {
    return animate(phase.ctx as never) === true
  } catch {
    return false
  }
}

/** Some instance of the layer has a burst under way. */
export const flying = (layer: LayerImpl): boolean => layer.insts.some(flies)
