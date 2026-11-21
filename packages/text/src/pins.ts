import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, inView, rng } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  max,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  Color,
  DataTexture,
  DataUtils,
  FrontSide,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  RGBAFormat,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { emOf, TIER } from './points'
import { fonts, type Raster, raster, unsupported } from './raster'
import { coverage, distance } from './sdf'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Style = 'pins' | 'bars' | 'domes'
type Press = 'in' | 'out'
type Params = {
  style: ChoiceParam<Style>
  press: ChoiceParam<Press>
  gap: number
  height: number
  radius: number
  color: ColorParam
  duration: number
  seed: number
}

/** Most pins at the high tier; past it the pitch widens. */
export const MAX_PINS = 16000
/** Share of the element height in view, above the bottom tenth, before the text rises. */
const THRESHOLD = 0.3
/** Share of `duration` the rising wave takes to cross the field; one pin rises in the rest. */
const WAVE = 0.6
/** Damping ratio of a rising pin: it overshoots a little and settles. */
const RISE_ZETA = 0.42
/** The pointer's springs: stiffness per second squared and damping ratio (a little wobble). */
const PUSH_STIFF = 240
const PUSH_ZETA = 0.34
/** Upward speed a flat pin gets as the wave passes, heights per second: the field ripples. */
const KICK = 1.4
/** Where the pointer takes the pins it covers, as shares of `height`: hovering and pressing. */
const LEVEL: Record<Press, readonly [number, number]> = { in: [0.15, -0.35], out: [0.6, 1.35] }
/** The closest the pins stand, px. */
const MIN_PITCH = 3
/** Ems around the glyphs where pins stand, thinning out to none. */
const HALO = 0.15
/** Highest a pin can stand, as a share of `height`, for the reach of the shadows. */
const TALLEST = 1.4

/** Key light, world axes (y up, z toward the viewer): from the upper left and the front. */
const KEY = [-0.4, 0.5, 0.95] as const
/** The softbox the metal reflects, and a dim fill low on the right. */
const SOFTBOX = [-0.42, 0.52, 0.74] as const
const FILL = [0.7, -0.35, 0.62] as const

/** How each style is built, in pitches: what a flat pin stands above the page, its grid. */
interface Shape {
  /** Height of a flat pin's top over the page. */
  readonly top: number
  /** Odd rows shifted by half a pitch. */
  readonly hex: boolean
}
const SHAPES: Record<Style, Shape> = {
  pins: { top: 0.31, hex: true },
  bars: { top: 0.25, hex: false },
  domes: { top: 0.32, hex: false },
}

// Attribute names become WGSL and GLSL identifiers: no keyword of either has a capital letter
// after the first.
const AT = 'pinAt'
const INFO = 'pinInfo'
const PART = 'pinPart'

/** The pins over a box and how far each stands out at rest. */
export interface Field {
  readonly count: number
  readonly cols: number
  readonly rows: number
  /** Spacing along a row and between rows, box px. */
  readonly pitch: number
  readonly row: number
  /** Box px of the first pin. */
  readonly x: number
  readonly y: number
  /** Odd rows shifted by half a pitch. */
  readonly hex: boolean
  /** Per pin: x, y in box px (y down) and the UV of its texel in the height texture. */
  readonly at: Float32Array
  /** Per pin: relief at rest 0..1, a random 0..1, and how much of the pin is there 0..1. */
  readonly info: Float32Array
  /** Per pin: its texel in the height texture, row by row over `cols` by `rows`. */
  readonly cell: Uint32Array
  /** Per pin: when the rising wave reaches it, 0..1 of the wave. */
  readonly wave: Float32Array
}

