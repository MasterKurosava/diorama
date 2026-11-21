// A row of items moved one at a time (coverflow, carousel): the `index` param and the position
// shown, which follows it with an eased move, a drag, a sideways wheel or the site's own
// horizontal scroll on touch screens; clicks and keys; `dio:index` when an item is reached.
// The DOM stays a real list: a click on the centre item follows its link.
import type { EffectContext } from '@dioramajs/effects'
import { afterDrag } from './click'
import { follow, linkOf, local, ownsPan } from './deck'

/** Pointer travel that still counts as a tap, px. */
const TAP = 8
/** Wheel or scroll quiet this long ends the gesture, ms. */
const IDLE = 140
/** How far a released drag coasts, in seconds of its speed. */
const COAST = 0.25

type Params = { index: number; duration: number }

/** What the effect tells the row. */
export interface TrackOptions {
  readonly items: readonly HTMLImageElement[]
  /** Positions wrap around the items. */
  loop(): boolean
  /** Drag px that move one item. */
  span(): number
  /** The unwrapped position of the item drawn under a point px from the box centre, y up. */
  pick(x: number, y: number): number | undefined
  drag(): boolean
  wheel(): boolean
  click(): boolean
  /** Any input of the user's own: autoplay waits. */
  touched?(): void
}

/** The row's state for the effect's update. */
export interface Track {
  /** The position shown, unwrapped, fractional while moving. */
  readonly pos: number
  /** A move, a drag or a gesture is under way. */
  readonly busy: boolean
  /** The item at a position. */
  wrap(i: number): number
  /** Moves time on. Call first in update. */
  tick(delta: number, calm: boolean): void
  /** Sets `index` to `by` items on, as a key would. */
  step(by: number): void
  /** Takes the row to a position: the nearest lap of the item when it loops. */
  go(position: number): void
}

const outCubic = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

