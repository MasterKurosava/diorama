// The grains of `dust`: the glyph raster cut into square cells, each a grain that carries its
// piece of the text, and their flight in 3D through a curl-like flow, lit, with a depth blur and a
// shadow on the page. Runs only in the dust chunk.
import { rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  cos,
  cross,
  dot,
  exp,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sRGBTransferEOTF,
  step,
  texture,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  CanvasTexture,
  type InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
} from 'three/webgpu'
import { instanced } from './points'
import type { Raster } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/** The grains of a raster on a square grid from the corner of its frame. */
export interface Field {
  readonly count: number
  /** Per grain: centre x, y in box px (y down), when it comes loose 0..1, ink coverage 0..1. */
  readonly home: Float32Array
  /** Per grain: linear r, g, b of its piece, a random 0..1. */
  readonly ink: Float32Array
  /** Per grain: four more randoms. */
  readonly random: Float32Array
  /** Per grain: its cell, row-major from the top-left. */
  readonly index: Uint32Array
  /** Cell side in box px. */
  readonly cell: number
  readonly cols: number
  readonly rows: number
  /** Ink bounds in box px: left, top, right, bottom. */
  readonly bounds: readonly [number, number, number, number]
}

export interface FieldOptions {
  /** Cell side in box px; widened until the grains fit `max`. */
  readonly cell: number
  readonly max: number
  readonly seed: number
}

/** Cells whose mean ink stays under this make no grain. */
const FAINT = 0.02

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** Cell of a box coordinate, the same rule as the shader's. */
export const cellAt = (at: number, origin: number, cell: number): number =>
  Math.floor((at - origin) / cell)

/**
 * The raster cut into cells: each cell with ink is a grain with the mean colour and coverage of
 * its pixels. The cell widens until at most `max` grains are left.
 */
export function field(layout: Raster, image: ImageData | undefined, options: FieldOptions): Field {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  let cell = Math.max(0.5, options.cell)
  const empty: Field = {
    count: 0,
    home: new Float32Array(4),
    ink: new Float32Array(4),
    random: new Float32Array(4),
    index: new Uint32Array(1),
    cell,
    cols: 1,
    rows: 1,
    bounds: [0, 0, 0, 0],
  }
  if (!image) return empty
  const { data, width: imageWidth, height: imageHeight } = image
  const scaleX = imageWidth / frameWidth
  const scaleY = imageHeight / frameHeight
  for (let attempt = 0; attempt < 6; attempt++) {
    const cols = Math.max(1, Math.ceil(frameWidth / cell))
    const rows = Math.max(1, Math.ceil(frameHeight / cell))
    const colOf = Int32Array.from({ length: imageWidth }, (_, px) =>
      Math.min(cols - 1, cellAt(frameX + (px + 0.5) / scaleX, frameX, cell)),
    )
    const rowOf = Int32Array.from({ length: imageHeight }, (_, py) =>
      Math.min(rows - 1, cellAt(frameY + (py + 0.5) / scaleY, frameY, cell)),
    )
    // Per cell: alpha, r·a, g·a, b·a, pixels.
    const sums = new Float64Array(cols * rows * 5)
    for (let py = 0; py < imageHeight; py++) {
      const row = (rowOf[py] as number) * cols
      for (let px = 0; px < imageWidth; px++) {
        const pixel = (py * imageWidth + px) * 4
        const sum = (row + (colOf[px] as number)) * 5
        const alpha = data[pixel + 3] as number
        sums[sum + 4] = (sums[sum + 4] as number) + 1
        if (!alpha) continue
        sums[sum] = (sums[sum] as number) + alpha
        sums[sum + 1] = (sums[sum + 1] as number) + (data[pixel] as number) * alpha
        sums[sum + 2] = (sums[sum + 2] as number) + (data[pixel + 1] as number) * alpha
        sums[sum + 3] = (sums[sum + 3] as number) + (data[pixel + 2] as number) * alpha
      }
    }
    const cells: number[] = []
    for (let cellIndex = 0; cellIndex < cols * rows; cellIndex++) {
      const pixelCount = sums[cellIndex * 5 + 4] as number
      if (pixelCount && (sums[cellIndex * 5] as number) / (pixelCount * 255) >= FAINT)
        cells.push(cellIndex)
    }
    if (!cells.length) return empty
    if (cells.length > options.max && attempt < 5) {
      cell *= Math.sqrt(cells.length / options.max) * 1.03
      continue
    }
    const count = Math.min(cells.length, options.max)
    const home = new Float32Array(count * 4)
    const ink = new Float32Array(count * 4)
    const random = new Float32Array(count * 4)
    const index = new Uint32Array(count)
    const nextRandom = rng(options.seed)
    const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i++) {
      const cellIndex = cells[i] as number
      const col = cellIndex % cols
      const row = Math.floor(cellIndex / cols)
      const x = frameX + (col + 0.5) * cell
      const y = frameY + (row + 0.5) * cell
      const sumAt = cellIndex * 5
      const alpha = sums[sumAt] as number
      home.set([x, y, 0, Math.min(1, alpha / ((sums[sumAt + 4] as number) * 255))], i * 4)
      ink.set(
        [
          toLinear((sums[sumAt + 1] as number) / alpha / 255),
          toLinear((sums[sumAt + 2] as number) / alpha / 255),
          toLinear((sums[sumAt + 3] as number) / alpha / 255),
          nextRandom(),
        ],
        i * 4,
      )
      random.set([nextRandom(), nextRandom(), nextRandom(), nextRandom()], i * 4)
      index[i] = cellIndex
      bounds[0] = Math.min(bounds[0], x - cell / 2)
      bounds[1] = Math.min(bounds[1], y - cell / 2)
      bounds[2] = Math.max(bounds[2], x + cell / 2)
      bounds[3] = Math.max(bounds[3], y + cell / 2)
    }
    return { count, home, ink, random, index, cell, cols, rows, bounds }
  }
  return empty
}

