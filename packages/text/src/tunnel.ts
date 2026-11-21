import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  attribute,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  sRGBTransferEOTF,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector2,
} from 'three/webgpu'
import { fonts, raster, unsupported } from './raster'

export type Style = 'tunnel' | 'zoom' | 'spiral'
type Params = {
  style: ChoiceParam<Style>
  depth: number
  perspective: number
  fade: number
  blur: number
  streak: number
  twist: number
  lines: boolean
  color: ColorParam
}

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
export type Vec3 = readonly [number, number, number]

/** Phrases further behind the one in focus than this many steps are not drawn. */
export const FAR = 6
/** Share of each step the camera slows down for at either end, so a phrase holds to be read. */
const HOLD = 0.2
/** Share of the travel that keeps moving through the holds, so the scroll never feels stuck. */
const DRIFT = 0.12
/** A phrase passing the viewer fades out between these shares of the eye distance. */
const NEAR_FROM = 0.2
const NEAR_TO = 0.65
/** How much the phrases behind dim while one holds in focus. */
const CALM = 0.5
/** Straight on, the phrases behind sit right behind the one in focus: they step back further. */
const CALM_ZOOM = 0.75
/** Blur of the phrases far behind, a share of `blur`. */
const SOFT = 0.3
/** Tunnel: how far a phrase on the floor or ceiling leans from facing the viewer, radians. */
const TILT = (50 * Math.PI) / 180
/** Spiral: the lean towards the axis of a phrase on the helix, radians. */
const LEAN = (26 * Math.PI) / 180
/** Spiral: where on the circle the helix meets the focus, radians (straight down). */
const START = -Math.PI / 2
/**
 * Where the tunnel's phrases wait in turn, as angles from the axis: floor, then ceiling. The side
 * walls would turn the reading direction into the depth and put a phrase level with the one in focus.
 */
const WALLS = [Math.PI / 2, -Math.PI / 2] as const
/** Margin around the phrase in focus that the phrases behind keep clear, a share of its height. */
const CLEAR = 0.3
/** The tunnel's walls and the helix sit this much inside the box. */
const INSET = 0.94
/** Radius of the helix, a share of the box's longer side. */
const RADIUS = 0.42
/** Exposure of the motion streak, seconds of camera travel. */
const SHUTTER = 1 / 30
/** Longest streak, plane px. */
const MAX_STREAK = 160
/** Scroll px a second at velocity 1 (the runtime's scale). */
const FULL_SPEED = 3000
/** Samples of the blur and streak kernel; 1 at quality low. */
const TAPS = 12
/** Longest side of the atlas of the phrases, device px. */
const ATLAS = 4096
/** Texels between the phrases in the atlas, room for the blur's mip levels. */
const GAP = 16
/** Width of a guide line at the focus, px. */
const LINE = 1.4

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const inOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
const inOutSlope = (t: number): number => (t < 0.5 ? 12 * t ** 2 : (6 * (-2 * t + 2) ** 2) / 2)

/**
 * Where the camera is at `pin` (0..1), in phrases: 0 on the first, `count - 1` on the last. It
 * slows down on each phrase, so each one holds still to be read, and speeds up between them.
 */
export function travel(pin: number, count: number): number {
  const last = count - 1
  if (last <= 0) return 0
  const position = clamp01(pin) * last
  const phrase = Math.min(last - 1, Math.floor(position))
  const fraction = position - phrase
  return (
    phrase + DRIFT * fraction + (1 - DRIFT) * inOut(clamp01((fraction - HOLD) / (1 - 2 * HOLD)))
  )
}

/** How fast `travel` moves at `pin`, phrases per unit of pin. */
export function pace(pin: number, count: number): number {
  const last = count - 1
  if (last <= 0) return 0
  const position = clamp01(pin) * last
  const fraction = position - Math.min(last - 1, Math.floor(position))
  const hold = (fraction - HOLD) / (1 - 2 * HOLD)
  const eased = hold <= 0 || hold >= 1 ? 0 : inOutSlope(hold) / (1 - 2 * HOLD)
  return last * (DRIFT + (1 - DRIFT) * eased)
}

/** Rotates `v` about the unit `axis` by `angle` (Rodrigues). */
function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cosAngle = Math.cos(angle)
  const sinAngle = Math.sin(angle)
  const along = (axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2]) * (1 - cosAngle)
  return [
    v[0] * cosAngle + (axis[1] * v[2] - axis[2] * v[1]) * sinAngle + axis[0] * along,
    v[1] * cosAngle + (axis[2] * v[0] - axis[0] * v[2]) * sinAngle + axis[1] * along,
    v[2] * cosAngle + (axis[0] * v[1] - axis[1] * v[0]) * sinAngle + axis[2] * along,
  ]
}
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** One phrase at rest: its ink's centre in box-centre px (y up) and half its size. */
export interface Rest {
  readonly x: number
  readonly y: number
  readonly halfWidth: number
  readonly halfHeight: number
}

