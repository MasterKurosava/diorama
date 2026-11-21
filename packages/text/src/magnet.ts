import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { cssColor } from '@dioramajs/render'
import {
  attribute,
  cos,
  dot,
  float,
  log2,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  sin,
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
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector3,
} from 'three/webgpu'
import {
  type Atlas,
  fillOf,
  flat,
  follow,
  monochrome,
  type Piece,
  prepare,
  relief,
} from './letters'

type Style = 'repel' | 'attract' | 'lift' | 'scatter'
type Params = {
  style: ChoiceParam<Style>
  radius: number
  strength: number
  rotate: number
  stiffness: number
  damping: number
}
type F = Node<'float'>
type V3 = Node<'vec3'>

// What a letter at the pointer does at strength 1, in em of its font size.
/** Push of repel, pull of attract, drift of scatter. */
const PUSH = 0.2
const PULL = 0.14
const DRIFT = 0.32
/** Rise toward the viewer. */
const RISE: Readonly<Record<Style, number>> = {
  repel: 0.35,
  attract: 0.2,
  lift: 0.8,
  scatter: 0.45,
}
/** Growth of a lifted letter on top of its perspective. */
const GROW = 0.1
/** Height of a letter's middle above the baseline, em: the point it turns around. */
const MIDDLE = 0.35
/** Thickness of a letter slab, em, and the layers that draw its sides. */
const THICK = 0.08
const LAYERS = 5
/** Width of the bevel round the edge of a letter, em. */
const BEVEL = 0.035
/** Light from the upper left, in front: a face turned to it brightens, turned away darkens. */
const LIGHT = new Vector3(-0.42, 0.55, 0.72).normalize()
const AMBIENT = 0.45
/** Shadow fall per px of height, x and y (up), and its darkness. */
const FALL = [0.2, -0.32] as const
const SHADE = 0.3
/** Integration step, s: stable for stiffness up to a few thousand. */
const STEP = 1 / 240
/** Longest frame step, s, and the most integration steps in one frame. */
const MAX_STEP = 0.05
const MAX_SUBSTEPS = 64
/** Channels of a letter: x, y (up), z (toward the viewer), turns round x, y, z, scale. */
const CHANNELS = 7
const REST = [0, 0, 0, 0, 0, 0, 1]
/** Settled within: px and px/s for the shifts, radians or scale and their rates for the rest. */
const NEAR = [0.05, 0.05, 0.05, 3e-4, 3e-4, 3e-4, 3e-4]
const SLOW = [0.2, 0.2, 0.2, 2e-3, 2e-3, 2e-3, 2e-3]
/** Steepest turn of a letter, radians. */
const TILT = (80 * Math.PI) / 180
/** The bevels are carved once the page is idle, at most this many ms later. */
const IDLE_TIMEOUT = 1000
/** Without idle callbacks, the bevels are carved after this many ms. */
const CARVE_DELAY = 50

// Attribute names become WGSL and GLSL identifiers: camelCase never meets a keyword of either.
/** The cell in box px, x, y, width, height (y down). */
const BOX = 'letterBox'
/** Baseline y, font size, centre x of the DOM box, and how far the letter is from rest (0..1). */
const UNIT = 'letterUnit'
/** The cell's corner in the atlas, atlas px. */
const SPOT = 'letterSpot'
/** x, y (up), z and scale. */
const SHIFT = 'letterShift'
/** Turns round x, y and z, radians. */
const TURN = 'letterTurn'

/** Instance data of one atlas, shared by the letters and their shadows. */
interface Instances {
  readonly box: InstancedBufferAttribute
  readonly unit: InstancedBufferAttribute
  readonly spot: InstancedBufferAttribute
  readonly shift: InstancedBufferAttribute
  readonly turn: InstancedBufferAttribute
  readonly letters: InstancedBufferGeometry
  readonly shadows: InstancedBufferGeometry
}

/**
 * Letters react to the pointer like magnets in 3D: they are thin lit slabs that push away and
 * turn their faces from it, lean toward it, rise toward the viewer like a dock, or tumble apart,
 * casting soft shadows on the page. Each letter rides a spring, so it wobbles back into place when
 * the pointer leaves. At rest the element is plain DOM text.
 */
