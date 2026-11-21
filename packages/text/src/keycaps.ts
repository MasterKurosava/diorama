import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, inView, palette, rng, roundedBox } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sRGBTransferEOTF,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { type Atlas, fillOf, follow, type Piece, prepare } from './letters'
import { alphaOf } from './paint'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Style = 'keycap' | 'retro' | 'glow'
type Trigger = 'view' | 'hover' | 'loop'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  depth: number
  gap: number
  radius: number
  color: string
  accent: string
  speed: number
  sound: boolean
}

// Sizes in keys (the pitch of one key) unless noted.
/** Pitch of a key per em of the text. */
export const KEY = 1.35
/** Font size of a legend. */
const LEGEND = 0.54
/** Width of a space bar. */
export const SPACE = 2.5
/** A gap between two letters wider than this share of an em is a space. */
const SPACE_GAP = 0.08
/** Rim of the case round the keys when the case fits the keys. */
export const BEZEL = 0.3
/** Extra rim behind the keys: the tilted caps lean over the far edge without it. */
const FAR = 0.4
/** Room the keys keep from the content edge when the case is the element's box. */
const EDGE = 0.1
/** Margin of the plate round the keys, inside the rim. */
const WELL = 0.08
/** Height of a bottomed-out cap's skirt above the plate. */
const CLEAR = 0.05
/** Thickness of the case and the draft of its walls. */
const THICK = 0.3
const CASE_TAPER = 0.02
/** Most keys drawn: past them the text stays as it is. */
export const MAX_KEYS = 240
/** The keyboard lies tilted back by this angle, its far edge away from the viewer. */
const TILT = (30 * Math.PI) / 180
const COS = Math.cos(TILT)
const SIN = Math.sin(TILT)
/** Share of the element in view, above the bottom tenth, before it types. */
const THRESHOLD = 0.3
/** Seconds between two runs of the loop trigger. */
export const LOOP = 3.2
/** A press while hovered, of the full travel. */
const HOVER = 0.42
/** Springs per second squared: a typed press, a hover, a hard click; and the damping ratio. */
const TYPE_K = 1700
const SOFT_K = 520
const HARD_K = 3200
const ZETA = 0.38
/** Highest a cap bounces back past its rest, of the travel. */
const TOP_OUT = 0.16
/** Seconds the glow keeps flowing after the pointer last moved over the keys. */
const STIR = 2.5
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2

/** How the caps and the case of a style look. */
interface Look {
  /** Cap height, side taper, rounded top edge and dish depth, in keys. */
  readonly height: number
  readonly taper: number
  readonly fillet: number
  readonly dish: number
  /** Tilt of the top per row, from the top row down; a single row takes `single`. */
  readonly rows: readonly number[]
  readonly single: number
  /** Specular strength and sharpness. */
  readonly gloss: number
  readonly shine: number
  /** Cap, accent and case colours under dark text and under light text. */
  readonly caps: readonly [string, string]
  readonly accent: readonly [string, string] | undefined
  readonly plate: readonly [string, string]
  readonly housing: string
  /** How far each cap's colour wanders from the others: old plastic yellows unevenly. */
  readonly vary: number
}

const LOOKS: Record<Style, Look> = {
  keycap: {
    height: 0.4,
    taper: 0.1,
    fillet: 0.05,
    dish: 0.028,
    rows: [0.2, 0.1, 0.04, -0.04],
    single: 0.07,
    gloss: 0.1,
    shine: 18,
    caps: ['#ebe8e2', '#2d3036'],
    accent: ['#ff6a3d', '#ff6a3d'],
    plate: ['#2e3136', '#141518'],
    housing: '#141416',
    vary: 0,
  },
  retro: {
    height: 0.52,
    taper: 0.085,
    fillet: 0.06,
    dish: 0.042,
    rows: [0.16, 0.09, 0.04, 0],
    single: 0.06,
    gloss: 0.16,
    shine: 30,
    caps: ['#ddd2b6', '#5e594f'],
    accent: ['#9a9487', '#a8452f'],
    plate: ['#8f8776', '#38342d'],
    housing: '#2a2824',
    vary: 0.05,
  },
  glow: {
    height: 0.36,
    taper: 0.06,
    fillet: 0.045,
    dish: 0.012,
    rows: [0],
    single: 0,
    gloss: 0.38,
    shine: 70,
    caps: ['#1f2026', '#1c1d22'],
    accent: undefined,
    plate: ['#0c0c0f', '#0c0c0f'],
    housing: '#8e95a3',
    vary: 0,
  },
}

/** Key light from the upper left in front, a dim fill from the right; world axes, y up. */
const unit = (x: number, y: number, z: number): [number, number, number] => {
  const norm = Math.hypot(x, y, z)
  return [x / norm, y / norm, z / norm]
}
const KEY_LIGHT = unit(-0.45, 0.62, 0.64)
const FILL_LIGHT = unit(0.7, -0.2, 0.68)

// Attribute names become WGSL and GLSL identifiers: camelCase never meets a keyword of either.
/** Per vertex: the corner's signs and the outward direction of its arc. */
const CORNER = 'capCorner'
/** Per vertex: up the side (0..1), round the top edge (0..1), in over the top (1 rim, 0 middle), on the top. */
const RING = 'capRing'
/** Per instance: centre x, y in keyboard px (y away from the viewer), width, depth. */
const BOX = 'capBox'
/** Per instance: base above the plate, height, side taper, corner radius, px. */
const FORM = 'capForm'
/** Per instance: dish depth, top tilt, rounded top edge, kind (0 cap, 1 switch, 2 case). */
const TOP = 'capTop'
/** Per instance: linear colour, 1 with a legend. */
const TINT = 'capTint'
/** Per instance: flash, then the glow colour's intensity. */
const STATE = 'capState'
/** Per instance: linear glow colour, its intensity. */
const GLOW = 'capGlow'
/** Per instance: centre of the legend's ink in atlas px, its scale. */
const GLYPH = 'capGlyph'
/** Per instance: the legend's cell in atlas px, left, top, right, bottom. */
const CELL = 'capCell'
const SHADE_BOX = 'shadeBox'
const SHADE_SOFT = 'shadeSoft'
const LIGHT_BOX = 'lightBox'
const LIGHT_TINT = 'lightTint'

/** Ink bounds of a piece in box px, and whether it has any. */
export interface Ink {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
  readonly empty: boolean
}

/** One key of the board. */
export interface KeyPlan {
  /** Centre in keyboard px: x right, y away from the viewer, the case's middle at 0. */
  readonly x: number
  readonly y: number
  /** Width in keys. */
  readonly units: number
  /** The atlas piece printed on it; -1 for a space bar. */
  readonly piece: number
  /** Place in the typing order. */
  readonly seq: number
  readonly row: number
}

/** The keys and the case round them. */
export interface Board {
  readonly keys: readonly KeyPlan[]
  /** Key pitch, px. */
  readonly unit: number
  readonly rows: number
  /** The case in box px: centre x, centre y (y down), width, height. */
  readonly case: readonly [number, number, number, number]
  /** The plate the keys sit on, keyboard px: centre x, y, half width, half height. */
  readonly well: readonly [number, number, number, number]
}

