import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, inView, rng } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  attribute,
  float,
  length,
  max,
  mix,
  positionGeometry,
  select,
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
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  Vector2,
} from 'three/webgpu'
import { cellValue, escapeHtml, PALETTE, rowsOf, SHOWN, tooltip } from './table'

type Mode = 'force' | 'radial' | 'tree' | 'circle'
type Motion = 'grow' | 'spread' | 'fade'
type Params = {
  mode: ChoiceParam<Mode>
  motion: ChoiceParam<Motion>
  colors: string
  seed: number
  radius: number
  thickness: number
  labels: boolean
  arrows: boolean
  dim: number
  duration: number
  stagger: number
}
type Float = Node<'float'>
type Vec2 = Node<'vec2'>

/** Most nodes one graph draws; the rest of a longer list stays DOM only. */
export const MAX_NODES = 400
/** Segments of a curved edge in the circle mode. */
const SEGMENTS = 16
/** How far a circle edge bows towards the middle, as a share of the way. */
const BEND = 0.7

/** A node of the graph: a list item, or a name in a table of links. */
export interface GraphNode {
  readonly id: string
  readonly label: string
  /** Text of the item besides its label, for the tooltip. */
  readonly note: string
  readonly group: string
  /** `data-dio-value`, NaN without one: sizes the node instead of its links. */
  readonly value: number
  readonly element: Element
  /** The item's link, followed when the node is clicked. */
  readonly link: HTMLElement | null
}
export interface GraphEdge {
  readonly from: number
  readonly to: number
  readonly weight: number
}
export interface GraphData {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
}

const words = (s: string): string => s.replace(/\s+/g, ' ').trim()
const isList = (child: Node | ChildNode): boolean =>
  child.nodeType === 1 && /^(UL|OL)$/.test((child as Element).tagName)

/** The item's own text without nested lists. */
function ownText(li: Element): string {
  let text = ''
  for (const child of li.childNodes) if (!isList(child)) text += `${child.textContent ?? ''} `
  return words(text)
}

/**
 * Nodes and links of a list or a table. A list: every `<li>` is a node, a nested list links its
 * items to the item it sits in, `data-dio-to` links to other items by id or label. A table: each
 * row links the names in its first two cells, a number in the third is the link's weight.
 */
export function readGraph(element: Element): GraphData {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  /** Nodes by lowercase id and label, the first one for each. */
  const byKey = new Map<string, number>()
  const seen = new Set<string>()
  const add = (node: GraphNode): number => {
    nodes.push(node)
    for (const key of [node.id, node.label].map((s) => s.toLowerCase()))
      if (key && !byKey.has(key)) byKey.set(key, nodes.length - 1)
    return nodes.length - 1
  }
  /** Links two nodes once, whichever way round, never a node to itself. */
  const link = (from: number, to: number, weight: number): void => {
    const key = from < to ? `${from} ${to}` : `${to} ${from}`
    if (from === to || seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, weight })
  }
  if (element instanceof HTMLTableElement) {
    const named = (cell: HTMLTableCellElement | undefined): number => {
      const label = words(cell?.textContent ?? '')
      if (!cell || !label) return -1
      const found = byKey.get(label.toLowerCase())
      if (found !== undefined) return found
      if (nodes.length >= MAX_NODES) return -1
      return add({
        id: label,
        label,
        note: '',
        group: cell.getAttribute('data-dio-group') ?? '',
        value: Number.NaN,
        element: cell,
        link: cell.querySelector<HTMLElement>('a[href]'),
      })
    }
    for (const row of rowsOf(element).body) {
      const [fromCell, toCell, weightCell] = [...row.cells]
      const from = named(fromCell)
      const to = named(toCell)
      const weight = weightCell ? cellValue(weightCell)[0] : Number.NaN
      if (from >= 0 && to >= 0) link(from, to, weight > 0 ? weight : 1)
    }
    return { nodes, edges }
  }
  const items = [...element.querySelectorAll('li')].slice(0, MAX_NODES)
  const index = new Map<Element, number>()
  for (const li of items) {
    const anchor = [...li.querySelectorAll<HTMLElement>('a[href]')].find(
      (a) => a.closest('li') === li,
    )
    const own = ownText(li)
    const label = anchor ? words(anchor.textContent ?? '') : own
    const grouped = li.closest('[data-dio-group]')
    const value = Number.parseFloat(li.getAttribute('data-dio-value') ?? '')
    index.set(
      li,
      add({
        id: li.id || label,
        label,
        note: anchor ? words(own.replace(label, '')) : '',
        group:
          grouped && element.contains(grouped)
            ? (grouped.getAttribute('data-dio-group') ?? '')
            : '',
        value,
        element: li,
        link: anchor ?? null,
      }),
    )
  }
  // Links by `data-dio-to` wait until every item has its node.
  const pending: [number, string][] = []
  for (const li of items) {
    const i = index.get(li) as number
    const parent = li.parentElement?.closest('li')
    const parentNode = parent && element.contains(parent) ? index.get(parent) : undefined
    if (parentNode !== undefined) link(parentNode, i, 1)
    for (const token of (li.getAttribute('data-dio-to') ?? '').split(/[\s,]+/))
      if (token) pending.push([i, token.replace(/^#/, '').toLowerCase()])
  }
  for (const [i, token] of pending) {
    const j = byKey.get(token)
    if (j !== undefined) link(i, j, 1)
  }
  return { nodes, edges }
}

/** Neighbors of every node, in the order the links were written. */
export function neighbors(n: number, edges: readonly GraphEdge[]): number[][] {
  const out: number[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    out[e.from]?.push(e.to)
    out[e.to]?.push(e.from)
  }
  return out
}

/**
 * A spanning tree by breadth from node 0, then from the first node of each other part: the
 * parent and depth of every node, and the roots of the parts.
 */
export function spanning(
  n: number,
  edges: readonly GraphEdge[],
): { parent: Int32Array; depth: Int32Array; roots: number[] } {
  const adjacent = neighbors(n, edges)
  const parent = new Int32Array(n).fill(-1)
  const depth = new Int32Array(n).fill(-1)
  const roots: number[] = []
  for (let root = 0; root < n; root++) {
    if (depth[root] !== -1) continue
    roots.push(root)
    depth[root] = 0
    const queue = [root]
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] as number
      for (const next of adjacent[node] as number[]) {
        if (depth[next] !== -1) continue
        depth[next] = (depth[node] as number) + 1
        parent[next] = node
        queue.push(next)
      }
    }
  }
  return { parent, depth, roots }
}

