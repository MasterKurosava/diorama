import type { Off } from '@diorama/core'

/** The part of Lenis 1.3 the adapter uses. */
export interface LenisLike {
  readonly options: {
    // Written by the pump on takeover and restored on release.
    autoRaf?: boolean
    readonly wrapper?: Window | Element
    readonly infinite?: boolean
  }
  // Written by the pump, which keeps Lenis time in the driver's clock.
  time: number
  readonly animatedScroll: number
  readonly actualScroll: number
  readonly limit: number
  readonly isHorizontal: boolean
  readonly isScrolling: boolean | 'native' | 'smooth'
  // The pump wraps these. `raf` is a class field in 1.3, the others are prototype methods.
  raf: (time: number) => void
  scrollTo: (...args: never[]) => void
  destroy: () => void
  on(event: 'scroll' | 'virtual-scroll', callback: () => void): () => void
}

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

export interface LenisApi {
  /** The Lenis in use. Undefined before `use()` and after `lenis.destroy()`. */
  readonly lenis: LenisLike | undefined
  /** 'diorama' when the pump advances Lenis, 'external' with `takeover: false`. */
  readonly mode: 'diorama' | 'external'
  /** Switches to `lenis`. Off or `lenis.destroy()` releases it. */
  use(lenis: LenisLike): Off
}
