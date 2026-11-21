// Frost drawn as a pane of ice over the page or a box. Nothing is sampled: the page stays real
// DOM under the ice, readable and clickable, and the ice is only a translucent layer on top.
import type { EffectContext } from '@dioramajs/effects'
import {
  abs,
  float,
  floor,
  fract,
  hash,
  length,
  max,
  min,
  mix,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  type DataTexture,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type Texture,
  Vector2,
  type Vector3,
  type Vector4,
} from 'three/webgpu'
import { TILE } from './feathers'
import { EDGE, frozen } from './wipe'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type U<T> = Node<T extends Vector4 ? 'vec4' : T extends Vector3 ? 'vec3' : 'vec2'>

/** Cell of the glints, px: at most one glint per cell. */
const GLINT = 9
/** Distance from the pointer within which the ice glitters, px. */
const SHINE = 260
/** Steam droplets sit on a grid of this many px. */
const CELL = 16
/** Boxes the ice keeps thin over, at most. */
export const KEEP = 6
/** Soft edge around a kept box, px. */
const SOFT = 70

export interface PaneParts {
  /** The wipe mask, red channel, y up. */
  readonly map: DataTexture
  readonly tile: Texture
  /** {@link featherTexture}. */
  readonly feathers: Texture
  /** (clearing origin px, its radius px, unused), as on the photo. */
  readonly look: Vector4
  /** {@link Freeze.look}. */
  readonly freeze: Vector4
  /** (pointer px, y up, 1 while over the pane). */
  readonly light: Vector3
  /** (thinning of the middle 0..1, 1 under reduced motion, unused). */
  readonly calm: Vector3
  /** {@link KEEP} boxes the ice keeps thin over: (centre px, y up, half size px); 0 size is none. */
  readonly keep: readonly Vector4[]
  /** Uniforms of the params `strength`, `grain`, `color` and of the presence. */
  readonly strength: F
  readonly grain: F
  readonly color: V3
  readonly presence: F
  readonly steam: boolean
  readonly low: boolean
}

/** The ice as one quad in `ctx.overlay`; place it with {@link Pane.place}. */
export class Pane {
  readonly mesh: Mesh
  readonly #size = uniform(new Vector2(1, 1))

