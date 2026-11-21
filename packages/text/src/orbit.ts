import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp, ease } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  cos,
  dot,
  float,
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
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BackSide,
  BufferAttribute,
  CanvasTexture,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type Texture,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { type Atlas, flat, follow, type Piece, prepare, relief } from './letters'

export type Style = 'cylinder' | 'sphere' | 'ring'
export type By = 'scroll' | 'drag' | 'auto'
type Params = {
  style: ChoiceParam<Style>
  by: ChoiceParam<By>
  radius: number
  tilt: number
  roll: number
  speed: number
  repeat: boolean
  fade: number
  pause: boolean
  fps: number
  color: ColorParam
}
type F = Node<'float'>
type V3 = Node<'vec3'>

/** Height of a line's middle above its baseline, em: the line runs round the form there. */
const MIDDLE = 0.35
/** Room between two copies of a line at its natural spacing, em: about a word space. */
const GAP = 0.32
/** Most a repeated line is spread to fill its circle; the rest goes between the copies. */
const SPREAD = 1.2
/** Farthest row of a text globe from its equator, radians. */
const LATITUDE = 1.2
/** Most letters drawn, copies included. */
export const MAX_LETTERS = 4000
/** Columns and rows of the mesh of a letter: it bends with the form. */
const COLS = 8
const ROWS_SPHERE = 4
/** Width of the bevel round the edge of a letter, em. */
const BEVEL = 0.03
/** Light from the upper left, in front. */
const LIGHT = new Vector3(-0.5, 0.62, 0.6).normalize()
const AMBIENT = 0.4
/** Highlight sharpness and strength. */
const SHINE = 90
const GLOSS = 0.5
/** Brightness of a letter seen edge on, and of the inside of the form. */
const EDGE = 0.55
const INSIDE = 0.82
/** Entrance: seconds, and the turn it spins in from, radians. */
const ENTER = 1.3
const SPIN_IN = 1.1
/** Time constants, s: the turn catching up with the scroll, a release coasting out, a pause. */
const FOLLOW = 0.14
const COAST = 0.75
const SLOW = 0.3
/** Pointer samples a release speed is read from, ms, and the fastest spin, rad/s. */
const WINDOW = 100
const FASTEST = 14
/** A spin slower than this stops, rad/s. */
const STOP = 0.03
/** A press that moved farther is a drag, px: the click it ends with is not a tap. */
const SLOP = 5
/** Most images of the element drawn with the form. */
const MAX_IMAGES = 4

// Attribute names become WGSL and GLSL identifiers: camelCase never meets a keyword of either.
/** A letter's cell on the form: arc position of its left edge, top (y up), width, height, px. */
const CELL = 'orbitCell'
/** The cell in the atlas: left, top, width, height as shares of the atlas. */
const SPOT = 'orbitSpot'
/** The radius of the letter's row as a share of the form's: cos of a globe row's latitude. */
const ROW = 'orbitRow'

/** A line of the text: its letters left to right and where it sits. */
interface Line {
  readonly pieces: readonly Piece[]
  /** Per piece: how far its cell moves down onto the line's baseline, px. */
  readonly drop: readonly number[]
  /** Left and right ends of its DOM boxes, box px. */
  readonly left: number
  readonly right: number
  /** y of its middle (box px, y down) and its largest font size. */
  readonly middle: number
  readonly em: number
}

function linesOf(atlas: Atlas): Line[] {
  const found = new Map<number, Piece[]>()
  for (const p of atlas.pieces) {
    const line = found.get(p.line) ?? []
    line.push(p)
    found.set(p.line, line)
  }
  const groups: { pieces: Piece[]; drop: number[] }[] = []
  for (const [, pieces] of [...found.entries()].sort(([i], [j]) => i - j)) {
    pieces.sort((p, q) => p.cx - q.cx)
    // A glyph of a fallback font can be measured on a baseline of its own: pieces that go on to
    // the right of the line about an em from it still sit on it.
    const prev = groups.at(-1)
    const lastBefore = prev?.pieces.at(-1)
    const first = pieces[0] as Piece
    if (
      prev &&
      lastBefore &&
      first.cx - first.span / 2 >= lastBefore.cx + lastBefore.span / 2 - lastBefore.em * 0.25 &&
      Math.abs(first.base - lastBefore.base) < Math.max(lastBefore.em, first.em) * 1.6
    ) {
      const base = (prev.pieces[0] as Piece).base
      prev.pieces.push(...pieces)
      prev.drop.push(...pieces.map((p) => base - p.base))
    } else groups.push({ pieces, drop: pieces.map(() => 0) })
  }
  return groups.map(({ pieces, drop }) => {
    const em = Math.max(...pieces.map((p) => p.em))
    // The baseline of the line's largest letters.
    const i = Math.max(
      0,
      pieces.findIndex((p) => p.em === em),
    )
    const base = (pieces[i]?.base ?? 0) + (drop[i] ?? 0)
    return {
      pieces,
      drop,
      left: Math.min(...pieces.map((p) => p.cx - p.span / 2)),
      right: Math.max(...pieces.map((p) => p.cx + p.span / 2)),
      middle: base - em * MIDDLE,
      em,
    }
  })
}

