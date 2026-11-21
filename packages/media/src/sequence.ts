import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { frames } from './frames'

type Params = {
  frames: string
  atlas: string
  grid: readonly [number, number]
  count: 'auto'
  by: ChoiceParam<'pin' | 'progress' | 'manual'>
  start: number
  end: number
  frame: number
  blend: boolean
  ease: number
  cache: number
  density: number
  resolution: number
}

/**
 * An image sequence scrubbed by scroll: the frame follows the pin of the sticky section the
 * `<img>` plays in, like the product teardowns on Apple's pages. Without WebGL and under reduced
 * motion the `<img>` shows its poster.
 */
const sequence: Effect<Params> = defineEffect({
  name: 'sequence',
  params: {
    frames: '',
    atlas: '',
    grid: [1, 1],
    count: 'auto',
    by: oneOf('pin', 'progress', 'manual'),
    start: 0,
    end: 1,
    frame: 0,
    blend: false,
    ease: 0,
    cache: 6,
    density: 1,
    resolution: 1920,
  },
  rebuild: ['grid', 'count', 'density', 'resolution'],
  media: true,
  reducedMotion: 'off',
  quality: {
    low: { density: 0.5, cache: 2, resolution: 960 },
    medium: { cache: 4, resolution: 1440 },
  },
  async setup(ctx: EffectContext<Params>) {
    const { params } = ctx
    // Coarse to fine: the first frame, every 16th and 8th at normal priority, the rest low.
    const player = await frames(ctx, { passes: [16, 8, 4, 2, 1], counted: 8 })
    if (!player) return
    const last = player.n - 1
    const by = params.by
    // The frame the scroll or the `frame` param asks for, fractional.
    const wanted = (input: EffectInput): number => {
      if (by === 'manual') return Math.min(last, Math.max(0, params.frame))
      const scroll = by === 'pin' ? ctx.section().pin : input.progress
      const span = params.end - params.start
      const progress = span ? (scroll - params.start) / span : scroll < params.start ? 0 : 1
      return Math.min(last, Math.max(0, last * Math.min(1, Math.max(0, progress))))
    }
    // 1 playing forwards, -1 backwards: the player prefetches ahead in this direction.
    let direction = 1
    let index = -1
    let goal = -1
    return (input): boolean => {
      const next = wanted(input)
      if (goal >= 0 && next !== goal) direction = next > goal ? 1 : -1
      goal = next
      index = index < 0 ? goal : damp(index, goal, params.ease, input.delta, 1e-3)
      const from = params.blend ? Math.floor(index) : Math.round(index)
      const to = params.blend ? Math.min(from + 1, last) : from
      player.show(from, to, params.blend ? index - from : 0, direction)
      return index !== goal
    }
  },
})
export default sequence
