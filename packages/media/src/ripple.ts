import type { Effect } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { cos, exp, max, sin, smoothstep, vec2, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/** Displacement at strength 1, in box heights. */
const AMPLITUDE = 0.02
/** Light on the crests and shade in the troughs at strength 1. */
const LIGHT = 0.12
/** How fast the rings fade with distance, per box height. */
const FADE = 4

/**
 * Rings spreading from the pointer while the image is hovered. Distances are in box heights, so
 * the rings stay round on any aspect, and the crests catch a little light like water.
 */
const ripple: Effect<{ strength: number; frequency: number; speed: number }> = defineEffect({
  name: 'ripple',
  params: { strength: 1, frequency: 40, speed: 6 },
  media: true,
  // Reads u.hoverTime, so frames run only under the pointer and while hover decays.
  when: 'hover',
  quality: {},
  setup({ surface, u }) {
    // Box UV to box heights: x scaled by the aspect.
    const aspect = vec2(u.size.x.div(max(u.size.y, 1)), 1)
    // The wave at a point: its offset from the pointer, its phase and its height.
    const wave = (uv: Node<'vec2'>) => {
      const fromPointer = uv.sub(u.pointer).mul(aspect)
      const distance = fromPointer.length()
      const phase = distance.mul(u.frequency).sub(u.hoverTime.mul(u.speed))
      // Calm right under the pointer, rings around it fading with distance.
      const envelope = exp(distance.mul(-FADE)).mul(
        smoothstep(0, 0.04, distance),
        u.hover,
        u.strength,
      )
      return { fromPointer, phase, envelope }
    }
    surface.uv((uv) => {
      const { fromPointer, phase, envelope } = wave(uv)
      // The tiny x offset keeps normalize() defined right at the pointer.
      const outward = fromPointer.add(vec2(1e-5, 0)).normalize()
      const push = outward.mul(sin(phase).mul(envelope, AMPLITUDE))
      return uv.add(push.div(aspect))
    })
    surface.color((color, { box }) => {
      const { phase, envelope } = wave(box)
      const light = cos(phase).mul(envelope, LIGHT)
      return vec4(color.rgb.add(light.mul(color.a)), color.a)
    })
  },
})
export default ripple
