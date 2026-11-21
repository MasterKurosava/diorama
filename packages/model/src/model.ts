// A glTF model fitted to the element's box: a turntable with tilt, drag and arrow keys, the file's
// animation clips, and part colours that ease between swatches.
import type { ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { DEV, damp, ease, fromOklab, type Oklab, toOklab } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import { hash, neutralToneMapping, output, screenCoordinate, uint, vec4 } from 'three/tsl'
import {
  type AnimationClip,
  AnimationMixer,
  Box3,
  Color,
  Group,
  InterpolateDiscrete,
  type Material,
  Matrix4,
  type Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
  type Object3D,
  Vector3,
} from 'three/webgpu'
import { AROUND, corners, type Fit, fitPoints } from './contain'
import { bounds } from './parts'
import { publish, type Rig, rigOf } from './rig'

type Params = {
  src: string
  part: string
  color: ColorParam
  swatches: string
  duration: number
  scale: number
  yaw: number
  pitch: number
  spin: number
  turn: number
  tilt: number
  drag: boolean
  clip: string
  exposure: number
}

const TAU = Math.PI * 2
const DEG = Math.PI / 180
/** Pitch limit of the rest pose together with what drag and arrow keys add. */
const PITCH = Math.PI / 9
/** One arrow key press. */
const STEP = Math.PI / 12
/** Below this a motion counts as settled. */
const EPSILON = 1e-4
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Scale with presence: the model grows the last few percent as it arrives. */
const arrival = (presence: number): number => 0.96 + 0.04 * presence
/** A drag held still this long before letting go does not coast, ms. */
const COAST_HOLD = 80
/** Fastest coast after a drag, radians per second. */
const COAST_MAX = TAU * 2
/** Coasting stops below this speed, radians per second. */
const COAST_STOP = 0.02
/** Half-lives, s: of the coast, of an arrow key step, of the pointer tilt. */
const COAST_HALF_LIFE = 0.35
const KEY_HALF_LIFE = 0.08
const TILT_HALF_LIFE = 0.12
/** Past this many meshes the fit holds the corners of the whole model, not of each mesh. */
const MAX_FIT_MESHES = 64
/** Distance of the camera when the renderer has none, px. */
const CAMERA_DISTANCE = 1000
/** Children that take their own clicks, so a press on them starts no drag. */
const INTERACTIVE =
  'a[href], button, input, select, textarea, label, summary, [tabindex], [contenteditable], [data-dio-at]'

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k

/** Yaw and pitch in radians. */
type Pose = readonly [yaw: number, pitch: number]

/**
 * A frame asked for by a timer may carry the time of the refresh before the timer fired, so the
 * timer for the next key fires this much later (ms), about one 60 Hz refresh.
 */
const LATE = 17

/**
 * Key times of a clip whose every track steps from key to key, like a ticking hand, sorted.
 * Undefined if any track blends between keys: then every frame shows something new.
 */
export function steps(clip: AnimationClip): number[] | undefined {
  const times = new Set<number>()
  for (const track of clip.tracks) {
    if (track.getInterpolation() !== InterpolateDiscrete) return undefined
    for (const time of track.times) times.add(time)
  }
  return [...times].sort((a, b) => a - b)
}

/** Seconds from clip time `at` to the next key, through the end of the loop. */
export function untilKey(keys: readonly number[], at: number, duration: number): number {
  let lo = 0
  let hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((keys[mid] as number) > at) hi = mid
    else lo = mid + 1
  }
  const next = keys[lo]
  if (next !== undefined) return next - at
  const first = keys[0]
  return first === undefined ? Number.POSITIVE_INFINITY : duration - at + first
}

/** Own material properties never copied to a twin: identity, cache marks, listeners. */
const SKIP = new Set(['uuid', 'id', 'type', 'version', 'userData', '_listeners'])

/**
 * A node material owned by the instance with the same look as a glTF one: textures stay shared
 * with the cache, colours and vectors are copied. Undefined for kinds glTF lines and points use.
 */
export function twin(
  source: Material,
): MeshStandardNodeMaterial | MeshBasicNodeMaterial | undefined {
  const from = source as Material & Record<string, unknown>
  const Kind = from.isMeshPhysicalMaterial
    ? MeshPhysicalNodeMaterial
    : from.isMeshStandardMaterial
      ? MeshStandardNodeMaterial
      : from.isMeshBasicMaterial
        ? MeshBasicNodeMaterial
        : undefined
  if (!Kind) return undefined
  const target = new Kind()
  const to = target as unknown as Record<string, unknown>
  for (const key in from) {
    if (SKIP.has(key) || key.startsWith('is') || !(key in to)) continue
    const value = from[key] as { isTexture?: boolean; clone?: () => unknown } | null
    to[key] =
      value && typeof value === 'object' && !value.isTexture && typeof value.clone === 'function'
        ? value.clone()
        : value
  }
  return target
}