export interface BoardOptions {
  /** The element's box, px. */
  readonly width: number
  readonly height: number
  /** Top, right, bottom, left. */
  readonly padding: readonly [number, number, number, number]
  /** 0 left, 0.5 centre, 1 right. */
  readonly align: number
  /** The case is the element's box, widened to fit the keys; otherwise a rim round the keys. */
  readonly fill: boolean
  /** Widest the board may grow, px. */
  readonly room: number
}

/** Ink bounds of every piece from the atlas pixels; the DOM box where they cannot be read. */
export function inks(drawn: Atlas): Ink[] {
  const { canvas, scale } = drawn
  const canvasWidth = canvas.width
  let data: Uint8ClampedArray | undefined
  try {
    const read = canvas.getContext('2d')?.getImageData(0, 0, canvasWidth, canvas.height).data
    if (read && read.length >= canvasWidth * canvas.height * 4) data = read
  } catch {
    data = undefined
  }
  return drawn.pieces.map((p) => {
    const dom = {
      x0: p.cx - p.span / 2,
      x1: p.cx + p.span / 2,
      y0: p.base - p.em * 0.7,
      y1: p.base,
      empty: false,
    }
    if (!data) return dom
    const cellLeft = Math.max(0, Math.floor(p.u * scale))
    const cellTop = Math.max(0, Math.floor(p.v * scale))
    const cellRight = Math.min(canvasWidth, Math.ceil((p.u + p.width) * scale))
    const cellBottom = Math.min(canvas.height, Math.ceil((p.v + p.height) * scale))
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    for (let y = cellTop; y < cellBottom; y++)
      for (
        let x = cellLeft, alphaAt = (y * canvasWidth + cellLeft) * 4 + 3;
        x < cellRight;
        x++, alphaAt += 4
      ) {
        if ((data[alphaAt] as number) < 40) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    if (x1 < x0) return { ...dom, empty: true }
    return {
      x0: p.x + x0 / scale - p.u,
      x1: p.x + (x1 + 1) / scale - p.u,
      y0: p.y + y0 / scale - p.v,
      y1: p.y + (y1 + 1) / scale - p.v,
      empty: false,
    }
  })
}

/**
 * The keys of the text: a row per visual line in reading order, one key per letter, a space bar
 * where the DOM has a space, a wider key for a legend that does not fit one. Keys are KEY em
 * apart, smaller when the board would not fit. The case is the element's box with `fill`,
 * otherwise a rim round the keys, aligned to the text like the text is aligned in its box.
 */
export function board(pieces: readonly Piece[], ink: readonly Ink[], options: BoardOptions): Board {
  const found = new Map<number, number[]>()
  pieces.forEach((p, i) => {
    const list = found.get(p.line) ?? []
    list.push(i)
    found.set(p.line, list)
  })
  const lines = [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((i, j) => (pieces[i] as Piece).cx - (pieces[j] as Piece).cx))
  const em = pieces.reduce((m, p) => Math.max(m, p.em), 1)

  type Draft = { piece: number; units: number; seq: number }
  const drafts: Draft[][] = lines.map((list) => {
    const out: Draft[] = []
    list.forEach((i, k) => {
      const p = pieces[i] as Piece
      if (k > 0) {
        const j = list[k - 1] as number
        const previous = pieces[j] as Piece
        const space = p.cx - p.span / 2 - (previous.cx + previous.span / 2)
        if (space > Math.max(p.em, previous.em) * SPACE_GAP)
          out.push({ piece: -1, units: SPACE, seq: Math.min(i, j) * 2 + 1 })
      }
      const inkBox = ink[i]
      const wide = inkBox ? ((inkBox.x1 - inkBox.x0) * LEGEND) / p.em : 0
      out.push({ piece: i, units: Math.max(1, Math.ceil((wide + 0.42) * 4) / 4), seq: i * 2 })
    })
    return out
  })
  const rows = Math.max(1, drafts.length)
  const widths = drafts.map((row) => row.reduce((n, k) => n + k.units, 0))
  const most = Math.max(1, ...widths)

  const [padTop, padRight, padBottom, padLeft] = options.padding
  const contentWidth = Math.max(1, options.width - padLeft - padRight)
  const contentHeight = Math.max(1, options.height - padTop - padBottom)
  let size = KEY * em
  if (options.fill)
    size = Math.min(
      size,
      Math.max(contentWidth, options.room - padLeft - padRight) / (most + 2 * EDGE),
      contentHeight / (rows + 2 * EDGE),
    )
  else size = Math.min(size, Math.max(options.width, options.room) / (most + 2 * BEZEL))
  size = Math.max(size, 4)
  const blockW = most * size
  const blockH = rows * size

  let caseX: number
  let caseY: number
  let caseW: number
  let caseH: number
  let left: number
  let top: number
  if (options.fill) {
    // The box, wider where the keys need it, growing the way the text is aligned.
    caseW = Math.max(options.width, blockW + 2 * EDGE * size + padLeft + padRight)
    caseX = (options.width - caseW) * options.align
    caseY = 0
    caseH = options.height
    left =
      caseX +
      padLeft +
      EDGE * size +
      (caseW - padLeft - padRight - 2 * EDGE * size - blockW) * options.align
    // Toward the viewer where the box has room, as the case does round its keys.
    top = padTop + (contentHeight - blockH) / 2
    top += Math.min(
      (FAR * size) / 2,
      Math.max(0, (contentHeight - blockH) / 2 + padBottom - EDGE * size),
    )
  } else {
    caseW = blockW + 2 * BEZEL * size
    caseH = blockH + (2 * BEZEL + FAR) * size
    let textLeft = Number.POSITIVE_INFINITY
    let textRight = Number.NEGATIVE_INFINITY
    for (const p of pieces) {
      textLeft = Math.min(textLeft, p.cx - p.span / 2)
      textRight = Math.max(textRight, p.cx + p.span / 2)
    }
    if (!pieces.length) textLeft = textRight = options.width / 2
    const anchor = textLeft + (textRight - textLeft) * options.align
    caseX = anchor - caseW * options.align
    const middle = (list: readonly number[] | undefined): number => {
      if (!list?.length) return options.height / 2
      let sum = 0
      for (const i of list) {
        const p = pieces[i] as Piece
        sum += p.base - p.em * 0.36
      }
      return sum / list.length
    }
    const centre = (middle(lines[0]) + middle(lines.at(-1))) / 2
    caseY = centre - caseH / 2 - (FAR * size) / 2
    left = caseX + BEZEL * size
    top = caseY + (BEZEL + FAR) * size
  }
  const caseCentreX = caseX + caseW / 2
  const caseCentreY = caseY + caseH / 2

  const keys: KeyPlan[] = []
  drafts.forEach((row, rowIndex) => {
    let x = left + (most - (widths[rowIndex] as number)) * size * options.align
    const y = top + (rowIndex + 0.5) * size
    for (const key of row) {
      const keyWidth = key.units * size
      keys.push({
        x: x + keyWidth / 2 - caseCentreX,
        y: caseCentreY - y,
        units: key.units,
        piece: key.piece,
        seq: key.seq,
        row: rowIndex,
      })
      x += keyWidth
    }
  })
  return {
    keys,
    unit: size,
    rows,
    case: [caseCentreX, caseCentreY, caseW, caseH],
    well: [
      left + blockW / 2 - caseCentreX,
      caseCentreY - (top + blockH / 2),
      blockW / 2 + WELL * size,
      blockH / 2 + WELL * size,
    ],
  }
}

/** Rings of a cap from the base up the side, round its top edge and in over the dished top. */
const RINGS = [
  [0, 0, 1, 0],
  [0.5, 0, 1, 0],
  [1, 0, 1, 0],
  [1, 0.35, 1, 0],
  [1, 0.7, 1, 0],
  [1, 1, 1, 0],
  // The same ring again with the normals of the dish: the crisp edge of a dished top.
  [1, 1, 1, 1],
  [1, 1, 0.8, 1],
  [1, 1, 0.58, 1],
  [1, 1, 0.36, 1],
  [1, 1, 0.16, 1],
] as const
/** The ring the dish starts on: no faces join it to the one before. */
const CREASE = 6
/** Segments of each rounded corner. */
const SEG = 5

/** A unit cap as rings of a rounded rectangle; its true shape comes from the instance. */
function shell(): InstancedBufferGeometry {
  const per = 4 * (SEG + 1)
  const corner: number[] = []
  const ring: number[] = []
  for (const step of RINGS)
    for (let side = 0; side < 4; side++)
      for (let segment = 0; segment <= SEG; segment++) {
        const phi = ((side + segment / SEG) * Math.PI) / 2
        corner.push(
          side === 0 || side === 3 ? 1 : -1,
          side < 2 ? 1 : -1,
          Math.cos(phi),
          Math.sin(phi),
        )
        ring.push(...step)
      }
  // The middle of the top.
  corner.push(0, 0, 0, 0)
  ring.push(1, 1, 0, 1)
  const index: number[] = []
  for (let level = 0; level < RINGS.length - 1; level++) {
    if (level + 1 === CREASE) continue
    for (let j = 0; j < per; j++) {
      const a = level * per + j
      const b = level * per + ((j + 1) % per)
      const c = (level + 1) * per + ((j + 1) % per)
      const d = (level + 1) * per + j
      index.push(a, b, c, a, c, d)
    }
  }
  const last = (RINGS.length - 1) * per
  const middle = RINGS.length * per
  for (let j = 0; j < per; j++) index.push(last + j, last + ((j + 1) % per), middle)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(index)
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corner.length * 0.75), 3))
  geometry.setAttribute(CORNER, new BufferAttribute(new Float32Array(corner), 4))
  geometry.setAttribute(RING, new BufferAttribute(new Float32Array(ring), 4))
  return geometry
}

