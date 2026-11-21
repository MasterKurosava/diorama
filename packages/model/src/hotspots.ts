// Annotated points on a `model`: DOM labels that follow their points as the model turns and hide
// behind it.
import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV } from '@dioramajs/effects/kit'
import { Matrix4, type Mesh, Object3D, Raycaster, Vector2, Vector3 } from 'three/webgpu'
import { bounds, find } from './parts'
import { type Rig, watchRig } from './rig'

type Params = {
  model: string
  occlude: ChoiceParam<'normal' | 'ray' | 'none'>
  face: boolean
}

/**
 * A label turns away below this cosine between its normal and the way to the viewer, and back
 * above the second. Slightly past the silhouette still counts as seen: a point on the top of a
 * product seen from the side keeps its label.
 */
const HIDE = -0.15
const SHOW = -0.05
/** A label on a node turns away once the node is this far behind the centre, in model sizes. */
const BACK = -0.3
/** Ray mode: points tested per drawn frame; the rest wait for the sweep once frames stop. */
const RAYS = 2
/** Ray mode: ms after the last frame before every point is tested. */
const SETTLE = 60
/** A point this deep under the surface still counts as on it, as a share of the model size. */
const DEPTH = 0.02

/** Where a hotspot sits: a point in the file's coordinates, or a node of the file by name. */
export type Spot = { readonly point: Vector3 } | { readonly node: string }

/** `data-dio-at`: "x y z" in the file's units, or a node name. */
export function parseAt(value: string): Spot | undefined {
  const text = value.trim()
  if (!text) return undefined
  const parts = text.split(/[\s,]+/)
  if (parts.length === 3 && parts.every((p) => p !== '' && Number.isFinite(Number(p))))
    return { point: new Vector3(...parts.map(Number)) }
  return { node: text }
}

/** "x y z" as a unit vector, undefined unless it is three finite numbers that are not all 0. */
function vector(value: string | null): Vector3 | undefined {
  const parts = value?.trim().split(/[\s,]+/) ?? []
  if (parts.length !== 3 || !parts.every((p) => p !== '' && Number.isFinite(Number(p))))
    return undefined
  const direction = new Vector3(...parts.map(Number))
  return direction.lengthSq() > 0 ? direction.normalize() : undefined
}

/**
 * The model's own yaw and pitch (radians) that turn the direction `d`, given in the model's space
 * before its rotation, towards the viewer: `pivot.rotation.set(pitch, yaw, 0)` brings it to +z.
 */
export function facing(d: Vector3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(-d.x, d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }
}

/**
 * The nearest ancestor that makes a stacking context whose own z-index does not beat `z`: the
 * labels' z-index cannot lift them out of it. Sticky stages are the usual one.
 */
function flattened(label: Element, z: number): Element | undefined {
  for (let up = label.parentElement; up && up !== document.body; up = up.parentElement) {
    const style = getComputedStyle(up)
    const positioned = style.position !== 'static' && style.position !== ''
    const stacks =
      style.position === 'fixed' ||
      style.position === 'sticky' ||
      (positioned && style.zIndex !== 'auto' && style.zIndex !== '') ||
      (style.transform !== 'none' && style.transform !== '') ||
      (style.filter !== 'none' && style.filter !== '') ||
      (style.opacity !== '' && Number(style.opacity) < 1) ||
      style.isolation === 'isolate'
    if (!stacks) continue
    const own = Number.parseInt(style.zIndex, 10)
    return own > z ? undefined : up
  }
  return undefined
}

/** A short selector-like name of an element for a warning. */
const describe = (e: Element): string =>
  e.id ? `#${e.id}` : e.classList.length ? `.${[...e.classList].join('.')}` : e.localName

/** A label and what the effect keeps about it between frames. */
interface Hotspot {
  readonly el: HTMLElement
  readonly spot: Spot
  /** Normal from `data-dio-normal`, in the file's space. */
  readonly normal: Vector3 | undefined
  anchor: Object3D | undefined
  /** The node a named label follows: its own meshes never hide it. */
  node: Object3D | undefined
  away: boolean
  transform: string
  opacity: string
  /** Where the callout goes: the side, how far out and how far up or down, as last written. */
  side: string
  reach: string
  shift: string
  /** Size of the label's card, px; undefined until measured. */
  card: { width: number; height: number } | undefined
}

