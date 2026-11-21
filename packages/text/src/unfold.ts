import type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectInput,
} from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, entering, inView, rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  cross,
  dot,
  exp,
  float,
  frontFacing,
  fwidth,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  select,
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
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  MaxEquation,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  OneFactor,
  RepeatWrapping,
  type Texture,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { backdrop, linear } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'

export type Style = 'strips' | 'accordion' | 'cards' | 'origami'
type Trigger = 'view' | 'scroll' | 'hover'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  bands: 'auto'
  angle: number
  duration: number
  stagger: number
  paper: ColorParam
  shade: number
  delay: number
  threshold: number
}

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
export type Vec3 = [number, number, number]

/** A flat cut of the text block that folds on a hinge. */
export interface Cut {
  /** Corners in box px (y down): top left, top right, bottom left, bottom right; a triangle repeats its last. */
  readonly corners: readonly [number, number, number, number, number, number, number, number]
  /** The cut it hangs from, always an earlier one; -1 hangs it from the page. */
  readonly parent: number
  /** A point on the hinge and the unit direction across it into this cut, box px, y down. */
  readonly hinge: readonly [number, number, number, number]
  /** The timing unit that opens it; -1 never moves. */
  readonly unit: number
  /** Paper thicknesses it lies above its parent when folded: the cuts folded in under it. */
  readonly layer: number
  /** Across each edge (top, bottom, left, right): the cut whose hinge it is, -1 for none. */
  readonly edges: readonly [number, number, number, number]
}

/** How the text block is cut, and the units that open one after another. */
export interface Sheet {
  readonly style: Style
  readonly cuts: readonly Cut[]
  /** Per unit, in opening order: its area (x0, y0, x1, y1, box px) and the hover reach, px. */
  readonly units: readonly (readonly [number, number, number, number, number])[]
  /** Accordion: the point that stays put, 0 left edge, 0.5 middle, 1 right edge. */
  readonly anchor: number
  /** Largest font size, px. */
  readonly em: number
}

/** A cut placed in 3D: box point (x, y down) lands at o + ax * x - ay * y, z towards the viewer. */
export interface Placed {
  readonly ax: Vec3
  readonly ay: Vec3
  /** The front's normal. */
  readonly az: Vec3
  readonly o: Vec3
  /** How closed the fold at each edge is, 0..1; positive where the fronts meet, negative the backs. */
  readonly creases: readonly [number, number, number, number]
}

/** Paper thickness, px: folded layers lie this far apart. */
const THICK = 0.6
/** Units start within this many durations at most; the pleats of an accordion nearly together. */
export const spreadOf = (style: Style): number => (style === 'accordion' ? 0.45 : 1.4)
/** Steepest a pleat of an accordion stands, radians: closed, it still shows its zig-zag. */
const PLEAT = (78 * Math.PI) / 180
/** Share of `angle` a unit folds under the pointer with the hover trigger. */
const HOVER = 0.28
/** Time the hover folds take to follow the pointer, s. */
const FOLLOW = 0.12
/** Light over the paper, from the top left, in the box frame (y up, z to the viewer). */
const LIGHT: Vec3 = [-0.42, 0.58, 0.7]
/** Light that reaches a face turned away from the lamp. */
const AMBIENT = 0.42
/** Darkest the soft shadow on the page gets. */
const SHADOW = 0.34
/** Side of the fibre tile, px. */
const FIBRE = 256

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const inOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

type Timing = { readonly stagger: number; readonly duration: number; readonly delay: number }

/** Seconds between neighbouring units: `stagger`, shrunk so all units start within `spread` durations. */
export const gapOf = (timing: Timing, units: number, spread: number): number =>
  units > 1
    ? Math.min(
        Math.max(0, timing.stagger),
        (Math.max(timing.duration, 0.05) * spread) / (units - 1),
      )
    : 0

/** Seconds from the trigger until the last unit lies flat. */
export const spanOf = (timing: Timing, units: number, spread: number): number =>
  Math.max(0, timing.delay) +
  Math.max(0, units - 1) * gapOf(timing, units, spread) +
  Math.max(timing.duration, 0.05)

/** The fold of every unit at `time` s after the trigger, radians: `angle` before, 0 once open. */
export function foldsAt(
  p: Timing & { readonly angle: number },
  units: number,
  spread: number,
  time: number,
  out: Float32Array = new Float32Array(units),
): Float32Array {
  const max = (Math.min(180, Math.max(0, p.angle)) * Math.PI) / 180
  const gap = gapOf(p, units, spread)
  const length = Math.max(p.duration, 0.05)
  for (let u = 0; u < units; u++) {
    const k = clamp01((time - Math.max(0, p.delay) - u * gap) / length)
    out[u] = max * (1 - inOut(k))
  }
  return out
}

type Box = readonly [number, number, number, number]

/** The ink of the raster's pieces: left, right, and per line its top, bottom and font size. */
function block(layout: Raster): { x0: number; x1: number; lines: [number, number, number][] } {
  const lines: [number, number, number][] = []
  let x0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  for (const q of layout.quads) {
    x0 = Math.min(x0, q.x)
    x1 = Math.max(x1, q.x + q.width)
    const line = lines.find((l) => Math.abs(l[0] - q.y) < 0.5)
    if (line) {
      line[1] = Math.max(line[1], q.y + q.height)
      line[2] = Math.max(line[2], q.em)
    } else lines.push([q.y, q.y + q.height, q.em])
  }
  lines.sort((a, b) => a[0] - b[0])
  return { x0, x1, lines }
}

/** Edges of horizontal bands over the lines: one per line, or `count` equal ones. */
function bandEdges(
  lines: readonly [number, number, number][],
  pad: number,
  count: number,
): number[] {
  const first = lines[0] as [number, number, number]
  const last = lines.at(-1) as [number, number, number]
  const top = first[0] - pad
  const bottom = last[1] + pad
  if (count > 0)
    return Array.from({ length: count + 1 }, (_, i) => top + ((bottom - top) * i) / count)
  const edges = [top]
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1] as [number, number, number]
    const b = lines[i] as [number, number, number]
    edges.push((a[1] + b[0]) / 2)
  }
  edges.push(bottom)
  return edges
}

