import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { radii } from '@dioramajs/effects/kit'
import { type Card, deck, measure } from './deck'
import { framing, leases } from './slots'
import { track } from './track'

/** How the covers beside the middle one lie. */
export type CoverflowStyle = 'classic' | 'arc' | 'cards'
type Params = {
  index: number
  style: ChoiceParam<CoverflowStyle>
  angle: number
  spacing: number
  depth: number
  shade: number
  reflection: number
  perspective: number
  duration: number
  loop: boolean
  drag: boolean
  wheel: boolean
  click: boolean
  items: string
}

/** Most covers drawn on each side of the middle one. */
const SIDE = 7
/** Radius of the arc in widths of a cover. */
const ARC = 5

/** A cover's place for an offset from the middle: px, radians, brightness. */
export interface CoverPose {
  x: number
  y: number
  z: number
  yaw: number
  roll: number
  scale: number
  bright: number
}

/**
 * Where the cover `offset` places from the middle one lies, for covers `width` px wide. `angle`
 * in degrees, `spacing` and `depth` in widths of a cover.
 */
export function cover(
  style: CoverflowStyle,
  offset: number,
  width: number,
  angle: number,
  spacing: number,
  depth: number,
  shade: number,
): CoverPose {
  const radians = (angle * Math.PI) / 180
  const side = Math.sign(offset)
  // The way to the first place either side, 0..1, and the places past it.
  const near = Math.min(Math.abs(offset), 1)
  const beyond = Math.max(Math.abs(offset) - 1, 0)
  if (style === 'arc') {
    // On a wheel turning about a point below the row.
    const radius = ARC * width
    const phi = (offset * width * (1 + spacing)) / radius
    return {
      x: radius * Math.sin(phi),
      y: radius * Math.cos(phi) - radius,
      z: -depth * width * 0.3 * near,
      yaw: 0,
      roll: -phi,
      scale: 1,
      bright: 1 - shade * near,
    }
  }
  if (style === 'cards') {
    // Behind the middle one, a little to the side, smaller and turned.
    const turned = Math.max(-3, Math.min(3, offset))
    return {
      x: Math.max(-4, Math.min(4, offset)) * width * spacing * 0.6,
      y: 0,
      z: -Math.abs(offset) * depth * width * 0.2,
      yaw: 0,
      roll: (-turned * radians) / 12,
      scale: Math.max(0.7, 1 - 0.06 * Math.abs(offset)),
      bright: 1 - shade * Math.min(1, Math.abs(offset) * 0.6),
    }
  }
  // Classic: each side cover turned towards the middle, its near edge just past the middle one.
  const first = (width / 2) * (1 + Math.cos(radians)) + spacing * width * 0.5
  return {
    x: side * (near * first + beyond * spacing * width),
    y: 0,
    z: -depth * width * near,
    yaw: -side * radians * near,
    roll: 0,
    scale: 1,
    bright: Math.max(0, 1 - shade * (near + 0.12 * beyond)),
  }
}

/** Covers drawn on each side of the middle one in a box `width` px wide. */
export function reach(
  style: CoverflowStyle,
  width: number,
  coverWidth: number,
  angle: number,
  spacing: number,
): number {
  if (style === 'cards') return 4
  if (style === 'arc') {
    // As far round the wheel as a little past a quarter turn.
    const phi = (coverWidth * (1 + spacing)) / (ARC * coverWidth)
    return Math.max(1, Math.min(SIDE, Math.floor((Math.PI * 0.55) / Math.max(phi, 1e-3))))
  }
  const radians = (angle * Math.PI) / 180
  const first = (coverWidth / 2) * (1 + Math.cos(radians)) + spacing * coverWidth * 0.5
  const more = Math.ceil((width / 2 - first + coverWidth / 2) / Math.max(spacing * coverWidth, 1))
  return Math.max(1, Math.min(SIDE, 1 + Math.max(0, more)))
}

/**
 * The images of a list as the classic cover flow: the middle cover faces the viewer and its
 * neighbours turn away in perspective, with an optional reflection on the floor. A drag, a
 * sideways wheel, a swipe, a click or a key brings the next one to the middle; a click on the
 * middle one follows its link. Fires `dio:index` when a cover reaches the middle.
 */
