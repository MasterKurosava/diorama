// A screenshot or a video inside a procedural phone, tablet, laptop or browser window, built to
// the proportions of the real devices, that leans toward the pointer.
import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp, ease } from '@dioramajs/effects/kit'
import {
  cameraPosition,
  clamp,
  dot,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  reflect,
  select,
  smoothstep,
  texture,
  color as tslColor,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Box3,
  type BufferGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { corners, type Fit, fitPoints } from './contain'
import { merge, panel, slab } from './shapes'
import { dissolve, Pointer, sharpen, shadow as softShadow, toned } from './studio'

export type Frame = 'phone' | 'tablet' | 'laptop' | 'browser'
type Params = {
  frame: ChoiceParam<Frame>
  color: ColorParam
  yaw: number
  pitch: number
  tilt: number
  turn: number
  radius: number
  shadow: number
  scale: number
}
type V3 = Node<'vec3'>

const DEG = Math.PI / 180
/** Pitch limit of the rest pose with the tilt on top. */
const PITCH = Math.PI / 6
/** Time a rest pose change takes, s. */
const EASE = 0.45
/** How far the laptop lid leans back from upright. */
const LEAN = 18 * DEG
/** How far the whole laptop tips toward the viewer, so the keyboard shows. */
const TIP = 15 * DEG
/** Below this a motion counts as settled. */
const EPSILON = 1e-4
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Half-life of the lean toward the pointer, s. */
const TILT_HALF_LIFE = 0.12
/** Distance of the camera when the renderer has none, px. */
const CAMERA_DISTANCE = 1000
/** Scale with presence: the device grows the last few percent as it arrives. */
const arrival = (presence: number): number => 0.96 + 0.04 * presence

/** The materials one device is built from. */
export interface Kit {
  readonly glass: Material
  readonly metal: Material
  readonly satin: Material
  readonly screen: Material
  readonly well: Material
  readonly keys: Material
  readonly pad: Material
  readonly chrome: Material
  readonly pill: Material
  readonly lights: readonly Material[]
}

/** A built device: its group, centred on its bounds, and its size at rest in screen heights. */
export interface Built {
  readonly group: Group
  readonly width: number
  readonly height: number
  readonly depth: number
  readonly corner: number
  /** The laptop stands on its base: its shadow is a band under it, not its whole outline. */
  readonly base: boolean
  /** Width over height of the screen, which the picture covers. */
  readonly aspect: number
  /** Corners of the bounds of its parts around its centre, for a fit tighter than its box. */
  readonly points: readonly Vector3[]
}

/** Long side over short side of the screens of real phones and tablets. */
const LONG = { phone: [16 / 9, 2.17], tablet: [4 / 3, 1.6] } as const
/** Laptop screens are 16:10; browser windows run from 5:4 to ultrawide. */
const LAPTOP = 1.6
const BROWSER = [1.25, 2.4] as const

/**
 * The screen aspect (width over height) of a frame for a box of `aspect`: within the range of the
 * real device, in the box's orientation for a phone or a tablet, always landscape for a laptop.
 */
export function screenOf(frame: Frame, aspect: number): number {
  const a = Math.max(0.05, aspect)
  if (frame === 'laptop') return LAPTOP
  if (frame === 'browser') return Math.min(BROWSER[1], Math.max(BROWSER[0], a))
  const [low, high] = LONG[frame]
  const long = Math.min(high, Math.max(low, a < 1 ? 1 / a : a))
  return a < 1 ? 1 / long : long
}

/**
 * Crop of a picture of `media` aspect that covers a screen of `screen` aspect: scale and offset of
 * the UV, centred across and from the top down, as a screenshot is read.
 */
export function coverOf(media: number, screen: number): [number, number, number, number] {
  if (!(media > 0) || !(screen > 0)) return [1, 1, 0, 0]
  if (media > screen) return [screen / media, 1, (1 - screen / media) / 2, 0]
  return [1, media / screen, 0, 1 - media / screen]
}

/** The keys of a laptop keyboard, `width` × `depth`, as one geometry facing +z, the top row at +y. */
function keyboard(width: number, depth: number): BufferGeometry {
  // Key widths of each row in key units, 15 units across.
  const rows: number[][] = [
    Array(14).fill(15 / 14),
    [...Array(13).fill(1), 2],
    [1.5, ...Array(12).fill(1), 1.5],
    [1.75, ...Array(11).fill(1), 2.25],
    [2.25, ...Array(10).fill(1), 2.75],
    [1, 1, 1, 1.25, 5.5, 1.25, 1, 1, 1, 1],
  ]
  const unit = width / 15
  // Five full rows and the half-height function row.
  const rowHeight = depth / 5.55
  const gap = 0.14 * unit
  const keys: BufferGeometry[] = []
  let y = depth / 2
  rows.forEach((widths, row) => {
    const height = row === 0 ? rowHeight * 0.55 : rowHeight
    let x = -width / 2
    for (const units of widths) {
      const key = panel(units * unit - gap, height - gap, 0.12 * unit, 3)
      key.translate(x + (units * unit) / 2, y - height / 2, 0)
      keys.push(key)
      x += units * unit
    }
    y -= height
  })
  return merge(keys)
}

/**
 * The device of a frame around a screen for a box of `aspect` (width over height), the screen 1
 * unit tall. Proportions follow the real devices: screen aspect, bezels, depth and corner radius,
 * `radius` times as round.
 */
export function build(frame: Frame, aspect: number, radius: number, kit: Kit): Built {
  const screen = screenOf(frame, aspect)
  const group = new Group()
  const add: Add = (geometry, material, z = 0) => {
    const mesh = new Mesh(geometry, material)
    mesh.position.z = z
    group.add(mesh)
    return mesh
  }
  const { depth, corner } =
    frame === 'phone' || frame === 'tablet'
      ? handheld(add, frame === 'phone', screen, radius, kit)
      : frame === 'laptop'
        ? laptop(group, screen, radius, kit)
        : browser(add, screen, radius, kit)
  // Centre the device on its bounds.
  group.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(group)
  const size = bounds.getSize(new Vector3())
  const centre = bounds.getCenter(new Vector3())
  const outer = new Group()
  group.position.copy(centre).negate()
  outer.add(group)
  outer.updateMatrixWorld(true)
  const points: Vector3[] = []
  outer.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    const own = box ? corners(box) : []
    for (const p of own) points.push(p.applyMatrix4(mesh.matrixWorld))
  })
  return {
    group: outer,
    width: size.x,
    height: size.y,
    depth: Math.max(depth, size.z),
    corner,
    base: frame === 'laptop',
    aspect: screen,
    points,
  }
}

