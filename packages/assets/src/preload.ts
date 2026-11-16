import type { Off } from '@diorama/core'
import { DEV, isAbort, noop } from './errors'
import { absolute, keyOf, srcset } from './keys'
import { bitmap, loaded } from './loaders'
import type {
  Asset,
  CrossOrigin,
  LoaderContext,
  LoadOptions,
  Preload,
  PreloadOptions,
  PreloadSource,
  Priority,
} from './types'

/** Hover longer than this is an intent to follow the link. */
const INTENT_MS = 65
const IMAGES = 'img[data-dio], img[data-dio-key]'
const MARKUP = '[data-dio-preload]'

export interface PreloadHost {
  /** A preload lease. Failures are not reported. */
  load(url: string, options: LoadOptions & { readonly type: string }): Asset<unknown>
  acquire(
    key: string,
    make: (context: LoaderContext) => Promise<never>,
    priority: Priority,
  ): Asset<unknown, unknown>
  /** An entry under the key, loading, ready or retained. */
  has(key: string): boolean
  /** A request slot for the browser's own request of a detached image. */
  slot(priority: Priority, signal: AbortSignal): Promise<Off>
  /** The type of an absolute URL by its extension. Undefined for a page address. */
  typeOf(url: string): string | undefined
  track(work: Promise<unknown>, priority: Priority): void
  warn(message: string): void
}

interface Target {
  readonly href: string
  readonly type: string
  readonly crossOrigin: CrossOrigin
  readonly key: string
}

interface Connection {
  readonly saveData?: boolean
  readonly effectiveType?: string
}

/** Nothing is preloaded under Save-Data or on a 2g connection. */
export function frugal(): boolean {
  const connection = (globalThis.navigator as { connection?: Connection } | undefined)?.connection
  return connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? '')
}

/** The CORS mode of an element as a key part. No attribute gives '' (no CORS). */
export function corsOf(el: Element): CrossOrigin {
  const value = el.getAttribute('crossorigin')
  if (value === null) return ''
  return value.toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous'
}

interface Copy {
  readonly img: HTMLImageElement
  /** Called once the queue gives a slot. */
  start(): void
}

/**
 * A detached image that picks the candidate the element would. Same `crossorigin`, `sizes` and
 * absolute `srcset`, inside a copy of its <picture>.
 */
function copy(source: Element, base: string, priority: Priority): Copy | undefined {
  const src = source.getAttribute('src')
  const set = source.getAttribute('srcset')
  if (!src && !set) return undefined
  const img = new Image()
  const cors = source.getAttribute('crossorigin')
  if (cors !== null) img.setAttribute('crossorigin', cors)
  const sizes = source.getAttribute('sizes')
  if (sizes) img.setAttribute('sizes', sizes)
  if (priority !== 'normal') img.setAttribute('fetchpriority', priority)
  let holder: HTMLPictureElement | undefined
  const picture = source.parentElement
  if (picture?.localName === 'picture') {
    holder = document.createElement('picture')
    for (const child of picture.children) {
      if (child.localName !== 'source') continue
      const item = document.createElement('source')
      for (const { name, value } of child.attributes) {
        item.setAttribute(name, name === 'srcset' ? srcset(value, base) : value)
      }
      holder.append(item)
    }
  }
  return {
    img,
    start() {
      // Each of these makes the image pick a source and load it.
      holder?.append(img)
      if (set) img.setAttribute('srcset', srcset(set, base))
      if (src) img.src = new URL(src, base).href
    },
  }
}

const words = (el: Element): string[] => (el.getAttribute('data-dio-preload') ?? '').split(/\s+/)

class PreloadImpl implements Preload {
  readonly leases: Asset<unknown, unknown>[] = []
  readonly abort: AbortController = new AbortController()
  settled: Promise<void> = Promise.resolve()

  release = (): void => {
    this.abort.abort()
    for (const lease of this.leases.splice(0)) lease.release()
  }

  dispose: () => void = this.release

  // biome-ignore lint/suspicious/noThenProperty: a preload is thenable by design
  then: PromiseLike<void>['then'] = (fulfilled, rejected) => this.settled.then(fulfilled, rejected)
}

/** API and markup preloads. Only the last of each kind holds its leases. */
export class Preloads {
  readonly #host: PreloadHost
  readonly #last = new Map<'api' | 'markup', PreloadImpl>()
  /** A broken link warns once in development, not on every intent. */
  readonly #warned = new Set<string>()

  constructor(host: PreloadHost) {
    this.#host = host
  }

