import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, ease, fresnel, inView, rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  Break,
  cameraPosition,
  cos,
  cross,
  dot,
  exp,
  Fn,
  float,
  frontFacing,
  fwidth,
  If,
  int,
  ivec2,
  Loop,
  length,
  log2,
  max,
  min,
  mix,
  modelWorldMatrix,
  mx_noise_vec3,
  normalize,
  positionGeometry,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sRGBTransferEOTF,
  texture,
  textureLoad,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  DoubleSide,
  FloatType,
  FrontSide,
  Group,
  type InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  type Node,
  RGBAFormat,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { emOf, instanced, pixels } from './points'
import { fonts, type Raster, raster, unsupported } from './raster'
import {
  CORNERS,
  type Cut,
  cut,
  type Flight,
  fadeOf,
  LIFE,
  launch,
  pose,
  type Strength,
  type Style,
  TEXELS,
} from './shards'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Trigger = 'click' | 'scroll' | 'hover' | 'view'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  pieces: number
  strength: number
  spin: number
  gravity: number
  depth: number
  hold: number
  seed: number
}

/** Most shards per tier. */
export const CAP = { low: 24, medium: 64, high: 140 } as const
/** Steps of the march through a stone shard, per tier. */
const STEPS = { low: 6, medium: 10, high: 14 } as const
/** Thickness of a shard at depth 1, em of the font size. */
export const THICK: Readonly<Record<Style, number>> = { glass: 0.06, stone: 0.15, paper: 0 }
/** Seconds of the fade that stands in for the break under reduced motion. */
export const CALM = 0.4
/** Seconds of physics a scrolled-out heading has flown, and gravity there. */
const SCROLL = { time: 1.25, fall: 0.3 } as const
/** The view trigger: seconds of physics the pieces fly back through, how long that takes, gravity. */
const VIEW = { time: 1.05, play: 1.5, fall: 0.35 } as const
/**
 * A click that comes back (`hold` > 0): thick air and light gravity keep the pieces near the box
 * (paper still flutters down), and the physics clock slows toward `time` so they hang there until
 * they fly back. Their speed scales with the font size over `em` px.
 */
const HELD = {
  drag: { glass: 8, stone: 8, paper: 4 },
  fall: { glass: 0.12, stone: 0.12, paper: 1 },
  time: 2.2,
  em: 160,
} as const
const heldTime = (clock: number): number => HELD.time * (1 - Math.exp(-clock / HELD.time))
const whole = (): number => 1
/** Scroll trigger: the break starts once the heading's top rises past this share of the viewport. */
const LINE = 0.3
/** Scroll trigger: the heading is whole once its top is above this share of the viewport. */
const ENTER = 0.62
/** View trigger: share of the heading in view that starts it. */
const THRESHOLD = 0.25
/** Light from the upper left, toward the viewer. */
const LIGHT = [-0.42, 0.6, 0.68] as const
const AMBIENT = 0.5
/** The page's up, for the reflections of glass. */
const UP = [0, 1, 0] as const
/** Hover: reach of the pointer and the springs of the pieces (stiffness, damping per second). */
const HOVER = { reach: 2.1, stiff: 170, damp: 2 * 0.38 * Math.sqrt(170), wave: 1400 } as const
/** Darkness of the shadows lifted pieces cast on the page. */
const SHADE = 0.3
/** Rings of cells around a click: their share of the cells and the first one's radius, em. */
const RINGS: Readonly<Record<Style, { rings: number; core: number }>> = {
  glass: { rings: 0.55, core: 0.16 },
  stone: { rings: 0.3, core: 0.34 },
  paper: { rings: 0.45, core: 0.22 },
}
/** Most dust motes of stone. */
const MOTES = 420

// Attribute names become WGSL and GLSL identifiers: camelCase never meets a keyword of either.
// `position` is the corner in the shard's own frame: x, y (up) from its pivot, and 0 on the face
// or 1 at the back.
/** The face normal in the shard's frame. */
const FACE = 'shardFace'
/** The pivot in box px, the shard's index and its size. */
const HOME = 'shardHome'
const DUST_FROM = 'moteFrom'
const DUST_WAY = 'moteWay'
const DUST_INK = 'moteInk'

/** Elements a click broke for good: they stay gone across rebuilds. */
const gone = new WeakSet<Element>()

