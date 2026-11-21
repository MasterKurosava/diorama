// A label image wrapped around a can, a bottle or a jar, which turns to show the whole label.
import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  atan,
  clamp,
  dFdx,
  dFdy,
  float,
  mix,
  modelWorldMatrix,
  normalize,
  normalLocal,
  positionLocal,
  reflect,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  Vector2,
} from 'three/webgpu'
import { glass, glint, metal, printed, toEye } from './sheen'
import { dissolve, Pointer, sharpen, shadow as softShadow } from './studio'
import { Turn } from './turn'

export type Style = 'can' | 'bottle' | 'jar'
type Params = {
  style: ChoiceParam<Style>
  color: string
  cap: string
  yaw: number
  pitch: number
  tilt: number
  turn: number
  spin: number
  gloss: number
  drag: boolean
  shadow: number
}
type F = Node<'float'>
type V3 = Node<'vec3'>

const TAU = Math.PI * 2
const DEG = Math.PI / 180
/** Pitch limit of a drag, the keys and the rest pose. */
const PITCH = 35 * DEG
/** One arrow key press. */
const STEP = Math.PI / 4
/** Seconds the idle spin waits after the last touch. */
const QUIET = 1.5
/** Knurled ridges around a jar's lid. */
const KNURLS = 180
/** Segments of the turned body around its axis. */
const SEGMENTS = 96
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Half-life of the lean toward the pointer, s. */
const TILT_HALF_LIFE = 0.12
/** Below this a motion counts as settled. */
const EPSILON = 1e-4

/**
 * A container one unit tall: its profile from the bottom centre up to the top centre as radius
 * and height pairs, the band the label may take, where the cap begins and the default colours.
 * Proportions of a 330 ml can, a 750 ml wine bottle and a 250 ml jar.
 */
export interface Shape {
  readonly radius: number
  readonly profile: readonly (readonly [number, number])[]
  readonly band: readonly [number, number]
  readonly cap: number
  readonly color: string
  readonly capColor: string
}

export const SHAPES: Readonly<Record<Style, Shape>> = {
  can: {
    radius: 0.287,
    profile: [
      [0, 0.035],
      [0.2, 0.018],
      [0.235, 0],
      [0.262, 0.012],
      [0.287, 0.06],
      [0.287, 0.9],
      [0.27, 0.935],
      [0.245, 0.965],
      [0.248, 0.985],
      [0.24, 0.993],
      [0.228, 0.978],
      [0, 0.978],
    ],
    band: [0.07, 0.89],
    cap: 0.93,
    color: '#c9ccd2',
    capColor: '#c9ccd2',
  },
  bottle: {
    radius: 0.13,
    profile: [
      [0, 0.02],
      [0.1, 0],
      [0.123, 0.004],
      [0.13, 0.02],
      [0.13, 0.62],
      [0.126, 0.66],
      [0.11, 0.71],
      [0.08, 0.75],
      [0.055, 0.78],
      [0.045, 0.81],
      [0.042, 0.93],
      [0.046, 0.94],
      [0.046, 0.965],
      [0.042, 0.975],
      [0, 0.975],
    ],
    band: [0.1, 0.52],
    cap: 0.84,
    color: '#1f3a26',
    capColor: '#2b2a30',
  },
  jar: {
    radius: 0.42,
    profile: [
      [0, 0],
      [0.39, 0],
      [0.42, 0.03],
      [0.42, 0.74],
      [0.41, 0.78],
      [0.37, 0.81],
      [0.35, 0.83],
      [0.375, 0.83],
      [0.385, 0.845],
      [0.385, 0.97],
      [0.37, 0.99],
      [0, 0.995],
    ],
    band: [0.12, 0.7],
    cap: 0.828,
    color: '#7a4a1c',
    capColor: '#1e1e22',
  },
}

/**
 * Where a label of `aspect` (width over height) lies on `shape`: the band's bottom and top and
 * the angle it wraps. It keeps its proportions: the band's height, and the angle that width
 * takes around the body; a label too long for one turn gets a lower band instead.
 */
export function placement(shape: Shape, aspect: number): [number, number, number] {
  const [bottom, top] = shape.band
  const wrap = (Math.max(0.05, aspect) * (top - bottom)) / shape.radius
  if (wrap <= TAU) return [bottom, top, wrap]
  const height = ((top - bottom) * TAU) / wrap
  const middle = (bottom + top) / 2
  return [middle - height / 2, middle + height / 2, TAU]
}