  preload(
    source: PreloadSource,
    options: PreloadOptions = {},
    kind: 'api' | 'markup' = 'api',
  ): Preload {
    const preload = new PreloadImpl()
    if (frugal()) return preload
    const priority = options.priority ?? 'low'
    const base = this.#base(source, options.base)
    const jobs: Promise<unknown>[] = []
    const url = (href: string, cors: CrossOrigin): void => {
      if (href) jobs.push(this.#url(preload, href, base, priority, cors))
    }
    const cors = options.crossOrigin ?? ''
    if (typeof source === 'string') url(source, cors)
    else if (Array.isArray(source)) for (const href of source as readonly string[]) url(href, cors)
    else if (typeof source === 'object') {
      const root = source as ParentNode
      const own = root instanceof Element ? [root] : []
      for (const el of [...own, ...root.querySelectorAll(IMAGES)]) {
        if (el.matches(IMAGES)) jobs.push(this.#image(preload, el, base, priority))
      }
      for (const el of [...own, ...root.querySelectorAll(MARKUP)]) {
        if (el.matches(MARKUP)) for (const href of words(el)) url(href, corsOf(el))
      }
    }
    preload.settled = Promise.all(jobs).then(noop)
    if (priority !== 'low') this.#host.track(preload.settled, priority)
    // Release after taking the new leases, so shared entries skip a trip through `retain`.
    this.#last.get(kind)?.release()
    this.#last.set(kind, preload)
    return preload
  }

  /** `data-dio-preload` on intent: hover (65 ms), focus or touch. */
  listen(signal: AbortSignal): void {
    let hovered: Element | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const target = (event: Event): Element | null =>
      (event.target as Element | null)?.closest?.(MARKUP) ?? null
    const intent = (el: Element | null): void => {
      if (!el) return
      const urls = words(el)
      const crossOrigin = corsOf(el)
      // Load again only what the cache lost: a preload dropped mid-load by the next intent, an
      // evicted or failed entry. The new preload holds all of the link's URLs.
      const lost = (url: string): boolean => {
        const wanted = this.#target(url, document.baseURI, crossOrigin)
        return typeof wanted === 'string' || !this.#host.has(wanted.key)
      }
      if (urls.some((url) => url && lost(url))) this.preload(urls, { crossOrigin }, 'markup')
    }
    const options = { signal, passive: true }
    document.addEventListener(
      'pointerover',
      (event) => {
        const el = target(event)
        if (!el || el === hovered) return
        clearTimeout(timer)
        hovered = el
        timer = setTimeout(() => intent(el), INTENT_MS)
      },
      options,
    )
    document.addEventListener(
      'pointerout',
      (event) => {
        const el = target(event)
        if (!el || el !== hovered || el.contains((event as PointerEvent).relatedTarget as Node)) {
          return
        }
        clearTimeout(timer)
        hovered = undefined
      },
      options,
    )
    document.addEventListener('focusin', (event) => intent(target(event)), options)
    document.addEventListener('touchstart', (event) => intent(target(event)), options)
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }

  close(): void {
    for (const preload of this.#last.values()) preload.release()
    this.#last.clear()
  }

  #base(source: PreloadSource, base: string | URL | undefined): string {
    if (base !== undefined) return new URL(base, document.baseURI).href
    const doc = (source as Partial<Node>).nodeType === 9 ? (source as Document) : undefined
    const href = doc?.querySelector('base[href]')?.getAttribute('href')
    return href ? new URL(href, document.baseURI).href : document.baseURI
  }

  /** The entry a preload of the URL takes, or the reason there is none. */
  #target(url: string, base: string, cors: CrossOrigin): Target | string {
    let href: string
    try {
      href = absolute(url, base)
    } catch {
      return `${url} is not a URL`
    }
    const found = this.#host.typeOf(href)
    // A page address. Router integrations pass the fetched Document instead.
    if (!found)
      return `ASSET_TYPE: ${href} has no asset type: preload takes asset URLs or a Document`
    // Images preload their pixels, since `texture` and the effects pool share the `image` entry.
    // Only images key by CORS mode. Models load like a `load()` without `crossOrigin`.
    const type = found === 'texture' ? 'image' : found
    const crossOrigin = type === 'image' ? cors : ''
    return { href, type, crossOrigin, key: keyOf(type, href, crossOrigin, {}) }
  }

  #url(
    preload: PreloadImpl,
    url: string,
    base: string,
    priority: Priority,
    cors: CrossOrigin,
  ): Promise<void> {
    const target = this.#target(url, base, cors)
    if (typeof target === 'string') return this.#failed(target)
    const { href, type, crossOrigin } = target
    const { signal } = preload.abort
    return this.#hold(preload, this.#host.load(href, { type, priority, crossOrigin, signal }), href)
  }

  /**
   * A failed lease goes at once, so the entry leaves the cache and the page's own load is a new
   * attempt, reported if it fails too.
   */
  async #hold(preload: PreloadImpl, lease: Asset<unknown, unknown>, url: string): Promise<void> {
    preload.leases.push(lease)
    try {
      await lease.ready
    } catch (error) {
      const at = preload.leases.indexOf(lease)
      if (at >= 0) preload.leases.splice(at, 1)
      lease.release()
      return this.#failed(error, url)
    }
  }

  async #image(
    preload: PreloadImpl,
    source: Element,
    base: string,
    priority: Priority,
  ): Promise<void> {
    const { signal } = preload.abort
    let made: Copy | undefined
    try {
      made = copy(source, base, priority)
    } catch {
      return
    }
    if (!made) return
    const { img } = made
    const url = source.getAttribute('src') ?? source.getAttribute('srcset') ?? ''
    try {
      const free = await this.#host.slot(priority, signal)
      try {
        made.start()
        await loaded(img, url, signal)
      } finally {
        free()
      }
    } catch (error) {
      return this.#failed(error, url)
    }
    if (signal.aborted) return
    // The browser picked the candidate, so its URL is the key the page's <img> will have.
    const src = absolute(img.currentSrc || img.src)
    const key = keyOf('image', src, corsOf(img), {})
    const target = img
    const lease = this.#host.acquire(
      key,
      (context) => context.decode(() => bitmap(target, src)) as Promise<never>,
      priority,
    )
    return this.#hold(preload, lease, src)
  }

  #failed(error: unknown, url?: string): Promise<void> {
    // The page loads it itself, so only warn in development.
    if (DEV && !isAbort(error)) {
      const message =
        typeof error === 'string' ? error : `preload of ${url} failed: ${String(error)}`
      if (!this.#warned.has(message)) this.#host.warn(message)
      this.#warned.add(message)
    }
    return Promise.resolve()
  }
}