/** The scene: box size, phrase spacing and eye distance in px, and the look. */
export interface Scene {
  readonly style: Style
  readonly width: number
  readonly height: number
  /** px between two phrases. */
  readonly depth: number
  /** px from the focus to the eye. */
  readonly eye: number
  readonly fade: number
  /** Blur at the eye, screen px. */
  readonly blur: number
  /** Turn of the helix from one phrase to the next, radians. */
  readonly twist: number
}

/** A phrase in 3D: a flat card around `centre`, along `ax` (reading direction) and `ay` (up). */
export interface Placed {
  /** Box-centre px, y up, z towards the viewer: 0 is the page. */
  readonly centre: Vec3
  readonly ax: Vec3
  readonly ay: Vec3
  readonly opacity: number
  /** Blur on screen, px. */
  readonly blur: number
}

type Point = readonly [number, number]

/** The corners of a placed phrase's ink on screen, box-centre px (y up), in order around it. */
export function onScreen(at: Placed, rest: Rest, eye: number): Point[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const qx = (sx as number) * rest.halfWidth
    const qy = (sy as number) * rest.halfHeight
    const k = eye / Math.max(eye - (at.centre[2] + at.ax[2] * qx + at.ay[2] * qy), 1)
    return [
      (at.centre[0] + at.ax[0] * qx + at.ay[0] * qy) * k,
      (at.centre[1] + at.ax[1] * qx + at.ay[1] * qy) * k,
    ] as Point
  })
}

/** Distance between two convex outlines on screen, px; negative when they overlap. */
export function gap(a: readonly Point[], b: readonly Point[]): number {
  let best = Number.NEGATIVE_INFINITY
  for (const shape of [a, b]) {
    shape.forEach((p, k) => {
      const q = shape[(k + 1) % shape.length] as Point
      const length = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (length < 1e-6) return
      const nx = (q[1] - p[1]) / length
      const ny = (p[0] - q[0]) / length
      let a0 = Number.POSITIVE_INFINITY
      let a1 = Number.NEGATIVE_INFINITY
      let b0 = Number.POSITIVE_INFINITY
      let b1 = Number.NEGATIVE_INFINITY
      for (const [x, y] of a) {
        a0 = Math.min(a0, x * nx + y * ny)
        a1 = Math.max(a1, x * nx + y * ny)
      }
      for (const [x, y] of b) {
        b0 = Math.min(b0, x * nx + y * ny)
        b1 = Math.max(b1, x * nx + y * ny)
      }
      best = Math.max(best, b0 - a1, a0 - b1)
    })
  }
  return best
}

/**
 * Phrase `i` with the camera at `t`: in focus (t = i) it lies flat where the DOM has it; further
 * back it moves onto the floor or ceiling of the tunnel or the helix, leaning towards the axis, and
 * fades into the fog; nearer it grows, blurs and fades out before it reaches the eye. Given the
 * phrase in focus (`focus`, the one at round(t)), a phrase behind that would cross it on screen
 * fades out while that one holds. Undefined when unseen.
 */
