// Hand-made shading of the picture objects (coin, vinyl, label): a print lit from the upper left
// that keeps its own colours facing the viewer, and metal or glass that mirror a small studio.
// No environment map: the same pixels on both backends, and nothing to load.
import {
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'

type F = Node<'float'>
type V3 = Node<'vec3'>

/** Light from the upper left in front, in world space. */
const LIGHT = [-0.45, 0.55, 0.7] as const
const LIGHT_LENGTH = Math.hypot(...LIGHT)
/** Brightness of a face turned away from the light. */
const AMBIENT = 0.55

/** Unit direction to the light. */
export const light = (): V3 =>
  vec3(LIGHT[0] / LIGHT_LENGTH, LIGHT[1] / LIGHT_LENGTH, LIGHT[2] / LIGHT_LENGTH)

/** Unit direction from the surface to the camera. */
export const toEye = (): V3 => normalize(cameraPosition.sub(positionWorld)) as unknown as V3

/**
 * A print under the light: facing the viewer it keeps the picture's own colour, turned away it
 * darkens, and `gloss` adds a highlight as it turns.
 */
export function printed(base: V3, n: V3, gloss: number | F = 0): V3 {
  const toLight = light()
  // Diffuse light relative to a face toward the viewer, so that face gets exactly 1.
  const lambert = clamp(dot(n, toLight).div(LIGHT[2] / LIGHT_LENGTH), 0, 1.06)
  const lit = base.mul(mix(float(AMBIENT), float(1), lambert)) as unknown as V3
  const half = normalize(toLight.add(toEye()))
  const highlight = pow(max(dot(n, half), 0), 60)
  return lit.add(highlight.mul(gloss)) as unknown as V3
}

/**
 * Brightness of a small studio seen along the unit direction `ray`: a large soft box behind the
 * camera, a round one at the upper left, a tall strip at the right, a dark floor.
 */
export function studio(ray: V3): F {
  const sky = mix(float(0.1), float(0.34), smoothstep(-0.5, 1, ray.y))
  const front = smoothstep(0.35, 1, ray.z).mul(0.5)
  const floor = smoothstep(-0.15, -0.6, ray.y).mul(0.08)
  return sky.add(front).add(glint(ray)).sub(floor) as unknown as F
}

/** The studio's two lamps alone: next to nothing along the view, so a print facing it stays true. */
export function glint(ray: V3): F {
  const key = pow(max(dot(ray, light()), 0), 24).mul(2.2)
  // A square, not pow: WGSL has no pow of a negative base.
  const fromStrip = ray.x.sub(0.9).mul(12)
  const strip = exp(fromStrip.mul(fromStrip).negate())
    .mul(smoothstep(-0.7, 0.1, ray.y))
    .mul(1.5)
  return key.add(strip) as unknown as F
}

/** Polished metal of `tint` with the normal `n`: the studio mirrored, white at grazing angles. */
export function metal(tint: V3, n: V3, rough = 0): V3 {
  const eye = toEye()
  const reflected = reflect(eye.negate(), n) as unknown as V3
  const mirror = studio(reflected)
  // A rough metal shows the studio blurred: less contrast, a little more fill.
  const env = mix(mirror, mirror.mul(0.55).add(0.25), rough) as unknown as F
  const facing = max(dot(n, eye), 0)
  const fresnel = pow(float(1).sub(facing), 5)
  return mix(tint.mul(env), vec3(env), fresnel.mul(0.6)) as unknown as V3
}

/** Coloured glass of `tint` with the normal `n`: a dark body with sharp reflections at the rims. */
export function glass(tint: V3, n: V3, body = 0.45): V3 {
  const eye = toEye()
  const reflected = reflect(eye.negate(), n) as unknown as V3
  const facing = max(dot(n, eye), 0)
  const fresnel = mix(float(0.06), float(1), pow(float(1).sub(facing), 4))
  // Light through the glass: brighter where it is seen face on and from the light's side.
  const through = tint.mul(mix(float(body * 0.45), float(body), facing))
  const shine = max(studio(reflected).sub(0.18), 0)
  return through.add(vec3(shine.mul(fresnel.mul(0.9).add(0.12)))) as unknown as V3
}
