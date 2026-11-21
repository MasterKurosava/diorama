// An interactive globe of land dots or a land mask, with markers for the page's points and arcs
// between them.
import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, dither, ease } from '@dioramajs/effects/kit'
import {
  attribute,
  cameraProjectionMatrix,
  cross,
  float,
  fract,
  mix,
  modelViewMatrix,
  normalView,
  positionGeometry,
  positionViewDirection,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'

type Params = {
  markers: string
  data: string
  lat: number
  lng: number
  spin: number
  drag: boolean
  style: ChoiceParam<'dots' | 'solid'>
  motion: ChoiceParam<'draw' | 'flow'>
  dots: number
  scale: number
  color: ColorParam
  land: ColorParam
  marker: ColorParam
  arc: ColorParam
  atmosphere: ColorParam
  glow: number
  markerSize: number
  fps: number
}

/** A point on the globe: from an element, or from the JSON of `data` without one. */
interface Marker {
  readonly id: string | null
  readonly lat: number
  readonly lng: number
  readonly element: Element | null
  /** Ids of the points arcs go to. */
  readonly to: readonly string[]
}

/** Columns of the land mask: 0.5° each, from 180° W. */
export const WIDTH = 720
/** Rows of the land mask: 0.5° each, from the north. */
export const HEIGHT = 360
// The run-length code of src/land.ts, written by scripts/land.mjs: a digit below TERMINAL ends a
// run, the digits above it are leading digits in base BASE.
const TERMINAL = 80
const BASE = 10

const TAU = Math.PI * 2
const RAD = Math.PI / 180
/** The sphere's radius in the placed group, where 1 is the smaller side of the box. */
const RADIUS = 0.5
/** Drag, arrow keys and inertia keep the pitch within this, the `lat` param does not. */
const PITCH = 35 * RAD
/** One arrow key press. */
const STEP = 15 * RAD
/** Turn to a focused point, and the reveal of arcs. */
const TURN = 0.8
/** A flowing dash runs along its arc in this time, s. */
const FLOW = 2.4
/** Length of a flowing dash, as a share of its arc. */
const DASH = 0.35
/** Spin waits this long after the pointer, a drag or the focus leaves. */
const PAUSE = 2
/** Hit testing projects at most this many markers. */
const HITS = 500
/** Ribbon segments of one arc. */
const SEGMENTS = 48
/** Arcs are this wide on screen, in CSS px. */
const ARC_WIDTH = 1.5
/** The halo reaches this far out, in radii. */
const HALO = 1.2
/** Below this a motion counts as settled. */
const EPSILON = 1e-4
/** Heights above the sphere, in radii: land dots, markers. */
const DOT_LIFT = 1.003
const MARKER_LIFT = 1.006
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/**
 * Half-lives, s: of the coast after a drag, of a move to new `lat` and `lng`, of an arrow key step
 * and of a marker lighting up.
 */
const COAST_HALF_LIFE = 0.6
const AIM_HALF_LIFE = 0.25
const KEY_HALF_LIFE = 0.08
const LIGHT_HALF_LIFE = 0.08
/** A drag held still this long before letting go does not coast, ms. */
const COAST_HOLD = 80
/** Fastest coast after a drag, radians per second. */
const COAST_MAX = TAU * 2
/** Coasting stops below this speed, radians per second. */
const COAST_STOP = 0.02
/** A press that moved further than this, px, is a drag and not a click. */
const TAP_SLOP = 4
/** A marker under the pointer is found this far past its own size, px. */
const HIT_SLOP = 8

/** A click this soon and this close to the pointerup that ended a drag belongs to the drag. */
const DRAG_CLICK_TIME = 500
const DRAG_CLICK_DISTANCE = 24

/**
 * The click a drag ends with: a mouse drag ends with one, a touch drag with none, so only the next
 * click on `el`, close in time and place to the armed pointerup, is the drag's. The next press and
 * a cancel disarm it.
 */
function afterDrag(
  el: Element,
  signal: AbortSignal,
): { arm(up: PointerEvent): void; ends(click: MouseEvent): boolean } {
  let up: { t: number; x: number; y: number } | undefined
  const disarm = (): void => {
    up = undefined
  }
  for (const type of ['pointerdown', 'pointercancel'])
    el.addEventListener(type, disarm, { signal, capture: true })
  return {
    arm: (e) => {
      up = { t: e.timeStamp, x: e.clientX, y: e.clientY }
    },
    ends: (e) => {
      const last = up
      up = undefined
      return (
        !!last &&
        e.timeStamp - last.t <= DRAG_CLICK_TIME &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) <= DRAG_CLICK_DISTANCE
      )
    },
  }
}

