import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp, ease, inView } from '@dioramajs/effects/kit'
import {
  attribute,
  float,
  mix,
  positionGeometry,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  varying,
  vec3,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  RedFormat,
  RepeatWrapping,
  Vector2,
} from 'three/webgpu'
import { SHOWN } from './table'

type Region = 'world' | 'europe' | 'americas' | 'asia' | 'africa' | 'oceania'
type Params = {
  markers: string
  style: ChoiceParam<'dots' | 'solid'>
  region: ChoiceParam<Region>
  dots: number
  center: number
  zoom: number
  color: ColorParam
  sea: number
  land: ColorParam
  marker: ColorParam
  arc: ColorParam
  markerSize: number
}

/** A place on the map, from an element. */
interface Marker {
  readonly id: string | null
  readonly lat: number
  readonly lng: number
  readonly element: Element
  /** Ids of the places arcs go to. */
  readonly to: readonly string[]
}

// The land mask of @dioramajs/globe: 720 x 360 cells of 0.5°, rows from the north.
const WIDTH = 720
const HEIGHT = 360
/**
 * The mask is run lengths of sea and land in turn, a digit per character. A digit below TERMINAL
 * ends a run; digits from TERMINAL up come before it and count whole TERMINALs, in base BASE.
 */
const TERMINAL = 80
const BASE = 10
const RAD = Math.PI / 180
/** Arcs draw in this long, each a little after the one before. */
const DRAW = 1.2
const STAGGER = 0.15
/** Width of an arc on screen, px. */
const ARC_WIDTH = 1.5
/** Straight pieces per arc. */
const SEGMENTS = 40
/** Markers the pointer is tested against, at most. */
const HITS = 500
/** Antarctica is left out: south of this the map draws no land or sea. */
const SOUTH_LAT = -60
const SOUTH = (SOUTH_LAT + 90) / 180

/** West, east, south and north edges of a region in degrees. */
export const REGIONS: Record<Region, readonly [number, number, number, number]> = {
  world: [-180, 180, -58, 84],
  europe: [-25, 45, 34, 71],
  americas: [-170, -30, -56, 74],
  asia: [25, 150, -11, 72],
  africa: [-20, 55, -36, 38],
  oceania: [110, 180, -48, 2],
}

/** Decodes the land mask of @dioramajs/globe/land: 1 for land, `WIDTH` cells a row. */
export function unpack(text: string): Uint8Array {
  const cells = new Uint8Array(WIDTH * HEIGHT)
  let at = 0
  let land = 0
  let lead = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // Printable characters from '#', skipping the quote and the backslash.
    const digit = code - 35 - (code > 39 ? 1 : 0) - (code > 92 ? 1 : 0)
    if (digit >= TERMINAL) {
      lead = lead * BASE + digit - TERMINAL
      continue
    }
    const run = lead * TERMINAL + digit
    lead = 0
    if (land) cells.fill(1, at, at + run)
    at += run
    land ^= 1
  }
  return cells
}

/** The mask cell of a latitude and a longitude in degrees. */
const cellOf = (lat: number, lng: number): number =>
  Math.min(HEIGHT - 1, Math.max(0, Math.floor((90 - lat) * 2))) * WIDTH +
  Math.min(WIDTH - 1, Math.floor((((lng % 360) + 540) % 360) * 2))

let mask: Uint8Array | undefined
async function landMask(): Promise<Uint8Array> {
  if (!mask) mask = unpack((await import('@dioramajs/globe/land')).default)
  return mask
}

// Equal Earth (Šavrič, Patterson, Jenny 2018): equal area, a familiar outline.
const A1 = 1.340264
const A2 = -0.081106
const A3 = 0.000893
const A4 = 0.003796
const M = Math.sqrt(3) / 2

/** Projected x, y of a latitude and a longitude from the central meridian, in radians. */
export function project(phi: number, lambda: number): [number, number] {
  const t = Math.asin(M * Math.sin(phi))
  const t2 = t * t
  const t6 = t2 * t2 * t2
  const x = (lambda * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)))
  const y = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
  return [x, y]
}

