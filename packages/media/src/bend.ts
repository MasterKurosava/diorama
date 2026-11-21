import type { Effect } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { abs, PI, sin, vec2, vec3, vec4 } from 'three/tsl'

/** How far the middle of the image lifts at strength 1 and full speed, in box heights. */
const LIFT = 0.08
/** Offset of the red and blue channels at split 1 and full speed, in box heights. */
const SPLIT = 0.015

/** Scroll speed bends the image like paper dragged through air and splits its colour channels. */
const bend: Effect<{ strength: number; split: number }> = defineEffect({
  name: 'bend',
  params: { strength: 1, split: 1 },
  media: true,
  bleed: 120,
  quality: {},
  setup({ surface, u }) {
    surface.segments(32)
    // A soft knee: an ordinary scroll already bends visibly, a fling no more than before.
    const speed = u.velocity.mul(1.25).div(abs(u.velocity).add(0.25))
    const lift = speed.mul(u.strength, -LIFT)
    surface.position((p, uv) => p.add(vec3(0, sin(uv.x.mul(PI)).mul(lift), 0)))
    surface.color((color, { uv, sample }) => {
      // Only the split adds to what earlier effects made, so at rest it is a no-op.
      const shift = vec2(0, speed.mul(u.split, SPLIT))
      const here = sample(uv)
      const red = color.r.add(sample(uv.add(shift)).r.sub(here.r))
      const blue = color.b.add(sample(uv.sub(shift)).b.sub(here.b))
      return vec4(red, color.g, blue, color.a)
    })
  },
})
export default bend
