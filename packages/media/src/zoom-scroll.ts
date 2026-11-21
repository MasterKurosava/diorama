import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { between, damp, ease } from '@dioramajs/effects/kit'
import { uniform, vec4 } from 'three/tsl'

type Params = {
  style: ChoiceParam<'zoom' | 'mask' | 'through'>
  start: number
  end: number
  zoom: number
  radius: number
  reverse: boolean
  ease: number
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** The closest sticky ancestor: the stage the picture sits on. */
function stageOf(el: Element): Element | undefined {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).position === 'sticky') return node
  }
  return undefined
}

/** The intrinsic size of the picture, 0 while unknown. */
function natural(el: Element): { width: number; height: number } {
  if (el instanceof HTMLVideoElement) return { width: el.videoWidth, height: el.videoHeight }
  if (el instanceof HTMLImageElement) return { width: el.naturalWidth, height: el.naturalHeight }
  return { width: 0, height: 0 }
}

/**
 * The scroll-into-the-picture hero: while a pinned section scrolls, the picture grows from its box
 * to the sticky stage, usually the whole screen. zoom scales it up with its box, mask keeps the
 * picture still at its full-screen framing and opens a window onto it, through grows it, flies past
 * the screen and fades out to show what lies behind. Before the pin and under reduced motion the
 * copy is the DOM picture.
 */
const zoomScroll: Effect<Params> = defineEffect({
  name: 'zoom-scroll',
  params: {
    style: oneOf('zoom', 'mask', 'through'),
    start: 0,
    end: 0.7,
    zoom: 1.2,
    radius: 0,
    reverse: false,
    ease: 0,
  },
  media: true,
  reducedMotion: 'off',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { params, app, element, render, surface } = ctx
    const stage = stageOf(element)
    const full = stage ? app.anchors.track(stage, { live: true }) : undefined
    const own = app.anchors.track(element, { live: true })
    ctx.onDispose(() => {
      full?.dispose()
      own.dispose()
    })
    const style = params.style
    // Only through fades, so only through pays for the transform.
    const fade = uniform(1)
    if (style === 'through') surface.color((color) => vec4(color.rgb, color.a.mul(fade)))
    surface.zoom(1)

    const centre = { x: 0, y: 0 }
    const ownCentre = { x: 0, y: 0 }
    // 0 at the picture's box, 1 at the stage; -1 before the first frame, which jumps to its goal.
    let progress = -1
    return (input): boolean => {
      const run = between(ctx.section().pin, params.start, params.end)
      const goal = params.reverse ? 1 - run : run
      progress = progress < 0 ? goal : damp(progress, goal, params.ease, input.delta, 1e-4)
      const easing = progress !== goal
      // through spends the first half growing, the second flying past.
      const grow = ease('cubicInOut', style === 'through' ? between(progress, 0, 0.5) : progress)
      const past = style === 'through' ? between(progress, 0.5, 1) : 0
      // Below 1 the picture would leave its box: 0, like 1, means no extra zoom.
      const scale = Math.max(params.zoom, 1)
      fade.value = 1 - between(past, 0.2, 1) ** 2
      // Immediate mode: without a pose the copy is the picture, as the DOM shows it.
      if (grow <= 0) {
        surface.zoom(1)
        return easing
      }
      const target = full ?? {
        x: 0,
        y: 0,
        width: app.stage.width.peek(),
        height: app.stage.height.peek(),
      }
      const { width, height } = target
      const { x, y } = render.toWorld(target.x + width / 2, target.y + height / 2, centre)
      if (style === 'zoom') surface.zoom(1 + (scale - 1) * grow)
      else if (style === 'through') surface.zoom(1 + (scale * 2 - 1) * past ** 3)
      else {
        // The window between the picture's box and the stage, as the pose blends it.
        const windowWidth = Math.max(1, lerp(own.width, width, grow))
        const windowHeight = Math.max(1, lerp(own.height, height, grow))
        const from = render.toWorld(own.x + own.width / 2, own.y + own.height / 2, ownCentre)
        const windowX = lerp(from.x, x, grow)
        const windowY = lerp(from.y, y, grow)
        // Cover at the stage over cover at the window: the picture keeps its full-screen size.
        const intrinsic = natural(element)
        const ratio =
          intrinsic.width > 0 && intrinsic.height > 0
            ? Math.max(width / intrinsic.width, height / intrinsic.height) /
              Math.max(windowWidth / intrinsic.width, windowHeight / intrinsic.height)
            : Math.max(width / windowWidth, height / windowHeight)
        const still = ratio * lerp(scale, 1, grow)
        // From the DOM framing the picture settles into place early, then holds while the
        // window opens.
        const settle = 1 - (1 - between(grow, 0, 0.3)) ** 3
        surface.zoom(
          1 + (still - 1) * settle,
          ((x - windowX) / windowWidth) * settle,
          ((y - windowY) / windowHeight) * settle,
        )
      }
      const pose = { x, y, width, height, radius: params.radius, clip: false, above: 1 }
      ctx.pose(ctx.layer, pose, grow)
      return easing
    }
  },
})
export default zoomScroll
