import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV } from '@dioramajs/effects/kit'
import {
  attribute,
  cross,
  dot,
  float,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
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
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { fonts, raster, unsupported } from './raster'

export type Style = 'cube' | 'drum' | 'flip' | 'fold'
export type Axis = 'x' | 'y'
type Trigger = 'interval' | 'scroll' | 'hover'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  axis: ChoiceParam<Axis>
  interval: number
  duration: number
  depth: number
  shade: number
  pause: boolean
  loop: boolean
}

type F = Node<'float'>
type V3 = Node<'vec3'>
export type Vec3 = readonly [number, number, number]
/** A 3x3 matrix as its columns: the images of x, y and z. */
type Mat = readonly [Vec3, Vec3, Vec3]

/** One word as laid out at rest, in element px (y down from the element's top left). */
export interface Word {
  /** Border-box width of the element while this word shows. */
  readonly width: number
  /** The `width` to write for that, in the element's box-sizing. */
  readonly style: number
  /** The word's own box, left and right edges. */
  readonly left: number
  readonly right: number
  /** Baseline and font size of its line. */
  readonly base: number
  readonly em: number
  /** The raster of the word: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
  /** Element px to atlas UV: u = (x - ox) * sx, v = (y - oy) * sy, v down. */
  readonly map: readonly [number, number, number, number]
}

/**
 * A flat region of a word moved into 3D: a point (x, y) of the region, y down, lands at
 * `origin + ax * x - ay * y` in the element's frame (origin at its top left, y up, z towards the
 * viewer).
 */
export interface Piece {
  readonly word: Word
  /** The region in element px, y down: x0, y0, x1, y1. */
  readonly rect: readonly [number, number, number, number]
  readonly ax: Vec3
  readonly ay: Vec3
  readonly origin: Vec3
  readonly opacity: number
  /** Extra light on top of the shading: a shadow below 1. */
  readonly shade: number
}

/** The words a turn shows, by place from the word leaving (0) and the word coming (1). */
export type Around = (k: number) => Word | undefined

const IDENTITY: Mat = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
/** Mirrors y: a region seen from its back. */
const MIRROR: Mat = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, 1],
]
const rx = (a: number): Mat => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c],
  ]
}
const ry = (a: number): Mat => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [c, 0, -s],
    [0, 1, 0],
    [s, 0, c],
  ]
}
const apply = (m: Mat, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
]
const compose = (a: Mat, b: Mat): Mat => [apply(a, b[0]), apply(a, b[1]), apply(a, b[2])]

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const inOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
/** Speeds up like cubicInOut, then runs a few percent past the end and settles back. */
export function overshoot(t: number): number {
  const x = clamp01(t)
  if (x < 0.5) return 4 * x ** 3
  const u = 2 * x - 2
  return 0.5 + 0.5 * (1 + 2.5 * u ** 3 + 1.5 * u ** 2)
}
/** A flap falling: faster and faster, then one small bounce on landing. */
export function fall(t: number): number {
  const x = clamp01(t)
  return x < 0.8 ? (x / 0.8) ** 2 : 1 - 0.07 * Math.sin((Math.PI * (x - 0.8)) / 0.2)
}

/** A region of `word` drawn rotated by `m` about `pivot`, a point of the flat page `at`. */
function piece(
  word: Word,
  rect: Piece['rect'],
  m: Mat,
  pivot: Vec3,
  at: Vec3,
  opacity = 1,
  shade = 1,
): Piece {
  const rotated = apply(m, at)
  return {
    word,
    rect,
    ax: m[0],
    ay: m[1],
    origin: [pivot[0] - rotated[0], pivot[1] - rotated[1], pivot[2] - rotated[2]],
    opacity,
    shade,
  }
}

const whole = (w: Word): Piece['rect'] => [
  w.frame[0],
  w.frame[1],
  w.frame[0] + w.frame[2],
  w.frame[1] + w.frame[3],
]
const middle = (w: Word): number => (w.left + w.right) / 2

/**
 * The words of a cube or drum: flat faces around an axis `radius` px behind the page, each as wide
 * (axis y) or high (axis x) as its word, turned by `eased` of the way from the word leaving to the
 * word coming. A drum fades its faces with their angle and shows more of them mid-turn.
 */
