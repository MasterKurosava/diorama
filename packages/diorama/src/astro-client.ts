// diorama/astro/client, the page side of `diorama({ lenis, restoreScroll })` in astro.config: the
// integration puts `smoothScroll(Lenis, options)` and `restoreScroll()` on every page. One Lenis
// for the site that lives across ClientRouter swaps; the app of `start()` takes it over once it runs.
import { type LenisLike, lenisPlugin } from '@dioramajs/lenis'
import { ready } from './attach'

/** The part of Lenis 1.3 the page side uses on top of what the adapter needs. */
export interface SmoothScroll extends LenisLike {
  /** Lenis' classes for <html>, e.g. 'lenis lenis-stopped'. */
  readonly className: string
  /** Where a smooth scroll in flight ends, px. */
  targetScroll: number
  /** Measures the page again and takes the native scroll position. */
  resize(): void
  /** Scrolls to a position. `immediate` ends a smooth scroll in flight, `force` works while stopped. */
  scrollTo: (target: number, options: { immediate: boolean; force: boolean }) => void
}

interface NavigationEvent extends Event {
  readonly navigationType: 'push' | 'replace' | 'traverse'
}
interface SwapEvent extends NavigationEvent {
  readonly newDocument: Document
  readonly from: URL
  readonly to: URL
}

const KEY = Symbol.for('diorama.astro.lenis')
const RESTORE = Symbol.for('diorama.astro.restore')
/** ms between saves of the scroll into history: Safari allows 100 replaceState per 30 s. */
const SAVE_EVERY = 400
/** sessionStorage key of the last scroll of each page left in this tab. */
const VISITED = 'diorama:scroll'
/** Pages remembered; the one left longest ago goes first. */
const KEEP = 100
const holder = globalThis as { [KEY]?: SmoothScroll; [RESTORE]?: () => void }

const lenisClass = (name: string): boolean => name === 'lenis' || name.startsWith('lenis-')

/**
 * Smooth scroll on an Astro page. The first call makes the page's Lenis, later calls return it,
 * so a script that needs the instance calls it too. Lenis runs on its own frames until the app
 * of `start()` runs and drives it. On a ClientRouter swap it keeps the scroll Astro sets (the
 * top, the hash, the position Back restores) and its classes on <html>.
 *
 *     import Lenis from 'lenis'
 *     import { smoothScroll } from 'dioramajs/astro/client'
 *
 *     const lenis = smoothScroll(Lenis, { easing: (t) => 1 - (1 - t) ** 3, duration: 1.2 })
 */
