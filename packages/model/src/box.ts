// A product box built from pictures of its faces, which turns, leans toward the pointer and opens.
import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  cameraPosition,
  clamp,
  dot,
  float,
  frontFacing,
  max,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  select,
  texture,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DoubleSide,
  FrontSide,
  Group,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type Texture,
} from 'three/webgpu'
import {
  dissolve,
  type Edge,
  edgeColor,
  isUrl,
  Pointer,
  sharpen,
  shadow as softShadow,
} from './studio'

export { edgeColor }

export type Motion = 'none' | 'flap' | 'lift' | 'drawer'
type Params = {
  motion: ChoiceParam<Motion>
  back: string
  left: string
  right: string
  top: string
  bottom: string
  inside: string
  depth: 'auto'
  yaw: number
  pitch: number
  swing: number
  open: number
  tilt: number
  spin: number
  drag: boolean
  shadow: number
}
type V3 = Node<'vec3'>
type FaceName = 'front' | 'back' | Edge

const TAU = Math.PI * 2
const DEG = Math.PI / 180
/** Arrow key steps: a turn and a tilt. */
const STEP = Math.PI / 4
const TIP = Math.PI / 6
/** Pitch limit of a drag or the keys. */
const PITCH = 80 * DEG
/** The box leans its top toward the viewer as it opens, so the inside shows. */
const LEAN = 28 * DEG
/** Full openings: the flap's angle, the lid's rise in box heights, the tray's slide in widths. */
const FLAP = 110 * DEG
const RISE = 0.55
const SLIDE = 0.62
/** Share of the height a lift-off lid covers. */
const LID = 0.22
/** Board thickness in box heights: the lid's overlap and the tray's inset. */
const BOARD = 0.006
/** Depth without a side picture or a depth param, in front widths. */
const DEPTH = 0.3
/** Seconds the idle spin waits after the last touch of the box. */
const QUIET = 1.5
/** Light from the upper left in front, in world space. */
const LIGHT = [-0.45, 0.55, 0.7] as const
const LIGHT_LENGTH = Math.hypot(...LIGHT)
/** Brightness of a face turned away from the light. */
const AMBIENT = 0.55
/** Bare board inside a box. */
const BOARD_COLOR = '#ebe5d8'
/** A quarter turn, the angle between neighbouring faces. */
const QUARTER = Math.PI / 2
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Half-lives, s: of the hover, the lid, the pointer tilt, an arrow key step and the coast. */
const HOVER_HALF_LIFE = 0.16
const LID_HALF_LIFE = 0.22
const TILT_HALF_LIFE = 0.12
const KEY_HALF_LIFE = 0.08
const COAST_HALF_LIFE = 0.35
/** A drag held still this long before letting go does not coast, ms. */
const COAST_HOLD = 80
/** Fastest coast after a drag, radians per second. */
const COAST_MAX = TAU * 2
/** Coasting stops below this speed, radians per second. */
const COAST_STOP = 0.02
/** A press that moved further than this, px, is a drag and not a click. */
const TAP_SLOP = 4
/** Below this a motion counts as settled. */
const EPSILON = 1e-4

/**
 * Depth of the box in front heights for a front `aspect` (width over height): `depth` times the
 * width when a number (0 is a flat card), else from the aspect of a side picture (its width is the
 * depth), else of a top one (its height is the depth), else a third of the width.
 */
export function depthOf(
  depth: number | 'auto',
  aspect: number,
  side?: readonly [number, number],
  top?: readonly [number, number],
): number {
  if (depth !== 'auto') return Math.min(4, Math.max(0, depth)) * aspect
  if (side && side[0] > 0 && side[1] > 0) return side[0] / side[1]
  if (top && top[0] > 0 && top[1] > 0) return (top[1] / top[0]) * aspect
  return DEPTH * aspect
}

/**
 * Colour lit by a light from the upper left: a face toward the viewer keeps the picture's own
 * colour, faces turned away darken, and a glossy one catches a highlight as it turns.
 */