/** Adds a mesh to the device, `z` in front of its centre. */
type Add = (geometry: BufferGeometry, material: Material | Material[], z?: number) => Mesh

/** What a frame builder returns: the body's depth and corner radius. */
interface Shell {
  readonly depth: number
  readonly corner: number
}

/** A phone or a tablet around a screen `screenWidth` × 1. */
function handheld(add: Add, phone: boolean, screenWidth: number, radius: number, kit: Kit): Shell {
  const screenHeight = 1
  const unit = Math.min(screenWidth, screenHeight)
  const bezel = (phone ? 0.042 : 0.055) * unit
  const bodyWidth = screenWidth + 2 * bezel
  const bodyHeight = screenHeight + 2 * bezel
  const depth = (phone ? 0.1 : 0.035) * Math.min(bodyWidth, bodyHeight)
  const corner = (phone ? 0.16 : 0.085) * Math.min(bodyWidth, bodyHeight) * radius
  add(slab(bodyWidth, bodyHeight, depth, corner, depth * 0.4), [kit.glass, kit.satin, kit.metal])
  const lift = depth / 2 + 0.0015 * unit
  add(panel(screenWidth, screenHeight, Math.max(0, corner - bezel * 0.9)), kit.screen, lift)
  const portrait = screenHeight >= screenWidth
  if (!phone) {
    // The tablet's camera: a dot in the bezel.
    const r = 0.009 * unit
    const camera = add(panel(2 * r, 2 * r, r), kit.chrome, depth / 2 + 0.0008 * unit)
    if (portrait) camera.position.y = screenHeight / 2 + bezel / 2
    else camera.position.x = -screenWidth / 2 - bezel / 2
    return { depth, corner }
  }
  // The camera island: a pill at the top of the screen, at the left in landscape.
  const islandLong = 0.32 * unit
  const islandThick = 0.093 * unit
  const offset = 0.028 * unit + islandThick / 2
  const island = add(
    panel(
      portrait ? islandLong : islandThick,
      portrait ? islandThick : islandLong,
      islandThick / 2,
    ),
    kit.glass,
    lift + 0.001 * unit,
  )
  if (portrait) island.position.y = screenHeight / 2 - offset
  else island.position.x = -screenWidth / 2 + offset
  // Side keys: power on one long edge, volume up and down on the other.
  const bar = depth * 0.42
  const longSide = Math.max(bodyWidth, bodyHeight)
  for (const [side, at, length] of [
    [1, 0.16, 0.16],
    [-1, 0.2, 0.09],
    [-1, 0.06, 0.09],
  ] as const) {
    const along = length * longSide
    const key = add(
      slab(portrait ? bar : along, portrait ? along : bar, bar, bar / 2, bar / 3),
      kit.metal,
    )
    const out = (portrait ? bodyWidth : bodyHeight) / 2 - bar * 0.3
    if (portrait) key.position.set(side * out, at * longSide, 0)
    else key.position.set(-at * longSide, side * out, 0)
  }
  return { depth, corner }
}