/** The letters laid out on the form. */
export interface Wrapped {
  /** Radius of the form, px: at least the one asked for, more when a line would not fit. */
  readonly radius: number
  /** Letters, copies included. */
  readonly count: number
  /** Per letter: arc position of the cell's left edge, its top (y up), width, height, px. */
  readonly cells: Float32Array
  /** Per letter: the cell in the atlas, left, top, width, height as shares of the atlas. */
  readonly spots: Float32Array
  /** Per letter: its row's radius as a share of the form's. */
  readonly rows: Float32Array
  /** Copies of each row, the element's own lines first. */
  readonly copies: readonly number[]
}

/**
 * Lays the letters of `atlas` round a form of radius `size` px: each line on a band (cylinder, ring)
 * or a row of a globe (sphere), its first copy centred in front. With `repeat` a line is copied
 * to fill its circle, its letters spread a little so the copies close up; a globe also fills its
 * surface with rows of the lines from pole to pole. The form grows when a line would not fit.
 */
export function wrap(
  atlas: Atlas,
  style: Style,
  size: number,
  repeat: boolean,
  limit: number = MAX_LETTERS,
): Wrapped {
  const lines = linesOf(atlas)
  const pitch = lines.map((l) => l.right - l.left + l.em * GAP)
  const radius = Math.max(1, size, ...pitch.map((p) => p / (2 * Math.PI)))
  const first = lines[0]
  const last = lines.at(-1)
  const centre = first && last ? (first.middle + last.middle) / 2 : 0
  /** Line, middle (y up, arc on atlas globe) and shift as atlas share of atlas copy. */
  const rows = lines.map((l, k) => ({ line: k, y: centre - l.middle, shift: 0, own: true }))
  if (style === 'sphere' && repeat && first && last) {
    const count = lines.length
    const step = Math.max(
      count > 1 ? (last.middle - first.middle) / (count - 1) : 0,
      first.em * 1.25,
    )
    const reach = radius * LATITUDE
    const top = centre - first.middle
    const extra: typeof rows = []
    for (let j = 1; top + j * step <= reach; j++)
      extra.push({
        line: (((-j % count) + count) % count) as number,
        y: top + j * step,
        shift: j % 2 ? 0.5 : 0,
        own: false,
      })
    for (let j = count; top - j * step >= -reach; j++)
      extra.push({
        line: j % count,
        y: top - j * step,
        shift: (j - count + 1) % 2 ? 0.5 : 0,
        own: false,
      })
    // Nearest the equator first, so a cut at the limit drops the rows near the poles.
    extra.sort((p, q) => Math.abs(p.y) - Math.abs(q.y))
    rows.push(...extra)
  }

  const cells: number[] = []
  const spots: number[] = []
  const scales: number[] = []
  const copies: number[] = []
  const [atlasWidth, atlasHeight] = atlas.size
  for (const row of rows) {
    const line = lines[row.line] as Line
    const k = style === 'sphere' ? Math.cos(row.y / radius) : 1
    const around = 2 * Math.PI * radius * k
    const rowPitch = pitch[row.line] as number
    // A row of the globe's own filling that cannot hold its line once is left out.
    if (!row.own && around < rowPitch) continue
    const repeats = repeat ? Math.max(1, Math.floor(around / rowPitch)) : 1
    if (cells.length / 4 + repeats * line.pieces.length > limit) {
      if (!row.own) break
      continue
    }
    const spread = Math.min(repeat ? SPREAD : 1, around / (repeats * rowPitch))
    const step = around / repeats
    const length = line.right - line.left
    for (let m = 0; m < repeats; m++) {
      const offset = (m + row.shift) * step
      for (const [i, piece] of line.pieces.entries()) {
        const along = spread * (piece.cx - line.left - length / 2) + offset
        const top = piece.y + (line.drop[i] ?? 0)
        cells.push(
          along - (piece.cx - piece.x),
          row.y + line.middle - top,
          piece.width,
          piece.height,
        )
        spots.push(
          piece.u / atlasWidth,
          piece.v / atlasHeight,
          piece.width / atlasWidth,
          piece.height / atlasHeight,
        )
        scales.push(k)
      }
    }
    copies.push(repeats)
  }
  const count = scales.length
  return {
    radius,
    count,
    cells: new Float32Array(count ? cells : [0, 0, 0, 0]),
    spots: new Float32Array(count ? spots : [0, 0, 0, 0]),
    rows: new Float32Array(count ? scales : [1]),
    copies,
  }
}