/** The first checked radio or the value of a select among these elements and inside them. */
function chosen(selector: string): string | undefined {
  for (const node of document.querySelectorAll(selector)) {
    const field = node.matches('input:checked, select')
      ? node
      : node.querySelector('input:checked, select')
    if (field) return (field as HTMLInputElement).value
  }
  return undefined
}

/** A glTF fitted to the element's box: turntable, tilt, drag, clips and part colours. */
const model: Effect<Params> = defineEffect({
  name: 'model',
  params: {
    src: '',
    part: '',
    color: Object.freeze({ '~kind': 'color', value: '#ffffff' }) as ColorParam,
    swatches: '',
    duration: 0.4,
    scale: 0.9,
    yaw: 0,
    pitch: 0,
    spin: 0,
    turn: 0,
    tilt: 8.6,
    drag: true,
    clip: '',
    exposure: 1,
  },
  rebuild: ['src', 'part', 'swatches', 'clip'],
  // Its own materials are opaque, so it leaves by dithering, not by alpha.
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, u, signal } = ctx
    const { src, part, swatches, clip } = ctx.params
    if (!src) throw new Error('model needs a file: data-dio-src="/models/chair.glb"')
    const el = element as HTMLElement
    const eager = el.getAttribute('data-dio-load') === 'eager'
    const scene = await ctx.model(src, { priority: eager ? 'high' : 'normal' })

    // Own node twins of the file's materials: tone mapped and dithered, the cache's untouched.
    const partNames = new Set(
      part
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    )
    const pixel = uint(screenCoordinate.x).add(uint(screenCoordinate.y).mul(8192))
    const dither = hash(pixel).mul(0.999).lessThan(u.presence) as unknown as Node<'bool'>
    const toned = vec4(neutralToneMapping(output.rgb, u.exposure) as Node<'vec3'>, output.a)
    const owned = ownMaterials(scene, partNames, dither, toned)
    const painted = owned.painted
    if (DEV && partNames.size && !painted.size) {
      ctx.app.log.warn(
        `model: no part "${part}" in ${src}. Materials: ${owned.materialNames.join(', ')}. Meshes: ${owned.meshNames.join(', ')}`,
      )
    }

    // Placement: root holds the fit, pivot the rotation, the file's scene inside.
    const root = new Group()
    const pivot = new Group()
    root.add(pivot)
    pivot.add(scene)
    ctx.place(root, { fit: 'contain', replace: true })
    const file = scene.children[0] ?? scene
    file.updateWorldMatrix(true, true)
    const toFile = new Matrix4().copy(file.matrixWorld).invert()
    const fileBounds = bounds(file, toFile)
    const fitCorners = cornersToFit(file, toFile, fileBounds)

    // Animation clip. A clip of step keys only draws at its keys, on a timer: a ticking watch is
    // a frame a second.
    let mixer: AnimationMixer | undefined
    let keys: number[] | undefined
    let action: { time: number } | undefined
    let clipDuration = 0
    let lastStepAt: number | undefined
    let keyTimer: ReturnType<typeof setTimeout> | undefined
    const clearKeyTimer = (): void => {
      clearTimeout(keyTimer)
      keyTimer = undefined
    }
    const onKeyTimer = (): void => {
      keyTimer = undefined
      ctx.invalidate()
    }
    if (clip) {
      const clips = scene.animations
      const found = clip === '*' ? clips[0] : clips.find((c) => c.name === clip)
      if (found) {
        const clipMixer = new AnimationMixer(scene)
        action = clipMixer.clipAction(found).play()
        clipMixer.update(0)
        clipDuration = found.duration
        keys = steps(found)?.filter((key) => key <= clipDuration)
        ctx.onDispose(() => {
          clearKeyTimer()
          clipMixer.stopAllAction()
          clipMixer.uncacheRoot(scene)
        })
        mixer = clipMixer
      } else if (DEV) {
        const list = clips.map((c) => c.name).join(', ') || 'none'
        ctx.app.log.warn(`model: no clip "${clip}" in ${src}. Clips: ${list}`)
      }
    }

    // Part colour: the latest of the param and the swatch group, eased in OKLab.
    const partColor = new Color()
    let lab: Readonly<Oklab> = [1, 0, 0]
    let labFrom = lab
    let labTo = lab
    let colorProgress = 1
    const paintParts = (): void => {
      fromOklab(lab, partColor)
      for (const material of painted) {
        material.color.copy(partColor)
        const velvet = material as MeshPhysicalNodeMaterial
        if (velvet.isMeshPhysicalNodeMaterial && velvet.sheen > 0) velvet.sheenColor.copy(partColor)
      }
    }
    const recolor = (value: string, immediate = false): void => {
      const parsed = cssColor(value, element)
      if (!parsed || !painted.size) return
      labFrom = lab
      labTo = toOklab(new Color().setStyle(parsed))
      colorProgress = immediate || ctx.params.duration <= 0 ? 1 : 0
      if (colorProgress === 1) {
        lab = labTo
        paintParts()
      }
      ctx.invalidate()
    }
    let colorParam = ctx.params.color
    recolor((swatches && chosen(swatches)) || colorParam, true)
    if (swatches) {
      if (DEV && !document.querySelector(swatches))
        ctx.app.log.warn(`model: no swatches "${swatches}" on the page`)
      document.addEventListener(
        'change',
        (event) => {
          const field = event.target as HTMLInputElement
          if (!(field instanceof Element) || !field.closest(swatches)) return
          if (field.type === 'radio' && !field.checked) return
          recolor(field.value)
        },
        { signal },
      )
    }

    // Rotation: the rest pose from yaw and pitch; spin, drag with inertia and arrow keys go into
    // offsets from it that stay where the visitor left them, turn and tilt on top.
    const clampPitch = (angle: number): number => Math.min(PITCH, Math.max(-PITCH, angle))
    const poseOf = (p: { yaw: number; pitch: number }): Pose => [
      p.yaw * DEG,
      clampPitch(p.pitch * DEG),
    ]
    let pose = poseOf(ctx.params)
    let poseFrom = pose
    let poseTo = pose
    let poseProgress = 1
    let yawParam = ctx.params.yaw
    let pitchParam = ctx.params.pitch
    // An offset keeps the whole pitch within the limit.
    const holdPitch = (offset: number): number => clampPitch(pose[1] + offset) - pose[1]
    let yaw = 0
    let pitch = 0
    let velocity = 0
    let keyYaw = 0
    let keyPitch = 0
    let tiltX = 0
    let tiltY = 0
    let grab: { id: number; x: number; y: number; t: number } | undefined

    // Drag and arrow keys.
    // A finger drags only where the site gave the gesture to the page: otherwise it scrolls.
    const touchable = (): boolean => {
      const action = getComputedStyle(el).touchAction
      return action === 'none' || (action.includes('pan-y') && !action.includes('pan-x'))
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, fn, { signal })
    listen('pointerdown', (e) => {
      if (grab || !ctx.params.drag || e.button !== 0) return
      const hit = (e.target as Element | null)?.closest?.(INTERACTIVE)
      if (hit && hit !== el && el.contains(hit)) return
      if (e.pointerType !== 'mouse' && !touchable()) return
      grab = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
      velocity = 0
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
      // No text selection and no native drag of the poster.
      if (e.pointerType === 'mouse') e.preventDefault()
    })
    listen('pointermove', (e) => {
      if (e.pointerId !== grab?.id) return
      // Half a turn per box width.
      const radiansPerPx = Math.PI / Math.max(1, ctx.input.width)
      const dx = (e.clientX - grab.x) * radiansPerPx
      const seconds = Math.max(1, e.timeStamp - grab.t) / 1000
      // The release speed is smoothed over the last few moves.
      velocity = velocity * 0.2 + (dx / seconds) * 0.8
      yaw += dx
      pitch = holdPitch(pitch + (e.clientY - grab.y) * radiansPerPx)
      grab = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
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
    listen('keydown', (e) => {
      if (!ctx.params.drag || !el.hasAttribute('tabindex')) return
      const x = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      const y = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
      if (!x && !y) return
      e.preventDefault()
      keyYaw += x * STEP
      keyPitch += y * STEP
      ctx.invalidate()
    })

    // Fit: px per unit that keeps the bounds in the box in the rest pose, in perspective, centred.
    // `explode` may swap the bounds for those of its parts through the rig.
    let partBounds: readonly Box3[] | undefined
    const union = new Box3()
    const sceneToFile = new Matrix4()
    const centre = new Vector3()
    const fit: Fit = { scale: 0, x: 0, y: 0 }
    const measure = (): void => {
      const p = ctx.params
      const { width, height } = ctx.input
      const side = Math.min(width, height)
      if (!(side > 0)) return
      const box = partBounds
        ? partBounds.reduce((all, b) => all.union(b), union.makeEmpty())
        : fileBounds
      const turning = (p.spin !== 0 || p.turn !== 0) && !ctx.input.reducedMotion
      const scale = Math.max(0, p.scale)
      // The centre of the bounds stays on the pivot, as parts move apart.
      scene.position.set(0, 0, 0)
      scene.updateMatrix()
      file.updateMatrix()
      sceneToFile.copy(scene.matrix)
      if (file !== scene) sceneToFile.multiply(file.matrix)
      if (!box.isEmpty())
        scene.position.copy(box.getCenter(centre).applyMatrix4(sceneToFile)).negate()
      scene.updateMatrix()
      sceneToFile.copy(scene.matrix)
      if (file !== scene) sceneToFile.multiply(file.matrix)
      fitPoints(
        partBounds ? partBounds.flatMap((b) => corners(b)) : fitCorners,
        sceneToFile,
        turning ? AROUND : [pose[0]],
        pose[1],
        width * scale,
        height * scale,
        ctx.render.camera.position.z || CAMERA_DISTANCE,
        fit,
      )
      const arrive = arrival(ctx.input.presence)
      root.scale.setScalar(((fit.scale || scale * side) / side) * arrive)
      root.position.set((fit.x / side) * arrive, (fit.y / side) * arrive, 0)
    }

    // Effects on the same element (`explode`, `hotspots`) work on the scene through the rig.
    const rig: Rig = {
      scene: scene as Group,
      pivot,
      file,
      root: ctx.layer.root,
      box: ctx.input,
      face(targetYaw, targetPitch) {
        velocity = 0
        keyYaw = targetYaw - pose[0] - yaw
        keyYaw -= TAU * Math.round(keyYaw / TAU)
        keyPitch = clampPitch(targetPitch) - pose[1] - pitch
        ctx.invalidate()
      },
      contain(boxes) {
        partBounds = boxes
        measure()
      },
      invalidate: () => ctx.invalidate(),
    }
    publish(element, rig)
    ctx.onDispose(() => {
      if (rigOf(element) === rig) publish(element, undefined)
    })

    const hoverable = matchMedia('(hover: hover)').matches
    return (now, frame): boolean => {
      const p = ctx.params
      const reduced = now.reducedMotion
      if (p.color !== colorParam) {
        colorParam = p.color
        recolor(colorParam)
      }
      if (p.yaw !== yawParam || p.pitch !== pitchParam) {
        yawParam = p.yaw
        pitchParam = p.pitch
        poseFrom = pose
        poseTo = poseOf(p)
        poseProgress = reduced || p.duration <= 0 ? 1 : 0
        if (poseProgress === 1) pose = poseTo
      }
      // The pointer is read only when it tilts, so moves draw nothing otherwise.
      let aimX = 0
      let aimY = 0
      if (hoverable && !reduced && p.tilt > 0 && !grab && now.over) {
        aimX = (now.pointer.x - 0.5) * 2 * p.tilt * DEG
        aimY = (0.5 - now.pointer.y) * 2 * p.tilt * DEG
      }
      const spinning = !reduced && p.spin !== 0 && !grab
      const playing = mixer !== undefined && !reduced
      const stepping = playing && keys !== undefined
      const flowing = playing && !stepping
      const moving = (): boolean =>
        spinning ||
        flowing ||
        velocity !== 0 ||
        colorProgress < 1 ||
        keyYaw !== 0 ||
        keyPitch !== 0 ||
        tiltX !== aimX ||
        tiltY !== aimY ||
        poseProgress < 1
      if (moving()) {
        const dt = Math.min(now.delta, MAX_STEP)
        if (spinning) yaw += p.spin * DEG * dt
        if (velocity && !grab) {
          yaw += velocity * dt
          velocity = Math.abs(velocity) < COAST_STOP ? 0 : damp(velocity, 0, COAST_HALF_LIFE, dt)
        }
        // Arrow keys ease to the next step, or jump to it under reduced motion.
        const remainder = (value: number): number => {
          return reduced ? 0 : damp(value, 0, KEY_HALF_LIFE, dt, EPSILON)
        }
        const yawLeft = remainder(keyYaw)
        const pitchLeft = remainder(keyPitch)
        yaw += keyYaw - yawLeft
        pitch = holdPitch(pitch + keyPitch - pitchLeft)
        keyYaw = yawLeft
        keyPitch = pitchLeft
        tiltX = damp(tiltX, aimX, TILT_HALF_LIFE, dt)
        tiltY = damp(tiltY, aimY, TILT_HALF_LIFE, dt)
        if (Math.abs(tiltX - aimX) + Math.abs(tiltY - aimY) < EPSILON) {
          tiltX = aimX
          tiltY = aimY
        }
        if (colorProgress < 1) {
          colorProgress = Math.min(1, colorProgress + dt / Math.max(p.duration, 1e-3))
          const k = ease('cubicInOut', colorProgress)
          lab = [
            lerp(labFrom[0], labTo[0], k),
            lerp(labFrom[1], labTo[1], k),
            lerp(labFrom[2], labTo[2], k),
          ]
          paintParts()
        }
        if (poseProgress < 1) {
          poseProgress = reduced ? 1 : Math.min(1, poseProgress + dt / Math.max(p.duration, 1e-3))
          const k = ease('cubicInOut', poseProgress)
          pose =
            poseProgress === 1
              ? poseTo
              : [lerp(poseFrom[0], poseTo[0], k), lerp(poseFrom[1], poseTo[1], k)]
        }
        if (flowing) mixer?.update(dt)
      }
      // Steps follow the real time between frames, however far apart: at rest a key apart, and
      // back on screen the watch shows the time it kept.
      if (stepping)
        mixer?.update(lastStepAt === undefined ? 0 : Math.max(0, frame.now - lastStepAt) / 1000)
      lastStepAt = stepping ? frame.now : undefined
      const turn = !reduced && p.turn !== 0 ? p.turn * DEG * (now.progress - 0.5) : 0
      pivot.rotation.set(pose[1] + pitch + tiltY, pose[0] + yaw + turn + tiltX, 0)
      measure()
      const busy = moving()
      // Off screen no update runs, so no new timer: the last one finds the layer hidden.
      clearKeyTimer()
      if (stepping && !busy && keys?.length && action && clipDuration > 0)
        keyTimer = setTimeout(onKeyTimer, untilKey(keys, action.time, clipDuration) * 1000 + LATE)
      return busy
    }
  },
})
export default model