export function place(
  i: number,
  t: number,
  rest: Rest,
  s: Scene,
  focus?: Rest,
): Placed | undefined {
  const rel = t - i
  const z = rel * s.depth
  if (rel <= -FAR || z >= s.eye * NEAR_TO) return undefined
  // While a phrase holds in focus the ones behind it step back: dimmer and a little soft.
  const held = 1 - smooth(0, 0.35, Math.abs(t - Math.round(t)))
  const behind = smooth(0.4, 1, -rel)
  const far =
    Math.exp(-s.fade * Math.max(0, -rel)) *
    smooth(-FAR, 1 - FAR, rel) *
    (1 - (s.style === 'zoom' ? CALM_ZOOM : CALM) * Math.min(1, s.fade) * held * behind)
  const opacity = far * (1 - smooth(NEAR_FROM, NEAR_TO, z / s.eye))
  if (opacity < 1e-3) return undefined
  const blur = s.blur * (smooth(0.05, 0.6, z / s.eye) + SOFT * smooth(0.5, 2.5, -rel))
  // 0 in focus, 1 one step away: the share of the way onto the wall or the helix.
  const weight = rel < 0 ? smooth(0.05, 0.85, -rel) : smooth(0.05, 0.6, rel)
  let ax: Vec3 = [1, 0, 0]
  let ay: Vec3 = [0, 1, 0]
  let x = rest.x
  let y = rest.y
  if (s.style === 'tunnel' && weight > 0) {
    const angle = WALLS[i % WALLS.length] as number
    const direction: Vec3 = [Math.cos(angle), Math.sin(angle), 0]
    // Turned about the line along the wall, so the face leans towards the axis.
    const axis: Vec3 = [direction[1], -direction[0], 0]
    const tiltedX = rotate(ax, axis, TILT)
    const tiltedY = rotate(ay, axis, TILT)
    ax = rotate(ax, axis, TILT * weight)
    ay = rotate(ay, axis, TILT * weight)
    // The card's outer edge touches the wall.
    const reach =
      Math.abs(dot3(tiltedX, direction)) * rest.halfWidth +
      Math.abs(dot3(tiltedY, direction)) * rest.halfHeight
    const wall = (Math.abs(direction[0]) > 0.5 ? s.width : s.height) * 0.5 * INSET
    const radius = Math.max(0, wall - reach)
    x = lerp(rest.x, direction[0] * radius, weight)
    y = lerp(rest.y, direction[1] * radius, weight)
  } else if (s.style === 'spiral' && weight > 0) {
    // The helix turns with the travel, so the phrase on it turns around the axis on its way in.
    const turn = -s.twist * rel
    const direction: Vec3 = [Math.cos(START + turn), Math.sin(START + turn), 0]
    const roll = turn * weight
    const axis: Vec3 = [direction[1], -direction[0], 0]
    ax = rotate([Math.cos(roll), Math.sin(roll), 0], axis, LEAN * weight)
    ay = rotate([-Math.sin(roll), Math.cos(roll), 0], axis, LEAN * weight)
    const radius = Math.max(s.width, s.height) * RADIUS
    x = lerp(rest.x, direction[0] * radius, weight)
    y = lerp(rest.y, direction[1] * radius, weight)
  }
  const at: Placed = { centre: [x, y, z], ax, ay, opacity, blur }
  const k = Math.round(t)
  if (!focus || s.style === 'zoom' || i === k || held === 0) return at
  const front = place(k, t, focus, s)
  if (!front) return at
  // Clear of the phrase in focus by a margin, else faded out while it holds.
  const apart = gap(onScreen(at, rest, s.eye), onScreen(front, focus, s.eye))
  const kept = opacity * (1 - held * (1 - smooth(0, CLEAR * focus.halfHeight + 4, apart)))
  return kept < 1e-3 ? undefined : { ...at, opacity: kept }
}

/**
 * The guide lines as segments: from and to (x, y in units of the tunnel's half size or the
 * helix radius, phrase step along the axis) and the line's opacity. Tunnel: the edges and two
 * lines down each wall, and a frame every half step; spiral: two strands of the helix; zoom: none.
 */
export function guides(style: Style, count: number, twist: number): number[][] {
  const out: number[][] = []
  const from = -1
  const to = count - 1 + FAR
  if (style === 'tunnel') {
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const
    // Along the axis: the four edges, and two lines down each wall.
    const rails: number[][] = corners.map(([x, y]) => [x, y, 1])
    for (const k of [-0.5, 0.5]) rails.push([k, -1, 0.5], [k, 1, 0.5], [-1, k, 0.5], [1, k, 0.5])
    for (let s = from; s < to; s += 0.5) {
      for (const [x, y, alpha] of rails as [number, number, number][]) {
        out.push([x, y, s, x, y, s + 0.5, alpha])
      }
    }
    for (let s = from; s <= to; s += 0.5) {
      const strong = Number.isInteger(s)
      corners.forEach(([ax, ay], k) => {
        const [bx, by] = corners[(k + 1) % 4] as readonly [number, number]
        out.push([ax, ay, s, bx, by, s, strong ? 1 : 0.55])
      })
    }
  } else if (style === 'spiral') {
    const step = 1 / 16
    for (const strand of [0, Math.PI]) {
      for (let s = from; s < to; s += step) {
        const angle = START + strand + twist * s
        const nextAngle = START + strand + twist * (s + step)
        out.push([
          Math.cos(angle),
          Math.sin(angle),
          s,
          Math.cos(nextAngle),
          Math.sin(nextAngle),
          s + step,
          1,
        ])
      }
    }
  }
  return out
}

/** One phrase as rastered: its canvas, its frame and its ink, in element px (y down). */
interface Measured {
  readonly canvas: HTMLCanvasElement
  readonly frame: readonly [number, number, number, number]
  /** Centre of the ink, element px. */
  readonly cx: number
  readonly cy: number
  readonly halfWidth: number
  readonly halfHeight: number
}

/** A phrase in the atlas. */
interface Phrase extends Rest {
  /** The frame around the centre, px, y up: x0, y0, x1, y1. */
  readonly rect: readonly [number, number, number, number]
  /** Phrase px (from the centre, y up) to atlas UV: u = x0 + px * sx, v = y0 + py * sy. */
  readonly map: readonly [number, number, number, number]
  /** Its cell of the atlas in UV, half a texel in: u0, v0, u1, v1. */
  readonly cell: readonly [number, number, number, number]
}