function shaded(base: V3, gloss = 0): Node {
  const n = normalize(normalWorld)
  const light = vec3(LIGHT[0] / LIGHT_LENGTH, LIGHT[1] / LIGHT_LENGTH, LIGHT[2] / LIGHT_LENGTH)
  // Diffuse light relative to a face toward the viewer, so that face gets exactly 1.
  const lambert = clamp(dot(n, light).div(LIGHT[2] / LIGHT_LENGTH), 0, 1.06)
  let lit = base.mul(mix(float(AMBIENT), float(1), lambert)) as unknown as V3
  if (gloss > 0) {
    const view = normalize(cameraPosition.sub(positionWorld))
    const half = normalize(light.add(view))
    lit = lit.add(pow(max(dot(n, half), 0), 60).mul(gloss)) as unknown as V3
  }
  return vec4(lit, 1)
}

/** A `width` × `height` plane facing +z whose UV covers `[u0, v0, u1, v1]` of its picture. */
function quad(width: number, height: number, rect = [0, 0, 1, 1]): PlaneGeometry {
  const plane = new PlaneGeometry(width, height)
  const [u0, v0, u1, v1] = rect as [number, number, number, number]
  const uvs = plane.getAttribute('uv')
  for (let i = 0; i < uvs.count; i++)
    uvs.setXY(i, u0 + uvs.getX(i) * (u1 - u0), v0 + uvs.getY(i) * (v1 - v0))
  return plane
}

/** A built box: the front face at z = 0, centred in x and y, one unit tall. */
export interface Built {
  readonly group: Group
  /** Hinge of the flap, the lid or the tray, as the motion has it. */
  readonly part?: Group
  readonly width: number
  readonly depth: number
}

/**
 * The box of a `width` × 1 front and `depth`, its faces in `faces`, bare board in `inside`.
 * flap: the top on a hinge at its back edge; lift: a lid over the top `LID` of the box; drawer:
 * a sleeve with a tray that slides out to the right.
 */