/** Decodes the land mask of src/land.ts: 1 for land, `WIDTH` cells a row. */
export function unpack(text: string): Uint8Array {
  const cells = new Uint8Array(WIDTH * HEIGHT)
  let at = 0
  let land = 0
  let lead = 0
  for (let i = 0; i < text.length; i++) {
    // Printable characters from '#' without the quote and the backslash.
    const code = text.charCodeAt(i)
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

/** The mask cell of a latitude and longitude in degrees. */
export const cellOf = (lat: number, lng: number): number =>
  Math.min(HEIGHT - 1, Math.floor((90 - lat) * 2)) * WIDTH +
  Math.min(WIDTH - 1, Math.floor((((lng % 360) + 540) % 360) * 2))

/** Unit vector of a latitude and longitude in radians: 0°, 0° faces +z, east is +x, north +y. */
function toVector(lat: number, lng: number, out: Vector3 = new Vector3()): Vector3 {
  const ring = Math.cos(lat)
  return out.set(ring * Math.sin(lng), Math.sin(lat), ring * Math.cos(lng))
}

/**
 * Unit vectors of the land dots: a Fibonacci spiral of `count` points over the sphere, kept where
 * the mask is land. The same on every load.
 */
export function landDots(count: number, cells: Uint8Array): Float32Array {
  const out: number[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * i + 1) / count
    const ring = Math.sqrt(1 - y * y)
    const x = Math.cos(i * golden) * ring
    const z = Math.sin(i * golden) * ring
    if (cells[cellOf(Math.asin(y) / RAD, Math.atan2(x, z) / RAD)]) out.push(x, y, z)
  }
  return new Float32Array(out)
}

let mask: Uint8Array | undefined
/** The land chunk, decoded once for every globe on the page. */
async function landMask(): Promise<Uint8Array> {
  if (!mask) mask = unpack((await import('./land')).default)
  return mask
}

/** A number attribute in range, or NaN. An empty attribute is not 0. */
function degrees(value: unknown, limit: number): number {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Math.abs(number) <= limit ? number : Number.NaN
}

const GLOBES = '[data-dio~="globe"]'

/** Points from elements: inside the globe, else anywhere outside every globe. */
function readMarkers(el: Element, selector: string): { found: Marker[]; bad: Element[] } {
  let nodes = [...el.querySelectorAll(selector)]
  if (!nodes.length) {
    nodes = [...document.querySelectorAll(selector)].filter(
      (node) => node !== el && !node.closest(GLOBES),
    )
  }
  const found: Marker[] = []
  const bad: Element[] = []
  for (const node of nodes) {
    const lat = degrees(node.getAttribute('data-dio-lat'), 90)
    const lng = degrees(node.getAttribute('data-dio-lng'), 180)
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      bad.push(node)
      continue
    }
    const to = (node.getAttribute('data-dio-to') ?? '').split(/\s+/).filter(Boolean)
    found.push({ id: node.id || null, lat, lng, element: node, to })
  }
  return { found, bad }
}

/** The JSON of `data`: `{ markers: [{ id, lat, lng }], arcs: [{ from, to }] }`. */
interface Data {
  readonly markers?: readonly { id?: unknown; lat?: unknown; lng?: unknown }[]
  readonly arcs?: readonly { from?: unknown; to?: unknown }[]
}

/** Points from the JSON of `data`, and how many it could not place. */
function readData(data: Data | undefined): { found: Marker[]; bad: number } {
  const found: Marker[] = []
  let bad = 0
  for (const item of data?.markers ?? []) {
    const lat = degrees(item?.lat, 90)
    const lng = degrees(item?.lng, 180)
    if (Number.isNaN(lat) || Number.isNaN(lng)) bad++
    else
      found.push({ id: item.id == null ? null : String(item.id), lat, lng, element: null, to: [] })
  }
  return { found, bad }
}

/** Index pairs of arcs: `data-dio-to` of points and the `arcs` of the JSON, each pair once. */
function arcsOf(points: readonly Marker[], data?: Data): [number, number][] {
  const byId = new Map<string, number>()
  points.forEach((p, i) => {
    if (p.id !== null && !byId.has(p.id)) byId.set(p.id, i)
  })
  const pairs: [number, number][] = []
  const seen = new Set<string>()
  const add = (from: number, to: unknown): void => {
    const end = byId.get(String(to))
    const key = end === undefined ? '' : from < end ? `${from} ${end}` : `${end} ${from}`
    if (end === undefined || from === end || seen.has(key)) return
    seen.add(key)
    pairs.push([from, end])
  }
  points.forEach((p, i) => {
    for (const to of p.to) add(i, to)
  })
  for (const arc of data?.arcs ?? []) {
    const from = byId.get(String(arc?.from))
    if (from !== undefined) add(from, arc?.to)
  }
  return pairs
}