/** What `ownMaterials` made: the twins that take the part colour, and names for a dev warning. */
interface Owned {
  readonly painted: Set<MeshStandardNodeMaterial | MeshBasicNodeMaterial>
  readonly meshNames: string[]
  readonly materialNames: string[]
}

/**
 * Swaps every mesh's materials for node twins with `dither` as the mask and `toned` as the
 * output. A material is twinned once per role: a named part (by mesh, ancestor or material name)
 * gets its own twin to paint, the rest share one.
 */
function ownMaterials(
  scene: Object3D,
  partNames: ReadonlySet<string>,
  dither: Node<'bool'>,
  toned: Node,
): Owned {
  const inPart = (object: Object3D): boolean => {
    for (let o: Object3D | null = object; o && o !== scene; o = o.parent)
      if (partNames.has(o.name)) return true
    return false
  }
  const twins = { plain: new Map<Material, Material>(), painted: new Map<Material, Material>() }
  const painted = new Set<MeshStandardNodeMaterial | MeshBasicNodeMaterial>()
  const meshNames: string[] = []
  const materialNames = new Set<string>()
  scene.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    meshNames.push(mesh.name)
    const wholeMesh = inPart(mesh)
    const own = (source: Material): Material => {
      materialNames.add(source.name)
      const paint = wholeMesh || partNames.has(source.name)
      const cache = paint ? twins.painted : twins.plain
      let made = cache.get(source)
      if (!made) {
        const copy = twin(source)
        if (copy) {
          copy.outputNode = toned
          copy.maskNode = dither
          if (paint) painted.add(copy)
        }
        made = copy ?? source
        cache.set(source, made)
      }
      return made
    }
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(own)
      : own(mesh.material as Material)
  })
  return { painted, meshNames, materialNames: [...materialNames] }
}

/**
 * Points the fit keeps in the box, in the file's coordinates: the corners of each mesh's bounds,
 * closer than those of the whole. Past a few dozen meshes the corners of the whole.
 */
function cornersToFit(file: Object3D, toFile: Matrix4, fileBounds: Box3): Vector3[] {
  const meshes: Mesh[] = []
  file.traverse((o) => {
    if ((o as Mesh).isMesh) meshes.push(o as Mesh)
  })
  if (meshes.length > MAX_FIT_MESHES) return corners(fileBounds)
  return meshes.flatMap((mesh) => {
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox?.clone()
    return box ? corners(box.applyMatrix4(mesh.matrixWorld).applyMatrix4(toFile)) : []
  })
}