/** How the grains move. */
export type Motion = 'wind' | 'rise' | 'explode'

/** Instance attributes of the grains. */
export const HOME = 'grainHome'
export const INK = 'grainInk'
export const RANDOM = 'grainRandom'

/** The soft light over the page: from the upper left, in front. y up, z towards the viewer. */
const LIGHT: readonly [number, number, number] = (() => {
  const direction = [-0.45, 0.6, 0.66]
  const norm = Math.hypot(...direction)
  return direction.map((v) => v / norm) as unknown as [number, number, number]
})()
/** Share of the light that reaches every side. */
const AMBIENT = 0.5
/** The light on a flake facing the viewer: shading divides by it, so an unturned flake is as drawn. */
const FLAT = AMBIENT + (1 - AMBIENT) * LIGHT[2]
/** Depth blur per px of distance from the page plane. */
const BLUR = 0.006
/** Advection steps of the flow. */
const STEPS = 5

/**
 * Per motion: the size of the swirls in font sizes, the turns a flake makes in its flight and
 * the part of the flight in which a flake rounds off into a grain (never for explode's shards).
 */
const SHAPE: Readonly<
  Record<
    Motion,
    { readonly flow: number; readonly spin: number; readonly round: readonly [number, number] }
  >
> = {
  wind: { flow: 1.6, spin: 2.5, round: [0.04, 0.32] },
  rise: { flow: 2.4, spin: 1.2, round: [0.15, 0.6] },
  explode: { flow: 2, spin: 3.2, round: [2, 3] },
}

/** What the grain materials read: uniforms of the effect and its params. */
export interface Flight {
  readonly motion: Motion
  /** How far the sweep front has gone, in sweep units. */
  readonly front: F
  /** Share of the sweep one grain flies for. */
  readonly span: number
  /** Unit wind direction, y up. */
  readonly way: V2
  /** Where an explosion starts, box px y down. */
  readonly middle: V2
  /** Typical travel of a grain, px. */
  readonly reach: F
  /** Size of the flow's swirls, px. */
  readonly em: F
  /** Cell side, px. */
  readonly cell: F
  readonly dot: F
  readonly turbulence: F
  readonly depth: F
  readonly shadow: F
  /** 1 under reduced motion: no grain shows. */
  readonly calm: F
  /** Half the box size, px. */
  readonly half: V2
  /** The raster frame in box px. */
  readonly frame: V4
  readonly seed: number
}

/** Rotates `v` around the unit `axis` by `angle`. */
function turn(v: V3, axis: V3, angle: F): V3 {
  const cosine = cos(angle)
  const sine = sin(angle)
  return v
    .mul(cosine)
    .add(cross(axis, v).mul(sine))
    .add(axis.mul(dot(axis, v).mul(cosine.oneMinus()))) as V3
}

