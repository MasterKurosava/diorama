import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { ease, entering, inView } from '@dioramajs/effects/kit'
import {
  ceil,
  clamp,
  dFdx,
  dFdy,
  dot,
  exp2,
  floor,
  length,
  log2,
  max,
  mix,
  select,
  smoothstep,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import { type Node, Vector2 } from 'three/webgpu'

type F = Node<'float'>
type V2 = Node<'vec2'>
type Params = {
  style: ChoiceParam<'square' | 'round' | 'hex'>
  trigger: ChoiceParam<'view' | 'hover' | 'scroll'>
  motion: ChoiceParam<'steps' | 'smooth'>
  cell: number
  duration: number
  delay: number
}

/** Share of the image height in view, above the bottom tenth of the viewport, before it plays. */
const THRESHOLD = 0.2
/** Reduced motion on hover: the blocks fade in this long instead of growing, s. */
const CALM = 0.15

/** `x mod y` with floor, the same for negative x on every backend. */
const wrap = (x: V2, y: V2): V2 => x.sub(y.mul(floor(x.div(y)))) as unknown as V2

/**
 * The image resolves from big pixels to sharp as it scrolls into view, or breaks into pixels on
 * hover. Square, round or hexagonal blocks, halving in steps or shrinking smoothly.
 */
const pixelate: Effect<Params> = defineEffect({
  name: 'pixelate',
  params: {
    style: oneOf('square', 'round', 'hex'),
    trigger: oneOf('view', 'hover', 'scroll'),
    motion: oneOf('steps', 'smooth'),
    cell: 32,
    duration: 1.2,
    delay: 0,
  },
  media: true,
  presence: 'custom',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { surface, u, params, element, app, signal } = ctx
    const { stage } = app
    const style = params.style
    const steps = params.motion === 'steps'
    const trigger = params.trigger
    // Four reads per block average its colour; on the low tier the block takes its centre.
    const taps = ctx.quality === 'low' ? 1 : 4
    // (pixelation 0 sharp .. 1 blocks of `cell` px, share of the blocks shown), from the CPU.
    const look = uniform(new Vector2(0, 1))

    surface.color((color, { box, sample }) => {
      // Leaving a page breaks the image into blocks again, entering resolves it.
      const entered = smoothstep(0, 1, u.presence)
      const pixelation = clamp(max(look.x, entered.oneMinus()), 0, 1)
      // The block side is 2^(level * maxLevel) px.
      const maxLevel = log2(max(u.cell, 1))
      // steps: the block side halves at a time, 32, 16, 8, 4, 2, then the image.
      const levels = max(ceil(maxLevel), 1)
      const level = steps ? ceil(pixelation.mul(levels)).div(levels) : pixelation
      const side = exp2(level.mul(maxLevel)) as unknown as F
      const size = u.size as unknown as V2
      // CSS px from the box centre, y up, and the same in blocks.
      const point = box.sub(0.5).mul(size)
      const inBlocks = point.div(side)
      let center: V2
      if (style === 'hex') {
        // Nearest centre of a triangular lattice: hexagons one block across. Of the two
        // rectangular lattices that make it up, the nearer centre wins.
        const period = vec2(1, Math.sqrt(3))
        const half = period.mul(0.5)
        const toFirst = wrap(inBlocks, period).sub(half)
        const toSecond = wrap(inBlocks.sub(half), period).sub(half)
        const nearer = select(
          dot(toFirst, toFirst).lessThan(dot(toSecond, toSecond)),
          toFirst,
          toSecond,
        )
        center = inBlocks.sub(nearer) as unknown as V2
      } else center = floor(inBlocks).add(0.5) as unknown as V2
      const at = (offset: V2 | null): Node<'vec4'> =>
        sample((offset ? center.add(offset) : center).mul(side).div(max(size, 1)).add(0.5) as V2)
      const block =
        taps === 1
          ? at(null)
          : at(vec2(-0.25, -0.25) as unknown as V2)
              .add(at(vec2(0.25, -0.25) as unknown as V2))
              .add(at(vec2(-0.25, 0.25) as unknown as V2))
              .add(at(vec2(0.25, 0.25) as unknown as V2))
              .mul(0.25)
      let alpha: F = block.a as unknown as F
      if (style === 'round') {
        // A dot per block on the page behind, its rim one device pixel wide.
        const aa = max(length(dFdx(point)), length(dFdy(point)), 1e-4).div(side)
        const fromCenter = length(inBlocks.sub(center))
        alpha = alpha.mul(
          clamp(fromCenter.oneMinus().sub(0.5).div(aa).add(0.5), 0, 1),
        ) as unknown as F
      }
      // Below two px a block is about a pixel: the image itself takes over.
      const blocky = smoothstep(1, 2, side).mul(look.y)
      const out = mix(color, vec4(block.rgb, alpha), blocky)
      return vec4(out.rgb, out.a.mul(smoothstep(0, 0.4, u.presence)))
    })

    const onScreen = (): boolean => {
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < stage.height.peek() &&
        rect.left < stage.width.peek()
      )
    }
    // An image seen as DOM stays sharp instead of breaking up to play an intro; until the instance
    // runs that includes one scrolled into view while the engine compiles. A veiled image (the
    // entry's `intro`) has not been seen, so the first screen plays too.
    const veiled = element.getAttribute('data-dio-state') === 'entering'
    let seen = trigger !== 'hover' && onScreen() && !veiled
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen && trigger !== 'hover') addEventListener('scroll', watch, { passive: true, signal })
    const lookValue = look.value as Vector2
    lookValue.set(trigger === 'view' && !seen ? 1 : 0, 1)

    // hover: the pointer over the image (mouse or pen: on touch it stays sharp). It may be there
    // already when the instance starts, with no pointerenter to come.
    let over = trigger === 'hover' && element.matches(':hover')
    let progress = 0
    if (trigger === 'hover') {
      const listen = (type: 'pointerenter' | 'pointerleave', on: boolean): void =>
        element.addEventListener(
          type,
          (e) => {
            if ((e as PointerEvent).pointerType === 'touch') return
            over = on
            ctx.invalidate()
          },
          { signal },
        )
      listen('pointerenter', true)
      listen('pointerleave', false)
    }
    let elapsed = -1
    let dom = false
    let moving = false
    const curve = (t: number): number =>
      steps ? Math.min(1, Math.max(0, t)) : ease('cubicInOut', t)

    // `trigger: 'hover'`: blocks grow while the pointer is over the image.
    const hover = (input: EffectInput): void => {
      const reduced = input.reducedMotion
      const goal = over ? 1 : 0
      if (progress !== goal) {
        const span = Math.max(reduced ? CALM : params.duration, 1e-3)
        const step = input.delta / span
        progress = goal ? Math.min(1, progress + step) : Math.max(0, progress - step)
      }
      // Reduced motion: blocks of the full size fade in, they do not grow.
      if (reduced) lookValue.set(1, progress)
      else lookValue.set(curve(progress), 1)
      moving = progress !== goal
    }
    // `trigger: 'scroll'`, scrubbed from THRESHOLD of the box in view to the box centred in the
    // viewport.
    const scrub = (input: EffectInput): void => {
      const viewportHeight = stage.height.peek()
      const progress = entering(input.progress, input.height, viewportHeight, THRESHOLD)
      // The first screen stays sharp until scrolling would have resolved it anyway.
      if (seen && progress < 1) return
      seen = false
      lookValue.x = 1 - progress
    }
    // `trigger: 'view'`, played once THRESHOLD of the box is in view. `elapsed` is -1 until then.
    const play = (input: EffectInput): void => {
      if (seen || lookValue.x === 0) return
      if (elapsed < 0) {
        // Counted above the bottom tenth of the viewport: an image peeking in at the edge has
        // not been looked at yet.
        if (!inView(input.y, input.height, stage.height.peek(), THRESHOLD)) return
        elapsed = 0
        moving = true
      } else elapsed += input.delta
      const progress = (elapsed - params.delay) / Math.max(params.duration, 1e-3)
      lookValue.x = 1 - curve(progress)
      if (progress >= 1) {
        lookValue.x = 0
        moving = false
      }
    }

    return (input): boolean => {
      if (trigger === 'hover') {
        hover(input)
        return moving
      }
      const reduced = input.reducedMotion
      // Reduced motion: no reveal, the image is handed to the DOM as it is.
      if (reduced !== dom) {
        dom = reduced
        ctx.showDom(reduced)
      }
      if (reduced) {
        lookValue.x = 0
        moving = false
        return false
      }
      if (trigger === 'scroll') scrub(input)
      else play(input)
      return moving
    }
  },
})
export default pixelate