/** A laptop open a little past upright around a screen `screenWidth` × 1. */
function laptop(group: Group, screenWidth: number, radius: number, kit: Kit): Shell {
  const screenHeight = 1
  const w = screenWidth
  const sideBezel = 0.026 * w
  const topBezel = 0.036 * w
  const bottomBezel = 0.052 * w
  const lidWidth = screenWidth + 2 * sideBezel
  const lidHeight = screenHeight + topBezel + bottomBezel
  const lidDepth = 0.012 * lidWidth
  const corner = 0.03 * lidWidth * radius
  // Open a little past upright, the whole machine tipped toward the viewer to show the deck.
  group.rotation.x = TIP
  const hinge = new Group()
  hinge.rotation.x = -LEAN
  group.add(hinge)
  const lid = new Mesh(slab(lidWidth, lidHeight, lidDepth, corner, lidDepth * 0.45), [
    kit.glass,
    kit.satin,
    kit.metal,
  ])
  lid.position.y = lidHeight / 2
  hinge.add(lid)
  const display = new Mesh(
    panel(screenWidth, screenHeight, Math.min(corner * 0.25, 0.006 * w)),
    kit.screen,
  )
  display.position.set(0, bottomBezel + screenHeight / 2, lidDepth / 2 + 0.0012 * w)
  hinge.add(display)
  const lens = new Mesh(panel(0.009 * w, 0.009 * w, 0.0045 * w), kit.well)
  lens.position.set(0, lidHeight - topBezel / 2, lidDepth / 2 + 0.0008 * w)
  hinge.add(lens)
  // The base lies flat, its back edge at the hinge, the deck facing up.
  const baseDepth = lidHeight * 0.92
  const baseThick = 0.026 * lidWidth
  const lay = (mesh: Mesh, y: number, z: number): void => {
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(0, y, z)
    group.add(mesh)
  }
  const base = slab(lidWidth, baseDepth, baseThick, corner, baseThick * 0.4)
  lay(new Mesh(base, [kit.satin, kit.metal, kit.metal]), -baseThick / 2, baseDepth / 2 - lidDepth)
  // The keyboard in its well behind the trackpad, the hinge barrel along the back edge.
  const keysWidth = lidWidth * 0.86
  const keysDepth = baseDepth * 0.42
  const keysZ = baseDepth * 0.07 - lidDepth + keysDepth / 2
  const well = panel(keysWidth * 1.01, keysDepth * 1.03, 0.01 * lidWidth)
  lay(new Mesh(well, kit.well), 0.0006 * w, keysZ)
  lay(new Mesh(keyboard(keysWidth * 0.985, keysDepth * 0.97), kit.keys), 0.0016 * w, keysZ)
  const trackpad = panel(lidWidth * 0.4, baseDepth * 0.32, 0.012 * lidWidth)
  lay(new Mesh(trackpad, kit.pad), 0.0008 * w, baseDepth * 0.71 - lidDepth)
  const barrel = new Mesh(
    new CylinderGeometry(baseThick * 0.42, baseThick * 0.42, lidWidth * 0.72, 24),
    kit.well,
  )
  barrel.rotation.z = Math.PI / 2
  barrel.position.set(0, -baseThick * 0.1, -lidDepth * 0.6)
  group.add(barrel)
  return { depth: baseDepth, corner }
}