/**
 * A curl-like flow: the rotated gradient of a few seeded waves over a warped plane, so the
 * velocity has no sources or sinks and neighbours swirl together. z is a wave of its own.
 */
function flow(seed: number, scale: F): (p: V3) => V3 {
  const random = rng(seed * 7919 + 17)
  const waves = [1, 2.1, 4.3].map((frequency, i) => {
    const angle = random() * Math.PI * 2
    const zAngle = random() * Math.PI * 2
    return {
      frequency,
      weight: [1, 0.5, 0.25][i] as number,
      // Direction of the wave whose gradient makes the flow, and of the one that makes z.
      direction: [Math.cos(angle), Math.sin(angle)] as const,
      zDirection: [Math.cos(zAngle), Math.sin(zAngle)] as const,
      phase: random() * Math.PI * 2,
      zPhase: random() * Math.PI * 2,
    }
  })
  const warp = [random() * 6.28, random() * 6.28]
  const invScale = float(1).div(scale)
  return (p) => {
    const x = p.x.mul(invScale)
    const y = p.y.mul(invScale)
    const warpedX = x.add(sin(y.mul(1.7).add(warp[0] as number)).mul(0.6))
    const warpedY = y.add(sin(x.mul(1.3).add(warp[1] as number)).mul(0.6))
    let gradX: F = float(0)
    let gradY: F = float(0)
    let vz: F = float(0)
    for (const wave of waves) {
      const along = warpedX
        .mul(wave.direction[0])
        .add(warpedY.mul(wave.direction[1]))
        .mul(wave.frequency)
        .add(wave.phase)
      const slope = cos(along).mul(wave.weight)
      gradX = gradX.add(slope.mul(wave.direction[0])) as F
      gradY = gradY.add(slope.mul(wave.direction[1])) as F
      const across = warpedX
        .mul(wave.zDirection[0])
        .add(warpedY.mul(wave.zDirection[1]))
        .mul(wave.frequency)
        .add(wave.zPhase)
      vz = vz.add(sin(across).mul(wave.weight)) as F
    }
    return vec3(gradY, gradX.negate(), vz.mul(0.6))
  }
}

/** Where a grain is, how it is turned and how it looks at its flight `progress`. */
interface Grain {
  /** Centre in the layer's local space: px, y up, z towards the viewer. */
  readonly centre: V3
  readonly progress: F
  /** 0 before it comes loose and after it is gone. */
  readonly loose: F
  readonly axis: V3
  readonly angle: F
  /** Side of the flake, px. */
  readonly size: F
  /** 0 a textured flake, 1 a round grain. */
  readonly round: F
  /** Alpha over its life. */
  readonly fade: F
}