export function smoothScroll<O extends object, L extends SmoothScroll>(
  Lenis: new (options?: O) => L,
  options?: O,
): L {
  const made = holder[KEY]
  if (made) return made as L
  const lenis = new Lenis({ ...options, autoRaf: true } as O)
  holder[KEY] = lenis
  const root = document.documentElement
  const controller = new AbortController()
  const { signal } = controller

  const destroy = lenis.destroy.bind(lenis)
  lenis.destroy = () => {
    controller.abort()
    if (holder[KEY] === lenis) delete holder[KEY]
    destroy()
  }

  // Astro saves the scroll that Back and Forward restore on `scrollend`, which Lenis sends only
  // when a smooth scroll comes to rest, a second or more after the wheel stops: a quick Back
  // would lose the position. Save it into the page's history entry as Lenis moves, and once more as
  // a link swaps the page. A popstate has already made the next page's entry current, so from
  // there to the swap nothing is saved.
  let moving = false
  let saving: ReturnType<typeof setTimeout> | undefined
  const save = (): void => {
    clearTimeout(saving)
    saving = undefined
    const state = history.state as { scrollX?: number; scrollY?: number } | null
    if (moving || !state || (state.scrollX === scrollX && state.scrollY === scrollY)) return
    history.replaceState({ ...state, scrollX, scrollY }, '')
  }
  lenis.on('scroll', () => {
    saving ??= setTimeout(save, SAVE_EVERY)
  })
  signal.addEventListener('abort', () => clearTimeout(saving))
  document.addEventListener(
    'astro:before-preparation',
    (event) => {
      if ((event as NavigationEvent).navigationType === 'traverse') moving = true
    },
    { signal },
  )

  document.addEventListener(
    'astro:before-swap',
    (event) => {
      // A link: the page may have scrolled on while the next one loaded.
      save()
      moving = true
      // Astro gives <html> the next page's attributes. Without Lenis' classes lenis.css lets go
      // (height: auto, overflow: clip while stopped) until Lenis changes state again.
      const next = (event as SwapEvent).newDocument.documentElement
      next.classList.add(...lenis.className.split(' '))
    },
    { signal },
  )
  document.addEventListener(
    'astro:after-swap',
    () => {
      // Astro has scrolled: the top, the hash, or the position Back restores. Lenis measures the
      // new page and takes it from there; it never scrolls to 0 itself, which would undo Back.
      moving = false
      lenis.resize()
      if (lenis.isScrolling === 'smooth') {
        // A smooth scroll of the page that left would go on to its old target. A jump to where
        // Astro put the page ends it; NaN keeps Lenis from skipping a jump onto its target.
        lenis.targetScroll = Number.NaN
        lenis.scrollTo(lenis.actualScroll, { immediate: true, force: true })
      }
      for (const name of [...root.classList]) if (lenisClass(name)) root.classList.remove(name)
      root.classList.add(...lenis.className.split(' '))
    },
    { signal },
  )

  const connect = (): void => {
    ready().then(
      (app) => {
        if (signal.aborted) return
        const service = app.find('lenis')
        if (service?.lenis && service.lenis !== lenis) {
          console.warn(
            '[diorama] diorama({ lenis }) in astro.config makes Lenis, and start({ lenis }) got another: the one from start() stays. Remove one of them',
          )
          lenis.destroy()
          return
        }
        if (service) service.use(lenis)
        else app.use(lenisPlugin({ lenis })).catch((error: unknown) => app.report(error, 'lenis'))
        // The next start() after a destroy takes Lenis over again.
        const off = app.state.subscribe((state) => {
          if (state !== 'destroyed') return
          queueMicrotask(() => off())
          connect()
        })
      },
      () => {},
    )
  }
  connect()
  return lenis
}

/** `#id`, or `main>3` for the 4th child of main (or of body), and the scroll past its top. */
type Anchor = [key: string, past: number]
/** A position left: the scroll, and anchors on the content at the top of the screen. */
type Spot = [x: number, y: number, anchors?: Anchor[]]
type Visited = Record<string, Spot>

/** The positions saved in this tab, by page. */
const visited = (): Visited => {
  try {
    const seen: unknown = JSON.parse(sessionStorage.getItem(VISITED) ?? '{}')
    return seen && typeof seen === 'object' ? (seen as Visited) : {}
  } catch {
    return {}
  }
}

/** The element whose children anchor a position: main, else body. */
const shell = (): [name: string, el: Element] => {
  const main = document.querySelector('main')
  return main ? ['main', main] : ['body', document.body]
}
const pinned = (el: Element): boolean => /fixed|sticky/.test(getComputedStyle(el).position)

/**
 * Anchors on what is at the top of the screen: the deepest element with an id there, then the
 * child of main (or body) there. A raw scroll misses once scripts fill blocks above it.
 */
function anchors(): Anchor[] {
  const [name, root] = shell()
  const children = [...root.children]
  let top: Element | undefined
  for (const child of children) {
    const rect = child.getBoundingClientRect()
    if (rect.top <= 0 && rect.height > 0 && !pinned(child)) top = child
  }
  if (!top) return []
  let named: Element | undefined = top.id ? top : undefined
  for (let el: Element | undefined = top; el; ) {
    el = [...el.children].find((child) => {
      const rect = child.getBoundingClientRect()
      return rect.top <= 0 && rect.bottom > 0 && !pinned(child)
    })
    if (el?.id) named = el
  }
  const past = (el: Element): number => -el.getBoundingClientRect().top
  const found: Anchor[] = []
  if (named) found.push([`#${named.id}`, past(named)])
  if (named !== top) found.push([`${name}>${children.indexOf(top)}`, past(top)])
  return found
}

/** The scroll that puts the first anchor still on the page where it was, else the raw one. */
function place([x, y, list = []]: Spot): [x: number, y: number] {
  const [name, root] = shell()
  for (const [key, past] of list) {
    const [where, at] = key.split('>')
    const el = key.startsWith('#')
      ? document.getElementById(key.slice(1))
      : where === name
        ? root.children[Number(at)]
        : undefined
    if (el) return [x, el.getBoundingClientRect().top + scrollY + past]
  }
  return [x, y]
}

