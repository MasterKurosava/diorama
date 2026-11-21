import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, entering, inView } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  cos,
  cross,
  dot,
  float,
  floor,
  max,
  min,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  round,
  select,
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
  BoxGeometry,
  CanvasTexture,
  Color,
  DataTexture,
  DataUtils,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  NoColorSpace,
  type Node,
  PlaneGeometry,
  RGBAFormat,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { backdrop, linear } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'

export type Style = 'horizontal' | 'vertical' | 'tiles'
export type Trigger = 'view' | 'scroll' | 'hover'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  slats: number
  gap: number
  duration: number
  stagger: number
  delay: number
  threshold: number
  angle: number
  light: number
  back: ColorParam
  reverse: string
}

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/** The panel reaches this far past the ink, in em: sideways and up and down. */
const PAD: readonly [number, number] = [0.14, 0.06]
/** Vertical slats are this many times as wide as horizontal ones are high; tiles this big. */
const WIDE = 2.5
const TILE = 1.5
/** Most slats or tiles of one heading. */
const MAX_CELLS = 2048
/** A long wave has every slat started within this many turns: `stagger` shrinks to fit. */
const SPREAD = 2.2
/** Slat thickness in px, as a share of its smaller side, and its bounds. */
const THICK = 0.08
const THICK_RANGE: readonly [number, number] = [1, 4]
/** How high the lamp stands over the page, radians. */
const ELEVATION = (50 * Math.PI) / 180
/** Share of the light that does not depend on the angle: on the printed front and the back. */
const AMBIENT = { front: 0.6, back: 0.38 } as const
/** Darkest a slat gets in a neighbour's shadow, and the page in theirs. */
const SLAT_SHADOW = 0.5
const PAGE_SHADOW = 0.3
/** The edges of a slat in its back colour, a shade darker. */
const EDGE = 0.82
/** The perspective, as a share of the panel's larger side seen from in front of it. */
const EYE = 1.4
/** Springs of the tilt under the pointer: stiffness, damping, pull of the neighbours. */
const SPRING = { k: 150, c: 7.5, line: 260, grid: 520 } as const
/** Springs of the hover trigger's turns: stiffness, damping. */
const TURN = { k: 140, c: 13 } as const
/** Integration step of the springs, s, and the most steps in one frame. */
const STEP = 1 / 240
const MAX_STEPS = 48
/** Largest tilt the pointer gives a slat, radians, and the push of 1000 px/s. */
const MAX_TILT = 0.45
const PUSH = 0.008
/** Hover: slats within this many em of the pointer open fully, past the second they rest. */
const REACH: readonly [number, number] = [0.9, 2]
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before rastering again after a change, ms; while the DOM shows, up to this idle timeout. */
const REDO_DELAY = 150
const REDO_IDLE_TIMEOUT = 1000

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a || 1))
  return t * t * (3 - 2 * t)
}

/**
 * A slat's turn, 0 closed to 1 open: it starts slowly, swings a few degrees past flat and settles
 * with no speed left, so the hand-back to the DOM is still.
 */
export function swing(t: number): number {
  const x = clamp01(t)
  const u = x * x * (3 - 2 * x) - 1
  return 1 + 2.1 * u ** 3 + 1.1 * u ** 2
}

/** One line of the text: its ink band and font size, element px, y down. */
export interface Line {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly em: number
}

/** How the text block is cut into slats or tiles. */
export interface Grid {
  readonly style: Style
  readonly cols: number
  readonly rows: number
  /** The panel in element px, y down: x0, y0, x1, y1. */
  readonly block: readonly [number, number, number, number]
  /** Width and height of one cell. */
  readonly pitch: readonly [number, number]
  /** Per cell, row by row: the axis in the page it turns about, x and y (y up). */
  readonly axis: Float32Array
  /** Per cell: its place in the wave, in slats from the first. */
  readonly order: Float32Array
  /** Per cell: half its extent across its axis, px, how far it stands out edge-on. */
  readonly reach: Float32Array
  /** Cells in draw order: the farthest from the middle first, so nearer ones cover them. */
  readonly cells: Float32Array
  /** Font size of the largest line. */
  readonly em: number
}

/**
 * Cuts the panel over `lines` (and `also`, the lines of the second text): `slats` strips per line,
 * or columns and square tiles of a like size.
 */