export function build(
  width: number,
  depth: number,
  motion: Motion,
  faces: Readonly<Record<FaceName, Material>>,
  inside: Material,
): Built {
  const w = Math.max(0.05, width)
  const d = Math.max(0.01, depth)
  const group = new Group()
  const add = (
    parent: Group,
    geometry: PlaneGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
  ): Mesh => {
    const mesh = new Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.rotation.set(rx, ry, 0)
    parent.add(mesh)
    return mesh
  }
  let hinge: Group | undefined
  if (motion === 'lift') {
    // The body below the lid shows the lower part of each picture; above it, bare board.
    const bodyHeight = 1 - LID
    const bodyY = -LID / 2
    const rimY = 0.5 - LID / 2
    const lower = [0, 0, 1, bodyHeight]
    add(group, quad(w, bodyHeight, lower), faces.front, 0, bodyY, 0)
    add(group, quad(w, bodyHeight, lower), faces.back, 0, bodyY, -d, 0, Math.PI)
    add(group, quad(d, bodyHeight, lower), faces.right, w / 2, bodyY, -d / 2, 0, QUARTER)
    add(group, quad(d, bodyHeight, lower), faces.left, -w / 2, bodyY, -d / 2, 0, -QUARTER)
    add(group, quad(w, LID), inside, 0, rimY, 0)
    add(group, quad(w, LID), inside, 0, rimY, -d, 0, Math.PI)
    add(group, quad(d, LID), inside, w / 2, rimY, -d / 2, 0, QUARTER)
    add(group, quad(d, LID), inside, -w / 2, rimY, -d / 2, 0, -QUARTER)
    add(group, quad(w, d), faces.bottom, 0, -0.5, -d / 2, QUARTER)
    // The lid turns about its back top edge, a board thick over the body.
    const b = BOARD
    hinge = new Group()
    hinge.position.set(0, 0.5 + b, -d - b)
    const upper = [0, bodyHeight, 1, 1]
    // The skirt reaches down to the body, over the board of the lid's own thickness.
    const skirt = LID + b
    const skirtY = -skirt / 2
    const lidZ = d / 2 + b
    add(hinge, quad(w + 2 * b, d + 2 * b), faces.top, 0, 0, lidZ, -QUARTER)
    add(hinge, quad(w + 2 * b, skirt, upper), faces.front, 0, skirtY, d + 2 * b)
    add(hinge, quad(w + 2 * b, skirt, upper), faces.back, 0, skirtY, 0, 0, Math.PI)
    add(hinge, quad(d + 2 * b, skirt, upper), faces.right, w / 2 + b, skirtY, lidZ, 0, QUARTER)
    add(hinge, quad(d + 2 * b, skirt, upper), faces.left, -w / 2 - b, skirtY, lidZ, 0, -QUARTER)
    group.add(hinge)
  } else {
    add(group, quad(w, 1), faces.front, 0, 0, 0)
    add(group, quad(w, 1), faces.back, 0, 0, -d, 0, Math.PI)
    add(group, quad(w, d), faces.bottom, 0, -0.5, -d / 2, QUARTER)
    if (motion === 'flap') {
      hinge = new Group()
      hinge.position.set(0, 0.5, -d)
      add(hinge, quad(w, d), faces.top, 0, 0, d / 2, -QUARTER)
      group.add(hinge)
    } else add(group, quad(w, d), faces.top, 0, 0.5, -d / 2, -QUARTER)
    if (motion === 'drawer') {
      // The tray: its ends are the box's sides, its walls and floor bare board inside the sleeve.
      hinge = new Group()
      const b = BOARD
      const trayWidth = w - 2 * b
      const trayHeight = 1 - 2 * b
      const trayDepth = d - 2 * b
      add(hinge, quad(trayWidth, trayDepth), inside, 0, -trayHeight / 2, -d / 2, -QUARTER)
      add(hinge, quad(trayWidth, trayHeight), inside, 0, 0, -b)
      add(hinge, quad(trayWidth, trayHeight), inside, 0, 0, -d + b, 0, Math.PI)
      add(hinge, quad(d, 1), faces.right, w / 2, 0, -d / 2, 0, QUARTER)
      add(hinge, quad(d, 1), faces.left, -w / 2, 0, -d / 2, 0, -QUARTER)
      group.add(hinge)
    } else {
      add(group, quad(d, 1), faces.right, w / 2, 0, -d / 2, 0, QUARTER)
      add(group, quad(d, 1), faces.left, -w / 2, 0, -d / 2, 0, -QUARTER)
    }
  }
  // Turns about the middle of its depth.
  group.position.z = d / 2
  return { group, part: hinge, width: w, depth: d }
}

/**
 * A product box from pictures of its faces: the front image becomes a 3D package with real
 * proportions that turns under a drag, leans toward the pointer and can open its lid.
 */