/** A quad per instance, corners at ±0.5. */
function quads(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]),
      3,
    ),
  )
  return geometry
}

/** Dynamic instance attributes of `count` items, four floats each, on `geometry`. */
function instanced(
  geometry: InstancedBufferGeometry,
  count: number,
  names: readonly string[],
): void {
  for (const name of names) {
    const attr = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4)
    attr.setUsage(DynamicDrawUsage)
    geometry.setAttribute(name, attr)
  }
  geometry.instanceCount = count
}

const BODY = [BOX, FORM, TOP, TINT, STATE, GLOW, GLYPH, CELL] as const

/**
 * The body's instance attributes in one interleaved buffer (WebGPU allows 8 vertex buffers), with
 * a plain array per attribute to write and `flush` to copy them in.
 */
function interleaved(geometry: InstancedBufferGeometry, count: number) {
  const stride = BODY.length * 4
  const buffer = new InstancedInterleavedBuffer(
    new Float32Array(Math.max(1, count) * stride),
    stride,
  )
  buffer.setUsage(DynamicDrawUsage)
  const parts = BODY.map((name, k) => {
    geometry.setAttribute(name, new InterleavedBufferAttribute(buffer, 4, k * 4))
    return new Float32Array(Math.max(1, count) * 4)
  })
  geometry.instanceCount = count
  return {
    parts,
    flush(): void {
      const out = buffer.array as Float32Array
      for (let i = 0; i < count; i++)
        parts.forEach((part, k) => {
          out.set(part.subarray(i * 4, i * 4 + 4), i * stride + k * 4)
        })
      buffer.needsUpdate = true
    },
  }
}
const SHADE = [SHADE_BOX, SHADE_SOFT] as const
const LIGHT = [LIGHT_BOX, LIGHT_TINT] as const

/** A point or a direction of the keyboard turned into the page: the far edge leans away. */
const tilt = (v: V3): V3 =>
  vec3(v.x, v.y.mul(COS).add(v.z.mul(SIN)), v.y.mul(-SIN).add(v.z.mul(COS))) as unknown as V3