const light = (): V3 => normalize(vec3(...LIGHT)) as V3
const unit = (v: readonly [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** The geometry of a cut: prisms of glass and stone, sheets of paper, and the caps that cast shadows. */
interface Shape {
  readonly geometry: BufferGeometry
  readonly caps: BufferGeometry
  /** Per shard: first index and count. */
  readonly ranges: Uint32Array
  /** The indices in shard order, to draw them back to front. */
  readonly index: Uint32Array
}

/** A shard's corners in its own frame: px from the pivot, y up, counterclockwise. */
export function corners(shard: Cut['shards'][number]): number[] {
  const out: number[] = []
  for (let k = 0; k < shard.poly.length; k += 2)
    out.push((shard.poly[k] as number) - shard.cx, shard.cy - (shard.poly[k + 1] as number))
  return out
}

/** Paper sheets are cut into this many rows per fan triangle, so they bend smoothly. */
const SHEET = 4

export function shape(pieces: Cut, style: Style): Shape {
  const pos: number[] = []
  const face: number[] = []
  const home: number[] = []
  const index: number[] = []
  const caps: number[] = []
  const ranges = new Uint32Array(Math.max(1, pieces.shards.length) * 2)
  pieces.shards.forEach((s, id) => {
    const start = index.length
    const poly = corners(s)
    const count = poly.length / 2
    const add = (
      x: number,
      y: number,
      layer: number,
      nx: number,
      ny: number,
      nz: number,
    ): number => {
      pos.push(x, y, layer)
      face.push(nx, ny, nz)
      home.push(s.cx, s.cy, id, s.size)
      return pos.length / 3 - 1
    }
    if (style === 'paper') {
      // A fan from the pivot, each triangle cut into a grid: the sheet bends between its corners.
      for (let k = 0; k < count; k++) {
        const bx = poly[k * 2] as number
        const by = poly[k * 2 + 1] as number
        const cx = poly[((k + 1) % count) * 2] as number
        const cy = poly[((k + 1) % count) * 2 + 1] as number
        const at: number[][] = []
        for (let i = 0; i <= SHEET; i++) {
          at.push([])
          for (let j = 0; j <= SHEET - i; j++)
            (at[i] as number[]).push(
              add((bx * i + cx * j) / SHEET, (by * i + cy * j) / SHEET, 0, 0, 0, 1),
            )
        }
        for (let i = 0; i < SHEET; i++)
          for (let j = 0; j < SHEET - i; j++) {
            const a = at[i]?.[j] as number
            const b = at[i + 1]?.[j] as number
            const d = at[i]?.[j + 1] as number
            index.push(a, b, d)
            caps.push(a, b, d)
            if (j < SHEET - i - 1) {
              const e = at[i + 1]?.[j + 1] as number
              index.push(b, e, d)
              caps.push(b, e, d)
            }
          }
      }
    } else {
      const front: number[] = []
      const back: number[] = []
      for (let k = 0; k < count; k++) {
        front.push(add(poly[k * 2] as number, poly[k * 2 + 1] as number, 0, 0, 0, 1))
        back.push(add(poly[k * 2] as number, poly[k * 2 + 1] as number, 1, 0, 0, -1))
      }
      for (let k = 1; k < count - 1; k++) {
        const f = [front[0], front[k], front[k + 1]] as number[]
        index.push(...f)
        caps.push(...f)
        index.push(back[0] as number, back[k + 1] as number, back[k] as number)
      }
      // The walls, facing out: counterclockwise corners have the outside on their right.
      for (let k = 0; k < count; k++) {
        const ax = poly[k * 2] as number
        const ay = poly[k * 2 + 1] as number
        const bx = poly[((k + 1) % count) * 2] as number
        const by = poly[((k + 1) % count) * 2 + 1] as number
        const l = Math.hypot(bx - ax, by - ay) || 1
        const nx = (by - ay) / l
        const ny = -(bx - ax) / l
        const i0 = add(ax, ay, 0, nx, ny, 0)
        const i1 = add(ax, ay, 1, nx, ny, 0)
        const i2 = add(bx, by, 1, nx, ny, 0)
        const i3 = add(bx, by, 0, nx, ny, 0)
        index.push(i0, i1, i2, i0, i2, i3)
      }
    }
    ranges[id * 2] = start
    ranges[id * 2 + 1] = index.length - start
  })
  const attributes = {
    position: new BufferAttribute(new Float32Array(pos.length ? pos : [0, 0, 0]), 3),
    [FACE]: new BufferAttribute(new Float32Array(face.length ? face : [0, 0, 1]), 3),
    [HOME]: new BufferAttribute(new Float32Array(home.length ? home : [0, 0, 0, 1]), 4),
  }
  const make = (list: number[]): BufferGeometry => {
    const geometry = new BufferGeometry()
    for (const [name, attr] of Object.entries(attributes)) geometry.setAttribute(name, attr)
    geometry.setIndex(new BufferAttribute(new Uint32Array(list), 1))
    return geometry
  }
  return { geometry: make(index), caps: make(caps), ranges, index: Uint32Array.from(index) }
}

/** The edges of each shard as half-planes in its own frame: unit normal out and offset. */
export function edges(
  c: Cut,
  rows: number,
  out: Float32Array<ArrayBuffer> = new Float32Array(CORNERS * 4 * rows),
): Float32Array<ArrayBuffer> {
  for (let i = 0; i < rows; i++) {
    const shard = c.shards[i]
    const poly = shard ? corners(shard) : []
    const count = poly.length / 2
    for (let k = 0; k < CORNERS; k++) {
      const offset = (i * CORNERS + k) * 4
      if (k >= count) {
        out.set([0, 0, 1e5, 0], offset)
        continue
      }
      const ax = poly[k * 2] as number
      const ay = poly[k * 2 + 1] as number
      const bx = poly[((k + 1) % count) * 2] as number
      const by = poly[((k + 1) % count) * 2 + 1] as number
      const l = Math.hypot(bx - ax, by - ay) || 1
      const nx = (by - ay) / l
      const ny = -(bx - ax) / l
      out.set([nx, ny, nx * ax + ny * ay, 0], offset)
    }
  }
  return out
}

/** A float texture of `width` x `rows` texels, read texel by texel. */
function table(data: Float32Array, width: number, rows: number): DataTexture {
  const map = new DataTexture(data, width, rows, RGBAFormat, FloatType)
  map.magFilter = map.minFilter = NearestFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/** Dust motes of stone: puffs that leave the cracks through the ink. */
function motes(
  c: Cut,
  f: Flight,
  alpha: (x: number, y: number) => number,
  em: number,
  seed: number,
): InstancedBufferGeometry {
  const random = rng(Math.round(seed) * 31 + 5)
  const from: number[] = []
  const way: number[] = []
  const ink: number[] = []
  const per = Math.max(2, Math.min(9, Math.floor(MOTES / Math.max(1, c.shards.length))))
  c.shards.forEach((s, i) => {
    const m = s.poly.length / 2
    for (let n = 0; n < per * 3 && from.length / 4 < MOTES; n++) {
      if (n >= per && from.length / 4 >= (i + 1) * per) break
      const k = Math.floor(random() * m)
      const t = random()
      const x = (s.poly[k * 2] as number) * (1 - t) + (s.poly[((k + 1) % m) * 2] as number) * t
      const y =
        (s.poly[k * 2 + 1] as number) * (1 - t) + (s.poly[((k + 1) % m) * 2 + 1] as number) * t
      if (alpha(x, y) < 0.3) continue
      const v = i * 4
      const out = Math.atan2(s.cy - y, x - s.cx)
      const speed = 60 + 160 * random()
      from.push(x, y, f.velocity[v + 3] as number, em * (0.018 + 0.035 * random()))
      way.push(
        Math.cos(out) * speed + (f.velocity[v] as number) * 0.22,
        Math.sin(out) * speed + (f.velocity[v + 1] as number) * 0.15 + 40,
        (f.velocity[v + 2] as number) * 0.3 + (random() - 0.3) * 120,
        0.8 + 0.9 * random(),
      )
      ink.push(s.color[0], s.color[1], s.color[2], random())
    }
  })
  const n = from.length / 4
  return instanced(n, {
    [DUST_FROM]: [new Float32Array(n ? from : [0, 0, 0, 0]), 4],
    [DUST_WAY]: [new Float32Array(n ? way : [0, 0, 0, 1]), 4],
    [DUST_INK]: [new Float32Array(n ? ink : [0, 0, 0, 0]), 4],
  })
}

/**
 * The heading breaks into 3D shards that fly apart, tumble and catch the light: thin panes of
 * glass with the text printed on them, thick chunks of stone with rough walls and a puff of dust,
 * or torn paper that flutters down. On a click from the point of impact, scrubbed as the heading
 * scrolls out, as a light crack under the pointer, or assembled from flying shards once in view.
 * At rest the element is plain DOM text.
 */
const shatter: Effect<Params> = defineEffect({
  name: 'shatter',
  params: {
    style: oneOf('glass', 'stone', 'paper'),
    trigger: oneOf('click', 'scroll', 'hover', 'view'),
    pieces: 40,
    strength: 1,
    spin: 1,
    gravity: 1,
    depth: 1,
    hold: 1.5,
    seed: 1,
  },
  rebuild: ['pieces', 'seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The pieces fly far past the box.
  bleed: 800,
  quality: { low: { pieces: 24 }, medium: { pieces: 64 } },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal, render } = ctx
    const { stage } = app
    const { trigger, style } = params
    const onScreen = (): boolean => {
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < stage.height.peek() &&
        rect.left < stage.width.peek()
      )
    }
    // As in text-reveal: a heading the visitor has seen as DOM does not vanish to fly in.
    const veiled = (): boolean => element.getAttribute('data-dio-state') === 'entering'
    let seen = onScreen() && !veiled()
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen && trigger === 'view') addEventListener('scroll', watch, { passive: true, signal })
    const warn = (reason: string): void => {
      if (DEV) app.log.warn(`shatter: ${reason}, the text stays as it is`, element)
    }
    const ratio = ctx.quality === 'low' ? 1 : 2
    const cap = CAP[ctx.quality]
    const steps = STEPS[ctx.quality]
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    seen ||= trigger === 'view' && onScreen() && !veiled()
    let image = layout ? pixels(layout) : undefined
    const camera = (): number => render.camera.position.z || 1000
    const cutOf = (r: Raster, img: ImageData | undefined, impact?: [number, number]): Cut =>
      cut(r, img, {
        pieces: Math.min(cap, params.pieces),
        seed: params.seed,
        em: emOf(r),
        trim: style !== 'glass',
        impact,
        ...RINGS[style],
      })
    const first = layout ? cutOf(layout, image) : undefined
    if (!layout || !first?.shards.length) {
      if (reason) warn(`${reason} cannot be drawn`)
      ctx.showDom(true)
      return
    }
    let pane: Cut = first
    let em = emOf(layout)
    const middle = (c: Cut): [number, number] => [
      (c.bounds[0] + c.bounds[2]) / 2,
      (c.bounds[1] + c.bounds[3]) / 2,
    ]
    const aim = (c: Cut, origin: [number, number]): Flight =>
      launch(c, origin, style, em, camera() * 0.4, params.seed)
    let flight = aim(pane, middle(pane))

    // Per shard: offset and how far it came loose, its turn, its bend and alpha.
    const state = new Float32Array(cap * TEXELS * 4)
    const stateMap = table(state, TEXELS, cap)
    const edgeData = edges(pane, cap)
    const edgeMap = table(edgeData, CORNERS, cap)
    ctx.onDispose(() => {
      stateMap.dispose()
      edgeMap.dispose()
    })

    const frame = uniform(new Vector4(...layout.frame))
    const texel = uniform(layout.canvas.width / (layout.frame[2] || 1))
    const thick = uniform(THICK[style] * em * Math.max(0, params.depth))
    // 0..1: everything fades under reduced motion, 1 otherwise.
    const fade = uniform(1)
    const ink = texture(atlas(layout))
    ink.mergeable = false
    ctx.onDispose(() => (ink.value as Texture).dispose())
    const half = u.size.mul(0.5) as unknown as V2
    const frameNode = frame as unknown as V4

    // The pose of the shard a vertex belongs to.
    const home = attribute(HOME, 'vec4') as unknown as V4
    const faceAttr = attribute(FACE, 'vec3') as unknown as V3
    const row = int(home.z.add(0.5))
    const state0 = textureLoad(stateMap, ivec2(int(0), row)) as unknown as V4
    const state1 = textureLoad(stateMap, ivec2(int(1), row)) as unknown as V4
    const state2 = textureLoad(stateMap, ivec2(int(2), row)) as unknown as V4
    const turn = (q: V4, v: V3): V3 =>
      v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2)) as V3
    const unturn = (q: V4, v: V3): V3 => turn(vec4(q.xyz.negate(), q.w) as V4, v)
    const depth = (thick as unknown as F).mul(state0.w) as F
    const corner = positionGeometry as unknown as V3
    let local = vec3(corner.x, corner.y, corner.z.mul(depth).negate()) as V3
    let normal = faceAttr
    if (style === 'paper') {
      // A sheet bent around an axis through its pivot.
      const axis = vec2(cos(state2.y), sin(state2.y))
      const along = dot(corner.xy, axis)
      local = vec3(corner.x, corner.y, state2.x.mul(0.5).mul(along).mul(along)) as V3
      normal = normalize(vec3(axis.mul(state2.x.mul(along)).negate(), 1)) as V3
    }
    const pivot = vec3(0, 0, depth.mul(-0.5))
    const placed = vec3(home.x.sub(half.x), half.y.sub(home.y), 0)
      .add(state0.xyz)
      .add(turn(state1, local.sub(pivot)).add(pivot)) as V3
    const world = modelWorldMatrix.mul(vec4(placed, 1)).xyz
    const vLocal = varying(local) as V3
    const vRay = varying(unturn(state1, world.sub(cameraPosition) as V3)) as V3
    const vFace = varying(normal) as V3
    const vHome = varying(home) as V4
    const vThick = varying(depth) as F
    const vLoose = varying(state0.w) as F
    const vAlpha = varying(state2.z) as F
    const vLight = varying(unturn(state1, light())) as V3
    const vUp = varying(unturn(state1, vec3(...UP) as V3)) as V3

    /** Box px of a point of the shard's frame. */
    const boxOf = (q: V2): V2 => vec2(vHome.x.add(q.x), vHome.y.sub(q.y)) as V2
    const uvOf = (q: V2): V2 => {
      const bounds = boxOf(q)
      return vec2(
        bounds.x.sub(frameNode.x).div(frameNode.z),
        bounds.y.sub(frameNode.y).div(frameNode.w).oneMinus(),
      ) as V2
    }
    const read = (q: V2, level: F): V4 => texture(ink, uvOf(q), level) as unknown as V4
    const inkA = (q: V2, level: F): F => read(q, level).a as unknown as F
    const colorOf = (c: V4): V3 => sRGBTransferEOTF(c.rgb.div(max(c.a, 1e-4)) as never) as V3
    const luma = (c: V3): F => dot(c, vec3(0.2126, 0.7152, 0.0722)) as F
    // The element's own alpha mask at the shard's home: opacity, presence, clips of ancestors.
    const mask = ctx.mask(
      vec2(vHome.x.div(u.size.x), vHome.y.div(u.size.y).oneMinus()).clamp(0, 1) as V2,
    )
    const norm = AMBIENT + (1 - AMBIENT) * unit(LIGHT)[2]
    const lit = (n: V3, L: V3): F =>
      max(dot(n, L), 0)
        .mul(1 - AMBIENT)
        .add(AMBIENT)
        .div(norm) as F

    const colorNode = Fn(() => {
      const point = vLocal
      const ray = normalize(vRay).toVar()
      const toEye = ray.negate()
      const toLight = normalize(vLight)
      const at = boxOf(point.xy)
      // The mip level of the raster on screen, before any loop: derivatives need uniform flow.
      const lod = max(
        log2(max(max(fwidth(at.x), fwidth(at.y)).mul(texel), 1e-4)).sub(0.5),
        0,
      ).toVar()
      const id = int(vHome.z.add(0.5))
      // Where the ray leaves the prism, and the nearest edge of the polygon to where it enters.
      const exit = float(1e5).toVar()
      If(ray.z.greaterThan(1e-5), () => {
        exit.assign(min(exit, point.z.negate().div(ray.z)))
      })
      If(ray.z.lessThan(-1e-5), () => {
        exit.assign(min(exit, vThick.negate().sub(point.z).div(ray.z)))
      })
      const edge = float(1e5).toVar()
      const outward = vec2(0, 1).toVar()
      Loop({ start: int(0), end: int(CORNERS), type: 'int', condition: '<' }, ({ i }) => {
        const e = textureLoad(edgeMap, ivec2(i, id)) as unknown as V4
        const toward = dot(e.xy, ray.xy)
        const room = e.z.sub(dot(e.xy, point.xy))
        If(toward.greaterThan(1e-5), () => {
          exit.assign(min(exit, room.div(toward)))
        })
        If(room.lessThan(edge), () => {
          edge.assign(room)
          outward.assign(e.xy)
        })
      })
      exit.assign(max(exit, 0))
      const loose = vLoose
      const halfway = normalize(toLight.add(toEye))
      // A bevel along the cut edges of the faces: the glint that runs along a turning shard.
      const capFace = abs(vFace.z).greaterThan(0.5)
      const bevel = smoothstep(2.2, 0, edge)
        .mul(loose)
        .mul(select(capFace, 1, 0))
      const beveled = (n: V3): V3 =>
        normalize(n.add(vec3(outward.mul(bevel.mul(1.3)), 0))) as unknown as V3

      if (style === 'glass') {
        const normal = beveled(vFace)
        const cosT = abs(dot(normal, toEye))
        const reflectance = fresnel(cosT, 0.04)
        const reflected = reflect(ray, normal)
        const sky = mix(
          vec3(0.05, 0.06, 0.08),
          vec3(0.92, 0.95, 1),
          smoothstep(-0.25, 0.75, dot(reflected, vUp)),
        )
        const sun = pow(max(dot(reflected, toLight), 0), 180).mul(3)
        const env = sky.add(sun)
        // Light lost along the way through the glass: green-blue, much more seen edge-on.
        const absorb = vec3(1).sub(exp(vec3(0.022, 0.008, 0.012).mul(exit).negate()))
        const dim = absorb.x.add(absorb.y).add(absorb.z).div(3)
        const glassA = reflectance.mul(0.85).add(dim.mul(0.8)).clamp(0, 0.95).mul(loose)
        const tint = vec3(0.06, 0.2, 0.16)
        const glass = env.mul(reflectance).add(tint.mul(dim)).mul(loose)
        // The text is printed on the front: met there, or seen through the glass from behind.
        const front = vFace.z.greaterThan(0.5)
        const through = select(ray.z.greaterThan(1e-5), point.z.negate().div(ray.z), float(-1))
        const sees = front.or(through.greaterThanEqual(0).and(through.lessThanEqual(exit)))
        const q = select(front, point.xy, point.xy.add(ray.xy.mul(max(through, 0))))
        const texel = read(q as V2, lod)
        const inkAlpha = texel.a.mul(select(sees, 1, 0))
        const flat = vec3(0, 0, 1) as unknown as V3
        const shown = colorOf(texel)
          .mul(select(front, lit(beveled(flat), toLight), float(0.8)))
          .mul(select(front, vec3(1), vec3(1).sub(absorb.mul(0.8))))
        const spec = pow(max(dot(normal, halfway), 0), 90)
          .mul(1.4)
          .add(bevel.mul(pow(max(dot(normal, halfway), 0), 12)).mul(0.9))
          .mul(loose)
        const premult = shown.mul(inkAlpha).add(glass.mul(inkAlpha.oneMinus())).add(vec3(spec))
        const alpha = inkAlpha.add(glassA.mul(inkAlpha.oneMinus())).add(spec.mul(0.6)).clamp(0, 1)
        return vec4(premult.div(max(alpha, 1e-4)), alpha.mul(vAlpha).mul(fade).mul(mask))
      }

      if (style === 'paper') {
        // Torn edges: the cut runs ragged through the letters, with pale fibres along it.
        const rough = mx_noise_vec3(vec3(point.xy.mul(0.32), vHome.z.mul(3.7))).x
        const torn = edge.sub(rough.mul(1.6).add(1.1).mul(loose))
        const keep = mix(float(1), torn.add(0.5).clamp(0, 1), loose)
        const fibre = smoothstep(1.6, 0, torn).mul(loose)
        const texel = read(point.xy, lod)
        const paper = vec3(0.86, 0.83, 0.76)
        const n = normalize(select(frontFacing, vFace, vFace.negate()))
        // Thin paper lets light through: its back never goes dark.
        const shade = select(frontFacing, lit(n as V3, toLight), max(lit(n as V3, toLight), 0.82))
        const face = mix(colorOf(texel), paper, fibre.mul(0.85))
        const backside = mix(paper, colorOf(texel), 0.1)
        const rgb = select(frontFacing, face, backside).mul(shade)
        const spec = pow(max(dot(n, halfway), 0), 24)
          .mul(0.12)
          .mul(loose)
        return vec4(rgb.add(spec), texel.a.mul(keep).mul(vAlpha).mul(fade).mul(mask))
      }

      // Stone: march through the slab to the first ink, so the walls are the letters' own.
      const hit = float(-1).toVar()
      const peak = float(0).toVar()
      const lastA = float(0).toVar()
      const lastT = float(0).toVar()
      Loop({ start: int(0), end: int(steps), type: 'int', condition: '<' }, ({ i }) => {
        const along = exit.mul(float(i).div(steps - 1))
        const alpha = inkA(point.xy.add(ray.xy.mul(along)) as V2, lod)
        peak.assign(max(peak, alpha))
        If(alpha.greaterThanEqual(0.5), () => {
          const k = float(0.5)
            .sub(lastA)
            .div(max(alpha.sub(lastA), 1e-4))
            .clamp(0, 1)
          hit.assign(select(i.greaterThan(int(0)), mix(lastT, along, k), float(0)))
          Break()
        })
        lastA.assign(alpha)
        lastT.assign(along)
      })
      const deep = hit.greaterThan(1e-3)
      const hitPoint = point.add(ray.mul(max(hit, 0)))
      const hitTexel = read(hitPoint.xy, lod)
      const rgb = colorOf(hitTexel)
      // The wall of a letter faces out of its ink: the gradient of a blurred coverage.
      const h = float(1)
      const soft = lod.add(1)
      const g = vec2(
        inkA(hitPoint.xy.add(vec2(h, 0)) as V2, soft).sub(
          inkA(hitPoint.xy.sub(vec2(h, 0)) as V2, soft),
        ),
        inkA(hitPoint.xy.add(vec2(0, h)) as V2, soft).sub(
          inkA(hitPoint.xy.sub(vec2(0, h)) as V2, soft),
        ),
      )
      const wall = normalize(vec3(g.negate().add(vec2(1e-5, 0)), 0))
      let n = select(deep, wall, beveled(vFace)) as unknown as V3
      // Rough broken stone on the walls, smooth on the face.
      const side = float(1).sub(abs(n.z))
      const grit = mx_noise_vec3(hitPoint.mul(0.28).add(vHome.z.mul(5.3)))
      n = normalize(n.add(grit.mul(side.mul(0.42)))) as unknown as V3
      const body = select(luma(rgb).greaterThan(0.035), rgb, mix(rgb, vec3(1), 0.14))
      const pit = grit.x.mul(0.18).add(0.82)
      const rear = vFace.z.lessThan(-0.5).and(deep.not())
      const tone = select(
        deep.or(abs(vFace.z).lessThan(0.5)),
        body.mul(0.78).mul(pit),
        select(rear, body.mul(0.86), rgb),
      )
      const spec = pow(max(dot(n, halfway), 0), 16)
        .mul(0.16)
        .add(bevel.mul(pow(max(dot(n, halfway), 0), 10)).mul(0.5))
        .mul(loose)
      const alpha = select(deep, float(1), peak)
      return vec4(tone.mul(lit(n, toLight)).add(vec3(spec)), alpha.mul(vAlpha).mul(fade).mul(mask))
    })() as unknown as V4

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: style === 'paper' ? DoubleSide : FrontSide,
    })
    material.forceSinglePass = true
    material.positionNode = placed
    material.colorNode = colorNode

    // The shadows: the faces projected on the page along the light, softer the higher they are.
    const lightDir = unit(LIGHT)
    const lift = max(placed.z, 0)
    const shadowMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    shadowMaterial.positionNode = vec3(
      placed.x.sub(lift.mul(lightDir[0] / lightDir[2])),
      placed.y.sub(lift.mul(lightDir[1] / lightDir[2])),
      0,
    )
    const height = varying(lift) as F
    const blur = log2(height.mul(0.06).mul(texel).add(1))
    const shadowA = read(vLocal.xy, blur.add(0.5))
      .a.mul(smoothstep(0, 8, height))
      .mul(float(1).sub(smoothstep(80, 700, height)))
      .mul(SHADE * (style === 'glass' ? 0.5 : 1))
      .mul(vLoose)
      .mul(vAlpha)
      .mul(fade)
      .mul(mask)
    shadowMaterial.colorNode = vec4(0.02, 0.02, 0.035, shadowA)

    let shape0 = shape(pane, style)
    const shards = new Mesh(shape0.geometry, material)
    const shadows = new Mesh(shape0.caps, shadowMaterial)
    for (const mesh of [shards, shadows]) mesh.frustumCulled = false
    shadows.renderOrder = 0
    shards.renderOrder = 1
    const group = new Group()
    group.add(shadows, shards)

    // Stone breaks with a puff of dust from its cracks.
    const dustTime = uniform(0)
    let dust: Mesh | undefined
    const alphaAt = (x: number, y: number): number => {
      const r = layout
      if (!image || !r) return 0
      const column = Math.floor((x - r.frame[0]) * (image.width / r.frame[2]))
      const row = Math.floor((y - r.frame[1]) * (image.height / r.frame[3]))
      if (column < 0 || row < 0 || column >= image.width || row >= image.height) return 0
      return (image.data[(row * image.width + column) * 4 + 3] as number) / 255
    }
    if (style === 'stone' && ctx.quality !== 'low') {
      const from = attribute(DUST_FROM, 'vec4') as unknown as V4
      const way = attribute(DUST_WAY, 'vec4') as unknown as V4
      const tint = attribute(DUST_INK, 'vec4') as unknown as V4
      const age = max(dustTime.sub(from.z), 0)
      const drift = float(1)
        .sub(exp(age.mul(-2.4)))
        .div(2.4)
      const force = max(u.strength, 0)
      const size = from.w.mul(age.mul(2.6).add(1))
      const centre = vec3(from.x.sub(half.x), half.y.sub(from.y), 0)
        .add(way.xyz.mul(drift).mul(force))
        .add(vec3(0, age.mul(age).mul(-30), 0))
      const quad = positionGeometry.xy as unknown as V2
      const dustMaterial = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      dustMaterial.positionNode = centre.add(vec3(quad.mul(size.mul(2)), 0))
      const radius = length(varying(quad).mul(2))
      const life = way.w
      const show = smoothstep(0, 0.05, age)
        .mul(float(1).sub(smoothstep(life.mul(0.3), life, age)))
        .mul(select(dustTime.greaterThan(from.z), 0.24, 0))
      const color = mix(tint.xyz, vec3(0.8, 0.77, 0.72), 0.55)
      const own = ctx.mask(
        vec2(from.x.div(u.size.x), from.y.div(u.size.y).oneMinus()).clamp(0, 1) as V2,
      )
      dustMaterial.colorNode = vec4(
        varying(color),
        float(1)
          .sub(smoothstep(0.15, 1, radius))
          .mul(varying(show))
          .mul(fade)
          .mul(own),
      )
      dust = new Mesh(motes(pane, flight, alphaAt, em, params.seed), dustMaterial)
      dust.frustumCulled = false
      dust.renderOrder = 2
      group.add(dust)
    }

    const sorted = new Uint32Array(shape0.index.length)
    let count = pane.shards.length
    const use = (c: Cut, fl: Flight): void => {
      pane = c
      flight = fl
      count = c.shards.length
      const old = shape0
      shape0 = shape(c, style)
      shards.geometry = shape0.geometry
      shadows.geometry = shape0.caps
      old.geometry.dispose()
      old.caps.dispose()
      edges(c, cap, edgeData)
      edgeMap.needsUpdate = true
      if (dust) {
        const was = dust.geometry
        dust.geometry = motes(c, fl, alphaAt, em, params.seed)
        was.dispose()
      }
      order = []
    }
    ctx.onDispose(() => {
      shape0.geometry.dispose()
      shape0.caps.dispose()
    })
    // Placed before any showDom, which hides the replace object.
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    // Draw order: farthest shard from the camera first.
    let order: number[] = []
    const depthOrder = (input: { x: number; y: number; width: number; height: number }): void => {
      const cam = render.camera.position
      const viewportWidth = stage.width.peek()
      const viewport = stage.height.peek()
      const offsetX = input.x + input.width / 2 - viewportWidth / 2
      const offsetY = viewport / 2 - input.y - input.height / 2
      const far = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const shard = pane.shards[i]
        if (!shard) continue
        const offset = i * TEXELS * 4
        const x = offsetX + shard.cx - input.width / 2 + (state[offset] as number) - cam.x
        const y = offsetY + input.height / 2 - shard.cy + (state[offset + 1] as number) - cam.y
        const z = (state[offset + 2] as number) - cam.z
        far[i] = x * x + y * y + z * z
      }
      const next = Array.from({ length: count }, (_, i) => i).sort(
        (a, b) => (far[b] as number) - (far[a] as number),
      )
      if (next.length === order.length && next.every((v, i) => v === order[i])) return
      order = next
      const out =
        sorted.length >= shape0.index.length ? sorted : new Uint32Array(shape0.index.length)
      let at = 0
      for (const i of next) {
        const start = shape0.ranges[i * 2] as number
        const n = shape0.ranges[i * 2 + 1] as number
        out.set(shape0.index.subarray(start, start + n), at)
        at += n
      }
      const attr = shape0.geometry.index as BufferAttribute
      ;(attr.array as Uint32Array).set(out.subarray(0, at))
      attr.needsUpdate = true
    }

    /** Every shard at rest: the face where the DOM text is. */
    const rest = (): void => {
      state.fill(0)
      for (let i = 0; i < cap; i++) {
        const offset = i * TEXELS * 4
        state[offset + 7] = 1
        state[offset + 10] = 1
      }
      stateMap.needsUpdate = true
    }
    rest()

    const strength = (fall: number, drag = 1, scale = 1): Strength => ({
      force: ctx.params.strength * scale,
      spin: ctx.params.spin,
      gravity: ctx.params.gravity * fall,
      drag,
    })
    /** Poses every shard `time` s after the break; `alpha` fades them by their own time. */
    const fly = (time: number, k: Strength, alpha: (own: number) => number): void => {
      const reach = camera() * 0.45
      for (let i = 0; i < count; i++) {
        const shard = pane.shards[i]
        if (!shard) continue
        pose(state, i, flight, time, style, shard.size, em, k)
        const offset = i * TEXELS * 4
        state[offset + 2] = Math.min(state[offset + 2] as number, reach)
        state[offset + 10] = alpha(Math.max(0, time - (flight.velocity[i * 4 + 3] as number)))
      }
      stateMap.needsUpdate = true
      dustTime.value = time
    }

    let dom = true
    const show = (value: boolean): void => {
      dom = value
      ctx.showDom(value)
    }
    let done = gone.has(element)
    group.visible = !done
    show(!done && trigger !== 'view')
    if (done) element.setAttribute('data-dio-shatter', 'gone')
    ctx.onDispose(() => {
      if (!gone.has(element)) element.removeAttribute('data-dio-shatter')
    })
    if (trigger === 'view' && seen) show(true)

    // Raster again when the text, its fonts or its width change, like text-reveal.
    let cancel: (() => void) | undefined
    let stuck: string | undefined
    let still = (): boolean => true
    // Pieces move on their own, so the update asks for frames.
    let playing = false
    const redo = async (): Promise<void> => {
      cancel = undefined
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(`${why} cannot be drawn`)
      stuck = why
      if (why) {
        playing = false
        ctx.invalidate()
        return
      }
      if (!still()) {
        schedule()
        return
      }
      const next = raster(element, 'line', ratio)
      const img = next && pixels(next)
      const c = next && cutOf(next, img)
      if (!next || !c?.shards.length) return
      layout = next
      image = img
      em = emOf(next)
      const old = ink.value as Texture
      ink.value = atlas(next)
      old.dispose()
      frame.value.set(...next.frame)
      texel.value = next.canvas.width / (next.frame[2] || 1)
      use(c, aim(c, middle(c)))
      rest()
      ctx.invalidate()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(() => void redo(), { timeout: 1000 })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(() => void redo(), 150)
        cancel = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => cancel?.())
    const text = new MutationObserver(schedule)
    text.observe(element, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => text.disconnect())
    const resize = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width
      if (Math.abs(width - (layout?.width ?? width)) > 0.5) schedule()
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // The click trigger's clock: where it is in the break, the wait and the way back.
    type Phase = 'rest' | 'break' | 'back' | 'gone' | 'wait' | 'in'
    let phase: Phase = done ? 'gone' : trigger === 'view' && !seen ? 'wait' : 'rest'
    let clock = 0
    // The physics time the way back starts from, and how long it takes.
    let from = 0
    let back = 1
    const latest = (): number => {
      let m = 0
      for (let i = 0; i < count; i++) m = Math.max(m, flight.velocity[i * 4 + 3] as number)
      return m
    }
    still = () => phase === 'rest' || phase === 'wait' || phase === 'gone'

    const strike = (x?: number, y?: number): void => {
      if (phase !== 'rest' || done || stuck || !layout) return
      const box = element.getBoundingClientRect()
      const impact: [number, number] =
        x === undefined || y === undefined ? middle(pane) : [x - box.left, y - box.top]
      if (!ctx.input.reducedMotion) {
        const pieces = cutOf(layout, image, impact)
        if (pieces.shards.length) use(pieces, aim(pieces, impact))
      }
      phase = 'break'
      clock = 0
      element.setAttribute('data-dio-shatter', 'broken')
      playing = true
      ctx.invalidate()
    }
    if (trigger === 'click') {
      element.addEventListener(
        'click',
        (e) => {
          const mouse = e as MouseEvent
          // A keyboard click has no point: it breaks from the middle.
          if (mouse.detail === 0) strike()
          else strike(mouse.clientX, mouse.clientY)
        },
        { signal },
      )
      element.addEventListener(
        'keydown',
        (e) => {
          const key = (e as KeyboardEvent).key
          // Buttons and links click on Enter themselves.
          if (key === 'Enter' && e.target === element && !element.matches('button, a[href]'))
            strike()
        },
        { signal },
      )
    }

    // Hover: a spring per shard for how far it lifts, and the pointer in client px.
    let lifted = new Float32Array(count)
    let speed = new Float32Array(count)
    let rung = new Uint8Array(count)
    const pointer = { x: 0, y: 0, on: false, touch: -1, wave: -1 }
    let near = { x: 0, y: 0, width: 0, height: 0 }
    if (trigger === 'hover') {
      const wake = (): void => {
        const reach = em * HOVER.reach
        const { x, y } = pointer
        if (
          x > near.x - reach &&
          x < near.x + near.width + reach &&
          y > near.y - reach &&
          y < near.y + near.height + reach
        ) {
          if (pointer.wave < 0) pointer.wave = 0
          playing = true
          ctx.invalidate()
        } else pointer.wave = -1
      }
      const move = (e: PointerEvent): void => {
        if (e.pointerType === 'touch' && e.pointerId !== pointer.touch) return
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.on = true
        wake()
      }
      const lift = (e: PointerEvent): void => {
        if (e.pointerType === 'touch' && e.pointerId !== pointer.touch) return
        pointer.touch = -1
        pointer.on = false
        pointer.wave = -1
        playing = true
        ctx.invalidate()
      }
      addEventListener('pointermove', move, { passive: true, signal })
      element.addEventListener(
        'pointerdown',
        (e) => {
          const pointerEvent = e as PointerEvent
          if (pointerEvent.pointerType !== 'touch') return
          pointer.touch = pointerEvent.pointerId
          pointer.wave = -1
          move(pointerEvent)
        },
        { passive: true, signal },
      )
      addEventListener('pointerup', lift, { passive: true, signal })
      addEventListener('pointercancel', lift, { passive: true, signal })
      document.documentElement.addEventListener(
        'pointerleave',
        (e) => (e as PointerEvent).pointerType !== 'touch' && lift(e as PointerEvent),
        { signal },
      )
      addEventListener('blur', () => lift(new PointerEvent('pointerup')), { signal })
    }

    /** Steps the hover springs and poses the shards; true while any of them moves. */
    const hover = (input: { x: number; y: number }, delta: number): boolean => {
      if (lifted.length !== count) {
        lifted = new Float32Array(count)
        speed = new Float32Array(count)
        rung = new Uint8Array(count)
      }
      const live = ctx.params
      const reach = em * HOVER.reach
      if (pointer.wave < 0) rung.fill(0)
      const pointerX = pointer.x - input.x
      const pointerY = pointer.y - input.y
      const dt = Math.min(Math.max(delta, 0), 1 / 20)
      if (pointer.wave >= 0) pointer.wave += dt
      const front = pointer.wave * HOVER.wave
      const steps = Math.max(1, Math.ceil(dt * 120))
      const step = dt / steps
      let moving = false
      for (let i = 0; i < count; i++) {
        const shard = pane.shards[i]
        if (!shard) continue
        const dx = shard.cx - pointerX
        const dy = shard.cy - pointerY
        const dist = Math.hypot(dx, dy)
        let goal = 0
        if (pointer.on) {
          const k = Math.max(0, 1 - dist / reach)
          goal = k * k * (3 - 2 * k)
          // A ring that runs out from where the pointer came in: each shard jumps as it passes.
          if (!rung[i] && pointer.wave >= 0 && front >= dist) {
            rung[i] = 1
            speed[i] = (speed[i] as number) + 7 * Math.max(0, 1 - dist / (reach * 3))
          }
        } else rung[i] = 0
        let x = lifted[i] as number
        let velocity = speed[i] as number
        if (Math.abs(goal - x) < 1e-3 && Math.abs(velocity) < 1e-3) {
          x = goal
          velocity = 0
        } else {
          for (let n = 0; n < steps; n++) {
            velocity += (HOVER.stiff * (goal - x) - HOVER.damp * velocity) * step
            x += velocity * step
          }
          moving = true
        }
        lifted[i] = x
        speed[i] = velocity
        // Up toward the viewer and a little apart, tilted with the near edge up.
        const offset = i * TEXELS * 4
        const l = Math.max(0, x)
        const ux = dist > 1e-3 ? dx / dist : 0
        const uy = dist > 1e-3 ? -dy / dist : 0
        const force = Math.max(0, live.strength)
        state[offset] = ux * em * 0.07 * force * l
        state[offset + 1] = uy * em * 0.07 * force * l
        state[offset + 2] = em * 0.32 * force * x
        state[offset + 3] = Math.min(1, Math.abs(x) * 4)
        const angle = 0.32 * Math.max(0, live.spin) * x
        const halfSin = Math.sin(angle / 2)
        state.set([-uy * halfSin, ux * halfSin, 0, Math.cos(angle / 2), 0, 0, 1, 0], offset + 4)
      }
      stateMap.needsUpdate = true
      return moving
    }

    return (input): boolean => {
      const live = ctx.params
      const reduced = input.reducedMotion
      near = input
      thick.value = THICK[style] * em * Math.max(0, live.depth)
      fade.value = 1
      if (stuck || (reduced && trigger !== 'click')) {
        playing = false
        group.visible = !done
        show(!done)
        return playing
      }
      const viewport = stage.height.peek()
      if (trigger === 'scroll') {
        // Gathers as the heading rises from the bottom, breaks as it leaves the top.
        const top = input.y + (typeof scrollY === 'number' ? scrollY : 0)
        const line = Math.max(0, Math.min(viewport * LINE, top - 1))
        const leaving = Math.min(
          1,
          Math.max(0, (line - input.y) / (line + input.height * 0.5 || 1)),
        )
        if (seen && (input.y > viewport || input.y + input.height < 0)) seen = false
        const entering = seen
          ? 0
          : Math.min(1, Math.max(0, (input.y - viewport * ENTER) / (viewport * (1 - ENTER) || 1)))
        const b = Math.max(leaving, entering)
        if (b > 0) {
          // Slow to start: a scroll in shows cracks and drifting pieces before they scatter.
          fly(b ** 1.6 * SCROLL.time, strength(SCROLL.fall), () => 1 - smooth(0.72, 1, b))
          depthOrder(input)
        } else rest()
        show(b <= 0 && input.presence >= 1)
        return playing
      }
      if (trigger === 'hover') {
        const moving = hover(input, input.delta)
        depthOrder(input)
        playing = moving
        let idle = true
        for (let i = 0; i < count && idle; i++) idle = lifted[i] === 0
        show(idle)
        return playing
      }
      if (trigger === 'view') {
        if (phase === 'wait') {
          if (seen) {
            phase = 'rest'
          } else {
            if (inView(input.y, input.height, viewport, THRESHOLD)) {
              phase = 'in'
              clock = 0
              playing = true
            }
          }
        }
        if (phase === 'in') {
          clock += input.delta
          const k = clock / VIEW.play
          const time = VIEW.time * (1 - ease('quartOut', k))
          fly(time, strength(VIEW.fall), () => 1 - smooth(0.55, 1, time / VIEW.time))
          depthOrder(input)
          if (k >= 1) {
            phase = 'rest'
            rest()
            playing = false
          }
        }
        if (phase === 'wait') fly(VIEW.time, strength(VIEW.fall), () => 0)
        show(phase === 'rest' && input.presence >= 1)
        return playing
      }

      // Click.
      if (phase === 'break' || phase === 'back') clock += input.delta
      // Held pieces travel in em: small type does not throw them across the page.
      const size = Math.min(1.5, Math.max(0.2, em / HELD.em))
      const held = strength(HELD.fall[style] * size, HELD.drag[style], size)
      const hold = Math.max(0, live.hold)
      const life = latest() + LIFE[style]
      if (reduced) {
        // A fade instead of the flight: out, and back in after `hold`.
        rest()
        if (phase === 'break') {
          fade.value = Math.max(0, 1 - clock / CALM)
          if (hold > 0 && clock >= hold) {
            phase = 'back'
            clock = 0
          } else if (hold <= 0 && clock >= CALM) finish()
        } else if (phase === 'back') {
          fade.value = Math.min(1, clock / CALM)
          if (clock >= CALM) settle()
        }
      } else if (phase === 'break' && hold > 0) {
        fly(heldTime(clock), held, whole)
        depthOrder(input)
        if (clock >= hold) {
          phase = 'back'
          from = heldTime(clock)
          back = Math.min(1.3, 0.6 + 0.25 * from)
          clock = 0
        }
      } else if (phase === 'break') {
        fly(Math.min(clock, life), strength(1), (own) => fadeOf(style, own))
        depthOrder(input)
        if (clock >= life) finish()
      } else if (phase === 'back') {
        // Time runs backward: the pieces fly back along their own paths and lock in place.
        const k = clock / back
        fly(from * (1 - ease('cubicInOut', k)), held, whole)
        depthOrder(input)
        if (k >= 1) settle()
      }
      group.visible = !done
      show(phase === 'rest' && !done && input.presence >= 1)
      return playing
    }

    function finish(): void {
      phase = 'gone'
      done = true
      gone.add(element)
      playing = false
      group.visible = false
      element.setAttribute('data-dio-shatter', 'gone')
      element.dispatchEvent(new CustomEvent('dio:shatter', { bubbles: true }))
    }
    function settle(): void {
      phase = 'rest'
      rest()
      playing = false
      element.removeAttribute('data-dio-shatter')
    }
  },
})
export default shatter

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
function atlas(layout: Raster): CanvasTexture {
  const map = new CanvasTexture(layout.canvas)
  map.premultiplyAlpha = true
  return map
}