/** Children of every node in a spanning tree, other parts under node 0 for the radial mode. */
function childrenOf(parent: Int32Array, roots: readonly number[], join: boolean): number[][] {
  const out: number[][] = Array.from({ length: parent.length }, () => [])
  parent.forEach((up, i) => {
    if (up >= 0) out[up]?.push(i)
  })
  if (join) for (const root of roots.slice(1)) out[0]?.push(root)
  return out
}

/**
 * Positions of the nodes, x right and y down, in a frame of the box's proportions; the same
 * graph, mode, aspect and seed always give the same picture.
 */
export function layoutGraph(data: GraphData, mode: Mode, aspect: number, seed = 1): Float64Array {
  const n = data.nodes.length
  const positions = new Float64Array(n * 2)
  if (n < 2) return positions
  const { parent, depth, roots } = spanning(n, data.edges)
  if (mode === 'circle') {
    // Grouped, in the order the groups first appear, from the top clockwise.
    const groups = [...new Set(data.nodes.map((d) => d.group))]
    const order = [...data.nodes.keys()].sort(
      (a, b) =>
        groups.indexOf((data.nodes[a] as GraphNode).group) -
          groups.indexOf((data.nodes[b] as GraphNode).group) || a - b,
    )
    order.forEach((i, k) => {
      const angle = (k / n) * Math.PI * 2 - Math.PI / 2
      positions[i * 2] = Math.cos(angle) * aspect
      positions[i * 2 + 1] = Math.sin(angle)
    })
    return positions
  }
  if (mode === 'tree') {
    // Leaves side by side in order, a parent over the middle of its children, a level per depth.
    const children = childrenOf(parent, roots, false)
    let nextLeaf = 0
    const place = (node: number): void => {
      const own = children[node] as number[]
      if (!own.length) positions[node * 2] = nextLeaf++
      else {
        for (const child of own) place(child)
        const first = positions[(own[0] as number) * 2] as number
        const last = positions[(own[own.length - 1] as number) * 2] as number
        positions[node * 2] = (first + last) / 2
      }
      positions[node * 2 + 1] = depth[node] as number
    }
    for (const root of roots) place(root)
    return positions
  }
  if (mode === 'radial') {
    // Node 0 in the middle, a ring per step away, each branch a slice as wide as its leaves.
    const children = childrenOf(parent, roots, true)
    const ring = new Int32Array(n)
    const leaves = new Float64Array(n)
    const countLeaves = (node: number, level: number): number => {
      ring[node] = level
      const own = children[node] as number[]
      leaves[node] = own.length
        ? own.reduce((sum, child) => sum + countLeaves(child, level + 1), 0)
        : 1
      return leaves[node] as number
    }
    countLeaves(0, 0)
    const deepest = Math.max(1, ...ring)
    const spread = (node: number, from: number, span: number): void => {
      const radius = (ring[node] as number) / deepest
      const angle = from + span / 2
      positions[node * 2] = Math.cos(angle) * radius * aspect
      positions[node * 2 + 1] = Math.sin(angle) * radius
      let at = from
      for (const child of children[node] as number[]) {
        const share = (span * (leaves[child] as number)) / (leaves[node] as number)
        spread(child, at, share)
        at += share
      }
    }
    // The first branch points up.
    const first = (children[0] as number[])[0]
    const share =
      first === undefined ? 0 : (Math.PI * 2 * (leaves[first] as number)) / (leaves[0] as number)
    spread(0, -Math.PI / 2 - share / 2, Math.PI * 2)
    return positions
  }
  // Force: Fruchterman and Reingold from seeded places, cooled over a fixed number of steps.
  const width = Math.sqrt(n * aspect)
  const height = Math.sqrt(n / aspect)
  /** The ideal distance between two linked nodes. */
  const ideal = 0.9
  const random = rng(seed)
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (random() - 0.5) * width
    positions[i * 2 + 1] = (random() - 0.5) * height
  }
  const steps = n > 200 ? 160 : 300
  const forceX = new Float64Array(n)
  const forceY = new Float64Array(n)
  // The longest move a step allows, cooled to nothing by the last step.
  let temperature = width / 8
  const cooling = temperature / (steps + 1)
  for (let step = 0; step < steps; step++) {
    forceX.fill(0)
    forceY.fill(0)
    // Every pair repels.
    for (let i = 0; i < n; i++) {
      const xi = positions[i * 2] as number
      const yi = positions[i * 2 + 1] as number
      for (let j = i + 1; j < n; j++) {
        const x = xi - (positions[j * 2] as number)
        const y = yi - (positions[j * 2 + 1] as number)
        const push = (ideal * ideal) / Math.max(x * x + y * y, 1e-4)
        forceX[i] = (forceX[i] as number) + x * push
        forceY[i] = (forceY[i] as number) + y * push
        forceX[j] = (forceX[j] as number) - x * push
        forceY[j] = (forceY[j] as number) - y * push
      }
    }
    // Linked nodes attract.
    for (const edge of data.edges) {
      const x = (positions[edge.from * 2] as number) - (positions[edge.to * 2] as number)
      const y = (positions[edge.from * 2 + 1] as number) - (positions[edge.to * 2 + 1] as number)
      const pull = Math.sqrt(x * x + y * y) / ideal
      forceX[edge.from] = (forceX[edge.from] as number) - x * pull
      forceY[edge.from] = (forceY[edge.from] as number) - y * pull
      forceX[edge.to] = (forceX[edge.to] as number) + x * pull
      forceY[edge.to] = (forceY[edge.to] as number) + y * pull
    }
    for (let i = 0; i < n; i++) {
      // Gravity keeps parts that link to nothing near the rest; pulled harder across the short
      // side of the box, the graph takes its proportions without walls to pile up against.
      const x = (forceX[i] as number) - ((positions[i * 2] as number) * 0.12) / aspect
      const y = (forceY[i] as number) - (positions[i * 2 + 1] as number) * 0.12 * aspect
      const length = Math.sqrt(x * x + y * y)
      if (length <= 0) continue
      const move = Math.min(length, temperature) / length
      positions[i * 2] = (positions[i * 2] as number) + x * move
      positions[i * 2 + 1] = (positions[i * 2 + 1] as number) + y * move
    }
    temperature -= cooling
  }
  return positions
}

