import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { radii, rng } from '@dioramajs/effects/kit'
import { afterDrag } from './click'
import { type Card, deck, follow, linkOf, local, measure, ownsPan } from './deck'
import { framing, leases } from './slots'

/** How the prints lie on the table. */
export type PolaroidsStyle = 'scatter' | 'grid' | 'pile'
type Params = {
  index: number
  open: number
  style: ChoiceParam<PolaroidsStyle>
  rotate: number
  spread: number
  border: number
  paper: ColorParam
  shadow: number
  zoom: number
  duration: number
  drag: boolean
  seed: number
  items: string
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Most prints on the table. */
const MOST = 40
/** Pointer travel that still counts as a tap, px. */
const TAP = 8
/** The bottom border of a print in borders. */
const CHIN = 3.4

/** Where a print lies: its centre px from the box centre (y up), its turn in radians. */
export interface Spot {
  x: number
  y: number
  roll: number
}

/**
 * Where the prints lie on a `width` x `height` table, the same for a seed on every load. `sizes`
 * are the prints, `at` the centres of their images in the page (for `grid`). `rotate` in degrees,
 * `spread` 0..1 how far they stray from their places.
 */
export function layout(
  style: PolaroidsStyle,
  sizes: readonly { w: number; h: number }[],
  at: readonly { x: number; y: number }[],
  width: number,
  height: number,
  seed: number,
  rotate: number,
  spread: number,
): Spot[] {
  const count = sizes.length
  const random = rng(Math.imul(seed, 7919) + 17)
  const radians = (rotate * Math.PI) / 180
  const cols = Math.max(
    1,
    Math.min(count, Math.round(Math.sqrt((count * width) / Math.max(height, 1)))),
  )
  const rows = Math.ceil(count / cols)
  return sizes.map((size, i) => {
    // A seeded stray in -1..1 on each axis, and a seeded turn.
    const strayX = random() * 2 - 1
    const strayY = random() * 2 - 1
    const roll = (random() * 2 - 1) * radians
    if (style === 'grid') {
      const image = at[i] ?? { x: 0, y: 0 }
      return { x: image.x + strayX * 6 * spread, y: image.y + strayY * 6 * spread, roll }
    }
    if (style === 'pile') {
      const reach = Math.min(width, height) * 0.12 * spread
      return { x: strayX * reach, y: strayY * reach, roll: roll * 1.5 }
    }
    // Scatter: a cell each, row by row, the last row centred, then a seeded stray in the cell.
    const row = Math.floor(i / cols)
    const inRow = row === rows - 1 ? count - row * cols : cols
    const cellWidth = width / cols
    const cellHeight = height / rows
    const cellX =
      (i % cols) * cellWidth + cellWidth / 2 + ((cols - inRow) * cellWidth) / 2 - width / 2
    const cellY = height / 2 - row * cellHeight - cellHeight / 2
    // The turned print stays whole on the table, or centred on an axis the table is too small for.
    const cos = Math.abs(Math.cos(roll))
    const sin = Math.abs(Math.sin(roll))
    const limitX = Math.max(0, width / 2 - (size.w * cos + size.h * sin) / 2)
    const limitY = Math.max(0, height / 2 - (size.w * sin + size.h * cos) / 2)
    return {
      x: Math.max(-limitX, Math.min(limitX, cellX + strayX * cellWidth * 0.35 * spread)),
      y: Math.max(-limitY, Math.min(limitY, cellY + strayY * cellHeight * 0.35 * spread)),
      roll,
    }
  })
}

/**
 * The images of a container as prints scattered on a table, each at a seeded angle: drag one to
 * move it to the top, click one to bring it forward, click the top one to hold it up large (or
 * follow its link). Fires `dio:index` when a print comes on top and `dio:open` when one is held
 * up or put back.
 */
const polaroids: Effect<Params> = defineEffect({
  name: 'polaroids',
  params: {
    index: 0,
    open: -1,
    style: oneOf('scatter', 'grid', 'pile'),
    rotate: 8,
    spread: 1,
    border: 10,
    paper: color('#fbfaf6'),
    shadow: 0.45,
    zoom: 2,
    duration: 0.5,
    drag: true,
    seed: 1,
    items: 'img',
  },
  on: ':not(img, video, canvas)',
  // Shadows, and a print held up past a small table.
  bleed: 80,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, app } = ctx
    const el = ctx.element as HTMLElement
    let items = [...el.querySelectorAll(params.items)].filter(
      (node): node is HTMLImageElement => node.localName === 'img',
    )
    if (!items.length) {
      app.log.warn(`polaroids: no images match "${params.items}", the container stays as it is`)
      return
    }
    if (items.length > MOST) {
      app.log.warn(`polaroids: ${items.length} images, the table shows the first ${MOST}`)
      items = items.slice(0, MOST)
    }
    const count = items.length
    const style = params.style
    const links = items.map((img) => linkOf(el, img))
    const pictures = leases(ctx, (i: number) => items[i] as HTMLImageElement)
    const frames = items.map((img) => framing(img))
    pictures.keep(...items.map((_, i) => i))
    await Promise.all(items.map((_, i) => pictures.get(i).ready))
    if (signal.aborted) return

    // Bottom to top; the print of `index` on top, the others in page order under it.
    let order = items.map((_, i) => count - 1 - i)
    const top = (): number => order[count - 1] as number
    const lift = (i: number): void => {
      order = [...order.filter((other) => other !== i), i]
    }
    lift(((Math.round(params.index) % count) + count) % count)
    let shownIndex = top()
    const raise = (i: number): void => {
      if (i === top()) return
      lift(i)
      ctx.set({ index: i })
      ctx.invalidate()
    }

    let ringOn = false
    const table = deck(ctx, el, (focused) => {
      ringOn = Boolean(focused)
      const i = items.findIndex((img, j) => links[j] === focused || focused?.contains(img))
      if (i >= 0 && i !== top()) raise(i)
    })
    const cards: Card[] = items.map(() => table.add())
    ctx.place(table.group, { replace: true, fit: 'none' })

    // Layout of the table, measured again when the box changes.
    let sizes = items.map(() => ({ w: 0, h: 0 }))
    let spots: Spot[] = []
    let laid = ''
    let box = { w: 0, h: 0 }
    let corners: number[] = []
    const border = (): number => Math.max(0, params.border)
    /** Measures the images and lays the prints out again. */
    const relay = (): void => {
      const paperBorder = border()
      const images = items.map((img) => measure(el, img))
      const known = images.find((image) => image.w > 0 && image.h > 0)
      sizes = images.map((image) => {
        const width = image.w > 0 ? image.w : (known?.w ?? 200)
        const height = image.h > 0 ? image.h : (known?.h ?? 200)
        return { w: width + 2 * paperBorder, h: height + paperBorder + CHIN * paperBorder }
      })
      // A print keeps a small corner; without paper each picture takes its image's own.
      corners = sizes.map((size, i) =>
        paperBorder > 0 ? 2 : radii(items[i] as Element, size.w, size.h)[0],
      )
      // A print's picture sits where its image is; the wider chin moves the print's centre down.
      const at = images.map((image) => ({
        x: image.x,
        y: image.y - ((CHIN - 1) * paperBorder) / 2,
      }))
      spots = layout(style, sizes, at, box.w, box.h, params.seed, params.rotate, params.spread)
      laid = `${box.w}x${box.h}:${params.seed}:${params.rotate}:${params.spread}:${paperBorder}`
    }

    // State of each print: moved by the user (px from the box centre), shown, lifted.
    const moved: (Spot | undefined)[] = items.map(() => undefined)
    const shown = items.map(() => ({ x: 0, y: 0, roll: 0, scale: 1, lift: 0, bright: 1 }))
    let first = true
    let open = -1
    let press:
      | { id: number; i: number; x: number; y: number; from: Spot; wasTop: boolean; pan: boolean }
      | undefined
    let dragging = false
    let pressedTop = -1
    const drags = afterDrag(el, signal)
    const passing = { on: false }

    const setOpen = (i: number): void => {
      if (i === open) return
      ctx.set({ open: i })
      ctx.invalidate()
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, handler, { signal })
    listen('dragstart', (e) => e.preventDefault())
    listen('pointerdown', (e) => {
      if (e.button !== 0 || press) return
      const [x, y] = local(el, e.clientX, e.clientY)
      const card = table.hit(x, y)
      const i = card ? cards.indexOf(card) : -1
      if (i < 0) return
      const wasTop = i === top()
      // Only a click on the print that was on top when pressed opens it.
      pressedTop = wasTop ? i : -1
      raise(i)
      const print = shown[i] as { x: number; y: number; roll: number }
      press = {
        id: e.pointerId,
        i,
        x: e.clientX,
        y: e.clientY,
        from: { x: print.x, y: print.y, roll: print.roll },
        wasTop,
        pan: e.pointerType === 'mouse' || ownsPan(el),
      }
    })
    listen('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return
      const dx = e.clientX - press.x
      const dy = e.clientY - press.y
      if (!dragging) {
        if (!params.drag || !press.pan || open === press.i) return
        if (Math.hypot(dx, dy) < TAP) return
        dragging = true
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // The pointer is gone already: its up or cancel follows.
        }
      }
      // A dragged print keeps at least a quarter of itself on the table.
      const size = sizes[press.i] as { w: number; h: number }
      const limitX = Math.max(0, box.w / 2 - size.w * 0.25)
      const limitY = Math.max(0, box.h / 2 - size.h * 0.25)
      moved[press.i] = {
        x: Math.max(-limitX, Math.min(limitX, press.from.x + dx)),
        y: Math.max(-limitY, Math.min(limitY, press.from.y - dy)),
        roll: press.from.roll,
      }
      ctx.invalidate()
    })
    const release = (e: PointerEvent): void => {
      if (!press || e.pointerId !== press.id) return
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP) drags.arm(e)
      press = undefined
      dragging = false
      ctx.invalidate()
    }
    listen('pointerup', release)
    listen('pointercancel', release)
    listen('click', (e) => {
      // A click sent on to a link, or one from the keyboard: the link does its own.
      if (passing.on || e.detail === 0) return
      e.preventDefault()
      if (drags.ends(e)) return
      const [x, y] = local(el, e.clientX, e.clientY)
      const card = table.hit(x, y)
      const i = card ? cards.indexOf(card) : -1
      if (open >= 0) return setOpen(-1)
      if (i < 0 || i !== top() || i !== pressedTop) return
      const link = links[i]
      if (link) follow(link, e, passing)
      else if (params.zoom > 0) setOpen(i)
    })
    listen('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const onTop = top()
      if (e.key === 'Escape' && open >= 0) {
        e.preventDefault()
        setOpen(-1)
        return
      }
      const by =
        e.key === 'ArrowRight' || e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? -1
            : 0
      if (by) {
        e.preventDefault()
        if (open >= 0) setOpen(-1)
        const i = (((onTop + by) % count) + count) % count
        raise(i)
        const link = links[i]
        if (link && e.target !== el) link.focus({ preventScroll: true })
        return
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
        e.preventDefault()
        if (open >= 0) setOpen(-1)
        else if (params.zoom > 0) setOpen(onTop)
      }
    })

    let paper = ''
    return (input): boolean => {
      const calm = input.reducedMotion
      if (input.width !== box.w || input.height !== box.h) box = { w: input.width, h: input.height }
      const paperBorder = border()
      const looks = `${params.seed}:${params.rotate}:${params.spread}:${paperBorder}`
      if (laid !== `${box.w}x${box.h}:${looks}`) {
        const reseeded = laid && !laid.endsWith(`:${looks}`)
        relay()
        // A new seed shuffles the table: the prints leave where the user put them.
        if (reseeded) moved.fill(undefined)
      }
      // The site's writes: the print on top and the one held up.
      const wanted = ((Math.round(params.index) % count) + count) % count
      if (wanted !== top()) lift(wanted)
      const asked =
        Number.isInteger(params.open) && params.open >= 0 && params.open < count ? params.open : -1
      if (asked !== open) {
        open = params.zoom > 0 ? asked : -1
        if (open >= 0) lift(open)
        el.dispatchEvent(new CustomEvent('dio:open', { detail: { index: open }, bubbles: true }))
      }
      if (top() !== shownIndex) {
        shownIndex = top()
        el.dispatchEvent(
          new CustomEvent('dio:index', { detail: { index: shownIndex }, bubbles: true }),
        )
      }

      const look = table.look
      look.perspective = 1000
      look.border = paperBorder
      look.bottom = CHIN * paperBorder
      look.shadow = params.shadow
      if (params.paper !== paper) {
        paper = params.paper
        table.paper(paper)
      }
      table.frame(input)

      // How far each print eases towards its target this frame.
      const step = calm
        ? 1
        : first
          ? 1
          : 1 - Math.exp(-input.delta / Math.max(params.duration / 4, 1e-3))
      first = false
      let busy = false
      const near = (a: number, b: number, epsilon: number): boolean => Math.abs(a - b) < epsilon
      for (let i = 0; i < count; i++) {
        const print = shown[i] as (typeof shown)[number]
        const size = sizes[i] as { w: number; h: number }
        const spot = moved[i] ?? (spots[i] as Spot)
        const held = press?.i === i && dragging
        const up = open === i
        const fit = Math.min(params.zoom, (box.w * 0.9) / size.w, (box.h * 0.9) / size.h)
        const target = up
          ? { x: 0, y: 0, roll: 0, scale: Math.max(1, fit), lift: 1, bright: 1 }
          : {
              x: spot.x,
              y: spot.y,
              roll: spot.roll,
              scale: held ? 1.04 : 1,
              lift: held ? 1 : 0,
              bright: open >= 0 ? 0.75 : 1,
            }
        // A held print follows the pointer at once; everything else eases there.
        const moveStep = held ? 1 : step
        print.x += (target.x - print.x) * moveStep
        print.y += (target.y - print.y) * moveStep
        print.roll += (target.roll - print.roll) * step
        print.scale += (target.scale - print.scale) * step
        print.lift += (target.lift - print.lift) * step
        print.bright += (target.bright - print.bright) * step
        if (
          !near(print.x, target.x, 0.2) ||
          !near(print.y, target.y, 0.2) ||
          !near(print.roll, target.roll, 1e-3) ||
          !near(print.scale, target.scale, 1e-3) ||
          !near(print.lift, target.lift, 1e-3) ||
          !near(print.bright, target.bright, 1e-3)
        )
          busy = true
        else Object.assign(print, target)
        const card = cards[i] as Card
        card.size.w = size.w
        card.size.h = size.h
        card.radius = corners[i] ?? 0
        Object.assign(card.pose, {
          x: print.x,
          y: print.y,
          z: 0,
          yaw: 0,
          pitch: 0,
          roll: print.roll,
          scale: print.scale,
        })
        card.lift = print.lift
        card.bright = print.bright
        card.alpha = 1
        card.ring = ringOn && i === top()
        card.show(pictures.peek(i)?.texture, frames[i])
        card.mesh.renderOrder = order.indexOf(i)
        card.apply()
      }
      return busy || dragging
    }
  },
})
export default polaroids