const magnet: Effect<Params> = defineEffect({
  name: 'magnet',
  params: {
    style: oneOf('repel', 'attract', 'lift', 'scatter'),
    radius: 2.5,
    strength: 1,
    rotate: 30,
    stiffness: 180,
    damping: 12,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // Letters and shadows move past the box.
  bleed: 64,
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, signal, render } = ctx
    const style = params.style
    const ratio = ctx.quality === 'low' ? 1 : 2
    let atlas = await prepare(ctx, ratio)
    if (!atlas) return

    const { letters, shadows, ink, bumps, soft, size, tall, density, tint, single } =
      magnetMaterials(ctx, atlas)
    let data = instances(atlas)
    const letterMesh = new Mesh(data.letters, letters)
    const shadowMesh = new Mesh(data.shadows, shadows)
    for (const mesh of [letterMesh, shadowMesh]) mesh.frustumCulled = false
    shadowMesh.renderOrder = -1
    ctx.onDispose(() => {
      ;(ink.value as Texture).dispose()
      ;(bumps.value as Texture).dispose()
    })
    ctx.place(letterMesh, { fit: 'none', replace: true })
    ctx.place(shadowMesh, { fit: 'none' })
    // Compiled here, not in their first frame, which would build them in one long task.
    await ctx.compile(letterMesh)
    if (signal.aborted) return
    await ctx.compile(shadowMesh)
    if (signal.aborted) return

    // The bevels are carved from the atlas when the page is idle.
    let carving: (() => void) | undefined
    const carve = (carved: Atlas): void => {
      carving?.()
      const run = (): void => {
        carving = undefined
        if (signal.aborted || atlas !== carved) return
        const old = bumps.value as Texture
        bumps.value = canvasTexture(relief(carved, bevelOf(carved)), false)
        old.dispose()
        ctx.invalidate()
      }
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: IDLE_TIMEOUT })
        carving = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(run, CARVE_DELAY)
        carving = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => carving?.())
    carve(atlas)

    let dom: boolean | undefined
    let count = atlas.pieces.length
    let rows = lines(atlas)
    let pos = new Float32Array(count * CHANNELS)
    let speed = new Float32Array(count * CHANNELS)
    let goal = new Float32Array(count * CHANNELS)
    const reset = (): void => {
      for (let i = 0; i < count; i++) pos.set(REST, i * CHANNELS)
    }
    reset()
    // Draw order: the lowest letter first, so a raised one covers its neighbours.
    let order: number[] = []
    let biggest = atlas.pieces.reduce((most, piece) => Math.max(most, piece.em), 0)
    // Text of one colour follows its live CSS colour; the last one applied.
    let mono = monochrome(element)
    let lastFill = ''
    let stuck = false
    const computed = getComputedStyle(element)
    const paint = (): void => {
      if (!mono) {
        single.value = 0
        return
      }
      const value = fillOf(computed)
      if (value === lastFill) return
      lastFill = value
      const hex = cssColor(value)
      single.value = hex ? 1 : 0
      if (hex) tint.value.setStyle(hex)
    }

    /** Writes the instances, lowest letter first. */
    const write = (): void => {
      const pieces = atlas?.pieces ?? []
      const next = pieces.map((_, i) => i)
      next.sort(
        (a, b) => (pos[a * CHANNELS + 2] as number) - (pos[b * CHANNELS + 2] as number) || a - b,
      )
      const same = next.length === order.length && next.every((v, i) => v === order[i])
      const boxes = data.box.array as Float32Array
      const units = data.unit.array as Float32Array
      const spots = data.spot.array as Float32Array
      const shifts = data.shift.array as Float32Array
      const turns = data.turn.array as Float32Array
      next.forEach((i, slot) => {
        const piece = pieces[i] as Piece
        const at = i * CHANNELS
        if (!same) {
          boxes.set([piece.x, piece.y, piece.width, piece.height], slot * 4)
          spots.set([piece.u, piece.v], slot * 2)
        }
        units.set([piece.base, piece.em, piece.cx, awake(pos, i, piece.em)], slot * 4)
        shifts.set(
          [pos[at] as number, pos[at + 1] as number, pos[at + 2] as number, pos[at + 6] as number],
          slot * 4,
        )
        turns.set([pos[at + 3] as number, pos[at + 4] as number, pos[at + 5] as number], slot * 3)
      })
      if (!same) {
        data.box.needsUpdate = true
        data.spot.needsUpdate = true
        order = next
      }
      data.unit.needsUpdate = true
      data.shift.needsUpdate = true
      data.turn.needsUpdate = true
    }

    follow(
      ctx,
      ratio,
      () => atlas?.width ?? 0,
      () => dom === true,
      (next) => {
        stuck = !next
        if (!next) return
        const old = data
        data = instances(next)
        letterMesh.geometry = data.letters
        shadowMesh.geometry = data.shadows
        old.letters.dispose()
        old.shadows.dispose()
        const map = canvasTexture(next.canvas, true)
        ;(ink.value as Texture).dispose()
        ink.value = map
        soft.value = map
        carve(next)
        size.value = next.size[0]
        tall.value = next.size[1]
        density.value = next.scale
        atlas = next
        count = next.pieces.length
        rows = lines(next)
        pos = new Float32Array(count * CHANNELS)
        speed = new Float32Array(count * CHANNELS)
        goal = new Float32Array(count * CHANNELS)
        reset()
        order = []
        biggest = next.pieces.reduce((most, piece) => Math.max(most, piece.em), 0)
        mono = monochrome(element)
        lastFill = ''
        write()
      },
    )

    // The pointer in client px while it is near enough to matter, or a finger while it is down.
    let point: { x: number; y: number } | undefined
    let finger: number | undefined
    let rect: DOMRect | undefined
    const near = (x: number, y: number): boolean => {
      rect ??= element.getBoundingClientRect()
      const margin = Math.max(ctx.params.radius, 0) * biggest
      return (
        x > rect.left - margin &&
        x < rect.right + margin &&
        y > rect.top - margin &&
        y < rect.bottom + margin
      )
    }
    const release = (): void => {
      if (!point) return
      point = undefined
      ctx.invalidate()
    }
    const track = (x: number, y: number): void => {
      if (near(x, y)) {
        point = { x, y }
        ctx.invalidate()
      } else release()
    }
    const options = { passive: true, signal }
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'touch' ? e.pointerId === finger : finger === undefined)
          track(e.clientX, e.clientY)
      },
      options,
    )
    element.addEventListener(
      'pointerdown',
      (e) => {
        const down = e as PointerEvent
        if (down.pointerType !== 'touch') return
        // Never prevented: the page scrolls as usual and the browser cancels the pointer then.
        finger = down.pointerId
        track(down.clientX, down.clientY)
      },
      options,
    )
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== finger) return
      finger = undefined
      release()
    }
    addEventListener('pointerup', up, options)
    addEventListener('pointercancel', up, options)
    // The mouse left the window.
    document.documentElement.addEventListener('pointerleave', release, options)
    addEventListener('pointerout', (e) => e.relatedTarget || release(), options)
    addEventListener('blur', release, options)
    // The box moves under a still pointer: measure again and see if it is still near.
    const moved = (): void => {
      rect = undefined
      if (point) track(point.x, point.y)
    }
    addEventListener('scroll', moved, options)
    addEventListener('resize', moved, options)
    write()

    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
      shadowMesh.visible = !value
    }
    show(true)

    return (input): boolean => {
      if (stuck) {
        show(true)
        return false
      }
      const live = ctx.params
      const dt = Math.min(input.delta, MAX_STEP)
      const gone = !element.isConnected
      aim(
        goal,
        atlas?.pieces ?? [],
        rows,
        style,
        live,
        render.camera.position.z || 1000,
        point ? point.x - input.x : 0,
        point ? point.y - input.y : 0,
        !!point && !gone,
        input.x - ctx.app.stage.width.peek() / 2,
      )
      // Every spring moves toward its goal in fixed steps.
      const k = Math.max(live.stiffness, 1)
      const c = Math.max(live.damping, 0)
      const steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / STEP))
      const step = steps ? dt / steps : 0
      let busy = false
      let away = false
      let changed = false
      for (let j = 0; j < count * CHANNELS; j++) {
        const target = goal[j] as number
        const channel = j % CHANNELS
        let x = pos[j] as number
        let v = speed[j] as number
        if (x === target && v === 0) {
          if (x !== REST[channel]) away = true
          continue
        }
        changed = true
        // Semi-implicit Euler on a damped spring.
        for (let s = 0; s < steps; s++) {
          v += (k * (target - x) - c * v) * step
          x += v * step
        }
        if (
          Math.abs(x - target) < (NEAR[channel] as number) &&
          Math.abs(v) < (SLOW[channel] as number)
        ) {
          x = target
          v = 0
        } else busy = true
        pos[j] = x
        speed[j] = v
        if (x !== REST[channel]) away = true
      }
      if (changed) write()
      // Leaving a page the copy fades with it, at rest.
      show(!busy && !away && input.presence >= 1)
      if (!dom) paint()
      return busy
    }
  },
})
export default magnet

