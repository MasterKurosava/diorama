import type { ScrollSource } from '@diorama/core'
import type { LenisLike } from './types'

/** Scroll source that reads the page after Lenis wrote it. */
export function lenisSource(lenis: LenisLike): ScrollSource {
  const wrapper = lenis.options.wrapper
  const element = wrapper && wrapper !== window ? (wrapper as Element) : undefined
  const cross = (): number =>
    element
      ? lenis.isHorizontal
        ? element.scrollTop
        : element.scrollLeft
      : lenis.isHorizontal
        ? window.scrollY
        : window.scrollX
  return {
    name: 'lenis',
    axis: lenis.isHorizontal ? 'x' : 'y',
    read(out) {
      // Use the applied offset, not the fractional animatedScroll. The DOM is drawn at the rounded one.
      const main = lenis.actualScroll
      out.x = lenis.isHorizontal ? main : cross()
      out.y = lenis.isHorizontal ? cross() : main
      // Infinite mode wraps the page offset, but velocity needs the unwrapped position.
      out.travel = lenis.options.infinite ? lenis.animatedScroll : main
    },
    limit: () => lenis.limit,
  }
}