/** Latitude and longitude in radians of a projected point, undefined outside the world. */
export function unproject(x: number, y: number): [number, number] | undefined {
  let t = y / A1
  for (let i = 0; i < 6; i++) {
    const t2 = t * t
    const t6 = t2 * t2 * t2
    const f = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - y
    t -= f / (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))
  }
  const s = Math.sin(t) / M
  if (!(Math.abs(s) <= 1)) return undefined
  const t2 = t * t
  const t6 = t2 * t2 * t2
  const lambda = (M * x * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))) / Math.cos(t)
  return Math.abs(lambda) <= Math.PI ? [Math.asin(s), lambda] : undefined
}

/** A longitude in -180..180. */
const wrap = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180

/** An attribute's angle in degrees, NaN when missing or past `limit`. */
function degrees(value: string | null, limit: number): number {
  const angle = value?.trim() ? Number(value) : Number.NaN
  return Math.abs(angle) <= limit ? angle : Number.NaN
}

const MAPS = '[data-dio~="map"]'

/** Places from elements: inside the map, else anywhere outside every map. */
function readMarkers(element: Element, selector: string): Marker[] {
  let nodes = [...element.querySelectorAll(selector)]
  if (!nodes.length)
    nodes = [...document.querySelectorAll(selector)].filter(
      (node) => node !== element && !node.closest(MAPS),
    )
  const found: Marker[] = []
  for (const node of nodes) {
    const lat = degrees(node.getAttribute('data-dio-lat'), 90)
    const lng = degrees(node.getAttribute('data-dio-lng'), 180)
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue
    const to = (node.getAttribute('data-dio-to') ?? '').split(/\s+/).filter(Boolean)
    found.push({ id: node.id || null, lat, lng, element: node, to })
  }
  return found
}

/** The view in projected units: centre and size, with the region's middle meridian. */
interface View {
  cx: number
  cy: number
  width: number
  height: number
  mid: number
}

/**
 * The region's projected bounds around its middle meridian (moved by `center`), shrunk by `zoom`
 * and widened to the box's proportions, so the region fits and the rest of the box shows more map.
 */
export function viewOf(region: Region, center: number, zoom: number, aspect: number): View {
  const [west, east, south, north] = REGIONS[region] ?? REGIONS.world
  const half = (east - west) / 2
  const mid = wrap((west + east) / 2 + center)
  // The projected bounds of a 17 x 17 grid over the region.
  let x0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (let i = 0; i <= 16; i++)
    for (let j = 0; j <= 16; j++) {
      const [x, y] = project(
        (south + ((north - south) * j) / 16) * RAD,
        (-half + (2 * half * i) / 16) * RAD,
      )
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  const scale = Math.max(zoom, 0.1)
  let width = (x1 - x0) / scale
  let height = (y1 - y0) / scale
  if (width / height < aspect) width = height * aspect
  else height = width / aspect
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, width, height, mid }
}

/** A grid of dots over the view: land, sea inside the world's outline, nothing outside it. */
export function dotGrid(
  view: View,
  columns: number,
  cells: Uint8Array,
): { centers: Float32Array; land: Float32Array; spacing: number } {
  const spacing = view.width / Math.max(4, Math.round(columns))
  const rows = Math.ceil(view.height / spacing)
  const cols = Math.ceil(view.width / spacing)
  const centers: number[] = []
  const land: number[] = []
  const x0 = view.cx - (cols * spacing) / 2 + spacing / 2
  const y0 = view.cy - (rows * spacing) / 2 + spacing / 2
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < cols; column++) {
      const x = x0 + column * spacing
      const y = y0 + row * spacing
      const at = unproject(x, y)
      if (!at || at[0] < SOUTH_LAT * RAD) continue
      centers.push(x, y)
      land.push(cells[cellOf(at[0] / RAD, wrap(at[1] / RAD + view.mid))] ?? 0)
    }
  return { centers: new Float32Array(centers), land: new Float32Array(land), spacing }
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** `count` copies of `base`, with the given per-instance attributes. */
function instanced(
  base: BufferGeometry,
  attributes: Record<string, [Float32Array, number]>,
  count: number,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(base.getIndex())
  geometry.setAttribute('position', base.getAttribute('position'))
  for (const [name, [array, size]] of Object.entries(attributes))
    geometry.setAttribute(name, new InstancedBufferAttribute(array, size))
  geometry.instanceCount = count
  return geometry
}

/**
 * A flat map of the world or a region, its land as dots or a solid fill, with markers for the
 * element's places and arcs between them that draw in once in view. Fires `dio:marker` on the
 * element when a marker lights up or goes dark.
 */
