import type { ReadonlySignal } from '@dioramajs/core'
import type { Effect } from '@dioramajs/effects'

/** The ready-made covers. */
export type CoverName = 'curtain' | 'pixel' | 'ink'

/** Where the cover is: the page shows, it closes, it hides the page, or it opens. */
export type CoverState = 'idle' | 'closing' | 'covered' | 'opening'

/** Where a cover starts: a click, an element (its centre), or a viewport point in CSS px. */
export type CoverOrigin = MouseEvent | Element | { readonly x: number; readonly y: number }

/** Timing and behaviour shared by every cover. */
export interface CoverTiming {
  /** Seconds the cover takes to close, and again to open. Default 0.6. */
  readonly duration: number
  /** Easing of each half, from 0..1 to 0..1. Default cubic in-out. */
  readonly ease: (t: number) => number
  /**
   * Seconds the closed cover waits, at most, for the new page's first screen (its pictures and
   * models) before it opens. Default 0.5.
   */
  readonly wait: number
  /** Seconds a closed cover waits for the page to change before it opens anyway. Default 10. */
  readonly timeout: number
  /**
   * Hold link clicks while the cover closes, then pass them on to the router. Routers that wait
   * by themselves (Astro ClientRouter) are not held. Default true.
   */
  readonly links: boolean
  /** Pages that change without a link click (Back, Forward, a router call) open through the cover. Default true. */
  readonly arrive: boolean
}

/** `curtain`: a panel sweeps over the old page and on, off the new one. */
export interface CurtainCover {
  readonly name: 'curtain'
  /** One 'panel' (default) or 'strips' that follow one another. */
  readonly style?: 'panel' | 'strips'
  /** Where the curtain travels. Default 'up': in from the bottom, out at the top. */
  readonly direction?: 'up' | 'down' | 'left' | 'right'
  /** Strips of the 'strips' style. Default 5. */
  readonly count?: number
  /** CSS colour of the curtain. Default '#0e0e10'. */
  readonly color?: string
  /** CSS colour of a second panel that leads the curtain in and trails it out. Default none. */
  readonly accent?: string
  /** URL of a picture on the curtain, cropped to fill it (a pattern, a title card). Needs `assets`. */
  readonly image?: string
  /** 0..1, how far the leading edge bows while it moves. Default 0.4. */
  readonly curve?: number
  /** 0..1, the soft shadow the moving edge casts on the page. Default 0.4. */
  readonly shade?: number
}

/** `pixel`: the old page breaks into growing blocks and the new one resolves from them. */
export interface PixelCover {
  readonly name: 'pixel'
  /** Block size in CSS px. Default 48. */
  readonly cell?: number
  /** Which blocks go first: 'random' (default), 'diagonal', or 'origin' (out from the click). */
  readonly order?: 'random' | 'diagonal' | 'origin'
  /** CSS colour of the blocks. Default '#0e0e10'. */
  readonly color?: string
  /** Up to three more CSS colours, space separated: each block takes one of them or `color`. */
  readonly palette?: string
  /** 0..1, the share of each half over which the blocks start. Default 0.6. */
  readonly spread?: number
  /** Random seed of the order and the colours. Default 1. */
  readonly seed?: number
}

/** `ink`: a blot spreads from the clicked link over the page, then recedes off the new one. */
export interface InkCover {
  readonly name: 'ink'
  /** How the new page shows: the blot 'recede's into where it came from (default) or a 'hole' opens there. */
  readonly motion?: 'recede' | 'hole'
  /** CSS colour of the ink. Default '#0e0e10'. */
  readonly color?: string
  /** 0..1, how uneven the edge is, with drops ahead of it. Default 0.5. */
  readonly wobble?: number
  /** 0..1, a darker rim along the edge. Default 0.3. */
  readonly shade?: number
  /** Random seed of the edge and the drops. Default 1. */
  readonly seed?: number
}

/**
 * Your own cover: an effect with a `position` param (0 page shown, 1 covered, 2 shown again), and
 * optionally `x` and `y`, the origin in viewport fractions. It runs on `<html>`.
 */
export interface CustomCover {
  readonly name: Effect
  /** Params for the effect. */
  readonly params?: Readonly<Record<string, unknown>>
}

/** A cover and its timing, e.g. `{ name: 'ink', color: '#e4002b', duration: 0.7 }`. */
export type CoverOptions = (CurtainCover | PixelCover | InkCover | CustomCover) &
  Partial<CoverTiming>

/** The `cover` service. */
export interface CoverApi {
  /** Where the cover is. */
  readonly state: ReadonlySignal<CoverState>
  /**
   * Closes the cover over the page from `at`, or the viewport centre. Resolves true once the
   * page is covered, false at once when the cover can't play (reduced motion, no 3D, the engine
   * not ready in time). Opens again by itself when the page changes, or after `timeout`.
   */
  close(at?: CoverOrigin): Promise<boolean>
  /** Opens the cover now, without waiting for a page change. */
  open(): void
  /** Loads the engine and the cover now. Resolves false when the cover can't play. */
  load(): Promise<boolean>
}

declare module '@dioramajs/core' {
  interface Services {
    /** Page covers, see `CoverApi`. */
    cover: CoverApi
  }
}