/** A label to place a card for, in the host's px: its point, its card and where that goes. */
export interface Callout {
  x: number
  y: number
  width: number
  height: number
  /** Turned away: keeps its place, takes no room from the others. */
  away: boolean
  /** -1 left of the point, 1 right; 0 before the first layout. */
  side: number
  /** Horizontal px from the point to the near edge of the card. */
  reach: number
  /** Vertical px from the point to the middle of the card. */
  shift: number
}

/** Px between the model's edge and a card, the shortest leader, the host's margin, between cards. */
const GAP = 20
const LEADER = 24
const MARGIN = 8
const SPACE = 8
/** A label changes sides once its point is this share of the model's width past the middle. */
const SWAP = 0.06

/**
 * Lays out the cards of callouts on a model that spans `left` to `right` in a `width` × `height`
 * host: each on the side of the model its point is on, just past the model's edge but inside the
 * host, and on each side spread up and down so no two cards overlap.
 */
export function arrange(
  list: readonly Callout[],
  left: number,
  right: number,
  width: number,
  height: number,
): void {
  const middle = (left + right) / 2
  const band = (right - left) * SWAP
  // Each card on the side of its point, kept on its side within a band around the middle.
  for (const c of list) {
    let side = c.side || (c.x < middle ? -1 : 1)
    if (side > 0 && c.x < middle - band) side = -1
    else if (side < 0 && c.x > middle + band) side = 1
    // The farthest a card can go on a side and stay in the host, and where it would like to be.
    const room = (towards: number): number =>
      towards > 0 ? width - MARGIN - c.width - c.x : c.x - MARGIN - c.width
    const want = (towards: number): number =>
      Math.max(LEADER, towards > 0 ? right + GAP - c.x : c.x - left + GAP)
    if (room(side) < LEADER && room(-side) >= LEADER) side = -side
    c.side = side
    c.reach = Math.max(LEADER, Math.min(want(side), room(side)))
    c.shift = 0
  }
  for (const side of [-1, 1]) {
    const column = list.filter((c) => c.side === side && !c.away).sort((a, b) => a.y - b.y)
    const at: number[] = []
    // Down the column each card clears the one above, then up from the bottom edge of the host.
    let floor = Number.NEGATIVE_INFINITY
    for (const c of column) {
      const half = c.height / 2
      const y = Math.max(
        Math.min(Math.max(c.y, MARGIN + half), height - MARGIN - half),
        floor + half,
      )
      at.push(y)
      floor = y + half + SPACE
    }
    let ceiling = height - MARGIN
    for (let i = column.length - 1; i >= 0; i--) {
      const c = column[i] as Callout
      const half = c.height / 2
      const y = Math.min(at[i] as number, ceiling - half)
      ceiling = y - half - SPACE
      c.shift = y - c.y
    }
  }
}

/** Inline styles the effect writes on labels and the element, to give back on dispose. */
const STYLES = [
  'position',
  'left',
  'top',
  'zIndex',
  'transform',
  'opacity',
  'pointerEvents',
] as const

/**
 * Annotated points on a `model`: the `[data-dio-at]` children of the element follow their points
 * as the model inside it turns, turn away with the back of the model and stay real, focusable
 * DOM. It goes on a parent of the model element, because a drawn model element hides its children.
 */