type Corners = Cut['corners']
const rect = (x0: number, y0: number, x1: number, y1: number): Corners => [
  x0,
  y0,
  x1,
  y0,
  x0,
  y1,
  x1,
  y1,
]
/** A triangle as a cut's corners, turned so the corners run like a quad's. */
function tri(a: [number, number], b: [number, number], c: [number, number]): Corners {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const [p, q] = cross >= 0 ? [b, c] : [c, b]
  return [a[0], a[1], p[0], p[1], q[0], q[1], q[0], q[1]]
}
const boundsOf = (c: Corners): Box => [
  Math.min(c[0], c[2], c[4], c[6]),
  Math.min(c[1], c[3], c[5], c[7]),
  Math.max(c[0], c[2], c[4], c[6]),
  Math.max(c[1], c[3], c[5], c[7]),
]

/**
 * Cuts the text block for a style. `bands` 'auto' picks the cut from the text: a band per line for
 * strips and origami (three for a single line of strips), about an em per pleat for accordion.
 * `flaps` hangs every strip from the page instead of from the strip above, for hover.
 */
export function cut(
  r: Raster,
  style: Style,
  bands: number | 'auto',
  align: number,
  flaps = false,
): Sheet | undefined {
  if (!r.quads.length) return undefined
  const { x0: left, x1: right, lines } = block(r)
  const em = Math.max(1, ...r.quads.map((q) => q.em))
  const pad = em * 0.12
  const x0 = left - pad
  const x1 = right + pad
  // 0 means auto below; a written count cuts at least one band.
  const count = bands === 'auto' ? 0 : Math.max(1, Math.round(bands))
  const cuts: Cut[] = []
  const units: [number, number, number, number, number][] = []

  if (style === 'cards') {
    // A card per letter, hinged at the bottom of its line.
    const order = [...r.quads.keys()].sort(
      (a, b) => (r.quads[a]?.order ?? 0) - (r.quads[b]?.order ?? 0),
    )
    const unitOf = new Map<number, number>()
    for (const i of order) {
      const q = r.quads[i] as Raster['quads'][number]
      let unit = unitOf.get(q.order)
      if (unit === undefined) {
        unit = units.length
        unitOf.set(q.order, unit)
        units.push([q.x, q.y, q.x + q.width, q.y + q.height, q.em])
      } else {
        const u = units[unit] as [number, number, number, number, number]
        u[0] = Math.min(u[0], q.x)
        u[1] = Math.min(u[1], q.y)
        u[2] = Math.max(u[2], q.x + q.width)
        u[3] = Math.max(u[3], q.y + q.height)
      }
      const index = cuts.length
      cuts.push({
        corners: rect(q.x, q.y, q.x + q.width, q.y + q.height),
        parent: -1,
        hinge: [q.x, q.y + q.height, 0, -1],
        unit,
        layer: 1,
        edges: [-1, index, -1, -1],
      })
    }
    return { style, cuts, units, anchor: 0, em }
  }

  if (style === 'accordion') {
    // Vertical panels in pleats of two, rising then falling, opening from the anchor out.
    const height = (lines.at(-1)?.[1] ?? 0) - (lines[0]?.[0] ?? 0)
    const y0 = (lines[0]?.[0] ?? 0) - pad
    const y1 = y0 + height + 2 * pad
    const auto = 2 * Math.round((x1 - x0) / (em * 1.8))
    const panels = Math.max(2, Math.min(48, count || Math.max(4, Math.min(24, auto))))
    const panelWidth = (x1 - x0) / panels
    const pleats = Math.ceil(panels / 2)
    const middle = (pleats - 1) / 2
    const rank = [...Array(pleats).keys()].sort((a, b) =>
      align < 0.25
        ? a - b
        : align > 0.75
          ? b - a
          : Math.abs(a - middle) - Math.abs(b - middle) || a - b,
    )
    const unitOf = new Map(rank.map((pleat, unit) => [pleat, unit]))
    for (const pleat of rank) {
      const a = x0 + pleat * 2 * panelWidth
      units.push([a, y0, Math.min(x1, a + 2 * panelWidth), y1, panelWidth * 1.6])
    }
    for (let i = 0; i < panels; i++) {
      cuts.push({
        corners: rect(x0 + i * panelWidth, y0, x0 + (i + 1) * panelWidth, y1),
        parent: -1,
        hinge: [x0 + i * panelWidth, y0, 1, 0],
        unit: unitOf.get(Math.floor(i / 2)) ?? 0,
        layer: 1,
        edges: [-1, -1, i > 0 ? i : -1, i < panels - 1 ? i + 1 : -1],
      })
    }
    return { style, cuts, units, anchor: align, em }
  }

  const edges = bandEdges(lines, pad, count || (style === 'strips' && lines.length < 2 ? 3 : 0))
  const rows = edges.length - 1

  if (style === 'strips') {
    // Bands in a roll: each folded onto the front of the one above, the first fixed to the page,
    // or with `flaps` every band hung from the page at its top edge.
    for (let k = 0; k < rows; k++) {
      const top = edges[k] as number
      const bottom = edges[k + 1] as number
      const moving = flaps || k > 0
      if (moving) units.push([x0, top, x1, bottom, (bottom - top) * 0.6])
      cuts.push({
        corners: rect(x0, top, x1, bottom),
        parent: flaps ? -1 : k - 1,
        hinge: [x0, top, 0, 1],
        unit: moving ? units.length - 1 : -1,
        layer: flaps ? 1 : rows - k,
        edges: [moving ? k : -1, !flaps && k < rows - 1 ? k + 1 : -1, -1, -1],
      })
    }
    return { style, cuts, units, anchor: 0, em }
  }

  // Origami: each row in squares as tall as the row, centred on the text and reaching past its
  // ends, each square a diamond with its four corners folded in to the middle (they meet there
  // only in a square), opened clockwise from the top left.
  for (let k = 0; k < rows; k++) {
    const top = edges[k] as number
    const bottom = edges[k + 1] as number
    const rowHeight = bottom - top
    const cols = Math.max(1, Math.ceil((x1 - x0) / Math.max(rowHeight, 1) - 0.05))
    const cellWidth = rowHeight
    const start = (x0 + x1) / 2 - (cols * cellWidth) / 2
    for (let c = 0; c < cols; c++) {
      const cellLeft = start + c * cellWidth
      const cellRight = cellLeft + cellWidth
      const mid = (cellLeft + cellRight) / 2
      const topMid: [number, number] = [mid, top]
      const rightMid: [number, number] = [cellRight, (top + bottom) / 2]
      const bottomMid: [number, number] = [mid, bottom]
      const leftMid: [number, number] = [cellLeft, (top + bottom) / 2]
      const base = cuts.length
      // The diamond's edges: L-T top, B-R bottom, L-B left, T-R right.
      cuts.push({
        corners: [
          leftMid[0],
          leftMid[1],
          topMid[0],
          topMid[1],
          bottomMid[0],
          bottomMid[1],
          rightMid[0],
          rightMid[1],
        ],
        parent: -1,
        hinge: [cellLeft, top, 0, 1],
        unit: -1,
        layer: 0,
        edges: [base + 1, base + 3, base + 4, base + 2],
      })
      const flaps: [[number, number], [number, number], [number, number], number][] = [
        [[cellLeft, top], topMid, leftMid, 0],
        [[cellRight, top], rightMid, topMid, 3],
        [[cellRight, bottom], bottomMid, rightMid, 1],
        [[cellLeft, bottom], leftMid, bottomMid, 2],
      ]
      flaps.forEach(([corner, p, q], j) => {
        const unit = units.length
        const bounds = boundsOf(tri(corner, p, q))
        units.push([...bounds, Math.max(cellWidth, rowHeight) * 0.35])
        // Across the hinge p-q towards the corner.
        const dx = q[0] - p[0]
        const dy = q[1] - p[1]
        const len = Math.hypot(dx, dy) || 1
        let normalX = -dy / len
        let normalY = dx / len
        if ((corner[0] - p[0]) * normalX + (corner[1] - p[1]) * normalY < 0) {
          normalX = -normalX
          normalY = -normalY
        }
        const corners = tri(corner, p, q)
        // The hinge is the edge without the cell's corner: right (1-3) or left (0-2) of the quad.
        const onRight = corners[0] === corner[0] && corners[1] === corner[1]
        cuts.push({
          corners,
          parent: base,
          hinge: [p[0], p[1], normalX, normalY],
          unit,
          layer: 4 - j,
          edges: onRight ? [-1, -1, -1, base + 1 + j] : [-1, -1, base + 1 + j, -1],
        })
      })
    }
  }
  return { style, cuts, units, anchor: 0, em }
}