/** The nearest equivalent of `angle` to `from`, for turns along the shortest way. */
const nearest = (angle: number, from: number): number =>
  from + ((((angle - from) % TAU) + TAU + Math.PI) % TAU) - Math.PI

/** Unit discs as instances: the geometry's vertices, a `center` and maybe a `lift` per instance. */
function discs(
  segments: number,
  centers: Float32Array,
  lift?: Float32Array,
): InstancedBufferGeometry {
  const base = new CircleGeometry(1, segments)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(base.getIndex())
  geometry.setAttribute('position', base.getAttribute('position'))
  geometry.setAttribute('center', new InstancedBufferAttribute(centers, 3))
  if (lift)
    geometry.setAttribute('lift', new InstancedBufferAttribute(lift, 1).setUsage(DynamicDrawUsage))
  geometry.instanceCount = centers.length / 3
  return geometry
}

/** A colour param without the light entry's helper. */
const hex = (value: string): ColorParam => Object.freeze({ '~kind': 'color', value }) as ColorParam

/** A disc of radius `size` on the sphere at `center`, from the unit disc of the geometry. */
function onSphere(center: Node<'vec3'>, size: Node<'float'>): Node<'vec3'> {
  const up = center.normalize()
  const eastward = vec3(up.z, 0, up.x.negate())
  // At a pole any direction is east.
  const east = select(eastward.length().lessThan(1e-4), vec3(1, 0, 0), eastward.normalize())
  const north = cross(up, east)
  return center.add(east.mul(positionGeometry.x).add(north.mul(positionGeometry.y)).mul(size))
}

/**
 * Ribbons of arcs along great circles, raised by distance. Per vertex: the point, the next point
 * along the arc for the direction, the side, how far along the arc it is and the arc's phase.
 */
