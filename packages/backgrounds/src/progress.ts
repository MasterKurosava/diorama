// Scroll progress of an element before its first update, so a background that moves with scroll
// draws its first frame where the page already is.
import type { EffectContext } from '@dioramajs/effects'

/** 0 while the element is below the viewport, 1 once it has left above, linear in between. */
export function startProgress(ctx: Pick<EffectContext, 'element' | 'app'>): number {
  const rect = ctx.element.getBoundingClientRect()
  const viewport = ctx.app.stage.height.peek()
  return Math.min(1, Math.max(0, (viewport - rect.top) / (viewport + rect.height || 1)))
}