type Mat = [Vec3, Vec3, Vec3]
const IDENTITY: Mat = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const apply = (m: Mat, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
]
const compose = (a: Mat, b: Mat): Mat => [apply(a, b[0]), apply(a, b[1]), apply(a, b[2])]
/** Rotation by `angle` about the unit `axis`, as columns. */
function turn(axis: Vec3, angle: number): Mat {
  const cosAngle = Math.cos(angle)
  const sinAngle = Math.sin(angle)
  const r = (v: Vec3): Vec3 => {
    const k = (axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2]) * (1 - cosAngle)
    return [
      v[0] * cosAngle + (axis[1] * v[2] - axis[2] * v[1]) * sinAngle + axis[0] * k,
      v[1] * cosAngle + (axis[2] * v[0] - axis[0] * v[2]) * sinAngle + axis[1] * k,
      v[2] * cosAngle + (axis[0] * v[1] - axis[1] * v[0]) * sinAngle + axis[2] * k,
    ]
  }
  return [r([1, 0, 0]), r([0, 1, 0]), r([0, 0, 1])]
}
const closed = (angle: number): number => (1 - Math.cos(angle)) / 2

/**
 * Every cut of the sheet in 3D for the folds of its units (radians, 0 flat). A cut turns on its
 * hinge towards its parent's front, carrying the cuts that hang from it.
 */
export function place(sheet: Sheet, folds: ArrayLike<number>): Placed[] {
  const { cuts } = sheet
  const fold = (c: Cut): number => (c.unit >= 0 ? (folds[c.unit] ?? 0) : 0)
  const out: Placed[] = []
  if (sheet.style === 'accordion') {
    // Panel i turns about its upright left edge, rising for even i and falling for odd i.
    const count = cuts.length
    const xs: number[] = [0]
    const zs: number[] = [0]
    const tilt = cuts.map((c, i) => (i % 2 ? -1 : 1) * Math.min(fold(c) * 0.5, PLEAT))
    for (let i = 0; i < count; i++) {
      const cut = cuts[i] as Cut
      const width = cut.corners[2] - cut.corners[0]
      xs.push((xs[i] as number) + width * Math.cos(tilt[i] as number))
      zs.push((zs[i] as number) + width * Math.sin(tilt[i] as number))
    }
    const first = cuts[0] as Cut
    const last = cuts[count - 1] as Cut
    const from = first.corners[0]
    const width = last.corners[2] - from
    const shift = from + (width - (xs[count] as number)) * sheet.anchor
    const low = Math.min(...zs)
    for (let i = 0; i < count; i++) {
      const cut = cuts[i] as Cut
      const tiltAngle = tilt[i] as number
      const rotation: Mat = [
        [Math.cos(tiltAngle), 0, Math.sin(tiltAngle)],
        [0, 1, 0],
        [-Math.sin(tiltAngle), 0, Math.cos(tiltAngle)],
      ]
      const at: Vec3 = [shift + (xs[i] as number), 0, (zs[i] as number) - low]
      const left = apply(rotation, [cut.corners[0], 0, 0])
      const peak = (j: number): number => closed(Math.abs(tilt[j] ?? 0) * 2)
      const valley = (j: number): number =>
        j < 0 || j >= count ? 0 : closed(Math.abs(tilt[j] ?? 0) + Math.abs(tilt[j + 1] ?? 0))
      // Valleys hold the fronts, peaks the backs.
      const before = i === 0 ? 0 : i % 2 ? -peak(i) : valley(i - 1)
      const after = i === count - 1 ? 0 : i % 2 ? valley(i) : -peak(i)
      out.push({
        ax: rotation[0],
        ay: rotation[1],
        az: rotation[2],
        o: [at[0] - left[0], at[1] - left[1], at[2] - left[2]],
        creases: [0, 0, before, after],
      })
    }
    return out
  }
  for (const c of cuts) {
    const parent = c.parent >= 0 ? (out[c.parent] as Placed) : undefined
    const parentRotation: Mat = parent ? [parent.ax, parent.ay, parent.az] : IDENTITY
    const parentOrigin: Vec3 = parent ? parent.o : [0, 0, 0]
    const angle = fold(c)
    let rotation = parentRotation
    let origin = parentOrigin
    if (angle !== 0) {
      const hinge: Vec3 = [c.hinge[0], -c.hinge[1], 0]
      const hingeDir: Vec3 = [c.hinge[2], -c.hinge[3], 0]
      const hingeTurn = turn([hingeDir[1], -hingeDir[0], 0], angle)
      const turnedHinge = apply(hingeTurn, hinge)
      const lift = THICK * c.layer * closed(angle)
      const local: Vec3 = [
        hinge[0] - turnedHinge[0],
        hinge[1] - turnedHinge[1],
        hinge[2] - turnedHinge[2] + lift,
      ]
      const moved = apply(parentRotation, local)
      rotation = compose(parentRotation, hingeTurn)
      origin = [parentOrigin[0] + moved[0], parentOrigin[1] + moved[1], parentOrigin[2] + moved[2]]
    }
    const creases = c.edges.map((j) => (j >= 0 ? closed(fold(cuts[j] as Cut)) : 0)) as [
      number,
      number,
      number,
      number,
    ]
    out.push({ ax: rotation[0], ay: rotation[1], az: rotation[2], o: origin, creases })
  }
  return out
}

