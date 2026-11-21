import type { Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { clamp, float, mix, step, texture, uniform } from 'three/tsl'
import { type Node, type Texture, Vector2 } from 'three/webgpu'

type V2 = Node<'vec2'>
type F = Node<'float'>
type Params = { depth: number; scroll: number; ease: number; map: string; focus: number }

/** The depth search per tier: layers a ray is tested against, then halvings of the gap it hit. */
const SEARCH = { low: [3, 3], medium: [6, 4], high: [10, 5] } as const

/**
 * The image shifts inside its box with the pointer and with scroll. With a depth map near parts
 * move more than far ones and cover them, a 2.5D photo without geometry.
 */
const parallax: Effect<Params> = defineEffect({
  name: 'parallax',
  params: { depth: 0.04, scroll: 0.12, ease: 0.12, map: '', focus: 0.5 },
  media: true,
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { surface, params, app } = ctx
    // Offset in box units (x, y up) a depth map scales per point.
    const shift = uniform(new Vector2())
    const depth = params.map ? await loadDepth(ctx) : undefined
    // The zoom and a flat shift are the copy's framing (`surface.zoom`), so a flight lands in
    // them. With a depth map the shift moves each point by its height instead.
    if (depth) {
      const [layers, halvings] = SEARCH[ctx.quality]
      surface.uv((uv) => relief(ctx, uv, shift as unknown as V2, depth, layers, halvings))
    }

    const fine = matchMedia('(hover: hover)')
    const pointer = { x: 0, y: 0 }
    const write = (progress: number): void => {
      // The farthest a point moves, scaled by the depth model, is what the zoom must hide.
      const reach = depth ? 2 * Math.max(params.focus, 1 - params.focus) : 1
      // Flat, the picture sinks into its frame while scrolling down, centred when the box is.
      // With depth, near parts rise past far ones the way they would past a moving viewer.
      const scrollShift = params.scroll * (0.5 - progress) * (depth ? -1 : 1)
      const zoom = 1 + 2 * (params.depth + params.scroll / 2) * reach
      if (depth) {
        ;(shift.value as Vector2).set(pointer.x, pointer.y + scrollShift)
        surface.zoom(zoom)
      } else surface.zoom(zoom, pointer.x, pointer.y + scrollShift)
    }
    // The first frame after setup draws before any update: it must not pop from zoom 1.
    const rect = ctx.element.getBoundingClientRect()
    const viewportHeight = app.stage.height.peek()
    write(
      Math.min(1, Math.max(0, (viewportHeight - rect.top) / (viewportHeight + rect.height || 1))),
    )

    return (input): boolean => {
      let targetX = 0
      let targetY = 0
      // On touch the pointer is never read, so taps draw nothing.
      if (fine.matches) {
        const at = input.over ? input.pointer : { x: 0.5, y: 0.5 }
        targetX = Math.max(-1, Math.min(1, (at.x - 0.5) * 2)) * -params.depth
        targetY = Math.max(-1, Math.min(1, (at.y - 0.5) * 2)) * -params.depth
      }
      const easing = Math.abs(pointer.x - targetX) >= 1e-5 || Math.abs(pointer.y - targetY) >= 1e-5
      if (easing) {
        pointer.x = damp(pointer.x, targetX, params.ease, input.delta)
        pointer.y = damp(pointer.y, targetY, params.ease, input.delta)
      } else {
        pointer.x = targetX
        pointer.y = targetY
      }
      write(input.progress)
      return easing
    }
  },
})
export default parallax

/** The depth map, or undefined with a warning when it does not load: the shift is flat then. */
async function loadDepth(ctx: EffectContext<Params>): Promise<Texture | undefined> {
  const { params, signal, app } = ctx
  try {
    return await ctx.texture(params.map, { colorSpace: 'linear' })
  } catch (error) {
    if (signal.aborted) throw error
    app.log.warn(`parallax: the depth map ${params.map} did not load, the shift is flat`, error)
    return undefined
  }
}

/**
 * Box UV with the depth map's relief. A shift of `offset` moves a point at height h (white is
 * near) by offset * (h - focus) * 2. The ray through a pixel is tested against `layers` heights
 * from near to far; the first one the depth map reaches is what the pixel shows, so near parts
 * cover far ones instead of smearing over them. Halving the gap it was found in `halvings` times
 * puts silhouettes on the pixel instead of in steps.
 */
function relief(
  ctx: EffectContext<Params>,
  uv: V2,
  offset: V2,
  depth: Texture,
  layers: number,
  halvings: number,
): V2 {
  const at = (height: F) => uv.sub(offset.mul(height.sub(ctx.u.focus).mul(2)))
  // 1 once the ray at this height is under the surface.
  const under = (height: F) =>
    step(height, texture(depth, clamp(ctx.coverUV(at(height)), 0, 1) as V2).r)
  let hit: F = float(0)
  let above: F = float(1)
  let below: F = float(0)
  for (let i = 0; i <= layers; i++) {
    const height = float(1 - i / layers)
    // 1 on the first layer under the surface only.
    const firstHit = under(height).mul(hit.oneMinus())
    above = mix(above, float(Math.min(1, 1 - (i - 1) / layers)), firstHit)
    below = mix(below, height, firstHit)
    hit = hit.add(firstHit)
  }
  for (let i = 0; i < halvings; i++) {
    const middle = above.add(below).mul(0.5)
    const middleUnder = under(middle)
    below = mix(below, middle, middleUnder)
    above = mix(middle, above, middleUnder)
  }
  return at(above.add(below).mul(0.5))
}