/** Packs the rasters in rows; `width` and `height` are the element box the phrases sit in. */
function pack(
  list: readonly Measured[],
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; phrases: Phrase[] } | undefined {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const area = list.reduce(
    (sum, phrase) => sum + (phrase.canvas.width + GAP) * (phrase.canvas.height + GAP),
    0,
  )
  const widest = Math.max(1, ...list.map((phrase) => phrase.canvas.width))
  const limit = Math.max(widest, Math.ceil(Math.sqrt(area * 1.3)))
  const spots: [number, number][] = []
  let x = 0
  let y = 0
  let row = 0
  let right = 1
  for (const m of list) {
    if (x > 0 && x + m.canvas.width > limit) {
      x = 0
      y += row + GAP
      row = 0
    }
    spots.push([x, y])
    right = Math.max(right, x + m.canvas.width)
    x += m.canvas.width + GAP
    row = Math.max(row, m.canvas.height)
  }
  const bottom = Math.max(1, y + row)
  const scale = Math.min(1, ATLAS / Math.max(right, bottom))
  canvas.width = Math.max(1, Math.ceil(right * scale))
  canvas.height = Math.max(1, Math.ceil(bottom * scale))
  const atlasWidth = canvas.width
  const atlasHeight = canvas.height
  const phrases = list.map((measured, i) => {
    const [sx0, sy0] = spots[i] as [number, number]
    const left = sx0 * scale
    const top = sy0 * scale
    const cellWidth = measured.canvas.width * scale
    const cellHeight = measured.canvas.height * scale
    ctx.drawImage(measured.canvas, left, top, cellWidth, cellHeight)
    const [frameX, frameY, frameWidth, frameHeight] = measured.frame
    // Texels per element px along x and y.
    const scaleX = cellWidth / Math.max(frameWidth, 1e-3)
    const scaleY = cellHeight / Math.max(frameHeight, 1e-3)
    const phrase: Phrase = {
      x: measured.cx - width / 2,
      y: height / 2 - measured.cy,
      halfWidth: measured.halfWidth,
      halfHeight: measured.halfHeight,
      rect: [
        frameX - measured.cx,
        measured.cy - (frameY + frameHeight),
        frameX + frameWidth - measured.cx,
        measured.cy - frameY,
      ],
      map: [
        (left + (measured.cx - frameX) * scaleX) / atlasWidth,
        1 - (top + (measured.cy - frameY) * scaleY) / atlasHeight,
        scaleX / atlasWidth,
        scaleY / atlasHeight,
      ],
      cell: [
        (left + 0.5) / atlasWidth,
        1 - (top + cellHeight - 0.5) / atlasHeight,
        (left + cellWidth - 0.5) / atlasWidth,
        1 - (top + 0.5) / atlasHeight,
      ],
    }
    return phrase
  })
  return { canvas, phrases }
}

/** Visually hidden but read by screen readers: the phrases not in focus when the DOM shows. */
const QUIET = ';opacity:0'
/** Stacks the phrases in one grid cell, centred, so each one's rest is the middle of the box. */
const STACKED = ';grid-area:1/1;align-self:center'

/** A colour param that is set: empty or currentColor leave the text's own colour. */
const own = (value: string): boolean => {
  const word = value.trim().toLowerCase()
  return word !== '' && word !== 'currentcolor'
}
const colorParam = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

const RECT = 'phraseRect'
const MAP = 'phraseMap'
const CELL = 'phraseCell'
const AX = 'phraseAxisX'
const AY = 'phraseAxisY'
const AT = 'phraseCentre'
const LOOK = 'phraseLook'
const FROM = 'guideFrom'
const TO = 'guideTo'

/** Vogel disk offsets and streak positions of the kernel taps. */
function kernel(taps: number): { disk: [number, number][]; along: number[] } {
  if (taps <= 1) return { disk: [[0, 0]], along: [0] }
  const disk: [number, number][] = []
  const along: number[] = []
  for (let j = 0; j < taps; j++) {
    const radius = Math.sqrt((j + 0.5) / taps)
    const angle = j * 2.399963
    disk.push([radius * Math.cos(angle), radius * Math.sin(angle)])
    along.push((((j * 7) % taps) + 0.5) / taps - 0.5)
  }
  return { disk, along }
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  return map
}

/**
 * The phrases of a pinned section as cards in real depth: the scroll flies the camera forward
 * through them. Each phrase comes out of the fog, holds in focus where the DOM has it, then grows,
 * blurs and passes the viewer, along the walls of a tunnel, straight on, or around a helix. At the
 * end of the section the last phrase settles as DOM text.
 */