/**
 * The order to paint the cuts in, back to front, for an eye at `eye` (element frame). A cut's
 * children fold to its front: they go after it when the eye is on that side, before it otherwise.
 * Siblings go by their height over the parent's plane, then the farthest from the eye first.
 */
export function paint(sheet: Sheet, placed: readonly Placed[], eye: Vec3): number[] {
  const { cuts } = sheet
  const centre = cuts.map((c, i) => {
    const piece = placed[i] as Placed
    const k = c.corners
    const centrePoint = at(piece, (k[0] + k[2] + k[4] + k[6]) / 4, (k[1] + k[3] + k[5] + k[7]) / 4)
    return centrePoint
  })
  const far = centre.map((c) => Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]))
  const out: number[] = []
  if (sheet.style === 'accordion') {
    out.push(...cuts.keys())
    return out.sort((a, b) => (far[b] as number) - (far[a] as number) || a - b)
  }
  const children: number[][] = cuts.map(() => [])
  const roots: number[] = []
  cuts.forEach((c, i) => {
    if (c.parent >= 0) children[c.parent]?.push(i)
    else roots.push(i)
  })
  const above = (i: number, parent: Placed | undefined): number => {
    const c = centre[i] as Vec3
    if (!parent) return c[2]
    return (
      (c[0] - parent.o[0]) * parent.az[0] +
      (c[1] - parent.o[1]) * parent.az[1] +
      (c[2] - parent.o[2]) * parent.az[2]
    )
  }
  const siblings = (list: number[], parent: Placed | undefined): number[] =>
    list
      .map((i) => ({ i, h: above(i, parent) }))
      .sort((a, b) => a.h - b.h || (far[b.i] as number) - (far[a.i] as number) || a.i - b.i)
      .map((e) => e.i)
  const visit = (i: number): void => {
    const piece = placed[i] as Placed
    const kids = siblings(children[i] as number[], piece)
    const seen =
      (eye[0] - piece.o[0]) * piece.az[0] +
        (eye[1] - piece.o[1]) * piece.az[1] +
        (eye[2] - piece.o[2]) * piece.az[2] >=
      0
    if (seen) {
      out.push(i)
      for (const k of kids) visit(k)
    } else {
      for (const k of kids.reverse()) visit(k)
      out.push(i)
    }
  }
  for (const r of siblings(roots, undefined)) visit(r)
  return out
}

/** A corner of a placed cut, element frame (y up, origin at the box's top left). */
const at = (p: Placed, x: number, y: number): Vec3 => [
  p.o[0] + p.ax[0] * x - p.ay[0] * y,
  p.o[1] + p.ax[1] * x - p.ay[1] * y,
  p.o[2] + p.ax[2] * x - p.ay[2] * y,
]

/** A tile of paper fibres and cloudy formation, grey around 0.5. */
function fibres(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = FIBRE
  canvas.height = FIBRE
  const context = canvas.getContext('2d')
  if (!context) return canvas
  try {
    const random = rng(11)
    context.fillStyle = 'rgb(128,128,128)'
    context.fillRect(0, 0, FIBRE, FIBRE)
    const wrap = (draw: (dx: number, dy: number) => void): void => {
      for (const dx of [-FIBRE, 0, FIBRE]) for (const dy of [-FIBRE, 0, FIBRE]) draw(dx, dy)
    }
    for (let i = 0; i < 46; i++) {
      const x = random() * FIBRE
      const y = random() * FIBRE
      const radius = 18 + random() * 46
      const light = random() < 0.5
      wrap((dx, dy) => {
        const grad = context.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, radius)
        grad.addColorStop(0, light ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)')
        grad.addColorStop(1, 'rgba(128,128,128,0)')
        context.fillStyle = grad
        context.fillRect(x + dx - radius, y + dy - radius, 2 * radius, 2 * radius)
      })
    }
    for (let i = 0; i < 340; i++) {
      const x = random() * FIBRE
      const y = random() * FIBRE
      const angle = random() * Math.PI * 2
      const length = 6 + random() ** 2 * 34
      const bend = (random() - 0.5) * length * 0.6
      const endX = x + Math.cos(angle) * length
      const endY = y + Math.sin(angle) * length
      const controlX = (x + endX) / 2 - Math.sin(angle) * bend
      const controlY = (y + endY) / 2 + Math.cos(angle) * bend
      context.lineWidth = 0.5 + random() * 0.9
      context.strokeStyle =
        random() < 0.6
          ? `rgba(255,255,255,${0.1 + random() * 0.16})`
          : `rgba(0,0,0,${0.06 + random() * 0.1})`
      wrap((dx, dy) => {
        context.beginPath()
        context.moveTo(x + dx, y + dy)
        context.quadraticCurveTo(controlX + dx, controlY + dy, endX + dx, endY + dy)
        context.stroke()
      })
    }
  } catch {
    // A canvas without paths or gradients keeps the plain grey.
  }
  return canvas
}

