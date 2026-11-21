import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { ease, noise } from '@dioramajs/effects/kit'
import { clamp, mix, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl'
import { type Node, Vector2 } from 'three/webgpu'
import { afterDrag } from './click'
import { framing, leases, slots } from './slots'

type V2 = Node<'vec2'>
type Params = {
  index: number
  duration: number
  style: ChoiceParam<'displace' | 'slide' | 'fade' | 'zoom'>
  strength: number
  interval: number
  click: boolean
  swipe: boolean
  loop: boolean
  items: string
  seed: number
}

/** Pointer travel past which a press is a drag and its click does not page, px. */
const DRAG = 10
/** Horizontal travel a swipe needs to page, px. */
const SWIPE = 40
/** Length of a change under reduced motion, a short crossfade, s. */
const REDUCED_DURATION = 0.25

/** A swipe needs the site to keep horizontal pans from the page: `touch-action: pan-y` or none. */
const ownsPan = (el: Element): boolean =>
  !/auto|manipulation|pan-x/.test(getComputedStyle(el).touchAction || 'auto')

/**
 * Shows one of the container's images and changes them with a noisy displacement, a slide, a
 * crossfade or a zoom: by index, click, swipe or timer. Fires `dio:index` on the container when
 * a picture is reached.
 */
const gallery: Effect<Params> = defineEffect({
  name: 'gallery',
  params: {
    index: 0,
    duration: 1.1,
    style: oneOf('displace', 'slide', 'fade', 'zoom'),
    strength: 0.25,
    interval: 0,
    click: true,
    swipe: true,
    loop: true,
    items: 'img',
    seed: 1,
  },
  rebuild: ['seed'],
  on: ':not(img, video)',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u } = ctx
    const el = ctx.element as HTMLElement
    const items = [...el.querySelectorAll(params.items)].filter(
      (node): node is HTMLImageElement => node.localName === 'img',
    )
    const count = items.length
    if (!count) {
      app.log.warn(`gallery: no images match "${params.items}", the container stays as it is`)
      return
    }
    const wrap = (i: number): number => ((i % count) + count) % count
    // Without loop the ends hold: the index stays within the pictures.
    const place = (i: number): number =>
      params.loop ? wrap(i) : Math.min(count - 1, Math.max(0, i))
    const pictures = leases(ctx, (i: number) => items[i] as HTMLImageElement)
    const frame = (i: number) => framing(items[i] as Element)
    const keepAround = (i: number): void => pictures.keep(i, place(i + 1), place(i - 1))

    let shown = place(Math.floor(params.index))
    const first = pictures.get(shown, 'high')
    await first.ready
    if (!first.texture) throw new Error(`gallery: picture ${shown} did not load`)
    keepAround(shown)

    // Slot a shows the current picture, slot b the next; state is (eased progress, forward).
    const pair = slots(ctx, first.texture, frame(shown))
    const { a, b, pick } = pair
    const state = uniform(new Vector2(0, 1))
    const stateNode = state as unknown as V2
    const change = stateNode.x
    const forward = stateNode.y
    const sign = forward.mul(2).sub(1)
    const style = params.style
    const grain = style === 'displace' ? noise(ctx, { seed: params.seed }) : undefined
    ctx.surface.color((_, { uv, radius }) => {
      const fade = pair.fade(uv, change)
      let out = fade
      if (grain) {
        const aspect = u.size.x.div(u.size.y.max(1))
        const grainValue = texture(grain, uv.mul(vec2(aspect, 1)).mul(0.75)).r
        const push = vec2(sign, 0).mul(grainValue, u.strength)
        // A wave with a noisy front sweeps the way the pictures move: in from the right going
        // forward. Mostly the sweep, so it reads as one motion rather than a dissolve.
        const along = mix(uv.x, uv.x.oneMinus(), forward)
        const front = mix(along, grainValue, 0.35)
        const wave = smoothstep(change.sub(0.1), change.add(0.1), front).oneMinus()
        const leaving = pick(a, uv.add(push.mul(change)))
        const entering = pick(b, uv.sub(push.mul(change.oneMinus())))
        out = mix(leaving, entering, wave)
      } else if (style === 'zoom') {
        // The incoming picture settles from 1.15 over the outgoing one, which swells to 1.05.
        const scale = (by: Node<'float'>) => uv.sub(0.5).div(by).add(0.5)
        const leaving = pick(a, scale(change.mul(0.05).add(1)))
        out = mix(leaving, pick(b, scale(change.mul(-0.15).add(1.15))), change)
      } else if (style === 'slide') {
        const width = u.size.x.max(1)
        const enter = uv.sub(vec2(sign.mul(change.oneMinus()), 0))
        // Antialiased edges of the incoming picture, a pixel wide.
        const inside = clamp(enter.x.mul(width).add(0.5), 0, 1).mul(
          clamp(enter.x.oneMinus().mul(width).add(0.5), 0, 1),
        )
        const leaving = pick(a, uv.add(vec2(sign.mul(change).div(3), 0)))
        const dimmed = vec4(leaving.rgb.mul(change.mul(-0.2).add(1)), leaving.a)
        out = mix(dimmed, pick(b, enter), inside)
      }
      // Under reduced motion every change is a short crossfade.
      const color = style === 'fade' ? fade : mix(fade, out, u.motion)
      return vec4(color.rgb, color.a.mul(radius))
    })

    // The index the last frame aimed at, the picture coming in and the change's progress.
    let aim = params.index
    let to = shown
    let progress = 0
    let moving = false
    let scrubbing = false
    const show = (i: number): void => {
      shown = i
      const picture = pictures.peek(i)?.texture
      if (picture) pair.show(picture, frame(i))
      ;(state.value as Vector2).x = 0
      el.dispatchEvent(new CustomEvent('dio:index', { detail: { index: i }, bubbles: true }))
    }

    // Autoplay: every `interval` seconds while nobody hovers, focuses or changes the picture.
    let timer: ReturnType<typeof setTimeout> | undefined
    let armed = 0
    let hovered = false
    let focused = false
    const arm = (): void => {
      clearTimeout(timer)
      timer = undefined
      armed = params.interval
      if (armed > 0 && !app.stage.reducedMotion.peek()) timer = setTimeout(fire, armed * 1000)
    }
    const fire = (): void => {
      timer = undefined
      const idle = !hovered && !focused && document.visibilityState !== 'hidden'
      if (!idle || !ctx.layer.input.visible || moving) arm()
      // At the last picture without loop, the timer stops.
      else if (params.loop || place(Math.round(params.index) + 1) !== shown) step(1)
    }
    const redraw = (): void => ctx.invalidate()
    // Clicks, swipes and the timer move the index itself, so the site reads where it is.
    const step = (by: number): void => {
      const i = Math.round(params.index)
      if (params.loop || place(i + by) !== place(i)) ctx.set({ index: i + by })
    }
    signal.addEventListener('abort', () => clearTimeout(timer))
    // Reduced motion turning on stops the countdown, turning off starts it again.
    ctx.onDispose(app.stage.reducedMotion.subscribe(() => arm()))

    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler, { signal })
    let down: { x: number; y: number; pan: boolean } | undefined
    const drags = afterDrag(el, signal)
    listen('pointerdown', (e) => {
      // Touch and pen swipe; read on each press, since the site may change touch-action.
      const pan = params.swipe && e.pointerType !== 'mouse' && ownsPan(el)
      down = { x: e.clientX, y: e.clientY, pan }
    })
    listen('pointercancel', () => {
      down = undefined
    })
    listen('pointerup', (e) => {
      const from = down
      down = undefined
      if (!from) return
      const dx = e.clientX - from.x
      const dy = e.clientY - from.y
      if (Math.hypot(dx, dy) > DRAG) drags.arm(e)
      if (!from.pan || Math.abs(dx) < SWIPE || Math.abs(dx) < Math.abs(dy)) return
      step(dx < 0 ? 1 : -1)
    })
    listen('click', (e) => {
      if (!params.click || drags.ends(e)) return
      step(1)
    })
    const pointed = (on: boolean) => (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      hovered = on
      if (!on) arm()
    }
    listen('pointerenter', pointed(true))
    listen('pointerleave', pointed(false))
    listen('focusin', () => {
      focused = true
    })
    listen('focusout', (e) => {
      focused = e.relatedTarget instanceof Element && el.contains(e.relatedTarget)
      if (!focused) arm()
    })

    const stateValue = state.value as Vector2
    // A fractional index (a tween): the exact frame between two pictures, without time of its own.
    const scrub = (wanted: number): void => {
      const before = Math.floor(wanted)
      const ends = [place(before), place(before + 1)] as const
      // Slot a keeps showing `shown` until both pictures are in.
      pictures.keep(...ends, shown)
      const [fromTexture, toTexture] = ends.map((i) => pictures.peek(i)?.texture)
      moving = false
      scrubbing = true
      aim = wanted
      if (!fromTexture || !toTexture) {
        for (const i of ends) {
          const lease = pictures.peek(i)
          if (!lease?.failed) void lease?.ready.then(redraw)
        }
        return
      }
      shown = ends[0]
      to = ends[1]
      a.set(fromTexture, frame(shown))
      pair.next(toTexture, frame(to))
      stateValue.set(wanted - before, 1)
    }
    // A tween ended on a picture: it is reached, or changed to below if it is not in yet. True
    // when reached.
    const endScrub = (wanted: number): boolean => {
      scrubbing = false
      aim = wanted
      const end = place(wanted)
      if (!pictures.peek(end)?.texture) return false
      show(end)
      keepAround(end)
      return true
    }
    // Moves the change under way on by a frame. True while it goes on.
    const advance = (input: EffectInput): boolean => {
      const duration = input.reducedMotion ? REDUCED_DURATION : params.duration
      progress += input.delta / Math.max(duration, 1e-3)
      if (progress < 1) {
        stateValue.x = ease('cubicInOut', progress)
        return true
      }
      moving = false
      show(to)
      keepAround(to)
      arm()
      return false
    }
    // Starts the change to `target` once its picture is in.
    const begin = (target: number): void => {
      if (target === shown) return
      pictures.keep(shown, target)
      const next = pictures.get(target)
      if (next.failed) {
        // Skipped: the timer goes on from it to the next picture.
        if (!timer) arm()
        return
      }
      if (!next.texture) {
        // Starts once the picture is in; clicks meanwhile only move the aim.
        void next.ready.then(redraw)
        return
      }
      to = target
      progress = 0
      pair.next(next.texture, frame(to))
      stateValue.x = 0
      moving = true
    }

    return (input): boolean => {
      if (params.interval !== armed) arm()
      const wanted = params.index
      if (!Number.isInteger(wanted)) {
        scrub(wanted)
        return moving
      }
      if (scrubbing && endScrub(wanted)) return moving
      if (moving && advance(input)) return moving
      if (wanted !== aim) {
        stateValue.y = wanted > aim ? 1 : 0
        aim = wanted
      }
      begin(place(aim))
      return moving
    }
  },
})
export default gallery