/** The mesh of one letter: a grid in 0..1, x right and y down, wound to face outward. */
function grid(cols: number, rows: number): [BufferAttribute, BufferAttribute] {
  const position: number[] = []
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= cols; i++) position.push(i / cols, j / rows, 0)
  const index: number[] = []
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const vertex = j * (cols + 1) + i
      const below = vertex + cols + 1
      index.push(vertex, below, vertex + 1, vertex + 1, below, below + 1)
    }
  return [
    new BufferAttribute(new Float32Array(position), 3),
    new BufferAttribute(new Uint16Array(index), 1),
  ]
}

function shape(
  wrapped: Wrapped,
  mesh: [BufferAttribute, BufferAttribute],
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(mesh[1])
  geometry.setAttribute('position', mesh[0])
  geometry.setAttribute(CELL, new InstancedBufferAttribute(wrapped.cells, 4))
  geometry.setAttribute(SPOT, new InstancedBufferAttribute(wrapped.spots, 4))
  geometry.setAttribute(ROW, new InstancedBufferAttribute(wrapped.rows, 1))
  geometry.instanceCount = wrapped.count
  return geometry
}

/** Texture reads of one texture; `set` swaps it under all of them. */
function slot(first: Texture): {
  read: (at: Node<'vec2'>) => Node<'vec4'>
  set: (next: Texture) => void
  dispose: () => void
} {
  let current = first
  const nodes: { value: Texture }[] = []
  return {
    read: (at) => {
      const node = texture(current, at)
      nodes.push(node as unknown as { value: Texture })
      return node as unknown as Node<'vec4'>
    },
    set: (next) => {
      const old = current
      current = next
      for (const n of nodes) n.value = next
      old.dispose()
    },
    dispose: () => current.dispose(),
  }
}

function atlasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  // Premultiplied, so mip levels do not darken the edges; sharp on letters turned away.
  map.premultiplyAlpha = true
  map.anisotropy = 8
  return map
}

/** A colour param that is set: empty or currentColor leave the text's own colour. */
const own = (value: string): boolean => {
  const word = value.trim().toLowerCase()
  return word !== '' && word !== 'currentcolor'
}

/** Rotation of the form, x then z: [cos tilt, sin tilt, cos roll, sin roll]. */
const turnPoint = (v: readonly [number, number, number], q: Vector4): [number, number, number] => {
  const y1 = v[1] * q.x - v[2] * q.y
  const z1 = v[1] * q.y + v[2] * q.x
  return [v[0] * q.z - y1 * q.w, v[0] * q.w + y1 * q.z, z1]
}

/** CSS object-fit of an image in its box: uv in the box (y up) to uv in the picture. */
function fitOf(
  img: HTMLImageElement,
  w: number,
  h: number,
  nw: number,
  nh: number,
  out: Vector4,
): Vector4 {
  const style = getComputedStyle(img)
  const mode = style.objectFit || 'fill'
  if (mode === 'fill' || !nw || !nh || !w || !h) return out.set(1, 1, 0, 0)
  const contain = Math.min(w / nw, h / nh)
  const scale =
    mode === 'cover'
      ? Math.max(w / nw, h / nh)
      : mode === 'none'
        ? 1
        : mode === 'scale-down'
          ? Math.min(1, contain)
          : contain
  const drawWidth = nw * scale
  const drawHeight = nh * scale
  const [px = '50%', py = '50%'] = (style.objectPosition || '50% 50%').split(/\s+/)
  const at = (value: string, free: number): number =>
    value.endsWith('%') ? (Number.parseFloat(value) / 100) * free : Number.parseFloat(value) || 0
  const x = at(px, w - drawWidth)
  const y = at(py, h - drawHeight)
  // u = (bx * w - x) / dw; v = 1 - ((1 - by) * h - y) / dh
  return out.set(w / drawWidth, h / drawHeight, -x / drawWidth, 1 - (h - y) / drawHeight)
}