/**
 * A browser window around a page `screenWidth` × 1: a toolbar with the window buttons and an
 * address field over the page.
 */
function browser(add: Add, screenWidth: number, radius: number, kit: Kit): Shell {
  const screenHeight = 1
  const w = Math.max(screenWidth, screenHeight)
  const bar = 0.055 * w
  const windowHeight = screenHeight + bar
  const depth = 0.012 * w
  const corner = 0.014 * w * radius
  const body = slab(screenWidth, windowHeight, depth, corner, depth * 0.45)
  add(body, [kit.chrome, kit.chrome, kit.chrome])
  const lift = depth / 2 + 0.0008 * w
  const pageCorner = Math.max(0, corner - 0.0005 * w)
  const page = add(
    panel(screenWidth, screenHeight, [0, 0, pageCorner, pageCorner]),
    kit.screen,
    lift,
  )
  page.position.y = -bar / 2
  const barY = windowHeight / 2 - bar / 2
  const r = 0.115 * bar
  kit.lights.forEach((material, i) => {
    const light = add(panel(2 * r, 2 * r, r), material, lift)
    light.position.set(-screenWidth / 2 + bar * (0.4 + 0.38 * i), barY, lift)
  })
  const field = add(
    panel(Math.min(screenWidth * 0.42, bar * 9), bar * 0.56, bar * 0.28),
    kit.pill,
    lift,
  )
  field.position.y = barY
  return { depth, corner }
}

/**
 * Px per unit that fits the device in the box in its rest pose, and the shift that centres it:
 * the corners of its parts turned by pitch and yaw, each grown by the perspective of its depth
 * seen from `distance` px.
 */
export function fitOf(
  built: Built,
  pose: readonly [number, number],
  width: number,
  height: number,
  distance: number,
): Fit {
  const fit = fitPoints(built.points, IDENTITY, [pose[0]], pose[1], width, height, distance)
  if (!fit.scale) fit.scale = 1
  return fit
}

const IDENTITY = new Matrix4()

/** Frees the geometries of a built device; its materials are shared and stay. */
function dispose(group: Group): void {
  group.traverse((o) => (o as Mesh).geometry?.dispose())
}