/**
 * The letters and their shadows. A letter is a lit slab turned around its middle, its face
 * bevelled once the page is idle; a shadow is the letter's own shape blurred on the page and
 * offset by its height.
 */
function magnetMaterials(ctx: EffectContext<Params>, atlas: Atlas) {
  const { u } = ctx
  // Shared by both draws.
  const size = uniform(atlas.size[0])
  const tall = uniform(atlas.size[1])
  const density = uniform(atlas.scale)
  const tint = uniform(new Color())
  const single = uniform(0)
  const box = attribute(BOX, 'vec4') as unknown as Node<'vec4'>
  const unit = attribute(UNIT, 'vec4') as unknown as Node<'vec4'>
  const spot = attribute(SPOT, 'vec2') as unknown as Node<'vec2'>
  const shift = attribute(SHIFT, 'vec4') as unknown as Node<'vec4'>
  const turn = attribute(TURN, 'vec3') as unknown as Node<'vec3'>
  const half = u.size.mul(0.5)
  const baseline = unit.x
  const em = unit.y
  const centreX = unit.z
  const pivot = baseline.sub(em.mul(MIDDLE))
  const active = unit.w
  const [cosZ, sinZ] = [cos(turn.z), sin(turn.z)]
  const [cosX, sinX] = [cos(turn.x), sin(turn.x)]
  const [cosY, sinY] = [cos(turn.y), sin(turn.y)]
  /** A point of the letter, px from its pivot (y up), turned round z, then x, then y. */
  const turned = (x: F, y: F, z: F): V3 => {
    const x1 = x.mul(cosZ).sub(y.mul(sinZ))
    const y1 = x.mul(sinZ).add(y.mul(cosZ))
    const y2 = y1.mul(cosX).sub(z.mul(sinX))
    const z2 = y1.mul(sinX).add(z.mul(cosX))
    return vec3(x1.mul(cosY).add(z2.mul(sinY)), y2, x1.mul(sinY).negate().add(z2.mul(cosY)))
  }
  /** A direction on the page turned back into the letter's own frame. */
  const local = (v: V3): V3 => {
    const x1 = v.x.mul(cosY).sub(v.z.mul(sinY))
    const z1 = v.x.mul(sinY).add(v.z.mul(cosY))
    const y2 = v.y.mul(cosX).add(z1.mul(sinX))
    const z2 = v.y.mul(sinX).negate().add(z1.mul(cosX))
    return vec3(x1.mul(cosZ).add(y2.mul(sinZ)), x1.mul(sinZ).negate().add(y2.mul(cosZ)), z2)
  }
  /** Box px (y down) of a point `cellX`, `cellY` px into the cell, and its atlas uv. */
  const cell = (cellX: F, cellY: F) => ({
    x: box.x.add(cellX),
    y: box.y.add(cellY),
    uv: vec2(spot.x.add(cellX).div(size), spot.y.add(cellY).div(tall).oneMinus()),
  })
  const boxUV = (x: F, y: F) => varying(vec2(x.div(u.size.x), y.div(u.size.y).oneMinus()))

  // The letters: a lit face over the layers of its sides.
  const layer = positionGeometry.z
  const front = float(1).sub(min(layer, 1))
  const corner = positionGeometry.xy.add(0.5)
  // Idle sides fold to nothing, so a letter at rest is one flat face.
  const fold = mix(min(active.mul(1000), 1), float(1), front)
  const faceX = box.z.mul(corner.x.sub(0.5).mul(fold).add(0.5))
  const faceY = box.w.mul(corner.y.oneMinus().sub(0.5).mul(fold).add(0.5))
  const face = cell(faceX, faceY)
  const depth = layer
    .mul(-THICK / (LAYERS - 1))
    .mul(em)
    .mul(active)
  const turnedFace = turned(
    face.x.sub(centreX).mul(shift.w),
    pivot.sub(face.y).mul(shift.w),
    depth as unknown as F,
  )
  const letters = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  letters.positionNode = vec3(
    centreX.add(shift.x).sub(half.x).add(turnedFace.x),
    half.y.sub(pivot).add(shift.y).add(turnedFace.y),
    shift.z.add(turnedFace.z),
  )
  const faceUV = varying(face.uv)
  const light = vec3(LIGHT.x, LIGHT.y, LIGHT.z)
  const toLight = varying(local(light))
  const halfway = varying(local(normalize(light.add(vec3(0, 0, 1)))))
  const lit = varying(active)
  const isFront = varying(front)
  const ink = texture(canvasTexture(atlas.canvas, true), faceUV)
  const color = sRGBTransferEOTF(ink.rgb.div(max(ink.a, 1e-4))) as V3
  // Text of one colour takes the live CSS colour: a hover colour shows while the letters move.
  const base = mix(color, tint, single) as unknown as V3
  // Flat until the page is idle: the bevels are carved after setup, not in it.
  const bumps = texture(canvasTexture(flat(), false), faceUV)
  const bump = bumps.xy.mul(2).sub(1).mul(lit)
  const normal = normalize(vec3(bump.x, bump.y, 1))
  // A face square to the viewer keeps the CSS colour exactly.
  const diffuse = max(dot(normal, toLight), 0)
    .mul(1 - AMBIENT)
    .add(AMBIENT)
    .div(AMBIENT + (1 - AMBIENT) * LIGHT.z)
  // A glint where a bevel or a turned face catches the light, and a sheen on faces turned to
  // it that shows on black letters too; neither on a face square to the viewer.
  const shine = pow(max(dot(normal, halfway), 0), 160)
    .mul(0.6)
    .add(max(dot(normal, toLight).sub(LIGHT.z), 0).mul(0.12))
    .mul(lit)
  const shaded = min(base.mul(diffuse).add(shine), vec3(1))
  // The sides: the colour in shade, a dark one lightened a little so its edge still reads.
  const luma = dot(base, vec3(0.2126, 0.7152, 0.0722))
  const side = base.mul(0.45).add(luma.oneMinus().mul(0.025))
  letters.colorNode = vec4(
    mix(side, shaded, isFront),
    ink.a.mul(mix(lit, float(1), isFront)).mul(ctx.mask(boxUV(face.x, face.y).clamp(0, 1))),
  )

  // The shadows: each letter's own shape on the page, blurred and offset by its height.
  const height = max(shift.z, 0)
  const blur = height.mul(0.2).add(0.6)
  const reach = blur.mul(2).add(1)
  const groundX = box.z.add(reach.mul(2)).mul(positionGeometry.x.add(0.5)).sub(reach)
  const groundY = box.w.add(reach.mul(2)).mul(positionGeometry.y.add(0.5).oneMinus()).sub(reach)
  const ground = cell(groundX, groundY)
  const turnedGround = turned(
    ground.x.sub(centreX).mul(shift.w),
    pivot.sub(ground.y).mul(shift.w),
    float(0),
  )
  const shadows = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  shadows.positionNode = vec3(
    centreX.add(shift.x).sub(half.x).add(turnedGround.x).add(height.mul(FALL[0])),
    half.y.sub(pivot).add(shift.y).add(turnedGround.y).add(height.mul(FALL[1])),
    0,
  )
  // Read inside the cell only, at a mip level as wide as the blur.
  const inside = cell(groundX.clamp(0, box.z), groundY.clamp(0, box.w))
  const soft = texture(ink.value as Texture, varying(inside.uv)).level(
    varying(log2(max(blur.mul(density), 1))),
  )
  // Under small text a shadow reads as a smudge: it fades out below about 40 px.
  const shade = varying(
    active
      .mul(min(height.div(em.mul(0.12)), 1))
      .mul(em.sub(8).div(32).clamp(0.2, 1))
      .mul(SHADE),
  )
  shadows.colorNode = vec4(
    0.02,
    0.02,
    0.035,
    soft.a.mul(shade).mul(ctx.mask(boxUV(ground.x, ground.y).clamp(0, 1))),
  )
  return { letters, shadows, ink, bumps, soft, size, tall, density, tint, single }
}

