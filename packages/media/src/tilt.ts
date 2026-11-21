import type { Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { noise, oklabToLinear, radii, roundedBox } from '@dioramajs/effects/kit'
import {
  clamp,
  cos,
  dot,
  float,
  fract,
  length,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  sin,
  smoothstep,
  sRGBTransferEOTF,
  sRGBTransferOETF,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { offaxisNode } from './offaxis'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Params = {
  tilt: number
  lift: number
  perspective: number
  ease: number
  glare: number
  foil: number
  mask: string
  shadow: number
  reverse: boolean
  gyro: boolean
}

/** Damping ratio of the springs: a slight overshoot as the card settles. */
const ZETA = 0.75
/** Tilt the light follows when the card itself does not tilt (reduced motion, a small tilt), °. */
const LIGHT_TILT = 10
/** Exponent of the foil's glow around the mirror direction. */
const SHINE = 10
/** Margin of the shadow plane around the card, px. */
const SPREAD = 90
/** Holographic bands per unit of in-plane view and light direction. */
const BANDS = 2.4
/** gyro: a turn of the phone this far, °, leans the card all the way. */
const GYRO = 20
/** gyro: the phone's resting angle catches up with the way it is held over this time, s. */
const DRIFT = 3

/** A damped spring: position and velocity. */
interface Spring {
  x: number
  v: number
}

/**
 * Moves a spring towards `target` over `dt` seconds, exactly for any step. `ease` is about the
 * time it takes to cover 63% of the way; 0 jumps. Returns whether it still moves.
 */
export function spring(s: Spring, target: number, ease: number, dt: number): boolean {
  let offset = s.x - target
  if (ease <= 0 || (Math.abs(offset) < 1e-4 && Math.abs(s.v) < 1e-3)) {
    s.x = target
    s.v = 0
    return false
  }
  if (dt > 0) {
    // The closed form of an underdamped spring: natural and damped angular frequencies, the
    // decay rate, and the cosine and sine parts of the motion now.
    const natural = 1.8 / ease
    const damped = natural * Math.sqrt(1 - ZETA * ZETA)
    const rate = ZETA * natural
    const cosPart = offset
    const sinPart = (s.v + rate * offset) / damped
    const decay = Math.exp(-rate * dt)
    const cosine = Math.cos(damped * dt)
    const sine = Math.sin(damped * dt)
    offset = decay * (cosPart * cosine + sinPart * sine)
    s.v =
      decay *
      ((sinPart * damped - rate * cosPart) * cosine - (cosPart * damped + rate * sinPart) * sine)
    s.x = target + offset
  }
  return true
}

/** `color` screened with `light`: brightens, never past white. */
const screen = (color: V3, light: V3): V3 => color.add(light).sub(color.mul(light)) as unknown as V3

/** The rotation of a card by `rx` around x, then `ry` around y: the inverse turns a world vector into the card's frame. */
function intoCard(v: Vector3, rx: number, ry: number): Vector3 {
  // R = Rx(rx) Ry(ry), so R^T v = Ry(-ry) Rx(-rx) v.
  const cosX = Math.cos(rx)
  const sinX = Math.sin(rx)
  const cosY = Math.cos(ry)
  const sinY = Math.sin(ry)
  const y = v.y * cosX + v.z * sinX
  const z = -v.y * sinX + v.z * cosX
  return v.set(v.x * cosY - z * sinY, y, v.x * sinY + z * cosY)
}

/**
 * A card image tilts toward the pointer in its own perspective and lifts, with glare, an
 * optional holographic foil and a soft shadow. At rest it is the DOM image.
 */
const tilt: Effect<Params> = defineEffect({
  name: 'tilt',
  params: {
    tilt: 12,
    lift: 20,
    perspective: 800,
    ease: 0.12,
    glare: 0.25,
    foil: 0,
    mask: '',
    shadow: 0.35,
    reverse: false,
    gyro: false,
  },
  media: true,
  bleed: 60,
  async setup(ctx: EffectContext<Params>) {
    const { surface, params, signal, element, render, app, u } = ctx

    let mask: Texture | undefined
    let foiled = true
    if (params.mask) {
      try {
        mask = await ctx.texture(params.mask, { colorSpace: 'linear' })
      } catch (error) {
        if (signal.aborted) throw error
        foiled = false
        app.log.warn(`tilt: the foil mask ${params.mask} did not load, the card has no foil`, error)
      }
    }
    const grain = noise(ctx, { size: 128, seed: 7, channels: 4 })

    // cos rx, sin rx, cos ry, sin ry of the drawn tilt.
    const turn = uniform(new Vector4(1, 0, 1, 0))
    // Lift px, light 0..1, card centre in world px.
    const state = uniform(new Vector4())
    const distance = uniform(render.camera.position.z || 1000)
    // The eye and the light in the card's frame, px from its centre (the light's tilt).
    const eye = uniform(new Vector3(0, 0, 800))
    const lamp = uniform(new Vector3(0, 0, 800))
    // Where the eye and the light would be for the card lying flat, for the shading.
    const flatLamp = uniform(new Vector3(0, 0, 800))
    // The centre of the glare in box UV, y up: opposite the pointer.
    const glint = uniform(new Vector2(0.5, 0.5))
    const turnNode = turn as unknown as V4
    const cosX = turnNode.x
    const sinX = turnNode.y
    const cosY = turnNode.z
    const sinY = turnNode.w
    const stateNode = state as unknown as V4
    const size = u.size as unknown as V2

    surface.segments(16)
    surface.position((p) => {
      // As CSS rotateX(rx) rotateY(ry) about the box centre, then lifted, in px with y up.
      const flatX = p.x.mul(size.x)
      const flatY = p.y.mul(size.y)
      const x = flatX.mul(cosY).add(p.z.mul(sinY))
      const turnedZ = p.z.mul(cosY).sub(flatX.mul(sinY))
      const y = flatY.mul(cosX).sub(turnedZ.mul(sinX))
      const z = flatY.mul(sinX).add(turnedZ.mul(cosX)).add(stateNode.x)
      const drawn = offaxisNode(
        vec3(x, y, z) as unknown as V3,
        stateNode.zw,
        u.perspective as unknown as F,
        distance as unknown as F,
      )
      return vec3(drawn.xy.div(size), drawn.z)
    })

    const light = stateNode.y
    surface.color((color, input) => {
      const at = input.box
      // The point on the card, px from its centre, y up: view and light directions from it.
      const point = vec3(at.sub(0.5).mul(size), 0)
      const view = normalize((eye as unknown as V3).sub(point))
      const toward = normalize((lamp as unknown as V3).sub(point))
      // Lambert against the card lying flat: the side turned to the light brightens a little.
      const flat = normalize((flatLamp as unknown as V3).sub(point))
      const shade = toward.z.sub(flat.z).mul(u.glare, 2.5, light).add(1)
      // The glare: a soft spot opposite the pointer, laid over the card the way a white CSS
      // overlay would be, in sRGB, so a dark card is not washed grey by it.
      const spot = pow(clamp(length(at.sub(glint as unknown as V2)).oneMinus(), 0, 1), 3).mul(
        u.glare,
        light,
      )
      const shaded = sRGBTransferOETF(color.rgb.mul(shade) as never) as unknown as V3
      const lit = mix(shaded, vec3(1), spot)
      let rgb = sRGBTransferEOTF(lit as never) as unknown as V3
      if (foiled) {
        // A diffraction foil: the hue follows the in-plane parts of the view and light directions
        // along a grating whose direction and phase wander over the card, so bands of colour
        // sweep across it as it turns. Brightest near the mirror direction.
        const wander = texture(grain, at.mul(size).div(320))
        const angle = wander.r.mul(Math.PI * 3)
        const grating = vec2(cos(angle), sin(angle))
        const phase = dot(view.xy.add(toward.xy), grating).mul(BANDS).add(wander.g.mul(1.6))
        const hue = fract(phase).mul(Math.PI * 2)
        const tint = oklabToLinear(vec3(0.78, cos(hue).mul(0.13), sin(hue).mul(0.13)))
        const where = mask ? texture(mask, clamp(ctx.coverUV(at), 0, 1) as V2).r : float(1)
        const halfway = normalize(view.add(toward))
        const glow = pow(max(halfway.z, 0), SHINE).mul(0.6).add(0.4)
        const strength = smoothstep(0.15, 0.85, wander.b).mul(0.5).add(0.5)
        const amount = strength.mul(glow, where, u.foil, light)
        rgb = screen(rgb, tint.mul(amount) as unknown as V3)
      }
      return vec4(rgb, color.a)
    })

    // The shadow lies on the page under the card: a tight contact shade and a soft ambient one,
    // both rounded boxes of the card blurred by its height, offset against the tilt.
    const fall = uniform(new Vector4())
    const blur = uniform(new Vector4(1, 1, 0, 0))
    const corner = uniform(radii(element, ctx.input.width, ctx.input.height)[0])
    const shadowMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const pad = size.add(SPREAD * 2)
    shadowMaterial.positionNode = vec3(positionLocal.xy.mul(pad).div(size), 0)
    {
      const point = uv().sub(0.5).mul(pad)
      // Offsets of the contact and the ambient shade (xy, zw), and their blurs and strength.
      const fallNode = fall as unknown as V4
      const blurNode = blur as unknown as V4
      const halfSize = size.mul(0.5)
      const shape = (offset: V2, spread: F): F =>
        smoothstep(
          spread,
          spread.negate(),
          roundedBox(point.sub(offset), halfSize, corner as unknown as F),
        )
      const contact = shape(fallNode.xy, blurNode.x as F)
      const ambient = shape(fallNode.zw, blurNode.y as F)
      shadowMaterial.colorNode = vec3(0.02, 0.02, 0.035)
      shadowMaterial.opacityNode = contact
        .mul(0.55)
        .add(ambient.mul(0.6))
        .mul(blurNode.z, u.opacity)
    }
    const shadow = new Mesh(new PlaneGeometry(1, 1), shadowMaterial)
    // Under every copy of its level: lifted with the card above its neighbours, under the card.
    shadow.renderOrder = -1
    shadow.frustumCulled = false
    ctx.place(shadow)
    await ctx.compile(shadow)
    shadow.visible = false
    if (signal.aborted) return

    // The pointer across and up the card, -1..1, and how far the card is lifted, 0..1.
    const tx: Spring = { x: 0, v: 0 }
    const ty: Spring = { x: 0, v: 0 }
    const on: Spring = { x: 0, v: 0 }
    // The pointer in client px while it is over the card, or a finger while it is down.
    let point: { x: number; y: number } | undefined
    let touching = false
    let focused = false
    const wake = (): void => ctx.invalidate()
    const listen = <K extends keyof HTMLElementEventMap>(
      target: Element,
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => target.addEventListener(type, handler as EventListener, { signal })
    const pointAt = (e: PointerEvent): void => {
      point = { x: e.clientX, y: e.clientY }
      wake()
    }
    const off = (): void => {
      point = undefined
      touching = false
      wake()
    }
    listen(element, 'pointerenter', (e) => {
      if (e.pointerType !== 'touch') pointAt(e)
    })
    listen(element, 'pointermove', (e) => {
      if (e.pointerType !== 'touch' || touching) pointAt(e)
    })
    listen(element, 'pointerdown', (e) => {
      if (e.pointerType !== 'touch') return
      // Never prevented: the page scrolls as usual and the browser cancels the pointer then.
      touching = true
      pointAt(e)
    })
    listen(element, 'pointerup', (e) => {
      if (e.pointerType === 'touch') off()
    })
    listen(element, 'pointercancel', off)
    listen(element, 'pointerleave', off)
    // Keyboard focus on the link around the card, or the card itself: a lift without tilt.
    const host = element.closest('a[href], area[href], button, [tabindex]')
    if (host) {
      const check = (): void => {
        let shown = false
        try {
          shown = host.matches(':focus-visible')
        } catch {
          shown = host.matches(':focus')
        }
        if (shown === focused) return
        focused = shown
        wake()
      }
      for (const type of ['focus', 'blur', 'keyup'] as const) listen(host, type, check)
      check()
    }

    // The phone's tilt leans the card where no pointer does: against the angle it is held at,
    // which follows slowly, so a phone held still settles flat.
    let sensed: { x: number; y: number } | undefined
    let held: { x: number; y: number; at: number } | undefined
    let asked = false
    // iOS asks for the motion sensors in the handler of a user activation: a touch's pointerup.
    listen(element, 'pointerup', () => {
      if (asked || !params.gyro) return
      asked = true
      const request = (
        globalThis.DeviceOrientationEvent as unknown as
          | { requestPermission?: () => Promise<string> }
          | undefined
      )?.requestPermission
      if (typeof request === 'function') void request().catch(() => {})
    })
    window.addEventListener(
      'deviceorientation',
      (e) => {
        if (!params.gyro || e.beta === null || e.gamma === null) {
          held = undefined
          if (sensed) wake()
          sensed = undefined
          return
        }
        // Right side down and top away, in the screen's axes however it is turned.
        const screenTurn = ((globalThis.screen?.orientation?.angle ?? 0) * Math.PI) / 180
        const leanX = e.gamma * Math.cos(screenTurn) - e.beta * Math.sin(screenTurn)
        const leanY = -e.gamma * Math.sin(screenTurn) - e.beta * Math.cos(screenTurn)
        const at = e.timeStamp / 1000
        if (!held) held = { x: leanX, y: leanY, at }
        const follow = 1 - Math.exp(-Math.max(0, at - held.at) / DRIFT)
        held = {
          x: held.x + (leanX - held.x) * follow,
          y: held.y + (leanY - held.y) * follow,
          at,
        }
        const unit = (degrees: number): number => Math.max(-1, Math.min(1, degrees / GYRO))
        const next = { x: unit(leanX - held.x), y: unit(leanY - held.y) }
        // A hand is never still: small changes draw nothing.
        const was = sensed ?? { x: 0, y: 0 }
        sensed ??= next
        if (Math.abs(next.x - was.x) + Math.abs(next.y - was.y) < 0.01) return
        sensed = next
        wake()
      },
      { signal },
    )

    const world = { x: 0, y: 0 }
    return (input): boolean => {
      const dt = input.delta
      const still = input.reducedMotion
      // A copy that left with its element flies flat.
      const gone = !element.isConnected
      let aimX = 0
      let aimY = 0
      let goal = 0
      if (point && !gone && input.width && input.height) {
        aimX = Math.max(-1, Math.min(1, ((point.x - input.x) / input.width) * 2 - 1))
        aimY = Math.max(-1, Math.min(1, 1 - ((point.y - input.y) / input.height) * 2))
        goal = 1
      } else if (sensed && !gone) {
        aimX = sensed.x
        aimY = sensed.y
        // Lift and light grow with the lean: a phone held level shows the plain card.
        goal = Math.min(1, Math.hypot(aimX, aimY) * 1.5)
      } else if (focused && !gone) goal = 1
      // A percent radius follows the box: read once as the card starts to move.
      if (goal && !on.x) corner.value = radii(element, input.width, input.height)[0]
      const ease = gone ? 0 : params.ease
      let busy = spring(tx, aimX, ease, dt)
      busy = spring(ty, aimY, ease, dt) || busy
      busy = spring(on, goal, ease, dt) || busy

      // Toward the pointer: its side goes down, away from the viewer; reverse lifts it instead.
      const sign = params.reverse ? -1 : 1
      const deg = Math.PI / 180
      const motion = still ? 0 : 1
      const ry = sign * tx.x * params.tilt * deg * motion
      const rx = -sign * ty.x * params.tilt * deg * motion
      ;(turn.value as Vector4).set(Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry))
      // The spring overshoots a little; the card never sinks below the page.
      const amount = Math.max(0, Math.min(1, on.x))
      const lift = params.lift * amount * motion
      const centre = render.toWorld(input.x + input.width / 2, input.y + input.height / 2, world)
      ;(state.value as Vector4).set(lift, amount, centre.x, centre.y)
      distance.value = render.camera.position.z || 1000

      // The light follows the pointer even where the card does not turn.
      const shine = Math.max(params.tilt, LIGHT_TILT) * deg
      const lightX = -sign * ty.x * shine
      const lightY = sign * tx.x * shine
      const perspective = params.perspective
      // The eye straight in front, the lamp a little above it, both as far as the perspective.
      intoCard((eye.value as Vector3).set(0, 0, perspective - lift), lightX, lightY)
      intoCard(
        (lamp.value as Vector3).set(0, perspective * 0.12, perspective - lift),
        lightX,
        lightY,
      )
      ;(flatLamp.value as Vector3).set(0, perspective * 0.12, perspective - lift)
      ;(glint.value as Vector2).set(0.5 - tx.x / 2, 0.5 - ty.x / 2)

      // The shadow: offset and blur grow with the height, the far side throws it farther.
      const tilted = Math.min(1, Math.hypot(tx.x, ty.x)) * params.tilt * motion
      const away = 0.6 * tilted
      ;(fall.value as Vector4).set(
        -sign * tx.x * away * 0.3,
        -0.2 * lift - 1,
        -sign * tx.x * away,
        -0.7 * lift - sign * ty.x * away - 2,
      )
      ;(blur.value as Vector4).set(
        2 + 0.25 * lift,
        6 + 1.3 * lift + tilted,
        params.shadow * amount,
        0,
      )
      shadow.visible = lift > 0.01 && params.shadow > 0

      // Above the neighbours while lifted or tilted, back on the page once flat.
      if (!still && on.x > 0) ctx.pose(ctx.layer, { above: 1 }, Math.min(1, on.x))
      return busy
    }
  },
})
export default tilt