export interface FieldOptions {
  /** Pin spacing in box px; widened until the pins fit `max`. */
  readonly pitch: number
  readonly max: number
  readonly hex: boolean
  readonly seed: number
  /**
   * Px around the glyphs where pins stand, thinning out to none; 0 fills the box. The grid then
   * reaches this far past the box too.
   */
  readonly halo?: number
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * The signed distance to the glyph edge of a raster in box px, positive inside, at box point
 * x, y; past the canvas, the distance at its nearest point less the way there. Bilinear between
 * pixel centres. `deep` is the largest distance inside: half the width of the thickest stroke.
 */
function sampler(layout: Raster): { at: (x: number, y: number) => number; deep: number } {
  const { width, height } = layout.canvas
  const [frameX, frameY, frameWidth] = layout.frame
  const scale = width / frameWidth
  const sdf = distance(coverage(layout.canvas, width, height), width, height)
  let deep = 0
  for (const v of sdf) if (-v > deep) deep = -v
  const at = (x: number, y: number): number => {
    const texelX = (x - frameX) * scale - 0.5
    const texelY = (y - frameY) * scale - 0.5
    const clampedX = Math.min(width - 1, Math.max(0, texelX))
    const clampedY = Math.min(height - 1, Math.max(0, texelY))
    const past = Math.hypot(texelX - clampedX, texelY - clampedY) / scale
    const x0 = Math.floor(clampedX)
    const y0 = Math.floor(clampedY)
    const x1 = Math.min(width - 1, x0 + 1)
    const y1 = Math.min(height - 1, y0 + 1)
    const fractionX = clampedX - x0
    const fractionY = clampedY - y0
    const at = (i: number, j: number): number => sdf[j * width + i] as number
    const top = at(x0, y0) * (1 - fractionX) + at(x1, y0) * fractionX
    const bottom = at(x0, y1) * (1 - fractionX) + at(x1, y1) * fractionX
    const depth = -(top * (1 - fractionY) + bottom * fractionY) / scale
    // The raster leaves a margin around the glyphs: its border is never inside one.
    return past > 0 ? Math.min(depth, 0) - past : depth
  }
  return { at, deep: deep / scale }
}

/**
 * Pins on a grid over a `width` by `height` box, a hex grid when `hex`. Each stands out by a
 * smooth step of the distance to the glyph edge, so the letters rise as plateaus whose edges ramp
 * over a pitch or so. With a `halo` only the pins that close to the glyphs are kept, fewer and
 * fewer toward its edge, so the field takes the shape of the word. The pitch widens until the
 * pins fit `max`. The wave reaches them left to right and a little top down.
 */
export function field(layout: Raster, width: number, height: number, options: FieldOptions): Field {
  const hex = options.hex
  const halo = Math.max(0, options.halo ?? 0)
  const fieldWidth = width + 2 * halo
  const fieldHeight = height + 2 * halo
  const across = (p: number): number => (hex ? (p * Math.sqrt(3)) / 2 : p)
  const gridOf = (p: number): [number, number] => [
    Math.max(1, Math.floor(fieldWidth / p - (hex ? 0.5 : 0))),
    Math.max(1, Math.floor(fieldHeight / across(p))),
  ]
  const { at: inside, deep } = sampler(layout)
  const origin = (p: number, cols: number, rows: number): [number, number] => [
    (fieldWidth - (cols - 1 + (hex && rows > 1 ? 0.5 : 0)) * p) / 2 - halo,
    (fieldHeight - (rows - 1) * across(p)) / 2 - halo,
  ]
  const keepAt = (x: number, y: number): number =>
    halo > 0 ? smooth(-halo, -halo * 0.3, inside(x, y)) : 1
  const kept = (p: number): number => {
    const [cols, rows] = gridOf(p)
    if (halo <= 0) return cols * rows
    const [x0, y0] = origin(p, cols, rows)
    let count = 0
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++)
        if (keepAt(x0 + (i + (hex && j % 2 ? 0.5 : 0)) * p, y0 + j * across(p)) > 0) count++
    return count
  }
  let pitch = Math.max(2, options.pitch)
  for (let i = 0, n = kept(pitch); i < 8 && n > options.max; i++, n = kept(pitch))
    pitch *= Math.sqrt(n / options.max) * 1.01
  const [cols, rows] = gridOf(pitch)
  const row = across(pitch)
  const [x0, y0] = origin(pitch, cols, rows)
  const at: number[] = []
  const info: number[] = []
  const wave: number[] = []
  const cell: number[] = []
  // The plateau's edge: a little past the glyph outside, to full height most of a pitch inside,
  // or sooner in thin strokes, so a hairline still stands out.
  const outer = pitch * 0.3
  const inner = Math.max(0.5, Math.min(pitch * 0.65, deep * 0.6))
  const random = rng(options.seed)
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = x0 + (i + (hex && j % 2 ? 0.5 : 0)) * pitch
      const y = y0 + j * row
      const roll = random()
      const keep = keepAt(x, y)
      if (keep <= 0) continue
      const depth = inside(x, y)
      at.push(x, y, (i + 1.5) / (cols + 2), (j + 1.5) / (rows + 2))
      info.push(smooth(-outer, inner, depth), roll, keep, 0)
      cell.push(j * cols + i)
      wave.push(
        Math.min(
          1,
          Math.max(
            0,
            0.84 * ((x + halo) / Math.max(fieldWidth, 1)) +
              0.16 * ((y + halo) / Math.max(fieldHeight, 1)) +
              (roll - 0.5) * 0.03,
          ),
        ),
      )
    }
  return {
    count: cell.length,
    cols,
    rows,
    pitch,
    row,
    x: x0,
    y: y0,
    hex,
    at: Float32Array.from(at),
    info: Float32Array.from(info),
    wave: Float32Array.from(wave),
    cell: Uint32Array.from(cell),
  }
}

/** A ring of a pin's profile: radius and height under the top in pitches, the normal's slope. */
interface Ring {
  readonly r: number
  readonly z: number
  /** The normal's radial and up parts. */
  readonly n: readonly [number, number]
  /** 1 rides with the top, 0 stays deep under the page. */
  readonly ride: number
  /** 1 on the head, 0 on the shaft. */
  readonly tone: number
}

interface Mesh0 {
  readonly position: number[]
  readonly normal: number[]
  readonly part: number[]
  readonly index: number[]
}

