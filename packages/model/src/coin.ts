// A coin, a medal or a token struck from one or two pictures, which turns, catches the light and
// flips over on a click.
import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp, ease } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  clamp,
  float,
  fract,
  length,
  mix,
  modelWorldMatrix,
  normalize,
  normalLocal,
  positionLocal,
  reflect,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  Group,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector2,
} from 'three/webgpu'
import { slab } from './shapes'
import { glint, metal, printed, toEye } from './sheen'
import { dissolve, isUrl, Pointer, sharpen, shadow as softShadow } from './studio'
import { Turn } from './turn'

export type Style = 'coin' | 'medal' | 'token'
export type Motion = 'flip' | 'toss' | 'none'
type Params = {
  style: ChoiceParam<Style>
  motion: ChoiceParam<Motion>
  back: string
  metal: ColorParam
  ink: number
  relief: number
  yaw: number
  pitch: number
  tilt: number
  turn: number
  spin: number
  drag: boolean
  shadow: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>

const TAU = Math.PI * 2
const DEG = Math.PI / 180
/** Pitch limit of a drag, the keys and the rest pose. */
const PITCH = 70 * DEG
/** One arrow key press. */
const STEP = Math.PI / 4
/** Seconds of a flip and of a toss. */
const FLIP = 0.7
const TOSS = 1.15
/** Whole turns of a toss before it lands on the other face, and its height in diameters. */
const TUMBLES = 2
const HEIGHT = 0.7
/** Seconds the idle spin waits after the last touch. */
const QUIET = 1.5
/** Reeds around the edge of a coin. */
const REEDS = 140
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Half-life of the lean toward the pointer, s. */
const TILT_HALF_LIFE = 0.12
/** Below this a motion counts as settled. */
const EPSILON = 1e-4

/** Thickness, bevel, rim width and rim height of each style, in diameters. */
export const SHAPES: Readonly<
  Record<Style, { depth: number; edge: number; rim: number; lift: number }>
> = {
  coin: { depth: 0.075, edge: 0.012, rim: 0.045, lift: 0.012 },
  medal: { depth: 0.1, edge: 0.03, rim: 0.085, lift: 0.02 },
  token: { depth: 0.12, edge: 0.04, rim: 0.12, lift: 0.008 },
}

/** A colour param without the light entry's helper. */
const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/**
 * Rotation of the flip part at `t` 0..1 of a turn from face `from` (0 front, 1 back): a flip
 * turns about the vertical, a toss tumbles about the horizontal while it rolls half a turn, so
 * it lands as the flip does, the other face upright. Returns [x, y, z, lift in diameters].
 */
export function flipPose(
  motion: Motion,
  from: number,
  t: number,
): [number, number, number, number] {
  const k = ease('cubicInOut', Math.max(0, Math.min(1, t)))
  if (t >= 1) return [0, (from + 1) * Math.PI, 0, 0]
  if (motion === 'toss') {
    // The tumble slows toward the landing; the height is a parabola over the toss.
    const spin = 1 - (1 - t) * (1 - t)
    const lift = 4 * t * (1 - t) * HEIGHT
    return [spin * (TUMBLES * TAU + Math.PI), from * Math.PI, k * Math.PI, lift]
  }
  return [0, (from + k) * Math.PI, 0, 0]
}

/**
 * A coin, a medal or a token struck from one or two pictures: a logo or a photo on a metal disc
 * with a rim, that turns under a drag, the scroll or on its own, catches the light and flips on
 * a click.
 */
const coin: Effect<Params> = defineEffect({
  name: 'coin',
  params: {
    style: oneOf('coin', 'medal', 'token'),
    motion: oneOf('flip', 'toss', 'none'),
    back: '',
    metal: color('#d4af5f'),
    ink: 1,
    relief: 0.6,
    yaw: 0,
    pitch: 0,
    tilt: 14.3,
    turn: 0,
    spin: 0,
    drag: true,
    shadow: 0.5,
  },
  rebuild: ['back'],
  media: true,
  bleed: 120,
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, element, params } = ctx
    const el = element as HTMLElement
    const style = params.style
    const motion = params.motion
    const shape = SHAPES[style]
    const plastic = style === 'token'
    const mask = dissolve(u)
    sharpen(ctx.map, ctx.render.renderer)

    let backMap: Texture | undefined
    if (params.back && isUrl(params.back)) {
      try {
        backMap = await ctx.texture(params.back)
        sharpen(backMap, ctx.render.renderer)
      } catch (error) {
        if (signal.aborted) throw error
        ctx.app.log.warn(`coin: ${params.back} did not load, the front shows on the back`, error)
      }
    }
    const css = params.back && !isUrl(params.back) ? cssColor(params.back, element) : undefined
    const backColor = css ? new Color().setStyle(css) : undefined

    // The disc is the square in the middle of the box: `span` maps its UV to the box's.
    const span = uniform(new Vector2(1, 1))
    const boxUV = (q: V2): V2 => q.sub(0.5).mul(span).add(0.5) as unknown as V2
    /** Step for the relief's slope: about a texel and a quarter of the picture. */
    const texel = (map: Texture): number => {
      const image = map.image as { width?: number; height?: number } | undefined
      return 1.25 / Math.max(64, image?.width ?? 512, image?.height ?? 512)
    }
    const tint = u.metal as unknown as V3
    const ink = u.ink as unknown as F
    const relief = u.relief as unknown as F
    const faceRadius = 0.5 - shape.edge
    const rimInner = faceRadius - shape.rim
    /** Height of the face at `q`: the picture's opaque parts and the rim stand out. */
    const height = (alpha: F, q: V2): F => {
      const ring = smoothstep(rimInner - 0.012, rimInner, length(q.sub(0.5)))
      return relief.mul(alpha.mul(0.6).add(ring.mul(float(1).sub(alpha)))).mul(shape.lift / 0.6)
    }
    /** One face of the disc: `sample` reads its picture at disc UV; `facing` +1 front, -1 back. */
    const face = (sample: (q: V2) => Node<'vec4'>, delta: number, facing: 1 | -1): Material => {
      const q = uv()
      const picture = sample(q)
      const alpha = picture.a as unknown as F
      // The relief's slope by central differences, tipping the flat face's normal.
      const heightAt = (at: V2): F => height(sample(at).a as unknown as F, at)
      const acrossX = heightAt(q.add(vec2(delta, 0))).sub(heightAt(q.sub(vec2(delta, 0))))
      const acrossY = heightAt(q.add(vec2(0, delta))).sub(heightAt(q.sub(vec2(0, delta))))
      const slopeX = acrossX.div(2 * delta)
      const slopeY = acrossY.div(2 * delta)
      const local =
        facing > 0 ? vec3(slopeX.negate(), slopeY.negate(), 1) : vec3(slopeX, slopeY.negate(), -1)
      const n = normalize(modelWorldMatrix.mul(vec4(local, 0)).xyz) as unknown as V3
      const field = plastic ? printed(tint, n, 0.35) : metal(tint, n, style === 'coin' ? 0.35 : 0.1)
      // A glint of the studio on the print as it turns, none facing the viewer.
      const reflected = reflect(toEye().negate(), n) as unknown as V3
      const print = printed(picture.rgb as unknown as V3, n, 0.12).add(glint(reflected).mul(0.1))
      const material = new MeshBasicNodeMaterial()
      material.colorNode = vec4(mix(field, print, alpha.mul(ink)), 1)
      material.maskNode = mask
      return material
    }
    const frontSample = (q: V2): Node<'vec4'> =>
      texture(ctx.map, clamp(ctx.coverUV(boxUV(q)), 0, 1)) as unknown as Node<'vec4'>
    const front = face(frontSample, texel(ctx.map), 1)
    let back: Material
    if (backMap) {
      const fit = ctx.fit(backMap, { fit: 'cover' })
      back = face((q) => fit.sample(boxUV(q)), texel(backMap), -1)
    } else if (backColor) {
      const plain = vec4(backColor.r, backColor.g, backColor.b, 0)
      back = face(() => plain as unknown as Node<'vec4'>, 0.002, -1)
    } else back = face(frontSample, texel(ctx.map), -1)

    // The edge: reeded on a coin, polished on a medal, striped on a token.
    const side = ((): Material => {
      const baseNormal = normalize(normalLocal)
      const radial = normalize(vec3(positionLocal.x, positionLocal.y, 0))
      const along = vec3(radial.y.negate(), radial.x, 0)
      // 1 on the straight band of the edge, 0 on the bevels.
      const straight = smoothstep(0.6, 0.3, abs(baseNormal.z))
      const around = uv().x
      let local = baseNormal as unknown as V3
      if (style === 'coin') {
        const reeds = sin(around.mul(TAU * REEDS))
          .mul(0.45)
          .mul(straight)
        local = normalize(baseNormal.add(along.mul(reeds)))
      }
      const n = normalize(modelWorldMatrix.mul(vec4(local, 0)).xyz) as unknown as V3
      let surface: V3
      if (plastic) {
        const stripe = step(0.5, fract(around.mul(8).add(0.25))).mul(straight)
        surface = printed(mix(tint, vec3(0.96, 0.95, 0.92), stripe) as unknown as V3, n, 0.35)
      } else surface = metal(tint, n, style === 'coin' ? 0.25 : 0.05)
      const material = new MeshBasicNodeMaterial()
      material.colorNode = vec4(surface, 1)
      material.maskNode = mask
      return material
    })()
    const materials = [front, back, side]
    ctx.onDispose(() => {
      for (const material of materials) material.dispose()
    })

    const root = new Group()
    const pivot = new Group()
    const flipper = new Group()
    root.add(pivot)
    pivot.add(flipper)
    const disc = new Mesh(slab(1, 1, shape.depth, 0.5, shape.edge, 40, 5), materials)
    flipper.add(disc)
    // Turns about the middle of its thickness, the front face where the image was.
    pivot.position.z = -shape.depth / 2
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
    // A click or Enter turns it over; links and buttons around it keep their clicks.
    let shownFace = 0
    let flip = 1
    const turnOver = (): void => {
      if (motion === 'none' || flip < 1) return
      flip = 0
      ctx.invalidate()
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, fn, { signal })
    listen('click', () => {
      if (!turn.dragged && !el.closest('a[href], button')) turnOver()
      turn.dragged = false
    })
    listen('keydown', (e) => {
      if (motion === 'none' || !el.hasAttribute('tabindex')) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      turnOver()
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
      const size = Math.min(now.width, now.height) || 1
      ;(span.value as Vector2).set(size / (now.width || 1), size / (now.height || 1))
      const aim = hoverable && !reduced && p.tilt > 0 && !turn.held ? pointer.aim(now) : undefined
      const aimX = aim ? aim[0] * p.tilt * DEG : 0
      const aimY = aim ? -aim[1] * p.tilt * DEG : 0
      const settle = (value: number, target: number): number => {
        if (reduced) return target
        return damp(value, target, TILT_HALF_LIFE, dt, EPSILON)
      }
      if (tiltX !== aimX) tiltX = settle(tiltX, aimX)
      if (tiltY !== aimY) tiltY = settle(tiltY, aimY)
      const coasting = turn.advance(dt, reduced)
      if (flip < 1) {
        flip = reduced ? 1 : Math.min(1, flip + dt / (motion === 'toss' ? TOSS : FLIP))
        if (flip === 1) shownFace = 1 - shownFace
      }
      const [flipX, flipY, flipZ, lift] =
        flip < 1 ? flipPose(motion, shownFace, flip) : [0, shownFace * Math.PI, 0, 0]
      flipper.rotation.set(flipX, flipY, flipZ)
      flipper.position.y = lift
      // The idle spin waits while the coin is touched, hovered, focused or turning over.
      const near = aim !== undefined || pointer.focused
      const idle = p.spin !== 0 && !reduced && !turn.held && !near && flip === 1
      if (!idle) quiet = p.spin !== 0 && !reduced ? QUIET : 0
      else if (quiet > 0) quiet = Math.max(0, quiet - dt)
      const spinning = idle && quiet === 0
      if (spinning) spun = (spun + p.spin * DEG * dt) % TAU
      const scroll = !reduced && p.turn !== 0 ? p.turn * DEG * (now.progress - 0.5) : 0
      const yaw = p.yaw * DEG + turn.yaw + spun + scroll + tiltX
      const pitch = Math.max(-PITCH, Math.min(PITCH, p.pitch * DEG + turn.pitch + tiltY))
      pivot.rotation.set(pitch, yaw, 0)
      root.scale.setScalar(size * (0.96 + 0.04 * now.presence))

      // The shadow shrinks, softens and fades as a toss lifts the coin.
      const wide = Math.abs(Math.cos(yaw)) + shape.depth * Math.abs(Math.sin(yaw))
      const tall = Math.abs(Math.cos(pitch)) + shape.depth * Math.abs(Math.sin(pitch))
      const up = lift / HEIGHT
      const shadowWidth = Math.max(0.12, wide) * size * 0.94 * (1 - 0.3 * up)
      const shadowHeight = Math.max(0.12, tall) * size * 0.94 * (1 - 0.3 * up)
      shade.set(
        shadowWidth,
        shadowHeight,
        Math.min(shadowWidth, shadowHeight) / 2,
        0,
        -0.02 * size,
        (0.05 + 0.08 * up) * size,
        Math.max(0, Math.min(1, p.shadow)) * (1 - 0.6 * up),
      )
      const busy =
        spinning || coasting || flip < 1 || tiltX !== aimX || tiltY !== aimY || (idle && quiet > 0)
      // Above the neighbours while it leans, flips or flies.
      const raised = Math.max(up, Math.min(1, (Math.abs(tiltX) + Math.abs(tiltY)) * 4))
      if (raised > 0) ctx.pose(ctx.layer, { above: 1 }, Math.min(1, raised + (flip < 1 ? 1 : 0)))
      return busy
    }
  },
})
export default coin