function grain(flight: Flight): Grain {
  const home = attribute(HOME, 'vec4') as unknown as V4
  const inkOf = attribute(INK, 'vec4') as unknown as V4
  const random = attribute(RANDOM, 'vec4') as unknown as V4
  // Five random 0..1 values per grain.
  const [r0, r1, r2, r3, r4] = [inkOf.w, random.x, random.y, random.z, random.w]
  const shape = SHAPE[flight.motion]
  const progress = flight.front.sub(home.z).div(flight.span).clamp(0, 1) as F
  const loose = step(1e-4, progress).mul(step(progress, 0.9999)).mul(flight.calm.oneMinus()) as F
  const start = vec3(home.x.sub(flight.half.x), flight.half.y.sub(home.y), 0) as V3
  const reach = flight.reach.mul(r1.mul(0.9).add(0.55)) as F
  const up = vec3(0, 1, 0)
  const wind = vec3(flight.way.x, flight.way.y, 0) as V3
  // How far the grain comes off the page, -0.25..1: most towards the viewer.
  const lift = r2.mul(1.25).sub(0.25)
  const burst = (t: F): F =>
    exp(t.mul(-3.2))
      .oneMinus()
      .div(1 - Math.exp(-3.2)) as F
  let drift: (t: F) => V3
  if (flight.motion === 'rise') {
    drift = (t) =>
      up
        .mul(reach.mul(0.9).mul(pow(t, 1.3)))
        .add(wind.mul(reach.mul(0.15).mul(t)))
        .add(vec3(0, 0, reach.mul(0.5).mul(flight.depth).mul(lift).mul(t))) as V3
  } else if (flight.motion === 'explode') {
    const out = start.xy.sub(
      vec2(flight.middle.x.sub(flight.half.x), flight.half.y.sub(flight.middle.y)),
    ) as V2
    const far = max(length(out), flight.em.mul(0.5))
    // Out from the middle and mostly towards the viewer: a shard near the middle flies straight
    // at the camera, one at an end flies wide.
    const spread = out.div(far)
    const away = vec3(
      spread.x.mul(0.9).add(r3.sub(0.5).mul(0.7)),
      spread.y.mul(0.9).add(r4.sub(0.5).mul(0.7)),
      r2.mul(0.95).sub(0.3).mul(flight.depth),
    )
    drift = (t) =>
      away
        .mul(reach.mul(burst(t)).mul(r3.mul(0.6).add(0.6)))
        .sub(up.mul(reach.mul(0.25).mul(t).mul(t))) as V3
  } else {
    drift = (t) =>
      wind
        .mul(reach.mul(pow(t, 1.6)))
        .add(up.mul(reach.mul(0.16).mul(t).mul(t)))
        .add(vec3(0, 0, reach.mul(0.4).mul(flight.depth).mul(lift).mul(pow(t, 1.2)))) as V3
  }
  // The flow carries each grain from where it is, a few steps along its path.
  const field = flow(flight.seed, flight.em.mul(shape.flow))
  const swirlStrength = flight.em
    .mul(flight.motion === 'explode' ? 0.5 : flight.motion === 'rise' ? 2 : 1.4)
    .mul(flight.turbulence)
    .mul(r3.mul(0.8).add(0.6))
  let swirl: V3 = vec3(0, 0, 0) as V3
  for (let i = 0; i < STEPS; i++) {
    const t = progress.mul((i + 0.5) / STEPS) as F
    const velocity = field(start.add(drift(t)).add(swirl) as V3)
    const calm = smoothstep(0, 0.3, t)
    swirl = swirl.add(
      velocity.mul(vec3(1, 1, flight.depth)).mul(swirlStrength.mul(calm).mul(progress).div(STEPS)),
    ) as V3
  }
  const centre = start.add(drift(progress)).add(swirl) as V3
  const axis = normalize(vec3(cos(r4.mul(6.2832)), sin(r4.mul(6.2832)), r0.mul(2).sub(1))) as V3
  const angle = progress.mul(shape.spin * 6.2832).mul(r0.mul(1.2).add(0.4)) as F
  const [from, to] = shape.round
  const round = smoothstep(from, to, progress) as F
  const grainSize = flight.dot.mul(r3.mul(0.9).add(0.55))
  const size =
    flight.motion === 'explode'
      ? (flight.cell.mul(mix(float(1), float(0.6), progress)) as F)
      : (mix(flight.cell, grainSize, smoothstep(0, 0.8, progress)) as F)
  const life = r1.mul(0.3).add(0.7)
  const fade = smoothstep(life.mul(0.6), life, progress).oneMinus() as F
  return { centre, progress, loose, axis, angle, size, round, fade }
}

/** A texture read of the raster at a UV. */
export type Read = (uv: V2) => V4

/** The raster as one texture under every read; `set` swaps in the canvas of a new raster. */
export interface Sheet {
  readonly read: Read
  set(canvas: HTMLCanvasElement): void
  dispose(): void
}

export function sheet(canvas: HTMLCanvasElement): Sheet {
  const make = (source: HTMLCanvasElement): Texture => {
    const map = new CanvasTexture(source)
    // Premultiplied, so mip levels and filtering do not darken edges.
    map.premultiplyAlpha = true
    return map
  }
  let current = make(canvas)
  const nodes: { value: Texture }[] = []
  return {
    read: (uv) => {
      const node = texture(current, uv)
      nodes.push(node as unknown as { value: Texture })
      return node as unknown as V4
    },
    set: (next) => {
      const old = current
      current = make(next)
      for (const textureNode of nodes) textureNode.value = current
      old.dispose()
    },
    dispose: () => current.dispose(),
  }
}

const GLYPH_BOX = 'dustBox'