/** A surface of revolution through `rings`, top down, with `segments` around. */
function lathe(rings: readonly Ring[], segments: number, out: Mesh0): void {
  const base = out.position.length / 3
  for (const ring of rings) {
    const len = Math.hypot(ring.n[0], ring.n[1]) || 1
    for (let j = 0; j < segments; j++) {
      const angle = ((j + 0.5) / segments) * Math.PI * 2
      const cosAngle = Math.cos(angle)
      const sinAngle = Math.sin(angle)
      out.position.push(ring.r * cosAngle, ring.r * sinAngle, ring.z)
      out.normal.push((ring.n[0] / len) * cosAngle, (ring.n[0] / len) * sinAngle, ring.n[1] / len)
      out.part.push(ring.ride, ring.tone)
    }
  }
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < segments; j++) {
      const a = base + i * segments + j
      const b = a + segments
      const c = base + i * segments + ((j + 1) % segments)
      const d = c + segments
      out.index.push(a, b, d, a, d, c)
    }
}

/** A square bar with a bevelled top, flat faces. */
function bar(out: Mesh0): void {
  const s = 0.47
  const b = 0.07
  const quad = (
    corners: readonly (readonly [number, number, number, number])[],
    n: readonly [number, number, number],
    tone: number,
  ): void => {
    const base = out.position.length / 3
    const len = Math.hypot(...n)
    for (const [x, y, z, ride] of corners) {
      out.position.push(x, y, z)
      out.normal.push(n[0] / len, n[1] / len, n[2] / len)
      out.part.push(ride, tone)
    }
    out.index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const t = s - b
  quad(
    [
      [-t, -t, 0, 1],
      [t, -t, 0, 1],
      [t, t, 0, 1],
      [-t, t, 0, 1],
    ],
    [0, 0, 1],
    1,
  )
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const) {
    // Seen from outside: the tangent to the right.
    const tx = -dy
    const ty = dx
    quad(
      [
        [dx * s - tx * s, dy * s - ty * s, -b, 1],
        [dx * s + tx * s, dy * s + ty * s, -b, 1],
        [dx * t + tx * t, dy * t + ty * t, 0, 1],
        [dx * t - tx * t, dy * t - ty * t, 0, 1],
      ],
      [dx, dy, 1],
      1,
    )
    quad(
      [
        [dx * s - tx * s, dy * s - ty * s, 0, 0],
        [dx * s + tx * s, dy * s + ty * s, 0, 0],
        [dx * s + tx * s, dy * s + ty * s, -b, 1],
        [dx * s - tx * s, dy * s - ty * s, -b, 1],
      ],
      [dx, dy, 0],
      0,
    )
  }
}

/**
 * One pin of `style` in pitches, its top at z 0: a thin shaft under a domed metal head, a square
 * bar with a bevelled top, or a round button. `pinPart` says which vertices ride with the top
 * and which belong to the head.
 */
export function pinShape(style: Style): Mesh0 {
  const out: Mesh0 = { position: [], normal: [], part: [], index: [] }
  if (style === 'bars') {
    bar(out)
    return out
  }
  const rings: Ring[] = []
  if (style === 'domes') {
    const a = 0.42
    const e = 0.32
    for (let k = 0; k <= 6; k++) {
      const phi = (k / 6) * (Math.PI / 2)
      const s = Math.sin(phi)
      const c = Math.cos(phi)
      rings.push({ r: a * s, z: -e * (1 - c), n: [s / a, c / e], ride: 1, tone: 1 })
    }
    rings.push({ r: a, z: -e, n: [1, 0], ride: 0, tone: 0.8 })
    lathe(rings, 14, out)
    return out
  }
  // A shallow spherical cap, a rounded rim, a short side, the flat underside, the shaft.
  const a = 0.43
  const c = 0.13
  const shaft = 0.08
  const radius = (a * a + c * c) / (2 * c)
  const last = Math.asin(a / radius)
  for (let k = 0; k <= 3; k++) {
    const phi = (k / 3) * last
    rings.push({
      r: radius * Math.sin(phi),
      z: -radius * (1 - Math.cos(phi)),
      n: [Math.sin(phi), Math.cos(phi)],
      ride: 1,
      tone: 1,
    })
  }
  const side = -c - 0.05
  const under = -c - 0.13
  rings.push(
    { r: a + 0.012, z: -c - 0.02, n: [0.86, 0.5], ride: 1, tone: 1 },
    { r: a + 0.015, z: side, n: [1, 0], ride: 1, tone: 1 },
    { r: a, z: under, n: [1, -0.25], ride: 1, tone: 1 },
    { r: a, z: under, n: [0, -1], ride: 1, tone: 0.4 },
    { r: shaft, z: under, n: [0, -1], ride: 1, tone: 0.4 },
    { r: shaft, z: under, n: [1, 0], ride: 1, tone: 0 },
    { r: shaft, z: under, n: [1, 0], ride: 0, tone: 0 },
  )
  lathe(rings, 10, out)
  return out
}