/**
 * Writes into `goal` where each letter wants to be for the pointer at box px `pointerX`,
 * `pointerY`; at rest when it is not `on`. `cameraDistance` is the camera's distance from the
 * page and `boxLeft` the box's left edge from the middle of the view, both px.
 */
function aim(
  goal: Float32Array,
  pieces: readonly Piece[],
  rows: number[][],
  style: Style,
  live: EffectContext<Params>['params'],
  cameraDistance: number,
  pointerX: number,
  pointerY: number,
  on: boolean,
  boxLeft: number,
): void {
  const radius = Math.max(live.radius, 1e-3)
  const power = on ? Math.max(live.strength, 0) : 0
  const most = (Math.min(Math.max(live.rotate, 0), 80) * Math.PI) / 180
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as Piece
    const at = i * CHANNELS
    goal.set(REST, at)
    if (!power) continue
    const dx = piece.cx - pointerX
    const dy = piece.base - piece.em * MIDDLE - pointerY
    const distance = Math.hypot(dx, dy)
    // 1 at the pointer, falling smoothly to 0 at `radius` em.
    const falloff = Math.min(1, distance / (radius * piece.em))
    const weight = 1 - falloff * falloff * (3 - 2 * falloff)
    if (weight <= 0) continue
    // From the pointer to the letter, y up; softened near its middle so a letter under the
    // pointer does not flip about.
    const soft = Math.hypot(distance, piece.em * 0.25) || 1
    const ux = dx / soft
    const uy = -dy / soft
    const amount = piece.em * power * weight
    const angle = Math.min(most * power * weight, TILT)
    if (style === 'repel') {
      // Pushed off and up, the side nearest the pointer lifted: the face turns away.
      goal[at] = ux * PUSH * amount
      goal[at + 1] = uy * PUSH * amount
      goal[at + 2] = RISE.repel * amount
      goal[at + 3] = -uy * angle
      goal[at + 4] = ux * angle
      goal[at + 5] = -ux * angle * 0.25
    } else if (style === 'attract') {
      // Drawn in a little, never past the pointer, the face turned to it.
      const pull = Math.min(PULL * amount, distance * 0.4) / soft
      goal[at] = -dx * pull
      goal[at + 1] = dy * pull
      goal[at + 2] = RISE.attract * amount
      goal[at + 3] = uy * angle
      goal[at + 4] = -ux * angle
      goal[at + 5] = ux * angle * 0.2
    } else if (style === 'lift') {
      // Raised toward the viewer and a little larger, the face tipped to the pointer.
      goal[at + 2] = RISE.lift * amount
      goal[at + 3] = uy * angle * 0.35
      goal[at + 4] = -ux * angle * 0.35
      goal[at + 6] = 1 + GROW * power * weight
    } else {
      // Each letter flies off at its own angle, height and spin.
      const bend = (hash(i, 1) - 0.5) * 0.9
      const far = DRIFT * amount * (0.6 + 0.8 * hash(i, 2))
      const cosBend = Math.cos(bend)
      const sinBend = Math.sin(bend)
      goal[at] = (ux * cosBend - uy * sinBend) * far
      goal[at + 1] = (ux * sinBend + uy * cosBend) * far
      goal[at + 2] = RISE.scatter * amount * (0.5 + hash(i, 4))
      goal[at + 3] = (hash(i, 5) * 2 - 1) * angle * 1.1
      goal[at + 4] = (hash(i, 6) * 2 - 1) * angle * 1.1
      goal[at + 5] = (hash(i, 3) * 2 - 1) * angle * 0.8
    }
  }
  if (!power || style === 'scatter') return
  if (style === 'lift') dock(goal, pieces, rows, cameraDistance, boxLeft, pointerX)
  else keepApart(goal, pieces, rows, style === 'attract', cameraDistance, boxLeft, pointerX)
}