function ring(
  axis: Axis,
  progress: number,
  eased: number,
  around: Around,
  height: number,
  radius: number,
  drum: boolean,
): Piece[] {
  const from = around(0) as Word
  const to = around(1) as Word
  const half = (w: Word): number =>
    Math.atan((axis === 'x' ? height : w.right - w.left) / 2 / radius)
  const step = half(from) + half(to)
  const turned = eased * step
  // Mid-turn the drum shows its neighbours; at rest only the word in front.
  const swing = Math.sin(Math.PI * clamp01(progress)) ** 2
  const spread = step * (1 + 2 * swing)
  const x = lerp(middle(from), middle(to), inOut(clamp01(progress)))
  const out: Piece[] = []
  const add = (k: number, angle: number): void => {
    const face = around(k)
    if (!face) return
    const phi = angle - turned
    if (Math.abs(phi) >= Math.PI / 2) return
    // The faces past the two of the turn only show while it turns.
    const opacity = drum
      ? clamp01(1 - Math.abs(phi) / spread) * (k === 0 || k === 1 ? 1 : swing)
      : 1
    if (opacity <= 0) return
    const sinPhi = Math.sin(phi)
    const cosPhi = Math.cos(phi)
    if (axis === 'x') {
      const y = -height / 2
      out.push(
        piece(
          face,
          whole(face),
          rx(phi),
          [0, y - radius * sinPhi, radius * cosPhi - radius],
          [0, y, 0],
          opacity,
        ),
      )
    } else {
      out.push(
        piece(
          face,
          whole(face),
          ry(phi),
          [x + radius * sinPhi, 0, radius * cosPhi - radius],
          [middle(face), 0, 0],
          opacity,
        ),
      )
    }
  }
  // Faces sit edge to edge: from one centre to the next is the two half angles.
  let angle = 0
  add(0, 0)
  for (let k = 1, prev = from; k <= (drum ? 3 : 1); k++) {
    const face = around(k)
    if (!face) break
    angle += half(prev) + half(face)
    add(k, angle)
    prev = face
  }
  angle = 0
  for (let k = -1, prev = from; drum && k >= -2; k--) {
    const face = around(k)
    if (!face) break
    angle -= half(prev) + half(face)
    add(k, angle)
    prev = face
  }
  return out
}

/**
 * Where the pieces of radius turn are at `progress` (0 the word leaving, flat; 1 the word coming, flat),
 * back to front. `height` is the element's box height. Under reduced motion the words fade.
 */