/** A box in element px: x from the left, y from the top. */
interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Layout positions stretched into `plot`, element px; a flat axis stays in the middle. */
export function fitTo(raw: Float64Array, plot: Rect): Float32Array {
  const n = raw.length / 2
  let x0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, raw[i * 2] as number)
    x1 = Math.max(x1, raw[i * 2] as number)
    y0 = Math.min(y0, raw[i * 2 + 1] as number)
    y1 = Math.max(y1, raw[i * 2 + 1] as number)
  }
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    out[i * 2] =
      x1 - x0 > 1e-9
        ? plot.left + (((raw[i * 2] as number) - x0) / (x1 - x0)) * plot.width
        : plot.left + plot.width / 2
    out[i * 2 + 1] =
      y1 - y0 > 1e-9
        ? plot.top + (((raw[i * 2 + 1] as number) - y0) / (y1 - y0)) * plot.height
        : plot.top + plot.height / 2
  }
  return out
}

/**
 * A list or a table of links drawn as a network: nodes in group colors sized by their links,
 * laid out once from a seed, that grow in when the graph scrolls into view. The pointer or focus
 * on a node lights it and its neighbors; the markup stays for screen readers and keyboards.
 */
const graph: Effect<Params> = defineEffect({
  name: 'graph',
  params: {
    mode: oneOf('force', 'radial', 'tree', 'circle'),
    motion: oneOf('grow', 'spread', 'fade'),
    colors: '',
    seed: 1,
    radius: 6,
    thickness: 1.25,
    labels: true,
    arrows: false,
    dim: 0.75,
    duration: 0.6,
    stagger: 0.12,
  },
  on: 'ul, ol, table',
  rebuild: ['seed'],
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { signal, u, params } = ctx
    const element = ctx.element as HTMLElement
    const mode = params.mode
    const motion = params.motion
    const data = readGraph(element)
    const n = data.nodes.length
    const adjacent = neighbors(n, data.edges)
    if (DEV && n < 2)
      ctx.app.log.warn('graph found fewer than two nodes in its list or table', element)

    // Colors by group, in the order groups first appear.
    const groups = [...new Set(data.nodes.map((d) => d.group))]
    const colors = (
      params.colors.trim() ? params.colors.split(/[\s,]+(?![^(]*\))/).filter(Boolean) : PALETTE
    ).map((c) => new Color(cssColor(c) ?? '#888888'))
    const tintOf = (i: number): Color =>
      colors[groups.indexOf((data.nodes[i] as GraphNode).group) % colors.length] as Color

    // Size: by value when the items give one, else by links.
    const degree = adjacent.map((list) => list.length)
    const valued = data.nodes.some((d) => d.value > 0)
    const sizes = data.nodes.map((d, i) =>
      valued ? Math.max(0, d.value) || 0 : (degree[i] as number),
    )
    const smallest = Math.min(...sizes)
    const largest = Math.max(...sizes)
    /** Radius of each node in units of `radius`: 0.7 to 1.6, the area following the size. */
    const scales = sizes.map((v) =>
      largest > smallest ? 0.7 + 0.9 * Math.sqrt((v - smallest) / (largest - smallest)) : 1,
    )
    const largestScale = Math.max(1, ...scales)
    const weights = data.edges.map((e) => e.weight)
    const heaviest = Math.max(1, ...weights)
    const widthOf = (weight: number): number =>
      weights.every((x) => x === weights[0]) ? 1 : 0.6 + 1.6 * Math.sqrt(weight / heaviest)

    // Order of the entrance: steps away from node 0, in order within a step.
    const { depth } = spanning(n, data.edges)
    const deepest = Math.max(0, ...depth)
    const levels: number[][] = Array.from({ length: deepest + 1 }, () => [])
    depth.forEach((d, i) => {
      levels[d]?.push(i)
    })
    const delays = new Float32Array(n)
    const stagger = Math.max(0, params.stagger)
    for (const [level, members] of levels.entries())
      members.forEach((i, k) => {
        delays[i] = (level + (k / Math.max(1, members.length)) * 0.8) * stagger
      })
    const lastDelay = n ? Math.max(...delays) : 0

    const root = new Group()
    ctx.place(root, { fit: 'none', replace: true })

    const clock = uniform(0)
    const span = uniform(Math.max(params.duration, 1e-3))
    // The hovered node, -1 for none, and how far the hover has faded in.
    const hot = uniform(-1)
    const focus = uniform(0)
    // Node 0, where the spread motion starts from.
    const origin = uniform(new Vector2())
    const ink = uniform(new Color('#888888'))
    /** 0..1 with a cubic ease out, `delay` s after the clock started. */
    const grown = (delay: Float): Float =>
      clock.sub(delay).div(span).clamp(0, 1).oneMinus().pow(3).oneMinus() as unknown as Float
    /** Where a node at `home` is at `growth`: the spread motion moves it out from node 0. */
    const positionAt = (home: Vec2, growth: Float): Vec2 =>
      (motion === 'spread' ? origin.add(home.sub(origin).mul(growth)) : home) as unknown as Vec2
    /** Opacity at `growth`: only the fade motion fades in. */
    const shown = (growth: Float): Float =>
      (motion === 'fade' ? growth : float(1)) as unknown as Float
    const fade = float(1).sub(focus.mul(u.dim).clamp(0, 1))

    // Edges: ribbons of constant width, straight or bowed towards the middle, one draw.
    const ends = attribute('ends', 'vec4')
    const pair = attribute('pair', 'vec2')
    const edgeDelays = attribute('delays', 'vec2')
    const along = attribute('along', 'float')
    const side = attribute('side', 'float')
    const thick = attribute('thick', 'float')
    const bend = mode === 'circle' ? BEND : 0
    /** The point and the tangent at `t` of the edge, a quadratic curve that is straight at bend 0. */
    const curve = (t: Float) => {
      const start = positionAt(ends.xy as unknown as Vec2, grown(edgeDelays.x as unknown as Float))
      const end = positionAt(ends.zw as unknown as Vec2, grown(edgeDelays.y as unknown as Float))
      // Neighbors on the ring bow a little, opposite nodes pass near the middle.
      const chord = length(end.sub(start)).div(max(length(start).add(length(end)), 1e-4))
      const control = start.add(end).mul(chord.mul(-bend).add(1).mul(0.5))
      const s = float(1).sub(t)
      const point = start
        .mul(s.mul(s))
        .add(control.mul(s.mul(t).mul(2)))
        .add(end.mul(t.mul(t)))
      const tangent = control
        .sub(start)
        .mul(s.mul(2))
        .add(end.sub(control).mul(t.mul(2)))
      return { point, tangent }
    }
    const lit = select(
      abs(pair.x.sub(hot))
        .lessThan(0.5)
        .or(abs(pair.y.sub(hot)).lessThan(0.5)),
      1,
      0,
    )
    const edgeMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    {
      const { point, tangent } = curve(along as unknown as Float)
      const half = u.thickness.mul(thick).mul(0.5)
      const normal = vec2(tangent.y.negate(), tangent.x).div(max(length(tangent), 1e-4))
      // A px wider on each side for the antialiased edge.
      const across = varying(side.mul(half.add(1)))
      edgeMaterial.positionNode = vec3(point.add(normal.mul(side).mul(half.add(1))), 0)
      edgeMaterial.colorNode = ink
      const edgeGrowth = grown(max(edgeDelays.x, edgeDelays.y) as unknown as Float)
      const drawn = motion === 'grow' ? select(along.lessThanEqual(edgeGrowth), 1, 0) : float(1)
      edgeMaterial.opacityNode = half
        .sub(abs(across))
        .add(0.5)
        .clamp(0, 1)
        .mul(drawn)
        .mul(shown(edgeGrowth))
        .mul(float(0.3).add(lit.mul(focus).mul(0.55)))
        .mul(select(lit.greaterThan(0.5), float(1), fade))
        .mul(u.opacity)
    }
    const edges = new Mesh(new BufferGeometry(), edgeMaterial)
    edges.frustumCulled = false
    root.add(edges)

    // Arrowheads at the target end of each link.
    const arrowMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    {
      const { point, tangent } = curve(float(1))
      const direction = tangent.div(max(length(tangent), 1e-4))
      const perpendicular = vec2(direction.y.negate(), direction.x)
      const size = u.thickness.mul(2.5).add(4)
      // The tip stops at the target's rim.
      const tip = point.sub(direction.mul(u.radius.mul(attribute('reach', 'float')).add(1.5)))
      const local = positionGeometry.xy.mul(size)
      arrowMaterial.positionNode = vec3(
        tip.add(direction.mul(local.x)).add(perpendicular.mul(local.y)),
        0.1,
      )
      arrowMaterial.colorNode = ink
      const edgeGrowth = grown(max(edgeDelays.x, edgeDelays.y) as unknown as Float)
      arrowMaterial.opacityNode = select(edgeGrowth.greaterThan(0.98), 1, 0)
        .mul(shown(edgeGrowth))
        .mul(float(0.55).add(lit.mul(focus).mul(0.4)))
        .mul(select(lit.greaterThan(0.5), float(1), fade))
        .mul(u.opacity)
    }
    const arrows = new Mesh(new InstancedBufferGeometry(), arrowMaterial)
    arrows.frustumCulled = false
    root.add(arrows)

    // Nodes: discs; the lit one gets a ring in the text color.
    const nodeMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    {
      const center = attribute('center', 'vec2')
      const delay = attribute('delay', 'float')
      const near = attribute('near', 'float')
      const index = attribute('index', 'float')
      const growth = grown(delay as unknown as Float)
      const scale =
        motion === 'grow' ? growth : motion === 'spread' ? growth.mul(0.6).add(0.4) : float(1)
      const radius = u.radius.mul(attribute('size', 'float')).mul(scale)
      // The quad reaches 5 px past the disc for the ring.
      const reach = radius.add(5)
      const local = varying(positionGeometry.xy.mul(reach))
      nodeMaterial.positionNode = vec3(
        positionAt(center as unknown as Vec2, growth).add(positionGeometry.xy.mul(reach)),
        0.2,
      )
      const fromCenter = length(local)
      const disc = radius.sub(fromCenter).add(0.5).clamp(0, 1)
      const isHot = select(abs(index.sub(hot)).lessThan(0.5), 1, 0).mul(focus)
      const ring = float(0.75)
        .sub(abs(fromCenter.sub(radius.add(2.75))))
        .add(0.5)
        .clamp(0, 1)
        .mul(isHot)
      nodeMaterial.colorNode = mix(ink, attribute('tint', 'vec3'), disc)
      nodeMaterial.opacityNode = max(disc, ring)
        .mul(shown(growth))
        .mul(select(near.greaterThan(0.5), float(1), fade))
        .mul(u.opacity)
    }
    const nodes = new Mesh(new InstancedBufferGeometry(), nodeMaterial)
    nodes.frustumCulled = false
    root.add(nodes)
    /** 1 for the lit node and its neighbors, which stay undimmed. */
    const nearFlags = new Float32Array(Math.max(1, n))
    let nearAttr: InstancedBufferAttribute | undefined

    // Labels: a canvas the size of the box, drawn again when the layout or the lit node changes.
    const canvas = document.createElement('canvas')
    const map = new CanvasTexture(canvas)
    // Premultiplied, so filtering does not fringe the text and its halo with black.
    map.premultiplyAlpha = true
    map.minFilter = map.magFilter = LinearFilter
    map.generateMipmaps = false
    ctx.onDispose(() => map.dispose())
    const inked = uniform(0)
    const paper = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    const texel = texture(map)
    const rgb = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as Node<'vec3'>
    paper.colorNode = vec4(rgb, texel.a)
    paper.opacityNode = inked.mul(u.opacity)
    const sheet = new Mesh(new PlaneGeometry(1, 1), paper)
    sheet.position.z = 0.3
    root.add(sheet)

    // Layout in element px.
    let screen: Float32Array = new Float32Array(n * 2)
    let font = 13
    let family = 'system-ui, sans-serif'
    /** The aspect the layout was worked out for. */
    let laid = ''
    let raw: Float64Array = new Float64Array(n * 2)
    let width = 1
    let height = 1
    const measure = (context: CanvasRenderingContext2D | null, text: string): number => {
      if (!context) return text.length * font * 0.55
      context.font = `${font}px ${family}`
      return context.measureText(text).width
    }

    /** Font and ink, the layout for the box's proportions, and the nodes fitted into the box. */
    const layout = (w: number, h: number): void => {
      const computed = getComputedStyle(element)
      font = Math.max(10, Math.min(14, (Number.parseFloat(computed.fontSize) || 15) * 0.8))
      family = computed.fontFamily || family
      ink.value.set(cssColor(computed.color) ?? '#888888')
      // The layout follows the box's proportions in steps, so a resize does not reshuffle it.
      const aspect = 2 ** (Math.round(Math.log2(Math.max(0.1, w / h)) * 4) / 4)
      const key = `${aspect}`
      if (key !== laid) {
        laid = key
        raw = layoutGraph(data, mode, aspect, params.seed)
      }
      const context = canvas.getContext('2d')
      const widest = params.labels
        ? Math.max(0, ...data.nodes.map((d) => measure(context, d.label)))
        : 0
      const pad = params.radius * largestScale + 6
      let plot: Rect
      if (mode === 'tree') {
        const side = Math.max(pad, Math.min(w * 0.15, widest / 2 + 4))
        const below = params.labels ? font * 1.6 + pad : pad
        plot = { left: side, top: pad, width: w - side * 2, height: h - pad - below }
      } else if (mode === 'circle') {
        const side = params.labels ? Math.min(w * 0.25, widest + pad + 6) : pad
        const top = params.labels ? pad + font : pad
        plot = { left: side, top, width: w - side * 2, height: h - top * 2 }
      } else {
        const right = params.labels ? Math.min(w * 0.3, widest + pad + 6) : pad
        plot = {
          left: pad,
          top: pad + font * 0.5,
          width: w - pad - right,
          height: h - pad * 2 - font,
        }
      }
      plot.width = Math.max(1, plot.width)
      plot.height = Math.max(1, plot.height)
      screen = fitTo(raw, plot)
      width = w
      height = h
    }

    /** Marks in world px, centre of the box at 0,0, y up. */
    const build = (): void => {
      const worldX = (i: number): number => (screen[i * 2] as number) - width / 2
      const worldY = (i: number): number => height / 2 - (screen[i * 2 + 1] as number)
      const centers = new Float32Array(n * 2)
      const tints = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        centers[i * 2] = worldX(i)
        centers[i * 2 + 1] = worldY(i)
        const tint = tintOf(i)
        tints.set([tint.r, tint.g, tint.b], i * 3)
      }
      if (n) origin.value.set(worldX(0), worldY(0))
      const disc = new PlaneGeometry(2, 2)
      const nodeGeometry = new InstancedBufferGeometry()
      nodeGeometry.setIndex(disc.getIndex())
      nodeGeometry.setAttribute('position', disc.getAttribute('position'))
      nodeGeometry.setAttribute('center', new InstancedBufferAttribute(centers, 2))
      nodeGeometry.setAttribute('tint', new InstancedBufferAttribute(tints, 3))
      nodeGeometry.setAttribute('size', new InstancedBufferAttribute(new Float32Array(scales), 1))
      nodeGeometry.setAttribute('delay', new InstancedBufferAttribute(delays, 1))
      nodeGeometry.setAttribute(
        'index',
        new InstancedBufferAttribute(
          Float32Array.from(scales, (_, i) => i),
          1,
        ),
      )
      nearAttr = new InstancedBufferAttribute(nearFlags, 1).setUsage(DynamicDrawUsage)
      nodeGeometry.setAttribute('near', nearAttr)
      nodeGeometry.instanceCount = n
      nodes.geometry.dispose()
      nodes.geometry = nodeGeometry

      const steps = bend ? SEGMENTS : 1
      const list = {
        ends: [] as number[],
        pair: [] as number[],
        delays: [] as number[],
        along: [] as number[],
        side: [] as number[],
        thick: [] as number[],
        index: [] as number[],
      }
      const heads = {
        ends: [] as number[],
        pair: [] as number[],
        delays: [] as number[],
        reach: [] as number[],
      }
      // Every vertex of an edge carries both ends: the shader places it along the curve.
      for (const edge of data.edges) {
        const endpoints = [worldX(edge.from), worldY(edge.from), worldX(edge.to), worldY(edge.to)]
        const first = list.side.length
        for (let s = 0; s <= steps; s++)
          for (const sign of [-1, 1]) {
            list.ends.push(...endpoints)
            list.pair.push(edge.from, edge.to)
            list.delays.push(delays[edge.from] as number, delays[edge.to] as number)
            list.along.push(s / steps)
            list.side.push(sign)
            list.thick.push(widthOf(edge.weight))
          }
        for (let s = 0; s < steps; s++) {
          const v = first + s * 2
          list.index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
        }
        heads.ends.push(...endpoints)
        heads.pair.push(edge.from, edge.to)
        heads.delays.push(delays[edge.from] as number, delays[edge.to] as number)
        heads.reach.push(scales[edge.to] as number)
      }
      const geometry = new BufferGeometry()
      const put = (name: string, values: number[], size: number): void => {
        geometry.setAttribute(name, new BufferAttribute(new Float32Array(values), size))
      }
      put(
        'position',
        list.side.flatMap(() => [0, 0, 0]),
        3,
      )
      put('ends', list.ends, 4)
      put('pair', list.pair, 2)
      put('delays', list.delays, 2)
      put('along', list.along, 1)
      put('side', list.side, 1)
      put('thick', list.thick, 1)
      geometry.setIndex(list.index)
      edges.geometry.dispose()
      edges.geometry = geometry

      const head = new BufferGeometry()
      head.setAttribute(
        'position',
        new BufferAttribute(new Float32Array([0, 0, 0, -1, 0.45, 0, -1, -0.45, 0]), 3),
      )
      const arrow = new InstancedBufferGeometry()
      arrow.setAttribute('position', head.getAttribute('position'))
      arrow.setAttribute('ends', new InstancedBufferAttribute(new Float32Array(heads.ends), 4))
      arrow.setAttribute('pair', new InstancedBufferAttribute(new Float32Array(heads.pair), 2))
      arrow.setAttribute('delays', new InstancedBufferAttribute(new Float32Array(heads.delays), 2))
      arrow.setAttribute('reach', new InstancedBufferAttribute(new Float32Array(heads.reach), 1))
      arrow.instanceCount = data.edges.length
      arrows.geometry.dispose()
      arrows.geometry = arrow
    }

    /** The lit node and its neighbors stay full; their labels go first. */
    /** The lit node, -1 for none. */
    let target = -1
    const draw = (): void => {
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const canvasWidth = Math.max(1, Math.round(width * ratio))
      const canvasHeight = Math.max(1, Math.round(height * ratio))
      // A texture keeps its storage size: a new size needs new storage.
      if (canvasWidth !== canvas.width || canvasHeight !== canvas.height) map.dispose()
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      sheet.scale.set(width, height, 1)
      map.needsUpdate = true
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      if (!params.labels || !n) return
      context.font = `${font}px ${family}`
      context.fillStyle = getComputedStyle(element).color || '#666'
      context.textBaseline = 'middle'
      // A halo in the page's colour keeps edges from striking through the text.
      const halo = backdrop(element)
      if (halo) {
        context.strokeStyle = halo
        context.lineWidth = 5
        context.lineJoin = 'round'
      }
      const lit = new Set(target >= 0 ? [target, ...(adjacent[target] as number[])] : [])
      // Bigger nodes first; a label that would overlap one already placed is left out.
      const order = [...data.nodes.keys()].sort(
        (a, b) =>
          Number(lit.has(b)) - Number(lit.has(a)) ||
          (scales[b] as number) - (scales[a] as number) ||
          a - b,
      )
      const placed: Rect[] = []
      const middleX = width / 2
      for (const i of order) {
        const label = (data.nodes[i] as GraphNode).label
        if (!label) continue
        const x = screen[i * 2] as number
        const y = screen[i * 2 + 1] as number
        const offset = params.radius * (scales[i] as number) + 5
        const textWidth = Math.min(context.measureText(label).width, width * 0.3)
        let left: number
        let top = y - font * 0.6
        let align: CanvasTextAlign = 'left'
        if (mode === 'tree') {
          align = 'center'
          left = x - textWidth / 2
          top = y + offset - 1
        } else if (mode === 'circle' && x < middleX) {
          align = 'right'
          left = x - offset - textWidth
        } else left = x + offset
        const box = { left, top, width: textWidth, height: font * 1.2 }
        const clash = placed.some(
          (o) =>
            box.left < o.left + o.width + 4 &&
            o.left < box.left + box.width + 4 &&
            box.top < o.top + o.height &&
            o.top < box.top + box.height,
        )
        if (clash && !(lit.has(i) && i === target)) continue
        placed.push(box)
        context.globalAlpha = target >= 0 && !lit.has(i) ? 1 - 0.8 * Math.min(1, params.dim) : 0.85
        context.textAlign = align
        const textX = align === 'center' ? x : align === 'right' ? x - offset : x + offset
        const textY = align === 'center' ? top + font * 0.6 : y
        if (halo) context.strokeText(label, textX, textY, width * 0.3)
        context.fillText(label, textX, textY, width * 0.3)
      }
      context.globalAlpha = 1
    }

    // Hover, touch and focus.
    const tip = tooltip(ctx.onDispose)
    /** The node under a viewport point, at least 12 px wide to aim at; -1 for none. */
    const hit = (clientX: number, clientY: number): number => {
      const box = element.getBoundingClientRect()
      const x = clientX - box.left
      const y = clientY - box.top
      let best = -1
      let reach = Number.POSITIVE_INFINITY
      for (let i = 0; i < n; i++) {
        const distance = Math.hypot(
          (screen[i * 2] as number) - x,
          (screen[i * 2 + 1] as number) - y,
        )
        const aim = Math.max(12, params.radius * (scales[i] as number) + 6)
        if (distance <= aim && distance < reach) {
          reach = distance
          best = i
        }
      }
      return best
    }
    /** Lights node `i` and its neighbors with a tooltip at `x`, `y`; -1 turns it off. */
    const light = (i: number, x = 0, y = 0): void => {
      if (i !== target) {
        target = i
        nearFlags.fill(0)
        if (i >= 0) for (const j of [i, ...(adjacent[i] as number[])]) nearFlags[j] = 1
        if (nearAttr) nearAttr.needsUpdate = true
        draw()
        ctx.invalidate()
      }
      if (i < 0) {
        tip.hide()
        element.style.cursor = ''
        return
      }
      const node = data.nodes[i] as GraphNode
      const names = (adjacent[i] as number[]).map((j) => (data.nodes[j] as GraphNode).label)
      const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6}` : '')
      tip.show(
        `<b>${escapeHtml(node.label)}</b>${node.note ? `<small>${escapeHtml(node.note)}</small>` : ''}${shown ? `<small>${escapeHtml(shown)}</small>` : ''}`,
        x,
        y,
      )
      element.style.cursor = node.link ? 'pointer' : ''
    }
    /** The viewport point of node `i`. */
    const spot = (i: number): [number, number] => {
      const box = element.getBoundingClientRect()
      return [box.left + (screen[i * 2] as number), box.top + (screen[i * 2 + 1] as number)]
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      on: HTMLElement | Document | Window,
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
      capture = false,
    ): void =>
      on.addEventListener(type, fn as (event: Event) => void, {
        signal,
        capture,
        passive: !capture,
      })
    listen(element, 'pointermove', (e) => {
      if (e.pointerType === 'touch') return
      light(hit(e.clientX, e.clientY), e.clientX, e.clientY)
    })
    listen(element, 'pointerleave', (e) => {
      if (e.pointerType !== 'touch') light(-1)
    })
    /** A click is being passed on to a node's own link: let it through. */
    let routing = false
    // A click lands on the node under the pointer, not on the hidden item there; keyboard clicks
    // (detail 0) stay native. On touch the first tap lights a node and the second follows it.
    listen(
      element,
      'click',
      (e) => {
        if (routing || e.detail === 0) return
        if (e.target !== element) e.preventDefault()
        const i = hit(e.clientX, e.clientY)
        const touch = (e as PointerEvent).pointerType === 'touch'
        if (i < 0) {
          light(-1)
          return
        }
        if (touch && i !== target) {
          light(i, e.clientX, e.clientY)
          return
        }
        const link = (data.nodes[i] as GraphNode).link
        if (!link) return light(i, e.clientX, e.clientY)
        routing = true
        try {
          link.click()
        } finally {
          routing = false
        }
      },
      true,
    )
    listen(document, 'pointerdown', (e) => {
      if (!element.contains(e.target as Element | null)) light(-1)
    })
    const nodeOf = (target: EventTarget | null): number =>
      target instanceof Element
        ? data.nodes.findIndex((d) => d.element === target || d.element.contains(target))
        : -1
    listen(element, 'focusin', (e) => {
      const i = nodeOf(e.target)
      if (i >= 0) light(i, ...spot(i))
    })
    listen(element, 'focusout', (e) => {
      if (nodeOf(e.relatedTarget) < 0) light(-1)
    })
    listen(window, 'scroll', () => target >= 0 && tip.hide())

    /** Seconds since the graph started to grow in, undefined before it came into view. */
    let started: number | undefined
    let layoutKey = ''
    // Geometry before the first compile, from the box as laid out now.
    layout(Math.max(1, ctx.input.width), Math.max(1, ctx.input.height))
    build()
    draw()

    return (input): boolean => {
      const w = input.width
      const h = input.height
      const key = `${w}x${h} ${params.radius} ${params.labels}`
      if (key !== layoutKey && w > 0 && h > 0) {
        layoutKey = key
        layout(w, h)
        build()
        draw()
      }
      arrows.visible = params.arrows && data.edges.length > 0
      span.value = Math.max(params.duration, 1e-3)
      if (started === undefined && inView(input.y, h, ctx.app.stage.height.peek(), SHOWN))
        started = 0
      const end = params.duration + lastDelay + 0.4
      if (started !== undefined && started < end)
        started = input.reducedMotion ? end : started + Math.min(input.delta, 0.1)
      clock.value = started ?? 0
      // Labels come in as the last nodes land.
      inked.value = Math.min(1, Math.max(0, ((started ?? 0) - (end - 0.4)) / 0.3))
      if (input.reducedMotion && started !== undefined) inked.value = 1
      if (target >= 0) hot.value = target
      const want = target >= 0 ? 1 : 0
      const current = focus.value as number
      focus.value = input.reducedMotion
        ? want
        : Math.abs(current - want) < 0.01
          ? want
          : damp(current, want, 0.06, input.delta)
      if (focus.value === 0) hot.value = -1
      return (started !== undefined && started < end) || focus.value !== want
    }
  },
})
export default graph

/** The colour painted behind an element: the first ancestor background that is not clear. */
export function backdrop(element: Element): string | undefined {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const background = getComputedStyle(at).backgroundColor
    if (background && background !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(background))
      return background
  }
  return undefined
}
