// Shared by the effects that inspect a picture closely (zoom, lightbox): where its large version
// lives, leases of large pictures that outlive a hover by a while, and the pan-zoom of a view
// with zoom to a point, pinch, clamped edges and inertia.
import type { EffectContext } from '@dioramajs/effects'
import type { Texture } from 'three/webgpu'
import { picture } from './bitmap'

const IMAGE = /\.(avif|webp|jpe?g|png|gif)([?#]|$)/i

/** The largest candidate of a srcset: the widest by its `w` descriptor, else the last one. */
export function largest(srcset: string): string | undefined {
  let best: string | undefined
  let width = -1
  let last: string | undefined
  for (const part of srcset.split(/,\s+/)) {
    const [url, descriptor = ''] = part.trim().split(/\s+/)
    if (!url) continue
    last = url
    const match = /^(\d+)w$/.exec(descriptor)
    if (match && Number(match[1]) > width) {
      width = Number(match[1])
      best = url
    }
  }
  return best ?? last
}

/**
 * The large version of an image: `full` (the `data-dio-full` attribute by default), else the
 * `href` of the closest link to an image file, else the largest `srcset` candidate, else the
 * source it shows.
 */
export function source(
  img: Element,
  full: string | null | undefined = img.getAttribute('data-dio-full'),
): string {
  const named = full?.trim()
  if (named) return named
  const link = img.closest('a[href]') as HTMLAnchorElement | null
  if (link && IMAGE.test(link.getAttribute('href') ?? '')) return link.href
  const set = img.getAttribute('srcset')
  const candidate = set ? largest(set) : undefined
  if (candidate) return new URL(candidate, img.baseURI).href
  const el = img as HTMLImageElement
  return el.currentSrc || el.src || ''
}

/** A large picture held for an effect. */
export interface Held {
  readonly url: string
  /** Set once decoded. */
  readonly texture?: Texture
  /** Set when it failed: the effect goes on with what it has. */
  readonly failed?: unknown
  /** Settles when the picture is in or failed, never rejects. */
  readonly ready: Promise<void>
}

/** Large pictures by URL, decoded through `bitmap.ts` and released when no longer wanted. */
export interface Hold {
  /** The picture of `url`, leased now if it is not held. */
  get(url: string, priority?: 'high' | 'normal'): Held
  /** The picture of `url` if it is held. */
  peek(url: string): Held | undefined
  /** Holds these, the first at high priority, and releases every other. */
  keep(...urls: string[]): void
}

interface Entry extends Held {
  texture?: Texture
  failed?: unknown
  release(): void
}

/**
 * Leases of large pictures for an effect, decoded at most `resolution` on the long side within
 * the device limit. Released with the phase.
 */
export function hold(
  ctx: Pick<EffectContext, 'name' | 'app' | 'render' | 'signal' | 'onDispose'>,
  resolution: number,
): Hold {
  const held = new Map<string, Entry>()
  const drop = (keep: readonly string[]): void => {
    for (const [url, entry] of held) {
      if (keep.includes(url)) continue
      entry.release()
      held.delete(url)
    }
  }
  const get = (url: string, priority: 'high' | 'normal' = 'normal'): Held => {
    const known = held.get(url)
    if (known) return known
    const leased = picture(ctx, url, { resolution, priority })
    const entry: Entry = {
      url,
      release: leased.release,
      ready: leased.ready.then(
        (texture) => {
          entry.texture = texture
        },
        (error: unknown) => {
          entry.failed = error ?? true
          if (ctx.signal.aborted || held.get(url) !== entry) return
          if ((error as { name?: string })?.name === 'AbortError') return
          ctx.app.log.warn(`${ctx.name}: ${url} did not load, the image shows as it is`, error)
        },
      ),
    }
    held.set(url, entry)
    return entry
  }
  ctx.onDispose(() => drop([]))
  return {
    get,
    peek: (url) => held.get(url),
    keep(...urls) {
      drop(urls)
      for (const [i, url] of urls.entries()) get(url, i ? 'normal' : 'high')
    },
  }
}

/** How the pointers on a view moved: their centre, its shift and the change of their spread. */
export interface Moved {
  /** Centre of the pointers, client px. */
  readonly x: number
  readonly y: number
  /** Shift of the centre since the last move, px. */
  readonly dx: number
  readonly dy: number
  /** Spread now over the spread before: above 1 the fingers part (pinch out). 1 for one pointer. */
  readonly k: number
}

/** Pointers held on a view: one drags it, two pinch it. */
export class Pointers {
  readonly #at = new Map<number, { x: number; y: number }>()

  get count(): number {
    return this.#at.size
  }

  down(e: PointerEvent): void {
    this.#at.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }

  up(e: PointerEvent): void {
    this.#at.delete(e.pointerId)
  }

  clear(): void {
    this.#at.clear()
  }

  /** Moves a held pointer. Undefined for a pointer that is not held. */
  move(e: PointerEvent): Moved | undefined {
    const pointer = this.#at.get(e.pointerId)
    if (!pointer) return undefined
    const [fromX, fromY, fromSpread] = this.#centre()
    pointer.x = e.clientX
    pointer.y = e.clientY
    const [x, y, spread] = this.#centre()
    const k = fromSpread > 0 && spread > 0 ? spread / fromSpread : 1
    return { x, y, dx: x - fromX, dy: y - fromY, k }
  }

  /** Centre and mean distance from it of the first two pointers. */
  #centre(): [number, number, number] {
    const [a, b] = this.#at.values()
    if (!a) return [0, 0, 0]
    if (!b) return [a.x, a.y, 0]
    return [(a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2]
  }
}

/** Seconds a zoom to a goal takes to settle within a pixel. */
const GLIDE = 0.12
/** Inertia: the time constant of the slowdown after a fling, s. */
const COAST = 0.3
/** A fling slower than this stops, px/s. */
const STOP = 10

/**
 * The pan and zoom of a picture in a frame. The picture's box `w` x `h` is centred in a frame
 * `fw` x `fh` at zoom 1; at zoom `z` it is `z` times larger and moved by `x`, `y` (px, y down,
 * from the frame centre). An axis where the zoomed picture is wider than the frame keeps its
 * edges outside the frame, else the picture is centred on it.
 */
export class View {
  z = 1
  x = 0
  y = 0
  /** Fling velocity, px/s. */
  vx = 0
  vy = 0
  /** Zoom limit. */
  max = 1
  w = 1
  h = 1
  fw = 1
  fh = 1
  /** A zoom being eased to: zoom and the frame point it keeps still. */
  #goal: { z: number; px: number; py: number } | undefined

  /** Sizes of the picture at zoom 1 and of the frame, and the zoom limit. Keeps the view inside. */
  frame(w: number, h: number, fw: number, fh: number, max: number): void {
    this.w = w
    this.h = h
    this.fw = fw
    this.fh = fh
    this.max = Math.max(1, max)
    this.z = Math.min(this.z, this.max)
    this.#clamp()
  }

  /** At zoom 1 and centred, at rest. */
  reset(): void {
    this.z = 1
    this.x = this.y = this.vx = this.vy = 0
    this.#goal = undefined
  }

  /** Not zoomed in. */
  get fitted(): boolean {
    return this.z <= 1.001 && !this.#goal
  }

  /** How far the picture may move from the centre on each axis at zoom `z`. */
  bounds(z: number = this.z): [number, number] {
    return [Math.max(0, (this.w * z - this.fw) / 2), Math.max(0, (this.h * z - this.fh) / 2)]
  }

  /** Zooms by `k` keeping the frame point (px, py) from the centre still, at once. */
  zoomAt(k: number, px: number, py: number): void {
    this.#goal = undefined
    this.vx = this.vy = 0
    this.#zoom(this.z * k, px, py)
  }

  /** Eases the zoom to `z` around the frame point (px, py); `still` jumps there at once. */
  zoomTo(z: number, px: number, py: number, still = false): void {
    this.vx = this.vy = 0
    const to = Math.min(this.max, Math.max(1, z))
    if (still) {
      this.#goal = undefined
      this.#zoom(to, px, py)
    } else this.#goal = { z: to, px, py }
  }

  /** Moves by (dx, dy) px, held inside. */
  pan(dx: number, dy: number): void {
    this.#goal = undefined
    this.x += dx
    this.y += dy
    this.#clamp()
  }

  /** Lets go with a velocity in px/s: the picture coasts and slows down. */
  fling(vx: number, vy: number): void {
    this.vx = vx
    this.vy = vy
  }

  /** Advances easing and inertia by `dt` s. Returns true while something moves. */
  step(dt: number): boolean {
    const goal = this.#goal
    if (goal) {
      const blend = 1 - Math.exp(-dt / (GLIDE / 4))
      const z = Math.abs(goal.z - this.z) < 1e-3 ? goal.z : this.z + (goal.z - this.z) * blend
      this.#zoom(z, goal.px, goal.py)
      if (z === goal.z) this.#goal = undefined
      return true
    }
    if (!this.vx && !this.vy) return false
    const decay = Math.exp(-dt / COAST)
    // The distance the exponential slowdown covers in dt.
    this.x += this.vx * COAST * (1 - decay)
    this.y += this.vy * COAST * (1 - decay)
    this.vx *= decay
    this.vy *= decay
    const [boundX, boundY] = this.bounds()
    if (Math.abs(this.x) >= boundX) this.vx = 0
    if (Math.abs(this.y) >= boundY) this.vy = 0
    if (Math.hypot(this.vx, this.vy) < STOP) this.vx = this.vy = 0
    this.#clamp()
    return true
  }

  #zoom(z: number, px: number, py: number): void {
    const to = Math.min(this.max, Math.max(1, z))
    // The picture point under (px, py) stays there.
    const ratio = to / this.z
    this.x = px - (px - this.x) * ratio
    this.y = py - (py - this.y) * ratio
    this.z = to
    this.#clamp()
  }

  #clamp(): void {
    const [boundX, boundY] = this.bounds()
    this.x = Math.min(boundX, Math.max(-boundX, this.x))
    this.y = Math.min(boundY, Math.max(-boundY, this.y))
  }
}