/**
 * A label image wrapped around a can, a bottle or a jar, at the angle its width takes around the
 * body: the whole label shows as it turns with a drag, the scroll or on its own.
 */
const label: Effect<Params> = defineEffect({
  name: 'label',
  params: {
    style: oneOf('can', 'bottle', 'jar'),
    color: '',
    cap: '',
    yaw: 0,
    pitch: 8,
    tilt: 6.9,
    turn: 180,
    spin: 0,
    gloss: 0.5,
    drag: true,
    shadow: 0.5,
  },
  rebuild: ['color', 'cap'],
  media: true,
  bleed: 80,
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, element, params } = ctx
    const el = element as HTMLElement
    const style = params.style
    const shape = SHAPES[style]
    const mask = dissolve(u)
    sharpen(ctx.map, ctx.render.renderer)

    const colorOf = (value: string, fallback: string): V3 => {
      const parsed = new Color().setStyle(cssColor(value, element) ?? fallback)
      return vec3(parsed.r, parsed.g, parsed.b) as unknown as V3
    }
    const body = colorOf(params.color, shape.color)
    const capTint = colorOf(params.cap, shape.capColor)

    // The label's band and angle follow the picture's proportions.
    const image = ctx.map.image as { width?: number; height?: number } | undefined
    const aspectOf = (): number => (image?.width || 3) / (image?.height || 1)
    const band = uniform(new Vector2(0, 1))
    const angle = uniform(TAU)
    const placeLabel = (): void => {
      const [bottom, top, wrap] = placement(shape, aspectOf())
      ;(band.value as Vector2).set(bottom, top)
      angle.value = wrap
    }
    placeLabel()

    // The label's UV from the angle around the body and the height in its band.
    const y = positionLocal.y.add(0.5)
    const theta = atan(positionLocal.x, positionLocal.z) as unknown as F
    // The same angle cut at the front, for the gradients where the first one wraps at the back.
    const behind = atan(positionLocal.x.negate(), positionLocal.z.negate()) as unknown as F
    const span = (angle as unknown as F).max(1e-3)
    const bandNode = band as unknown as Node<'vec2'>
    const labelU = theta.div(span).add(0.5)
    const labelV = y.sub(bandNode.x).div(bandNode.y.sub(bandNode.x))
    // Explicit gradients, so the mip level does not jump where the angle wraps.
    const back = abs(theta).greaterThan(Math.PI / 2)
    const dUdx = select(back, dFdx(behind), dFdx(theta)).div(span)
    const dUdy = select(back, dFdy(behind), dFdy(theta)).div(span)
    const labelUV = vec2(labelU, labelV)
    const art = texture(ctx.map, clamp(labelUV, 0, 1)).grad(
      vec2(dUdx, dFdx(labelV)),
      vec2(dUdy, dFdy(labelV)),
    )
    const inside = step(0, labelU)
      .mul(step(labelU, 1))
      .mul(step(0, labelV))
      .mul(step(labelV, 1)) as unknown as F
    const cover = inside.mul(art.a) as unknown as F

    // Knurled ridges on a jar's lid, the body as the profile has it elsewhere.
    const lid = step(shape.cap, y) as unknown as F
    let local = normalize(normalLocal) as unknown as V3
    if (style === 'jar') {
      const ridge = sin(theta.mul(KNURLS))
        .mul(0.35)
        .mul(lid)
        .mul(smoothstep(0.6, 0.2, abs(local.y)))
      local = normalize(
        local.add(vec3(positionLocal.z, 0, positionLocal.x.negate()).mul(ridge.mul(-3))),
      )
    }
    const n = normalize(modelWorldMatrix.mul(vec4(local, 0)).xyz) as unknown as V3
    const gloss = u.gloss as unknown as F
    let shell: V3
    if (style === 'can') shell = metal(body, n, 0.18)
    else shell = glass(body, n, style === 'jar' ? 0.75 : 0.4)
    const cap = style === 'jar' ? printed(capTint, n, 0.5) : metal(capTint, n, 0.3)
    shell = mix(shell, cap, lid) as unknown as V3
    // The print: matte paper on glass, ink on metal for a can, with the studio's shine on top.
    const reflected = reflect(toEye().negate(), n) as unknown as V3
    const print = printed(
      art.rgb as unknown as V3,
      n,
      gloss.mul(style === 'can' ? 0.35 : 0.15),
    ).add(
      glint(reflected)
        .mul(gloss)
        .mul(style === 'can' ? 0.45 : 0.2),
    )
    const material = new MeshBasicNodeMaterial()
    material.colorNode = vec4(mix(shell, print, cover.mul(float(1).sub(lid))), 1)
    material.maskNode = mask
    material.side = DoubleSide
    ctx.onDispose(() => material.dispose())

    // The profile turned around the axis, centred on its height.
    const points = shape.profile.map(([x, h]) => new Vector2(x, h - 0.5))
    const geometry = new LatheGeometry(points, SEGMENTS, Math.PI)
    const root = new Group()
    const pivot = new Group()
    root.add(pivot)
    pivot.add(new Mesh(geometry, material))
    ctx.place(root, { fit: 'none', replace: true })
    const shade = softShadow(u)
    ctx.place(shade.mesh, { fit: 'none' })
    await ctx.compile(root)
    if (signal.aborted) return

    const turn = new Turn(el, signal, {
      input: ctx.input,
      enabled: () => ctx.params.drag,
      pitch: PITCH,
      step: STEP,
      wake: () => ctx.invalidate(),
    })
    const pointer = new Pointer(element, signal, () => ctx.invalidate(), true)
    const hoverable = matchMedia('(hover: hover)').matches

    let tiltX = 0
    let tiltY = 0
    let quiet = 0
    let spun = 0
    return (now): boolean => {
      const p = ctx.params
      const reduced = now.reducedMotion
      const dt = Math.min(now.delta, MAX_STEP)
      const aim = hoverable && !reduced && p.tilt > 0 && !turn.held ? pointer.aim(now) : undefined
      const aimX = aim ? aim[0] * p.tilt * DEG : 0
      const aimY = aim ? -aim[1] * p.tilt * DEG * 0.5 : 0
      const ease = (value: number, target: number): number => {
        if (reduced) return target
        return damp(value, target, TILT_HALF_LIFE, dt, EPSILON)
      }
      if (tiltX !== aimX) tiltX = ease(tiltX, aimX)
      if (tiltY !== aimY) tiltY = ease(tiltY, aimY)
      const coasting = turn.advance(dt, reduced)
      const near = aim !== undefined || pointer.focused
      const idle = p.spin !== 0 && !reduced && !turn.held && !near
      if (!idle) quiet = p.spin !== 0 && !reduced ? QUIET : 0
      else if (quiet > 0) quiet = Math.max(0, quiet - dt)
      const spinning = idle && quiet === 0
      if (spinning) spun = (spun + p.spin * DEG * dt) % TAU
      const scroll = !reduced && p.turn !== 0 ? p.turn * DEG * (now.progress - 0.5) : 0
      const yaw = p.yaw * DEG + turn.yaw + spun + scroll + tiltX
      const rest = Math.max(-PITCH, Math.min(PITCH, p.pitch * DEG))
      const pitch = Math.max(-PITCH, Math.min(PITCH, rest + turn.pitch + tiltY))
      pivot.rotation.set(pitch, yaw, 0)
      // Fits the box in its rest pitch: the top's ellipse adds to the height.
      const radius = shape.radius
      const tall = Math.cos(rest) + 2 * radius * Math.abs(Math.sin(rest))
      const s = Math.min((now.height || 1) / tall, (now.width || 1) / (2 * radius)) * 0.94
      root.scale.setScalar(s * (0.96 + 0.04 * now.presence))
      // A flat ellipse under the base.
      const foot = (-0.5 * Math.cos(pitch) + radius * Math.sin(Math.abs(pitch)) * 0.3) * s
      shade.set(
        2 * radius * s * 1.04,
        2 * radius * s * 0.3,
        radius * s * 0.3,
        0,
        foot,
        Math.max(4, 0.06 * s),
        Math.max(0, Math.min(1, p.shadow)),
      )
      const busy = spinning || coasting || tiltX !== aimX || tiltY !== aimY || (idle && quiet > 0)
      // Above the neighbours while it leans toward the pointer.
      const lean = Math.min(1, (Math.abs(tiltX) + Math.abs(tiltY)) / Math.max(p.tilt * DEG, 1e-3))
      if (lean > 0) ctx.pose(ctx.layer, { above: 1 }, lean)
      return busy
    }
  },
})
export default label