/**
 * Which ClientRouter links land where the reader left the page, as Back does, instead of at the
 * top. 'parents': links up the address, to `/` from anywhere or to `/work` from `/work/aurora`,
 * so a list opens where the reader left it while a project opened from it starts at its cover.
 * 'visited': links to any page seen earlier in this tab.
 */
export type ScrollRestore = 'parents' | 'visited'

/** The reader's own scrolling ends the corrections after a restore. */
const GESTURES = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * Links back to a page land where the reader left it, as Back does; browsers open every link at
 * the top. A link with a #hash still goes to its anchor, and a link to the page on screen or a
 * form's answer to the top. Positions live in sessionStorage by path and query, kept against the
 * content at the top of the screen, so blocks that scripts fill above it after the swap do not
 * move the page. Runs before other `astro:after-swap` listeners, so Lenis, page transitions and
 * the site's own scripts start from the restored position, and puts the page back on that content
 * at `astro:page-load` and on the frame after it. Back and Forward get the same correction when
 * Astro restores the position the page was left at. The first call decides; it returns a
 * function that turns it off.
 *
 *     import { restoreScroll } from 'dioramajs/astro/client'
 *
 *     restoreScroll('parents')
 */
export function restoreScroll(mode: ScrollRestore): () => void {
  const made = holder[RESTORE]
  if (made) return made
  const controller = new AbortController()
  // Capture on window: Astro dispatches on document, so these run before its listeners.
  const options = { capture: true, signal: controller.signal }
  // `/work/` and `/work` are one page; `/work/` is the folder of `/work/aurora`, not of `/workshop`.
  const path = (url: URL): string => url.pathname.replace(/(.)\/$/, '$1')
  const dir = (url: URL): string => path(url).replace(/([^/])$/, '$1/')
  const page = (url: URL): string => path(url) + url.search
  let form = false
  let to: Spot | undefined
  let frame = 0
  const settle = (): void => {
    if (!to) return
    const [x, y] = place(to)
    if (Math.abs(x - scrollX) >= 1 || Math.abs(y - scrollY) >= 1) {
      scrollTo(x, y)
      // Lenis made here takes the position at once; another one follows the native scroll.
      const lenis = holder[KEY]
      if (lenis && !lenis.isScrolling) lenis.resize()
    }
    const state = history.state as object | null
    if (state) history.replaceState({ ...state, scrollX, scrollY }, '')
  }
  const stop = (): void => {
    to = undefined
    cancelAnimationFrame(frame)
  }
  for (const gesture of GESTURES) addEventListener(gesture, stop, { ...options, passive: true })
  addEventListener(
    'astro:before-preparation',
    (event) => {
      stop()
      form = !!(event as Event & { formData?: FormData }).formData
    },
    options,
  )
  addEventListener(
    'astro:before-swap',
    (event) => {
      const { from, to: next, navigationType } = event as SwapEvent
      const left = page(from)
      const seen = visited()
      delete seen[left]
      const found = anchors()
      seen[left] = found.length ? [scrollX, scrollY, found] : [scrollX, scrollY]
      for (const key of Object.keys(seen).slice(0, -KEEP)) delete seen[key]
      try {
        sessionStorage.setItem(VISITED, JSON.stringify(seen))
      } catch {}
      const spot = page(next) === left ? undefined : seen[page(next)]
      if (navigationType === 'traverse') {
        // Astro restores the entry's own scroll: corrected only when the page was left there.
        const y = (history.state as { scrollY?: number } | null)?.scrollY
        to = spot && typeof y === 'number' && Math.abs(spot[1] - y) < 1 ? spot : undefined
        return
      }
      const back =
        mode === 'visited' || (path(next) !== path(from) && dir(from).startsWith(dir(next)))
      to = back && !form && !next.hash ? spot : undefined
    },
    options,
  )
  // Astro has put the page at the top or at the entry's scroll: move it onto the content left and
  // into the entry Back comes to. The new page's scripts run before page-load, some fill a frame
  // later.
  addEventListener('astro:after-swap', settle, options)
  addEventListener(
    'astro:page-load',
    () => {
      settle()
      frame = requestAnimationFrame(() => {
        settle()
        to = undefined
      })
    },
    options,
  )
  const off = (): void => {
    stop()
    controller.abort()
    if (holder[RESTORE] === off) delete holder[RESTORE]
  }
  holder[RESTORE] = off
  return off
}