const tunnel: Effect<Params> = defineEffect({
  name: 'tunnel',
  params: {
    style: oneOf('tunnel', 'zoom', 'spiral'),
    depth: 1,
    perspective: 1,
    fade: 0.6,
    blur: 10,
    streak: 1,
    twist: 50,
    lines: true,
    color: colorParam('currentColor'),
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  reducedMotion: 'off',
  quality: { low: { blur: 0, streak: 0 } },
  async setup(ctx: EffectContext<Params>) {
    const { element, params, app, signal, u, render } = ctx
    const el = element as HTMLElement
    const style = params.style
    const items = (): HTMLElement[] =>
      [...el.children].filter((c) => c.textContent?.trim()) as HTMLElement[]
    let phrases = items()
    if (phrases.length < 2) {
      if (DEV) app.log.warn('tunnel: put two or more phrases in the element, one child each', el)
      ctx.showDom(true)
      return
    }
    const reason = unsupported(el) ?? (await fonts(el))
    if (signal.aborted) return
    if (reason) {
      if (DEV) app.log.warn(`tunnel: ${reason} cannot be drawn, the phrases stay as they are`, el)
      ctx.showDom(true)
      return
    }

    // The page's own inline styles, put back on dispose and kept under ours.
    const saved = new Map<Element, string | null>()
    const remember = (node: Element): string => {
      if (!saved.has(node)) saved.set(node, node.getAttribute('style'))
      const before = saved.get(node) ?? ''
      return before && !before.trim().endsWith(';') ? `${before};` : before
    }
    const restore = (node: Element): void => {
      const before = saved.get(node)
      if (before === undefined) return
      if (before === null) node.removeAttribute('style')
      else node.setAttribute('style', before)
      saved.delete(node)
    }
    ctx.onDispose(() => {
      for (const node of [...saved.keys()]) restore(node)
    })
    /** The phrases on top of each other; the DOM shows the last, the others stay for readers. */
    const stack = (): void => {
      el.setAttribute('style', `${remember(el)}display:grid`)
      phrases.forEach((phrase, k) => {
        phrase.setAttribute(
          'style',
          remember(phrase) + STACKED + (k < phrases.length - 1 ? QUIET : ''),
        )
      })
    }
    stack()

    const ratio = ctx.quality === 'low' ? 1 : 2
    const taps = ctx.quality === 'low' ? 1 : TAPS
    /** Every phrase rastered where the stack lays it out. */
    const measure = (): { canvas: HTMLCanvasElement; phrases: Phrase[] } | undefined => {
      const box = el.getBoundingClientRect()
      const list: Measured[] = []
      for (const p of phrases) {
        const drawn = raster(p, 'line', ratio, ATLAS)
        if (!drawn?.quads.length) return undefined
        const own = p.getBoundingClientRect()
        const dx = own.left - box.left
        const dy = own.top - box.top
        let x0 = Number.POSITIVE_INFINITY
        let y0 = Number.POSITIVE_INFINITY
        let x1 = Number.NEGATIVE_INFINITY
        let y1 = Number.NEGATIVE_INFINITY
        for (const q of drawn.quads) {
          x0 = Math.min(x0, q.x)
          y0 = Math.min(y0, q.y)
          x1 = Math.max(x1, q.x + q.width)
          y1 = Math.max(y1, q.y + q.height)
        }
        list.push({
          canvas: drawn.canvas,
          frame: [drawn.frame[0] + dx, drawn.frame[1] + dy, drawn.frame[2], drawn.frame[3]],
          cx: (x0 + x1) / 2 + dx,
          cy: (y0 + y1) / 2 + dy,
          halfWidth: (x1 - x0) / 2,
          halfHeight: (y1 - y0) / 2,
        })
      }
      return pack(list, box.width, box.height)
    }
    let atlas = measure()
    if (!atlas) {
      ctx.showDom(true)
      return
    }

    // Uniforms: the box centre in world px, the eye distance and the page camera's, the camera's
    // place along the phrases, the spacing, the guides' size, roll and strength, the ink.
    const centre = uniform(new Vector2())
    const eye = uniform(1000)
    const distance = uniform(render.camera.position.z || 1000)
    const camera = uniform(0)
    const spacing = uniform(1000)
    const half = uniform(new Vector2(1, 1))
    const roll = uniform(0)
    const guide = uniform(0)
    const fog = uniform(params.fade)
    const tinted = uniform(own(params.color) ? 1 : 0)
    const ink = uniform(new Color())
    const readInk = (): void => {
      const style = getComputedStyle(el)
      const fill = style.getPropertyValue('-webkit-text-fill-color')
      const word = fill && !/^(transparent|rgba\(.*,\s*0\))$/.test(fill) ? fill : style.color
      ;(ink.value as Color).set(cssColor(word) ?? '#000000')
    }
    readInk()

    /**
     * Seen through an eye `eye` px in front of the box centre: a point at depth z lands where the
     * page camera shows it at that perspective, about the box centre.
     */
    const project = (p: V3): V3 => {
      const k = p.z.div(eye)
      return vec3(p.xy.sub(centre.mul(k)), k.mul(distance)) as unknown as V3
    }
    /** Box UV of a point on screen, exact across a card: interpolated before the divide. */
    const screen = (p: V3): V3 => varying(vec3(p.xy, eye.sub(p.z).div(eye))) as unknown as V3
    const boxUV = (point: V3): V2 =>
      point.xy.div(max(point.z, 1e-4)).div(u.size).add(0.5) as unknown as V2
    // The guides fade into the fog, slower than the phrases so the depth reads further.
    const fogAt = (rel: F, share: number): F =>
      exp(fog.mul(-share).mul(max(rel.negate(), 0))).mul(
        smoothstep(-FAR, 1 - FAR, rel),
      ) as unknown as F

    const material = (): MeshBasicNodeMaterial =>
      new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })

    // The phrases: one instance each, placed on the CPU every frame.
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex([0, 2, 1, 2, 3, 1])
    const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
    const attrs = {
      rect: { name: RECT, size: 4 },
      map: { name: MAP, size: 4 },
      cell: { name: CELL, size: 4 },
      ax: { name: AX, size: 3 },
      ay: { name: AY, size: 3 },
      at: { name: AT, size: 3 },
      look: { name: LOOK, size: 4 },
    }
    type Key = keyof typeof attrs
    const buffers = {} as Record<Key, InstancedBufferAttribute>
    const allocate = (count: number): void => {
      for (const [key, { name, size }] of Object.entries(attrs) as [
        Key,
        { name: string; size: number },
      ][]) {
        const attr = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * size), size)
        attr.setUsage(DynamicDrawUsage)
        buffers[key] = attr
        geometry.setAttribute(name, attr)
      }
    }
    allocate(phrases.length)
    geometry.instanceCount = 0

    const sampled: { value: Texture }[] = []
    let current: Texture = canvasTexture(atlas.canvas)
    const cards = material()
    {
      const rect = attribute(RECT, 'vec4') as unknown as V4
      const map = varying(attribute(MAP, 'vec4')) as unknown as V4
      const cell = varying(attribute(CELL, 'vec4')) as unknown as V4
      const ax = attribute(AX, 'vec3') as unknown as V3
      const ay = attribute(AY, 'vec3') as unknown as V3
      const mid = attribute(AT, 'vec3') as unknown as V3
      const lookAttr = attribute(LOOK, 'vec4') as unknown as V4
      const look = varying(lookAttr) as unknown as V4
      const corner = positionGeometry.xy.add(0.5)
      const q = vec2(mix(rect.x, rect.z, corner.x), mix(rect.y, rect.w, corner.y))
      const point = mid.add(ax.mul(q.x)).add(ay.mul(q.y)) as unknown as V3
      cards.positionNode = project(point)
      const seen = screen(point)
      // The streak: what slides under a pixel while the camera moves `look.z` px. The part of
      // the move along the card slides it, the part across it grows it about the axis.
      const normal = cross(ax, ay)
      const r3 = vec3(point.xy, 0)
      const grow = normal.z.div(max(eye.sub(point.z), 1))
      const raw = vec2(ax.z, ay.z)
        .add(vec2(dot(r3, ax), dot(r3, ay)).mul(grow))
        .mul(lookAttr.z)
      const streak = varying(
        raw.mul(min(float(1), float(MAX_STREAK).div(max(length(raw), 1e-3)))),
      ) as unknown as V2
      const local = varying(q) as unknown as V2
      const { disk, along } = kernel(taps)
      let sum: V4 | undefined
      for (let j = 0; j < disk.length; j++) {
        const [dx, dy] = disk[j] as [number, number]
        const off = vec2(dx, dy)
          .mul(look.y)
          .add(streak.mul(along[j] as number))
        const uv = clamp(map.xy.add(local.add(off).mul(map.zw)), cell.xy, cell.zw)
        const node = texture(current, uv).bias(look.w)
        sampled.push(node as unknown as { value: Texture })
        const texel = node as unknown as V4
        sum = sum ? (sum.add(texel) as unknown as V4) : texel
      }
      const total = (sum as V4).div(disk.length)
      const rgb = sRGBTransferEOTF(total.rgb.div(max(total.a, 1e-4))) as unknown as V3
      cards.colorNode = vec4(
        mix(rgb, u.color as unknown as V3, tinted),
        total.a.mul(look.x).mul(ctx.mask(boxUV(seen))),
      )
    }
    const cardMesh = new Mesh(geometry, cards)
    cardMesh.frustumCulled = false
    cardMesh.renderOrder = 1

    // The guide lines: thin strips on the walls, at least a couple of pixels wide on screen.
    const lineGeometry = new InstancedBufferGeometry()
    lineGeometry.setIndex([0, 2, 1, 2, 3, 1])
    lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
    lineGeometry.instanceCount = 0
    const lines = material()
    // A strip turned to the eye winds either way round.
    lines.side = DoubleSide
    {
      const from = attribute(FROM, 'vec4') as unknown as V4
      const to = attribute(TO, 'vec4') as unknown as V4
      const corner = positionGeometry.xy.add(0.5)
      const cosRoll = cos(roll)
      const sinRoll = sin(roll)
      const turn = (v: V2): V2 =>
        vec2(
          v.x.mul(cosRoll).sub(v.y.mul(sinRoll)),
          v.x.mul(sinRoll).add(v.y.mul(cosRoll)),
        ) as unknown as V2
      const fromPoint = vec3(turn(from.xy.mul(half)), camera.sub(from.z).mul(spacing))
      const toPoint = vec3(turn(to.xy.mul(half)), camera.sub(to.z).mul(spacing))
      const base = mix(fromPoint, toPoint, corner.x) as unknown as V3
      // Across the line and the view: the strip faces the eye, so no line thins away to nothing.
      const side = normalize(cross(toPoint.sub(fromPoint), vec3(base.xy.negate(), eye.sub(base.z))))
      // Plane px per screen px at this depth: far lines keep 1.6 pixels and lose opacity instead.
      const perPx = max(eye.sub(base.z).div(eye), 0)
      const wide = max(float(LINE), perPx.mul(1.6))
      const point = base.add(side.mul(wide.mul(positionGeometry.y))) as unknown as V3
      lines.positionNode = project(point)
      const seen = screen(point)
      const rel = mix(camera.sub(from.z), camera.sub(to.z), corner.x)
      const near = float(1).sub(smoothstep(0.3, 0.75, base.z.div(eye)))
      const strength = varying(
        fogAt(rel as unknown as F, 0.5)
          .mul(near)
          .mul(min(float(1), float(LINE).div(wide)).sqrt())
          .mul(mix(from.w, to.w, corner.x)),
      ) as unknown as F
      const across = varying(positionGeometry.y.mul(2)) as unknown as F
      const profile = float(1).sub(across.mul(across)) as unknown as F
      lines.colorNode = vec4(
        mix(ink, u.color as unknown as V3, tinted),
        strength
          .mul(profile)
          .mul(guide)
          .mul(ctx.mask(boxUV(seen))),
      )
    }
    const lineMesh = new Mesh(lineGeometry, lines)
    lineMesh.frustumCulled = false
    let built = ''
    let guideCount = 0
    /** The guide segments for this style, count and twist; rebuilt when they change. */
    const buildGuides = (count: number, twist: number): void => {
      const key = `${count}:${style === 'spiral' ? twist : 0}`
      if (key === built) return
      built = key
      const list = guides(style, count, twist)
      const from = new Float32Array(Math.max(1, list.length) * 4)
      const to = new Float32Array(Math.max(1, list.length) * 4)
      list.forEach((g, k) => {
        const [x0, y0, s0, x1, y1, s1, alpha] = g as number[] as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ]
        const strength = alpha * (style === 'spiral' ? 0.42 : 0.32)
        from.set([x0, y0, s0, strength], k * 4)
        to.set([x1, y1, s1, strength], k * 4)
      })
      lineGeometry.setAttribute(FROM, new InstancedBufferAttribute(from, 4))
      lineGeometry.setAttribute(TO, new InstancedBufferAttribute(to, 4))
      guideCount = list.length
    }
    buildGuides(phrases.length, (params.twist * Math.PI) / 180)

    const group = new Group()
    group.add(cardMesh)
    if (style !== 'zoom') group.add(lineMesh)
    ctx.onDispose(() => current.dispose())
    ctx.place(group, { fit: 'none', replace: true })
    // One card, so the compile builds the pipeline of a draw that has instances.
    geometry.instanceCount = 1
    await ctx.compile(group)
    geometry.instanceCount = 0
    if (signal.aborted) return

    // Raster again when the phrases, their fonts or the box change.
    let laidOut = { width: 0, height: 0 }
    const rememberBox = (): void => {
      const box = el.getBoundingClientRect()
      laidOut = { width: box.width, height: box.height }
    }
    rememberBox()
    let cancel: (() => void) | undefined
    const redo = async (): Promise<void> => {
      cancel = undefined
      if (await fonts(el)) return
      if (signal.aborted) return
      const next = items()
      if (next.length < 2) return
      for (const p of phrases) if (!next.includes(p)) restore(p)
      phrases = next
      stack()
      const fresh = measure()
      if (!fresh || signal.aborted) return
      if (geometry.getAttribute(RECT).count < phrases.length) allocate(phrases.length)
      const old = current
      current = canvasTexture(fresh.canvas)
      for (const node of sampled) node.value = current
      old.dispose()
      atlas = fresh
      rememberBox()
      readInk()
      ctx.invalidate()
    }
    const schedule = (): void => {
      cancel?.()
      const id = setTimeout(() => void redo(), 150)
      cancel = () => clearTimeout(id)
    }
    ctx.onDispose(() => cancel?.())
    const text = new MutationObserver(schedule)
    text.observe(el, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => text.disconnect())
    const resize = new ResizeObserver(() => {
      const box = el.getBoundingClientRect()
      if (Math.abs(box.width - laidOut.width) > 0.5 || Math.abs(box.height - laidOut.height) > 0.5)
        schedule()
    })
    resize.observe(el)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    /** 0..1 through the pinned section the phrases play in, else through the viewport. */
    const progress = (input: EffectInput): { p: number; range: number } => {
      const viewport = app.stage.height.peek() || 1
      const section = ctx.section()
      if (section.element !== el && section.height > viewport * 1.05)
        return { p: section.pin, range: section.height - viewport }
      const middle = input.y + input.height / 2
      return { p: clamp01((viewport * 0.85 - middle) / (viewport * 0.6)), range: viewport * 0.6 }
    }

    let dom = false
    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }
    const placed: { i: number; at: Placed }[] = []
    return (input) => {
      const now = atlas
      if (!now) return
      const list = now.phrases
      const count = list.length
      const live = ctx.params
      const { p: pin, range } = progress(input)
      if (pin >= 1 || count < 2) {
        // The last phrase rests where the DOM shows it.
        geometry.instanceCount = 0
        lineGeometry.instanceCount = 0
        show(true)
        return
      }
      const position = travel(pin, count)
      const height = laidOut.height || input.height
      const width = laidOut.width || input.width
      const scene: Scene = {
        style,
        width,
        height,
        depth: Math.max(0.05, live.depth) * height,
        eye: height / Math.max(0.1, live.perspective),
        fade: Math.max(0, live.fade),
        blur: Math.max(0, live.blur),
        twist: (live.twist * Math.PI) / 180,
      }
      // Camera travel during the shutter, px: from the scroll speed.
      let shutter = 0
      if (live.streak > 0) {
        const speed = Math.abs(input.velocity) * FULL_SPEED
        const steps = (speed * pace(pin, count)) / Math.max(range, 1)
        shutter = Math.min(scene.eye * 0.3, steps * scene.depth * SHUTTER * live.streak)
      }
      placed.length = 0
      list.forEach((phrase, i) => {
        const at = place(i, position, phrase, scene, list[Math.round(position)])
        if (at) placed.push({ i, at })
      })
      placed.sort((a, b) => a.at.centre[2] - b.at.centre[2] || a.i - b.i)
      const b = buffers
      placed.forEach(({ i, at }, k) => {
        const phrase = list[i] as Phrase
        const [cx, cy, cz] = at.centre
        const toEye = Math.max(scene.eye - cz, 1)
        // Screen blur over the magnification is the blur on the card.
        const blur = (at.blur * toEye) / scene.eye
        const normal: Vec3 = [
          at.ax[1] * at.ay[2] - at.ax[2] * at.ay[1],
          at.ax[2] * at.ay[0] - at.ax[0] * at.ay[2],
          at.ax[0] * at.ay[1] - at.ax[1] * at.ay[0],
        ]
        const reach =
          Math.hypot(cx, cy) +
          Math.hypot(phrase.rect[2] - phrase.rect[0], phrase.rect[3] - phrase.rect[1]) / 2
        const streak = Math.min(
          MAX_STREAK,
          shutter * (Math.hypot(at.ax[2], at.ay[2]) + (reach * Math.abs(normal[2])) / toEye),
        )
        const pad = blur * 1.2 + streak * 0.5 + 1
        const [x0, y0, x1, y1] = phrase.rect
        b.rect.array.set([x0 - pad, y0 - pad, x1 + pad, y1 + pad], k * 4)
        b.map.array.set(phrase.map, k * 4)
        b.cell.array.set(phrase.cell, k * 4)
        b.ax.array.set(at.ax, k * 3)
        b.ay.array.set(at.ay, k * 3)
        b.at.array.set(at.centre, k * 3)
        // Mip bias for the kernel's spread on screen; the GPU adds the card's own minification.
        const spread = at.blur + (streak * 0.35 * scene.eye) / toEye
        const lod = Math.min(4, Math.log2(Math.max(1, spread / 2.5)))
        b.look.array.set([at.opacity, blur, shutter, lod], k * 4)
      })
      for (const attr of Object.values(b)) attr.needsUpdate = true
      geometry.instanceCount = placed.length

      const where = render.toWorld(input.x + input.width / 2, input.y + input.height / 2)
      ;(centre.value as Vector2).set(where.x, where.y)
      eye.value = scene.eye
      distance.value = render.camera.position.z || 1000
      camera.value = position
      spacing.value = scene.depth
      fog.value = scene.fade
      tinted.value = own(live.color) ? 1 : 0
      if (style !== 'zoom') {
        buildGuides(count, scene.twist)
        const radius = Math.max(width, height) * RADIUS
        if (style === 'spiral') (half.value as Vector2).set(radius, radius)
        else (half.value as Vector2).set(width * 0.5 * INSET, height * 0.5 * INSET)
        lineGeometry.instanceCount = guideCount
        roll.value = style === 'spiral' ? -scene.twist * position : 0
        // The guides leave over the last step, so only the last phrase is left to settle.
        guide.value = live.lines ? 1 - smooth(count - 1.6, count - 1, position) : 0
      }
      show(false)
    }
  },
})
export default tunnel