/** One quad per piece of the raster, for the glyphs that have not come loose. */
export function pieces(layout: Raster): InstancedBufferGeometry {
  const box = new Float32Array(Math.max(1, layout.quads.length) * 4)
  layout.quads.forEach((quad, i) => {
    box.set([quad.x, quad.y, quad.width, quad.height], i * 4)
  })
  return instanced(layout.quads.length, { [GLYPH_BOX]: [box, 4] })
}

/**
 * The glyphs as drawn by the raster, each pixel kept while `keep` of its box point (px, y down)
 * is 1: pixel for pixel the text, as long as nothing has come loose.
 */
export function letters(
  layout: Raster,
  read: Read,
  half: V2,
  frame: V4,
  keep: (boxPoint: V2) => F,
  mask: (uv: V2) => F,
): Mesh {
  const box = attribute(GLYPH_BOX, 'vec4') as unknown as V4
  const corner = (positionGeometry.xy as unknown as V2).add(0.5) as V2
  const px = box.x.add(corner.x.mul(box.z))
  const py = box.y.add(corner.y.oneMinus().mul(box.w))
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  material.positionNode = vec3(px.sub(half.x), half.y.sub(py), 0)
  const uv = varying(
    vec2(px.sub(frame.x).div(frame.z), py.sub(frame.y).div(frame.w).oneMinus()),
  ) as V2
  const boxPoint = varying(vec2(px, py)) as V2
  const boxUV = varying(vec2(px.div(half.x.mul(2)), py.div(half.y.mul(2)).oneMinus())) as V2
  const texel = read(uv)
  const rgb = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as V3
  material.colorNode = vec4(rgb, texel.a.mul(keep(boxPoint)).mul(mask(boxUV.clamp(0, 1) as V2)))
  const mesh = new Mesh(pieces(layout), material)
  mesh.frustumCulled = false
  return mesh
}

/** Box UV of a point in the local space, for the mask. */
const boxUV = (p: V3, half: V2): V2 =>
  vec2(p.x.add(half.x).div(half.x.mul(2)), p.y.add(half.y).div(half.y.mul(2))).clamp(0, 1) as V2

/**
 * The grains: textured flakes of the glyphs as they come loose that tumble, shrink to round
 * grains, catch the light and blur with their distance from the page.
 */
export function grains(flight: Flight, read: Read, mask: (uv: V2) => F): MeshBasicNodeMaterial {
  const home = attribute(HOME, 'vec4') as unknown as V4
  const inkOf = attribute(INK, 'vec4') as unknown as V4
  const flake = grain(flight)
  const z = flake.centre.z
  const blur = abs(z).mul(BLUR)
  // Room for the blur and a pixel of smoothing around the flake.
  const extent = flake.size.add(blur.mul(2)).add(2).mul(flake.loose)
  const corner = positionGeometry.xy as unknown as V2
  const local = corner.mul(extent) as V2
  const offset = turn(vec3(local.x, local.y, 0) as V3, flake.axis, flake.angle)
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  material.positionNode = flake.centre.add(offset)
  // Shading of the flake, two-sided, divided so that a flake facing the viewer is as drawn.
  const facing = turn(vec3(0, 0, 1) as V3, flake.axis, flake.angle)
  const normal = select(facing.z.lessThan(0), facing.negate(), facing) as unknown as V3
  const light = vec3(...LIGHT)
  const lit = max(dot(normal, light), 0)
    .mul(1 - AMBIENT)
    .add(AMBIENT)
    .div(FLAT)
  const halfway = normalize(light.add(vec3(0, 0, 1)))
  // Dark ink glints less, so sand on a light page stays as dark as the text it came from.
  const inkLuma = dot(inkOf.xyz, vec3(0.2126, 0.7152, 0.0722))
  const glint = pow(max(dot(normal, halfway), 0), 60)
    .mul(mix(float(0.12), float(0.6), inkLuma.sqrt()))
    .mul(smoothstep(0.02, 0.12, flake.progress))
  const near = z.div(400).clamp(-1, 1)
  const shade = varying(lit.mul(near.max(0).mul(0.15).add(1))) as F
  const spark = varying(glint) as F
  // The flake's own pixels: its cell of the raster, in the raster's UV.
  const [frameX, frameY, frameWidth, frameHeight] = [
    flight.frame.x,
    flight.frame.y,
    flight.frame.z,
    flight.frame.w,
  ]
  const vLocal = varying(local) as V2
  const side = varying(flake.size) as F
  const soft = varying(blur) as F
  const centreUV = varying(
    vec2(home.x.sub(frameX).div(frameWidth), home.y.sub(frameY).div(frameHeight).oneMinus()),
  ) as V2
  const cellUV = varying(vec2(flight.cell.div(frameWidth), flight.cell.div(frameHeight))) as V2
  const texel = read(centreUV.add(vLocal.div(max(side, 1e-3)).mul(cellUV)) as V2)
  const flakeRGB = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as V3
  const inside = step(abs(vLocal.x), side.mul(0.5)).mul(step(abs(vLocal.y), side.mul(0.5)))
  const flakeA = texel.a.mul(inside)
  // The round grain: the mean colour of its piece, softer with depth.
  const discDistance = length(vLocal).sub(side.mul(0.5))
  const edge = max(fwidth(discDistance), soft.mul(2))
  const energy = side.mul(side).div(side.mul(side).add(soft.mul(soft).mul(2)))
  // A grain smaller than its cell is denser, so the sand keeps the weight of the ink.
  const cover = varying(
    min(
      home.w
        .mul(flight.cell.mul(flight.cell))
        .div(max(flake.size.mul(flake.size).mul(0.785), 1e-3)),
      1,
    ),
  ) as F
  const grainA = float(0.5)
    .sub(discDistance.div(max(edge, 1e-4)))
    .clamp(0, 1)
    .mul(cover)
    .mul(energy)
  const round = varying(flake.round) as F
  const rgb = mix(flakeRGB, varying(inkOf.xyz) as V3, round)
    .mul(shade)
    .add(vec3(1, 0.96, 0.88).mul(spark))
  const behind = varying(near.min(0).mul(0.6).add(1)) as F
  const alpha = varying(
    flake.fade.mul(flake.loose).mul(mask(boxUV(flake.centre, flight.half))),
  ) as F
  material.colorNode = vec4(rgb, mix(flakeA, grainA, round).mul(alpha).mul(behind).clamp(0, 1))
  return material
}