export function cut(
  style: Style,
  lines: readonly Line[],
  slats: number,
  also: readonly Line[] = [],
): Grid {
  const all = [...lines, ...also]
  const em = Math.max(1, ...all.map((l) => l.em))
  const x0 = Math.min(...all.map((l) => l.left)) - PAD[0] * em
  const x1 = Math.max(...all.map((l) => l.right)) + PAD[0] * em
  let y0 = Math.min(...all.map((l) => l.top)) - PAD[1] * em
  let y1 = Math.max(...all.map((l) => l.bottom)) + PAD[1] * em
  const panelWidth = Math.max(1, x1 - x0)
  const perLine = Math.max(1, Math.round(slats))
  const stripHeight = (y1 - y0) / (perLine * Math.max(1, lines.length))
  let cols = 1
  let rows = 1
  if (style === 'horizontal') rows = perLine * Math.max(1, lines.length)
  else if (style === 'vertical') cols = Math.max(2, Math.round(panelWidth / (stripHeight * WIDE)))
  else {
    cols = Math.max(1, Math.round(panelWidth / (stripHeight * TILE)))
    if (cols > MAX_CELLS / 4) cols = Math.floor(MAX_CELLS / 4)
    // Tiles are square, so a tile turned over its diagonal lands on its own place: the panel
    // grows to a whole number of them, about its middle.
    const side = panelWidth / cols
    rows = Math.max(1, Math.ceil((y1 - y0) / side - 0.05))
    const grow = (rows * side - (y1 - y0)) / 2
    y0 -= grow
    y1 += grow
  }
  if (cols * rows > MAX_CELLS) {
    const shrink = Math.sqrt(MAX_CELLS / (cols * rows))
    cols = Math.max(1, Math.floor(cols * shrink))
    rows = Math.max(1, Math.floor(rows * shrink))
  }
  const panelHeight = Math.max(1, y1 - y0)
  const cellWidth = panelWidth / cols
  const cellHeight = panelHeight / rows
  const count = cols * rows
  const axis = new Float32Array(count * 2)
  const order = new Float32Array(count)
  const reach = new Float32Array(count)
  const fromMiddle = new Float32Array(count)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      // Horizontal slats turn about x, vertical ones about y; tiles about their rising diagonal,
      // across the ripple that runs from the top left corner.
      const [axisX, axisY] =
        style === 'horizontal'
          ? [1, 0]
          : style === 'vertical'
            ? [0, 1]
            : [Math.SQRT1_2, Math.SQRT1_2]
      order[i] =
        style === 'horizontal'
          ? row
          : style === 'vertical'
            ? col
            : Math.hypot(col + 0.5, row + 0.5) - Math.SQRT1_2
      axis[i * 2] = axisX
      axis[i * 2 + 1] = axisY
      reach[i] = (Math.abs(axisX) * cellHeight + Math.abs(axisY) * cellWidth) / 2
      fromMiddle[i] = Math.hypot(
        (col + 0.5) * cellWidth - panelWidth / 2,
        (row + 0.5) * cellHeight - panelHeight / 2,
      )
    }
  }
  const cells = Float32Array.from(
    [...Array(count).keys()].sort(
      (a, b) => (fromMiddle[b] as number) - (fromMiddle[a] as number) || a - b,
    ),
  )
  return {
    style,
    cols,
    rows,
    block: [x0, y0, x1, y1],
    pitch: [cellWidth, cellHeight],
    axis,
    order,
    reach,
    cells,
    em,
  }
}

/** Seconds between neighbouring slats: `stagger`, shrunk so a long wave starts in time. */
export const gapOf = (p: { stagger: number; duration: number }, last: number): number =>
  last > 0 ? Math.min(Math.max(p.stagger, 0), (SPREAD * Math.max(p.duration, 0.05)) / last) : 0

/** Seconds from the trigger until the last slat lies flat. */
export function spanOf(
  p: { stagger: number; duration: number; delay: number },
  grid: Grid,
): number {
  const last = grid.order.reduce((m, o) => Math.max(m, o), 0)
  return Math.max(p.delay, 0) + last * gapOf(p, last) + Math.max(p.duration, 0.05)
}

/** The turn of every cell at `time` s after the trigger, radians: -π closed, 0 open. */
export function waveAt(
  grid: Grid,
  p: { stagger: number; duration: number; delay: number },
  time: number,
  out: Float32Array = new Float32Array(grid.order.length),
): Float32Array {
  const last = grid.order.reduce((m, o) => Math.max(m, o), 0)
  const gap = gapOf(p, last)
  const length = Math.max(p.duration, 0.05)
  for (let i = 0; i < out.length; i++) {
    const progress = (time - Math.max(p.delay, 0) - (grid.order[i] as number) * gap) / length
    out[i] = -Math.PI * (1 - swing(progress))
  }
  return out
}

/** The ink bands of the raster's lines. */
const linesOf = (r: Raster): Line[] =>
  r.quads.map((q) => ({
    left: q.x,
    right: q.x + q.width,
    top: q.y,
    bottom: q.y + q.height,
    em: q.em,
  }))

/**
 * The second text, laid out as the element would lay it out and rastered: a copy of the element
 * stands in for it next to it for a moment, out of sight. A text longer than a shrink-to-fit
 * element runs past it on one line instead of wrapping, from the side the text is aligned to.
 * `dx`, `dy` place it in the element's box.
 */
async function reverseOf(
  element: HTMLElement,
  words: string,
  ratio: number,
): Promise<{ raster: Raster; dx: number; dy: number } | undefined> {
  const copy = element.cloneNode(false) as HTMLElement
  for (const { name } of [...copy.attributes])
    if (name === 'id' || name.startsWith('data-dio')) copy.removeAttribute(name)
  copy.textContent = words
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  const box = element.getBoundingClientRect()
  const inline = copy.getAttribute('style')
  copy.setAttribute(
    'style',
    `${inline && !inline.trim().endsWith(';') ? `${inline};` : (inline ?? '')}position:absolute;left:0;top:0;margin:0;box-sizing:border-box;width:${box.width}px;min-width:max-content;opacity:0;pointer-events:none`,
  )
  element.after(copy)
  try {
    if (unsupported(copy) || (await fonts(copy))) return undefined
    if (!copy.isConnected) return undefined
    const rastered = raster(copy, 'line', ratio)
    const laid = copy.getBoundingClientRect()
    const align = getComputedStyle(element).textAlign
    const rtl = getComputedStyle(element).direction === 'rtl'
    const end = align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl)
    const over = box.width - laid.width
    const dx = align === 'center' ? over / 2 : end ? over : 0
    return rastered ? { raster: rastered, dx, dy: (box.height - laid.height) / 2 } : undefined
  } finally {
    copy.remove()
  }
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  return map
}

/** One clear pixel: WebGPU cannot copy a canvas without a context. */
function blankCanvas(): HTMLCanvasElement {
  const blank = document.createElement('canvas')
  blank.width = 1
  blank.height = 1
  blank.getContext('2d')
  return blank
}