function geometry(style: Style, field: Field): InstancedBufferGeometry {
  const shape = pinShape(style)
  const shared = new InstancedBufferGeometry()
  shared.setIndex(shape.index)
  shared.setAttribute('position', new BufferAttribute(Float32Array.from(shape.position), 3))
  shared.setAttribute('normal', new BufferAttribute(Float32Array.from(shape.normal), 3))
  shared.setAttribute(PART, new BufferAttribute(Float32Array.from(shape.part), 2))
  shared.setAttribute(AT, new InstancedBufferAttribute(field.at, 4))
  shared.setAttribute(INFO, new InstancedBufferAttribute(field.info, 4))
  shared.instanceCount = field.count
  return shared
}

/** The texel of grid cell `k` in a height texture with a border of empty texels. */
const texel = (field: Field, k: number): number => {
  const i = k % field.cols
  return ((k - i) / field.cols + 1) * (field.cols + 2) + i + 1
}

/**
 * The height of each pin as a share of `height` in R, how much of a pin stands there in G (0
 * where none), with a border of empty texels; linearly filtered half floats, first row on top.
 */
function heightTexture(field: Field): DataTexture {
  const width = field.cols + 2
  const height = field.rows + 2
  const data = new Uint16Array(width * height * 4)
  for (let i = 0; i < field.count; i++)
    data[texel(field, field.cell[i] as number) * 4 + 1] = DataUtils.toHalfFloat(
      field.info[i * 4 + 2] as number,
    )
  const map = new DataTexture(data, width, height, RGBAFormat, HalfFloatType)
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/** The fill color of the element's text as `#rrggbb`. */
function inkOf(element: Element): string {
  const style = getComputedStyle(element)
  const fill = style.getPropertyValue('-webkit-text-fill-color')
  const word = fill && !/^(transparent|rgba\(.*,\s*0\))$/.test(fill) ? fill : style.color
  return cssColor(word) ?? '#808080'
}

/** A colour param that is set: empty or currentColor leave the text's own colour. */
const own = (value: string): boolean => {
  const word = value.trim().toLowerCase()
  return word !== '' && word !== 'currentcolor'
}
const colorParam = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Seconds until the last pin has started to rise. */
export const span = (duration: number): number => Math.max(duration, 0) * WAVE

const unit = (v: readonly number[]): [number, number, number] => {
  const length = Math.hypot(...v) || 1
  return [(v[0] as number) / length, (v[1] as number) / length, (v[2] as number) / length]
}

/**
 * The element's box becomes a pin-art toy: a dense field of lit metal pins seen through the page
 * camera, the ones inside the glyphs pushed toward the viewer so the text stands out in relief.
 * On view the letters rise out of the flat field in a wave; the pointer presses the pins in (or
 * pushes them out) in a soft circle and they spring back.
 */
const pins: Effect<Params> = defineEffect({
  name: 'pins',
  params: {
    style: oneOf('pins', 'bars', 'domes'),
    press: oneOf('in', 'out'),
    gap: 0.06,
    height: 26,
    radius: 70,
    color: colorParam('currentColor'),
    duration: 1.6,
    seed: 1,
  },
  rebuild: ['gap', 'seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  // Shadows fall past the box and raised pins lean out of it in perspective.
  bleed: 160,
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const style = params.style
    const press = params.press
    const shape = SHAPES[style]
    const cap = Math.round(MAX_PINS * TIER[ctx.quality])
    const low = ctx.quality === 'low'
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', 1)
    if (signal.aborted) return
    const box = (): { width: number; height: number } => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }
    const pick = (layout: Raster): Field => {
      const { width, height } = box()
      // Pins and halo in ems, so a letter is the same number of pins wide at any size.
      const em = emOf(layout)
      const pitch = Math.max(MIN_PITCH, params.gap * em)
      return field(layout, width, height, {
        pitch,
        max: cap,
        hex: shape.hex,
        seed: params.seed,
        halo: Math.max(pitch * 2.2, em * HALO),
      })
    }
    let grid = layout?.quads.length ? pick(layout) : undefined
    const inkedIn = (f: Field): boolean => f.info.some((v, i) => i % 4 === 0 && v > 0.2)
    const inked = !!grid && inkedIn(grid)
    if (!layout || !grid || !inked) {
      if (reason && DEV)
        app.log.warn(`pins: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }

    // The colour of the pins: `color`, else the text's.
    const ink = uniform(new Color(inkOf(element)))
    const tinted = uniform(own(params.color) ? 1 : 0)
    const tint = mix(ink, u.color, tinted) as unknown as V3
    // The grid: first pin and spacing in box px; texture size, odd-row shift and pitch.
    const where = uniform(new Vector4(grid.x, grid.y, grid.pitch, grid.row))
    const dims = uniform(
      new Vector4(grid.cols + 2, grid.rows + 2, shape.hex ? 0.25 : 0, grid.pitch),
    )
    const half = u.size.mul(0.5) as unknown as V2
    const pitch = dims.w
    const lift = smoothstep(0, 1, u.presence) as unknown as F
    const fade = clamp(u.presence.mul(2), 0, 1) as unknown as F
    const tall = max(u.height, 0).mul(lift) as unknown as F
    const flat = pitch.mul(shape.top) as unknown as F

    let heights = heightTexture(grid)
    const nodes: { value: Texture }[] = []
    const read = (uv: V2, level = false): V4 => {
      const heightTexel = texture(heights, uv)
      nodes.push(heightTexel as unknown as { value: Texture })
      return (level ? heightTexel.level(float(0)) : heightTexel) as unknown as V4
    }
    /** The top of the pins around box point p, px over the page; 0 past the field. */
    const topAt = (point: V2): F => {
      const column = point.x.sub(where.x).div(where.z).sub(dims.z)
      const row = point.y.sub(where.y).div(where.w)
      const sample = read(
        vec2(column.add(1.5).div(dims.x), row.add(1.5).div(dims.y)) as unknown as V2,
      )
      return sample.y.mul(flat).add(sample.x.mul(tall)) as unknown as F
    }

    // The pins: the head rides on the pin's height, the shaft reaches deep under the page.
    const at = attribute(AT, 'vec4') as unknown as V4
    const info = attribute(INFO, 'vec4') as unknown as V4
    const part = attribute(PART, 'vec2') as unknown as V2
    const local = positionGeometry as unknown as V3
    const own0 = read(at.zw as unknown as V2, true)
    const pinHeight = own0.x as unknown as F
    // Toward the edge of the field the pins shrink and sink into the page, so it has no edge.
    const keep = info.z as unknown as F
    const head = pitch.mul(mix(0.45, 1, smoothstep(0, 0.7, keep)))
    const top = flat.mul(keep).add(pinHeight.mul(tall))
    // The shafts end at the page: under it they would show past the field in perspective.
    const z = top.add(local.z.mul(head)).mul(part.x)
    const headX = at.x.add(local.x.mul(head))
    const headY = at.y.sub(local.y.mul(head))
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: FrontSide,
    })
    material.forceSinglePass = true
    material.positionNode = vec3(headX.sub(half.x), half.y.sub(headY), z)

    // Shading per fragment: the point in box px and over the page, the normal, the part.
    const headPoint = varying(vec2(headX, headY)) as unknown as V2
    const headZ = varying(z) as unknown as F
    const tone = varying(part.y) as unknown as F
    const rise = varying(pinHeight) as unknown as F
    const random = varying(info.y) as unknown as F
    const normal = normalize(varying(normalGeometry)) as unknown as V3
    const key = vec3(...unit(KEY)) as unknown as V3
    // Toward the light in box px (y down) and how steeply it falls.
    const toward = normalize(vec2(KEY[0], -KEY[1])) as unknown as V2
    const steep = KEY[2] / Math.hypot(KEY[0], KEY[1])
    const reach = flat.add(max(u.height, 0).mul(TALLEST)).div(steep)
    /** 1 where the pins between `point` and the light stand over a point at `height` px. */
    const shadowAt = (point: V2, height: F, steps: number): F => {
      let occ: F = float(0) as unknown as F
      for (let k = 1; k <= steps; k++) {
        const distance = reach.mul((k / steps) ** 1.3)
        const q = point.add(toward.mul(distance)) as unknown as V2
        const over = topAt(q).sub(height.add(distance.mul(steep)))
        const soft = pitch.mul(0.35).add(distance.mul(0.12))
        occ = max(occ, smoothstep(soft.negate(), soft, over)) as unknown as F
      }
      return occ
    }
    /** How much the pins around `point` stand over a point at `height` px: 0 in the open, 1 deep. */
    const crowdAt = (point: V2, height: F, ring: number): F => {
      let sum: F = float(0) as unknown as F
      const radii = ring > 6 ? [1.05, 2.4] : [1.6]
      let count = 0
      radii.forEach((r, ri) => {
        for (let k = 0; k < 6; k++) {
          const angle = ((k + ri * 0.5) / 6) * Math.PI * 2
          const distance = pitch.mul(r)
          const q = point.add(vec2(Math.cos(angle), Math.sin(angle)).mul(distance)) as unknown as V2
          sum = sum.add(clamp(topAt(q).sub(height).div(distance), 0, 1.5)) as unknown as F
          count++
        }
      })
      return sum.div(count) as unknown as F
    }
    const shadow = shadowAt(headPoint, headZ, low ? 4 : 6)
    const lit = shadow.oneMinus()
    const crowd = crowdAt(headPoint, headZ, low ? 6 : 12)
    const occlusion = float(1).sub(clamp(crowd.mul(0.9), 0, 0.82))
    const view = normalize(cameraPosition.sub(positionWorld)) as unknown as V3
    const reflected = reflect(view.negate(), normal) as unknown as V3
    const ndl = dot(normal, key)
    const halfway = normalize(key.add(view)) as unknown as V3
    const ndh = max(dot(normal, halfway), 0)
    const ndv = clamp(dot(normal, view), 0, 1)
    const fres = pow(ndv.oneMinus(), 5)
    // Raised pins are nearer the lamp and catch a little more of it.
    const near = clamp(rise, -0.3, 1.2).mul(0.85).add(0.3)
    const luma = dot(tint, vec3(0.2126, 0.7152, 0.0722))
    // Metal keeps some brightness whatever the text colour, so its highlights read.
    const metal = mix(vec3(luma, luma, luma), tint, 0.8)
      .add(0.002)
      .mul(clamp(luma, 0.14, 0.85).div(luma.add(0.002))) as unknown as V3
    const grain = random.sub(0.5).mul(0.08).add(1)
    let rgb: V3
    if (style === 'domes') {
      // Round buttons of soft plastic: wrapped diffuse light, a white highlight, a soft rim.
      const diffuse = clamp(ndl.add(0.3).div(1.3), 0, 1).mul(lit)
      // Its gloss reflects the softbox too, so dark buttons show their relief.
      const spec = pow(ndh, 60)
        .mul(0.55)
        .add(smoothstep(0.86, 0.98, dot(reflected, vec3(...unit(SOFTBOX)))).mul(0.3))
        .mul(lit)
        .mul(near)
      // A clear coat that mirrors the room, brighter toward the rim.
      const coat = smoothstep(-0.35, 1, reflected.y)
        .mul(0.3)
        .add(max(reflected.z, 0).mul(0.12))
        .mul(fres.mul(0.7).add(0.3))
        .mul(0.5)
        .mul(near)
      rgb = tint
        .mul(diffuse.mul(0.85).mul(near).add(0.18))
        .mul(occlusion)
        .add(vec3(spec, spec, spec).add(coat).mul(occlusion.mul(0.5).add(0.5))) as unknown as V3
    } else if (style === 'bars') {
      // Anodized bars: satin faces lit by their side, a soft sheen on the bevels.
      const diffuse = max(ndl, 0).mul(lit)
      const spec = pow(ndh, 28).mul(0.32).mul(lit)
      const body = metal.mul(grain)
      rgb = body
        .mul(diffuse.mul(0.95).mul(near).add(0.2))
        .mul(occlusion)
        .add(mix(body, vec3(1, 1, 1), 0.6).mul(spec)) as unknown as V3
    } else {
      // Polished metal: the room and a softbox in the reflection, a sharp highlight from the
      // key light, white at grazing angles; the shafts darker than the heads.
      const room = smoothstep(-0.35, 1, reflected.y)
        .mul(0.32)
        .add(max(reflected.z, 0).mul(0.2))
        .add(0.05)
        .mul(shadow.mul(-0.3).add(1))
      const box = smoothstep(0.8, 0.96, dot(reflected, vec3(...unit(SOFTBOX))))
        .mul(1.7)
        .mul(lit)
      const fill = smoothstep(0.86, 0.98, dot(reflected, vec3(...unit(FILL)))).mul(0.35)
      const env = room.add(box).add(fill).mul(near)
      const spec = pow(ndh, 120).mul(2.2).mul(lit).mul(near)
      const baseReflectance = metal
        .mul(grain)
        .mul(mix(float(0.75), float(1), tone)) as unknown as V3
      const reflectance = baseReflectance.add(
        vec3(1, 1, 1).sub(baseReflectance).mul(fres.mul(tone).mul(0.6)),
      )
      rgb = reflectance
        .mul(env)
        .mul(occlusion)
        .add(
          mix(baseReflectance, vec3(1, 1, 1), 0.55)
            .mul(spec)
            .mul(tone),
        ) as unknown as V3
    }
    const inBox = (q: V2): F =>
      // Half a px inside the box: the mask reads 0.5 right on its edge.
      ctx.mask(
        vec2(
          clamp(q.x, 0.5, u.size.x.sub(0.5)).div(u.size.x),
          clamp(q.y, 0.5, u.size.y.sub(0.5)).div(u.size.y).oneMinus(),
        ) as unknown as V2,
      ) as unknown as F
    // Low pins recede into the page, dimmer and fainter on a light page or a dark one alike,
    // so the risen letters read over them.
    const up = smoothstep(-0.1, 0.7, rise)
    const present = smoothstep(0, 0.5, varying(keep) as unknown as F).mul(mix(0.5, 1, up))
    material.colorNode = vec4(
      rgb.mul(mix(0.7, 1.05, up)),
      fade.mul(present, inBox(varying(at.xy) as unknown as V2)),
    )

    // The page under the pins: in the shade between them and in the shadows they cast.
    const floor = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const area = uniform(new Vector4(0, 0, 1, 1))
    const fp = vec2(
      area.x.add(positionGeometry.x.mul(area.z)),
      area.y.add(positionGeometry.y.mul(area.w)),
    ) as unknown as V2
    floor.positionNode = vec3(fp.x.sub(half.x), half.y.sub(fp.y), 0)
    const q = varying(fp) as unknown as V2
    const ground = float(0) as unknown as F
    const cast = shadowAt(q, ground, low ? 4 : 6)
    const under = crowdAt(q, ground, 6)
    // Little light reaches the page between tall pins, and the slots between bars are deep.
    const dark = max(
      cast.mul(0.3),
      clamp(under, 0, 1.5)
        .mul(0.36)
        .max(style === 'bars' ? clamp(under, 0, 1).mul(0.6) : 0),
    )
    floor.colorNode = vec4(tint.mul(0.03), dark.mul(fade).mul(inBox(q)))

    const quad = new InstancedBufferGeometry()
    quad.setIndex([0, 2, 1, 2, 3, 1])
    quad.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
    )
    quad.instanceCount = 1
    const cover = (field: Field): void => {
      // The field and the reach of its shadows, down and to the right.
      const pad = field.pitch
      const spill = (field.pitch * shape.top + Math.max(ctx.params.height, 0) * TALLEST) / steep
      const right = field.x + (field.cols - 0.5 + (field.hex ? 0.5 : 0)) * field.pitch
      const bottom = field.y + (field.rows - 0.5) * field.row
      const left = field.x - field.pitch / 2 - pad
      const topY = field.y - field.row / 2 - pad
      area.value.set(left, topY, right + pad + spill * 0.8 - left, bottom + pad + spill - topY)
    }
    cover(grid)

    const group = new Group()
    const floorMesh = new Mesh(quad, floor)
    const pinMesh = new Mesh(geometry(style, grid), material)
    floorMesh.frustumCulled = false
    pinMesh.frustumCulled = false
    pinMesh.renderOrder = 1
    group.add(floorMesh, pinMesh)
    ctx.onDispose(() => {
      heights.dispose()
      quad.dispose()
    })
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    // Per pin: how far it has risen (0..1) and the pointer's push (shares of `height`), each
    // with its speed; whether the wave has passed it; the height last written.
    let rise0 = new Float32Array(grid.count)
    let riseV = new Float32Array(grid.count)
    let push = new Float32Array(grid.count)
    let pushV = new Float32Array(grid.count)
    let passed = new Uint8Array(grid.count)
    let shown = new Float32Array(grid.count)
    // Seconds since the text started to rise, -1 before.
    let since = -1
    const write = (i: number, value: number): void => {
      const field = grid as Field
      ;(heights.image.data as Uint16Array)[texel(field, field.cell[i] as number) * 4] =
        DataUtils.toHalfFloat(value)
    }
    const use = (next: Raster, field: Field): void => {
      layout = next
      grid = field
      const old = heights
      heights = heightTexture(field)
      for (const node of nodes) node.value = heights
      old.dispose()
      const was = pinMesh.geometry
      pinMesh.geometry = geometry(style, field)
      was.dispose()
      where.value.set(field.x, field.y, field.pitch, field.row)
      dims.value.set(field.cols + 2, field.rows + 2, shape.hex ? 0.25 : 0, field.pitch)
      cover(field)
      ink.value.set(inkOf(element))
      // A heading that has risen stays risen.
      const up = since >= 0 ? 1 : 0
      rise0 = new Float32Array(field.count).fill(up)
      riseV = new Float32Array(field.count)
      push = new Float32Array(field.count)
      pushV = new Float32Array(field.count)
      passed = new Uint8Array(field.count).fill(up)
      shown = new Float32Array(field.count)
      for (let i = 0; i < field.count; i++) {
        shown[i] = up * (field.info[i * 4] as number)
        if (up) write(i, shown[i] as number)
      }
      heights.needsUpdate = true
      ctx.invalidate()
    }

    // Build again when the text, its fonts or its box change.
    let timer: ReturnType<typeof setTimeout> | undefined
    let building = 0
    const redo = async (): Promise<void> => {
      timer = undefined
      const ticket = ++building
      if (await fonts(element)) return
      if (signal.aborted || ticket !== building) return
      const next = raster(element, 'line', 1)
      if (!next?.quads.length) return
      const field = pick(next)
      if (inkedIn(field)) use(next, field)
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void redo(), 150)
    }
    ctx.onDispose(() => clearTimeout(timer))
    const text = new MutationObserver(schedule)
    text.observe(element, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => text.disconnect())
    let size = box()
    const resize = new ResizeObserver(() => {
      const next = box()
      if (Math.abs(next.width - size.width) > 0.5 || Math.abs(next.height - size.height) > 0.5) {
        size = next
        schedule()
      }
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // The pointer in viewport px: a mouse over the field presses lightly and deeper while its
    // button is down; a finger presses while it is down.
    const pointer = { x: 0, y: 0, on: false, down: false, touch: -1 }
    const last = { x: 0, y: 0, width: 0, height: 0 }
    const nearBox = (): boolean => {
      const reach = Math.max(ctx.params.radius, 0) + 8
      return (
        pointer.x > last.x - reach &&
        pointer.x < last.x + last.width + reach &&
        pointer.y > last.y - reach &&
        pointer.y < last.y + last.height + reach
      )
    }
    const passive = { signal, passive: true }
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'touch' && e.pointerId !== pointer.touch) return
        const was = pointer.on && nearBox()
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.on = true
        if (was || nearBox()) ctx.invalidate()
      },
      passive,
    )
    el.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'touch') pointer.touch = e.pointerId
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.on = true
        pointer.down = true
        ctx.invalidate()
      },
      passive,
    )
    const release = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') {
        if (e.pointerId !== pointer.touch) return
        pointer.touch = -1
        pointer.on = false
      }
      if (!pointer.down && pointer.on) return
      pointer.down = false
      ctx.invalidate()
    }
    addEventListener('pointerup', release, passive)
    addEventListener('pointercancel', release, passive)
    const gone = (): void => {
      pointer.on = false
      pointer.down = false
      pointer.touch = -1
      ctx.invalidate()
    }
    document.documentElement.addEventListener(
      'pointerleave',
      (e) => (e as PointerEvent).pointerType !== 'touch' && gone(),
      { signal },
    )
    addEventListener('blur', gone, { signal })

    /** Steps every pin's springs; true while any of them moves. */
    const step = (dt: number, input: { x: number; y: number }): boolean => {
      const field = grid as Field
      const live = ctx.params
      const duration = Math.max(live.duration, 0)
      const wave = span(duration)
      // A rising pin's spring: one swing in the part of `duration` the wave leaves.
      const omega = (2 * Math.PI) / Math.max(duration * (1 - WAVE) * 1.4, 1e-3)
      const riseK = omega * omega
      const riseC = 2 * RISE_ZETA * omega
      const pushC = 2 * PUSH_ZETA * Math.sqrt(PUSH_STIFF)
      const radius = Math.max(live.radius, 0)
      const touching = pointer.on && radius > 0 && nearBox()
      const pointerX = pointer.x - input.x
      const pointerY = pointer.y - input.y
      const level = LEVEL[press][pointer.down ? 1 : 0]
      const radiusSquared = radius * radius
      const steps = Math.max(1, Math.ceil(dt * 120))
      const hstep = dt / steps
      let moving = false
      let dirty = false
      for (let i = 0; i < field.count; i++) {
        const rest = field.info[i * 4] as number
        // The rise: the wave reaches the pin, it springs up and the flat ones bob.
        const goal = since >= (field.wave[i] as number) * wave ? 1 : 0
        if (goal && !passed[i]) {
          passed[i] = 1
          pushV[i] = (pushV[i] as number) + KICK * (1 - rest)
        }
        let x = rise0[i] as number
        let velocity = riseV[i] as number
        if (x !== goal || velocity !== 0) {
          if (duration <= 0) {
            x = goal
            velocity = 0
          } else
            for (let s = 0; s < steps; s++) {
              velocity += (riseK * (goal - x) - riseC * velocity) * hstep
              x += velocity * hstep
            }
          if (Math.abs(goal - x) < 1e-3 && Math.abs(velocity) < 2e-3) {
            x = goal
            velocity = 0
          } else moving = true
          rise0[i] = x
          riseV[i] = velocity
        }
        // The pointer: a soft circle that takes the pins toward its level.
        let target = 0
        if (touching) {
          const dx = (field.at[i * 4] as number) - pointerX
          const dy = (field.at[i * 4 + 1] as number) - pointerY
          const distanceSquared = dx * dx + dy * dy
          if (distanceSquared < radiusSquared) {
            const k = 1 - distanceSquared / radiusSquared
            const weight = k * k
            const now = rest * x
            const to = now + (level - now) * weight
            target = (press === 'in' ? Math.min(now, to) : Math.max(now, to)) - now
          }
        }
        let y = push[i] as number
        let vy = pushV[i] as number
        if (y !== target || vy !== 0) {
          for (let s = 0; s < steps; s++) {
            vy += (PUSH_STIFF * (target - y) - pushC * vy) * hstep
            y += vy * hstep
          }
          if (Math.abs(target - y) < 1e-3 && Math.abs(vy) < 3e-3) {
            y = target
            vy = 0
          } else moving = true
          push[i] = y
          pushV[i] = vy
        }
        const value = rest * x + y
        if (value !== shown[i]) {
          shown[i] = value
          write(i, value)
          dirty = true
        }
      }
      if (dirty) heights.needsUpdate = true
      return moving
    }
    /** Every pin at its relief at once, the pointer ignored. */
    const still = (): void => {
      const field = grid as Field
      let dirty = false
      for (let i = 0; i < field.count; i++) {
        const value = field.info[i * 4] as number
        rise0[i] = 1
        riseV[i] = 0
        push[i] = 0
        pushV[i] = 0
        passed[i] = 1
        if (shown[i] !== value) {
          shown[i] = value
          write(i, value)
          dirty = true
        }
      }
      if (dirty) heights.needsUpdate = true
    }

    return (input): boolean => {
      last.x = input.x
      last.y = input.y
      last.width = input.width
      last.height = input.height
      const live = ctx.params
      tinted.value = own(live.color) ? 1 : 0
      cover(grid as Field)
      if (input.reducedMotion) {
        since = Math.max(since, span(live.duration) + 1)
        still()
        return false
      }
      if (since < 0) {
        // Counted above the bottom tenth of the viewport, like `reveal`.
        if (inView(input.y, input.height, stage.height.peek(), THRESHOLD)) since = 0
      } else since += Math.min(Math.max(input.delta, 0), 0.1)
      const dt = Math.min(Math.max(input.delta, 0), 1 / 20)
      return step(dt, input) || (since >= 0 && since < span(live.duration))
    }
  },
})
export default pins
