import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { ease, radii, roundedBox } from '@dioramajs/effects/kit'
import {
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  frontFacing,
  fwidth,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  sign,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type Texture,
  type TextureNode,
  type UniformNode,
  Vector4,
} from 'three/webgpu'
import { type Picture, picture } from './bitmap'
import { afterDrag } from './click'
import { focusRing } from './focus'
import { board, reach, type Shape, shape } from './leaf'
import { offaxisNode } from './offaxis'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Params = {
  index: number
  items: string
  mode: ChoiceParam<'auto' | 'double' | 'single'>
  cover: boolean
  motion: ChoiceParam<'curl' | 'flat' | 'fade'>
  duration: number
  curl: number
  shade: number
  click: boolean
  swipe: boolean
  resolution: number
}

/** How the pages fall into spreads. */
export interface Book {
  /** Pages. */
  readonly n: number
  /** Two pages a spread, else one. */
  readonly double: boolean
  /** The first page stands alone on the right. */
  readonly cover: boolean
}

const unit = (value: number): number => Math.min(1, Math.max(0, value))

/** Number of spreads. */
export const spreads = (book: Book): number =>
  !book.double ? book.n : book.cover ? 1 + Math.ceil((book.n - 1) / 2) : Math.ceil(book.n / 2)

/** The left and right page of `spread`, -1 where there is none. */
export function sides(book: Book, spread: number): [number, number] {
  if (!book.double) return [-1, spread >= 0 && spread < book.n ? spread : -1]
  const left = book.cover ? 2 * spread - 1 : 2 * spread
  const right = left + 1
  return [left >= 0 && left < book.n ? left : -1, right >= 0 && right < book.n ? right : -1]
}

/** The first page of `spread`, what `index` names it by. */
export function first(book: Book, spread: number): number {
  const [left, right] = sides(book, spread)
  return left >= 0 ? left : right
}

/** The spread that holds `page`. */
export function spreadOf(book: Book, page: number): number {
  const spread = !book.double
    ? page
    : book.cover
      ? Math.floor((page + 1) / 2)
      : Math.floor(page / 2)
  return Math.max(0, Math.min(spreads(book) - 1, spread))
}

/** Where `index` is in spreads: a whole spread at its first page, a turn between two. */
export function position(book: Book, index: number): number {
  const spread = spreadOf(book, Math.floor(index))
  if (spread >= spreads(book) - 1) return spread
  const from = first(book, spread)
  return spread + unit((index - from) / (first(book, spread + 1) - from))
}

/**
 * Where the spine stands at spread position `at`, in page widths from the box centre. A book with
 * a cover, closed on it or on the back cover, stands in the middle of the box, and so does every
 * open spread; between two spreads it slides with the turn. One page a spread: its left edge.
 */
export function spine(book: Book, at: number): number {
  const of = (spread: number): number => {
    if (!book.double) return -0.5
    if (!book.cover) return 0
    const [left, right] = sides(book, spread)
    return left < 0 ? -0.5 : right < 0 ? 0.5 : 0
  }
  const spread = Math.floor(at)
  const turned = at - spread
  return turned > 0 ? of(spread) + (of(spread + 1) - of(spread)) * turned : of(spread)
}

/** Two pages side by side when the box holds them at three quarters of a page's height or more. */
export const twoUp = (width: number, height: number, aspect: number): boolean =>
  width >= 1.5 * aspect * height

/** Page width and height of a book of `aspect` pages contained in the box. */
export function pageSize(
  width: number,
  height: number,
  aspect: number,
  double: boolean,
): [number, number] {
  const across = double ? 2 * aspect : aspect
  const pageHeight = width / height > across ? height : width / across
  return [pageHeight * aspect, pageHeight]
}

/** Leaf grid per quality tier: columns along the page, rows up it. */
const GRID = { high: [32, 8], medium: [24, 6], low: [16, 4] } as const
/** Colour of a page not in yet: blank paper. */
const PAPER = vec3(0.95, 0.94, 0.92)
/** Pointer travel that still counts as a tap, px; a drag starts past it. */
const TAP = 8
/** Turn speed at a release that finishes or undoes the turn whatever its progress, px/ms. */
const FLICK = 0.35
/** Light over the leaf, a little from the top left. */
const LIGHT = [-0.25, 0.3, 1] as const