/** Instance attributes of one batch of quads, rewritten each frame. */
class Batch {
  readonly geometry = new InstancedBufferGeometry()
  readonly attrs: Record<string, InstancedBufferAttribute> = {}
  constructor(capacity: number, layout: Record<string, number>) {
    const shared = this.geometry
    shared.setIndex([0, 2, 1, 2, 3, 1])
    const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
    shared.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
    const slots = Math.max(1, capacity)
    for (const [name, size] of Object.entries(layout)) {
      const attr = new InstancedBufferAttribute(new Float32Array(slots * size), size)
      attr.setUsage(DynamicDrawUsage)
      shared.setAttribute(name, attr)
      this.attrs[name] = attr
    }
    shared.instanceCount = 0
  }
  set(name: string, i: number, values: ArrayLike<number>): void {
    const attr = this.attrs[name] as InstancedBufferAttribute
    ;(attr.array as Float32Array).set(values, i * attr.itemSize)
  }
  commit(count: number): void {
    for (const attr of Object.values(this.attrs)) attr.needsUpdate = true
    this.geometry.instanceCount = count
  }
}

const CUT_LAYOUT = {
  foldCornerA: 4,
  foldCornerB: 4,
  foldAxisX: 3,
  foldAxisY: 3,
  foldOrigin: 3,
  foldCrease: 4,
  foldLook: 4,
}
const SHADE_LAYOUT = { shadeCornerA: 4, shadeCornerB: 4, shadePlane: 4, shadeBox: 4 }

const colorParam = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/**
 * The headline unfolds out of the page like paper: cut into strips, a zig-zag band, a card per
 * letter or folded squares, hinged together and opened one after another in perspective, with
 * paper backs, crease shading and soft shadows on the page. Once flat it is DOM text again.
 */