/** The shadow of the grains on the page: soft dots offset away from the light by their height. */
export function shadows(flight: Flight, mask: (uv: V2) => F): MeshBasicNodeMaterial {
  const home = attribute(HOME, 'vec4') as unknown as V4
  const flake = grain(flight)
  const z = max(flake.centre.z, 0)
  const spread = flake.size.add(z.mul(0.05))
  const extent = spread.add(z.mul(0.06)).add(2).mul(flake.loose)
  const corner = positionGeometry.xy as unknown as V2
  const local = corner.mul(extent) as V2
  const shadowAt = flake.centre.xy.add(
    vec2(-LIGHT[0] / LIGHT[2], -LIGHT[1] / LIGHT[2]).mul(z.mul(0.5)),
  )
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  material.positionNode = vec3(shadowAt.x.add(local.x), shadowAt.y.add(local.y), 0)
  const vLocal = varying(local) as V2
  const radius = varying(spread.mul(0.5)) as F
  const soft = varying(z.mul(0.03).add(0.5)) as F
  const discDistance = length(vLocal).sub(radius)
  const shape = float(0.5)
    .sub(discDistance.div(max(fwidth(discDistance), soft.mul(2))))
    .clamp(0, 1)
  // Lifted grains cast their shade; one on the page hides its own.
  // A grain high over the page casts a wide, faint shade: the same darkness spread wider.
  const spreadOut = flake.size.div(spread.add(z.mul(0.06)))
  // Light text mostly sits on a dark page, where a shadow only reads as a dark smudge.
  const inkOf = attribute(INK, 'vec4') as unknown as V4
  const inkLuma = dot(inkOf.xyz, vec3(0.2126, 0.7152, 0.0722)).sqrt()
  const strength = smoothstep(2, 40, z)
    .mul(spreadOut.mul(spreadOut).max(0.04))
    .mul(mix(float(1), float(0.3), inkLuma))
  const alpha = varying(
    flake.fade
      .mul(flake.loose)
      .mul(home.w)
      .mul(strength)
      .mul(flight.shadow)
      .mul(0.3)
      .mul(mask(boxUV(vec3(shadowAt.x, shadowAt.y, 0) as V3, flight.half))),
  ) as F
  material.colorNode = vec4(vec3(0, 0, 0), shape.mul(alpha))
  return material
}