/**
 * Seen on the page, a pushed or raised letter must not run over its neighbours: walking out from
 * the pointer, each one keeps its distance, grown by perspective.
 */
function keepApart(
  goal: Float32Array,
  pieces: readonly Piece[],
  rows: number[][],
  attract: boolean,
  distance: number,
  boxLeft: number,
  pointerX: number,
): void {
  for (const row of rows) {
    const count = row.length
    // Each letter's x on screen, its size there and its perspective scale.
    const onScreen = new Float64Array(count)
    const size = new Float64Array(count)
    const depth = new Float64Array(count)
    row.forEach((i, r) => {
      const at = i * CHANNELS
      const z = Math.min(goal[at + 2] as number, distance * 0.5)
      depth[r] = distance / (distance - z)
      size[r] = (goal[at + 6] as number) * depth[r]
      onScreen[r] = (boxLeft + (pieces[i] as Piece).cx + (goal[at] as number)) * depth[r]
    })
    const before = onScreen.slice()
    // Attract may close a quarter of a word gap, so words never run together; repel keeps it.
    const spacing = (r: number): number => {
      const left = pieces[row[r - 1] as number] as Piece
      const right = pieces[row[r] as number] as Piece
      const rest = right.cx - left.cx
      const gap = attract ? rest - (rest - Math.min(rest, (left.span + right.span) / 2)) / 4 : rest
      return (gap * ((size[r] as number) + (size[r - 1] as number))) / 2
    }
    // The first letter right of the pointer: the pair around it share any shortfall.
    let pivot = row.findIndex((i) => (pieces[i] as Piece).cx >= pointerX)
    if (pivot < 0) pivot = count
    if (pivot > 0 && pivot < count) {
      const short = spacing(pivot) - ((onScreen[pivot] as number) - (onScreen[pivot - 1] as number))
      if (short > 0) {
        onScreen[pivot] = (onScreen[pivot] as number) + short / 2
        onScreen[pivot - 1] = (onScreen[pivot - 1] as number) - short / 2
      }
    }
    for (let r = Math.max(pivot, 0) + 1; r < count; r++)
      onScreen[r] = Math.max(onScreen[r] as number, (onScreen[r - 1] as number) + spacing(r))
    for (let r = pivot - 2; r >= 0; r--)
      onScreen[r] = Math.min(onScreen[r] as number, (onScreen[r + 1] as number) - spacing(r + 1))
    row.forEach((i, r) => {
      if (onScreen[r] === before[r]) return
      goal[i * CHANNELS] =
        (onScreen[r] as number) / (depth[r] as number) - boxLeft - (pieces[i] as Piece).cx
    })
  }
}