export function pieces(
  style: Style,
  axis: Axis,
  t: number,
  around: Around,
  height: number,
  reduced = false,
  perspective = 0,
): Piece[] {
  const from = around(0) as Word
  const to = around(1) as Word
  const x = clamp01(t)
  let out: Piece[]
  if (reduced) {
    const e = inOut(x)
    out = [
      piece(from, whole(from), IDENTITY, [0, 0, 0], [0, 0, 0], 1 - e),
      piece(to, whole(to), IDENTITY, [0, 0, 0], [0, 0, 0], e),
    ]
  } else if (style === 'cube' || style === 'drum') {
    const drum = style === 'drum'
    const size = axis === 'x' ? height : Math.max(from.right - from.left, to.right - to.left, 1)
    // A cube's faces meet at right angles (two half angles whose tangents multiply to 1); a drum
    // is a ten-sided wheel, or wider for long words.
    const radius =
      axis === 'x'
        ? drum
          ? height / 2 / Math.tan(Math.PI / 10)
          : height / 2
        : drum
          ? size * 1.2
          : Math.sqrt(Math.max(from.right - from.left, 1) * Math.max(to.right - to.left, 1)) / 2
    out = ring(axis, x, overshoot(x), around, height, Math.max(radius, 1), drum)
  } else if (style === 'flip') {
    if (axis === 'x') {
      // A split flap: the top half of the word leaving falls over a hinge a third of an em above
      // the baseline and shows the bottom half of the word coming on its back.
      const hinge = from.base - from.em * 0.33
      const top = (w: Word): Piece['rect'] => [
        w.frame[0],
        w.frame[1],
        w.frame[0] + w.frame[2],
        hinge,
      ]
      const bottom = (w: Word): Piece['rect'] => [
        w.frame[0],
        hinge,
        w.frame[0] + w.frame[2],
        w.frame[1] + w.frame[3],
      ]
      const fallen = fall(x)
      const angle = Math.PI * fallen
      const pivot: Vec3 = [0, -hinge, 0]
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      // The flap hides what is behind it, as an opaque card would: the halves standing still
      // show only past its edge, where `perspective` (1 / px) draws that edge.
      const edge = (reach: number): number => {
        const y = -hinge + reach * cos
        const centre = -height / 2
        return -(centre + (y - centre) / Math.max(1e-3, 1 - reach * sin * perspective))
      }
      const shown = top(to)
      const still = bottom(from)
      const upper = cos > 0 ? edge(hinge - from.frame[1]) - 1 : hinge
      const lower = cos < 0 ? edge(to.frame[1] + to.frame[3] - hinge) + 1 : hinge
      out = [
        piece(
          to,
          [shown[0], shown[1], shown[2], Math.min(hinge, upper)],
          IDENTITY,
          [0, 0, 0],
          [0, 0, 0],
          1,
          0.55 + 0.45 * clamp01(fallen / 0.7),
        ),
        piece(
          from,
          [still[0], Math.max(hinge, lower), still[2], still[3]],
          IDENTITY,
          [0, 0, 0],
          [0, 0, 0],
          x >= 0.8 ? 0 : 1,
          1 - 0.45 * clamp01(2 * fallen - 1),
        ),
        piece(from, top(from), rx(angle), pivot, pivot),
        piece(to, bottom(to), compose(rx(angle), MIRROR), pivot, pivot),
      ]
    } else {
      // A card turning over about its upright middle, lifted towards the viewer on the way.
      const angle = Math.PI * inOut(x)
      const lift = height * 0.35 * Math.sin(Math.PI * x)
      const centre = lerp(middle(from), middle(to), inOut(x))
      out = [
        piece(from, whole(from), ry(angle), [centre, 0, lift], [middle(from), 0, 0]),
        piece(to, whole(to), ry(angle + Math.PI), [centre, 0, lift], [middle(to), 0, 0]),
      ]
    }
  } else {
    // The word leaving folds back into the page over one edge, the word coming unfolds from the
    // opposite edge: down for axis x, along the line for axis y.
    const away = (Math.PI / 2) * clamp01(x / 0.6) ** 2
    const back = (Math.PI / 2) * (1 - (1 - clamp01((x - 0.4) / 0.6)) ** 2)
    if (axis === 'x') {
      const floor: Vec3 = [0, -height, 0]
      out = [
        piece(from, whole(from), rx(-away), floor, floor),
        piece(to, whole(to), rx(Math.PI / 2 - back), [0, 0, 0], [0, 0, 0]),
      ]
    } else {
      const left: Vec3 = [from.left, 0, 0]
      const right: Vec3 = [to.right, 0, 0]
      out = [
        piece(from, whole(from), ry(away), left, left),
        piece(to, whole(to), ry(back - Math.PI / 2), right, right),
      ]
    }
  }
  const facing = (p: Piece): number => p.ax[0] * p.ay[1] - p.ax[1] * p.ay[0]
  const depth = (p: Piece): number => {
    const cx = (p.rect[0] + p.rect[2]) / 2
    const cy = (p.rect[1] + p.rect[3]) / 2
    return p.origin[2] + p.ax[2] * cx - p.ay[2] * cy
  }
  return out
    .filter(
      (p) => p.opacity > 1e-3 && facing(p) > 1e-3 && p.rect[3] > p.rect[1] && p.rect[2] > p.rect[0],
    )
    .map((p, i) => ({ p, i, z: depth(p) }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map(({ p }) => p)
}

/** Longest side of the atlas of a turn's words, device px. */
const ATLAS = 4096
/** A turn's words: the two of the turn, and two more on each side for a drum. */
const NEAR = [-2, -1, 0, 1, 2, 3] as const
/** Seconds of the fade that stands in for the turn under reduced motion, at most. */
const FADE = 0.35
/** Scroll: the share of each word's stretch held still before and after its turn. */
const HOLD = 0.2
/** Most pieces one turn draws. */
const MAX_PIECES = 8

/** Share of the light that does not depend on the angle. */
const AMBIENT = 0.4

/** Visually hidden but read by screen readers. */
const HIDDEN =
  ';position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap'
/** Undoes the same, for a word the page's own CSS hides that way before the effect runs. */
const SHOWN = ';position:static;width:auto;height:auto;overflow:visible;clip-path:none'

const RECT = 'pieceRect'
const MAP = 'pieceMap'
const AX = 'pieceAxisX'
const AY = 'pieceAxisY'
const ORIGIN = 'pieceOrigin'
const LOOK = 'pieceLook'

interface Turn {
  readonly from: number
  readonly to: number
  readonly words: Map<number, Word>
  time: number
  fresh: boolean
}

interface Measured extends Omit<Word, 'map'> {
  readonly canvas: HTMLCanvasElement
}

/** Packs the rasters of the words one under another; returns the atlas and each word's mapping. */
function pack(list: readonly Measured[]): { canvas: HTMLCanvasElement; words: Word[] } | undefined {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const gap = 2
  let width = 1
  let height = 0
  for (const m of list) {
    width = Math.max(width, m.canvas.width)
    height += m.canvas.height + gap
  }
  const scale = Math.min(1, ATLAS / Math.max(width, height, 1))
  canvas.width = Math.max(1, Math.ceil(width * scale))
  canvas.height = Math.max(1, Math.ceil(height * scale))
  let y = 0
  const words = list.map((measured) => {
    const drawWidth = measured.canvas.width * scale
    const drawHeight = measured.canvas.height * scale
    ctx.drawImage(measured.canvas, 0, y, drawWidth, drawHeight)
    const [frameX, frameY, frameWidth, frameHeight] = measured.frame
    const scaleX = drawWidth / (Math.max(frameWidth, 1e-3) * canvas.width)
    const scaleY = drawHeight / (Math.max(frameHeight, 1e-3) * canvas.height)
    const word: Word = {
      width: measured.width,
      style: measured.style,
      left: measured.left,
      right: measured.right,
      base: measured.base,
      em: measured.em,
      frame: measured.frame,
      map: [frameX, frameY - y / canvas.height / scaleY, scaleX, scaleY],
    }
    y += drawHeight + gap * scale
    return word
  })
  return { canvas, words }
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  return map
}

/**
 * Words take turns in a phrase on the faces of a real 3D shape: a cube or a drum that rolls to
 * the next word, a split flap falling over its hinge or a strip folding into the page, lit from
 * above and seen in perspective. The box eases to the width of the next word; between turns the
 * word is plain DOM text.
 */
const rotator: Effect<Params> = defineEffect({
  name: 'rotator',
  params: {
    style: oneOf('cube', 'drum', 'flip', 'fold'),
    trigger: oneOf('interval', 'scroll', 'hover'),
    axis: oneOf('x', 'y'),
    interval: 2.2,
    duration: 0.8,
    depth: 1,
    shade: 1,
    pause: true,
    loop: true,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  bleed: 48,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, app, signal, u, render } = ctx
    const el = element as HTMLElement
    const { style: kind, axis, trigger } = params

    let words = [...el.children].filter((c) => c.textContent?.trim()) as HTMLElement[]
    if (words.length < 2) {
      if (DEV)
        app.log.warn('rotator: put two or more words in the element, one child element each', el)
      ctx.showDom(true)
      return
    }

    // The page's own inline styles, put back on dispose and kept under ours.
    const own = new Map<Element, string | null>()
    const remember = (node: Element): string => {
      if (!own.has(node)) own.set(node, node.getAttribute('style'))
      const before = own.get(node) ?? ''
      return before && !before.trim().endsWith(';') ? `${before};` : before
    }
    const restore = (node: Element): void => {
      const before = own.get(node)
      if (before === undefined) return
      if (before === null) node.removeAttribute('style')
      else node.setAttribute('style', before)
      own.delete(node)
    }
    ctx.onDispose(() => {
      for (const node of [...own.keys()]) restore(node)
    })
    // An inline element takes a width only as an inline block; a phrase never wraps mid-turn.
    const inline = getComputedStyle(el).display === 'inline'
    const base = `${remember(el)}${inline ? 'display:inline-block;' : ''}white-space:nowrap`
    el.setAttribute('style', base)

    let shown = 0
    /** Shows word `i` in the DOM and hides the others visually; the element sizes to it. */
    const show = (i: number): void => {
      shown = i
      el.setAttribute('style', base)
      words.forEach((w, k) => {
        const before = remember(w)
        if (k !== i) {
          w.setAttribute('style', before + HIDDEN)
          return
        }
        w.setAttribute('style', before)
        // The page's CSS may hide every word but the first before the effect runs.
        const style = getComputedStyle(w)
        const clipped =
          (style.clipPath && style.clipPath !== 'none') || style.position === 'absolute'
        if (clipped || style.display === 'none')
          w.setAttribute(
            'style',
            before + SHOWN + (style.display === 'none' ? ';display:revert' : ''),
          )
      })
    }
    show(0)

    const ratio = ctx.quality === 'low' ? 1 : 2
    const reason = unsupported(el) ?? (await fonts(el))
    if (signal.aborted) return
    if (reason && DEV)
      app.log.warn(`rotator: ${reason} cannot be drawn, the words swap without turning`, el)
    const gl = !reason

    /** Word `i` laid out at rest in the element and rastered. Leaves word `i` shown. */
    const measure = (i: number): Measured | undefined => {
      show(i)
      const word = words[i] as HTMLElement
      const box = el.getBoundingClientRect()
      const own = word.getBoundingClientRect()
      const drawn = raster(word, 'line', ratio)
      if (!drawn) return undefined
      const style = getComputedStyle(el)
      const sides =
        style.boxSizing === 'border-box'
          ? 0
          : (Number.parseFloat(style.paddingLeft) || 0) +
            (Number.parseFloat(style.paddingRight) || 0) +
            (Number.parseFloat(style.borderLeftWidth) || 0) +
            (Number.parseFloat(style.borderRightWidth) || 0)
      const dx = own.left - box.left
      const dy = own.top - box.top
      const q = drawn.quads[0]
      const em = q?.em ?? (Number.parseFloat(getComputedStyle(word).fontSize) || own.height)
      return {
        canvas: drawn.canvas,
        width: box.width,
        style: Math.max(0, box.width - sides),
        left: dx,
        right: dx + own.width,
        base: q ? dy + q.base : dy + own.height * 0.8,
        em,
        frame: [drawn.frame[0] + dx, drawn.frame[1] + dy, drawn.frame[2], drawn.frame[3]],
      }
    }

    // Uniforms: the box centre in world px, the perspective as 1 / its distance in px, where the
    // eye is for the highlight, the camera's distance.
    const centre = uniform(new Vector2())
    // The window a drum is seen through, box-centre px (x0, y0, x1, y1), and its soft edge.
    const clip = uniform(new Vector4(-1e6, -1e6, 1e6, 1e6))
    const soft = uniform(1)
    const perspective = uniform(0)
    const eye = uniform(1e5)
    // A lamp above, to the left and in front of the box, box-centre px.
    const lamp = uniform(new Vector3(-300, 300, 400))
    const distance = uniform(render.camera.position.z || 1000)
    // Until the first turn: one clear pixel. WebGPU cannot copy a canvas without a context.
    const blank = document.createElement('canvas')
    blank.width = 1
    blank.height = 1
    blank.getContext('2d')
    let current: Texture = canvasTexture(blank)
    let map: { value: Texture } | undefined

    const geometry = new InstancedBufferGeometry()
    geometry.setIndex([0, 2, 1, 2, 3, 1])
    const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
    const attrs = {
      rect: new InstancedBufferAttribute(new Float32Array(MAX_PIECES * 4), 4),
      map: new InstancedBufferAttribute(new Float32Array(MAX_PIECES * 4), 4),
      ax: new InstancedBufferAttribute(new Float32Array(MAX_PIECES * 3), 3),
      ay: new InstancedBufferAttribute(new Float32Array(MAX_PIECES * 3), 3),
      origin: new InstancedBufferAttribute(new Float32Array(MAX_PIECES * 3), 3),
      look: new InstancedBufferAttribute(new Float32Array(MAX_PIECES * 2), 2),
    }
    for (const attr of Object.values(attrs)) attr.setUsage(DynamicDrawUsage)
    geometry.setAttribute(RECT, attrs.rect)
    geometry.setAttribute(MAP, attrs.map)
    geometry.setAttribute(AX, attrs.ax)
    geometry.setAttribute(AY, attrs.ay)
    geometry.setAttribute(ORIGIN, attrs.origin)
    geometry.setAttribute(LOOK, attrs.look)
    geometry.instanceCount = 0

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    {
      const rect = attribute(RECT, 'vec4') as unknown as Node<'vec4'>
      const atlasRect = attribute(MAP, 'vec4') as unknown as Node<'vec4'>
      const ax = attribute(AX, 'vec3') as unknown as V3
      const ay = attribute(AY, 'vec3') as unknown as V3
      const origin = attribute(ORIGIN, 'vec3') as unknown as V3
      const look = attribute(LOOK, 'vec2') as unknown as Node<'vec2'>
      const corner = positionGeometry.xy.add(0.5)
      const x = mix(rect.x, rect.z, corner.x)
      const y = mix(rect.w, rect.y, corner.y)
      const placed = origin.add(ax.mul(x)).sub(ay.mul(y))
      const half = u.size.mul(0.5)
      // From the element's top left to its centre, which the placed mesh sits at.
      const local = vec3(placed.x.sub(half.x), placed.y.add(half.y), placed.z)
      // Seen with its own perspective from in front of the box, like CSS perspective on the
      // element: depth scaled for the page camera and pulled towards its axis.
      const z = local.z.mul(perspective)
      const drawn = vec3(local.xy.sub(centre.mul(z)), z.mul(distance))
      material.positionNode = drawn
      const at = varying(
        vec2(
          x.sub(atlasRect.x).mul(atlasRect.z),
          float(1).sub(y.sub(atlasRect.y).mul(atlasRect.w)),
        ),
      )
      const normal = varying(normalize(cross(ax, ay))) as unknown as V3
      const point = varying(local) as unknown as V3
      const flat = varying(drawn.xy) as unknown as Node<'vec2'>
      const boxUV = flat.div(u.size).add(0.5)
      const inside = flat.sub(clip.xy).min(clip.zw.sub(flat)).div(soft).clamp(0, 1)
      const seen = inside.x.mul(inside.y)
      const texel = texture(current, at)
      map = texel as unknown as { value: Texture }
      const rgb = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as V3
      const unitNormal = normalize(normal)
      const toLamp = normalize(lamp.sub(point))
      // Lambert over the same light on a face turned to the viewer: at rest it is exactly 1, the
      // DOM's colour.
      const facing = max(toLamp.z, 0)
        .mul(1 - AMBIENT)
        .add(AMBIENT)
      const lit = min(
        max(dot(unitNormal, toLamp), 0)
          .mul(1 - AMBIENT)
          .add(AMBIENT)
          .div(facing),
        1.15,
      )
      const shade = mix(float(1), lit, u.shade).mul(look.y)
      // A highlight runs over a face as it tilts towards the lamp; minus the highlight a face
      // turned to the viewer would have there, so a face at rest has none.
      const view = normalize(vec3(0, 0, eye).sub(point))
      const halfway = normalize(toLamp.add(view))
      const gloss = max(
        pow(max(dot(unitNormal, halfway), 0), 90).sub(pow(max(halfway.z, 0), 90)),
        0,
      )
        .mul(0.22)
        .mul(u.shade)
      material.colorNode = vec4(
        rgb.mul(shade).add(gloss as F),
        texel.a.mul(look.x, seen).mul(ctx.mask(boxUV.clamp(0, 1))),
      )
    }
    const mesh = new Mesh(geometry, material)
    // The vertices are placed in the shader, far from the unit quad the bounds come from.
    mesh.frustumCulled = false
    ctx.onDispose(() => current.dispose())
    ctx.place(mesh, { fit: 'none', replace: true })
    ctx.showDom(true)
    if (gl) {
      // One empty piece, so the compile builds the pipeline of a draw that has instances.
      geometry.instanceCount = 1
      await ctx.compile(mesh)
      geometry.instanceCount = 0
      if (signal.aborted) return
    }

    const count = (): number => words.length
    const wrap = (i: number): number => ((i % count()) + count()) % count()

    let turn: Turn | undefined
    // A timed turn plays, so the update asks for frames.
    let turning = false
    /** Lays out and rasters the words of a turn from `from` to `to`; the DOM shows `from` again. */
    const begin = (from: number, to: number): Turn | undefined => {
      const places = kind === 'drum' && trigger !== 'scroll' ? NEAR : ([0, 1] as const)
      const loop = ctx.params.loop && trigger !== 'scroll'
      const indexOf = (k: number): number | undefined => {
        const i = k <= 0 ? from + k : to + (k - 1)
        if (loop) return wrap(i)
        return i >= 0 && i < count() ? i : undefined
      }
      const measured = new Map<number, Measured>()
      for (const k of places) {
        const i = indexOf(k)
        if (i === undefined || measured.has(i)) continue
        const m = measure(i)
        if (m) measured.set(i, m)
      }
      show(from)
      const list = [...measured.values()]
      const packed = list.length ? pack(list) : undefined
      if (!packed || !measured.has(from) || !measured.has(to)) return undefined
      const byIndex = new Map<number, Word>()
      ;[...measured.keys()].forEach((i, n) => {
        byIndex.set(i, packed.words[n] as Word)
      })
      const words = new Map<number, Word>()
      for (const k of places) {
        const i = indexOf(k)
        const w = i === undefined ? undefined : byIndex.get(i)
        if (w) words.set(k, w)
      }
      const next = canvasTexture(packed.canvas)
      if (map) map.value = next
      current.dispose()
      current = next
      return { from, to, words, time: 0, fresh: true }
    }

    /** Writes the pieces of `turn` at `progress` and the element's width. */
    const draw = (now: Turn, progress: number, input: EffectInput): void => {
      const height = input.height
      const leaving = now.words.get(0) as Word
      const coming = now.words.get(1) as Word
      // Like CSS perspective at four times the size of what turns: the line height, or for
      // axis y most of the width of the wider word.
      const size =
        axis === 'x'
          ? height
          : Math.max(
              height,
              0.6 * Math.max(leaving.right - leaving.left, coming.right - coming.left),
            )
      const strength = Math.max(0, ctx.params.depth) / Math.max(4 * size, 1)
      const list = pieces(
        kind,
        axis,
        progress,
        (k) => now.words.get(k),
        height,
        input.reducedMotion,
        strength,
      ).slice(0, MAX_PIECES)
      list.forEach((p, i) => {
        attrs.rect.array.set(p.rect, i * 4)
        attrs.map.array.set(p.word.map, i * 4)
        attrs.ax.array.set(p.ax, i * 3)
        attrs.ay.array.set(p.ay, i * 3)
        attrs.origin.array.set(p.origin, i * 3)
        attrs.look.array.set([p.opacity, p.shade], i * 2)
      })
      for (const attr of Object.values(attrs)) attr.needsUpdate = true
      geometry.instanceCount = list.length
      const at = render.toWorld(input.x + input.width / 2, input.y + input.height / 2)
      ;(centre.value as Vector2).set(at.x, at.y)
      perspective.value = strength
      eye.value = strength > 1e-5 ? 1 / strength : 1e5
      ;(lamp.value as Vector3).set(-input.width * 0.4, height * 2.4, height * 3)
      // A drum, and a cube turning sideways, are seen through a window so they never cover the
      // words around them: the line and a little above and below it for axis x, the box for y.
      const box = clip.value as Vector4
      const windowed = kind === 'drum' || (kind === 'cube' && axis === 'y')
      if (!windowed || input.reducedMotion) {
        box.set(-1e6, -1e6, 1e6, 1e6)
        soft.value = 1
      } else {
        // Fully seen within 2 px of the box, fading out over `edge` beyond it.
        const edge = Math.max(1, height * (axis === 'x' ? 0.45 : 0.3))
        const pad = edge + 2
        if (axis === 'x') box.set(-1e6, -height / 2 - pad, 1e6, height / 2 + pad)
        else box.set(-input.width / 2 - pad, -1e6, input.width / 2 + pad, 1e6)
        soft.value = edge
      }
      distance.value = render.camera.position.z || 1000
      el.style.width = `${lerp(leaving.style, coming.style, inOut(clamp01(progress)))}px`
      ctx.showDom(false)
    }

    /** Ends a turn on `rest`: the DOM shows that word at its own width. */
    const settle = (rest: number): void => {
      turn = undefined
      turning = false
      geometry.instanceCount = 0
      show(rest)
      ctx.showDom(true)
    }

    // The next turn is due: set by the interval timer, a hover or a tap.
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const wake = (): void => {
      pending = true
      ctx.invalidate()
    }
    const last = (): boolean => !ctx.params.loop && shown >= count() - 1
    const later = (): void => {
      clearTimeout(timer)
      if (trigger !== 'interval' || last()) return
      timer = setTimeout(wake, Math.max(0.1, ctx.params.interval) * 1000)
    }
    ctx.onDispose(() => clearTimeout(timer))

    // Hovering or focusing the phrase pauses the interval; the turn due waits for the leave.
    let over = false
    let focused = false
    const host = (el.closest('a, button') as HTMLElement | null) ?? el.parentElement ?? el
    const listen = (target: EventTarget, type: string, fn: (e: Event) => void): void =>
      target.addEventListener(type, fn, { signal, passive: true })
    if (trigger === 'interval') {
      listen(host, 'pointerenter', (e) => {
        if ((e as PointerEvent).pointerType !== 'touch') over = true
      })
      listen(host, 'pointerleave', () => {
        over = false
        if (pending) ctx.invalidate()
      })
      listen(host, 'focusin', () => {
        focused = true
      })
      listen(host, 'focusout', () => {
        focused = false
        if (pending) ctx.invalidate()
      })
      later()
    } else if (trigger === 'hover') {
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      const play = (): void => {
        if (!turn && !last()) wake()
      }
      listen(target, 'pointerenter', (e) => {
        if ((e as PointerEvent).pointerType !== 'touch') play()
      })
      listen(target, 'focusin', play)
      // Touch screens have no hover: a tap turns to the next word.
      listen(target, 'pointerdown', (e) => {
        if ((e as PointerEvent).pointerType === 'touch') play()
      })
    }
    const paused = (): boolean => ctx.params.pause && (over || focused)

    // A framework that swaps the words: start over from the first.
    const children = new MutationObserver(() => {
      for (const w of words) if (!w.isConnected || w.parentElement !== el) restore(w)
      words = [...el.children].filter((c) => c.textContent?.trim()) as HTMLElement[]
      for (const w of [...own.keys()]) if (w !== el && !words.includes(w as HTMLElement)) restore(w)
      if (words.length < 2) {
        turn = undefined
        turning = false
        geometry.instanceCount = 0
        for (const w of words) restore(w)
        ctx.showDom(true)
        return
      }
      settle(0)
      later()
    })
    children.observe(el, { childList: true })
    ctx.onDispose(() => children.disconnect())

    /** Scroll: 0..1 through the pinned section the rotator plays in, else through the viewport. */
    const travel = (input: EffectInput): number => {
      const viewport = app.stage.height.peek() || 1
      const section = ctx.section()
      if (section.element !== el && section.height > viewport * 1.05) return section.pin
      const middle = input.y + input.height / 2
      return clamp01((viewport * 0.85 - middle) / (viewport * 0.6))
    }

    return (input): boolean => {
      if (count() < 2) return turning
      const live = ctx.params
      if (trigger === 'scroll') {
        const pos = travel(input) * (count() - 1)
        const from = Math.min(count() - 2, Math.floor(pos))
        const t = clamp01((pos - from - HOLD) / (1 - 2 * HOLD))
        if (!gl || t <= 0 || t >= 1) {
          const rest = gl ? (t >= 1 ? from + 1 : from) : Math.round(pos)
          if (turn || shown !== rest) settle(rest)
          return turning
        }
        if (turn?.from !== from) {
          show(from)
          turn = begin(from, from + 1)
        }
        if (turn) draw(turn, t, input)
        return turning
      }
      if (!turn) {
        if (!pending || paused()) return turning
        pending = false
        if (last()) return turning
        const to = wrap(shown + 1)
        if (!gl) {
          show(to)
          later()
          return turning
        }
        turn = begin(shown, to)
        if (!turn) {
          show(to)
          later()
          return turning
        }
        turning = true
      }
      const now = turn
      if (now.fresh) now.fresh = false
      else now.time += input.delta
      const length = input.reducedMotion
        ? Math.min(Math.max(live.duration, 0.05), FADE)
        : Math.max(live.duration, 0.05)
      const progress = Math.min(1, now.time / length)
      if (progress < 1) draw(now, progress, input)
      else {
        settle(now.to)
        later()
      }
      return turning
    }
  },
})
export default rotator