const unfold: Effect<Params> = defineEffect({
  name: 'unfold',
  params: {
    style: oneOf('strips', 'accordion', 'cards', 'origami'),
    trigger: oneOf('view', 'scroll', 'hover'),
    bands: 'auto',
    angle: 180,
    duration: 0.9,
    stagger: 0.3,
    paper: colorParam('#f8f5ee'),
    shade: 0.7,
    delay: 0,
    threshold: 0.2,
  },
  rebuild: ['bands'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  reducedMotion: 'off',
  bleed: 200,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal, render } = ctx
    const { stage } = app
    const { style, trigger } = params
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
    // As in text-reveal: text the visitor has seen as DOM stays, veiled text has not been seen,
    // a hovered heading starts as DOM text.
    const veiled = (): boolean =>
      trigger === 'view' && element.getAttribute('data-dio-state') === 'entering'
    let seen = trigger === 'hover' || (onScreen() && !veiled())
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const ratio = ctx.quality === 'low' ? 1 : 2
    const by = style === 'cards' ? 'letter' : 'line'
    const reason = unsupported(element) ?? (await fonts(element))
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()
    if (reason) {
      if (DEV) app.log.warn(`unfold: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    const alignOf = (): number => {
      const align = getComputedStyle(element).textAlign
      const rtl = getComputedStyle(element).direction === 'rtl'
      if (align === 'center' || align === '-webkit-center') return 0.5
      if (align === 'right' || (rtl && align === 'start') || (!rtl && align === 'end')) return 1
      return 0
    }
    const sheetOf = (r: Raster): Sheet | undefined =>
      cut(r, style, params.bands, alignOf(), trigger === 'hover')
    let layout = raster(element, by, ratio)
    let sheet = layout ? sheetOf(layout) : undefined
    if (!layout || !sheet) {
      ctx.showDom(true)
      return
    }

    // The page behind: the panels' fronts take its color, so they vanish into it when flat. On a
    // picture or gradient the fronts are clear and turn to paper as they lift.
    const behind = backdrop(element.parentElement ?? element)?.color
    const fillColor = uniform(behind ? linear(behind) : new Color(1, 1, 1))
    const fillAlpha = uniform(behind ? 1 : 0)
    const frame = uniform(new Vector4(...layout.frame))
    const centre = uniform(new Vector2())
    const eye = uniform(1200)
    const distance = uniform(render.camera.position.z || 1000)
    const half = u.size.mul(0.5)
    const light = normalize(vec3(...LIGHT))

    const map = texture(atlasOf(layout.canvas))
    map.mergeable = false
    const fibreCanvas = fibres()
    const fibreMap = new CanvasTexture(fibreCanvas)
    fibreMap.wrapS = fibreMap.wrapT = RepeatWrapping
    ctx.onDispose(() => {
      ;(map.value as Texture).dispose()
      fibreMap.dispose()
    })

    /** From the element frame (y up, top left origin) to drawn, with the eye `eye` px away. */
    const project = (world: V3): { drawn: V3; box: V2 } => {
      const local = vec3(world.x.sub(half.x), world.y.add(half.y), world.z)
      const z = local.z.mul(distance).div(eye)
      const drawn = vec3(local.xy.sub(centre.mul(z).div(distance)), z) as unknown as V3
      // Where it lands on screen, box px y down: for the mask.
      const k = distance.div(max(distance.sub(z), 1))
      const screen = centre.add(drawn.xy).mul(k).sub(centre)
      return { drawn, box: vec2(screen.x.add(half.x), half.y.sub(screen.y)) as unknown as V2 }
    }
    /** The mask half a pixel inside the box, where it is whole. */
    const maskAt = (point: V2): F =>
      ctx.mask(
        vec2(
          point.x.clamp(0.5, u.size.x.sub(0.5)).div(u.size.x),
          point.y.clamp(0.5, u.size.y.sub(0.5)).div(u.size.y).oneMinus(),
        ) as unknown as V2,
      ) as unknown as F

    // The paper.
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    material.forceSinglePass = true
    {
      const cornersA = attribute('foldCornerA', 'vec4') as unknown as V4
      const cornersB = attribute('foldCornerB', 'vec4') as unknown as V4
      const ax = attribute('foldAxisX', 'vec3') as unknown as V3
      const ay = attribute('foldAxisY', 'vec3') as unknown as V3
      const origin = attribute('foldOrigin', 'vec3') as unknown as V3
      const crease = attribute('foldCrease', 'vec4') as unknown as V4
      const look = attribute('foldLook', 'vec4') as unknown as V4
      const corner = positionGeometry.xy.add(0.5)
      const across = corner.x
      const down = corner.y.oneMinus()
      const sheetPoint = mix(
        mix(cornersA.xy, cornersA.zw, across),
        mix(cornersB.xy, cornersB.zw, across),
        down,
      ) as unknown as V2
      const world = origin.add(ax.mul(sheetPoint.x)).sub(ay.mul(sheetPoint.y)) as unknown as V3
      const { drawn, box } = project(world)
      material.positionNode = drawn
      /** Distance from sheetPoint to the line through a and b, px; far for a corner repeated. */
      const line = (a: V2, b: V2): F => {
        const e = b.sub(a)
        const len = length(e)
        return select(
          len.greaterThan(1e-3),
          abs(e.x.mul(sheetPoint.y.sub(a.y)).sub(e.y.mul(sheetPoint.x.sub(a.x)))).div(
            max(len, 1e-3),
          ),
          1e5,
        ) as unknown as F
      }
      const edge = varying(
        vec4(
          line(cornersA.xy, cornersA.zw),
          line(cornersB.xy, cornersB.zw),
          line(cornersA.xy, cornersB.xy),
          line(cornersA.zw, cornersB.zw),
        ),
      ) as unknown as V4
      const at = varying(sheetPoint) as unknown as V2
      const screen = varying(box) as unknown as V2
      const front = varying(normalize(cross(ax, ay))) as unknown as V3
      const point = varying(
        vec3(world.x.sub(half.x), world.y.add(half.y), world.z),
      ) as unknown as V3
      const tangentX = varying(ax) as unknown as V3
      const tangentY = varying(ay) as unknown as V3
      const creaseV = varying(crease) as unknown as V4
      const lookV = varying(look) as unknown as V4
      const lift = lookV.y

      const uvOf = (q: V2): V2 =>
        vec2(
          q.x.sub(frame.x).div(frame.z),
          q.y.sub(frame.y).div(frame.w).oneMinus(),
        ) as unknown as V2
      const texel = texture(map, uvOf(at)) as unknown as V4
      const ink = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4)) as never) as unknown as V3
      const frontNormal = normalize(front)
      const normal = select(frontFacing, frontNormal, frontNormal.negate()) as unknown as V3
      const strength = u.shade.clamp(0, 1)
      // The fibres: a height field that shades the back and catches the light as it turns.
      const fib = (q: V2): F => texture(fibreMap, q.div(FIBRE)).r as unknown as F
      const fiber = fib(at)
      const fiberSlopeX = fib(at.add(vec2(1.5, 0))).sub(fiber)
      const fiberSlopeY = fib(at.add(vec2(0, 1.5))).sub(fiber)
      const bumped = normalize(
        normal.sub(
          tangentX
            .mul(fiberSlopeX)
            .sub(tangentY.mul(fiberSlopeY))
            .mul(select(frontFacing, 0, 0.7)),
        ),
      ) as unknown as V3
      // Lambert over the same lamp on a face turned to the viewer: exactly 1 flat, the DOM's color.
      const lambert = (m: V3): F =>
        max(dot(m, light), 0)
          .mul(1 - AMBIENT)
          .add(AMBIENT)
          .div(light.z.mul(1 - AMBIENT).add(AMBIENT)) as unknown as F
      const lit = mix(float(1), min(lambert(bumped), 1.12), strength)
      const view = normalize(vec3(0, 0, eye).sub(point))
      const halfway = normalize(light.add(view))
      const sheen = pow(max(dot(bumped, halfway), 0), 20)
        .mul(0.1)
        .mul(strength)
        .mul(lift)
      // Folds darken towards a crease on the side that closes in on itself.
      const occlusion = (k: F, d: F): F =>
        max(select(frontFacing, k, k.negate()), 0).mul(
          exp(d.negate().div(max(lookV.x, 1))),
        ) as unknown as F
      const open = occlusion(creaseV.x, edge.x)
        .oneMinus()
        .mul(occlusion(creaseV.y, edge.y).oneMinus())
        .mul(occlusion(creaseV.z, edge.z).oneMinus())
        .mul(occlusion(creaseV.w, edge.w).oneMinus())
      const shade = lit.mul(open.oneMinus().mul(strength.mul(0.7)).oneMinus())
      // Front: the page's color (or paper while lifted) with the letters on it.
      const baseA = max(fillAlpha, lift)
      const base = mix(u.paper, fillColor, fillAlpha) as unknown as V3
      const frontA = texel.a.add(baseA.mul(texel.a.oneMinus()))
      const frontRgb = ink
        .mul(texel.a)
        .add(base.mul(baseA).mul(texel.a.oneMinus()))
        .div(max(frontA, 1e-4))
      // Back: paper with its fibres, the letters showing through a little.
      const backRgb = u.paper.mul(fiber.sub(0.5).mul(0.08).add(1)).mul(texel.a.mul(-0.05).add(1))
      // The cut edges of paper off the page darken a little over a pixel and a half, so pieces
      // lying on each other read apart.
      const near = min(min(edge.x, edge.y), min(edge.z, edge.w))
      const rim = smoothstep(0, max(fwidth(near).mul(1.5), 1e-3), near)
        .oneMinus()
        .mul(0.16)
        .mul(lift.clamp(0, 1))
      const rgb = select(frontFacing, frontRgb, backRgb)
        .mul(shade)
        .mul(rim.oneMinus())
        .add(sheen) as unknown as V3
      const alpha = select(frontFacing, frontA, float(1)) as unknown as F
      material.colorNode = vec4(rgb, alpha.mul(maskAt(screen)))
    }

    // The soft shadows the raised paper casts on the page.
    const shadowMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    })
    {
      const cornersA = attribute('shadeCornerA', 'vec4') as unknown as V4
      const cornersB = attribute('shadeCornerB', 'vec4') as unknown as V4
      const plane = attribute('shadePlane', 'vec4') as unknown as V4
      const bounds = attribute('shadeBox', 'vec4') as unknown as V4
      const corner = positionGeometry.xy.add(0.5)
      const shadowX = mix(bounds.x, bounds.z, corner.x)
      const shadowY = mix(bounds.y, bounds.w, corner.y.oneMinus())
      const { drawn } = project(vec3(shadowX, shadowY.negate(), 0) as unknown as V3)
      shadowMaterial.positionNode = drawn
      const point = varying(vec2(shadowX, shadowY)) as unknown as V2
      const cornerA = varying(cornersA) as unknown as V4
      const cornerB = varying(cornersB) as unknown as V4
      const planeV = varying(plane) as unknown as V4
      // Signed distance outside each edge of the outline, corners in order.
      const side = (from: V2, to: V2): F => {
        const e = to.sub(from)
        const len = length(e)
        return select(
          len.greaterThan(1e-3),
          dot(point.sub(from), vec2(e.y, e.x.negate()).div(max(len, 1e-3))),
          -1e5,
        ) as unknown as F
      }
      const distance = max(
        max(side(cornerA.xy, cornerA.zw), side(cornerA.zw, cornerB.xy)),
        max(side(cornerB.xy, cornerB.zw), side(cornerB.zw, cornerA.xy)),
      )
      // The height over the page, extrapolated past the outline no higher than its top corner.
      const height = dot(planeV.xy, point).add(planeV.z).clamp(0, planeV.w)
      const r = height.mul(0.3).add(2)
      const cover = smoothstep(r.negate(), r, distance).oneMinus()
      const alpha = cover
        .mul(SHADOW)
        .mul(smoothstep(0, 3, height))
        .div(height.div(260).add(1))
      // Premultiplied black: the maximum keeps the darkest shadow's alpha and the color below.
      shadowMaterial.colorNode = vec4(vec3(0), alpha.mul(maskAt(point)))
    }

    const capacity = (s: Sheet): number => s.cuts.length
    let flat = new Batch(capacity(sheet), CUT_LAYOUT)
    let raised = new Batch(capacity(sheet), CUT_LAYOUT)
    let shades = new Batch(capacity(sheet), SHADE_LAYOUT)
    const flatMesh = new Mesh(flat.geometry, material)
    const raisedMesh = new Mesh(raised.geometry, material)
    const shadowMesh = new Mesh(shades.geometry, shadowMaterial)
    // Shadows first, blended by their maximum so overlapping ones do not add up; paper lying flat
    // on the page covers them, raised paper comes after.
    shadowMesh.renderOrder = -1
    flatMesh.renderOrder = 0
    raisedMesh.renderOrder = 2
    const group = new Group()
    for (const mesh of [flatMesh, shadowMesh, raisedMesh]) {
      // The vertices are placed in the shader, far from the unit quad the bounds come from.
      mesh.frustumCulled = false
      group.add(mesh)
    }
    ctx.place(group, { fit: 'none', replace: true })
    // One empty instance each, so the compile builds the pipelines of draws with instances.
    for (const b of [flat, raised, shades]) b.geometry.instanceCount = 1
    await ctx.compile(group)
    for (const b of [flat, raised, shades]) b.geometry.instanceCount = 0
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()

    const use = (next: Raster): void => {
      const nextSheet = sheetOf(next)
      if (!nextSheet) return
      const old = map.value as Texture
      map.value = atlasOf(next.canvas)
      old.dispose()
      frame.value.set(...next.frame)
      if (capacity(nextSheet) > capacity(sheet as Sheet)) {
        for (const [b, mesh] of [
          [flat, flatMesh],
          [raised, raisedMesh],
          [shades, shadowMesh],
        ] as const) {
          b.geometry.dispose()
          const fresh = new Batch(capacity(nextSheet), b === shades ? SHADE_LAYOUT : CUT_LAYOUT)
          mesh.geometry = fresh.geometry
          if (b === flat) flat = fresh
          else if (b === raised) raised = fresh
          else shades = fresh
        }
      }
      layout = next
      sheet = nextSheet
      lifts = new Float32Array(nextSheet.units.length)
      folds = new Float32Array(nextSheet.units.length)
    }

    /** Writes the paper for the folds of the units; false when everything lies flat. */
    const draw = (now: Float32Array, input: EffectInput): boolean => {
      const current = sheet as Sheet
      let any = false
      for (const f of now) if (f > 1e-4) any = true
      if (!any) {
        for (const b of [flat, raised, shades]) b.commit(0)
        return false
      }
      const placed = place(current, now)
      const eyeDistance = eyeOf(input.width, input.height)
      let flats = 0
      let ups = 0
      let shadows = 0
      for (const i of paint(current, placed, [input.width / 2, -input.height / 2, eyeDistance])) {
        const piece = placed[i] as Placed
        const corners = (current.cuts[i] as Cut).corners
        const z: [Vec3, Vec3, Vec3, Vec3] = [
          at(piece, corners[0], corners[1]),
          at(piece, corners[2], corners[3]),
          at(piece, corners[4], corners[5]),
          at(piece, corners[6], corners[7]),
        ]
        const top = Math.max(...z.map((v) => v[2]))
        if (piece.az[2] > 0.99999 && top < 0.05 && Math.min(...z.map((v) => v[2])) > -0.05) {
          write(flat, flats++, current, i, piece, 0)
          continue
        }
        write(raised, ups++, current, i, piece, clamp01((1 - piece.az[2]) * 6 + 0.35))
        if (top > 0.4) shadow(shades, shadows++, z)
      }
      flat.commit(flats)
      raised.commit(ups)
      shades.commit(shadows)
      const world = render.toWorld(input.x + input.width / 2, input.y + input.height / 2)
      ;(centre.value as Vector2).set(world.x, world.y)
      eye.value = eyeDistance
      distance.value = render.camera.position.z || distance.value
      return true
    }

    let dom = false
    const show = (value: boolean): void => {
      dom = value
      ctx.showDom(value)
    }
    const units = (): number => (sheet as Sheet).units.length
    const spread = spreadOf(style)
    const total = (): number => spanOf(ctx.params, units(), spread)
    let folds = new Float32Array(units())
    let lifts = new Float32Array(units())
    if (seen) show(true)

    // Raster again when the text, its fonts or its width change.
    let cancel: (() => void) | undefined
    const redo = async (): Promise<void> => {
      cancel = undefined
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, by, ratio)
      if (!next) return
      use(next)
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

    // Hover: the pointer in box px, or a tap held for a moment on touch screens.
    let pointer: { x: number; y: number } | undefined
    let tap: ReturnType<typeof setTimeout> | undefined
    ctx.onDispose(() => clearTimeout(tap))
    if (trigger === 'hover') {
      const aim = (e: PointerEvent): void => {
        const rect = element.getBoundingClientRect()
        pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        ctx.invalidate()
      }
      const listen = (type: string, fn: (e: PointerEvent) => void): void =>
        element.addEventListener(type, fn as EventListener, { signal, passive: true })
      listen('pointermove', (e) => e.pointerType !== 'touch' && aim(e))
      listen('pointerleave', (e) => {
        if (e.pointerType === 'touch') return
        pointer = undefined
        ctx.invalidate()
      })
      listen('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return
        aim(e)
        clearTimeout(tap)
        tap = setTimeout(() => {
          pointer = undefined
          ctx.invalidate()
        }, 450)
      })
    }

    let elapsed = -1
    return (input): boolean => {
      const live = ctx.params
      const { y, height, progress, presence } = input
      const last = total()
      const viewport = stage.height.peek()
      const count = units()
      if (folds.length !== count) folds = new Float32Array(count)
      let time: number
      let busy = false
      if (trigger === 'scroll') {
        // From `threshold` of the box in view to the box centred in the viewport, scrubbed.
        const through = entering(progress, height, viewport, live.threshold)
        if (seen && through < 1) time = last
        else {
          seen = false
          time = Math.max(0, live.delay) + through * (last - Math.max(0, live.delay))
        }
      } else if (trigger === 'hover') {
        time = last
      } else {
        if (!seen && elapsed < 0) {
          // Counted above the bottom tenth of the viewport, like `reveal`.
          if (inView(y, height, viewport, live.threshold)) {
            elapsed = 0
            busy = true
          }
        } else if (elapsed >= 0 && elapsed < last) {
          elapsed += input.delta
          busy = elapsed < last
        }
        time = seen ? last : Math.max(elapsed, 0)
      }
      // A page transition folds the paper back up as it leaves and opens it as it enters.
      foldsAt(live, count, spread, Math.min(time, presence * last), folds)
      if (trigger === 'hover') {
        if (lifts.length !== count) lifts = new Float32Array(count)
        const current = sheet as Sheet
        const most = (Math.min(180, Math.max(0, live.angle)) * Math.PI * HOVER) / 180
        for (let k = 0; k < count; k++) {
          const unit = current.units[k] as Sheet['units'][number]
          let goal = 0
          if (pointer && !input.reducedMotion) {
            const dx = Math.max(unit[0] - pointer.x, 0, pointer.x - unit[2])
            const dy = Math.max(unit[1] - pointer.y, 0, pointer.y - unit[3])
            const distance = Math.hypot(dx, dy) / Math.max(unit[4], 1)
            goal = most * (1 - clamp01(distance) ** 2) ** 2
          }
          lifts[k] = damp(lifts[k] as number, goal, FOLLOW, input.delta, 1e-3)
          if (lifts[k] !== goal) busy = true
          folds[k] = Math.max(folds[k] as number, lifts[k] as number)
        }
      }
      const drawn = draw(folds, input)
      show(!drawn && presence >= 1)
      return busy || (trigger !== 'scroll' && elapsed >= 0 && elapsed < last)
    }
  },
})
export default unfold

/** Distance of the eye from the paper, px: a perspective like CSS `perspective` on the box. */
export const eyeOf = (width: number, height: number): number =>
  Math.max(900, 1.25 * Math.max(width, height))

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
function atlasOf(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  return map
}

/** Writes one placed cut into a batch; `lift` 0..1 turns the clear front to paper and softens edges. */
function write(
  batch: Batch,
  k: number,
  current: Sheet,
  i: number,
  piece: Placed,
  lift: number,
): void {
  const corners = (current.cuts[i] as Cut).corners
  batch.set('foldCornerA', k, [corners[0], corners[1], corners[2], corners[3]])
  batch.set('foldCornerB', k, [corners[4], corners[5], corners[6], corners[7]])
  batch.set('foldAxisX', k, piece.ax)
  batch.set('foldAxisY', k, piece.ay)
  batch.set('foldOrigin', k, piece.o)
  batch.set('foldCrease', k, piece.creases)
  const [x0, y0, x1, y1] = boundsOf(corners)
  // Crease shadows reach about a third of the panel across.
  const reach = Math.min(Math.max(4, 0.32 * Math.min(x1 - x0, y1 - y0)), 70)
  batch.set('foldLook', k, [reach, lift, 0, 0])
}

/** Writes the shadow of a raised cut, its corners in the element frame, onto the page. */
function shadow(batch: Batch, k: number, corners: Vec3[]): void {
  const light = LIGHT
  const len = Math.hypot(...light)
  const lightX = light[0] / len
  const lightY = light[1] / len
  const lightZ = light[2] / len
  // Along the light onto z = 0, in box px (y down), with the height above the page.
  const drop = corners.map((v) => {
    const height = Math.max(0, v[2])
    return [
      v[0] - (lightX * height) / lightZ,
      -(v[1] - (lightY * height) / lightZ),
      height,
    ] as const
  })
  // Outline in order round the quad: 0, 1, 3, 2; clockwise on screen.
  let ring = [drop[0], drop[1], drop[3], drop[2]] as (typeof drop)[number][]
  let area = 0
  for (let i = 0; i < 4; i++) {
    const a = ring[i] as (typeof drop)[number]
    const c = ring[(i + 1) % 4] as (typeof drop)[number]
    area += a[0] * c[1] - c[0] * a[1]
  }
  if (area < 0) ring = ring.reverse()
  const [r0, r1, r2, r3] = ring as [
    (typeof drop)[number],
    (typeof drop)[number],
    (typeof drop)[number],
    (typeof drop)[number],
  ]
  batch.set('shadeCornerA', k, [r0[0], r0[1], r1[0], r1[1]])
  batch.set('shadeCornerB', k, [r2[0], r2[1], r3[0], r3[1]])
  // The height over the outline as a plane through three corners that span it.
  const pick = (a: number, c: number, e: number): number[] | undefined => {
    const p = drop[a] as (typeof drop)[number]
    const q = drop[c] as (typeof drop)[number]
    const r = drop[e] as (typeof drop)[number]
    const ux = q[0] - p[0]
    const uy = q[1] - p[1]
    const vx = r[0] - p[0]
    const vy = r[1] - p[1]
    const det = ux * vy - uy * vx
    if (Math.abs(det) < 4) return undefined
    const du = q[2] - p[2]
    const dv = r[2] - p[2]
    const a1 = (du * vy - dv * uy) / det
    const b1 = (dv * ux - du * vx) / det
    return [a1, b1, p[2] - a1 * p[0] - b1 * p[1]]
  }
  const mean = drop.reduce((n, v) => n + v[2], 0) / 4
  const top = Math.max(...drop.map((v) => v[2]))
  batch.set('shadePlane', k, [
    ...(pick(0, 1, 2) ?? pick(0, 1, 3) ?? pick(1, 3, 2) ?? [0, 0, mean]),
    top,
  ])
  // Past the blur at the top corner.
  const m = top * 0.3 + 4
  batch.set('shadeBox', k, [
    Math.min(...drop.map((v) => v[0])) - m,
    Math.min(...drop.map((v) => v[1])) - m,
    Math.max(...drop.map((v) => v[0])) + m,
    Math.max(...drop.map((v) => v[1])) + m,
  ])
}