/** A screenshot or a video in a 3D phone, tablet, laptop or browser window that leans toward the pointer. */
const device: Effect<Params> = defineEffect({
  name: 'device',
  params: {
    frame: oneOf('phone', 'tablet', 'laptop', 'browser'),
    color: Object.freeze({ '~kind': 'color', value: '#1d1e22' }) as ColorParam,
    yaw: -18,
    pitch: 6,
    tilt: 6.9,
    turn: 0,
    radius: 1,
    shadow: 0.5,
    scale: 0.9,
  },
  media: true,
  bleed: 80,
  // Its materials are opaque, so it leaves by dithering, not by alpha.
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, element } = ctx
    const frame = ctx.params.frame
    const mask = dissolve(u)
    sharpen(ctx.map, ctx.render.renderer)
    const lit = (options: { metalness: number; roughness: number }, colour: Node): Material => {
      const material = new MeshStandardNodeMaterial(options)
      material.colorNode = colour as Node<'vec4'>
      material.outputNode = toned()
      material.maskNode = mask
      return material
    }
    const flat = (colour: Node): Material => {
      const material = new MeshBasicNodeMaterial()
      material.colorNode = colour as Node<'vec4'>
      material.maskNode = mask
      return material
    }
    const body = u.color as unknown as V3
    // The screen shows the element's media as the page does, under a faint reflection of the room.
    const view = normalize(cameraPosition.sub(positionWorld))
    const sky = smoothstep(
      0.15,
      0.95,
      dot(reflect(view.negate(), normalWorld), normalize(vec3(-0.4, 0.8, 0.2))),
    )
    // The picture covers the screen, whose aspect is the device's, not always the box's.
    const crop = uniform(new Vector4(1, 1, 0, 0))
    const cropNode = crop as unknown as Node<'vec4'>
    const picture = texture(ctx.map, clamp(uv().mul(cropNode.xy).add(cropNode.zw), 0, 1))
    const screen = flat(vec4(picture.rgb.add(sky.mul(0.05)), 1))
    const luminance = dot(body, vec3(0.2126, 0.7152, 0.0722))
    const kit: Kit = {
      glass: lit({ metalness: 0, roughness: 0.12 }, tslColor(0x050507)),
      metal: lit(
        frame === 'browser'
          ? { metalness: 0, roughness: 0.6 }
          : { metalness: 0.75, roughness: 0.32 },
        body,
      ),
      satin: lit({ metalness: 0.4, roughness: 0.5 }, body),
      screen,
      well: lit({ metalness: 0.2, roughness: 0.7 }, body.mul(0.22)),
      keys: lit({ metalness: 0, roughness: 0.55 }, tslColor(0x16171a)),
      pad: lit({ metalness: 0.6, roughness: 0.38 }, body.mul(0.92)),
      chrome: lit({ metalness: 0, roughness: 0.6 }, body),
      // The address field: a little lighter on a dark toolbar, darker on a light one.
      pill: lit(
        { metalness: 0, roughness: 0.6 },
        mix(body, select(luminance.lessThan(0.25), vec3(1), vec3(0)), 0.12),
      ),
      lights: [0xff5f57, 0xfebc2e, 0x28c840].map((c) => flat(tslColor(c))),
    }
    const materials = [...new Set(Object.values(kit).flat())] as Material[]

    const root = new Group()
    const pivot = new Group()
    root.add(pivot)
    ctx.place(root, { fit: 'none', replace: true })
    const shade = softShadow(u)
    ctx.place(shade.mesh, { fit: 'none' })
    // Materials of a rebuilt device stay: dispose them with the instance.
    ctx.onDispose(() => {
      for (const material of materials) material.dispose()
    })

    const aspectOf = (): number => {
      const { width, height } = ctx.input
      if (width > 0 && height > 0) return width / height
      const media = element as HTMLImageElement & HTMLVideoElement
      const w = media.naturalWidth || media.videoWidth || 9
      const h = media.naturalHeight || media.videoHeight || 16
      return w / h
    }
    let built = build(frame, aspectOf(), ctx.params.radius, kit)
    let aspect = aspectOf()
    let radius = ctx.params.radius
    pivot.add(built.group)
    await ctx.compile(root)
    if (signal.aborted) return

    const clampPitch = (a: number): number => Math.min(PITCH, Math.max(-PITCH, a))
    const poseOf = (p: { yaw: number; pitch: number }): [number, number] => [
      p.yaw * DEG,
      clampPitch(p.pitch * DEG),
    ]
    let pose = poseOf(ctx.params)
    let poseFrom = pose
    let poseTo = pose
    let poseProgress = 1
    let yawParam = ctx.params.yaw
    let pitchParam = ctx.params.pitch
    let tiltX = 0
    let tiltY = 0
    const pointer = new Pointer(element, signal, () => ctx.invalidate())
    const hoverable = matchMedia('(hover: hover)').matches

    return (now): boolean => {
      const p = ctx.params
      const reduced = now.reducedMotion
      // Rebuilt when the box's shape changes by more than 1% or the radius changes.
      const boxAspect = now.width > 0 && now.height > 0 ? now.width / now.height : aspect
      if (Math.abs(boxAspect - aspect) > aspect * 0.01 || p.radius !== radius) {
        aspect = boxAspect
        radius = p.radius
        pivot.remove(built.group)
        dispose(built.group)
        built = build(frame, aspect, Math.max(0, radius), kit)
        pivot.add(built.group)
      }
      const media = element as HTMLImageElement & HTMLVideoElement
      const mediaWidth = media.naturalWidth || media.videoWidth || 0
      const mediaHeight = media.naturalHeight || media.videoHeight || 0
      const mediaAspect = mediaHeight > 0 ? mediaWidth / mediaHeight : aspect
      ;(crop.value as Vector4).fromArray(coverOf(mediaAspect, built.aspect))
      if (p.yaw !== yawParam || p.pitch !== pitchParam) {
        yawParam = p.yaw
        pitchParam = p.pitch
        poseFrom = pose
        poseTo = poseOf(p)
        poseProgress = reduced ? 1 : 0
        if (poseProgress === 1) pose = poseTo
      }
      const aim = hoverable && !reduced && p.tilt > 0 ? pointer.aim(now) : undefined
      const aimX = aim ? aim[0] * p.tilt * DEG : 0
      const aimY = aim ? -aim[1] * p.tilt * DEG : 0
      const dt = Math.min(now.delta, MAX_STEP)
      if (tiltX !== aimX || tiltY !== aimY) {
        tiltX = damp(tiltX, aimX, TILT_HALF_LIFE, dt)
        tiltY = damp(tiltY, aimY, TILT_HALF_LIFE, dt)
        if (Math.abs(tiltX - aimX) + Math.abs(tiltY - aimY) < EPSILON) {
          tiltX = aimX
          tiltY = aimY
        }
      }
      if (poseProgress < 1) {
        poseProgress = reduced ? 1 : Math.min(1, poseProgress + dt / EASE)
        const k = ease('cubicInOut', poseProgress)
        pose =
          poseProgress === 1
            ? poseTo
            : [
                poseFrom[0] + (poseTo[0] - poseFrom[0]) * k,
                poseFrom[1] + (poseTo[1] - poseFrom[1]) * k,
              ]
      }
      const turn = !reduced && p.turn !== 0 ? p.turn * DEG * (now.progress - 0.5) : 0
      const yaw = pose[0] + turn + tiltX
      const pitch = clampPitch(pose[1] + tiltY)
      pivot.rotation.set(pitch, yaw, 0)
      const scale = Math.max(0, p.scale)
      const arrive = arrival(now.presence)
      const fit = fitOf(
        built,
        pose,
        now.width * scale,
        now.height * scale,
        ctx.render.camera.position.z || CAMERA_DISTANCE,
      )
      const s = fit.scale * arrive
      const dx = fit.x * arrive
      const dy = fit.y * arrive
      root.scale.setScalar(s)
      root.position.set(dx, dy, 0)
      // The shadow on the page under the device's footprint, a little below it.
      const { width, height, depth: thick } = built
      const blur = 0.06 * Math.min(width, height) * s
      const density = Math.max(0, Math.min(1, p.shadow))
      if (built.base) {
        // Under the front of the base, as on a desk seen from a little above.
        const span = width * Math.abs(Math.cos(yaw)) + thick * Math.abs(Math.sin(yaw)) * 0.8
        shade.set(
          span * s * 0.92,
          0.1 * height * s,
          blur,
          dx,
          dy - 0.45 * height * s,
          blur * 1.2,
          density,
        )
      } else {
        const wide = width * Math.abs(Math.cos(yaw)) + thick * Math.abs(Math.sin(yaw))
        const tall = height * Math.abs(Math.cos(pitch)) + thick * Math.abs(Math.sin(pitch)) * 0.3
        const y = -0.03 * height * s - blur * 0.4
        shade.set(wide * s * 0.94, tall * s * 0.94, built.corner * s, dx, dy + y, blur, density)
      }
      const busy = poseProgress < 1 || tiltX !== aimX || tiltY !== aimY
      // Above the neighbours while it leans toward the pointer.
      const lean = Math.min(1, (Math.abs(tiltX) + Math.abs(tiltY)) / Math.max(p.tilt * DEG, 1e-3))
      if (lean > 0) ctx.pose(ctx.layer, { above: 1 }, lean)
      return busy
    }
  },
})
export default device
