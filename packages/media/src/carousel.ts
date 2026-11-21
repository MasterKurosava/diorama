import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { radii } from '@dioramajs/effects/kit'
import { type Card, deck, measure } from './deck'
import { framing, leases } from './slots'
import { track } from './track'

/** Where the viewer stands: before a ring of pictures, or inside one. */
export type CarouselStyle = 'ring' | 'inside'
type Params = {
  index: number
  style: ChoiceParam<CarouselStyle>
  by: ChoiceParam<'drag' | 'scroll'>
  motion: ChoiceParam<'step' | 'drift'>
  interval: number
  radius: 'auto'
  spacing: number
  tilt: number
  focus: number
  shade: number
  reflection: number
  perspective: number
  duration: number
  drag: boolean
  wheel: boolean
  click: boolean
  pause: boolean
  items: string
}

/** Most pictures on the ring: more would crowd it and hold too many textures. */
const MOST = 24
/** After the user's own input, autoplay waits this long, ms. */
const RESUME = 4000

/** A card's place on the ring at angle `theta` from the front, radians. */
export interface RingPose {
  x: number
  z: number
  yaw: number
  /** 0 behind, 1 at the front. */
  front: number
  /** 0 out of sight, 1 in full. */
  alpha: number
}

/** The place on a ring of `radius` px at `theta` radians from the front. */
export function onRing(style: CarouselStyle, theta: number, radius: number): RingPose {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  if (style === 'inside') {
    // The viewer at the centre: the cards face inward and those beside or behind go out of sight.
    const t = Math.min(1, Math.max(0, (cos - 0.15) / 0.3))
    const alpha = t * t * (3 - 2 * t)
    return { x: radius * sin, z: radius * (1 - cos), yaw: -theta, front: cos, alpha }
  }
  return { x: radius * sin, z: radius * (cos - 1), yaw: theta, front: cos, alpha: 1 }
}

/** Radius that keeps `count` cards `width` px wide apart by `spacing` widths, px. */
export const ringRadius = (count: number, width: number, spacing: number): number =>
  Math.max(width * 0.7, (width * (1 + spacing)) / 2 / Math.tan(Math.PI / Math.max(count, 3)))

/** Angle of `offset` places from the front on a ring of `count`, wrapped into -pi..pi. */
const angleOf = (offset: number, count: number): number => {
  const angle = (offset / count) * Math.PI * 2
  return angle - Math.round(angle / (Math.PI * 2)) * Math.PI * 2
}

const PLAY = '<path d="M8 5v14l11-7z"/>'
const HOLD = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>'

/**
 * The pause control autoplay needs (WCAG 2.2.2): a real button after the container, over its
 * bottom right corner, since the copy hides the container with all it holds.
 */
function pauseButton(
  el: HTMLElement,
  signal: AbortSignal,
  canvas: Element,
  toggle: (paused: boolean) => void,
) {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML =
    '<style>:host{position:absolute;width:40px;height:40px}button{display:grid;place-items:center;width:40px;height:40px;padding:0;border:0;border-radius:50%;background:rgb(0 0 0/.45);color:#fff;cursor:pointer}button:focus-visible{outline:2px solid currentColor;outline-offset:2px}svg{width:20px;height:20px;fill:currentColor}</style>' +
    `<button part="pause" type="button" aria-pressed="false" aria-label="Pause"><svg viewBox="0 0 24 24" aria-hidden="true">${HOLD}</svg></button>`
  const button = root.querySelector('button') as HTMLButtonElement
  const icon = root.querySelector('svg') as SVGElement
  let paused = false
  button.addEventListener(
    'click',
    () => {
      paused = !paused
      button.setAttribute('aria-pressed', String(paused))
      icon.innerHTML = paused ? PLAY : HOLD
      toggle(paused)
    },
    { signal },
  )
  host.hidden = true
  el.after(host)
  signal.addEventListener('abort', () => host.remove(), { once: true })
  const place = (): void => {
    if (host.hidden) return
    // 12 px in from the container's bottom right corner, in its containing block's px.
    const block = host.offsetParent as HTMLElement | null
    const positioned = block && getComputedStyle(block).position !== 'static'
    const base = positioned
      ? block.getBoundingClientRect()
      : { left: -scrollX, top: -scrollY, width: 0, height: 0 }
    const rect = el.getBoundingClientRect()
    const left =
      rect.right - base.left - (positioned ? block.clientLeft - block.scrollLeft : 0) - 52
    const top = rect.bottom - base.top - (positioned ? block.clientTop - block.scrollTop : 0) - 52
    host.style.left = `${Math.round(left)}px`
    host.style.top = `${Math.round(top)}px`
    // Above the canvas when it draws over the page.
    const zIndex = Number.parseInt(getComputedStyle(canvas).zIndex, 10)
    if (zIndex >= 0) host.style.zIndex = String(zIndex + 1)
  }
  addEventListener('resize', place, { signal })
  return {
    host,
    get paused() {
      return paused
    },
    show(on: boolean) {
      if (host.hidden !== on) return
      host.hidden = !on
      place()
    },
    place,
  }
}

