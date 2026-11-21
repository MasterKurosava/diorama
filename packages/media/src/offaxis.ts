// A box seen with its own perspective, like CSS `perspective()` on the element itself (tilt,
// flipbook). The page camera looks at the viewport centre from `distance` px, so a box tilted in
// 3D away from the centre looks skewed. Scaling depth by distance / perspective and pulling each
// point towards the camera axis by its depth puts the vanishing point at the box centre instead.
import { vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

type Vec3 = readonly [number, number, number]

/**
 * Where to draw a point of a box for the page camera so it projects as if seen from in front of
 * the box centre with `perspective`. `p` is the point in px from the box centre after the box's
 * own rotation (y up, z towards the viewer); `centre` is the box centre in world px (viewport
 * centre 0,0, y up); `distance` is the camera's, `ctx.render.camera.position.z`. Returns the
 * offset from the box centre to draw at.
 */
export function offaxis(
  p: Vec3,
  centre: readonly [number, number],
  perspective: number,
  distance: number,
): [number, number, number] {
  const z = (p[2] * distance) / perspective
  return [p[0] - (centre[0] * z) / distance, p[1] - (centre[1] * z) / distance, z]
}

/** `offaxis` in a vertex graph, for `surface.position` or a placed mesh. */
export function offaxisNode(
  p: Node<'vec3'>,
  centre: Node<'vec2'>,
  perspective: Node<'float'>,
  distance: Node<'float'> | number,
): Node<'vec3'> {
  const z = p.z.mul(distance).div(perspective)
  return vec3(p.xy.sub(centre.mul(z).div(distance)), z) as unknown as Node<'vec3'>
}

/** The centre of a viewport box (CSS px, y down) in world px: viewport centre 0,0, y up. */
export function centre(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): [number, number] {
  return [box.x + box.width / 2 - viewport.width / 2, viewport.height / 2 - box.y - box.height / 2]
}
