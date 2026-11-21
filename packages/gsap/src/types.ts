import type { FrameDriver, Off } from '@dioramajs/core'

// Structural types only. The site passes its own gsap, whatever copy or version it is.

/** A `gsap.ticker` listener. */
export type GsapTickerCallback = (time: number, deltaTime: number, frame: number) => void

/** The part of `gsap.ticker` the adapter uses. */
export interface GsapTickerLike {
  /** Adds a listener. */
  add(callback: GsapTickerCallback, once?: boolean, prioritize?: boolean): unknown
  /** Removes a listener. */
  remove(callback: GsapTickerCallback): void
}

/** The part of `gsap` the adapter uses. */
export interface GsapLike {
  /** The ticker frames come from. */
  readonly ticker: GsapTickerLike
  /** Read for `core.globals()` to find ScrollTrigger. gsap's own typings don't declare it. */
  readonly core?: object
}

/** The part of a ScrollTrigger instance the adapter reads. */
export interface ScrollTriggerLike {
  /** Scroll progress of the trigger, 0..1. */
  readonly progress: number
  /** Whether the trigger is enabled. */
  readonly enabled?: boolean
  /** The pinned element, if any. */
  readonly pin?: Element | null
  /** The trigger element. */
  readonly trigger?: Element | null
  /** The animation the trigger controls. */
  readonly animation?: { progress(): number } | null
  /** The trigger's config. */
  readonly vars?: { readonly scrub?: unknown }
}

/** The part of the ScrollTrigger class the adapter uses. */
export interface ScrollTriggerStatic {
  /** Every trigger. */
  getAll(): readonly ScrollTriggerLike[]
  /** Recomputes trigger progress from the current scroll. */
  update(): void
  /** Remeasures every trigger. */
  refresh(): void
  /** Creates a trigger. */
  create(vars: object): ScrollTriggerLike
  /** Listens to `refresh`. */
  addEventListener(type: 'refresh', listener: () => void): void
  /** Stops listening to `refresh`. */
  removeEventListener(type: 'refresh', listener: () => void): void
}

/** Options of `gsapPlugin`. */
export interface GsapPluginOptions {
  /** The site's gsap. */
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

/** Which progress a pin reads: `auto`, the trigger's scroll, or its animation. */
export type PinProgress = 'auto' | 'scroll' | 'animation'

/** Options of `gsap.pin`. */
export interface PinOptions {
  /** Defaults to effect elements inside the trigger's `pin` (or `trigger`) element at call time. */
  readonly target?: string | Element | Iterable<Element>
  /** 'auto' (default) uses the scrubbed animation's progress when `vars.scrub` is set, else `st.progress`. */
  readonly progress?: PinProgress
}

/** The `gsap` service. */
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