const coverflow: Effect<Params> = defineEffect({
  name: 'coverflow',
  params: {
    index: 0,
    style: oneOf('classic', 'arc', 'cards'),
    angle: 60,
    spacing: 0.3,
    depth: 0.6,
    shade: 0.4,
    reflection: 0,
    perspective: 900,
    duration: 0.5,
    loop: false,
    drag: true,
    wheel: true,
    click: true,
    items: 'img',
  },
  on: ':not(img, video, canvas)',
  // The reflection and the covers past the box edges.
  bleed: 200,
  quality: { low: { reflection: 0 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app } = ctx
    const el = ctx.element as HTMLElement
    const items = [...el.querySelectorAll(params.items)].filter(
      (node): node is HTMLImageElement => node.localName === 'img',
    )
    const count = items.length
    if (!count) {
      app.log.warn(`coverflow: no images match "${params.items}", the list stays as it is`)
      return
    }
    const style = params.style
    const pictures = leases(ctx, (i: number) => items[i] as HTMLImageElement)
    const frames = items.map((img) => framing(img))

    // Sizes and heights of the covers as the list lays them out.
    let sizes = items.map(() => ({ w: 0, h: 0, x: 0, y: 0 }))
    let width = 1
    let corners: number[] = []
    const remeasure = (): void => {
      sizes = items.map((img) => measure(el, img))
      const known = sizes.filter((size) => size.w > 0 && size.h > 0)
      width = known.length ? known.reduce((sum, size) => sum + size.w, 0) / known.length : 0
      // Images not laid out take the box's height at the pictures' usual shape.
      const fallback = el.clientHeight * 0.7 || 200
      if (!width) width = fallback
      for (const size of sizes) {
        if (size.w > 0 && size.h > 0) continue
        size.w = width
        size.h = known[0]?.h ?? fallback
        size.y = 0
      }
      corners = sizes.map((size, i) => radii(items[i] as Element, size.w, size.h)[0])
    }
    remeasure()

    const row = track(ctx, {
      items,
      loop: () => params.loop,
      span: () =>
        style === 'arc'
          ? width * (1 + params.spacing)
          : Math.max(params.spacing * width, width * 0.5),
      pick: (x, y) => (table.hit(x, y)?.mesh.userData as { at?: number } | undefined)?.at,
      drag: () => params.drag,
      wheel: () => params.wheel,
      click: () => params.click,
    })
    let ringOn = false
    const table = deck(ctx, el, (focused) => {
      ringOn = Boolean(focused)
    })

    /** Items from the middle one outwards, `side` and one more either way. */
    const around = (middle: number, side: number): number[] => {
      const out: number[] = []
      for (let step = 0; step <= side + 1; step++)
        for (const place of step ? [middle + step, middle - step] : [middle]) {
          if (!params.loop && (place < 0 || place > count - 1)) continue
          const i = row.wrap(place)
          if (!out.includes(i)) out.push(i)
        }
      return out
    }
    let held = Math.round(row.pos)
    let side = reach(style, el.clientWidth || 800, width, params.angle, params.spacing)
    pictures.keep(...around(held, side))
    // The middle cover and its neighbours in before the copy shows.
    await Promise.all(around(held, 1).map((i) => pictures.get(i).ready))
    if (signal.aborted) return
    for (const i of around(held, side)) {
      const lease = pictures.peek(i)
      if (lease && !lease.texture && !lease.failed) void lease.ready.then(() => ctx.invalidate())
    }

    const cards: Card[] = Array.from({ length: SIDE * 2 + 1 }, () => table.add())
    ctx.place(table.group, { replace: true, fit: 'none' })
    // Images that come in later change the sizes of their covers.
    el.addEventListener(
      'load',
      () => {
        remeasure()
        ctx.invalidate()
      },
      { signal, capture: true },
    )

    let box = { w: 0, h: 0 }
    return (input): boolean => {
      if (input.width !== box.w || input.height !== box.h) {
        box = { w: input.width, h: input.height }
        remeasure()
      }
      const calm = input.reducedMotion
      row.tick(input.delta, calm)
      const moving = row.busy

      const look = table.look
      look.perspective = params.perspective
      look.reflection = Math.max(0, Math.min(1, params.reflection))
      look.reach = 0.45
      table.frame(input)

      const at = row.pos
      const middle = Math.round(at)
      side = reach(style, box.w, width, params.angle, params.spacing)
      if (middle !== held) {
        held = middle
        const wanted = around(middle, side)
        pictures.keep(...wanted)
        for (const i of wanted) {
          const lease = pictures.peek(i)
          if (lease && !lease.texture && !lease.failed)
            void lease.ready.then(() => ctx.invalidate())
        }
      }
      // One card per place from the middle; places past the reach or the ends are hidden.
      for (let step = -SIDE; step <= SIDE; step++) {
        const card = cards[step + SIDE] as Card
        const place = middle + step
        if (Math.abs(step) > side + 1 || (!params.loop && (place < 0 || place > count - 1))) {
          card.alpha = 0
          card.apply()
          continue
        }
        const i = row.wrap(place)
        const offset = place - at
        const pose = cover(
          style,
          offset,
          width,
          params.angle,
          params.spacing,
          params.depth,
          params.shade,
        )
        const size = sizes[i] as { w: number; h: number; y: number }
        card.size.w = size.w
        card.size.h = size.h
        card.radius = corners[i] ?? 0
        Object.assign(card.pose, {
          x: pose.x,
          y: pose.y + size.y,
          z: pose.z,
          yaw: pose.yaw,
          pitch: 0,
          roll: pose.roll,
          scale: pose.scale,
        })
        card.bright = pose.bright
        card.alpha = Math.max(0, Math.min(1, side + 0.5 - Math.abs(offset)))
        card.ring = ringOn && step === 0
        card.show(pictures.peek(i)?.texture, frames[i])
        // Nearer the middle draws later, over its neighbours.
        card.mesh.renderOrder = 100 - Math.round(Math.abs(offset) * 10)
        card.mesh.userData.at = place
        card.apply()
      }
      return moving
    }
  },
})
export default coverflow