/**
 * A dock: letters that come closer look larger, and their neighbours along the line make room
 * for them while the letter under the pointer stays put.
 */
function dock(
  goal: Float32Array,
  pieces: readonly Piece[],
  rows: number[][],
  distance: number,
  boxLeft: number,
  pointerX: number,
): void {
  /** How much larger a letter looks than at rest, perspective and growth together. */
  const grown = (i: number): number => {
    const z = Math.min(goal[i * CHANNELS + 2] as number, distance * 0.5)
    return ((goal[i * CHANNELS + 6] as number) * distance) / (distance - z) - 1
  }
  for (const row of rows) {
    // The growth left of the pointer, which the row shifts back so that point stays.
    let fixed = 0
    for (const i of row) {
      const piece = pieces[i] as Piece
      const left = piece.cx - piece.span / 2
      const share = Math.min(1, Math.max(0, (pointerX - left) / (piece.span || 1)))
      fixed += piece.span * grown(i) * share
    }
    let sum = 0
    for (const i of row) {
      const piece = pieces[i] as Piece
      const extra = piece.span * grown(i)
      // Perspective already moves a raised letter out from the middle of the view: the shift
      // is what is left to put it where the dock wants it.
      const z = Math.min(goal[i * CHANNELS + 2] as number, distance * 0.5)
      const rest = boxLeft + piece.cx
      goal[i * CHANNELS] = ((rest + sum + extra / 2 - fixed) * (distance - z)) / distance - rest
      sum += extra
    }
  }
}

