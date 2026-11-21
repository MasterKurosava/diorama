import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { cornerRadius, ease, radii, roundedBox } from '@dioramajs/effects/kit'
import { abs, clamp, fwidth, max, smoothstep, uniform, uv, vec4 } from 'three/tsl'
import { Mesh, MeshBasicNodeMaterial, type Node, PlaneGeometry, Vector4 } from 'three/webgpu'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Vec4 = Node<'vec4'>
type Params = {
  trigger: ChoiceParam<'hover' | 'interval' | 'view'>
  angle: number
  width: number
  color: ColorParam
  duration: number
  interval: number
  strength: number
}

/** The first timed sweep comes this long after the element shows up, s. */
const FIRST = 0.6

/**
 * Where the band is `t` of the way through a sweep across a box of `width` x `height` px at
 * `angle` (CSS gradient degrees, 90 sweeps left to right): the direction in box px with y up,
 * the band's centre along it and its half width, px.
 */
export function band(
  angle: number,
  share: number,
  width: number,
  height: number,
  t: number,
  out: Vector4 = new Vector4(),
): Vector4 {
  const radians = (angle * Math.PI) / 180
  const dx = Math.sin(radians)
  const dy = Math.cos(radians)
  // Half the length of the box along the sweep.
  const reach = (Math.abs(dx) * width + Math.abs(dy) * height) / 2
  const half = Math.max(1, share * reach)
  const from = -reach - half
  const at = from + 2 * (reach + half) * ease('cubicInOut', t)
  return out.set(dx, dy, at, half)
}

/**
 * A bright band sweeps across the element on hover, on a timer or as it comes into view, clipped
 * to its rounded box: a glint on a call to action, a pricing card or a badge. The element stays
 * DOM; the band draws over it and is gone between sweeps.
 */
const shine: Effect<Params> = defineEffect({
  name: 'shine',
  params: {
    trigger: oneOf('hover', 'interval', 'view'),
    angle: 120,
    width: 0.35,
    color: Object.freeze({ '~kind': 'color', value: '#ffffff' }) as ColorParam,
    duration: 1.1,
    interval: 4,
    strength: 0.5,
  },
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, element, u } = ctx
    const trigger = params.trigger

    // The band as `band` writes it: direction x, y, centre and half width, px.
    const bandState = uniform(new Vector4(1, 0, -1e5, 1))
    const corners = uniform(new Vector4())
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const sweep = bandState as unknown as Vec4
    const size = u.size as unknown as Vec2
    // Px from the box centre, y up.
    const local = uv().sub(0.5).mul(size)
    const fromBand = abs(
      local.x.mul(sweep.x).add(local.y.mul(sweep.y)).sub(sweep.z),
    ) as unknown as Float
    const half = max(sweep.w, 1) as unknown as Float
    // A soft wide sheen with a brighter core.
    const soft = smoothstep(half, 0, fromBand)
    const core = smoothstep(half.mul(0.3), 0, fromBand)
    const alpha = soft.mul(soft).mul(0.7).add(core.mul(0.3)).mul(u.strength)
    // Its own rounded box, per corner and capped like CSS, so a pill's 999px clips right.
    const distance = roundedBox(
      local,
      size.mul(0.5),
      cornerRadius(local, corners as unknown as Vec4),
    )
    const shape = clamp(
      distance
        .div(max(fwidth(distance), 1e-4))
        .negate()
        .add(0.5),
      0,
      1,
    )
    material.colorNode = vec4(u.color, alpha.mul(shape, u.opacity, u.presence).clamp(0, 1))
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    mesh.frustumCulled = false
    ctx.place(mesh)
    await ctx.compile(mesh)
    mesh.visible = false
    if (signal.aborted) return

    let elapsed = 0
    let shown = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    signal.addEventListener('abort', clear)

    /** A sweep is under way, so the update asks for frames. */
    let sweeping = false
    /** A frame of the current sweep has run. */
    let began = false
    const start = (): void => {
      if (sweeping) return
      clear()
      elapsed = 0
      began = false
      ;(corners.value as Vector4).fromArray(radii(element, ctx.input.width, ctx.input.height))
      sweeping = true
      ctx.invalidate()
      // An observer can report the element before the runtime counts its layer as visible, and
      // a frame request is dropped then: ask again on the next few frames until one runs.
      let tries = 0
      const retry = (): void => {
        if (began || signal.aborted || !sweeping || ++tries > 30) return
        ctx.invalidate()
        requestAnimationFrame(retry)
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(retry)
    }
    /** The next timed sweep, while the element is on screen and the tab is open. */
    const schedule = (delay: number): void => {
      clear()
      if (trigger !== 'interval' || !shown || params.interval <= 0 || document.hidden) return
      timer = setTimeout(start, delay * 1000)
    }

    const listen = (target: EventTarget, type: string, fn: (e: Event) => void): void =>
      target.addEventListener(type, fn, { signal, passive: true })
    listen(element, 'pointerenter', (e) => {
      if ((e as PointerEvent).pointerType !== 'touch') start()
    })
    listen(element, 'pointerdown', (e) => {
      if ((e as PointerEvent).pointerType === 'touch') start()
    })
    // Keyboard focus on the element or a control inside it sweeps like a hover.
    listen(element, 'focusin', (e) => {
      const target = e.target as Element
      let visible = true
      try {
        visible = target.matches(':focus-visible')
      } catch {}
      if (visible) start()
    })

    if (trigger !== 'hover' && typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1]
          if (!entry) return
          const root = entry.rootBounds
          const seen =
            entry.isIntersecting &&
            (entry.intersectionRatio >= 0.5 ||
              (!!root && entry.intersectionRect.height >= 0.5 * root.height))
          if (trigger === 'view') {
            if (!seen) return
            observer.disconnect()
            start()
            return
          }
          if (seen === shown) return
          shown = seen
          if (shown && !sweeping) schedule(FIRST)
          else if (!shown) clear()
        },
        { threshold: [0, 0.25, 0.5] },
      )
      observer.observe(element)
      signal.addEventListener('abort', () => observer.disconnect())
      if (trigger === 'interval') {
        listen(document, 'visibilitychange', () => {
          if (document.hidden) clear()
          else if (!sweeping) schedule(FIRST)
        })
      }
    }

    const value = bandState.value as Vector4
    return (input): boolean => {
      if (!sweeping) {
        mesh.visible = false
        return false
      }
      began = true
      elapsed += input.delta
      const progress = elapsed / Math.max(params.duration, 0.05)
      if (progress >= 1) {
        sweeping = false
        mesh.visible = false
        schedule(params.interval)
        return false
      }
      band(params.angle, params.width, input.width, input.height, progress, value)
      mesh.visible = params.strength > 0
      return true
    }
  },
})
export default shine
