import type { Off } from '@dioramajs/core'

/** The part of Lenis 1.3 the adapter uses. */
export interface LenisLike {
  /** Lenis options the adapter reads. */
  readonly options: {
    // Written by the pump on takeover and restored on release.
    autoRaf?: boolean
    readonly wrapper?: Window | Element
    readonly infinite?: boolean
  }
  /** Lenis time, ms. The pump writes it to keep Lenis on the driver's clock. */
  time: number
  /** Smoothed scroll position, px. */
  readonly animatedScroll: number
  /** Native scroll position, px. */
  readonly actualScroll: number
  /** Maximum scroll, px. */
  readonly limit: number
  /** Whether Lenis scrolls horizontally. */
  readonly isHorizontal: boolean
  /** Whether and how Lenis is scrolling. */
  readonly isScrolling: boolean | 'native' | 'smooth'
  // The pump wraps these. `raf` is a class field in 1.3, the others are prototype methods.
  /** Advances Lenis to `time`, ms. */
  raf: (time: number) => void
  /** Scrolls to a target. */
  scrollTo: (...args: never[]) => void
  /** Removes Lenis from the page. */
  destroy: () => void
  /** Listens to a Lenis event. Returns the unsubscribe function. */
  on(event: 'scroll' | 'virtual-scroll', callback: () => void): () => void
}

/** Options of `lenisPlugin`. */
export interface LenisPluginOptions {
  /** The site's Lenis. One created later (ReactLenis, a page transition) comes in through `use()`. */
  readonly lenis?: LenisLike | undefined
  /**
   * With true (default) only the pump advances Lenis. The site's own `raf` calls (own loop,
   * gsap.ticker, autoRaf) are absorbed and only wake the pump. With false Diorama never calls
   * `raf`, the site drives Lenis and GL may lag a frame ('external').
   */
  readonly takeover: boolean
  /** Keep driving Lenis after the last app using it goes away (StrictMode, HMR). Default true. */
  readonly handoff: boolean
}

/** The `lenis` service. */
export interface LenisApi {
  /** The Lenis in use. Undefined before `use()` and after `lenis.destroy()`. */
  readonly lenis: LenisLike | undefined
  /** 'diorama' when the pump advances Lenis, 'external' with `takeover: false`. */
  readonly mode: 'diorama' | 'external'
  /** Switches to `lenis`. Off or `lenis.destroy()` releases it. */
  use(lenis: LenisLike): Off
}
