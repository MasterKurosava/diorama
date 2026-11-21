import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { noise, rng } from '@dioramajs/effects/kit'
import {
  clamp,
  float,
  length,
  max,
  min,
  mix,
  sin,
  smoothstep,
  texture,
  vec2,
  vec4,
} from 'three/tsl'
import { BASE, type Base, color, type F, farthest, screen, show, type V2 } from './screen'

type Params = Base & {
  motion: ChoiceParam<'recede' | 'hole'>
  color: ColorParam
  wobble: number
  shade: number
  seed: number
}

/** Drops thrown ahead of the spreading edge. */
const DROPS = 7
/** How far the edge strays from a circle at full wobble, a share of the radius each way. */
const STRAY = 0.3
/** Width of the darker rim inside the edge, CSS px. */
const RIM = 28

/**
 * A blot of ink spreads from the origin (the clicked link) over the whole page, its edge uneven
 * and drops running ahead of it. Then it recedes into where it came from, or a hole opens there,
 * and the new page shows.
 */
const ink: Effect<Params> = defineEffect({
  name: 'cover-ink',
  params: {
    ...BASE,
    motion: oneOf('recede', 'hole'),
    color: color('#0e0e10'),
    wobble: 0.5,
    shade: 0.3,
    seed: 1,
  },
  rebuild: ['seed'],
  presence: 'custom',
  async setup(ctx: EffectContext<Params>) {
    const { u, params } = ctx
    const view = screen(ctx)
    const { px, size, origin } = view
    const grain = noise(ctx, { seed: params.seed, size: 128 })
    const position = u.position as F
    const closing = clamp(position, 0, 1)
    const opening = clamp(position.sub(1), 0, 1)
    const offset = px.sub(origin) as V2
    const distance = length(offset)
    const wobble = clamp(u.wobble, 0, 1)
    // Far enough that the most inward stray of the edge still passes the farthest corner.
    const full = farthest(origin, size).mul(1.04).div(wobble.mul(STRAY).oneMinus())
    // The edge's stray: noise read around a circle, so it has no seam, flowing as the ink moves.
    const around = offset.div(max(distance, 1e-3))
    const flow = position.mul(0.3)
    const stray = (shift: number): F =>
      texture(grain, around.mul(0.3).add(vec2(flow, shift)))
        .r.sub(0.5)
        .mul(1.4)
        .add(
          texture(grain, around.mul(0.9).add(vec2(shift, flow.mul(1.6))))
            .r.sub(0.5)
            .mul(0.6),
        ) as F
    const edgeOf = (radius: F, shift: number): F =>
      radius.mul(
        stray(shift)
          .mul(wobble)
          .mul(STRAY * 2)
          .add(1),
      ) as F

    // Negative where the ink covers, in px.
    const hole = params.motion === 'hole'
    const radius = full.mul(hole ? closing : closing.sub(opening)) as F
    let field = distance.sub(edgeOf(radius, 0.21)) as F
    // Drops run ahead while the ink spreads and join it as it slows.
    const ahead = sin(closing.mul(Math.PI))
      .mul(opening.oneMinus())
      .mul(min(wobble.mul(2), 1))
    const random = rng(params.seed)
    for (let index = 0; index < DROPS; index++) {
      const angle = ((index + random() * 0.8) / DROPS) * Math.PI * 2
      const reach = radius.mul(ahead.mul(0.1 + random() * 0.3).add(1))
      const at = origin.add(vec2(Math.cos(angle), Math.sin(angle)).mul(reach))
      const drop = length(px.sub(at)).sub(radius.mul(ahead).mul(0.04 + random() * 0.05))
      field = smoothUnion(field, drop as F, max(radius.mul(0.05), 1) as F)
    }
    if (hole) {
      // The page shows through a hole that opens where the ink came from.
      field = max(field, edgeOf(full.mul(opening) as F, 0.67).sub(distance)) as F
    }
    const alpha = clamp(float(0.5).sub(field), 0, 1)
    // A darker rim just inside the edge, like ink pooling.
    const rim = smoothstep(-RIM, 0, field).mul(u.shade).mul(0.45)
    const rgb = u.color.rgb.mul(rim.oneMinus())
    return show(ctx, view, vec4(rgb, alpha))
  },
})
export default ink

/** Smooth union of two signed distances, blended over `width` px. */
function smoothUnion(a: F, b: F, width: F): F {
  const blend = clamp(b.sub(a).div(width).mul(0.5).add(0.5), 0, 1)
  return mix(b, a, blend).sub(width.mul(blend).mul(blend.oneMinus())) as F
}
