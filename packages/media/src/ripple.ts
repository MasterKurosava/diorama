import { defineEffect, type Effect } from '@diorama/effects'
import { exp, sin, vec2 } from 'three/tsl'

/** Rings spreading from the pointer while the image is hovered. */
const ripple: Effect<{ strength: number; frequency: number; speed: number }> = defineEffect({
  name: 'ripple',
  params: { strength: 1, frequency: 40, speed: 6 },
  media: true,
  // Reads u.hoverTime, so frames run only under the pointer and while hover decays.
  when: 'hover',
  setup({ surface, u }) {
    surface.uv((uv) => {
      const toPointer = uv.sub(u.pointer)
      const d = toPointer.length()
      const phase = d.mul(u.frequency).sub(u.hoverTime.mul(u.speed))
      const wave = sin(phase).mul(exp(d.mul(-8)), u.hover, u.strength, 0.012)
      return uv.add(toPointer.add(vec2(1e-5, 0)).normalize().mul(wave))
    })
  },
})
export default ripple