/** The slats' angles, lifts and axes, one texel per cell, half floats. */
function stateTexture(cols: number, rows: number): DataTexture {
  const map = new DataTexture(
    new Uint16Array(cols * rows * 4),
    cols,
    rows,
    RGBAFormat,
    HalfFloatType,
  )
  map.magFilter = NearestFilter
  map.minFilter = NearestFilter
  map.generateMipmaps = false
  map.colorSpace = NoColorSpace
  map.needsUpdate = true
  return map
}

/** Instanced boxes, one per cell, in draw order. */
function slatGeometry(grid: Grid): InstancedBufferGeometry {
  const box = new BoxGeometry(1, 1, 1)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(box.getIndex())
  geometry.setAttribute('position', box.getAttribute('position'))
  geometry.setAttribute('normal', box.getAttribute('normal'))
  geometry.setAttribute(CELL, new InstancedBufferAttribute(grid.cells, 1))
  geometry.instanceCount = grid.cells.length
  box.dispose()
  return geometry
}

/** Instance attribute: the cell a box draws. */
const CELL = 'slatCell'

/**
 * The heading is printed across real 3D slats that turn to show it: closed, they make a panel in
 * the back color; they turn one after another in a wave, catching the light and casting thin
 * shadows on each other and on the page, until the text lies flat. Horizontal slats, vertical
 * ones or square tiles; played once, scrubbed by the scroll or opened under the pointer. At rest
 * the element is plain DOM text.
 */
