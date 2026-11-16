import { defineEffect, type Effect } from '@diorama/effects'
import { PI, sin, vec2, vec3, vec4 } from 'three/tsl'

/** Scroll speed bends the image like paper dragged through air and splits its colour channels. */
const bend: Effect<{ strength: number; split: number }> = defineEffect({
  name: 'bend',
  params: { strength: 1, split: 1 },
  media: true,
  bleed: 120,
  setup({ surface, u }) {
    surface.segments(32)
    const lift = u.velocity.mul(u.strength, -0.08)
    surface.position((p, uv) => p.add(vec3(0, sin(uv.x.mul(PI)).mul(lift), 0)))
    surface.color((color, { uv, sample }) => {
      // Only the split adds to what earlier effects made, so at rest it is a no-op.
      const shift = vec2(0, u.velocity.mul(u.split, 0.015))
      const here = sample(uv)
      const r = color.r.add(sample(uv.add(shift)).r.sub(here.r))
      const b = color.b.add(sample(uv.sub(shift)).b.sub(here.b))
      return vec4(r, color.g, b, color.a)
    })
  },
})
export default bend