/** A page's picture as a lease and, once in, its texture. */
interface Held {
  readonly lease: Picture
  texture?: Texture
  failed?: boolean
}

/** One page drawn: its picture swaps without a recompile. */
interface Slot {
  readonly node: TextureNode
  /** Cover scale x, y (negative y flips a top-left texture), page present, picture in. */
  readonly frame: UniformNode<'vec4'>
}

/** The pointer since a press on the book. */
interface Press {
  readonly id: number
  readonly x: number
  readonly y: number
  /** Touch or pen whose horizontal pans the site gave to the element. */
  readonly pan: boolean
}

/** A page held by the pointer. */
interface Drag {
  readonly id: number
  /** +1 turns forward (a right page), -1 back. */
  readonly dir: 1 | -1
  /** The spread it started from. */
  readonly from: number
  readonly x: number
  /** Distance of the grab from the spine at the press, px. */
  readonly reach: number
  /** Client x of the spine at the press, and how far it slides by the end of the turn, px. */
  readonly spine: number
  readonly slide: number
  /** 0..1 of the turn. */
  t: number
  /** Turn speed along `dir`, px/ms, and the latest sample. */
  speed: number
  last: { x: number; at: number }
}

/** A page turning on its own: from one spread position to the next. */
interface Turn {
  readonly from: number
  readonly to: number
  /** Eases out only, after a drag. */
  readonly out: boolean
  p: number
}

/** A touch or pen drag needs the site to keep horizontal pans from the page. */
const ownsPan = (el: Element): boolean =>
  !/auto|manipulation|pan-x/.test(getComputedStyle(el).touchAction || 'auto')

/**
 * The page images of a container as a book: spreads whose pages bend as they turn by drag, click
 * or keys. Without WebGL the pages are the site's layout. Fires `dio:index` when a spread is
 * reached.
 */