/** How far letter `i` is from rest, 0..1: its depth cues fade in with it. */
function awake(pos: Float32Array, i: number, size: number): number {
  const at = i * CHANNELS
  const far = Math.max(
    Math.hypot(pos[at] as number, pos[at + 1] as number) / (size * 0.15),
    Math.abs(pos[at + 2] as number) / (size * 0.12),
    Math.abs(pos[at + 3] as number) / 0.2,
    Math.abs(pos[at + 4] as number) / 0.2,
    Math.abs(pos[at + 5] as number) / 0.3,
    Math.abs((pos[at + 6] as number) - 1) / 0.08,
  )
  const t = Math.min(1, far)
  return t * t * (3 - 2 * t)
}

/** A number in 0..1 for a letter and a channel, the same on every load. */
function hash(i: number, salt: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Indices of the pieces of each line, left to right. */
function lines(atlas: Atlas): number[][] {
  const found = new Map<number, number[]>()
  atlas.pieces.forEach((piece, i) => {
    const line = found.get(piece.line) ?? []
    line.push(i)
    found.set(piece.line, line)
  })
  for (const line of found.values())
    line.sort((i, j) => (atlas.pieces[i]?.cx ?? 0) - (atlas.pieces[j]?.cx ?? 0))
  return [...found.values()]
}

/** A quad per layer, z its layer: the back layers come first, so the face draws over the sides. */
function slab(): [BufferAttribute, BufferAttribute] {
  const position: number[] = []
  const index: number[] = []
  for (let layer = LAYERS - 1, quad = 0; layer >= 0; layer--, quad++) {
    position.push(-0.5, 0.5, layer, 0.5, 0.5, layer, -0.5, -0.5, layer, 0.5, -0.5, layer)
    const first = quad * 4
    index.push(first, first + 2, first + 1, first + 2, first + 3, first + 1)
  }
  return [
    new BufferAttribute(new Float32Array(position), 3),
    new BufferAttribute(new Uint16Array(index), 1),
  ]
}

function instances(atlas: Atlas): Instances {
  const count = Math.max(1, atlas.pieces.length)
  const make = (size: number): InstancedBufferAttribute => {
    const buffer = new InstancedBufferAttribute(new Float32Array(count * size), size)
    buffer.setUsage(DynamicDrawUsage)
    return buffer
  }
  const parts = { box: make(4), unit: make(4), spot: make(2), shift: make(4), turn: make(3) }
  const geometry = ([position, index]: [BufferAttribute, BufferAttribute]) => {
    const shared = new InstancedBufferGeometry()
    shared.setIndex(index)
    shared.setAttribute('position', position)
    shared.setAttribute(BOX, parts.box)
    shared.setAttribute(UNIT, parts.unit)
    shared.setAttribute(SPOT, parts.spot)
    shared.setAttribute(SHIFT, parts.shift)
    shared.setAttribute(TURN, parts.turn)
    shared.instanceCount = atlas.pieces.length
    return shared
  }
  const quad: [BufferAttribute, BufferAttribute] = [
    new BufferAttribute(
      new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]),
      3,
    ),
    new BufferAttribute(new Uint16Array([0, 2, 1, 2, 3, 1]), 1),
  ]
  return { ...parts, letters: geometry(slab()), shadows: geometry(quad) }
}

/** A canvas as a texture; the atlas is premultiplied, so mip levels do not darken its edges. */
function canvasTexture(canvas: HTMLCanvasElement, premultiplied: boolean): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = premultiplied
  return map
}

/** Bevel width in px for the largest font of the atlas. */
function bevelOf(atlas: Atlas): number {
  return BEVEL * atlas.pieces.reduce((most, piece) => Math.max(most, piece.em), 1)
}