const hotspots: Effect<Params> = defineEffect({
  name: 'hotspots',
  params: {
    model: '',
    occlude: oneOf('normal', 'ray', 'none'),
    face: true,
  },
  // Labels fade with the page themselves; the model leaves by dithering.
  presence: 'custom',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { element, params, signal } = ctx
    const el = element as HTMLElement
    const occlude = params.occlude
    const target = params.model
      ? (el.querySelector(params.model) ?? document.querySelector(params.model))
      : el.querySelector('[data-dio~="model"]')
    const list: Hotspot[] = []
    for (const label of el.querySelectorAll<HTMLElement>('[data-dio-at]')) {
      // A label inside the model element would be hidden with it.
      if (target?.contains(label)) continue
      const spot = parseAt(label.getAttribute('data-dio-at') ?? '')
      if (!spot) continue
      const normal = vector(label.getAttribute('data-dio-normal'))
      list.push({
        el: label,
        spot,
        normal,
        anchor: undefined,
        node: undefined,
        away: false,
        transform: '',
        opacity: '',
        side: '',
        reach: '',
        shift: '',
        card: undefined,
      })
    }
    if (DEV) {
      if (!target)
        ctx.app.log.warn(
          params.model
            ? `hotspots: no model element "${params.model}"`
            : 'hotspots: no model inside; put data-dio="hotspots" on a parent of the data-dio="model" element',
        )
      else if (target.querySelector('[data-dio-at]'))
        ctx.app.log.warn(
          'hotspots: labels inside the model element are hidden with it; put them next to it',
        )
      if (!list.length)
        ctx.app.log.warn('hotspots: no children with data-dio-at="x y z" or a node name')
    }

    // The labels leave the flow only once the model draws them in place.
    const saved = new Map<HTMLElement, string[]>()
    const save = (node: HTMLElement): void => {
      if (!saved.has(node))
        saved.set(
          node,
          STYLES.map((key) => node.style[key]),
        )
    }
    let placed = false
    const place = (): void => {
      if (placed) return
      placed = true
      const position = getComputedStyle(el).position
      if (!position || position === 'static') {
        save(el)
        el.style.position = 'relative'
      }
      // Over a canvas that covers the page, the labels go above it, unless the page lifts them.
      const canvas = Number.parseInt(getComputedStyle(ctx.render.renderer.domElement).zIndex, 10)
      for (const h of list) {
        save(h.el)
        h.el.style.position = 'absolute'
        h.el.style.left = '0'
        h.el.style.top = '0'
        const own = Number.parseInt(getComputedStyle(h.el).zIndex, 10)
        if (canvas >= 0 && !(own > canvas)) h.el.style.zIndex = String(canvas + 1)
      }
      const first = list[0]
      if (DEV && first && canvas >= 0) {
        const below = flattened(first.el, canvas)
        if (below)
          ctx.app.log.warn(
            `hotspots: the labels sit in a stacking context below the canvas (z-index ${canvas}), so the model covers them. Give ${describe(below)} a z-index above ${canvas}.`,
          )
      }
    }
    const restore = (): void => {
      for (const [node, values] of saved)
        STYLES.forEach((key, i) => {
          node.style[key] = values[i] as string
        })
      saved.clear()
      for (const h of list) {
        h.el.removeAttribute('data-dio-away')
        h.el.removeAttribute('data-dio-side')
        h.el.style.removeProperty('--dio-reach')
        h.el.style.removeProperty('--dio-shift')
        h.transform = ''
        h.opacity = ''
        h.side = h.reach = h.shift = ''
        h.away = false
      }
      callouts.length = 0
      placed = false
    }

    let rig: Rig | undefined
    /** The model's meshes: the cards keep clear of their bounds on screen. */
    const meshes: Mesh[] = []
    const unhook = (): void => {
      for (const h of list) {
        h.anchor?.removeFromParent()
        h.anchor = undefined
        h.node = undefined
      }
      meshes.length = 0
      rig = undefined
    }
    if (target)
      watchRig(
        target,
        (next) => {
          unhook()
          if (!next) return
          rig = next
          const { file } = next
          file.updateWorldMatrix(true, true)
          file.traverse((o) => {
            const mesh = o as Mesh
            if (!mesh.isMesh || !mesh.geometry) return
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
            meshes.push(mesh)
          })
          const missing: string[] = []
          for (const h of list) {
            const anchor = new Object3D()
            anchor.name = 'hotspot'
            if ('point' in h.spot) {
              anchor.position.copy(h.spot.point)
              file.add(anchor)
            } else {
              const node = find(file, h.spot.node)
              if (!node) {
                missing.push(h.spot.node)
                continue
              }
              // The centre of the node's meshes, so the point moves with the part.
              const box = bounds(node, new Matrix4().copy(node.matrixWorld).invert())
              if (!box.isEmpty()) box.getCenter(anchor.position)
              node.add(anchor)
              h.node = node
            }
            h.anchor = anchor
          }
          if (DEV && missing.length) {
            const all: string[] = []
            file.traverse((o) => {
              if (o !== file && o.name) all.push(o.name)
            })
            ctx.app.log.warn(
              `hotspots: no node "${missing.join(', ')}" in the model. Nodes: ${all.join(', ')}`,
            )
          }
          ctx.invalidate()
        },
        signal,
      )
    ctx.onDispose(() => {
      unhook()
      restore()
    })

    // Where the camera sees points, in the element's px.
    const camera = ctx.render.camera
    const eye = new Vector3()
    const point = new Vector3()
    const direction = new Vector3()
    const rootAt = new Vector3()
    const offset = new Vector3()
    const centre = new Vector3()
    const forward = new Vector3()
    const scale = new Vector3()
    const toPivot = new Matrix4()
    const ray = new Raycaster()
    const hits: unknown[] = []
    const corner = new Vector3()

    // Callouts: the card of a label is its last element, or the label itself. Its size is read
    // once and then on resize, never per frame.
    const callouts: Callout[] = []
    const cardOf = (h: Hotspot): Element => h.el.lastElementChild ?? h.el
    const cards =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            for (const entry of entries) {
              const h = list.find((spot) => cardOf(spot) === entry.target)
              const size = entry.borderBoxSize?.[0]
              if (!h || !size) continue
              h.card = { width: size.inlineSize, height: size.blockSize }
            }
            dirty = true
            ctx.invalidate()
          })
        : undefined
    for (const h of list) cards?.observe(cardOf(h))
    ctx.onDispose(() => cards?.disconnect())
    const cardSize = (h: Hotspot): { width: number; height: number } => {
      if (!h.card) {
        const rect = cardOf(h).getBoundingClientRect()
        h.card = { width: rect.width, height: rect.height }
      }
      return h.card
    }
    /** Writes where each card goes, from the model's extent on screen this frame. */
    const lay = (rootX: number, halfWidth: number, centreX: number): void => {
      if (!rig) return
      let modelLeft = Number.POSITIVE_INFINITY
      let modelRight = Number.NEGATIVE_INFINITY
      for (const mesh of meshes) {
        const bounds = mesh.geometry.boundingBox
        if (!bounds || bounds.isEmpty()) continue
        for (let i = 0; i < 8; i++) {
          const { min, max } = bounds
          corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
          corner.applyMatrix4(mesh.matrixWorld).project(camera)
          const x = (corner.x - rootX) * halfWidth + centreX
          if (x < modelLeft) modelLeft = x
          if (x > modelRight) modelRight = x
        }
      }
      if (!(modelRight > modelLeft)) return
      arrange(
        callouts.filter((c) => c !== undefined),
        modelLeft,
        modelRight,
        width,
        height,
      )
      list.forEach((h, i) => {
        const c = callouts[i]
        if (!c || !h.anchor) return
        // Written as data attributes and CSS variables for the page's own styles.
        const side = c.side < 0 ? 'left' : 'right'
        if (side !== h.side) {
          h.side = side
          h.el.setAttribute('data-dio-side', side)
        }
        const reach = `${Math.round(c.reach)}px`
        if (reach !== h.reach) {
          h.reach = reach
          h.el.style.setProperty('--dio-reach', reach)
        }
        const shift = `${Math.round(c.shift)}px`
        if (shift !== h.shift) {
          h.shift = shift
          h.el.style.setProperty('--dio-shift', shift)
        }
      })
    }
    /** Offset of the labels' containing block from the element's box, read on resize. */
    const origin = new Map<Element | null, { x: number; y: number }>()
    const originOf = (h: Hotspot): { x: number; y: number } => {
      const parent = h.el.offsetParent
      let at = origin.get(parent)
      if (!at) {
        const box = el.getBoundingClientRect()
        const holder = parent instanceof HTMLElement && el.contains(parent) ? parent : el
        const own = holder.getBoundingClientRect()
        at = { x: own.left + holder.clientLeft - box.left, y: own.top + holder.clientTop - box.top }
        origin.set(parent, at)
      }
      return at
    }

    /** True when the model hides the point from the camera. */
    const blocked = (h: Hotspot): boolean => {
      if (!rig || !h.anchor) return false
      point.setFromMatrixPosition(h.anchor.matrixWorld)
      const distance = eye.distanceTo(point)
      // The pivot's scale is the model's largest side in px.
      rig.pivot.getWorldScale(scale)
      ray.set(eye, direction.copy(point).sub(eye).normalize())
      ray.far = Math.max(0, distance - DEPTH * scale.x)
      hits.length = 0
      ray.intersectObject(rig.scene, true, hits as never)
      const { node } = h
      return (hits as { object: Object3D }[]).some((hit) => {
        for (let up: Object3D | null = hit.object; up; up = up.parent) if (up === node) return false
        return true
      })
    }

    let presence = 1
    const show = (h: Hotspot, away: boolean): void => {
      if (away !== h.away) {
        h.away = away
        h.el.toggleAttribute('data-dio-away', away)
        h.el.style.pointerEvents = away ? 'none' : ''
      }
      // A focused label stays visible, so the focus ring is never lost behind the model.
      const visible = !away || h.el === document.activeElement ? presence : 0
      const opacity = visible >= 1 ? '' : String(Math.round(visible * 1000) / 1000)
      if (opacity !== h.opacity) {
        h.opacity = opacity
        h.el.style.opacity = opacity
      }
    }

    // Ray mode tests a few labels a frame, from `firstRay` on, and all of them once frames stop.
    let firstRay = 0
    let sweepTimer: ReturnType<typeof setTimeout> | undefined
    ctx.onDispose(() => clearTimeout(sweepTimer))
    const sweep = (): void => {
      sweepTimer = undefined
      if (!rig) return
      rig.scene.updateWorldMatrix(true, true)
      for (const h of list) if (h.anchor) show(h, blocked(h))
    }

    let dirty = false
    let left = 0
    let top = 0
    let width = -1
    let height = -1
    const project = (): void => {
      if (!dirty || !rig) return
      dirty = false
      place()
      // Half the viewport in px: projected coordinates -1..1 to px.
      const half = ctx.render.toWorld(0, 0)
      const halfWidth = -half.x
      const halfHeight = half.y
      camera.updateMatrixWorld()
      eye.setFromMatrixPosition(camera.matrixWorld)
      rig.root.updateWorldMatrix(true, false)
      rootAt.setFromMatrixPosition(rig.root.matrixWorld).project(camera)
      rig.pivot.updateWorldMatrix(true, false)
      centre.setFromMatrixPosition(rig.pivot.matrixWorld)
      camera.getWorldDirection(forward).negate()
      // The pivot's scale is the model's largest side in px.
      const size = rig.pivot.getWorldScale(scale).x || 1
      // The model's box centre in this element's px: both boxes are this frame's.
      const { box, file } = rig
      const centreX = box.x + box.width / 2 - left
      const centreY = box.y + box.height / 2 - top
      let rays = occlude === 'ray' ? RAYS : 0
      // Ray tests and callouts read every mesh's matrix: fresh after a real render, not after a
      // test one.
      rig.scene.updateWorldMatrix(true, true)
      for (let i = 0; i < list.length; i++) {
        const index = (firstRay + i) % list.length
        const h = list[index] as Hotspot
        if (!h.anchor) continue
        h.anchor.updateWorldMatrix(true, false)
        point.setFromMatrixPosition(h.anchor.matrixWorld)
        let away = h.away
        if (h.normal && occlude !== 'none') {
          direction.copy(h.normal).transformDirection(file.matrixWorld)
          away = direction.dot(offset.copy(eye).sub(point).normalize()) < (h.away ? SHOW : HIDE)
        } else if (occlude === 'normal' && h.node) {
          // A part may stick out anywhere once exploded: it hides only well behind the centre.
          const depth = offset.copy(point).sub(centre).dot(forward) / size
          away = depth < (h.away ? BACK + 0.1 : BACK)
        } else if (occlude === 'normal') {
          direction.copy(point).sub(centre).normalize()
          away = direction.dot(offset.copy(eye).sub(point).normalize()) < (h.away ? SHOW : HIDE)
        }
        if (occlude === 'ray' && !away && rays > 0) {
          rays--
          away = blocked(h)
          point.setFromMatrixPosition(h.anchor.matrixWorld)
        } else if (occlude === 'none') away = false
        show(h, away)
        point.project(camera)
        const at = originOf(h)
        const x = (point.x - rootAt.x) * halfWidth + centreX - at.x
        const y = (rootAt.y - point.y) * halfHeight + centreY - at.y
        const transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`
        if (transform !== h.transform) {
          h.transform = transform
          h.el.style.transform = transform
        }
        const card = cardSize(h)
        const callout = callouts[index]
        if (callout) {
          callout.x = x + at.x
          callout.y = y + at.y
          callout.width = card.width
          callout.height = card.height
          callout.away = h.away
        } else
          callouts[index] = {
            x: x + at.x,
            y: y + at.y,
            ...card,
            away: h.away,
            side: 0,
            reach: 0,
            shift: 0,
          }
      }
      lay(rootAt.x, halfWidth, centreX)
      if (occlude === 'ray' && list.length) {
        firstRay = (firstRay + RAYS) % list.length
        clearTimeout(sweepTimer)
        sweepTimer = setTimeout(sweep, SETTLE)
      }
    }
    // After the frame is drawn every matrix is final, whatever order the effects updated in.
    ctx.app.system('afterRender', project, { name: 'hotspots' })

    const turn = (label: HTMLElement): void => {
      const h = list.find((spot) => spot.el === label)
      if (!rig || !h?.anchor) return
      const { pivot, file } = rig
      pivot.updateWorldMatrix(true, false)
      h.anchor.updateWorldMatrix(true, false)
      toPivot.copy(pivot.matrixWorld).invert()
      // The label's normal, or the way from the centre to its point, in the pivot's space.
      const towards = h.normal
        ? direction.copy(h.normal).transformDirection(toPivot.multiply(file.matrixWorld))
        : direction.setFromMatrixPosition(h.anchor.matrixWorld).applyMatrix4(toPivot)
      if (towards.lengthSq() < 1e-12) return
      const { yaw, pitch } = facing(towards)
      rig.face(yaw, pitch)
    }
    el.addEventListener(
      'focusin',
      (e) => {
        const label = (e.target as Element | null)?.closest?.('[data-dio-at]')
        if (!(label instanceof HTMLElement) || !el.contains(label)) return
        if (params.face) turn(label)
        dirty = true
        ctx.invalidate()
      },
      { signal },
    )
    el.addEventListener(
      'focusout',
      () => {
        dirty = true
        ctx.invalidate()
      },
      { signal },
    )

    // Dev aid: Alt+click on the model logs the point under the pointer as data-dio-at.
    if (DEV && target)
      target.addEventListener(
        'click',
        (e) => {
          const { altKey, clientX, clientY } = e as MouseEvent
          if (!altKey || !rig) return
          const half = ctx.render.toWorld(0, 0)
          ray.setFromCamera(new Vector2(clientX / -half.x - 1, 1 - clientY / half.y), camera)
          ray.far = Number.POSITIVE_INFINITY
          rig.scene.updateWorldMatrix(true, true)
          const [hit] = ray.intersectObject(rig.scene, true)
          if (!hit) return
          const xyz = rig.file
            .worldToLocal(hit.point.clone())
            .toArray()
            .map((value) => Number(value.toFixed(3)))
            .join(' ')
          ctx.app.log.warn(`hotspots: data-dio-at="${xyz}" (on ${hit.object.name || 'a mesh'})`)
        },
        { signal },
      )

    return (input) => {
      if (input.width !== width || input.height !== height) {
        width = input.width
        height = input.height
        origin.clear()
      }
      left = input.x
      top = input.y
      presence = input.presence
      dirty = true
    }
  },
})
export default hotspots