/** A number in 0..1 for a key and a channel, the same on every load. */
function hash(i: number, salt: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const luma = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

/** A CSS colour as `#rrggbb`: any colour, `var(--x)`, `currentColor`; undefined for none. */
const colorOf = (value: string, element: Element): string | undefined =>
  value.trim() ? palette(value, element)[0] : undefined

/** Where a key travels: its press, 0 at rest and 1 bottomed out, and its speed. */
export interface Spring {
  x: number
  v: number
}

/**
 * Steps a key toward `target` for `dt` seconds: a stiff spring that bottoms out hard at 1, the
 * stem's top stopping a bounce back a little past rest. True when it hit the bottom moving.
 */
export function travel(state: Spring, target: number, stiffness: number, dt: number): boolean {
  const steps = Math.min(64, Math.ceil(dt * 480))
  const stepTime = steps ? dt / steps : 0
  const damping = 2 * ZETA * Math.sqrt(stiffness)
  let hit = false
  for (let i = 0; i < steps; i++) {
    state.v += (stiffness * (target - state.x) - damping * state.v) * stepTime
    state.x += state.v * stepTime
    if (state.x > 1) {
      if (state.v > 2) hit = true
      state.x = 1
      state.v = Math.min(state.v, 0)
    } else if (state.x < -TOP_OUT) {
      state.x = -TOP_OUT
      state.v = Math.max(state.v, 0)
    }
  }
  if (Math.abs(state.x - target) < 2e-3 && Math.abs(state.v) < 0.02) {
    state.x = target
    state.v = 0
  }
  return hit
}

/** Seconds from the first key to the last, at `speed` keys a second, with a human rhythm. */
export function rhythm(keys: readonly KeyPlan[], speed: number): number[] {
  const beat = 1 / Math.max(speed, 0.5)
  const order = keys.map((_, i) => i).sort((a, b) => (keys[a]?.seq ?? 0) - (keys[b]?.seq ?? 0))
  const times = new Array<number>(keys.length).fill(0)
  let time = 0
  order.forEach((i, n) => {
    const key = keys[i] as KeyPlan
    // A space bar, and the key after it, come a little late: a word ends.
    if (key.piece < 0) time += beat * 0.25
    times[i] = time
    time += beat * (0.75 + 0.5 * hash(n, 7)) + (key.piece < 0 ? beat * 0.2 : 0)
  })
  return times
}

let noise: AudioBuffer | undefined
/** Seeded, so the effect module stays deterministic; only the sound varies per click. */
const random = rng(7)
/** A short synthesized key click: plastic in a band of noise, a low thump as it bottoms out. */
function clack(audio: AudioContext, style: Style, hard: boolean): void {
  const start = audio.currentTime
  if (!noise || noise.sampleRate !== audio.sampleRate) {
    const samples = Math.floor(audio.sampleRate * 0.05)
    noise = audio.createBuffer(1, samples, audio.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < samples; i++) data[i] = (random() * 2 - 1) * Math.exp(-i / (samples * 0.1))
  }
  const [band, low] = style === 'retro' ? [3600, 220] : style === 'glow' ? [1700, 120] : [2400, 150]
  const out = audio.createGain()
  out.gain.value = hard ? 0.42 : 0.24
  out.connect(audio.destination)
  const source = audio.createBufferSource()
  source.buffer = noise
  source.playbackRate.value = 0.9 + random() * 0.2
  const filter = audio.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = band * (0.92 + random() * 0.16)
  filter.Q.value = 1.3
  source.connect(filter).connect(out)
  const thump = audio.createOscillator()
  thump.frequency.setValueAtTime(low, start)
  thump.frequency.exponentialRampToValueAtTime(low * 0.5, start + 0.05)
  const env = audio.createGain()
  env.gain.setValueAtTime(hard ? 0.9 : 0.5, start)
  env.gain.exponentialRampToValueAtTime(0.001, start + 0.07)
  thump.connect(env).connect(out)
  source.start(start)
  thump.start(start)
  thump.stop(start + 0.08)
  thump.onended = () => out.disconnect()
}

/**
 * The text set on the keycaps of a mechanical keyboard in 3D: one sculpted, dished cap per letter
 * with the legend printed on top in the text colour, a wide space bar between words, on a darker
 * case seen in perspective with soft shadows. On view the keys go down one after another as if
 * the word were typed, a quick press, a bounce and a flash each; under the pointer they press, a
 * click sends one down hard. Retro beige caps or dark caps with an RGB glow. The text stays real
 * in the DOM.
 */
const keycaps: Effect<Params> = defineEffect({
  name: 'keycaps',
  params: {
    style: oneOf('keycap', 'retro', 'glow'),
    trigger: oneOf('view', 'hover', 'loop'),
    depth: 0.22,
    gap: 0.07,
    radius: 0.16,
    color: '',
    accent: '',
    speed: 9,
    sound: false,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The case fits the keys, which are wider than the letters, and leans out of the page.
  bleed: 480,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, signal, u, render, app } = ctx
    const { stage } = app
    const style = params.style
    const trigger = params.trigger
    const look = LOOKS[style]
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    let atlas = await prepare(ctx, ratio)
    if (!atlas) return
    if (atlas.pieces.length > MAX_KEYS) {
      if (DEV)
        app.log.warn(`keycaps: more than ${MAX_KEYS} letters, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }

    const css = getComputedStyle(element)
    const textColor = new Color(cssColor(fillOf(css)) ?? '#000000')
    const tone = luma(textColor) < 0.4 ? 0 : 1
    const pick = (
      value: string,
      fallback: string | undefined,
      what: string,
    ): string | undefined => {
      if (value.trim().toLowerCase() === 'none') return undefined
      const hex = colorOf(value, element)
      if (!hex && value.trim() && DEV)
        app.log.warn(`keycaps: "${value}" is not a ${what} colour, using the style's own`, element)
      return hex ?? fallback
    }
    const capHex = pick(params.color, look.caps[tone], 'cap') ?? look.caps[tone]
    const accentHex = pick(params.accent, look.accent?.[tone], 'accent')
    // An element with a background of its own is the case; otherwise the case fits the keys.
    const bg = css.backgroundColor
    const solid = bg && alphaOf(bg) >= 0.5 ? cssColor(bg) : undefined
    const own = {
      color: solid,
      fill: !!solid || (!!css.backgroundImage && css.backgroundImage !== 'none'),
    }
    const capColor = new Color(capHex)
    const accentColor = accentHex ? new Color(accentHex) : undefined
    const plateColor = new Color(own.color ?? look.plate[tone])
    // Clear switches light up under glow caps; dark ones sink into the plate's shade.
    const housingColor =
      style === 'glow' ? new Color(look.housing) : plateColor.clone().multiplyScalar(0.5)
    const px = (v: string): number => Number.parseFloat(v) || 0

    const layout = (drawn: Atlas): Board => {
      const rect = element.getBoundingClientRect()
      const parent = element.parentElement?.getBoundingClientRect()
      const align = css.textAlign
      const rtl = css.direction === 'rtl'
      const alignShare =
        align === 'center'
          ? 0.5
          : align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl)
            ? 1
            : 0
      return board(drawn.pieces, inks(drawn), {
        width: rect.width,
        height: rect.height,
        padding: [
          px(css.paddingTop),
          px(css.paddingRight),
          px(css.paddingBottom),
          px(css.paddingLeft),
        ],
        align: alignShare,
        fill: own.fill,
        room: parent ? (parent.right - rect.left) * 0.92 : rect.width,
      })
    }
    let plan = layout(atlas)
    let ink = inks(atlas)

    // Uniforms shared by the draws.
    const centre = uniform(new Vector2(plan.case[0], plan.case[1]))
    const atlasSize = uniform(new Vector2(atlas.size[0], atlas.size[1]))
    const caseShape = uniform(new Vector4(plan.case[2] / 2, plan.case[3] / 2, 0, 0))
    const well = uniform(new Vector4(...plan.well))
    const keyU = uniform(plan.unit)
    const where = uniform(new Vector2(0.5, 0.5))
    const half = u.size.mul(0.5) as unknown as V2
    const origin = vec3(centre.x.sub(half.x), half.y.sub(centre.y), 0) as unknown as V3
    const alpha = ctx.mask(where as unknown as V2) as unknown as F

    // The caps, their switches and the case: one instanced shell, shaped per instance.
    const corner = attribute(CORNER, 'vec4') as unknown as V4
    const ring = attribute(RING, 'vec4') as unknown as V4
    const box = attribute(BOX, 'vec4') as unknown as V4
    const form = attribute(FORM, 'vec4') as unknown as V4
    const top = attribute(TOP, 'vec4') as unknown as V4
    const dir = corner.zw
    const height = max(form.y, 1e-3)
    const fillet = min(top.z, height.mul(0.6))
    const straight = max(height.sub(fillet), 1e-3)
    const psi = ring.y.mul(Math.PI / 2)
    const inset = form.z.mul(ring.x).add(fillet.mul(cos(psi).oneMinus()))
    const rise = straight.mul(ring.x).add(fillet.mul(sin(psi)))
    const cornerRadius = form.w
    const radius = max(cornerRadius.sub(inset.mul(0.5)), cornerRadius.mul(0.4))
    const halfX = box.z.mul(0.5).sub(inset)
    const halfY = box.w.mul(0.5).sub(inset)
    const rim = vec2(
      corner.x.mul(max(halfX.sub(radius), 0)).add(radius.mul(dir.x)),
      corner.y.mul(max(halfY.sub(radius), 0)).add(radius.mul(dir.y)),
    ) as unknown as V2
    const share = ring.z
    const flat = rim.mul(share) as unknown as V2
    const lifted = rise.sub(top.x.mul(share.mul(share).oneMinus()))
    // Sculpted: the top tilts by its row's slope, the base stays on the plate.
    const z = lifted.add(top.y.mul(flat.y).mul(lifted.div(height)))
    const local = vec3(box.x.add(flat.x), box.y.add(flat.y), form.x.add(z)) as unknown as V3
    // The top's middle vertex has no direction: a wall without taper would normalize zero there.
    const side = normalize(vec3(dir.mul(straight), max(form.z, 1e-3)))
    const edge = normalize(mix(side, vec3(0, 0, 1), sin(psi)))
    const reach = max(dot(rim, dir), 1e-3)
    const dish = normalize(vec3(dir.mul(top.x.mul(share).mul(-2).div(reach)), 1))
    const blended = normalize(mix(edge, dish, ring.w))
    const normalLocal = normalize(
      vec3(blended.x, blended.y.sub(top.y.mul(blended.z)), blended.z),
    ) as unknown as V3
    const body = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: FrontSide,
    })
    body.forceSinglePass = true
    body.positionNode = origin.add(tilt(local))

    const normal = normalize(varying(tilt(normalLocal))) as unknown as V3
    const kind = varying(top.w) as unknown as F
    const isCase = step(1.5, kind)
    const isSwitch = step(0.5, kind).mul(isCase.oneMinus())
    const isCap = float(1).sub(step(0.5, kind))
    const tint = varying(attribute(TINT, 'vec4')) as unknown as V4
    const state = varying(attribute(STATE, 'vec4')) as unknown as V4
    const glow = varying(attribute(GLOW, 'vec4')) as unknown as V4
    const glyph = varying(attribute(GLYPH, 'vec4')) as unknown as V4
    const cell = varying(attribute(CELL, 'vec4')) as unknown as V4
    const onTop = varying(ring.w) as unknown as F
    const vTop = varying(flat) as unknown as V2
    const vRise = varying(lifted.div(height)) as unknown as F
    const vLocal = varying(local) as unknown as V3

    // The legend, printed on the top in the text's own colour.
    const scale = max(glyph.z, 1e-3)
    const spot = vec2(
      glyph.x.add(vTop.x.div(scale)),
      glyph.y.sub(vTop.y.div(scale)),
    ) as unknown as V2
    const inside = step(cell.x, spot.x)
      .mul(step(spot.x, cell.z))
      .mul(step(cell.y, spot.y))
      .mul(step(spot.y, cell.w))
    const map = new CanvasTexture(atlas.canvas)
    map.premultiplyAlpha = true
    map.anisotropy = 4
    const legend = texture(map, vec2(spot.x.div(atlasSize.x), spot.y.div(atlasSize.y).oneMinus()))
    const printed = legend.a
      .mul(inside)
      .mul(smoothstep(0.5, 1, onTop))
      .mul(isCap)
      .mul(tint.w) as unknown as F
    const inkColor = sRGBTransferEOTF(legend.rgb.div(max(legend.a, 1e-4))) as unknown as V3

    // The plate inside the case's rim: a shade darker, in shadow along its edge.
    const wellDistance = roundedBox(
      vLocal.xy.sub(well.xy) as unknown as V2,
      well.zw as unknown as V2,
      keyU.mul(0.1),
    )
    const inWell = smoothstep(-1, 1, wellDistance)
      .oneMinus()
      .mul(isCase)
      .mul(smoothstep(0.5, 1, onTop))
    const plateAO = mix(
      float(1),
      smoothstep(keyU.mul(-0.14), 0, wellDistance).mul(-0.3).add(1),
      inWell,
    )
    const glowStyle = style === 'glow' ? 1 : 0
    const albedo = mix(tint.xyz, inkColor, printed.mul(glowStyle ? 0.55 : 1))
      .mul(mix(float(1), float(0.8), inWell))
      .mul(plateAO) as unknown as V3

    // Light: a wrapped key light, a fill, a sky above and the floor below, a soft sheen.
    const key = vec3(...KEY_LIGHT)
    const view = normalize(cameraPosition.sub(positionWorld)) as unknown as V3
    const nDotL = dot(normal, key)
    const wrap = clamp(nDotL.add(0.25).div(1.25), 0, 1)
    const fill = max(dot(normal, vec3(...FILL_LIGHT)), 0).mul(0.16)
    const sky = normal.y.mul(0.5).add(0.5)
    const ambient = mix(float(0.2), float(0.38), sky)
    // Walls darken toward the plate, where the switch and the neighbours shade them.
    const ao = mix(float(0.55), float(1), smoothstep(0, 0.45, vRise))
      .mul(isCap)
      .add(isCap.oneMinus())
    const halfway = normalize(key.add(view))
    const gloss = mix(float(look.gloss), float(0.14), isCase).mul(printed.mul(-0.4).add(1))
    const spec = pow(max(dot(normal, halfway), 0), mix(float(look.shine), float(26), isCase)).mul(
      gloss,
    )
    const fresnel = pow(clamp(dot(normal, view), 0, 1).oneMinus(), 4)
      .mul(0.07)
      .mul(sky)
    const lit = albedo
      .mul(ambient.add(wrap.mul(0.62)).add(fill))
      .mul(ao)
      .add(spec.add(fresnel).mul(ao)) as unknown as V3
    // A flash on a pressed key; under glow caps the light shines through the plastic.
    const flash = state.x.mul(isCap).mul(onTop.mul(0.22).add(0.1))
    const walls = onTop.oneMinus().mul(vRise.oneMinus().pow(2))
    const shine = glow.xyz.mul(glow.w).mul(
      isCap
        .mul(walls.mul(0.75).add(printed.mul(1.4)))
        .add(isSwitch.mul(0.8))
        .mul(glowStyle),
    )
    const flashTint = glowStyle ? glow.xyz : vec3(1, 0.97, 0.9)
    body.colorNode = vec4(lit.add(shine).add(flashTint.mul(flash)), alpha)

    // Soft shadows: of the case on the page, and of each cap and switch on the plate.
    const shadeBox = attribute(SHADE_BOX, 'vec4') as unknown as V4
    const shadeSoft = attribute(SHADE_SOFT, 'vec4') as unknown as V4
    const quadCorner = positionGeometry.xy as unknown as V2
    const shadeReach = shadeBox.zw.add(shadeSoft.x.mul(2.5))
    const shadeLocal = quadCorner.mul(shadeReach.mul(2)) as unknown as V2
    const shadePoint = vec3(
      shadeBox.x.add(shadeLocal.x),
      shadeBox.y.add(shadeLocal.y),
      shadeSoft.z,
    ) as unknown as V3
    const shadow = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
    })
    shadow.positionNode = origin.add(tilt(shadePoint))
    const vShadeLocal = varying(shadeLocal) as unknown as V2
    const vShadeSoft = varying(shadeSoft) as unknown as V4
    const vShadeHalf = varying(shadeBox.zw) as unknown as V2
    const vShadeAt = varying(shadePoint.xy) as unknown as V2
    const shadeDistance = roundedBox(vShadeLocal, vShadeHalf, vShadeSoft.w)
    const caseDistance = roundedBox(
      vShadeAt,
      caseShape.xy as unknown as V2,
      caseShape.z as unknown as F,
    )
    // On the plate only; the case's own shadow falls past it.
    const onPlate = mix(
      float(1),
      smoothstep(-1.5, 0, caseDistance).oneMinus(),
      step(0, vShadeSoft.z),
    )
    shadow.colorNode = vec4(
      0,
      0,
      0,
      smoothstep(vShadeSoft.x.negate(), vShadeSoft.x, shadeDistance)
        .oneMinus()
        .mul(vShadeSoft.y)
        .mul(onPlate)
        .mul(alpha),
    )

    // Light on the plate: the RGB glow bleeding from under each cap, or a pressed key's flash.
    const lightBox = attribute(LIGHT_BOX, 'vec4') as unknown as V4
    const lightTint = attribute(LIGHT_TINT, 'vec4') as unknown as V4
    const spread = keyU.mul(glowStyle ? 0.36 : 0.3)
    const lightReach = lightBox.zw.add(spread.mul(3))
    const lightLocal = quadCorner.mul(lightReach.mul(2)) as unknown as V2
    const lightPoint = vec3(
      lightBox.x.add(lightLocal.x),
      lightBox.y.add(lightLocal.y),
      0.8,
    ) as unknown as V3
    const light = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    light.positionNode = origin.add(tilt(lightPoint))
    const vLightLocal = varying(lightLocal) as unknown as V2
    const vLightHalf = varying(lightBox.zw) as unknown as V2
    const vLightAt = varying(lightPoint.xy) as unknown as V2
    const vLightTint = varying(lightTint) as unknown as V4
    const lightDistance = max(roundedBox(vLightLocal, vLightHalf, keyU.mul(0.12)), 0)
    const falloff = exp(lightDistance.div(spread).mul(-2.4)).add(
      exp(lightDistance.div(spread).mul(-9)).mul(0.6),
    )
    // Inside the plate: the case's rounded top edge falls away from the light's plane.
    const onCase = smoothstep(
      -1.5,
      0,
      roundedBox(vLightAt, caseShape.xy as unknown as V2, caseShape.z as unknown as F).add(
        keyU.mul(0.1),
      ),
    ).oneMinus()
    light.colorNode = vec4(vLightTint.xyz.mul(falloff), vLightTint.w.mul(onCase).mul(alpha))

    const shell0 = shell()
    let bodies = shell0
    let shades = quads()
    let lights = quads()
    let staged: ReturnType<typeof interleaved> = { parts: [], flush() {} }
    const sizes = (count: number): void => {
      bodies = shell0.clone() as InstancedBufferGeometry
      staged = interleaved(bodies, 1 + 2 * count)
      shades = quads()
      instanced(shades, 1 + 2 * count, SHADE)
      lights = quads()
      instanced(lights, count, LIGHT)
    }
    sizes(plan.keys.length)
    const bodyMesh = new Mesh(bodies, body)
    const shadeMesh = new Mesh(shades, shadow)
    const lightMesh = new Mesh(lights, light)
    shadeMesh.renderOrder = 1
    lightMesh.renderOrder = 2
    const group = new Group()
    for (const mesh of [bodyMesh, shadeMesh, lightMesh]) {
      mesh.frustumCulled = false
      group.add(mesh)
    }
    ctx.onDispose(() => {
      ;(legend.value as Texture).dispose()
      shell0.dispose()
    })

    // Per key: its press and speed, its flash, when it is typed.
    let springs: Spring[] = []
    let flashes = new Float32Array(0)
    let times: number[] = []
    let caps: Color[] = []
    const glowColor = new Color()
    let phase = 0
    const reset = (): void => {
      const count = plan.keys.length
      springs = Array.from({ length: count }, () => ({ x: 0, v: 0 }))
      flashes = new Float32Array(count)
      times = rhythm(plan.keys, ctx.params.speed)
      // The first letter typed takes the accent; old plastic yellows unevenly.
      let first = -1
      plan.keys.forEach((k, i) => {
        if (k.piece >= 0 && (first < 0 || k.seq < (plan.keys[first] as KeyPlan).seq)) first = i
      })
      caps = plan.keys.map((k, i) => {
        const color = (i === first && accentColor ? accentColor : capColor).clone()
        if (look.vary) {
          const shift = (hash(k.seq, 3) - 0.5) * 2 * look.vary
          color.setRGB(
            color.r * (1 + shift * 0.6),
            color.g * (1 + shift * 0.4),
            color.b * (1 - shift),
          )
        }
        return color
      })
    }
    reset()

    /** Writes every instance from the board, the live params and the keys' presses. */
    const write = (): void => {
      const p = ctx.params
      const keySize = plan.unit
      const gap = Math.min(Math.max(p.gap, 0), 0.45) * keySize
      const depth = Math.min(Math.max(p.depth, 0), 0.6) * keySize
      const cornerRadius = Math.min(Math.max(p.radius, 0), 0.5) * keySize
      const count = plan.keys.length
      const [boxData, formData, topData, tintData, stateData, glowData, glyphData, cellData] =
        staged.parts as [
          Float32Array,
          Float32Array,
          Float32Array,
          Float32Array,
          Float32Array,
          Float32Array,
          Float32Array,
          Float32Array,
        ]
      const shadeBoxData = (shades.getAttribute(SHADE_BOX) as InstancedBufferAttribute)
        .array as Float32Array
      const shadeSoftData = (shades.getAttribute(SHADE_SOFT) as InstancedBufferAttribute)
        .array as Float32Array
      const lightBoxData = (lights.getAttribute(LIGHT_BOX) as InstancedBufferAttribute)
        .array as Float32Array
      const lightTintData = (lights.getAttribute(LIGHT_TINT) as InstancedBufferAttribute)
        .array as Float32Array
      const [, , caseWidth, caseHeight] = plan.case
      const caseRadius = Math.min(
        Math.max(css.borderTopLeftRadius ? px(css.borderTopLeftRadius) : 0, keySize * 0.22),
        caseWidth / 2,
        caseHeight / 2,
      )
      caseShape.value.set(caseWidth / 2, caseHeight / 2, caseRadius, 0)
      // The case: its top is the plate, its walls below it.
      const thick = THICK * keySize
      boxData.set([0, 0, caseWidth, caseHeight], 0)
      formData.set([-thick, thick, CASE_TAPER * keySize, caseRadius], 0)
      topData.set([0, 0, keySize * 0.07, 2], 0)
      tintData.set([plateColor.r, plateColor.g, plateColor.b, 0], 0)
      stateData.set([0, 0, 0, 0], 0)
      glowData.set([0, 0, 0, 0], 0)
      // The case on the page, below and right of it.
      shadeBoxData.set([keySize * 0.12, -keySize * 0.22, caseWidth / 2, caseHeight / 2], 0)
      shadeSoftData.set([keySize * 0.45, 0.42, -thick - 1, caseRadius], 0)
      const capH = look.height * keySize
      const rows = plan.rows
      const slopeOf = (row: number): number =>
        rows === 1
          ? look.single
          : (look.rows[Math.round((row / Math.max(rows - 1, 1)) * (look.rows.length - 1))] ?? 0)
      const pieces = atlas?.pieces ?? []
      for (let i = 0; i < count; i++) {
        const key = plan.keys[i] as KeyPlan
        const press = springs[i]?.x ?? 0
        const keyWidth = key.units * keySize - gap
        const keyDepth = keySize - gap
        const capRadius = Math.min(cornerRadius, keyWidth * 0.45, keyDepth * 0.45)
        const base = CLEAR * keySize + depth * (1 - press)
        const flash = flashes[i] ?? 0
        const color = caps[i] as Color
        // The glow: a hue per key travelling along the row.
        let glowLevel = 0
        if (style === 'glow') {
          const along = (key.x / Math.max(plan.case[2], 1) + 0.5) * 0.85 + key.row * 0.12
          glowColor.setHSL((((phase - along) % 1) + 1) % 1, 1, 0.55)
          glowLevel = 0.8 + 0.25 * Math.max(press, 0) + 0.8 * flash
        } else {
          glowColor.setRGB(1, 0.95, 0.85)
          glowLevel = 0.5 * flash
        }
        // The switch under the cap, then the cap.
        const switchAt = 1 + i
        const capAt = 1 + count + i
        const switchHeight = Math.min(
          CLEAR * keySize + depth + 0.12 * keySize,
          CLEAR * keySize + capH - 0.06 * keySize,
        )
        boxData.set(
          [key.x, key.y, Math.min(0.56 * keySize, keyWidth), 0.56 * keySize],
          switchAt * 4,
        )
        formData.set([0, switchHeight, 0.03 * keySize, 0.1 * keySize], switchAt * 4)
        topData.set([0, 0, 0.02 * keySize, 1], switchAt * 4)
        tintData.set([housingColor.r, housingColor.g, housingColor.b, 0], switchAt * 4)
        stateData.set([0, 0, 0, 0], switchAt * 4)
        glowData.set([glowColor.r, glowColor.g, glowColor.b, glowLevel], switchAt * 4)
        boxData.set([key.x, key.y, keyWidth, keyDepth], capAt * 4)
        formData.set([base, capH, look.taper * keySize, capRadius], capAt * 4)
        topData.set([look.dish * keySize, slopeOf(key.row), look.fillet * keySize, 0], capAt * 4)
        const piece = key.piece >= 0 ? pieces[key.piece] : undefined
        const inkBox = key.piece >= 0 ? ink[key.piece] : undefined
        const printed = piece && inkBox && !inkBox.empty
        tintData.set([color.r, color.g, color.b, printed ? 1 : 0], capAt * 4)
        stateData.set([flash, 0, 0, 0], capAt * 4)
        glowData.set([glowColor.r, glowColor.g, glowColor.b, glowLevel], capAt * 4)
        if (piece && inkBox && printed) {
          // The line's ink shares one baseline across its keys, centred on the tops.
          const topW = keyWidth - 2 * (look.taper + look.fillet) * keySize
          const topD = keyDepth - 2 * (look.taper + look.fillet) * keySize
          const lineTop = lineTops.get(piece.line) ?? inkBox.y0
          const lineBottom = lineBottoms.get(piece.line) ?? inkBox.y1
          const mid = (lineTop + piece.base) / 2 + 0.25 * (lineBottom - piece.base)
          let legendScale = (LEGEND * keySize) / piece.em
          legendScale = Math.min(
            legendScale,
            (0.74 * topW) / Math.max(inkBox.x1 - inkBox.x0, 1),
            (0.7 * topD) / Math.max(lineBottom - lineTop, 1),
          )
          glyphData.set(
            [
              piece.u + (inkBox.x0 + inkBox.x1) / 2 - piece.x,
              piece.v + mid - piece.y,
              legendScale,
              0,
            ],
            capAt * 4,
          )
          cellData.set([piece.u, piece.v, piece.u + piece.width, piece.v + piece.height], capAt * 4)
        } else {
          glyphData.set([0, 0, 1, 0], capAt * 4)
          cellData.set([0, 0, 0, 0], capAt * 4)
        }
        // Shadows on the plate: the cap's from its height, the switch's tight round its foot.
        const lift = base
        shadeBoxData.set(
          [key.x + lift * 0.18, key.y - lift * 0.3, keyWidth / 2, keyDepth / 2],
          switchAt * 4,
        )
        shadeSoftData.set(
          [keySize * 0.05 + lift * 0.45, 0.5 - Math.min(lift / keySize, 0.4) * 0.5, 0.6, capRadius],
          switchAt * 4,
        )
        shadeBoxData.set([key.x, key.y - keySize * 0.02, 0.34 * keySize, 0.34 * keySize], capAt * 4)
        shadeSoftData.set([keySize * 0.05, 0.55, 0.6, 0.1 * keySize], capAt * 4)
        lightBoxData.set([key.x, key.y, keyWidth / 2, keyDepth / 2], i * 4)
        lightTintData.set(
          [glowColor.r, glowColor.g, glowColor.b, glowLevel * (style === 'glow' ? 0.55 : 0.6)],
          i * 4,
        )
      }
      staged.flush()
      for (const name of SHADE)
        (shades.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
      for (const name of LIGHT)
        (lights.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true
    }
    // Ink top and bottom of each line, for the legends' common baseline.
    const lineTops = new Map<number, number>()
    const lineBottoms = new Map<number, number>()
    const lineInk = (): void => {
      lineTops.clear()
      lineBottoms.clear()
      atlas?.pieces.forEach((piece, i) => {
        const inkBox = ink[i]
        if (!inkBox || inkBox.empty) return
        lineTops.set(piece.line, Math.min(lineTops.get(piece.line) ?? inkBox.y0, inkBox.y0))
        lineBottoms.set(piece.line, Math.max(lineBottoms.get(piece.line) ?? inkBox.y1, inkBox.y1))
      })
    }
    lineInk()
    const frame = (): void => {
      centre.value.set(plan.case[0], plan.case[1])
      well.value.set(...plan.well)
      keyU.value = plan.unit
    }
    frame()
    write()

    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    let stuck = false
    // Keys move, so the update asks for frames; the layout waits for them to rest.
    let playing = false
    follow(
      ctx,
      ratio,
      () => atlas?.width ?? 0,
      () => !playing,
      (next) => {
        stuck = !next
        if (!next) {
          ctx.showDom(true)
          return
        }
        if (next.pieces.length > MAX_KEYS) {
          stuck = true
          ctx.showDom(true)
          return
        }
        ctx.showDom(false)
        atlas = next
        ink = inks(next)
        plan = layout(next)
        lineInk()
        const old = [bodies, shades, lights]
        sizes(plan.keys.length)
        bodyMesh.geometry = bodies
        shadeMesh.geometry = shades
        lightMesh.geometry = lights
        for (const geometry of old) geometry.dispose()
        const nextMap = new CanvasTexture(next.canvas)
        nextMap.premultiplyAlpha = true
        nextMap.anisotropy = 4
        ;(legend.value as Texture).dispose()
        legend.value = nextMap
        atlasSize.value.set(next.size[0], next.size[1])
        reset()
        frame()
        write()
      },
    )

    // Seconds since typing started, -1 while idle; whether it typed once; the loop's next run.
    let typing = -1
    let typed = false
    let end = 0
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    ctx.onDispose(() => clearTimeout(timer))
    const hold = (): number => Math.min(0.09, 0.7 / Math.max(ctx.params.speed, 0.5))
    const start = (): void => {
      times = rhythm(plan.keys, ctx.params.speed)
      typing = 0
      typed = true
      end = Math.max(0, ...times) + hold() + 0.5
      playing = true
      ctx.invalidate()
    }
    const again = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        pending = true
        ctx.invalidate()
      }, LOOP * 1000)
    }

    // Sound, only after the visitor has touched the page: browsers block it before.
    let audio: AudioContext | undefined
    const unlock = (): void => {
      if (audio || !ctx.params.sound || typeof AudioContext !== 'function') return
      try {
        audio = new AudioContext()
      } catch {
        audio = undefined
      }
    }
    const play = (hard: boolean): void => {
      if (!ctx.params.sound) return
      const active = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation
      if (!audio && active?.hasBeenActive) unlock()
      if (audio?.state === 'running') clack(audio, style, hard)
    }
    ctx.onDispose(() => void audio?.close().catch(() => {}))

    // The pointer over the keyboard: a mouse anywhere, a finger or a click while pressed.
    let last: { x: number; y: number; width: number; height: number } | undefined
    let pointer: { x: number; y: number } | undefined
    let down: { id: number; key: number } | undefined
    /** Seconds the glow's wave still flows after the pointer last moved over the keys. */
    let stir = 0
    /** The key at client px, -2 over the case between keys, -1 off the keyboard. */
    const keyAt = (clientX: number, clientY: number): number => {
      if (!last) return -1
      const vw = stage.width.peek()
      const vh = stage.height.peek()
      const cameraDistance = render.camera.position.z || 1000
      const keySize = plan.unit
      const lift =
        (CLEAR + Math.min(Math.max(ctx.params.depth, 0), 0.6) + look.height * 0.8) * keySize
      const originX = last.x + plan.case[0] - vw / 2
      const originY = vh / 2 - (last.y + plan.case[1])
      const screenX = clientX - vw / 2
      const screenY = vh / 2 - clientY
      // The ray from the camera through the point, met with the plane of the key tops.
      const denom = screenY * SIN - cameraDistance * COS
      if (Math.abs(denom) < 1e-6) return -1
      const along = ((originY + lift * SIN) * SIN + (lift * COS - cameraDistance) * COS) / denom
      const keyX = along * screenX - originX
      const keyY =
        (along * screenY - originY) * COS - (cameraDistance - along * cameraDistance) * SIN
      const [, , caseWidth, caseHeight] = plan.case
      if (Math.abs(keyX) > caseWidth / 2 || Math.abs(keyY) > caseHeight / 2) return -1
      for (let i = 0; i < plan.keys.length; i++) {
        const key = plan.keys[i] as KeyPlan
        if (
          Math.abs(keyX - key.x) <= (key.units * keySize) / 2 &&
          Math.abs(keyY - key.y) <= keySize / 2
        )
          return i
      }
      return -2
    }
    const passive = { passive: true, signal }
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'touch' && e.pointerId !== down?.id) return
        const was = pointer && keyAt(pointer.x, pointer.y) !== -1
        pointer = { x: e.clientX, y: e.clientY }
        const now = keyAt(pointer.x, pointer.y) !== -1
        if (now) stir = STIR
        if (was || now) ctx.invalidate()
      },
      passive,
    )
    addEventListener(
      'pointerdown',
      (e) => {
        unlock()
        const key = keyAt(e.clientX, e.clientY)
        if (key < 0) return
        down = { id: e.pointerId, key }
        pointer = { x: e.clientX, y: e.clientY }
        stir = STIR
        if (!ctx.input.reducedMotion) {
          flashes[key] = 1.3
          play(true)
        }
        if (trigger === 'hover' && typing < 0) start()
        ctx.invalidate()
      },
      passive,
    )
    addEventListener('keydown', unlock, passive)
    const up = (e: PointerEvent): void => {
      if (!down || e.pointerId !== down.id) return
      down = undefined
      if (e.pointerType === 'touch') pointer = undefined
      ctx.invalidate()
    }
    addEventListener('pointerup', up, passive)
    addEventListener('pointercancel', up, passive)
    const gone = (): void => {
      pointer = undefined
      down = undefined
      ctx.invalidate()
    }
    document.documentElement.addEventListener('pointerleave', gone, { signal })
    addEventListener('blur', gone, { signal })
    // A link or button round the keyboard types it when it takes focus, as a hover would.
    const host = element.closest('a, button')
    if (host && trigger === 'hover')
      host.addEventListener('focusin', () => typing < 0 && start(), { signal })

    let over = false
    return (input): boolean => {
      if (stuck) {
        playing = false
        return false
      }
      last = input
      // The mask at the case's middle, half a px inside the box: its edge reads 0.5.
      const maskX = Math.min(Math.max(plan.case[0], 0.5), Math.max(input.width - 0.5, 0.5))
      const maskY = Math.min(Math.max(plan.case[1], 0.5), Math.max(input.height - 0.5, 0.5))
      where.value.set(maskX / Math.max(input.width, 1), 1 - maskY / Math.max(input.height, 1))
      const dt = Math.min(Math.max(input.delta, 0), 0.05)
      const count = plan.keys.length
      if (input.reducedMotion) {
        // The keys are drawn, nothing presses.
        typing = -1
        for (const spring of springs) {
          spring.x = 0
          spring.v = 0
        }
        flashes.fill(0)
        write()
        playing = false
        return false
      }

      // Typing: on view, again in the loop, or when the pointer comes over the keys.
      const seen = inView(input.y, input.height, stage.height.peek(), THRESHOLD)
      if (trigger !== 'hover' && !typed && typing < 0 && seen) start()
      if (pending && typing < 0 && input.visible) {
        pending = false
        start()
      }
      const hovered = pointer ? keyAt(pointer.x, pointer.y) : -1
      const isOver = hovered !== -1
      if (trigger === 'hover' && isOver && !over && typing < 0) start()
      over = isOver
      const before = typing
      if (typing >= 0) {
        typing += dt
        if (typing > end) {
          typing = -1
          if (trigger === 'loop') again()
        }
      }

      const held = hold()
      let busy = typing >= 0
      for (let i = 0; i < count; i++) {
        const spring = springs[i] as Spring
        let target = 0
        let stiffness = SOFT_K
        if (typing >= 0) {
          const pressAt = times[i] ?? 0
          if (before < pressAt && typing >= pressAt) {
            flashes[i] = Math.max(flashes[i] ?? 0, 1)
            play(false)
          }
          if (typing >= pressAt && typing < pressAt + held) {
            target = 1
            stiffness = TYPE_K
          }
        }
        if (hovered === i && target < HOVER) target = HOVER
        if (down?.key === i) {
          target = 1
          stiffness = HARD_K
        }
        if (spring.x !== target || spring.v !== 0) {
          travel(spring, target, stiffness, dt)
          if (spring.x !== target || spring.v !== 0) busy = true
        }
        const flash = flashes[i] ?? 0
        if (flash > 0) {
          flashes[i] = flash > 0.01 ? flash * Math.exp(-dt * 7) : 0
          busy = true
        }
      }
      // The glow's wave flows while keys move and a little after the pointer stops over them.
      if (style === 'glow') {
        stir = isOver ? Math.max(stir - dt, 0) : 0
        if (busy || stir > 0) {
          phase = (phase + dt * 0.3) % 1
          busy = true
        }
      }
      write()
      playing = busy
      return busy
    }
  },
})
export default keycaps