function ribbons(ends: readonly [Vector3, Vector3][]): BufferGeometry {
  // Great circles through two points or their antipodes have no single way.
  const kept = ends.filter(([a, b]) => {
    const angle = a.angleTo(b)
    return angle > 1e-3 && angle < Math.PI - 1e-3
  })
  const count = kept.length * (SEGMENTS + 1) * 2
  const position = new Float32Array(count * 3)
  const ahead = new Float32Array(count * 3)
  const side = new Float32Array(count)
  const along = new Float32Array(count)
  const phase = new Float32Array(count)
  const index: number[] = []
  const point = new Vector3()
  let vertex = 0
  // Slerp between the ends, raised more in the middle of a longer arc.
  const sample = (a: Vector3, b: Vector3, angle: number, t: number, out: Vector3): Vector3 => {
    const lift = RADIUS * (1.004 + (0.05 + (0.2 * angle) / Math.PI) * Math.sin(Math.PI * t))
    return out
      .copy(a)
      .multiplyScalar(Math.sin((1 - t) * angle))
      .addScaledVector(b, Math.sin(t * angle))
      .multiplyScalar(lift / Math.sin(angle))
  }
  for (const [arc, [a, b]] of kept.entries()) {
    const angle = a.angleTo(b)
    for (let segment = 0; segment <= SEGMENTS; segment++) {
      const t = segment / SEGMENTS
      sample(a, b, angle, t, point)
      const next = sample(a, b, angle, t + 1 / SEGMENTS, new Vector3())
      for (const edge of [-1, 1]) {
        point.toArray(position, vertex * 3)
        next.toArray(ahead, vertex * 3)
        side[vertex] = edge
        along[vertex] = t
        // Golden steps: neighbouring arcs flow out of step.
        phase[vertex] = (arc * 0.618034) % 1
        vertex++
      }
      if (segment < SEGMENTS) {
        const i = vertex - 2
        index.push(i, i + 1, i + 2, i + 1, i + 3, i + 2)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setIndex(index)
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  geometry.setAttribute('ahead', new BufferAttribute(ahead, 3))
  geometry.setAttribute('side', new BufferAttribute(side, 1))
  geometry.setAttribute('along', new BufferAttribute(along, 1))
  geometry.setAttribute('arcPhase', new BufferAttribute(phase, 1))
  return geometry
}

/** What the frame policy reads, by the phase's signal: the probe hands setup a proxy context. */
interface Motion {
  /** Drag inertia, a turn to a point or a param, arcs, highlights, arrow keys. */
  fast: boolean
  /** Spinning, waiting to spin again, or arcs flowing. */
  spinning: boolean
}
const motions = new WeakMap<AbortSignal, Motion>()

/**
 * An interactive globe of land dots or a land mask, with markers for the element's points and arcs
 * between them that draw once or flow. Fires `dio:marker` on the element when a marker lights up
 * or goes dark.
 */
const globe: Effect<Params> = defineEffect({
  name: 'globe',
  params: {
    markers: '[data-dio-lat]',
    data: '',
    lat: 20,
    lng: 0,
    spin: 3.6,
    drag: true,
    style: oneOf('dots', 'solid'),
    motion: oneOf('draw', 'flow'),
    dots: 12000,
    scale: 0.8,
    color: hex('#0d1220'),
    land: hex('#5b6b8c'),
    marker: hex('#ffb547'),
    arc: hex('#ffb547'),
    atmosphere: hex('#6ea8ff'),
    glow: 0.4,
    markerSize: 6,
    fps: 30,
  },
  on: ':not(img, video, canvas)',
  rebuild: ['dots'],
  // Spin no faster than `fps`; coasting, turns and reveals at full rate (an infinite rate asks
  // for the next frame, where 60 would wait for a timer); nothing at rest.
  animate: {
    fps: (ctx) => {
      const motion = motions.get(ctx.signal)
      return motion?.fast ? Number.POSITIVE_INFINITY : motion?.spinning ? ctx.params.fps : 0
    },
  },
  // The sphere is opaque, so it leaves by dithering every material, not by alpha.
  presence: 'custom',
  quality: { low: { dots: 4000, fps: 20 }, medium: { dots: 8000 } },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, signal } = ctx
    const el = element as HTMLElement
    const p = ctx.params
    const { markers: selector, data: url, style } = p
    const flow = p.motion === 'flow'
    const [cells, data] = await Promise.all([
      landMask(),
      url
        ? fetch(url, { signal }).then((response) => {
            if (!response.ok)
              throw new Error(`globe: data-dio-data "${url}" answered ${response.status}`)
            return response.json() as Promise<Data>
          })
        : undefined,
    ])

    // Every material leaves by the same dither against presence.
    const threshold = dither().mul(255).add(0.5)
    const kept = threshold.mul(0.999).lessThan(u.presence) as unknown as Node<'bool'>
    const material = (): MeshBasicNodeMaterial => {
      const made = new MeshBasicNodeMaterial()
      made.maskNode = kept
      return made
    }

    // Sphere: the ocean, or the land mask sampled by longitude and latitude; a fresnel rim.
    const sphere = material()
    let surface = u.color as unknown as Node<'vec3'>
    if (style === 'solid') {
      const bytes = new Uint8Array(WIDTH * HEIGHT)
      // Texture rows go from the south, like the sphere's v.
      for (let row = 0; row < HEIGHT; row++)
        for (let col = 0; col < WIDTH; col++)
          bytes[(HEIGHT - 1 - row) * WIDTH + col] = (cells[row * WIDTH + col] as number) * 255
      const map = new DataTexture(bytes, WIDTH, HEIGHT, RedFormat)
      map.wrapS = RepeatWrapping
      map.magFilter = map.minFilter = LinearFilter
      map.needsUpdate = true
      ctx.onDispose(() => map.dispose())
      // The sphere's u starts at 90° W.
      const land = texture(map, uv().add(vec2(0.25, 0))).r
      surface = mix(u.color, u.land, smoothstep(0.3, 0.7, land))
    }
    const facing = normalView.dot(positionViewDirection).clamp(0, 1)
    const rim = facing.oneMinus().pow(3)
    sphere.colorNode = mix(surface, u.atmosphere, rim.mul(u.glow))

    const root = new Group()
    const pivot = new Group()
    root.add(pivot)
    pivot.add(new Mesh(new SphereGeometry(RADIUS, 64, 32), sphere))

    if (style === 'dots') {
      const centers = landDots(p.dots, cells).map((c) => c * RADIUS * DOT_LIFT)
      // Dots take a bit over half the spacing of the spiral.
      const size = RADIUS * 0.28 * Math.sqrt((4 * Math.PI) / p.dots)
      const dots = material()
      const center = attribute('center', 'vec3')
      dots.positionNode = onSphere(center, float(size))
      // Towards the rim the dots sink into the ocean colour. The discs have no normal of their own.
      const normal = modelViewMatrix.mul(vec4(center, 0)).xyz.normalize()
      const edge = normal.dot(positionViewDirection).clamp(0, 1).oneMinus().pow(3)
      dots.colorNode = mix(u.land, u.color, edge.mul(0.5))
      const mesh = new Mesh(discs(6, centers), dots)
      mesh.frustumCulled = false
      pivot.add(mesh)
    }

    // Halo: a plane through the centre facing the viewer, hidden where the sphere is in front.
    const halo = material()
    // Distance from the centre in radii.
    const fromCentre = uv()
      .sub(0.5)
      .length()
      .mul(2 * HALO)
    const fade = fromCentre
      .sub(1)
      .div(HALO - 1)
      .oneMinus()
      .clamp(0, 1)
      .pow(2)
    halo.colorNode = u.atmosphere
    halo.opacityNode = smoothstep(0.98, 1, fromCentre).mul(fade).mul(u.glow)
    halo.transparent = true
    halo.depthWrite = false
    root.add(new Mesh(new PlaneGeometry(2 * RADIUS * HALO, 2 * RADIUS * HALO), halo))

    // Markers: discs of `markerSize` px; a lit one doubles with a ring around its dot.
    const lift = attribute('lift', 'float')
    const radius = u.markerSize.mul(0.5).div(u.size.x.min(u.size.y).mul(u.scale).max(1))
    const pins = material()
    pins.positionNode = onSphere(attribute('center', 'vec3'), radius.mul(lift.add(1)))
    pins.colorNode = u.marker
    // The doubled disc keeps its dot and its outer ring, with a gap between them.
    const fromMiddle = positionGeometry.xy.length()
    const dot = fromMiddle.lessThan(lift.add(1).reciprocal())
    const ring = fromMiddle.greaterThan(lift.mul(-0.25).add(1))
    pins.maskNode = kept.and(dot.or(ring)) as unknown as Node<'bool'>
    const markerMesh = new Mesh(discs(32, new Float32Array(3), new Float32Array(1)), pins)
    markerMesh.frustumCulled = false
    pivot.add(markerMesh)

    // Arcs: ribbons of constant screen width, revealed along their length, or a dash running
    // along each one, from its first point to its second.
    const drawn = uniform(1)
    const clock = uniform(0)
    const whole = uniform(0)
    const distance = uniform(ctx.render.camera.position.z || 1)
    const lines = material()
    const ahead = attribute('ahead', 'vec3')
    const here = modelViewMatrix.mul(vec4(positionGeometry, 1)).xyz
    const aheadInView = modelViewMatrix.mul(vec4(ahead, 1)).xyz
    const across = cross(aheadInView.sub(here), here).normalize()
    // Half the width, grown with depth so it stays the same on screen.
    const halfWidth = here.z
      .negate()
      .mul(ARC_WIDTH / 2)
      .div(distance)
    lines.vertexNode = cameraProjectionMatrix.mul(
      vec4(here.add(across.mul(attribute('side', 'float').mul(halfWidth))), 1),
    )
    lines.colorNode = u.arc
    const along = attribute('along', 'float')
    let shown = along.lessThanEqual(drawn)
    if (flow) {
      const head = fract(clock.div(FLOW).add(attribute('arcPhase', 'float'))).mul(1 + DASH)
      const dash = along.lessThanEqual(head).and(along.greaterThanEqual(head.sub(DASH)))
      shown = shown.and(dash.or(whole.greaterThan(0.5)))
    }
    lines.maskNode = kept.and(shown) as unknown as Node<'bool'>
    lines.side = DoubleSide
    const arcMesh = new Mesh(new BufferGeometry(), lines)
    arcMesh.frustumCulled = false
    pivot.add(arcMesh)

    ctx.place(root, { fit: 'contain', replace: true })

    // Points: elements and JSON, read again on DOM changes before the next drawn frame.
    let points: Marker[] = []
    let units = new Float32Array(0)
    let lifts = new Float32Array(1)
    let liftAttr = markerMesh.geometry.getAttribute('lift') as InstancedBufferAttribute
    let arcCount = 0
    let signature = ''
    let warned = false
    let crowded = false
    // One note per instance for points it cannot place.
    const skip = (bad: readonly unknown[]): void => {
      if (!DEV || warned || !bad.length) return
      warned = true
      const message =
        'globe skips points without a latitude in -90..90 and a longitude in -180..180'
      ctx.app.log.warn(`EFFECT_PARAM: ${message}`, ...bad)
    }
    const fromData = readData(data)
    if (fromData.bad) skip([url])
    const scan = (): void => {
      const { found, bad } = readMarkers(el, selector)
      skip(bad)
      const next = [...found, ...fromData.found]
      const key = next.map((m) => `${m.lat},${m.lng},${m.id},${m.to.join(' ')}`).join(';')
      if (key === signature && next.every((m, i) => m.element === points[i]?.element)) return
      signature = key
      points = next
      // Lit and focused points stay so while their element or id is there. A lit point that is
      // gone stays `lit` until `light()` below says it went dark.
      const same = (m: Marker | undefined): Marker | undefined => {
        const key = m && keyOf(m)
        return key == null ? undefined : points.find((n) => keyOf(n) === key)
      }
      hovered = same(hovered)
      legend = same(legend)
      focused = same(focused)
      lit = same(lit) ?? lit
      if (DEV && points.length > HITS && !crowded) {
        crowded = true
        ctx.app.log.warn(
          `globe: ${points.length} markers, the pointer finds only the first ${HITS}`,
        )
      }
      units = new Float32Array(points.length * 3)
      const unit = new Vector3()
      for (const [i, m] of points.entries())
        toVector(m.lat * RAD, m.lng * RAD, unit).toArray(units, i * 3)
      lifts = new Float32Array(Math.max(1, points.length))
      const centers = points.length
        ? units.map((c) => c * RADIUS * MARKER_LIFT)
        : new Float32Array(3)
      const geometry = discs(32, centers, lifts)
      geometry.instanceCount = points.length
      markerMesh.geometry.dispose()
      markerMesh.geometry = geometry
      markerMesh.visible = points.length > 0
      liftAttr = geometry.getAttribute('lift') as InstancedBufferAttribute
      const pairs = arcsOf(points, data)
      const ends = pairs.map(
        ([a, b]) =>
          [new Vector3().fromArray(units, a * 3), new Vector3().fromArray(units, b * 3)] as [
            Vector3,
            Vector3,
          ],
      )
      arcMesh.geometry.dispose()
      arcMesh.geometry = ribbons(ends)
      arcMesh.visible = pairs.length > 0
      if (!arcCount && pairs.length && !reveal && !flow) reveal = 0
      arcCount = pairs.length
      light()
    }
    const keyOf = (m: Marker): Element | string | null => m.element ?? m.id
    const observer = new MutationObserver(() => {
      dirty = true
      ctx.invalidate()
    })
    let dirty = false
    const watch = el.querySelector(selector) ? el : document.body
    observer.observe(watch, {
      attributes: true,
      attributeFilter: ['data-dio-lat', 'data-dio-lng', 'data-dio-to', 'id'],
      childList: true,
      subtree: true,
    })
    ctx.onDispose(() => observer.disconnect())

    // Lit marker: the pointer over the globe or a legend item, else the focused point.
    let hovered: Marker | undefined
    let legend: Marker | undefined
    let focused: Marker | undefined
    let lit: Marker | undefined
    const light = (): void => {
      const next = hovered ?? legend ?? focused
      if (next === lit) return
      lit = next
      ctx.invalidate()
      el.dispatchEvent(
        new CustomEvent('dio:marker', {
          detail: { marker: next?.element ?? null, id: next?.id ?? null },
          bubbles: true,
        }),
      )
    }

    // Orientation: yaw turns about the poles, pitch tilts north towards the viewer.
    const reduced = (): boolean => ctx.app.stage.reducedMotion.peek()
    let yaw = -p.lng * RAD
    let pitch = p.lat * RAD
    let lat = p.lat
    let lng = p.lng
    let aim: { yaw: number; pitch: number } | undefined
    let turn:
      | { yaw: number; pitch: number; fromYaw: number; fromPitch: number; t: number }
      | undefined
    let velocity = 0
    let keyYaw = 0
    let keyPitch = 0
    // Seconds left before the spin starts again.
    let rest = 0
    let over = false
    let reveal: number | undefined
    let grab:
      | { id: number; x: number; y: number; t: number; startX: number; startY: number }
      | undefined
    /** The press moved: a drag, whose click is not a tap. */
    let moved = false
    let routing = false
    // User input keeps the pitch within ±35°, or moves it back towards that range.
    const hold = (next: number, from: number): number =>
      Math.abs(next) <= PITCH
        ? next
        : Math.sign(next) * Math.min(Math.abs(next), Math.max(PITCH, Math.abs(from)))
    const euler = new Euler()
    const orient = (): void => {
      pivot.quaternion.setFromEuler(euler.set(pitch, yaw, 0, 'XYZ'))
    }
    const turnTo = (m: Marker): void => {
      const target = { yaw: nearest(-m.lng * RAD, yaw), pitch: m.lat * RAD }
      aim = undefined
      velocity = 0
      if (reduced()) {
        yaw = target.yaw
        pitch = target.pitch
        turn = undefined
      } else turn = { ...target, fromYaw: yaw, fromPitch: pitch, t: 0 }
      ctx.invalidate()
    }

    /** The marker under a viewport point: the nearest front one within `markerSize + 8` px. */
    const hit = (x: number, y: number): Marker | undefined => {
      const box = el.getBoundingClientRect()
      const radiusPx = RADIUS * p.scale * Math.min(box.width, box.height)
      const viewWidth = ctx.app.stage.width.peek()
      const viewHeight = ctx.app.stage.height.peek()
      const cameraZ = ctx.render.camera.position.z
      // The globe's centre from the viewport's, px with y up.
      const centreX = box.left + box.width / 2 - viewWidth / 2
      const centreY = viewHeight / 2 - box.top - box.height / 2
      const marker = new Vector3()
      let best: Marker | undefined
      let reach = p.markerSize + HIT_SLOP
      const count = Math.min(points.length, HITS)
      for (let i = 0; i < count; i++) {
        marker
          .fromArray(units, i * 3)
          .applyQuaternion(pivot.quaternion)
          .multiplyScalar(radiusPx)
        if (marker.z <= 0) continue
        const perspective = cameraZ > 0 ? cameraZ / (cameraZ - marker.z) : 1
        const distance = Math.hypot(
          viewWidth / 2 + (centreX + marker.x) * perspective - x,
          viewHeight / 2 - (centreY + marker.y) * perspective - y,
        )
        if (distance < reach) {
          reach = distance
          best = points[i]
        }
      }
      return best
    }
    /** The point whose element holds `node`, if any. */
    const pointOf = (node: unknown): Marker | undefined => {
      if (!(node instanceof Element)) return undefined
      return points.find((m) => m.element?.contains(node))
    }

    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
      capture = false,
    ): void => target.addEventListener(type, fn as (event: Event) => void, { signal, capture })
    // A finger drags only where the site gave the gesture to the page: otherwise it scrolls.
    const touchable = (): boolean => {
      const action = getComputedStyle(el).touchAction
      return action === 'none' || (action.includes('pan-y') && !action.includes('pan-x'))
    }
    listen(el, 'pointerdown', (e) => {
      if (grab) return
      moved = false
      if (!p.drag || e.button !== 0 || (e.pointerType !== 'mouse' && !touchable())) return
      const { pointerId: id, clientX: x, clientY: y, timeStamp: t } = e
      grab = { id, x, y, t, startX: x, startY: y }
      velocity = 0
      aim = undefined
      turn = undefined
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
      // No text selection and no native drag of a poster.
      if (e.pointerType === 'mouse') e.preventDefault()
    })
    listen(el, 'pointermove', (e) => {
      if (e.pointerId === grab?.id) {
        // The point under the pointer follows it.
        const box = el.getBoundingClientRect()
        const radiansPerPx = 1 / Math.max(1, RADIUS * p.scale * Math.min(box.width, box.height))
        const dx = (e.clientX - grab.x) * radiansPerPx
        const seconds = Math.max(1, e.timeStamp - grab.t) / 1000
        // The release speed is smoothed over the last few moves.
        velocity = velocity * 0.2 + (dx / seconds) * 0.8
        yaw += dx
        pitch = hold(pitch + (e.clientY - grab.y) * radiansPerPx, pitch)
        moved ||= Math.hypot(e.clientX - grab.startX, e.clientY - grab.startY) > TAP_SLOP
        grab = { ...grab, x: e.clientX, y: e.clientY, t: e.timeStamp }
        ctx.invalidate()
        return
      }
      // No hover on touch: a tap is a click.
      if (e.pointerType === 'touch' || grab) return
      hovered = hit(e.clientX, e.clientY)
      light()
    })
    const drags = afterDrag(el, signal)
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== grab?.id) return
      if (moved && e.type === 'pointerup') drags.arm(e)
      // Held still before letting go, cancelled by a scroll, or no motion wanted: no coasting.
      if (e.type !== 'pointerup' || e.timeStamp - grab.t > COAST_HOLD || reduced()) velocity = 0
      velocity = Math.min(COAST_MAX, Math.max(-COAST_MAX, velocity))
      grab = undefined
      rest = PAUSE
      ctx.invalidate()
    }
    listen(el, 'pointerup', release)
    listen(el, 'pointercancel', release)
    listen(el, 'dragstart', (e) => e.preventDefault())
    listen(el, 'pointerenter', (e) => {
      if (e.pointerType === 'mouse') over = true
    })
    listen(el, 'pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return
      over = false
      hovered = undefined
      rest = PAUSE
      light()
      ctx.invalidate()
    })
    // A pointer click lands on the marker under it, except the one a drag ends with; keyboard
    // clicks (detail 0) stay native, which is also how the click handed to a point's link passes
    // through here.
    listen(
      el,
      'click',
      (e) => {
        if (routing || e.detail === 0) return
        // The hidden list inside the globe must not take clicks meant for the globe.
        if (e.target !== el) {
          e.preventDefault()
          e.stopPropagation()
        }
        if (drags.ends(e)) return
        const marker = hit(e.clientX, e.clientY)
        if (!marker) return
        hovered = marker
        light()
        const node = marker.element
        if (!node) return
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
    listen(el, 'keydown', (e) => {
      if (!p.drag || !el.hasAttribute('tabindex')) return
      const x = e.key === 'ArrowRight' ? -1 : e.key === 'ArrowLeft' ? 1 : 0
      const y = e.key === 'ArrowDown' ? -1 : e.key === 'ArrowUp' ? 1 : 0
      if (!x && !y) return
      e.preventDefault()
      aim = undefined
      turn = undefined
      keyYaw += x * STEP
      keyPitch += y * STEP
      ctx.invalidate()
    })
    // Legend items outside the globe light their marker; focus anywhere in a point turns to it.
    listen(document, 'pointerover', (e) => {
      const marker = pointOf(e.target)
      if (!marker || el.contains(marker.element)) return
      legend = marker
      light()
    })
    listen(document, 'pointerout', (e) => {
      if (!legend || legend.element?.contains(e.relatedTarget as Element | null)) return
      legend = undefined
      light()
    })
    listen(document, 'focusin', (e) => {
      const marker = pointOf(e.target)
      if (!marker || marker === focused) return
      focused = marker
      turnTo(marker)
      light()
    })
    listen(document, 'focusout', (e) => {
      if (!focused || pointOf(e.relatedTarget)) return
      focused = undefined
      rest = PAUSE
      light()
      ctx.invalidate()
    })

    scan()
    if (reduced()) reveal = undefined
    drawn.value = reveal === undefined ? 1 : 0
    orient()
    root.scale.setScalar(p.scale)

    const motion: Motion = { fast: false, spinning: false }
    motions.set(signal, motion)
    ctx.onDispose(() => motions.delete(signal))
    // What is left of an arrow key step after this frame.
    const pull = (value: number, still: boolean, dt: number): number => {
      return still ? 0 : damp(value, 0, KEY_HALF_LIFE, dt, EPSILON)
    }
    return (now) => {
      const still = now.reducedMotion
      const dt = Math.min(now.delta, MAX_STEP)
      if (dirty) {
        dirty = false
        scan()
      }
      if (p.lat !== lat || p.lng !== lng) {
        lat = p.lat
        lng = p.lng
        turn = undefined
        aim = { yaw: nearest(-lng * RAD, yaw), pitch: lat * RAD }
      }
      // Spin stops under the pointer, while dragged or focused, and waits `PAUSE` after: the
      // handlers that end a hold restart the wait, since no frame runs while it is held.
      const held = over || grab !== undefined || focused !== undefined
      if (!held && rest > 0) rest = Math.max(0, rest - dt)
      const spins = !still && p.spin !== 0
      if (spins && !held && rest === 0) {
        // Degrees a second.
        const step = ((p.spin * TAU) / 360) * dt
        yaw += step
        if (aim) aim.yaw += step
      }
      if (velocity && !grab) {
        yaw += velocity * dt
        velocity =
          Math.abs(velocity) < COAST_STOP || still ? 0 : damp(velocity, 0, COAST_HALF_LIFE, dt)
      }
      if (aim) {
        yaw = still ? aim.yaw : damp(yaw, aim.yaw, AIM_HALF_LIFE, dt)
        pitch = still ? aim.pitch : damp(pitch, aim.pitch, AIM_HALF_LIFE, dt)
        if (Math.abs(yaw - aim.yaw) + Math.abs(pitch - aim.pitch) < EPSILON) {
          yaw = aim.yaw
          pitch = aim.pitch
          aim = undefined
        }
      }
      if (turn) {
        turn.t = still ? 1 : Math.min(1, turn.t + dt / TURN)
        const k = ease('cubicInOut', turn.t)
        yaw = turn.fromYaw + (turn.yaw - turn.fromYaw) * k
        pitch = turn.fromPitch + (turn.pitch - turn.fromPitch) * k
        if (turn.t === 1) turn = undefined
      }
      // Arrow keys ease to the next step, or jump to it under reduced motion.
      if (keyYaw || keyPitch) {
        const yawLeft = pull(keyYaw, still, dt)
        const pitchLeft = pull(keyPitch, still, dt)
        yaw += keyYaw - yawLeft
        pitch = hold(pitch + keyPitch - pitchLeft, pitch)
        keyYaw = yawLeft
        keyPitch = pitchLeft
      }
      if (reveal !== undefined) {
        reveal = still ? 1 : Math.min(1, reveal + dt / TURN)
        drawn.value = ease('cubicInOut', reveal)
        if (reveal === 1) reveal = undefined
      }
      // A flowing dash runs at the spin's rate; under reduced motion the arcs stand whole.
      const flowing = flow && arcCount > 0 && !still
      if (flowing) clock.value = ((clock.value as number) + dt) % (FLOW * 1000)
      whole.value = still ? 1 : 0
      // Lit markers ease in and out.
      let easing = false
      for (let i = 0; i < points.length; i++) {
        const target = points[i] === lit ? 1 : 0
        const value = lifts[i] as number
        if (value === target) continue
        lifts[i] = still ? target : damp(value, target, LIGHT_HALF_LIFE, dt, 1e-3)
        easing ||= lifts[i] !== target
        liftAttr.needsUpdate = true
      }
      orient()
      root.scale.setScalar(p.scale * (0.96 + 0.04 * now.presence))
      motion.fast =
        (velocity !== 0 && !grab) ||
        aim !== undefined ||
        turn !== undefined ||
        reveal !== undefined ||
        keyYaw !== 0 ||
        keyPitch !== 0 ||
        easing
      motion.spinning = (spins && !held) || flowing
    }
  },
})
export default globe