const blinds: Effect<Params> = defineEffect({
  name: 'blinds',
  params: {
    style: oneOf('horizontal', 'vertical', 'tiles'),
    trigger: oneOf('view', 'scroll', 'hover'),
    slats: 6,
    gap: 2,
    duration: 0.9,
    stagger: 0.07,
    delay: 0,
    threshold: 0.3,
    angle: 65,
    light: 315,
    back: Object.freeze({ '~kind': 'color', value: 'currentColor' }) as ColorParam,
    reverse: '',
  },
  rebuild: ['slats'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  bleed: 64,
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, app, signal, u, render } = ctx
    const el = element as HTMLElement
    const { stage } = app
    const { style, trigger } = params

    const onScreen = (): boolean => {
      const r = el.getBoundingClientRect()
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < stage.height.peek() &&
        r.left < stage.width.peek()
      )
    }
    // Text the visitor has seen as DOM stays as it is instead of closing to play an intro; veiled
    // text (the entry's `intro`, an entering page) has not been seen. Like text-reveal.
    const veiled = (): boolean =>
      trigger !== 'scroll' && el.getAttribute('data-dio-state') === 'entering'
    let seen = trigger !== 'hover' && onScreen() && !veiled()
    const watch = (): void => {
      if (el.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= trigger !== 'hover' && onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const warn = (reason: string): void => {
      if (DEV) app.log.warn(`blinds: ${reason} cannot be drawn, the text stays as it is`, el)
    }
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    const reason = unsupported(el) ?? (await fonts(el))
    let layout = reason ? undefined : raster(el, 'line', ratio)
    const words = params.reverse.trim()
    let back = layout && words ? await reverseOf(el, words, ratio) : undefined
    if (signal.aborted) return
    seen ||= trigger !== 'hover' && onScreen() && !veiled()
    if (!layout?.quads.length) {
      if (reason) warn(reason)
      ctx.showDom(true)
      return
    }

    const backLines = (b: typeof back): Line[] =>
      b
        ? linesOf(b.raster).map((l) => ({
            ...l,
            left: l.left + b.dx,
            right: l.right + b.dx,
            top: l.top + b.dy,
            bottom: l.bottom + b.dy,
          }))
        : []
    let grid = cut(style, linesOf(layout), params.slats, backLines(back))

    // Uniforms. The panel and its cells in element px (y down); the perspective as 1 / its
    // distance, centred on the panel; the lamp as a unit vector in the element frame (y up).
    const block = uniform(new Vector4())
    const pitch = uniform(new Vector2())
    const cells = uniform(new Vector2())
    const gaps = uniform(new Vector2())
    const thick = uniform(1)
    const centre = uniform(new Vector2())
    const middle = uniform(new Vector2())
    const perspective = uniform(0)
    const distance = uniform(render.camera.position.z || 1000)
    const eye = uniform(new Vector3())
    const lamp = uniform(new Vector3(0, 0, 1))
    const frontFrame = uniform(new Vector4(0, 0, 1, 1))
    const backFrame = uniform(new Vector4(0, 0, 1, 1))
    const reversed = uniform(0)
    // The page behind the text: the front of a slat is cut from it, its color fades in as the
    // slat turns. Unknown (an image, nothing painted) leaves the front clear.
    const paper = uniform(new Color(1, 1, 1))
    const papered = uniform(0)
    const ink = uniform(new Color(0, 0, 0))
    const tinted = uniform(0)

    const frontNodes: { value: Texture }[] = []
    const backNodes: { value: Texture }[] = []
    const stateNodes: { value: Texture }[] = []
    let front: Texture = canvasTexture(layout.canvas)
    let reverseMap: Texture = canvasTexture(back?.raster.canvas ?? blankCanvas())
    let state = stateTexture(grid.cols, grid.rows)
    ctx.onDispose(() => {
      front.dispose()
      reverseMap.dispose()
      state.dispose()
    })

    const stateAt = (cell: V2): V4 => {
      const texel = texture(state, cell.add(0.5).div(cells)).level(float(0))
      stateNodes.push(texel as unknown as { value: Texture })
      return texel as unknown as V4
    }
    /** `v` turned by the angle of `cosine` and `sine` about the unit `axis` in the page (Rodrigues). */
    const rotate = (v: V3, axis: V3, cosine: F, sine: F): V3 =>
      v
        .mul(cosine)
        .add(cross(axis, v).mul(sine))
        .add(axis.mul(dot(axis, v).mul(cosine.oneMinus()))) as V3
    /** Centre of a cell in the element frame, y up. */
    const centreOf = (cell: V2): V2 =>
      vec2(
        block.x.add(cell.x.add(0.5).mul(pitch.x)),
        block.y.add(cell.y.add(0.5).mul(pitch.y)).negate(),
      )
    /** Size of a cell's slat: the gap opens as it turns away from the page. */
    const sizeOf = (phi: F): V2 =>
      pitch.sub(gaps.mul(smoothstep(0.06, 0.5, abs(sin(phi.mul(0.5)))))) as V2
    /** Thickness of a slat: none flat on its face, so nothing of it shows at rest. */
    const depthOf = (phi: F): F => thick.mul(cos(phi).oneMinus().mul(0.5))

    /**
     * How much of the light toward `point` (element frame) the slat of `cell` blocks: a ray to
     * the lamp against the slat's rectangle, softer the longer the way.
     */
    const blockedBy = (point: V3, cell: V2, soft: number): F => {
      const inside = step(0, cell.x)
        .mul(step(cell.x, cells.x.sub(1)))
        .mul(step(0, cell.y))
        .mul(step(cell.y, cells.y.sub(1)))
      const cellState = stateAt(cell)
      const phi = cellState.x
      const cosine = cos(phi)
      const sine = sin(phi)
      const axis = vec3(cellState.z, cellState.w, 0)
      const cellCentre = centreOf(cell)
      const origin = vec3(cellCentre.x, cellCentre.y, cellState.y.sub(depthOf(phi).mul(0.5)))
      const normal = rotate(vec3(0, 0, 1), axis, cosine, sine)
      const facing = dot(lamp, normal)
      const toward = select(facing.greaterThanEqual(0), float(1), float(-1))
      const denom = toward.mul(max(abs(facing), 0.05))
      const rayLength = dot(origin.sub(point), normal).div(denom)
      const hit = point.add(lamp.mul(rayLength)).sub(origin)
      const local = rotate(hit, axis, cosine, sine.negate())
      const size = sizeOf(phi).mul(0.5)
      const penumbra = rayLength.mul(soft).add(0.6)
      const cover = smoothstep(penumbra.negate(), penumbra, size.x.sub(abs(local.x))).mul(
        smoothstep(penumbra.negate(), penumbra, size.y.sub(abs(local.y))),
      )
      // A slat flat on the page casts nothing; one turned out of it all of its shade.
      const solid = smoothstep(0.25, 0.75, abs(sine))
      return inside
        .mul(cover)
        .mul(solid)
        .mul(smoothstep(0.5, 2, rayLength)) as F
    }
    /** Shadow of the cells at `offsets` from `cell` on `point`: 0 lit, 1 in full shade. */
    const shadowOf = (
      point: V3,
      cell: V2,
      offsets: readonly (readonly [number, number])[],
      soft: number,
    ): F => {
      let lit: F = float(1)
      for (const [dc, dr] of offsets)
        lit = lit.mul(blockedBy(point, cell.add(vec2(dc, dr)), soft).oneMinus()) as F
      return lit.oneMinus() as F
    }
    const near: Record<Style, readonly (readonly [number, number])[]> = {
      horizontal: [
        [0, -1],
        [0, 1],
      ],
      vertical: [
        [-1, 0],
        [1, 0],
      ],
      tiles: [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ],
    }
    const under: Record<Style, readonly (readonly [number, number])[]> = {
      horizontal: [-2, -1, 0, 1, 2].map((r) => [0, r] as const),
      vertical: [-1, 0, 1].map((c) => [c, 0] as const),
      tiles: [-1, 0, 1].flatMap((r) => [-1, 0, 1].map((c) => [c, r] as const)),
    }
    /** From the element frame to the box-centre frame the meshes sit in, seen in perspective. */
    const half = u.size.mul(0.5)
    const project = (point: V3): { drawn: V3; flat: V2 } => {
      const local = vec3(point.x.sub(half.x), point.y.add(half.y), point.z)
      const z = min(point.z.mul(perspective), 0.8)
      return {
        // The page camera's perspective, pulled to the panel's centre: like CSS perspective.
        drawn: vec3(local.xy.sub(centre.mul(z)), z.mul(distance)) as V3,
        flat: local.xy.sub(middle.mul(z)).div(z.oneMinus()) as V2,
      }
    }
    // Masked at the clamped point, half a pixel inside the box: the mask is 0.5 on its edge.
    const maskAt = (flat: V2): F => {
      const inset = vec2(0.5).div(u.size)
      return ctx.mask(flat.div(u.size).add(0.5).clamp(inset, inset.oneMinus()))
    }
    const shown = smoothstep(0, 0.2, u.presence)
    const luminance = (cosine: V3): F => dot(cosine, vec3(0.2126, 0.7152, 0.0722))

    // The slats: boxes turned about their axis in the page, lifted so they never sink into it.
    const slats = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    {
      const index = attribute(CELL, 'float') as unknown as F
      const row = floor(index.add(0.5).div(cells.x))
      const col = index.sub(row.mul(cells.x))
      const cell = vec2(col, row)
      const cellState = stateAt(cell)
      const phi = cellState.x
      const cosine = cos(phi)
      const sine = sin(phi)
      const turnAxis = vec3(cellState.z, cellState.w, 0)
      const size = sizeOf(phi)
      const depth = depthOf(phi)
      const unitBox = positionGeometry
      const local = vec3(unitBox.x.mul(size.x), unitBox.y.mul(size.y), unitBox.z.mul(depth))
      const cellCentre = centreOf(cell)
      const point = vec3(cellCentre.x, cellCentre.y, cellState.y.sub(depth.mul(0.5))).add(
        rotate(local, turnAxis, cosine, sine),
      )
      const { drawn, flat } = project(point as V3)
      slats.positionNode = drawn
      // Where the point lies at rest (front) and where it lands closed (back), element px y down.
      const frontAt = vec2(cellCentre.x.add(local.x), cellCentre.y.add(local.y).negate())
      const mirrored = turnAxis.xy.mul(dot(turnAxis.xy, local.xy).mul(2)).sub(local.xy)
      const backAt = vec2(cellCentre.x.add(mirrored.x), cellCentre.y.add(mirrored.y).negate())
      const uvOf = (xy: V2, frontTexel: typeof frontFrame): V2 =>
        vec2(
          xy.x.sub(frontTexel.x).div(frontTexel.z),
          float(1).sub(xy.y.sub(frontTexel.y).div(frontTexel.w)),
        ) as V2
      const vFront = varying(uvOf(frontAt as V2, frontFrame))
      const vBack = varying(uvOf(backAt as V2, backFrame))
      const vPoint = varying(point) as unknown as V3
      const vNormal = varying(rotate(normalGeometry, turnAxis, cosine, sine)) as unknown as V3
      const vFace = varying(normalGeometry.z) as unknown as F
      const vPhi = varying(phi) as unknown as F
      const vCell = varying(cell) as unknown as V2
      const vFlat = varying(flat) as unknown as V2

      const frontTexel = texture(front, vFront)
      frontNodes.push(frontTexel as unknown as { value: Texture })
      const inkAlpha = frontTexel.a
      const inkRGB = sRGBTransferEOTF(frontTexel.rgb.div(max(frontTexel.a, 1e-4))) as V3
      const board = papered.mul(smoothstep(0.08, 0.6, cos(vPhi).oneMinus()))
      const frontA = inkAlpha.add(board.mul(inkAlpha.oneMinus()))
      const frontRGB = inkRGB
        .mul(inkAlpha)
        .add((paper as unknown as V3).mul(board.mul(inkAlpha.oneMinus())))
        .div(max(frontA, 1e-4))
      const backTexel = texture(reverseMap, vBack)
      backNodes.push(backTexel as unknown as { value: Texture })
      // `back` empty or currentColor: the text's own color.
      const tint = mix(ink as unknown as V3, u.back as unknown as V3, tinted) as V3
      // The second text in whichever of the page and the text color stands out on the back.
      const reverseInk = select(
        abs(luminance(paper as unknown as V3).sub(luminance(tint))).greaterThan(
          abs(luminance(ink as unknown as V3).sub(luminance(tint))),
        ),
        paper as unknown as V3,
        ink as unknown as V3,
      )
      const backRGB = mix(tint, reverseInk, backTexel.a.mul(reversed))
      const isFront = vFace.greaterThan(0.5)
      const isBack = vFace.lessThan(-0.5)
      const base = select(isFront, frontRGB, select(isBack, backRGB, tint.mul(EDGE)))
      const alpha = select(isFront, frontA, float(1))

      const normal = normalize(vNormal)
      // Lambert over the same light on a face turned to the viewer: flat on the page it is
      // exactly 1, the DOM's color.
      const ambient = select(isFront, float(AMBIENT.front), float(AMBIENT.back))
      const facing = lamp.z.mul(ambient.oneMinus()).add(ambient)
      const lit = min(
        max(dot(normal, lamp), 0).mul(ambient.oneMinus()).add(ambient).div(facing),
        1.3,
      )
      const shade = shadowOf(vPoint, vec2(round(vCell.x), round(vCell.y)), near[style], 0.08)
      // A glint as a face tilts toward the lamp, minus the one a face flat on the page would
      // have there: none at rest. The painted back and edges shine more than the print.
      const view = normalize(eye.sub(vPoint))
      const halfway = normalize(lamp.add(view))
      const shine = select(isFront, float(70), float(28))
      const strength = select(isFront, float(0.18), float(0.32))
      const gloss = max(
        pow(max(dot(normal, halfway), 0), shine).sub(pow(max(halfway.z, 0), shine)),
        0,
      )
        .mul(strength)
        .mul(shade.oneMinus())
      slats.colorNode = vec4(
        base.mul(lit).mul(shade.mul(-SLAT_SHADOW).add(1)).add(gloss),
        alpha.mul(maskAt(vFlat)).mul(shown),
      )
    }
    const geometry = slatGeometry(grid)
    const slatMesh = new Mesh(geometry, slats)
    slatMesh.frustumCulled = false
    slatMesh.renderOrder = 1

    // Their shadows on the page: a quad over the panel and a margin, darkened where a slat
    // stands between the page and the lamp.
    const margin = uniform(0)
    const page = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    {
      const corner = positionGeometry.xy.add(0.5)
      const x = mix(block.x.sub(margin), block.z.add(margin), corner.x)
      const yDown = mix(block.w.add(margin), block.y.sub(margin), corner.y)
      const point = vec3(x, yDown.negate(), 0)
      page.positionNode = vec3(x.sub(half.x), half.y.sub(yDown), 0)
      const vPoint = varying(point) as unknown as V3
      const cell = vec2(
        floor(vPoint.x.sub(block.x).div(pitch.x)),
        floor(vPoint.y.negate().sub(block.y).div(pitch.y)),
      )
      const shade = shadowOf(vPoint, cell as V2, under[style], 0.22)
      page.colorNode = vec4(
        vec3(0),
        shade
          .mul(PAGE_SHADOW)
          .mul(maskAt(vec2(vPoint.x.sub(half.x), vPoint.y.add(half.y))))
          .mul(shown),
      )
    }
    const pageMesh = new Mesh(new PlaneGeometry(1, 1), page)
    pageMesh.frustumCulled = false
    pageMesh.renderOrder = 0

    const group = new Group()
    group.add(pageMesh, slatMesh)
    ctx.place(group, { fit: 'none', replace: true })
    ctx.showDom(true)
    await ctx.compile(group)
    if (signal.aborted) return
    seen ||= trigger !== 'hover' && onScreen() && !veiled()

    const rest = (): number => (-Math.min(180, Math.max(0, ctx.params.angle)) * Math.PI) / 180
    // Per cell: the scripted or sprung turn, the pointer's tilt over it, their speeds, the sum.
    let base = new Float32Array(grid.cols * grid.rows)
    let baseSpeed = new Float32Array(base.length)
    let tilt = new Float32Array(base.length)
    let tiltSpeed = new Float32Array(base.length)
    let spare = new Float32Array(base.length)
    let phis = new Float32Array(base.length)
    /** Hover: when each cell's turn comes after a tap or focus, s on `clock`. */
    let due = new Float32Array(base.length)
    /** The tilt springs hold still: nothing to integrate until the pointer pushes. */
    let still = true
    const allocate = (n: number): void => {
      base = new Float32Array(n).fill(trigger === 'hover' ? rest() : 0)
      baseSpeed = new Float32Array(n)
      tilt = new Float32Array(n)
      tiltSpeed = new Float32Array(n)
      spare = new Float32Array(n)
      phis = new Float32Array(n)
      due = new Float32Array(n)
      still = true
    }
    allocate(base.length)

    /** Sets the uniforms of the grid and the colors around it. */
    const measure = (): void => {
      const [x0, y0, x1, y1] = grid.block
      ;(block.value as Vector4).set(x0, y0, x1, y1)
      ;(pitch.value as Vector2).set(grid.pitch[0], grid.pitch[1])
      ;(cells.value as Vector2).set(grid.cols, grid.rows)
      thick.value = Math.min(
        THICK_RANGE[1],
        Math.max(THICK_RANGE[0], THICK * Math.min(grid.pitch[0], grid.pitch[1])),
      )
      margin.value = Math.max(grid.pitch[0], grid.pitch[1]) * (style === 'horizontal' ? 2 : 1.2)
      perspective.value = 1 / (EYE * Math.max(x1 - x0, y1 - y0, 200))
      ;(frontFrame.value as Vector4).set(...(layout as Raster).frame)
      if (back) {
        const [fx, fy, fw, fh] = back.raster.frame
        ;(backFrame.value as Vector4).set(fx + back.dx, fy + back.dy, fw, fh)
      }
      reversed.value = back ? 1 : 0
      const computed = getComputedStyle(el)
      const text = linear(computed.getPropertyValue('-webkit-text-fill-color') || computed.color)
      ;(ink.value as Color).copy(text)
      const behind = backdrop(el.parentElement ?? el)
      if (behind?.color) {
        ;(paper.value as Color).copy(linear(behind.color))
        papered.value = 1
      } else {
        // Nothing solid behind: a clear front, and a reverse text in white or black.
        const dark = text.r * 0.2126 + text.g * 0.7152 + text.b * 0.0722 < 0.2
        ;(paper.value as Color).setRGB(dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0)
        papered.value = 0
      }
    }
    measure()

    /** Swaps in a new raster: the grid, its state and the meshes follow. */
    const use = (next: Raster, nextBack: typeof back): void => {
      layout = next
      back = nextBack
      const old = grid
      grid = cut(style, linesOf(next), ctx.params.slats, backLines(nextBack))
      const map = canvasTexture(next.canvas)
      for (const node of frontNodes) node.value = map
      front.dispose()
      front = map
      if (nextBack) {
        const reverseTexture = canvasTexture(nextBack.raster.canvas)
        for (const node of backNodes) node.value = reverseTexture
        reverseMap.dispose()
        reverseMap = reverseTexture
      }
      if (old.cols !== grid.cols || old.rows !== grid.rows) {
        const nextState = stateTexture(grid.cols, grid.rows)
        for (const node of stateNodes) node.value = nextState
        state.dispose()
        state = nextState
        allocate(grid.cols * grid.rows)
      }
      const nextGeometry = slatGeometry(grid)
      slatMesh.geometry.dispose()
      slatMesh.geometry = nextGeometry
      measure()
    }

    // Raster again when the text, its fonts or its width change: at once while the slats move,
    // when the page is idle while the DOM shows.
    let cancel: (() => void) | undefined
    let stuck: string | undefined
    let dom = true
    const redo = async (): Promise<void> => {
      cancel = undefined
      const why = unsupported(el) ?? (await fonts(el))
      if (signal.aborted) return
      if (why && why !== stuck) warn(why)
      stuck = why
      if (why) {
        ctx.invalidate()
        return
      }
      const nextRaster = raster(el, 'line', ratio)
      if (!nextRaster?.quads.length) return
      const reverseWords = ctx.params.reverse.trim()
      const nextBack = reverseWords ? await reverseOf(el, reverseWords, ratio) : undefined
      if (signal.aborted) return
      use(nextRaster, nextBack)
      ctx.invalidate()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(() => void redo(), { timeout: REDO_IDLE_TIMEOUT })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(() => void redo(), REDO_DELAY)
        cancel = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => cancel?.())
    const changes = new MutationObserver(schedule)
    changes.observe(el, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => changes.disconnect())
    const resize = new ResizeObserver(() => {
      const width = el.getBoundingClientRect().width
      if (Math.abs(width - (layout?.width ?? width)) > 0.5) schedule()
    })
    resize.observe(el)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // The pointer in client px while it is over the panel or near it.
    let point: { x: number; y: number } | undefined
    let last: { x: number; y: number } | undefined
    let rect: DOMRect | undefined
    const inPanel = (x: number, y: number, pad: number): boolean => {
      rect ??= el.getBoundingClientRect()
      const [x0, y0, x1, y1] = grid.block
      return (
        x > rect.left + x0 - pad &&
        x < rect.left + x1 + pad &&
        y > rect.top + y0 - pad &&
        y < rect.top + y1 + pad
      )
    }
    const release = (): void => {
      if (!point) return
      point = undefined
      ctx.invalidate()
    }
    const track = (x: number, y: number): void => {
      if (inPanel(x, y, grid.em * 0.5)) {
        point = { x, y }
        ctx.invalidate()
      } else release()
    }
    const opts = { passive: true, signal }
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'touch' || trigger !== 'hover') track(e.clientX, e.clientY)
      },
      opts,
    )
    document.documentElement.addEventListener('pointerleave', release, opts)
    addEventListener('pointerout', (e) => e.relatedTarget || release(), opts)
    const moved = (): void => {
      rect = undefined
      if (point) track(point.x, point.y)
    }
    addEventListener('scroll', moved, opts)
    addEventListener('resize', moved, opts)

    // Hover trigger: a tap opens every slat in a ripple from the finger and closes them again, and
    // keyboard focus opens them from the left.
    let clock = 0
    let opened = false
    const openFrom = (x: number, y: number, open: boolean): void => {
      opened = open
      const [x0, y0] = grid.block
      const [cellWidth, cellHeight] = grid.pitch
      const gap = gapOf(ctx.params, Math.max(grid.cols, grid.rows))
      for (let row = 0; row < grid.rows; row++)
        for (let col = 0; col < grid.cols; col++) {
          const cellsAway = Math.hypot(
            (x0 + (col + 0.5) * cellWidth - x) / cellWidth,
            (y0 + (row + 0.5) * cellHeight - y) / cellHeight,
          )
          due[row * grid.cols + col] = clock + cellsAway * gap
        }
      ctx.invalidate()
    }
    if (trigger === 'hover') {
      const host = (el.closest('a, button') as HTMLElement | null) ?? el
      host.addEventListener(
        'pointerdown',
        (e) => {
          const pointer = e as PointerEvent
          if (pointer.pointerType !== 'touch') return
          rect = el.getBoundingClientRect()
          openFrom(pointer.clientX - rect.left, pointer.clientY - rect.top, !opened)
        },
        opts,
      )
      host.addEventListener('focusin', () => openFrom(grid.block[0], grid.block[1], true), opts)
      host.addEventListener('focusout', () => openFrom(grid.block[0], grid.block[1], false), opts)
    }

    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }

    /** Writes the cells' angles, lifts and axes. */
    const write = (angles: Float32Array): void => {
      const out = state.image.data as unknown as Uint16Array
      const toHalf = DataUtils.toHalfFloat
      for (let i = 0; i < angles.length; i++) {
        const phi = angles[i] as number
        out[i * 4] = toHalf(phi)
        out[i * 4 + 1] = toHalf((grid.reach[i] as number) * Math.abs(Math.sin(phi)))
        out[i * 4 + 2] = toHalf(grid.axis[i * 2] as number)
        out[i * 4 + 3] = toHalf(grid.axis[i * 2 + 1] as number)
      }
      state.needsUpdate = true
    }

    /** The springs of the tilt under the pointer: neighbours pull, so a nudge runs on as a wave. */
    const springs = (dt: number): boolean => {
      if (still) return false
      const { cols, rows } = grid
      const pull = cols > 1 && rows > 1 ? SPRING.grid : SPRING.line
      const steps = Math.min(MAX_STEPS, Math.ceil(dt / STEP))
      const stepTime = steps ? dt / steps : 0
      for (let substep = 0; substep < steps; substep++) {
        for (let row = 0; row < rows; row++)
          for (let col = 0; col < cols; col++) {
            const i = row * cols + col
            const angle = tilt[i] as number
            let around = 0
            if (col > 0) around += (tilt[i - 1] as number) - angle
            if (col < cols - 1) around += (tilt[i + 1] as number) - angle
            if (row > 0) around += (tilt[i - cols] as number) - angle
            if (row < rows - 1) around += (tilt[i + cols] as number) - angle
            const speed = tiltSpeed[i] as number
            const acceleration = -SPRING.k * angle - SPRING.c * speed + pull * around
            tiltSpeed[i] = speed + acceleration * stepTime
            spare[i] = Math.max(
              -MAX_TILT,
              Math.min(MAX_TILT, angle + (speed + acceleration * stepTime) * stepTime),
            )
          }
        const swap = tilt
        tilt = spare
        spare = swap
      }
      still = true
      for (let i = 0; i < tilt.length; i++) {
        if (Math.abs(tilt[i] as number) < 2e-3 && Math.abs(tiltSpeed[i] as number) < 2e-2) {
          tilt[i] = 0
          tiltSpeed[i] = 0
        } else still = false
      }
      return !still
    }

    /** Hover trigger: each cell's turn springs toward closed at rest and open near the pointer. */
    const sprung = (dt: number, px: number | undefined, py: number | undefined): boolean => {
      const { cols, rows } = grid
      const [x0, y0] = grid.block
      const [cellWidth, cellHeight] = grid.pitch
      const closed = rest()
      const [fullReach, restReach] = [REACH[0] * grid.em, REACH[1] * grid.em]
      const steps = Math.min(MAX_STEPS, Math.ceil(dt / STEP))
      const stepTime = steps ? dt / steps : 0
      let busy = false
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
          const i = row * cols + col
          let open = opened && clock >= (due[i] as number) ? 1 : 0
          if (!opened && clock < (due[i] as number)) open = 1
          if (px !== undefined && py !== undefined) {
            const dx = style === 'horizontal' ? 0 : x0 + (col + 0.5) * cellWidth - px
            const dy = style === 'vertical' ? 0 : y0 + (row + 0.5) * cellHeight - py
            open = Math.max(open, 1 - smooth(fullReach, restReach, Math.hypot(dx, dy)))
          }
          const goal = closed * (1 - open)
          let angle = base[i] as number
          let speed = baseSpeed[i] as number
          for (let substep = 0; substep < steps; substep++) {
            speed += (TURN.k * (goal - angle) - TURN.c * speed) * stepTime
            angle += speed * stepTime
          }
          if (Math.abs(angle - goal) < 1e-3 && Math.abs(speed) < 1e-2) {
            angle = goal
            speed = 0
          } else busy = true
          if (clock < (due[i] as number)) busy = true
          base[i] = angle
          baseSpeed[i] = speed
        }
      return busy
    }

    /** The pointer's push on the cells near it, from its speed since the last frame. */
    const nudge = (px: number, py: number, dt: number): void => {
      if (!last || dt <= 0) return
      const vx = (px - last.x) / dt
      const vy = (py - last.y) / dt
      const speed = Math.hypot(vx, vy)
      if (speed < 1) return
      const { cols, rows } = grid
      const [x0, y0] = grid.block
      const [cellWidth, cellHeight] = grid.pitch
      // Down across the slats tips them one way, up the other; along them, the first way.
      const across = style === 'vertical' ? vx + 0.35 * Math.abs(vy) : vy + 0.35 * Math.abs(vx)
      const sign = style === 'tiles' ? 1 : Math.sign(across) || 1
      // PUSH is per frame at 60 fps.
      const kick = PUSH * Math.min(speed, 3000) * dt * 60 * sign
      const sigma = style === 'tiles' ? 0.7 : 1.1
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
          const dx = style === 'horizontal' ? 0 : (x0 + (col + 0.5) * cellWidth - px) / cellWidth
          const dy = style === 'vertical' ? 0 : (y0 + (row + 0.5) * cellHeight - py) / cellHeight
          const distanceSq = (dx * dx + dy * dy) / (sigma * sigma)
          // Past three widths of the bell the push is too small to matter.
          if (distanceSq > 9) continue
          const i = row * cols + col
          tiltSpeed[i] = (tiltSpeed[i] as number) + kick * Math.exp(-distanceSq)
          still = false
        }
    }

    // Seconds since the trigger in once, -1 before it.
    let elapsed = -1
    return (input): boolean => {
      if (stuck) {
        show(true)
        return false
      }
      const p = ctx.params
      const { y, height, progress, presence } = input
      const dt = Math.min(input.delta, 0.05)
      clock += dt
      const total = spanOf(p, grid)
      const vh = stage.height.peek()
      const px = point ? point.x - input.x : undefined
      const py = point ? point.y - input.y : undefined
      let wave = false
      if (trigger === 'hover') wave = sprung(dt, px, py)
      else {
        let time: number
        if (trigger === 'scroll') {
          // From `threshold` of the box in view to the box centred in the viewport, scrubbed.
          const entered = entering(progress, height, vh, p.threshold)
          // Text seen on the first screen stays until scrolling would have shown it anyway.
          if (seen && entered < 1) time = total
          else {
            seen = false
            time = entered * total
          }
        } else {
          if (!seen && elapsed < 0) {
            // Counted above the bottom tenth of the viewport, like text-reveal.
            if (inView(y, height, vh, p.threshold)) elapsed = 0
          } else if (elapsed >= 0 && elapsed < total) elapsed += dt
          time = seen ? total : Math.max(elapsed, 0)
          wave = elapsed >= 0 && elapsed < total
        }
        // Leaving a page the slats close again; entering, they open. The runtime draws while
        // presence moves.
        if (presence < 1) time = Math.min(time, presence * total)
        waveAt(grid, p, time, base)
      }
      if (px !== undefined && py !== undefined) nudge(px, py, dt)
      last = px !== undefined && py !== undefined ? { x: px, y: py } : undefined
      const tilting = springs(dt)
      let open = true
      for (let i = 0; i < phis.length; i++) {
        const phi = (base[i] as number) + (tilt[i] as number)
        phis[i] = phi
        if (phi !== 0) open = false
      }
      const busy = wave || tilting
      if (open && !busy && presence >= 1) {
        show(true)
        return false
      }
      write(phis)
      const backColor = p.back.trim().toLowerCase()
      tinted.value = backColor !== '' && backColor !== 'currentcolor' ? 1 : 0
      const light = (p.light * Math.PI) / 180
      ;(lamp.value as Vector3).set(
        Math.sin(light) * Math.cos(ELEVATION),
        Math.cos(light) * Math.cos(ELEVATION),
        Math.sin(ELEVATION),
      )
      const [x0, y0, x1, y1] = grid.block
      const midX = (x0 + x1) / 2
      const midY = (y0 + y1) / 2
      const world = render.toWorld(input.x + midX, input.y + midY)
      ;(centre.value as Vector2).set(world.x, world.y)
      ;(middle.value as Vector2).set(midX - input.width / 2, input.height / 2 - midY)
      ;(eye.value as Vector3).set(midX, -midY, 1 / (perspective.value as number))
      ;(gaps.value as Vector2).set(
        grid.cols > 1 ? Math.max(0, p.gap) : 0,
        grid.rows > 1 ? Math.max(0, p.gap) : 0,
      )
      distance.value = render.camera.position.z || 1000
      show(false)
      return busy
    }
  },
})
export default blinds