const map: Effect<Params> = defineEffect({
  name: 'map',
  params: {
    markers: '[data-dio-lat]',
    style: oneOf('dots', 'solid'),
    region: oneOf('world', 'europe', 'americas', 'asia', 'africa', 'oceania'),
    dots: 160,
    center: 0,
    zoom: 1,
    color: color('#8792a8'),
    sea: 0,
    land: color('#8792a8'),
    marker: color('#ff5a36'),
    arc: color('#ff5a36'),
    markerSize: 8,
  },
  on: ':not(img, video, canvas)',
  rebuild: ['dots'],
  quality: { low: { dots: 100 }, medium: { dots: 130 } },
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, params } = ctx
    const element = ctx.element as HTMLElement
    const { markers: selector, style, region } = params
    const cells = await landMask()

    // `inner` holds the map in projected units; the update scales it to the box.
    const root = new Group()
    const inner = new Group()
    root.add(inner)
    ctx.place(root, { fit: 'none', replace: true })
    /** Projected units per CSS px. */
    const unit = uniform(1)

    // Everything is clipped to the view: the projected world is wider than a region.
    const half = uniform(new Vector2(1, 1))
    const middle = uniform(new Vector2())
    const within = (at: Node<'vec2'>): Node<'float'> => {
      const outside = at.sub(middle).abs().sub(half)
      return select(outside.x.max(outside.y).lessThanEqual(0), 1, 0) as unknown as Node<'float'>
    }

    // Land: instanced dots, sea dots among them at `sea`; or the mask on a projected world mesh.
    const dotMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    const isLand = attribute('land', 'float')
    const spacing = uniform(0.01)
    dotMaterial.positionNode = vec3(
      attribute('center', 'vec2').add(positionGeometry.xy.mul(spacing.mul(0.36))),
      0,
    )
    dotMaterial.colorNode = mix(u.color, u.land, isLand)
    dotMaterial.opacityNode = mix(u.sea, float(1), isLand).mul(u.opacity)
    const dots = new Mesh(new InstancedBufferGeometry(), dotMaterial)
    dots.frustumCulled = false

    const solidMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    // The mask as a texture, rows from the south.
    const bytes = new Uint8Array(WIDTH * HEIGHT)
    for (let row = 0; row < HEIGHT; row++)
      for (let column = 0; column < WIDTH; column++)
        bytes[(HEIGHT - 1 - row) * WIDTH + column] = (cells[row * WIDTH + column] as number) * 255
    const landMap = new DataTexture(bytes, WIDTH, HEIGHT, RedFormat)
    landMap.wrapS = RepeatWrapping
    landMap.magFilter = landMap.minFilter = LinearFilter
    landMap.needsUpdate = true
    ctx.onDispose(() => landMap.dispose())
    const shore = smoothstep(0.3, 0.7, texture(landMap, uv()).r)
    const local = varying(positionGeometry.xy)
    solidMaterial.colorNode = mix(u.color, u.land, shore)
    // Antarctica is left out, as in the dots.
    solidMaterial.opacityNode = mix(u.sea, float(1), shore)
      .mul(within(local))
      .mul(select(uv().y.greaterThan(SOUTH), 1, 0))
      .mul(u.opacity)
    const solid = new Mesh(new BufferGeometry(), solidMaterial)
    solid.frustumCulled = false
    inner.add(style === 'solid' ? solid : dots)

    // Markers: discs of `markerSize` px; a lit one doubles with a ring around its dot.
    const lift = attribute('lift', 'float')
    const pins = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    const radius = u.markerSize.mul(0.5).mul(unit)
    pins.positionNode = vec3(
      attribute('center', 'vec2').add(positionGeometry.xy.mul(radius.mul(lift.add(1)))),
      0.2,
    )
    pins.colorNode = u.marker
    // The dot keeps its size while the disc grows; the gap between them opens into a ring.
    const fromCenter = positionGeometry.xy.length()
    pins.opacityNode = select(
      fromCenter
        .lessThan(lift.add(1).reciprocal())
        .or(fromCenter.greaterThan(lift.mul(-0.25).add(1))),
      1,
      0,
    )
      .mul(within(attribute('center', 'vec2')))
      .mul(u.opacity)
    const pinMesh = new Mesh(new InstancedBufferGeometry(), pins)
    pinMesh.frustumCulled = false
    inner.add(pinMesh)

    // Arcs: ribbons of constant screen width along a curve that rises with the distance.
    const clock = uniform(0)
    const arcs = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    arcs.positionNode = vec3(
      positionGeometry.xy.add(
        attribute('across', 'vec2')
          .mul(attribute('side', 'float'))
          .mul(unit.mul(ARC_WIDTH / 2)),
      ),
      0.1,
    )
    arcs.colorNode = u.arc
    const drawn = clock
      .sub(attribute('delay', 'float'))
      .div(DRAW)
      .clamp(0, 1)
      .oneMinus()
      .pow(3)
      .oneMinus()
    arcs.opacityNode = select(attribute('along', 'float').lessThanEqual(drawn), 1, 0)
      .mul(within(varying(positionGeometry.xy)))
      .mul(u.opacity)
      .mul(0.9)
    const arcMesh = new Mesh(new BufferGeometry(), arcs)
    arcMesh.frustumCulled = false
    inner.add(arcMesh)

    let view = viewOf(region, params.center, params.zoom, 2)
    let points: Marker[] = []
    /** Projected x, y of each marker. */
    let xy = new Float32Array(0)
    /** How lit each marker is, 0..1. */
    let lifts = new Float32Array(1)
    let liftAttr: InstancedBufferAttribute | undefined
    let arcCount = 0
    const projectMarker = (marker: Marker): [number, number] =>
      project(marker.lat * RAD, wrap(marker.lng - view.mid) * RAD)

    /** The land for the current view: a projected world mesh, or the dot grid. */
    const buildLand = (): void => {
      half.value.set(view.width / 2, view.height / 2)
      middle.value.set(view.cx, view.cy)
      if (style === 'solid') {
        // A 2.5 degree grid over the world, projected.
        const cols = 145
        const rows = 73
        const position = new Float32Array(cols * rows * 3)
        const uvs = new Float32Array(cols * rows * 2)
        const index: number[] = []
        for (let j = 0; j < rows; j++)
          for (let i = 0; i < cols; i++) {
            const lambda = -180 + (360 * i) / (cols - 1)
            const lat = -90 + (180 * j) / (rows - 1)
            const [x, y] = project(lat * RAD, lambda * RAD)
            const vertex = j * cols + i
            position.set([x, y, 0], vertex * 3)
            uvs.set([(lambda + view.mid + 180) / 360, (lat + 90) / 180], vertex * 2)
            if (i < cols - 1 && j < rows - 1)
              index.push(
                vertex,
                vertex + 1,
                vertex + cols,
                vertex + 1,
                vertex + cols + 1,
                vertex + cols,
              )
          }
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new BufferAttribute(position, 3))
        geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
        geometry.setIndex(index)
        solid.geometry.dispose()
        solid.geometry = geometry
        return
      }
      const grid = dotGrid(view, params.dots, cells)
      spacing.value = grid.spacing
      dots.geometry.dispose()
      dots.geometry = instanced(
        new CircleGeometry(1, 10),
        { center: [grid.centers, 2], land: [grid.land, 1] },
        grid.land.length,
      )
    }

    /** The marker discs and the arcs between them. */
    const buildMarks = (): void => {
      xy = new Float32Array(points.length * 2)
      points.forEach((marker, i) => {
        xy.set(projectMarker(marker), i * 2)
      })
      lifts = new Float32Array(Math.max(1, points.length))
      const geometry = instanced(
        new CircleGeometry(1, 32),
        { center: [points.length ? xy : new Float32Array(2), 2], lift: [lifts, 1] },
        points.length,
      )
      liftAttr = geometry.getAttribute('lift') as InstancedBufferAttribute
      liftAttr.setUsage(DynamicDrawUsage)
      pinMesh.geometry.dispose()
      pinMesh.geometry = geometry
      pinMesh.visible = points.length > 0
      // Arcs from `data-dio-to`, each pair once, as quadratic curves bowed towards the north.
      const byId = new Map<string, number>()
      points.forEach((marker, i) => {
        if (marker.id && !byId.has(marker.id)) byId.set(marker.id, i)
      })
      const seen = new Set<string>()
      const position: number[] = []
      const across: number[] = []
      const side: number[] = []
      const along: number[] = []
      const delay: number[] = []
      const index: number[] = []
      let arcIndex = 0
      points.forEach((marker, from) => {
        for (const id of marker.to) {
          const to = byId.get(id)
          const key = to === undefined ? '' : from < to ? `${from} ${to}` : `${to} ${from}`
          if (to === undefined || from === to || seen.has(key)) continue
          seen.add(key)
          const [startX, startY] = [xy[from * 2] as number, xy[from * 2 + 1] as number]
          const [endX, endY] = [xy[to * 2] as number, xy[to * 2 + 1] as number]
          const length = Math.hypot(endX - startX, endY - startY)
          if (length < 1e-6) continue
          // The control point lies off the middle along the normal that points north.
          let normalX = -(endY - startY) / length
          let normalY = (endX - startX) / length
          if (normalY < 0) {
            normalX = -normalX
            normalY = -normalY
          }
          const controlX = (startX + endX) / 2 + normalX * length * 0.22
          const controlY = (startY + endY) / 2 + normalY * length * 0.22
          const first = position.length / 3
          for (let k = 0; k <= SEGMENTS; k++) {
            const t = k / SEGMENTS
            const s = 1 - t
            const x = s * s * startX + 2 * s * t * controlX + t * t * endX
            const y = s * s * startY + 2 * s * t * controlY + t * t * endY
            // The tangent of the curve gives the ribbon's sides.
            const tangentX = 2 * s * (controlX - startX) + 2 * t * (endX - controlX)
            const tangentY = 2 * s * (controlY - startY) + 2 * t * (endY - controlY)
            const tangentLength = Math.hypot(tangentX, tangentY) || 1
            for (const sign of [-1, 1]) {
              position.push(x, y, 0)
              across.push(-tangentY / tangentLength, tangentX / tangentLength)
              side.push(sign)
              along.push(t)
              delay.push(arcIndex * STAGGER)
            }
            if (k < SEGMENTS) {
              const v = first + k * 2
              index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
            }
          }
          arcIndex++
        }
      })
      const arcGeometry = new BufferGeometry()
      arcGeometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3))
      arcGeometry.setAttribute('across', new BufferAttribute(new Float32Array(across), 2))
      arcGeometry.setAttribute('side', new BufferAttribute(new Float32Array(side), 1))
      arcGeometry.setAttribute('along', new BufferAttribute(new Float32Array(along), 1))
      arcGeometry.setAttribute('delay', new BufferAttribute(new Float32Array(delay), 1))
      arcGeometry.setIndex(index)
      arcMesh.geometry.dispose()
      arcMesh.geometry = arcGeometry
      arcMesh.visible = arcIndex > 0
      arcCount = arcIndex
    }

    // Places, read again on DOM changes before the next drawn frame.
    let signature = ''
    /** Reads the places again; true when they changed. */
    const scan = (): boolean => {
      const next = readMarkers(element, selector)
      const key = next.map((m) => `${m.lat},${m.lng},${m.id},${m.to.join(' ')}`).join(';')
      if (key === signature && next.every((m, i) => m.element === points[i]?.element)) return false
      signature = key
      points = next
      if (lit && !points.includes(lit)) lit = points.find((m) => m.element === lit?.element)
      return true
    }
    let dirty = false
    const observer = new MutationObserver(() => {
      dirty = true
      ctx.invalidate()
    })
    observer.observe(element.querySelector(selector) ? element : document.body, {
      attributes: true,
      attributeFilter: ['data-dio-lat', 'data-dio-lng', 'data-dio-to', 'id'],
      childList: true,
      subtree: true,
    })
    ctx.onDispose(() => observer.disconnect())

    // Lit marker: the pointer over the map or a legend item, else the focused place.
    let hovered: Marker | undefined
    let legend: Marker | undefined
    let focused: Marker | undefined
    let lit: Marker | undefined
    const light = (): void => {
      const next = hovered ?? legend ?? focused
      if (next === lit) return
      lit = next
      ctx.invalidate()
      element.dispatchEvent(
        new CustomEvent('dio:marker', {
          detail: { marker: next?.element ?? null, id: next?.id ?? null },
          bubbles: true,
        }),
      )
    }
    /** The marker under a viewport point: the nearest within `markerSize + 8` px. */
    const hit = (x: number, y: number): Marker | undefined => {
      const box = element.getBoundingClientRect()
      const scale = box.width / view.width
      let best: Marker | undefined
      let reach = params.markerSize + 8
      const n = Math.min(points.length, HITS)
      for (let i = 0; i < n; i++) {
        const screenX = box.left + box.width / 2 + ((xy[i * 2] as number) - view.cx) * scale
        const screenY = box.top + box.height / 2 - ((xy[i * 2 + 1] as number) - view.cy) * scale
        if (screenX < box.left || screenX > box.right || screenY < box.top || screenY > box.bottom)
          continue
        const distance = Math.hypot(screenX - x, screenY - y)
        if (distance < reach) {
          reach = distance
          best = points[i]
        }
      }
      return best
    }
    const pointOf = (node: unknown): Marker | undefined =>
      node instanceof Element ? points.find((m) => m.element.contains(node)) : undefined
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
      capture = false,
    ): void => target.addEventListener(type, fn as (event: Event) => void, { signal, capture })
    listen(element, 'pointermove', (e) => {
      if (e.pointerType === 'touch') return
      hovered = hit(e.clientX, e.clientY)
      element.style.cursor = hovered ? 'pointer' : ''
      light()
    })
    listen(element, 'pointerleave', () => {
      hovered = undefined
      light()
    })
    /** A click is being passed on to a marker's own link: let it through. */
    let routing = false
    // A pointer click lands on the marker under it; keyboard clicks (detail 0) stay native.
    listen(
      element,
      'click',
      (e) => {
        if (routing || e.detail === 0) return
        // The hidden list inside the map must not take clicks meant for the map.
        if (e.target !== element) {
          e.preventDefault()
          e.stopPropagation()
        }
        const marker = hit(e.clientX, e.clientY)
        if (!marker) return
        hovered = marker
        light()
        const node = marker.element
        const link = node.matches('a, button') ? node : node.querySelector('a, button')
        routing = true
        try {
          ;((link ?? node) as HTMLElement).click()
        } finally {
          routing = false
        }
      },
      true,
    )
    listen(document, 'pointerover', (e) => {
      const marker = pointOf(e.target)
      if (!marker || element.contains(marker.element)) return
      legend = marker
      light()
    })
    listen(document, 'pointerout', (e) => {
      if (!legend || legend.element.contains(e.relatedTarget as Element | null)) return
      legend = undefined
      light()
    })
    listen(document, 'focusin', (e) => {
      const marker = pointOf(e.target)
      if (!marker || marker === focused) return
      focused = marker
      light()
    })
    listen(document, 'focusout', (e) => {
      if (!focused || pointOf(e.relatedTarget)) return
      focused = undefined
      light()
    })

    scan()
    // Geometry before the first compile, from the box as laid out now.
    view = viewOf(
      region,
      params.center,
      params.zoom,
      (ctx.input.width || 2) / (ctx.input.height || 1),
    )
    buildLand()
    buildMarks()
    /** Still growing or easing the focus, so the update asks for frames. */
    let playing = false
    let layoutKey = ''
    /** Seconds since the arcs started to draw, undefined before the map came into view. */
    let started: number | undefined

    return (input): boolean => {
      const w = input.width
      const h = input.height
      if (w <= 0 || h <= 0) return playing
      const changed = dirty && scan()
      dirty = false
      const key = `${w}x${h} ${params.center} ${params.zoom}`
      if (key !== layoutKey) {
        layoutKey = key
        view = viewOf(region, params.center, params.zoom, w / h)
        buildLand()
        buildMarks()
      } else if (changed) buildMarks()
      const scale = w / view.width
      unit.value = 1 / scale
      inner.scale.set(scale, scale, 1)
      inner.position.set(-view.cx * scale, -view.cy * scale, 0)
      // Arcs draw in once, when a third of the map is above the bottom tenth of the viewport.
      if (started === undefined && inView(input.y, h, ctx.app.stage.height.peek(), SHOWN))
        started = 0
      const end = DRAW + STAGGER * arcCount
      if (started !== undefined && started < end)
        started = input.reducedMotion ? end : started + Math.min(input.delta, 0.1)
      clock.value = started ?? 0
      let easing = false
      for (let i = 0; i < points.length; i++) {
        const target = points[i] === lit ? 1 : 0
        const value = lifts[i] as number
        if (value === target) continue
        lifts[i] = input.reducedMotion ? target : damp(value, target, 0.08, input.delta, 1e-3)
        easing ||= lifts[i] !== target
        if (liftAttr) liftAttr.needsUpdate = true
      }
      playing = (started !== undefined && started < end && arcCount > 0) || easing
      root.scale.setScalar(0.98 + 0.02 * ease('cubicInOut', input.presence))
      return playing
    }
  },
})
export default map