const flipbook: Effect<Params> = defineEffect({
  name: 'flipbook',
  params: {
    index: 0,
    items: 'img',
    mode: oneOf('auto', 'double', 'single'),
    cover: true,
    motion: oneOf('curl', 'flat', 'fade'),
    duration: 0.9,
    curl: 0.6,
    shade: 0.5,
    click: true,
    swipe: true,
    resolution: 1600,
  },
  rebuild: ['resolution'],
  on: ':not(img, video, canvas)',
  quality: { low: { resolution: 1024 }, medium: { resolution: 1280 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u, render } = ctx
    const el = ctx.element as HTMLElement
    const items = [...el.querySelectorAll(params.items)].filter(
      (node): node is HTMLImageElement => node.localName === 'img',
    )
    const count = items.length
    if (!count) {
      app.log.warn(`flipbook: no images match "${params.items}", the container stays as it is`)
      return
    }
    const mode = params.mode
    const motion = params.motion
    const resolution = params.resolution

    // Pictures: a window of leases around the spread shown, released as it moves on.
    const held = new Map<number, Held>()
    const wake = (): void => ctx.invalidate()
    const lease = (i: number, priority: 'high' | 'normal' = 'normal'): Held => {
      const known = held.get(i)
      if (known) return known
      const img = items[i] as HTMLImageElement
      const url = img.currentSrc || img.src
      const entry: Held = { lease: picture(ctx, url, { resolution, priority }) }
      held.set(i, entry)
      entry.lease.ready.then(
        (texture) => {
          entry.texture = texture
          wake()
        },
        (error) => {
          entry.failed = true
          if (signal.aborted || held.get(i) !== entry) return
          app.log.warn(`flipbook: page ${i + 1} (${url}) did not load, it shows blank`, error)
          wake()
        },
      )
      return entry
    }
    const keep = (wanted: readonly number[], first?: number): void => {
      for (const [i, entry] of held) {
        if (wanted.includes(i)) continue
        entry.lease.release()
        held.delete(i)
      }
      for (const i of wanted) if (i >= 0) lease(i, i === first ? 'high' : 'normal')
    }
    ctx.onDispose(() => keep([]))
    /** In, failed or absent: nothing to wait for. */
    const settled = (i: number): boolean => {
      if (i < 0) return true
      const entry = held.get(i)
      return Boolean(entry?.texture || entry?.failed)
    }

    const size = (): [number, number] => {
      const { width, height } = ctx.input
      if (width && height) return [width, height]
      const rect = el.getBoundingClientRect()
      return [rect.width, rect.height]
    }
    // The book takes the proportion of its first page.
    const naturalAspect = (): number | undefined => {
      const img = items[0] as HTMLImageElement
      return img.naturalWidth && img.naturalHeight
        ? img.naturalWidth / img.naturalHeight
        : undefined
    }
    let aspect = naturalAspect() ?? 0
    const doubleNow = (width: number, height: number): boolean =>
      mode === 'double' || (mode === 'auto' && twoUp(width, height, aspect || Math.SQRT1_2))
    const bookNow = (width: number, height: number): Book => ({
      n: count,
      double: doubleNow(width, height),
      cover: Boolean(params.cover),
    })

    let book = bookNow(...size())
    const index = params.index
    const opening = (of: Book): number =>
      Number.isInteger(index) ? spreadOf(of, index) : position(of, index)
    /** The spread position shown: whole on a spread, fractional during a turn. */
    let current = opening(book)
    const pages = (of: Book, ...spreadList: number[]): number[] => {
      const out: number[] = []
      for (const spread of spreadList) {
        if (spread < 0 || spread >= spreads(of)) continue
        for (const page of sides(of, spread)) if (page >= 0 && !out.includes(page)) out.push(page)
      }
      return out
    }
    // The spread nearest and one either side: at most six pages, both ends of any turn.
    const around = (at: number, of: Book): number[] => {
      const nearest = Math.round(at)
      return pages(of, nearest, nearest + 1, nearest - 1)
    }
    // The first spread in before the copy shows, so it never starts blank.
    {
      const start = Math.floor(current)
      const need = [...sides(book, start), ...sides(book, start + 1)].filter((i) => i >= 0)
      if (!aspect && !need.includes(0)) need.push(0)
      keep(need, need[0])
      await Promise.all(need.map((i) => held.get(i)?.lease.ready.catch(() => {})))
      if (signal.aborted) return
      if (!aspect) {
        const image = held.get(0)?.texture?.image as { width?: number; height?: number } | undefined
        aspect = image?.width && image.height ? image.width / image.height : Math.SQRT1_2
      }
      book = bookNow(...size())
      current = opening(book)
      keep(around(current, book))
    }

    // Shared uniforms. geo: spine x from the box centre, page width and height, two-up 0/1.
    const geo = uniform(new Vector4())
    // fold, radius, bend, mirror (-1 for a leaf lifted on the left).
    const leafShape = uniform(new Vector4())
    // cos and sin of the fold's lean, cos and sin of the turn at the spine.
    const leafTurn = uniform(new Vector4(1, 0, 1, 0))
    // Box centre in world px, perspective, camera distance.
    const view = uniform(new Vector4(0, 0, 1, 1000))
    // The leaf's edge over each page at the bottom and top rows, from the spine, and its height
    // there: right edge (x bottom, x top, z bottom, z top), left edge the same.
    const edgeR = uniform(new Vector4())
    const edgeL = uniform(new Vector4())
    const geoNode = geo as unknown as V4
    const spineX = geoNode.x
    const pageWidth = geoNode.y
    const pageHeight = geoNode.z
    const twoPages = geoNode.w
    const box = u.size as unknown as V2
    const shading = u.shade as unknown as F

    const blank = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    blank.needsUpdate = true
    ctx.onDispose(() => blank.dispose())
    const slot = (): Slot => {
      const node = texture(blank) as unknown as TextureNode
      // Its own binding: slots compiled on the same texture would otherwise share one.
      ;(node as unknown as { mergeable: boolean }).mergeable = false
      return { node, frame: uniform(new Vector4(1, 1, 0, 0)) as unknown as UniformNode<'vec4'> }
    }
    const paint = (slot: Slot, at: V2): V4 => {
      const frame = slot.frame as unknown as V4
      const color = slot.node.sample(at.sub(0.5).mul(frame.xy).add(0.5))
      return vec4(mix(PAPER, color.rgb, frame.w), frame.z) as unknown as V4
    }
    // The darkening near the spine, the same on still pages and the leaf: `x` px from the spine.
    const gutter = (x: F): F =>
      smoothstep(0, pageWidth.mul(0.12), abs(x))
        .oneMinus()
        .mul(shading, 0.22, twoPages)
        .oneMinus() as unknown as F
    // Mask of the box at a point px from its centre, clamped so a leaf over the edge is not cut.
    const masked = (point: V2): F => ctx.mask(point.div(box).add(0.5).clamp(0, 1) as V2) as F

    // Still pages: each crossfades between two pictures (under reduced motion) and takes the
    // leaf's shadow beyond its edge.
    const still = (side: 1 | -1) => {
      const a = slot()
      const b = slot()
      const rect = uniform(new Vector4())
      const fade = uniform(0)
      const rectNode = rect as unknown as V4
      const vertex = positionGeometry.xy.mul(rectNode.zw).add(rectNode.xy) as unknown as V2
      const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
      material.positionNode = vec3(vertex.div(box), 0)
      // The point in px from the box centre.
      const point = varying(vertex) as unknown as V2
      const color = mix(paint(a, uv()), paint(b, uv()), fade)
      const fromSpine = point.x.sub(spineX)
      const leafEdge = (side > 0 ? edgeR : edgeL) as unknown as V4
      const up = point.y.div(pageHeight).add(0.5).clamp(0, 1)
      const edge = mix(leafEdge.x, leafEdge.y, up)
      const lift = max(mix(leafEdge.z, leafEdge.w, up), 0)
      const pastEdge = side > 0 ? fromSpine.sub(edge) : edge.sub(fromSpine)
      // Darkest at the leaf's edge, wider and stronger the higher it is.
      const fall = clamp(pastEdge.div(lift.mul(0.45).add(8)), 0, 1).oneMinus()
      const shadow = fall
        .mul(fall)
        .mul(exp(lift.div(-40)).oneMinus(), shading, 0.9)
        .oneMinus()
      material.colorNode = vec4(
        color.rgb.mul(shadow, gutter(fromSpine as F)),
        color.a.mul(masked(point)),
      )
      const mesh = new Mesh(new PlaneGeometry(1, 1), material)
      mesh.frustumCulled = false
      return { mesh, a, b, rect, fade }
    }
    const left = still(-1)
    const right = still(1)

    // The turning leaf. The vertex graph mirrors `point` of leaf.ts; the normal is its derivative.
    const front = slot()
    const back = slot()
    const [cols, rows] = GRID[ctx.quality] ?? GRID.high
    const shapeNode = leafShape as unknown as V4
    const fold = shapeNode.x
    const radius = shapeNode.y
    const bend = shapeNode.z
    const mirror = shapeNode.w
    const turnNode = leafTurn as unknown as V4
    const cosTilt = turnNode.x
    const sinTilt = turnNode.y
    const cosRoot = turnNode.z
    const sinRoot = turnNode.w
    const viewNode = view as unknown as V4
    // The grid point in px: from the spine and from the page's middle.
    const u0 = positionGeometry.x.add(0.5).mul(pageWidth)
    const v0 = positionGeometry.y.mul(pageHeight)
    const pastFold = u0.sub(fold).mul(cosTilt).add(v0.mul(sinTilt))
    const along = fold.sub(u0).mul(sinTilt).add(v0.mul(cosTilt))
    // The bend is signed: back up while the free edge trails.
    const arc = radius.mul(abs(bend))
    const bendSign = sign(bend)
    const phi = clamp(pastFold, 0, arc).div(radius)
    const rest = max(pastFold.sub(arc), 0)
    const across = min(pastFold, 0)
      .add(radius.mul(sin(phi)))
      .add(rest.mul(cos(bend)))
    const localZ = bendSign.mul(radius, cos(phi).oneMinus()).add(rest.mul(sin(bend)))
    const localX = fold.add(across.mul(cosTilt)).sub(along.mul(sinTilt))
    const localY = across.mul(sinTilt).add(along.mul(cosTilt))
    const turnedX = localX.mul(cosRoot).sub(localZ.mul(sinRoot)).mul(mirror)
    const turnedZ = localX.mul(sinRoot).add(localZ.mul(cosRoot))
    const slope = bendSign.mul(sin(phi)).negate()
    const normalX = slope.mul(cosTilt)
    const normal = varying(
      vec3(
        normalX.mul(cosRoot).sub(cos(phi).mul(sinRoot)).mul(mirror),
        slope.mul(sinTilt),
        normalX.mul(sinRoot).add(cos(phi).mul(cosRoot)),
      ),
    ) as unknown as V3
    const flat = vec3(turnedX.add(spineX), localY, turnedZ) as unknown as V3
    const drawn = offaxisNode(flat, viewNode.xy, viewNode.z as F, viewNode.w as F)
    const leafMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      side: DoubleSide,
    })
    // One pass: a transparent double-sided material would otherwise draw its sides apart.
    leafMaterial.forceSinglePass = true
    leafMaterial.positionNode = vec3(drawn.xy.div(box), drawn.z)
    {
      const at = uv()
      const color = select(frontFacing, paint(front, at), paint(back, vec2(at.x.oneMinus(), at.y)))
      const surfaceNormal = normalize(normal)
      const eye = normalize(cameraPosition.sub(positionWorld))
      // The normal of the side that faces the viewer.
      const facing = surfaceNormal.mul(select(dot(surfaceNormal, eye).greaterThanEqual(0), 1, -1))
      const light = normalize(vec3(...LIGHT))
      // Lambert lighting scaled so a flat page facing the viewer stays at 1.
      const lit = min(
        max(dot(facing, light), 0).mul(0.4).add(0.6).div(light.z.mul(0.4).add(0.6)),
        1.04,
      )
      const shade = mix(1, lit, shading).mul(gutter(at.x.mul(pageWidth) as unknown as F))
      // A single page goes out of sight at the spine as it turns over.
      const leafX = varying(turnedX) as unknown as F
      const keep = mix(clamp(leafX.div(max(fwidth(leafX), 1e-4)).add(0.5), 0, 1), 1, twoPages)
      const point = varying(drawn.xy) as unknown as V2
      leafMaterial.colorNode = vec4(color.rgb.mul(shade), color.a.mul(keep, masked(point)))
    }
    const leaf = new Mesh(new PlaneGeometry(1, 1, cols, rows), leafMaterial)
    leaf.frustumCulled = false
    leaf.renderOrder = 1
    leaf.visible = false

    // The focus ring the hidden container would show.
    const ring = focusRing(ctx, el)
    const corner = uniform(0)
    const ringMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    {
      const margin = ring.width.add(ring.offset).add(2)
      const span = box.add(margin.mul(2))
      const vertex = positionGeometry.xy.mul(span)
      ringMaterial.positionNode = vec3(vertex.div(box), 0)
      const at = varying(vertex) as unknown as V2
      const edge = roundedBox(at, box.mul(0.5) as V2, corner as unknown as F)
      ringMaterial.colorNode = vec4(ring.color, ring.alpha(edge).mul(u.opacity))
    }
    const ringMesh = new Mesh(new PlaneGeometry(1, 1), ringMaterial)
    ringMesh.frustumCulled = false
    ringMesh.renderOrder = 2

    const group = new Group()
    group.add(left.mesh, right.mesh, leaf, ringMesh)
    ctx.place(group, { replace: true })

    // State: the spread position shown, the turn on its way, the pointer.
    let goal = Math.round(current)
    let reached = Number.isInteger(current) ? current : -1
    let turn: Turn | undefined
    /** The spread a long jump lands next to, while its pages load. */
    let jump: number | undefined
    let drag: Drag | undefined
    let press: Press | undefined
    /** The latest press, for telling a tap from a drag. */
    let down: { id: number; x: number; y: number } | undefined
    let dragged = false
    const drags = afterDrag(el, signal)
    /** Which side the leaf lifts on (-1 mirrors it to the left page) and the height grabbed, -1..1. */
    let side: 1 | -1 = 1
    let grab = 0
    let laid = `${book.double} ${book.cover}`
    /** Where the spine stands, as drawn last: page widths from the box centre. */
    let lean = spine(book, current)

    const step = (by: number, height = -0.35): void => {
      const spread = Math.max(0, Math.min(spreads(book) - 1, goal + by))
      if (spread === goal || drag) return
      side = by < 0 ? -1 : 1
      grab = height
      ctx.set({ index: first(book, spread) })
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler, { signal })
    /** Client x of the spine and the page width, client y of the book's middle and its height. */
    const frame = (): { spine: number; w: number; mid: number; h: number; centre: number } => {
      const rect = el.getBoundingClientRect()
      const [w, h] = pageSize(rect.width, rect.height, aspect, book.double)
      const centre = rect.left + rect.width / 2
      return { spine: centre + lean * w, w, mid: rect.top + rect.height / 2, h, centre }
    }
    // The pages' images are the site's; dragging one would pick it up.
    listen('dragstart', (e) => e.preventDefault())
    listen('pointerdown', (e) => {
      if (e.button !== 0 || drag) return
      dragged = false
      down = { id: e.pointerId, x: e.clientX, y: e.clientY }
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        pan: e.pointerType === 'mouse' || ownsPan(el),
      }
    })
    listen('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return
      const dx = e.clientX - press.x
      const pageFrame = frame()
      if (!drag) {
        if (!params.swipe || !press.pan || turn || !Number.isInteger(current)) return
        if (Math.abs(dx) < TAP || Math.abs(dx) < Math.abs(e.clientY - press.y)) return
        const dir = book.double ? (press.x >= pageFrame.spine ? 1 : -1) : dx < 0 ? 1 : -1
        // Only a page moved the way it turns, and only towards a spread there is.
        if (Math.sign(dx) === dir || current + dir < 0 || current + dir >= spreads(book)) {
          press = undefined
          return
        }
        dragged = true
        side = book.double ? dir : 1
        grab = Math.max(-1, Math.min(1, (pageFrame.mid - press.y) / (pageFrame.h / 2)))
        drag = {
          id: press.id,
          dir,
          from: current,
          x: press.x,
          reach: Math.max(Math.abs(press.x - pageFrame.spine), pageFrame.w / 3),
          spine: pageFrame.spine,
          slide: (spine(book, current + dir) - spine(book, current)) * pageFrame.w,
          t: 0,
          speed: 0,
          last: { x: e.clientX, at: e.timeStamp },
        }
        try {
          // Moves past the box still turn the page.
          el.setPointerCapture(e.pointerId)
        } catch {
          // The pointer is gone already: its up or cancel follows.
        }
      }
      const held = drag
      // The grabbed point goes from the press to its mirror over the spine where the turn ends,
      // the spine sliding there with the turn: at both ends it is under the pointer, and without
      // a slide all the way. The acos maps that straight path onto the turn's half circle.
      const from = held.spine + held.dir * held.reach
      const to = held.spine + held.slide - held.dir * held.reach
      const single = !book.double && held.dir < 0
      held.t = single
        ? unit((e.clientX - held.x) / pageFrame.w)
        : Math.acos(1 - 2 * unit((e.clientX - from) / (to - from))) / Math.PI
      const elapsed = e.timeStamp - held.last.at
      if (elapsed > 0) {
        const speed = (-(e.clientX - held.last.x) * held.dir) / elapsed
        held.speed = held.speed * 0.5 + speed * 0.5
        held.last = { x: e.clientX, at: e.timeStamp }
      }
      wake()
    })
    const release = (e: PointerEvent, cancelled: boolean): void => {
      if (press?.id === e.pointerId) press = undefined
      const held = drag
      if (!held || e.pointerId !== held.id) return
      drag = undefined
      const quick = Math.abs(held.speed) > FLICK && e.timeStamp - held.last.at < 100
      const done = !cancelled && (quick ? held.speed > 0 : held.t > 0.5)
      if (done) ctx.set({ index: first(book, held.from + held.dir) })
      else goal = held.from
      wake()
    }
    listen('pointerup', (e) => {
      const from = down
      if (from?.id === e.pointerId) {
        down = undefined
        // A press that moved or turned a page is a drag: its click turns nothing.
        if (dragged || Math.hypot(e.clientX - from.x, e.clientY - from.y) > TAP) drags.arm(e)
      }
      release(e, false)
    })
    listen('pointercancel', (e) => {
      if (down?.id === e.pointerId) down = undefined
      release(e, true)
    })
    listen('click', (e) => {
      if (!params.click || drags.ends(e)) return
      const pageFrame = frame()
      // Two pages: the side of the spine, so a click anywhere on a closed book opens it.
      step(
        e.clientX >= (book.double ? pageFrame.spine : pageFrame.centre) ? 1 : -1,
        Math.max(-1, Math.min(1, (pageFrame.mid - e.clientY) / (pageFrame.h / 2))),
      )
    })
    listen('keydown', (e) => {
      if (e.target !== el || e.altKey || e.ctrlKey || e.metaKey) return
      const last = spreads(book) - 1
      const by =
        e.key === 'ArrowRight' || e.key === 'PageDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'PageUp'
            ? -1
            : e.key === 'Home'
              ? -goal
              : e.key === 'End'
                ? last - goal
                : undefined
      if (by === undefined) return
      e.preventDefault()
      if (by) step(by)
    })

    /** Puts `page` on a slot; a missing page is blank paper with `paper`, else nothing. */
    const fill = (target: Slot, page: number, paper = false): void => {
      const frame = target.frame.value as Vector4
      const texture = page >= 0 ? held.get(page)?.texture : undefined
      target.node.value = texture ?? blank
      if (!texture) {
        frame.set(1, 1, page >= 0 || paper ? 1 : 0, 0)
        return
      }
      // Cover: a page of another shape is cut to the book's.
      const image = texture.image as { width: number; height: number }
      const pictureAspect = image.width / image.height
      const flip = (texture as { isCompressedTexture?: boolean }).isCompressedTexture ? -1 : 1
      const wider = pictureAspect > aspect
      frame.set(
        wider ? aspect / pictureAspect : 1,
        (wider ? 1 : pictureAspect / aspect) * flip,
        1,
        1,
      )
    }
    const world = { x: 0, y: 0 }

    return (input): boolean => {
      const { width, height } = input
      book = bookNow(width, height)
      const total = spreads(book)
      const layout = `${book.double} ${book.cover}`
      const wanted = params.index
      if (layout !== laid) {
        // Another arrangement of the same pages: the spread with the index, at once.
        laid = layout
        current = position(book, wanted)
        goal = spreadOf(book, wanted)
        turn = undefined
        drag = undefined
      }
      // fade: a crossfade at the turn's own duration; reduced motion: the same in 0.25 s.
      const calm = input.reducedMotion || motion === 'fade'
      if (drag) current = drag.from + drag.dir * drag.t
      else if (!Number.isInteger(wanted)) {
        // Scrubbed (a tween): the exact frame between two spreads.
        current = position(book, wanted)
        goal = Math.round(current)
        turn = undefined
        side = 1
        grab = 0
      } else {
        goal = spreadOf(book, wanted)
        jump = undefined
        if (current === goal) turn = undefined
        if (
          current !== goal &&
          !turn &&
          Number.isInteger(current) &&
          Math.abs(goal - current) > 1
        ) {
          // A jump of several spreads turns only the last page, once both ends are in.
          const aim = goal - Math.sign(goal - current)
          if (pages(book, aim, goal).every(settled)) current = aim
          else jump = aim
        }
        if (current !== goal && jump === undefined) {
          const to = current < goal ? Math.floor(current) + 1 : Math.ceil(current) - 1
          const lower = Math.floor(Math.min(current, to))
          const ready = [...sides(book, lower), ...sides(book, lower + 1)].every(settled)
          if (!turn || turn.to !== to) {
            if (!Number.isInteger(current)) turn = { from: current, to, out: true, p: 0 }
            else if (ready) {
              if (side !== Math.sign(to - current)) grab = -0.35
              side = to > current ? 1 : -1
              turn = { from: current, to, out: false, p: 0 }
            }
          }
          if (turn) {
            const length =
              (input.reducedMotion ? 0.25 : params.duration) * Math.abs(turn.to - turn.from)
            turn.p += input.delta / Math.max(length, 1e-3)
            const progress = Math.min(1, turn.p)
            const eased = turn.out ? 1 - (1 - progress) ** 3 : ease('cubicInOut', progress)
            current = turn.from + (turn.to - turn.from) * eased
            // Steps of 1/60 s add up to a hair under 1.
            if (turn.p >= 1 - 1e-9) {
              current = turn.to
              turn = undefined
            }
          }
        }
      }
      const moving = !!turn
      current = Math.max(0, Math.min(total - 1, current))
      if (current === goal && current !== reached && !drag) {
        reached = current
        el.dispatchEvent(
          new CustomEvent('dio:index', { detail: { index: first(book, current) }, bubbles: true }),
        )
      }

      // Pages: the two spreads either side of the turn, leases around them.
      const spread = Math.min(Math.floor(current), total - 1)
      const turned = current - spread
      keep(
        jump === undefined ? around(current, book) : pages(book, spread, jump, goal),
        first(book, Math.round(current)),
      )
      // The pages of the spread the turn leaves and of the one it reaches.
      const [leftFrom, rightFrom] = sides(book, spread)
      const [leftTo, rightTo] = turned > 0 ? sides(book, spread + 1) : [-1, -1]
      const turning = turned > 0 && !calm
      fill(left.a, leftFrom)
      fill(left.b, leftTo)
      fill(right.a, rightFrom)
      fill(right.b, rightTo)
      left.fade.value = calm ? turned : 0
      right.fade.value = calm ? turned : turning ? 1 : 0
      leaf.visible = turning
      if (turning) {
        fill(front, rightFrom)
        if (book.double) fill(back, leftTo)
        else fill(back, -1, true)
      }

      // Geometry in px from the box centre, y up. Under reduced motion the book moves at once.
      const [pageWidthPx, pageHeightPx] = pageSize(width, height, aspect, book.double)
      lean = input.reducedMotion && !drag ? spine(book, goal) : spine(book, current)
      const spinePx = lean * pageWidthPx
      ;(geo.value as Vector4).set(spinePx, pageWidthPx, pageHeightPx, book.double ? 1 : 0)
      ;(left.rect.value as Vector4).set(spinePx - pageWidthPx / 2, 0, pageWidthPx, pageHeightPx)
      ;(right.rect.value as Vector4).set(spinePx + pageWidthPx / 2, 0, pageWidthPx, pageHeightPx)
      const rightEdge = edgeR.value as Vector4
      const leftEdge = edgeL.value as Vector4
      rightEdge.set(pageWidthPx, pageWidthPx, 0, 0)
      leftEdge.set(-pageWidthPx, -pageWidthPx, 0, 0)
      if (turning) {
        const mirror = book.double ? side : 1
        const t = mirror < 0 ? 1 - turned : turned
        const leafNow: Shape =
          motion === 'flat'
            ? board(t, pageWidthPx)
            : shape(t, grab, pageWidthPx, pageHeightPx, params.curl)
        ;(leafShape.value as Vector4).set(leafNow.fold, leafNow.radius, leafNow.bend, mirror)
        ;(leafTurn.value as Vector4).set(
          Math.cos(leafNow.tilt),
          Math.sin(leafNow.tilt),
          Math.cos(leafNow.root),
          Math.sin(leafNow.root),
        )
        // Where the leaf reaches over each page, mirrored with it.
        const bottom = reach(leafNow, pageWidthPx, -pageHeightPx / 2)
        const top = reach(leafNow, pageWidthPx, pageHeightPx / 2)
        if (mirror > 0) {
          rightEdge.set(bottom.right, top.right, bottom.rightZ, top.rightZ)
          leftEdge.set(bottom.left, top.left, bottom.leftZ, top.leftZ)
        } else {
          rightEdge.set(-bottom.left, -top.left, bottom.leftZ, top.leftZ)
          leftEdge.set(-bottom.right, -top.right, bottom.rightZ, top.rightZ)
        }
        const centre = render.toWorld(input.x + width / 2, input.y + height / 2, world)
        const distance = render.camera.position.z || 1000
        // The book's own perspective: at least three times its size.
        const perspective = Math.max(3 * (pageWidthPx + pageHeightPx), distance * 0.6)
        ;(view.value as Vector4).set(centre.x, centre.y, perspective, distance)
      }
      const shown = ring.on.value > 0
      ringMesh.visible = shown
      if (shown) corner.value = radii(el, width, height)[0]
      return moving
    }
  },
})
export default flipbook
