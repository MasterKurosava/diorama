import { type FrameDriver, tickerDriver } from '@dioramajs/core'
import type { GsapLike, GsapTickerCallback } from './types'

const drivers = new WeakMap<GsapLike, FrameDriver>()

/** Frames from gsap.ticker, after the tweens of the same tick. One driver per gsap object. */
export function gsapDriver(gsap: GsapLike): FrameDriver {
  const cached = drivers.get(gsap)
  if (cached) return cached
  let tick: (() => void) | undefined
  let adding = false
  let woke = false
  let last = -1
  // One stable callback for add/remove. It skips the synchronous tick a sleeping ticker runs
  // inside add(), and a second dispatch within one gsap frame (re-added after a later listener
  // invalidated).
  const listener: GsapTickerCallback = (_time, _delta, frame) => {
    if (adding) woke = true
    if (adding || frame === last) return
    last = frame
    tick?.()
  }
  const driver = tickerDriver(
    (onTick) => {
      // Take the stamp from `now`. gsap time is in seconds and bent by lagSmoothing.
      tick = () => onTick()
      adding = true
      woke = false
      try {
        gsap.ticker.add(listener)
      } finally {
        adding = false
      }
      // The skipped wake tick set gsap's next frame a gap ahead, so the rAF right after it may
      // not dispatch. Tick from our own rAF unless gsap dispatched to us first.
      if (woke && typeof requestAnimationFrame === 'function') {
        const seen = last
        requestAnimationFrame(() => {
          if (last === seen) tick?.()
        })
      }
      return () => gsap.ticker.remove(listener)
    },
    { name: 'gsap', now: () => performance.now() },
  )
  drivers.set(gsap, driver)
  return driver
}