/**
 * The images of a container on a 3D ring that turns with a drag, a sideways wheel, keys, the
 * page scroll or by itself, the front picture enlarged; a click on a picture turns it to the
 * front, a click on the front one follows its link. Autoplay comes with a pause button and holds
 * under the pointer and focus. Fires `dio:index` when a picture reaches the front.
 */
const carousel: Effect<Params> = defineEffect({
  name: 'carousel',
  params: {
    index: 0,
    style: oneOf('ring', 'inside'),
    by: oneOf('drag', 'scroll'),
    motion: oneOf('step', 'drift'),
    interval: 0,
    radius: 'auto',
    spacing: 0.4,
    tilt: 8,
    focus: 1.15,
    shade: 0.5,
    reflection: 0,
    perspective: 1200,
    duration: 0.7,
    drag: true,
    wheel: true,
    click: true,
    pause: true,
    items: 'img',
  },
  on: ':not(img, video, canvas)',
  // Cards at the sides of the ring and the reflection reach past the box.
  bleed: 240,
  quality: { low: { reflection: 0 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app } = ctx
    const el = ctx.element as HTMLElement
    let items = [...el.querySelectorAll(params.items)].filter(
      (node): node is HTMLImageElement => node.localName === 'img',
    )
    if (!items.length) {
      app.log.warn(`carousel: no images match "${params.items}", the container stays as it is`)
      return
    }
    if (items.length > MOST) {
      app.log.warn(`carousel: ${items.length} images, the ring shows the first ${MOST}`)
      items = items.slice(0, MOST)
    }
    const count = items.length
    const { style, by, motion } = params
    const pictures = leases(ctx, (i: number) => items[i] as HTMLImageElement)
    const frames = items.map((img) => framing(img))

    let sizes = items.map(() => ({ w: 0, h: 0, x: 0, y: 0 }))
    let width = 1
    let height = 1
    let corners: number[] = []
    const remeasure = (): void => {
      sizes = items.map((img) => measure(el, img))
      const known = sizes.filter((size) => size.w > 0 && size.h > 0)
      const fallback = el.clientHeight * 0.6 || 200
      const average = (of: (size: { w: number; h: number }) => number): number =>
        known.length ? known.reduce((sum, size) => sum + of(size), 0) / known.length : fallback
      width = average((size) => size.w)
      height = average((size) => size.h)
      for (const size of sizes) {
        if (size.w > 0 && size.h > 0) continue
        size.w = width
        size.h = height
      }
      corners = sizes.map((size, i) => radii(items[i] as Element, size.w, size.h)[0])
    }
    remeasure()

    // Autoplay: held by the button, the pointer, focus, a hidden page or the user's input.
    let hovered = false
    let focused = false
    let waiting = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const control = pauseButton(el, signal, ctx.render.renderer.domElement, () => {
      clearTimeout(timer)
      timer = undefined
      ctx.invalidate()
    })
    const plays = (): boolean =>
      params.interval > 0 &&
      by === 'drag' &&
      !control.paused &&
      !hovered &&
      !focused &&
      !ctx.input.reducedMotion &&
      document.visibilityState !== 'hidden' &&
      !waiting
    const wake = (): void => {
      // Autoplay comes back once the user's input is old enough.
      waiting = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        waiting = false
        ctx.invalidate()
      }, RESUME)
    }

    let scale = 1
    let ring = ringRadius(count, width, params.spacing)
    const row = track(ctx, {
      items,
      loop: () => true,
      span: () => ((Math.PI * 2 * ring * scale) / count) * 0.8,
      pick: (x, y) => (table.hit(x, y)?.mesh.userData as { at?: number } | undefined)?.at,
      drag: () => params.drag && by === 'drag',
      wheel: () => params.wheel && by === 'drag',
      click: () => params.click && by === 'drag',
      touched: wake,
    })
    let ringOn = false
    const table = deck(ctx, el, (element) => {
      ringOn = Boolean(element)
    })
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler, { signal })
    const hold = (on: boolean) => () => {
      hovered = on
      // Leaving starts a full wait again.
      if (!on) {
        clearTimeout(timer)
        timer = undefined
      }
      ctx.invalidate()
    }
    listen('pointerenter', hold(true))
    listen('pointerleave', hold(false))
    control.host.addEventListener('pointerenter', hold(true), { signal })
    control.host.addEventListener('pointerleave', hold(false), { signal })
    listen('focusin', () => {
      focused = true
    })
    listen('focusout', (e) => {
      focused = e.relatedTarget instanceof Element && el.contains(e.relatedTarget)
      ctx.invalidate()
    })
    document.addEventListener('visibilitychange', () => ctx.invalidate(), { signal })
    ctx.onDispose(() => clearTimeout(timer))

    // Every picture is on the ring; the front ones first.
    const order = (front: number): number[] => {
      const out: number[] = []
      for (let step = 0; out.length < count; step++)
        for (const place of step ? [front + step, front - step] : [front]) {
          const i = row.wrap(place)
          if (!out.includes(i)) out.push(i)
        }
      return out
    }
    let held = Math.round(row.pos)
    pictures.keep(...order(held))
    await Promise.all(
      order(held)
        .slice(0, 3)
        .map((i) => pictures.get(i).ready),
    )
    if (signal.aborted) return
    for (const i of order(held)) {
      const lease = pictures.peek(i)
      if (lease && !lease.texture && !lease.failed) void lease.ready.then(() => ctx.invalidate())
    }

    const cards: Card[] = Array.from({ length: count }, () => table.add())
    ctx.place(table.group, { replace: true, fit: 'none' })
    el.addEventListener(
      'load',
      () => {
        remeasure()
        ctx.invalidate()
      },
      { signal, capture: true },
    )

    // The page scroll turns the ring on from the index the markup gave.
    const start = Math.round(params.index)
    if (params.interval > 0 && !params.pause && by === 'drag') {
      app.log.warn(
        'carousel: autoplay without the pause button: give the page a control of its own that sets interval to 0 (WCAG 2.2.2)',
      )
    }
    let box = { w: 0, h: 0 }
    return (input): boolean => {
      if (input.width !== box.w || input.height !== box.h) {
        box = { w: input.width, h: input.height }
        remeasure()
        control.place()
      }
      const calm = input.reducedMotion
      const auto = plays()
      control.show(params.pause && params.interval > 0 && by === 'drag' && !calm)
      if (by === 'scroll' && !calm) {
        // The page scroll turns the ring once round while the container crosses the viewport.
        const at = start + input.progress * count
        if (Math.abs(at - params.index) > 1e-4) ctx.set({ index: at })
      } else if (auto && motion === 'drift' && !row.busy) {
        // A long gap (a tab in the background) does not jump the ring.
        ctx.set({ index: params.index + Math.min(input.delta, 0.1) / params.interval })
      }
      row.tick(input.delta, calm)
      if (auto && motion === 'step' && !row.busy && !timer) {
        timer = setTimeout(() => {
          timer = undefined
          if (plays()) row.step(1)
          ctx.invalidate()
        }, params.interval * 1000)
      }
      const moving = row.busy || (auto && motion === 'drift')

      // The ring fits the box: a wide one is drawn smaller.
      const perspective = params.perspective
      ring =
        params.radius === 'auto'
          ? ringRadius(count, width, params.spacing)
          : Math.max(1, params.radius)
      // How far the ring's side reaches from the centre, as seen.
      const side =
        style === 'inside' ? 0 : ((ring + width / 2) * perspective) / (perspective + ring)
      scale = side > 0 ? Math.min(1, box.w / 2 / side) : 1
      const radius = ring * scale
      const look = table.look
      look.perspective = perspective
      look.tilt = (params.tilt * Math.PI) / 180
      look.pivot = style === 'inside' ? radius : -radius
      look.reflection = Math.max(0, Math.min(1, params.reflection))
      look.reach = 0.35
      table.frame(input)

      const at = row.pos
      const front = Math.round(at)
      if (front !== held) {
        held = front
        pictures.keep(...order(front))
      }
      const half = Math.floor(count / 2)
      for (let i = 0; i < count; i++) {
        const card = cards[i] as Card
        // The nearest lap of picture i around the position.
        const place = front + (((((i - row.wrap(front)) % count) + count + half) % count) - half)
        const offset = place - at
        const pose = onRing(style, angleOf(offset, count), radius)
        const size = sizes[i] as { w: number; h: number }
        // Only the cards near the front grow by `focus`.
        const facing = Math.max(0, pose.front) ** 6
        card.size.w = size.w
        card.size.h = size.h
        card.radius = corners[i] ?? 0
        Object.assign(card.pose, {
          x: pose.x,
          y: 0,
          z: pose.z,
          yaw: pose.yaw,
          pitch: 0,
          roll: 0,
          scale: scale * (1 + (params.focus - 1) * facing),
        })
        card.bright = 1 - params.shade * (1 - pose.front) * (style === 'inside' ? 1 : 0.5)
        card.alpha = pose.alpha
        card.ring = ringOn && place === front
        card.show(pictures.peek(i)?.texture, frames[i])
        card.mesh.userData.at = place
        card.apply()
      }
      // Far cards first.
      const depths = cards.map((card) => table.depth(card))
      const sorted = cards.map((_, i) => i).sort((a, b) => (depths[a] ?? 0) - (depths[b] ?? 0))
      sorted.forEach((i, rank) => {
        ;(cards[i] as Card).mesh.renderOrder = rank
      })
      return moving
    }
  },
})
export default carousel
