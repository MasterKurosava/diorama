// An exploded view of the `model` on the same element: its parts move apart as the page scrolls.
import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, ease } from '@dioramajs/effects/kit'
import { type Box3, Matrix3, Matrix4, type Mesh, type Object3D, Vector3 } from 'three/webgpu'
import { bounds, find } from './parts'
import { type Rig, watchRig } from './rig'

type Params = {
  mode: ChoiceParam<'radial' | 'axis' | 'extras'>
  by: ChoiceParam<'pin' | 'progress' | 'manual'>
  pieces: string
  axis: readonly [number, number, number]
  spread: number
  start: number
  end: number
  position: number
  cascade: number
  twist: number
  ease: number
  contain: boolean
}

const DEG = Math.PI / 180
/** Below this the scrub counts as settled. */
const EPSILON = 1e-4
/** Projections closer than this share a level along the axis, as a share of the model size. */
const LEVEL = 0.02

/** A part that moves apart, with everything about it in the file's coordinates. */
export interface Piece {
  readonly node: Object3D
  /** Bounds at rest. */
  readonly box: Box3
  /** Offset at `spread: 1`. */
  readonly offset: Vector3
  /** Takes a file offset into the parent's space. */
  readonly toParent: Matrix3
  /** Indices of the pieces it sits inside, which carry it along. */
  readonly outer: readonly number[]
}

/** The parts of a file when none are named: below the chain of single wrapper nodes. */
function automatic(file: Object3D): Object3D[] {
  let node = file
  for (;;) {
    const only = node.children.length === 1 ? node.children[0] : undefined
    if (!only || (only as Mesh).isMesh || !only.children.length) break
    node = only
  }
  return node.children
}

/**
 * The pieces of a file and their offsets at `spread: 1`. `radial` moves each from the centre by
 * its own distance; `axis` spreads levels along the axis evenly over one model size; `extras`
 * takes `extras.explode = [x, y, z]` of the glTF nodes, in file units.
 */
export function layout(
  file: Object3D,
  mode: 'radial' | 'axis' | 'extras',
  names: readonly string[],
  axis: readonly [number, number, number] = [0, 1, 0],
): { pieces: Piece[]; missing: string[]; whole: Box3; still: Box3[] } {
  file.updateWorldMatrix(true, true)
  const inverse = new Matrix4().copy(file.matrixWorld).invert()
  const missing: string[] = []
  let nodes: Object3D[]
  if (names.length) {
    nodes = []
    for (const name of names) {
      const node = find(file, name)
      if (node) nodes.push(node)
      else missing.push(name)
    }
  } else if (mode === 'extras') {
    nodes = []
    file.traverse((o) => {
      if (o !== file && extra(o)) nodes.push(o)
    })
  } else nodes = automatic(file)
  nodes = nodes.filter((node) => !bounds(node, inverse).isEmpty() || extra(node))

  const whole = bounds(file, inverse)
  const centre = whole.getCenter(new Vector3())
  const size = Math.max(...whole.getSize(new Vector3()).toArray()) || 1
  const boxes = nodes.map((node) => bounds(node, inverse))
  const centres = boxes.map((box) => box.getCenter(new Vector3()))
  let offsets: Vector3[]
  if (mode === 'extras') {
    offsets = nodes.map((node) => new Vector3().fromArray(extra(node) ?? [0, 0, 0]))
  } else if (mode === 'axis') {
    const direction = new Vector3(...axis)
    if (direction.lengthSq() === 0) direction.set(0, 1, 0)
    direction.normalize()
    const along = centres.map((c) => c.clone().sub(centre).dot(direction))
    // Levels: projections within a small share of the size sit together.
    const sorted = [...along].sort((x, y) => x - y)
    const levels: number[] = []
    for (const value of sorted) {
      const last = levels[levels.length - 1]
      if (last === undefined || value - last > LEVEL * size) levels.push(value)
    }
    // A level starts at its lowest value, so a value belongs to the last start at or below it.
    const level = (value: number): number => {
      let index = 0
      for (let i = 0; i < levels.length; i++) if (value >= (levels[i] as number)) index = i
      return index
    }
    const span = Math.max(1, levels.length - 1)
    // Levels spread evenly over one model size, centred on the model.
    offsets = along.map((value) =>
      direction.clone().multiplyScalar(((level(value) - (levels.length - 1) / 2) * size) / span),
    )
  } else offsets = centres.map((c) => c.clone().sub(centre))

  const pieces = nodes.map((node, i): Piece => {
    const parent = node.parent ?? file
    const toParent = new Matrix3().setFromMatrix4(
      new Matrix4().multiplyMatrices(inverse, parent.matrixWorld).invert(),
    )
    // A piece inside another moves with it.
    const outer: number[] = []
    for (let up = node.parent; up && up !== file; up = up.parent) {
      const index = nodes.indexOf(up)
      if (index >= 0) outer.push(index)
    }
    return { node, box: boxes[i] as Box3, offset: offsets[i] as Vector3, toParent, outer }
  })
  // What no piece moves: the bounds of each mesh outside every piece.
  const moving = new Set(nodes)
  const still: Box3[] = []
  const toFile = new Matrix4()
  file.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    for (let up: Object3D | null = mesh; up && up !== file; up = up.parent)
      if (moving.has(up)) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    if (box)
      still.push(box.clone().applyMatrix4(toFile.multiplyMatrices(inverse, mesh.matrixWorld)))
  })
  return { pieces, missing, whole, still }
}

