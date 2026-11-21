import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { between, damp, ease } from '@dioramajs/effects/kit'

type Params = {
  into: string
  by: ChoiceParam<'pin' | 'progress' | 'manual'>
  position: number
  start: number
  end: number
  out: number
  zoom: number
  radius: number
  ease: number
}

const unit = (value: number): number => Math.min(1, Math.max(0, value))

/** The closest sticky ancestor: the stage the card sits on. */
function stageOf(el: Element): Element | undefined {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).position === 'sticky') return node
  }
  return undefined
}

/**
 * The image of a card grows to the box of its sticky stage, usually the whole screen, while the
 * section scrolls, and settles there; scrolling back folds it into the card. The copy poses its
 * own layer: framed by object-fit at every size, above the copies around it, out of the card's
 * clip.
 */
const expand: Effect<Params> = defineEffect({
  name: 'expand',
  params: {
    into: '',
    by: oneOf('pin', 'progress', 'manual'),
    position: 0,
    start: 0,
    end: 0.5,
    out: 1,
    zoom: 1.1,
    radius: 0,
    ease: 0,
  },
  media: true,
  reducedMotion: 'off',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { params, app, element, render } = ctx
    const selector = params.into.trim()
    const into = selector ? element.parentElement?.closest(selector) : stageOf(element)
    if (selector && !into) {
      app.log.warn(`expand: no ancestor matches "${selector}", the image grows to the viewport`)
    }
    const box = into ? app.anchors.track(into, { live: true }) : undefined
    if (box) ctx.onDispose(() => box.dispose())
    // The content swells on the way and lands at 1 at both ends. As the copy's framing a flight
    // starts from it.
    const { surface } = ctx
    surface.zoom(1)

    const by = params.by
    // Grows from `start` to `end` of the scroll and folds back from `out` to the end of it.
    const scrolled = (input: EffectInput): number => {
      if (by === 'manual') return 0
      const progress = by === 'pin' ? ctx.section().pin : input.progress
      const folding = params.out < 1 ? between(progress, params.out, 1) : 0
      return Math.min(between(progress, params.start, params.end), 1 - folding)
    }
    const centre = { x: 0, y: 0 }
    // 0 the card, 1 the stage's box; -1 before the first frame, which jumps to its goal.
    let expanded = -1
    return (input): boolean => {
      const goal = Math.max(unit(params.position), ease('cubicInOut', scrolled(input)))
      expanded = expanded < 0 ? goal : damp(expanded, goal, params.ease, input.delta, 1e-4)
      const easing = expanded !== goal
      // Below 1 the content would leave its box: 0, like 1, means no swell.
      surface.zoom(1 + (Math.max(params.zoom, 1) - 1) * Math.sin(Math.PI * expanded))
      // Immediate mode: without a pose the copy is the card, as the DOM shows it.
      if (expanded <= 0) return easing
      const target = box ?? {
        x: 0,
        y: 0,
        width: app.stage.width.peek(),
        height: app.stage.height.peek(),
      }
      const { width, height } = target
      const { x, y } = render.toWorld(target.x + width / 2, target.y + height / 2, centre)
      const pose = { x, y, width, height, radius: params.radius, clip: false, above: 1 }
      ctx.pose(ctx.layer, pose, expanded)
      return easing
    }
  },
})
export default expand