/** Frames a second each phase wants. */
const pacing = new WeakMap<AbortSignal, () => number>()

/**
 * The text wrapped round a 3D form that turns: a drum like a spinning label, a globe of rows or a
 * tilted ring round the element's centre, passing in front of and behind its image. The letters
 * bend with the form and are lit by their normals, so those turning away darken and the ones at
 * the back show mirrored through the gaps, dimmed by depth. The turn follows the scroll, a drag
 * with inertia or runs by itself. The DOM text stays once for screen readers.
 */
const orbit: Effect<Params> = defineEffect({
  name: 'orbit',
  params: {
    style: oneOf('cylinder', 'sphere', 'ring'),
    by: oneOf('scroll', 'drag', 'auto'),
    radius: 1,
    tilt: 15,
    roll: 0,
    speed: 20,
    repeat: true,
    fade: 0.55,
    pause: true,
    fps: 60,
    color: Object.freeze({ '~kind': 'color', value: 'currentColor' }) as ColorParam,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The form reaches past the box.
  bleed: 240,
  quality: { low: { fps: 30 } },
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, params, signal, u, render, app } = ctx
    const style = params.style
    const by = params.by
    const ratio = ctx.quality === 'low' ? 1 : 2
    let atlas = await prepare(ctx, ratio)
    if (!atlas) return
    const el = element as HTMLElement

    // The images of the element, drawn with the form: hidden with the element, they are its core.
    const pictures = [...el.querySelectorAll('img')].slice(0, MAX_IMAGES)
    const loaded = await Promise.all(
      pictures.map((img) =>
        Promise.resolve()
          .then(() => ctx.texture(img.currentSrc || img.src))
          .then(
            (map) => ({ img, map }),
            () => undefined,
          ),
      ),
    )
    if (signal.aborted) return
    if (loaded.some((l) => !l)) {
      app.log.warn('orbit: an image of the element cannot be drawn, the element stays as it is', el)
      ctx.showDom(true)
      return
    }
    const images = loaded as { img: HTMLImageElement; map: Texture }[]
    const tested = images.length > 0

    const radius = uniform(1)
    const turn = uniform(0)
    const pose = uniform(new Vector4(1, 0, 1, 0))
    const centre = uniform(new Vector3())
    const eye = uniform(new Vector3(0, 0, 1000))
    const norm = uniform(1)
    /** The normal of the front of the form. */
    const ahead = uniform(new Vector3(0, 0, 1))
    const enter = uniform(0)
    const tinted = uniform(0)
    const lamp = vec3(LIGHT.x, LIGHT.y, LIGHT.z)
    const inks = slot(atlasTexture(atlas.canvas))
    const bumps = slot(new CanvasTexture(flat()))
    ctx.onDispose(() => {
      inks.dispose()
      bumps.dispose()
    })

    /** A vector of the form turned by the tilt, then the roll. */
    const turned = (v: V3): V3 => {
      const y1 = v.y.mul(pose.x).sub(v.z.mul(pose.y))
      const z1 = v.y.mul(pose.y).add(v.z.mul(pose.x))
      return vec3(v.x.mul(pose.z).sub(y1.mul(pose.w)), v.x.mul(pose.w).add(y1.mul(pose.z)), z1)
    }

    /** The letters seen from outside (1) or the inside of the form through it (-1). */
    const letters = (side: 1 | -1): MeshBasicNodeMaterial => {
      const cell = attribute(CELL, 'vec4') as unknown as Node<'vec4'>
      const spot = attribute(SPOT, 'vec4') as unknown as Node<'vec4'>
      const row = attribute(ROW, 'float') as unknown as F
      const vertex = positionGeometry
      const along = cell.x.add(vertex.x.mul(cell.z))
      const y = cell.y.sub(vertex.y.mul(cell.w))
      const theta = along.div(radius.mul(row)).sub(turn)
      const sinTheta = sin(theta)
      const cosTheta = cos(theta)
      let surface: V3
      let formNormal: V3
      let formBitangent: V3
      if (style === 'sphere') {
        const phi = y.div(radius)
        const sinPhi = sin(phi)
        const cosPhi = cos(phi)
        formNormal = vec3(cosPhi.mul(sinTheta), sinPhi, cosPhi.mul(cosTheta))
        surface = formNormal.mul(radius)
        formBitangent = vec3(sinPhi.negate().mul(sinTheta), cosPhi, sinPhi.negate().mul(cosTheta))
      } else {
        formNormal = vec3(sinTheta, 0, cosTheta)
        surface = vec3(sinTheta.mul(radius), y, cosTheta.mul(radius))
        formBitangent = vec3(0, 1, 0)
      }
      const formTangent = vec3(cosTheta, 0, sinTheta.negate())
      const local = turned(surface)
      const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: tested && side > 0,
        depthWrite: false,
        side: side > 0 ? FrontSide : BackSide,
      })
      material.positionNode = local.add(centre)
      const at = varying(
        vec2(spot.x.add(vertex.x.mul(spot.z)), spot.y.add(vertex.y.mul(spot.w)).oneMinus()),
      )
      const worldNormal = normalize(varying(turned(formNormal)) as unknown as V3)
      const worldTangent = varying(turned(formTangent)) as unknown as V3
      const worldBitangent = varying(turned(formBitangent)) as unknown as V3
      const worldPoint = varying(local.add(centre)) as unknown as V3
      const depth = varying(radius.sub(local.z).div(radius.mul(2)).clamp(0, 1)) as unknown as F

      const ink = inks.read(at)
      const rgb = sRGBTransferEOTF(ink.rgb.div(max(ink.a, 1e-4))) as V3
      const base = mix(rgb, u.color as unknown as V3, tinted) as unknown as V3
      const bump = bumps.read(at).xy.mul(2).sub(1)
      const normal = normalize(
        worldTangent.mul(bump.x).add(worldBitangent.mul(bump.y)).add(worldNormal),
      ).mul(side)
      const view = normalize(eye.sub(worldPoint))
      const diffuse = max(dot(normal, lamp), 0)
        .mul(1 - AMBIENT)
        .add(AMBIENT)
        .div(norm)
      // A highlight runs over the letters turning toward the light and along their bevels; minus
      // the one a face looking straight ahead has, so the front keeps the text's colour.
      const halfway = normalize(lamp.add(view))
      const shine = max(
        pow(max(dot(normal, halfway), 0), SHINE).sub(pow(max(dot(ahead, halfway), 0), SHINE)),
        0,
      ).mul(GLOSS)
      // Seen edge on, a letter darkens like a surface turning away.
      const facing = abs(dot(worldNormal, view))
      const rim = mix(float(EDGE), float(1), smoothstep(0, 0.7, facing))
      const lit = min(
        base
          .mul(diffuse)
          .mul(rim)
          .mul(side > 0 ? 1 : INSIDE)
          .add(shine),
        vec3(1),
      )
      const dim = float(1).sub(u.fade.clamp(0, 1).mul(smoothstep(0, 1, depth)))
      material.colorNode = vec4(lit, ink.a.mul(dim).mul(enter).mul(u.opacity))
      return material
    }

    /** Where an image is: its box in box px (x, y down, width, height) and its fit. */
    const lens = uniform(new Vector4(0, 0, 1, 0))
    const pictureMeshes = images.map(({ map }) => {
      const area = uniform(new Vector4())
      const fit = uniform(new Vector4(1, 1, 0, 0))
      const q = positionGeometry
      const half = u.size.mul(0.5)
      // The image keeps its place and size on screen at the depth of the form's centre.
      const x = area.x.add(q.x.add(0.5).mul(area.z)).sub(half.x).add(lens.x).mul(lens.z).sub(lens.x)
      const y = half.y
        .sub(area.y.add(q.y.oneMinus().sub(0.5).mul(area.w)))
        .add(lens.y)
        .mul(lens.z)
        .sub(lens.y)
      const at = uv().mul(fit.xy).add(fit.zw)
      const inside = at.x
        .greaterThanEqual(0)
        .and(at.x.lessThanEqual(1))
        .and(at.y.greaterThanEqual(0))
        .and(at.y.lessThanEqual(1))
      const texel = texture(map, at.clamp(0, 1))
      const alpha = texel.a
        .mul(select(inside, 1, 0) as unknown as F)
        .mul(enter)
        .mul(u.opacity)
      const plane = new PlaneGeometry(1, 1)
      const colour = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: true,
        depthWrite: false,
      })
      colour.positionNode = vec3(x, y, lens.w)
      colour.colorNode = vec4(texel.rgb, alpha)
      // Depth where the image is solid, so the letters behind it hide and the ones before it show.
      const solid = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: true,
        depthWrite: true,
      })
      solid.colorWrite = false
      solid.alphaTest = 0.5
      solid.positionNode = vec3(x, y, lens.w)
      solid.colorNode = vec4(texel.rgb, alpha)
      const front = new Mesh(plane, colour)
      const depth = new Mesh(plane, solid)
      depth.renderOrder = 0
      front.renderOrder = 2
      for (const m of [front, depth]) m.frustumCulled = false
      return { area, fit, meshes: [depth, front] }
    })

    const mesh = grid(COLS, style === 'sphere' ? ROWS_SPHERE : 1)
    const sizeOf = (width: number, height: number, size: number): number =>
      (Math.max(0, size) * (style === 'sphere' ? Math.min(width, height) : width)) / 2
    const rect = el.getBoundingClientRect()
    let wrapped = wrap(atlas, style, sizeOf(rect.width, rect.height, params.radius), params.repeat)
    let laid = { w: rect.width, h: rect.height, k: params.radius, repeat: params.repeat }
    let geometry = shape(wrapped, mesh)
    const inside = new Mesh(geometry, letters(-1))
    const outside = new Mesh(geometry, letters(1))
    inside.renderOrder = 1
    outside.renderOrder = 3
    const group = new Group()
    for (const m of [inside, outside]) {
      // The vertices are placed in the shader, far from the unit grid the bounds come from.
      m.frustumCulled = false
      group.add(m)
    }
    for (const p of pictureMeshes) for (const m of p.meshes) group.add(m)
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    const relay = (next: Wrapped): void => {
      wrapped = next
      const old = geometry
      geometry = shape(next, mesh)
      inside.geometry = geometry
      outside.geometry = geometry
      old.dispose()
    }

    // The bevels when the page is idle: a distance pass over the atlas.
    let carving: (() => void) | undefined
    const carve = (carved: Atlas): void => {
      carving?.()
      const run = (): void => {
        carving = undefined
        if (signal.aborted || atlas !== carved) return
        const em = carved.pieces.reduce((most, p) => Math.max(most, p.em), 1)
        bumps.set(new CanvasTexture(relief(carved, BEVEL * em)))
        ctx.invalidate()
      }
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 1000 })
        carving = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(run, 50)
        carving = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => carving?.())
    carve(atlas)

    let stuck = false
    let dom = true
    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }
    follow(
      ctx,
      ratio,
      () => atlas?.width ?? 0,
      () => dom,
      (next) => {
        stuck = !next
        if (!next) return
        atlas = next
        inks.set(atlasTexture(next.canvas))
        laid = { ...laid, k: Number.NaN }
        carve(next)
      },
    )

    // Where each image sits in the box; measured again when the box changes.
    const measure = (): void => {
      const outer = el.getBoundingClientRect()
      for (const [i, { img, map }] of images.entries()) {
        const r = img.getBoundingClientRect()
        const picture = pictureMeshes[i]
        if (!picture) continue
        picture.area.value.set(r.left - outer.left, r.top - outer.top, r.width, r.height)
        const data = map.image as { width?: number; height?: number } | undefined
        fitOf(img, r.width, r.height, data?.width ?? 0, data?.height ?? 0, picture.fit.value)
      }
    }
    if (images.length) {
      measure()
      const resize = new ResizeObserver(() => {
        measure()
        ctx.invalidate()
      })
      resize.observe(el)
      for (const { img } of images) resize.observe(img)
      ctx.onDispose(() => resize.disconnect())
    }

    // The turn, radians: the front moves left as it grows.
    let angle = 0
    /** Spin of a release or a key, rad/s. */
    let spin = 0
    let started = false
    let entered = 0
    /** auto: 1 turning, easing to 0 under the pointer or focus. */
    let pace = 1
    let paused = false
    const motion = { fast: false, slow: false }
    pacing.set(signal, () =>
      motion.fast ? Number.POSITIVE_INFINITY : motion.slow ? Math.max(0, ctx.params.fps) : 0,
    )
    ctx.onDispose(() => pacing.delete(signal))

    /** Radians a px of drag turns the front by. */
    let perPixel = 0.005
    type Grab = {
      id: number
      x: number
      from: number
      moved: boolean
      samples: { t: number; a: number }[]
    }
    let grab: Grab | undefined
    let armed: { t: number } | undefined
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
      capture = false,
    ): void => el.addEventListener(type, fn as (event: Event) => void, { signal, capture })
    if (by === 'drag') {
      listen('pointerdown', (e) => {
        if (e.button !== 0 || grab) return
        const finger = e.pointerType !== 'mouse'
        const action = getComputedStyle(el).touchAction || 'auto'
        // A finger turns only where the site gave the gesture to the page.
        if (finger && action !== 'none' && !(action.includes('pan-y') && !action.includes('pan-x')))
          return
        armed = undefined
        spin = 0
        grab = {
          id: e.pointerId,
          x: e.clientX,
          from: angle,
          moved: false,
          samples: [{ t: e.timeStamp, a: angle }],
        }
        try {
          el.setPointerCapture(e.pointerId)
        } catch {}
        // No text selection, no native drag of an image.
        if (!finger) e.preventDefault()
        ctx.invalidate()
      })
      listen('pointermove', (e) => {
        if (e.pointerId !== grab?.id) return
        const dx = e.clientX - grab.x
        if (Math.abs(dx) > SLOP) grab.moved = true
        angle = grab.from - dx * perPixel
        grab.samples.push({ t: e.timeStamp, a: angle })
        while (grab.samples.length > 2 && e.timeStamp - (grab.samples[1]?.t ?? 0) > WINDOW)
          grab.samples.shift()
        ctx.invalidate()
      })
      const release = (e: PointerEvent): void => {
        if (e.pointerId !== grab?.id) return
        const first = grab.samples[0]
        const last = grab.samples.at(-1)
        spin = 0
        if (first && last && e.type === 'pointerup' && !app.stage.reducedMotion.peek()) {
          const seconds = (last.t - first.t) / 1000
          if (e.timeStamp - last.t <= WINDOW && seconds > 0) spin = (last.a - first.a) / seconds
          spin = Math.max(-FASTEST, Math.min(FASTEST, spin))
        }
        if (grab.moved) armed = { t: e.timeStamp }
        grab = undefined
        ctx.invalidate()
      }
      listen('pointerup', release)
      listen('pointercancel', release)
      // The click a drag ends with is not a tap on a link inside.
      listen(
        'click',
        (e) => {
          if (armed && e.timeStamp - armed.t < 500) {
            e.preventDefault()
            e.stopPropagation()
          }
          armed = undefined
        },
        true,
      )
      listen('dragstart', (e) => e.preventDefault())
      listen('keydown', (e) => {
        if (!el.hasAttribute('tabindex') || e.altKey || e.ctrlKey || e.metaKey) return
        const x = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!x) return
        e.preventDefault()
        // Like a drag that way: a coast of a twelfth of a turn, a step under reduced motion.
        if (app.stage.reducedMotion.peek()) angle -= (x * Math.PI) / 6
        else spin = (-x * Math.PI) / 6 / COAST
        ctx.invalidate()
      })
    }
    if (by === 'auto') {
      const hold = (value: boolean): void => {
        paused = value
        ctx.invalidate()
      }
      listen('pointerenter', (e) => e.pointerType === 'mouse' && hold(true))
      listen('pointerleave', (e) => e.pointerType === 'mouse' && hold(false))
      listen('focusin', () => hold(true))
      listen('focusout', () => hold(false))
    }

    const rotation = new Vector4()
    return (input) => {
      if (stuck || !atlas) {
        motion.fast = false
        motion.slow = false
        show(true)
        return
      }
      const live = ctx.params
      const dt = Math.min(input.delta, 0.1)
      const still = input.reducedMotion
      const { width: w, height: h } = input
      if (w !== laid.w || h !== laid.h || live.radius !== laid.k || live.repeat !== laid.repeat) {
        relay(wrap(atlas, style, sizeOf(w, h, live.radius), live.repeat))
        laid = { w, h, k: live.radius, repeat: live.repeat }
        if (images.length) measure()
      }
      const formRadius = wrapped.radius
      const viewport = app.stage.height.peek()
      const rate = (live.speed * Math.PI) / 180

      let fast = false
      let slow = false
      if (!still && input.visible && entered < 1) {
        entered = Math.min(1, entered + dt / ENTER)
        fast = entered < 1
      } else if (still) entered = 1
      if (by === 'scroll') {
        // Readable in front when the box is centred in the view; the front moves left going down.
        const goal = still ? 0 : (rate * (viewport / 2 - (input.y + h / 2))) / 100
        if (!started || still) angle = goal
        else {
          angle = damp(angle, goal, FOLLOW, dt, 1e-4)
          if (angle !== goal) fast = true
        }
      } else if (by === 'auto') {
        pace = still ? 0 : damp(pace, live.pause && paused ? 0 : 1, SLOW, dt)
        if (pace < 0.01) pace = 0
        if (pace > 0.99) pace = 1
        angle += rate * pace * dt
        // The bleed counts a box near the view as seen: the form itself must be on screen.
        const cameraDistance = render.camera.position.z || 1000
        const reach = Math.max(
          0,
          (formRadius * cameraDistance) /
            Math.max(cameraDistance - (style === 'ring' ? formRadius : 0), 1) -
            Math.min(w, h) / 2,
        )
        const viewportWidth = app.stage.width.peek()
        const seen =
          input.y + h + reach > 0 &&
          input.y - reach < viewport &&
          input.x + w + reach > 0 &&
          input.x - reach < viewportWidth
        if (pace > 0 && rate !== 0 && seen) {
          if (pace < 1) fast = true
          else slow = true
        }
      } else if (!grab && spin) {
        if (still) spin = 0
        angle += spin * dt
        spin *= Math.exp(-dt / COAST)
        if (Math.abs(spin) < STOP) spin = 0
        else fast = true
      }
      started = true
      if (by !== 'scroll' && !grab && Math.abs(angle) > 1e3) angle %= 2 * Math.PI
      motion.fast = fast
      motion.slow = slow

      const tilt = (Math.max(-89, Math.min(89, live.tilt)) * Math.PI) / 180
      const roll = (live.roll * Math.PI) / 180
      rotation.set(Math.cos(tilt), Math.sin(tilt), Math.cos(roll), Math.sin(roll))
      pose.value.copy(rotation)
      radius.value = formRadius
      const shown = ease('expoOut', entered)
      turn.value = angle - (1 - shown) * SPIN_IN
      enter.value = Math.min(1, entered * 2.5)
      tinted.value = own(live.color) ? 1 : 0
      // The form's centre from the box centre: the front of a drum on the page plane where the
      // text is, a globe touching the page, a ring round the middle of the box.
      const front = turnPoint([0, 0, formRadius], rotation)
      const centrePoint = centre.value as Vector3
      if (style === 'cylinder') centrePoint.set(-front[0], -front[1], -front[2])
      else if (style === 'sphere') centrePoint.set(0, 0, -formRadius)
      else centrePoint.set(0, 0, 0)
      const at = render.toWorld(input.x + w / 2, input.y + h / 2)
      const camera = render.camera.position
      const cameraDistance = camera.z || 1000
      ;(eye.value as Vector3).set(camera.x - at.x, camera.y - at.y, cameraDistance)
      const facing = turnPoint([0, 0, 1], rotation)
      ;(ahead.value as Vector3).set(...facing)
      norm.value =
        Math.max(0, facing[0] * LIGHT.x + facing[1] * LIGHT.y + facing[2] * LIGHT.z) *
          (1 - AMBIENT) +
        AMBIENT
      lens.value.set(at.x, at.y, (cameraDistance - centrePoint.z) / cameraDistance, centrePoint.z)
      // The front, seen nearer or farther, turns faster or slower under the pointer.
      const zFront = centrePoint.z + front[2]
      perPixel = (cameraDistance - zFront) / cameraDistance / Math.max(formRadius, 1)
      show(false)
    }
  },
})
export default orbit
