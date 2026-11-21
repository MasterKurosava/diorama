import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import {
  abs,
  ceil,
  clamp,
  floor,
  fract,
  hash,
  length,
  max,
  mix,
  smoothstep,
  step,
  uniform,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { BASE, type Base, color, type F, farthest, screen, show, tint, type V2 } from './screen'

type Params = Base & {
  cell: number
  order: ChoiceParam<'random' | 'diagonal' | 'origin'>
  color: ColorParam
  palette: string
  spread: number
  seed: number
}

/** Colours a palette adds to `color`. */
const MORE = 3
/** How much of a block's turn is its own random, in the ordered modes. */
const JITTER = 0.15
/** One colour of a palette list: a functional colour, or anything else up to a space or comma. */
const CSS_COLOR = /(?:rgba?|hsla?)\([^)]*\)|[^\s,]+/g
/** Cells are never smaller than this many CSS px. */
const MIN_CELL = 4
/** The most `spread` may be, so every block still has some time of its own. */
const MAX_SPREAD = 0.95

/**
 * The old page breaks up into blocks that grow from the centre of each cell until they meet,
 * then the blocks shrink away off the new page: at random, along the diagonal, or outward from
 * the click.
 */
const pixel: Effect<Params> = defineEffect({
  name: 'cover-pixel',
  params: {
    ...BASE,
    cell: 48,
    order: oneOf('random', 'diagonal', 'origin'),
    color: color('#0e0e10'),
    palette: '',
    spread: 0.6,
    seed: 1,
  },
  rebuild: ['seed'],
  presence: 'custom',
  async setup(ctx: EffectContext<Params>) {
    const { u, params, app } = ctx
    const view = screen(ctx)
    const { px, size } = view
    const cell = max(u.cell, MIN_CELL) as F
    const grid = px.div(cell) as V2
    const id = floor(grid) as V2
    const inCell = fract(grid) as V2
    const cells = ceil(size.div(cell)) as V2
    // Hash inputs mixed with primes so neighbouring cells and seeds look unrelated.
    const salt = Math.round(Math.abs(params.seed) * 7919) % 65521
    const turn = hash(id.x.add(id.y.mul(4099)).add(salt)) as F
    const pick = hash(
      id.x
        .mul(131)
        .add(id.y.mul(7))
        .add(salt + 977),
    ) as F

    let order: F = turn
    if (params.order !== 'random') {
      let along: F
      if (params.order === 'diagonal')
        along = id.x.div(cells.x).add(id.y.div(cells.y)).mul(0.5) as F
      else {
        const { origin } = view
        const centre = id.add(0.5).mul(cell)
        along = length(centre.sub(origin)).div(farthest(origin, size)) as F
      }
      order = clamp(along, 0, 1)
        .mul(1 - JITTER)
        .add(turn.mul(JITTER)) as F
    }
    const spread = clamp(u.spread, 0, MAX_SPREAD)
    // This block's own 0..1 within a half of the cover, starting at its turn.
    const local = (half: F): F =>
      smoothstep(0, 1, clamp(half.sub(order.mul(spread)).div(spread.oneMinus()), 0, 1)) as F
    const position = u.position as F
    // The block's side as a share of its cell: grows over the old page, shrinks off the new one.
    const side = local(clamp(position, 0, 1)).sub(local(clamp(position.sub(1), 0, 1)))
    const offCentre = max(abs(inCell.x.sub(0.5)), abs(inCell.y.sub(0.5))).mul(2)
    // A soft pixel at the block's edge; a full block fills its cell without seams.
    const alpha = max(
      clamp(side.sub(offCentre).mul(cell).mul(0.5).add(0.5), 0, 1),
      step(0.999, side),
    )

    let rgb: Node<'vec3'> = u.color.rgb
    const extra = (params.palette.match(CSS_COLOR) ?? [])
      .slice(0, MORE)
      .map((css) => {
        const tinted = tint(css)
        if (!tinted) app.log.warn(`cover pixel: "${css}" in palette is not a colour`)
        return tinted
      })
      .filter((tinted) => tinted !== undefined)
    // `pick` chooses one of the colours, each with an equal share.
    const colours = extra.length + 1
    for (const [index, extraColour] of extra.entries())
      rgb = mix(rgb, uniform(extraColour), step((index + 1) / colours, pick)) as Node<'vec3'>
    return show(ctx, view, vec4(rgb, alpha))
  },
})
export default pixel
