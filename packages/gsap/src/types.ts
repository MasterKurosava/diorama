import type { FrameDriver, Off } from '@diorama/core'

// Structural types only. The site passes its own gsap, whatever copy or version it is.

export type GsapTickerCallback = (time: number, deltaTime: number, frame: number) => void

export interface GsapTickerLike {
  add(callback: GsapTickerCallback, once?: boolean, prioritize?: boolean): unknown
  remove(callback: GsapTickerCallback): void
}

export interface GsapLike {
  readonly ticker: GsapTickerLike
  /** Read for `core.globals()` to find ScrollTrigger. gsap's own typings don't declare it. */
  readonly core?: object
}

export interface ScrollTriggerLike {
  readonly progress: number
  readonly enabled?: boolean
  readonly pin?: Element | null
  readonly trigger?: Element | null
  readonly animation?: { progress(): number } | null
  readonly vars?: { readonly scrub?: unknown }
}

export interface ScrollTriggerStatic {
  getAll(): readonly ScrollTriggerLike[]
  update(): void
  refresh(): void
  create(vars: object): ScrollTriggerLike
  addEventListener(type: 'refresh', listener: () => void): void
  removeEventListener(type: 'refresh', listener: () => void): void
}

export interface GsapPluginOptions {
  readonly gsap: GsapLike
  /**
   * Pass it explicitly, since a minified build renames the class. By default it is looked up
   * in `gsap.core.globals()` by shape (getAll, update, refresh, create, addEventListener).
   */
  readonly scrollTrigger: ScrollTriggerStatic | undefined
  /**
   * Frames from gsap.ticker. 'auto' (default) uses it unless the app runs on a deterministic
   * driver with `step` or `tick` (offlineDriver, manualDriver), which is kept.
   */
  readonly ticker: 'auto' | boolean
  /** Read window scroll in the frame, not from events (ScrollToPlugin, snap). Default true. */
  readonly liveScroll: boolean
  /** Effects inside a pinned ScrollTrigger get its progress as `pin`. Default true. */
  readonly pins: boolean
}

export type PinProgress = 'auto' | 'scroll' | 'animation'

export interface PinOptions {
  /** Defaults to effect elements inside the trigger's `pin` (or `trigger`) element at call time. */
  readonly target?: string | Element | Iterable<Element>
  /** 'auto' (default) uses the scrubbed animation's progress when `vars.scrub` is set, else `st.progress`. */
  readonly progress?: PinProgress
}

export interface GsapApi {
  /** The installed gsapDriver. Undefined when `ticker` is off or a deterministic driver was kept. */
  readonly driver: FrameDriver | undefined
  /** The resolved ScrollTrigger, or undefined while it is not registered. */
  readonly scrollTrigger: ScrollTriggerStatic | undefined
  /** Feeds a ScrollTrigger into the effects `pin` input of the targets. Wins over automatic pins. */
  pin(trigger: ScrollTriggerLike, options?: PinOptions): Off
  /** Re-binds automatic pins now, after DOM moves the plugin cannot see. */
  refresh(): void
}