/** The row of `options.items`, driven by the effect's `index` and `duration` params. */
export function track(ctx: EffectContext<Params>, options: TrackOptions): Track {
  const { params, signal } = ctx
  const el = ctx.element as HTMLElement
  const count = options.items.length
  const links = options.items.map((img) => linkOf(el, img))
  const wrap = (i: number): number => ((i % count) + count) % count
  const bound = (i: number): number => (options.loop() ? i : Math.min(count - 1, Math.max(0, i)))
  // Past the ends without loop, the row gives a little.
  const give = (at: number): number => {
    if (options.loop()) return at
    if (at < 0) return at * 0.3
    if (at > count - 1) return count - 1 + (at - count + 1) * 0.3
    return at
  }

  let pos = bound(Number.isFinite(params.index) ? params.index : 0)
  let aim = params.index
  let reached = Number.isInteger(pos) ? pos : Number.NaN
  /** The eased move to `index`: `t` its progress 0..1, `length` its duration in s. */
  let easing: { from: number; to: number; t: number; length: number } | undefined
  let drag:
    | { id: number; x: number; from: number; last: number; at: number; speed: number }
    | undefined
  let press: { id: number; x: number; y: number; pan: boolean } | undefined
  /** A wheel, or the site's scroll on touch, moves the row until it goes quiet. */
  let gesture: { base: number; timer?: ReturnType<typeof setTimeout> } | undefined
  const drags = afterDrag(el, signal)
  const passing = { on: false }
  ctx.onDispose(() => clearTimeout(gesture?.timer))

  const settle = (to: number): void => {
    // A release or a gesture's end animates from where the row is, even to the same index.
    aim = Number.NaN
    ctx.set({ index: to })
    ctx.invalidate()
  }
  const go = (position: number): void => {
    let target = position
    if (options.loop()) {
      const here = Math.round(params.index)
      let offset = wrap(position - here)
      if (offset > count / 2) offset -= count
      target = here + offset
    }
    ctx.set({ index: bound(target) })
  }
  const step = (by: number): void => {
    if (drag || !by) return
    const i = Math.round(params.index)
    if (!options.loop() && (i + by < 0 || i + by > count - 1)) {
      ctx.set({ index: Math.min(count - 1, Math.max(0, i + by)) })
      return
    }
    ctx.set({ index: i + by })
  }

  // The scrollable list under the copy, synced at rest so a swipe starts where the row is.
  const room = (): number => Math.max(0, el.scrollWidth - el.clientWidth)
  const fromScroll = (): number =>
    count > 1 && room() ? (el.scrollLeft / room()) * (count - 1) : 0
  const sync = (): void => {
    const scrollRoom = room()
    if (!scrollRoom || gesture || count < 2) return
    const left = (wrap(Math.round(pos)) / (count - 1)) * scrollRoom
    if (Math.abs(el.scrollLeft - left) > 1) el.scrollLeft = left
  }
  const quiet = (): void => {
    if (!gesture) return
    clearTimeout(gesture.timer)
    gesture.timer = setTimeout(() => {
      gesture = undefined
      settle(Math.round(pos))
    }, IDLE)
  }

  const listen = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void => el.addEventListener(type, handler, { signal, ...options })
  // Images and links of the list would be picked up by a drag.
  listen('dragstart', (e) => e.preventDefault())
  listen('pointerdown', (e) => {
    if (e.button !== 0 || drag) return
    options.touched?.()
    const pan = e.pointerType === 'mouse' || ownsPan(el)
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, pan }
    // Without touch-action the browser scrolls the list itself: the row follows that scroll.
    if (!pan && room()) {
      clearTimeout(gesture?.timer)
      gesture = { base: pos - fromScroll() }
      easing = undefined
    }
  })
  listen('scroll', () => {
    if (!gesture || drag) return
    pos = give(fromScroll() + gesture.base)
    easing = undefined
    quiet()
    ctx.invalidate()
  })
  listen('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return
    const dx = e.clientX - press.x
    if (!drag) {
      if (!options.drag() || !press.pan) return
      if (Math.abs(dx) < TAP || Math.abs(dx) < Math.abs(e.clientY - press.y)) return
      clearTimeout(gesture?.timer)
      gesture = undefined
      easing = undefined
      drag = { id: press.id, x: press.x, from: pos, last: e.clientX, at: e.timeStamp, speed: 0 }
      try {
        // Moves past the box still carry the row.
        el.setPointerCapture(e.pointerId)
      } catch {
        // The pointer is gone already: its up or cancel follows.
      }
    }
    const elapsed = e.timeStamp - drag.at
    if (elapsed > 0) {
      const speed = (e.clientX - drag.last) / elapsed
      drag.speed = drag.speed * 0.5 + speed * 0.5
      drag.last = e.clientX
      drag.at = e.timeStamp
    }
    pos = give(drag.from - dx / Math.max(options.span(), 1))
    ctx.invalidate()
  })
  const release = (e: PointerEvent, cancelled: boolean): void => {
    const from = press
    if (from?.id === e.pointerId) {
      press = undefined
      if (!cancelled && Math.hypot(e.clientX - from.x, e.clientY - from.y) > TAP) drags.arm(e)
    }
    // A tap or a swipe the browser scrolls with: the gesture ends once the list is quiet.
    quiet()
    const ended = drag
    if (!ended || e.pointerId !== ended.id) return
    drag = undefined
    const fresh = e.timeStamp - ended.at < 100
    // px/ms to items: the row coasts on a little way past where it was let go.
    const coast =
      fresh && !ctx.input.reducedMotion ? (-ended.speed * 1000 * COAST) / options.span() : 0
    settle(bound(Math.round(pos + Math.max(-3, Math.min(3, coast)))))
  }
  listen('pointerup', (e) => release(e, false))
  listen('pointercancel', (e) => release(e, true))
  listen(
    'wheel',
    (e) => {
      if (!options.wheel()) return
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (!dx || drag) return
      e.preventDefault()
      options.touched?.()
      if (!gesture) gesture = { base: 0 }
      easing = undefined
      // Lines and pages to px.
      const pixels = e.deltaMode === 1 ? dx * 16 : e.deltaMode === 2 ? dx * el.clientWidth : dx
      pos = give(pos + pixels / Math.max(options.span(), 1))
      quiet()
      ctx.invalidate()
    },
    { passive: false },
  )
  listen('click', (e) => {
    // A click the row sends on to a link, or one from the keyboard: the link does its own.
    if (passing.on || e.detail === 0) return
    e.preventDefault()
    if (drags.ends(e)) return
    options.touched?.()
    const [x, y] = local(el, e.clientX, e.clientY)
    const place = options.pick(x, y)
    if (place === undefined) return
    const i = wrap(place)
    const centre = Math.round(pos)
    if (place === centre && Math.abs(pos - centre) < 0.05) {
      const link = links[i]
      if (link) follow(link, e, passing)
      else el.dispatchEvent(new CustomEvent('dio:open', { detail: { index: i }, bubbles: true }))
    } else if (options.click()) ctx.set({ index: bound(place) })
  })
  listen('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const i = Math.round(params.index)
    const lap = i - wrap(i)
    const by =
      e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowLeft'
          ? -1
          : e.key === 'PageDown'
            ? 3
            : e.key === 'PageUp'
              ? -3
              : e.key === 'Home'
                ? (options.loop() ? lap : 0) - i
                : e.key === 'End'
                  ? (options.loop() ? lap : 0) + count - 1 - i
                  : undefined
    if (by === undefined) return
    e.preventDefault()
    options.touched?.()
    step(by)
    // Focus on a link moves with the row, so Enter opens the item in the middle.
    const to = links[wrap(Math.round(params.index))]
    if (to && e.target !== el && to !== e.target) to.focus({ preventScroll: true })
  })
  listen('focusin', (e) => {
    const target = e.target as Element
    // A press focuses the hidden link under the pointer, not the cover drawn there: the press's
    // own drag or click decides where the row goes.
    if (target === el || press) return
    const i = options.items.findIndex((img, j) => target.contains(img) || links[j] === target)
    if (i < 0 || i === wrap(Math.round(params.index))) return
    options.touched?.()
    go(i)
  })

  return {
    get pos() {
      return pos
    },
    get busy() {
      return Boolean(easing || drag || gesture)
    },
    wrap,
    step,
    go,
    tick(delta, calm) {
      if (!drag && !gesture) {
        const wanted = params.index
        if (!Number.isInteger(wanted)) {
          // Scrubbed (a tween): the row exactly there.
          pos = bound(wanted)
          aim = Number.NaN
          easing = undefined
        } else if (wanted !== aim) {
          aim = wanted
          const to = bound(wanted)
          const span = Math.abs(to - pos)
          if (calm || span < 1e-3) {
            pos = to
            easing = undefined
          } else {
            // Longer moves take longer, but less than in proportion.
            const length = params.duration * (span <= 1 ? Math.max(span, 0.3) : Math.sqrt(span))
            easing = { from: pos, to, t: 0, length }
          }
        }
      }
      if (easing) {
        easing.t += calm ? 1 : delta / Math.max(easing.length, 1e-3)
        pos = easing.from + (easing.to - easing.from) * outCubic(easing.t)
        if (easing.t >= 1) {
          pos = easing.to
          easing = undefined
        }
      }
      if (!drag && !gesture && !easing && Number.isInteger(pos) && pos !== reached) {
        reached = pos
        sync()
        // Focus on a link follows the row, so Enter opens the item in the middle.
        const active = document.activeElement as HTMLElement | null
        const to = links[wrap(pos)]
        if (to && active && active !== to && links.includes(active))
          to.focus({ preventScroll: true })
        el.dispatchEvent(
          new CustomEvent('dio:index', { detail: { index: wrap(pos) }, bubbles: true }),
        )
      }
    },
  }
}