const box: Effect<Params> = defineEffect({
  name: 'box',
  params: {
    motion: oneOf('none', 'flap', 'lift', 'drawer'),
    back: '',
    left: '',
    right: '',
    top: '',
    bottom: '',
    inside: '',
    depth: 'auto',
    yaw: 0,
    pitch: 0,
    swing: 30,
    open: 0.6,
    tilt: 5.7,
    spin: 0,
    drag: true,
    shadow: 0.5,
  },
  rebuild: ['back', 'left', 'right', 'top', 'bottom', 'inside'],
  media: true,
  bleed: 160,
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, element, params } = ctx
    const el = element as HTMLElement
    const motion = params.motion
    const opens = motion !== 'none'
    const mask = dissolve(u)
    sharpen(ctx.map, ctx.render.renderer)

    // Each face: a picture, a colour, or what the other faces suggest.
    const picture = async (value: string): Promise<Texture | undefined> => {
      if (!value || !isUrl(value)) return undefined
      try {
        const map = await ctx.texture(value)
        sharpen(map, ctx.render.renderer)
        return map
      } catch (error) {
        if (signal.aborted) throw error
        ctx.app.log.warn(`box: ${value} did not load, a plain color shows instead`, error)
        return undefined
      }
    }
    const names = ['back', 'left', 'right', 'top', 'bottom'] as const
    const maps = Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await picture(params[n])] as const)),
    ) as Record<(typeof names)[number], Texture | undefined>
    const colorOf = (value: string): Color | undefined => {
      const css = value && !isUrl(value) ? cssColor(value, element) : undefined
      return css ? new Color().setStyle(css) : undefined
    }
    const fallback = new Color(0x2b2b2e)
    const edge = (side: Edge): Color =>
      colorOf(params[side]) ?? edgeColor(ctx.map.image, side) ?? fallback

    const make = (colour: Node): Material => {
      const material = new MeshBasicNodeMaterial()
      material.colorNode = colour as Node<'vec4'>
      material.maskNode = mask
      // An opening box shows the backs of its walls: bare board.
      material.side = opens ? DoubleSide : FrontSide
      return material
    }
    const board = colorOf(params.inside) ?? new Color().setStyle(BOARD_COLOR)
    const bare = vec3(board.r, board.g, board.b).mul(0.9) as unknown as V3
    const face = (base: V3, gloss: number): Material =>
      make(opens ? select(frontFacing, shaded(base, gloss), shaded(bare)) : shaded(base, gloss))
    const pictured = (map: Texture): Material =>
      face(texture(map, clamp(uv(), 0, 1)).rgb as unknown as V3, 0.08)
    const plain = (c: Color): Material => face(vec3(c.r, c.g, c.b) as unknown as V3, 0.05)
    const front = face(texture(ctx.map, clamp(ctx.coverUV(uv()), 0, 1)).rgb as unknown as V3, 0.08)
    const side = (own: Edge, other: Edge): Material => {
      const map = maps[own] ?? maps[other]
      return map ? pictured(map) : plain(edge(own))
    }
    // Without a back of its own the box carries the front print on both sides.
    const backColor = colorOf(params.back)
    const faces: Record<FaceName, Material> = {
      front,
      back: maps.back ? pictured(maps.back) : backColor ? plain(backColor) : front,
      left: side('left', 'right'),
      right: side('right', 'left'),
      top: side('top', 'bottom'),
      bottom: side('bottom', 'top'),
    }
    const inside = make(shaded(bare))
    const materials = [...new Set([...Object.values(faces), inside])]
    ctx.onDispose(() => {
      for (const material of materials) material.dispose()
    })

    const size = (map?: Texture): [number, number] | undefined => {
      const image = map?.image as { width?: number; height?: number } | undefined
      return image?.width && image.height ? [image.width, image.height] : undefined
    }
    const sidePicture = size(maps.right ?? maps.left)
    const topPicture = size(maps.top ?? maps.bottom)

    const root = new Group()
    const pivot = new Group()
    root.add(pivot)
    ctx.place(root, { fit: 'none', replace: true })
    const shade = softShadow(u)
    ctx.place(shade.mesh, { fit: 'none' })

    const aspectOf = (): number => {
      const { width, height } = ctx.input
      if (width > 0 && height > 0) return width / height
      const img = element as HTMLImageElement
      return (img.naturalWidth || 3) / (img.naturalHeight || 4)
    }
    let built: Built & { aspect: number; param: number | 'auto' }
    const buildBox = (aspect: number, depth: number | 'auto'): void => {
      const boxDepth = depthOf(depth, aspect, sidePicture, topPicture)
      const next = build(aspect, boxDepth, motion, faces, inside)
      pivot.position.z = -next.depth / 2
      pivot.add(next.group)
      built = { ...next, aspect, param: depth }
    }
    buildBox(aspectOf(), params.depth)
    await ctx.compile(root)
    if (signal.aborted) return

    // Drag turns it with a little inertia and leaves it there; arrow keys step it.
    let yaw = 0
    let pitch = 0
    let velocity = 0
    let keyYaw = 0
    let keyPitch = 0
    let held = false
    let quiet = 0
    let grab:
      | { id: number; x: number; y: number; t: number; tilt: boolean; moved: number }
      | undefined
    let dragged = false
    const touchAction = (): string => getComputedStyle(el).touchAction
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, fn, { signal })
    listen('pointerdown', (e) => {
      if (grab || !ctx.params.drag || e.button !== 0) return
      const action = touchAction()
      const mouse = e.pointerType !== 'touch'
      const free = action === 'none'
      if (!mouse && !free && !(action.includes('pan-y') && !action.includes('pan-x'))) return
      grab = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        tilt: mouse || free,
        moved: 0,
      }
      dragged = false
      velocity = 0
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
      if (mouse) e.preventDefault()
    })
    listen('pointermove', (e) => {
      if (e.pointerId !== grab?.id) return
      const span = Math.max(1, ctx.input.width)
      const dx = ((e.clientX - grab.x) * Math.PI) / span
      const dy = grab.tilt ? ((e.clientY - grab.y) * Math.PI) / Math.max(1, ctx.input.height) : 0
      const seconds = Math.max(1, e.timeStamp - grab.t) / 1000
      // The release speed is smoothed over the last few moves.
      velocity = velocity * 0.2 + (dx / seconds) * 0.8
      yaw += dx
      pitch = Math.max(-PITCH, Math.min(PITCH, pitch + dy))
      const moved = grab.moved + Math.hypot(e.clientX - grab.x, e.clientY - grab.y)
      if (moved > TAP_SLOP) dragged = true
      grab = { ...grab, x: e.clientX, y: e.clientY, t: e.timeStamp, moved }
      ctx.invalidate()
    })
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== grab?.id) return
      // Held still before letting go, cancelled by a scroll, or no motion wanted: no coasting.
      if (e.type !== 'pointerup' || e.timeStamp - grab.t > COAST_HOLD || ctx.input.reducedMotion)
        velocity = 0
      velocity = Math.min(COAST_MAX, Math.max(-COAST_MAX, velocity))
      grab = undefined
      ctx.invalidate()
    }
    listen('pointerup', release)
    listen('pointercancel', release)
    listen('dragstart', (e) => e.preventDefault())
    // A click or Enter opens the box and closes it again; links keep their clicks.
    const toggle = (): void => {
      if (!opens || ctx.params.open <= 0) return
      held = !held
      ctx.invalidate()
    }
    listen('click', () => {
      if (!dragged && !el.closest('a[href], button')) toggle()
      dragged = false
    })
    listen('keydown', (e) => {
      if (!el.hasAttribute('tabindex')) return
      if ((e.key === 'Enter' || e.key === ' ') && opens && ctx.params.open > 0) {
        e.preventDefault()
        toggle()
        return
      }
      if (!ctx.params.drag) return
      const x = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      const y = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
      if (!x && !y) return
      e.preventDefault()
      keyYaw += x * STEP
      keyPitch += y * TIP
      ctx.invalidate()
    })
    const pointer = new Pointer(element, signal, () => ctx.invalidate(), true)
    const hoverable = matchMedia('(hover: hover)').matches

    // Hover and lid run 0..1 and ease toward their goals.
    let hover = 0
    let lid = 0
    let tiltX = 0
    let tiltY = 0
    let spun = 0
    return (now): boolean => {
      const p = ctx.params
      const reduced = now.reducedMotion
      const aspect = now.width > 0 && now.height > 0 ? now.width / now.height : built.aspect
      if (Math.abs(aspect - built.aspect) > built.aspect * 0.01 || p.depth !== built.param) {
        pivot.remove(built.group)
        built.group.traverse((o) => (o as Mesh).geometry?.dispose())
        buildBox(aspect, p.depth)
      }
      const aim = hoverable && !reduced ? pointer.aim(now) : undefined
      const near = !reduced && (aim !== undefined || pointer.focused)
      const hoverGoal = near ? 1 : 0
      const lidGoal = opens && p.open > 0 ? (held ? 1 : near ? Math.min(1, p.open) : 0) : 0
      const aimX = aim && !grab ? aim[0] * p.tilt * DEG : 0
      const aimY = aim && !grab ? -aim[1] * p.tilt * DEG : 0
      const dt = Math.min(now.delta, MAX_STEP)
      const settle = (value: number, target: number, halfLife: number): number => {
        if (reduced) return target
        return damp(value, target, halfLife, dt, EPSILON)
      }
      if (hover !== hoverGoal) hover = settle(hover, hoverGoal, HOVER_HALF_LIFE)
      if (lid !== lidGoal) lid = settle(lid, lidGoal, LID_HALF_LIFE)
      if (tiltX !== aimX) tiltX = settle(tiltX, aimX, TILT_HALF_LIFE)
      if (tiltY !== aimY) tiltY = settle(tiltY, aimY, TILT_HALF_LIFE)
      if (velocity && !grab) {
        yaw += velocity * dt
        velocity = Math.abs(velocity) < COAST_STOP ? 0 : damp(velocity, 0, COAST_HALF_LIFE, dt)
      }
      if (keyYaw) {
        const rest = settle(keyYaw, 0, KEY_HALF_LIFE)
        yaw += keyYaw - rest
        keyYaw = rest
      }
      if (keyPitch) {
        const rest = settle(keyPitch, 0, KEY_HALF_LIFE)
        pitch = Math.max(-PITCH, Math.min(PITCH, pitch + keyPitch - rest))
        keyPitch = Math.abs(pitch) >= PITCH ? 0 : rest
      }
      // The idle spin waits while the box is touched, hovered, focused or open.
      const idle = p.spin !== 0 && !reduced && !grab && !near && !held && lid === 0
      if (!idle) quiet = p.spin !== 0 && !reduced ? QUIET : 0
      else if (quiet > 0) quiet = Math.max(0, quiet - dt)
      const spinning = idle && quiet === 0
      if (spinning) spun = (spun + p.spin * DEG * dt) % TAU
      // Smoothstep of hover and lid: the swing and the opening start and end gently.
      const swing = hover * hover * (3 - 2 * hover)
      const opened = lid * lid * (3 - 2 * lid)
      const turn = -p.yaw * DEG + yaw + spun - p.swing * DEG * swing + tiltX
      const lean = Math.max(-PITCH, Math.min(PITCH, p.pitch * DEG + pitch + LEAN * opened + tiltY))
      pivot.rotation.set(lean, turn, 0)
      pivot.position.z = -built.depth / 2 + 0.04 * swing
      const hinge = built.part
      if (hinge) {
        if (motion === 'flap') hinge.rotation.x = -FLAP * opened
        else if (motion === 'lift') {
          hinge.position.y = 0.5 + BOARD + RISE * opened
          hinge.rotation.x = -0.3 * opened
        } else hinge.position.x = SLIDE * built.width * opened
      }
      const s = now.height || 1
      root.scale.setScalar(s * (0.96 + 0.04 * now.presence))

      const wide = built.width * Math.abs(Math.cos(turn)) + built.depth * Math.abs(Math.sin(turn))
      shade.set(
        wide * s * 0.92,
        s * 0.94,
        0.01 * s,
        0,
        -0.015 * s - swing * 0.01 * s,
        (0.045 + 0.04 * swing) * s,
        Math.max(0, Math.min(1, p.shadow)),
      )
      const busy =
        spinning ||
        hover !== hoverGoal ||
        lid !== lidGoal ||
        tiltX !== aimX ||
        tiltY !== aimY ||
        velocity !== 0 ||
        keyYaw !== 0 ||
        keyPitch !== 0 ||
        (idle && quiet > 0)
      // Above the neighbours while it swings or opens.
      const up = Math.max(swing, opened)
      if (up > 0) ctx.pose(ctx.layer, { above: 1 }, up)
      return busy
    }
  },
})
export default box