  constructor(ctx: Pick<EffectContext, 'onDispose'>, parts: PaneParts) {
    const size = this.#size as unknown as V2
    const look = uniform(parts.look) as unknown as U<Vector4>
    const freeze = uniform(parts.freeze) as unknown as U<Vector4>
    const light = uniform(parts.light) as unknown as U<Vector3>
    const calm = uniform(parts.calm) as unknown as U<Vector3>
    const at = uv() as unknown as V2
    const point = at.mul(size)

    // Two scales of the noise tile: `coarse` for patches and ragged edges, `fine` for detail.
    const coarse = texture(parts.tile, point.div(430)) as unknown as V4
    const fine = texture(parts.tile, point.div(150).add(coarse.ba.mul(0.35))) as unknown as V4
    const ragged = coarse.r.sub(0.5).mul(0.5)
    const wiped = smoothstep(0.3, 0.7, (texture(parts.map, at).r as unknown as F).add(ragged))
    const fromOrigin = length(point.sub(look.xy)).add(coarse.g.sub(0.5).mul(EDGE))
    const grown = smoothstep(look.z, look.z.sub(EDGE), fromOrigin).mul(step(0.5, look.z))
    const clear = max(wiped, grown) as unknown as F
    const fog = clear.oneMinus()
    const { ice, wet, slush, front } = frozen(point, size, freeze, coarse.a, fine.r)

    // Thick at the edges, where frost starts on a window, a milky veil of `strength` inside.
    const toSideX = min(point.x, size.x.sub(point.x))
    const toSideY = min(point.y, size.y.sub(point.y))
    const edge = min(toSideX, toSideY)
      .div(max(min(size.x, size.y).mul(0.5), 1))
      .add(coarse.a.sub(0.5).mul(0.35))
    const middle = length(at.sub(0.5).mul(2))
    const reading = smoothstep(0.95, 0.25, middle).mul(calm.x)
    const veil = parts.strength.clamp(0, 1).mul(reading.oneMinus())
    // Over the boxes of `keep` (text, a button) the ice stays a thin veil.
    let kept = float(0) as unknown as F
    for (const box of parts.keep) {
      const keptBox = uniform(box) as unknown as V4
      const corner = abs(point.sub(keptBox.xy)).sub(keptBox.zw)
      // A ragged edge, like a patch someone breathed on.
      const fromBox = length(max(corner, 0))
        .add(min(max(corner.x, corner.y), 0))
        .add(coarse.r.sub(0.5).mul(SOFT * 1.4))
      kept = max(kept, smoothstep(SOFT, 0, fromBox).mul(step(0.5, keptBox.z))) as unknown as F
    }
    const thick = mix(
      mix(veil, 0.85, smoothstep(0.42, 0.0, edge)),
      veil.mul(0.6),
      kept,
    ) as unknown as F

    const tint = parts.color
    let rgb: V3
    let alpha: F
    if (parts.steam) {
      // Condensation: a grey veil and beads that catch the light, thicker towards the edges.
      const inCells = point.div(CELL)
      const id = floor(inCells)
      const seed = id.x.add(id.y.mul(1013)).mul(4)
      const random = hash(seed)
      const centre = vec2(hash(seed.add(1)), hash(seed.add(2)))
        .mul(0.5)
        .add(0.25)
      const radius = random.mul(0.22).add(0.07)
      const fromCentre = fract(inCells).sub(centre)
      const distance = length(fromCentre)
      // About six cells in ten hold a bead.
      const bead = smoothstep(radius, radius.mul(0.7), distance).mul(
        step(0.4, random),
        parts.grain.clamp(0, 1),
      )
      const glint = smoothstep(radius.mul(0.45), 0, length(fromCentre.add(radius.mul(0.35))))
      const rim = smoothstep(radius.mul(0.55), radius, distance).mul(bead)
      alpha = thick.mul(0.7).add(bead.mul(0.25)).add(glint.mul(bead).mul(0.6)) as unknown as F
      rgb = mix(tint.mul(0.86), vec3(1), glint.mul(bead).add(rim.mul(0.3)).clamp(0, 1)) as never
    } else {
      // Feathers of ice from the baked tile, thick towards the edges where frost starts, a
      // few stars and stray feathers in the middle. Two layers at different scales and turns,
      // warped by the noise, so the tile never shows its repeat.
      const warp = coarse.ba.sub(0.5).mul(0.14)
      const layerA = texture(parts.feathers, point.div(TILE).add(warp)) as unknown as V4
      const layerB = parts.low
        ? layerA
        : (texture(
            parts.feathers,
            vec2(point.y, point.x.negate())
              .div(TILE * 1.43)
              .add(0.31)
              .sub(warp),
          ) as unknown as V4)
      const dense = smoothstep(0.66, 0.08, edge)
      const patch = smoothstep(0.3, 0.7, coarse.g)
      const lines = max(
        layerA.r.mul(patch.mul(0.5).add(0.5)),
        layerB.r.mul(patch.oneMinus().mul(0.6).add(0.4)),
      )
      const glow = max(layerA.g, layerB.g).mul(dense)
      const stars = layerA.b.mul(dense.oneMinus()).mul(smoothstep(0.45, 0.6, fine.g))
      const crystals = lines
        .mul(dense.mul(0.8).add(0.04))
        .add(glow.mul(0.24))
        .add(stars.mul(0.4))
        .add(front.mul(lines.add(0.25)).mul(0.6))
        .mul(parts.grain.clamp(0, 1).mul(1.6))
        .mul(kept.mul(0.7).oneMinus())
        .mul(calm.y.oneMinus()) as unknown as F
      // Glints: a few cells hold a point of light, brighter near the pointer.
      const cell = point.div(GLINT)
      const random = hash(floor(cell.x).add(floor(cell.y).mul(7919)))
      const near = smoothstep(SHINE, 0, length(point.sub(light.xy))).mul(light.z)
      const spark = smoothstep(0.32, 0, length(fract(cell).sub(0.5)))
      const glints = step(0.985, random)
        .mul(spark)
        .mul(near.mul(1.6).add(0.25))
        .mul(thick)
        .mul(calm.y.oneMinus()) as unknown as F
      const white = crystals.add(glints).add(thick.mul(0.2)).clamp(0, 1)
      alpha = thick.mul(0.55).add(crystals.mul(0.75)).add(glints) as unknown as F
      rgb = mix(tint.mul(vec3(0.76, 0.85, 0.95)), vec3(1), white) as unknown as V3
    }
    // A wiped band keeps a rim of water; the slush ahead of a thaw goes clear and glossy, and
    // the glass behind it is wet for a while.
    // Only where the glass turns from fogged to clear, not over a thin fog that came back.
    const rim = smoothstep(0.3, 0.5, clear)
      .mul(smoothstep(0.7, 0.5, clear))
      .mul(ice)
    alpha = alpha.mul(slush.mul(0.55).oneMinus()).add(rim.mul(0.12)) as unknown as F
    const shine = wet.mul(smoothstep(0.55, 0.8, fine.b)).mul(0.16)
    rgb = mix(rgb, vec3(1), rim.mul(0.5)) as unknown as V3
    // Reduced motion: only a faint cold tint.
    const strength = mix(1, 0.32, calm.y)
    const opacity = alpha.clamp(0, 0.96).mul(ice).mul(fog).mul(strength).add(shine)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.colorNode = vec4(rgb, opacity.mul(parts.presence).clamp(0, 1))
    this.mesh = new Mesh(new PlaneGeometry(1, 1), material)
    this.mesh.frustumCulled = false
    ctx.onDispose(() => {
      this.mesh.geometry.dispose()
      material.dispose()
    })
  }

  /** Covers the area at `left`, `top` (client px) of the viewport `viewportWidth` × `viewportHeight`. */
  place(
    left: number,
    top: number,
    width: number,
    height: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    this.mesh.position.set(
      left + width / 2 - viewportWidth / 2,
      viewportHeight / 2 - (top + height / 2),
      0,
    )
    this.mesh.scale.set(Math.max(width, 1), Math.max(height, 1), 1)
    ;(this.#size.value as Vector2).set(Math.max(width, 1), Math.max(height, 1))
  }
}