/** `extras.explode` of a glTF node, which three's loader puts in userData. */
function extra(node: Object3D): [number, number, number] | undefined {
  const value = (node.userData as { explode?: unknown }).explode
  return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number')
    ? (value as [number, number, number])
    : undefined
}

/**
 * Bounds of the parts of the model with each piece moved by its own `moves` entry (file units)
 * and by those of the pieces it sits inside: what `contain` fits into the box.
 */
export function extent(
  pieces: readonly Piece[],
  still: readonly Box3[],
  moves: readonly Vector3[],
): Box3[] {
  const shift = new Vector3()
  return [
    ...still,
    ...pieces.map((piece, i) => {
      shift.copy(moves[i] as Vector3)
      for (const index of piece.outer) shift.add(moves[index] as Vector3)
      return piece.box.clone().translate(shift)
    }),
  ]
}

/**
 * An exploded view of the `model` on the same element: its parts move apart as the section
 * scrolls and come back on the way up.
 */
const explode: Effect<Params> = defineEffect({
  name: 'explode',
  params: {
    mode: oneOf('radial', 'axis', 'extras'),
    by: oneOf('pin', 'progress', 'manual'),
    pieces: '',
    axis: [0, 1, 0],
    spread: 1,
    start: 0,
    end: 1,
    position: 0,
    cascade: 0.3,
    twist: 0,
    ease: 0.15,
    contain: true,
  },
  rebuild: ['axis'],
  // The model leaves by dithering; nothing of its own fades.
  presence: 'custom',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { element, params, signal } = ctx
    const { mode, by, axis } = params
    const names = params.pieces
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    if (DEV) {
      const tokens = element.getAttribute('data-dio')?.split(/\s+/)
      if (tokens && !tokens.includes('model'))
        ctx.app.log.warn('explode works on a model of the same element: data-dio="model explode"')
    }

    let rig: Rig | undefined
    let pieces: Piece[] = []
    let rests: Vector3[] = []
    let moves: Vector3[] = []
    let still: Box3[] = []
    // The eased scrub 0..1; -1 until the first frame, which jumps to its goal.
    let scrub = -1
    const step = new Vector3()
    const unhook = (): void => {
      if (!rig) return
      pieces.forEach((piece, i) => {
        piece.node.position.copy(rests[i] as Vector3)
      })
      rig.scene.rotation.y = 0
      rig.contain(undefined)
      rig.invalidate()
      rig = undefined
      pieces = []
    }
    watchRig(
      element,
      (next) => {
        unhook()
        if (!next) return
        rig = next
        const found = layout(next.file, mode, names, axis)
        pieces = found.pieces
        still = found.still
        rests = pieces.map((piece) => piece.node.position.clone())
        moves = pieces.map(() => new Vector3())
        scrub = -1
        if (DEV && found.missing.length) {
          const all: string[] = []
          next.file.traverse((o) => {
            if (o !== next.file && o.name) all.push(o.name)
          })
          ctx.app.log.warn(
            `explode: no piece "${found.missing.join(', ')}" in the model. Nodes: ${all.join(', ')}`,
          )
        } else if (DEV && pieces.length < 2)
          ctx.app.log.warn(
            mode === 'extras'
              ? 'explode: no node of the model has extras.explode = [x, y, z]'
              : 'explode: the model has fewer than two parts to move; name them in data-dio-pieces',
          )
        ctx.invalidate()
      },
      signal,
    )
    ctx.onDispose(unhook)

    // Pieces start one after another, the farthest first.
    const order = (): number[] => {
      const ranked = pieces.map((piece, i) => [piece.offset.length(), i] as const)
      ranked.sort((a, b) => b[0] - a[0])
      const rank: number[] = []
      ranked.forEach(([, index], place) => {
        rank[index] = place
      })
      return rank
    }
    let ranks: number[] = []
    let rankedFor: Piece[] | undefined

    return (input): boolean => {
      // Without a model nothing eases, even if it left mid-way.
      if (!rig) return false
      const reduced = input.reducedMotion
      let goal: number
      if (by === 'manual') goal = params.position
      else if (reduced) goal = 1
      else {
        const progress = by === 'pin' ? ctx.section().pin : input.progress
        const span = params.end - params.start
        goal = span ? (progress - params.start) / span : progress < params.start ? 0 : 1
      }
      goal = Math.min(1, Math.max(0, goal))
      scrub = scrub < 0 || reduced ? goal : damp(scrub, goal, params.ease, input.delta, EPSILON)

      if (rankedFor !== pieces) {
        ranks = order()
        rankedFor = pieces
      }
      const spread = params.spread
      const cascade = Math.min(0.9, Math.max(0, params.cascade))
      const count = pieces.length
      pieces.forEach((piece, i) => {
        // Each piece moves over its own window of the scrub, later the lower it ranks.
        const delay = count > 1 ? (cascade * (ranks[i] as number)) / (count - 1) : 0
        const t = Math.min(1, Math.max(0, (scrub - delay) / (1 - cascade)))
        const amount = ease('cubicInOut', t) * spread
        const move = (moves[i] as Vector3).copy(piece.offset).multiplyScalar(amount)
        step.copy(move).applyMatrix3(piece.toParent)
        piece.node.position.copy(rests[i] as Vector3).add(step)
      })
      const eased = ease('cubicInOut', scrub)
      rig.scene.rotation.y = reduced ? 0 : params.twist * DEG * eased
      // Contained, the model shrinks as it opens so the parts stay in the box, centred in it.
      rig.contain(params.contain ? extent(pieces, still, moves) : undefined)
      return scrub !== goal
    }
  },
})
export default explode
