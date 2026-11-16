import type { Off } from '@diorama/core'
import { isEffectName } from './define'
import { EffectError } from './errors'
import type { Controller, DomPort } from './instances'
import type { EffectsOptions } from './types'

/** Which app owns an element. A second app skips it. */
const claims = new WeakMap<Element, object>()

const HIDE =
  '@media not print { [data-dio-state="drawn"], [data-dio-state="entering"] { filter: opacity(0) !important } }'
const MARKUP = '[data-dio], [data-dio-state]'
type Host = Document | ShadowRoot

/** DOM side of the light part: one MutationObserver, a reconcile per microtask, foreign state. */
export class Dom implements DomPort {
  readonly present: WeakMap<Element, 'live' | 'drawn'> = new WeakMap()
  /** A Set rather than a WeakSet, so destroy can lift every veil. */
  readonly veiled: Set<Element> = new Set()
  readonly #ctl: Controller
  readonly #main: ParentNode
  readonly #selector: string | undefined
  readonly #markup: boolean
  readonly #observer: MutationObserver
  readonly #roots = new Set<ParentNode>()
  /** Expected `data-dio-state`. Absent means no attribute. */
  readonly #expected = new WeakMap<Element, string>()
  readonly #watched = new WeakSet<Element>()
  #classes: MutationObserver | undefined
  #added = new Set<Element>()
  #subtrees = new Set<Element>()
  #attrs = new Map<Element, Set<string>>()
  #removed = false
  #scheduled = false
  #sheet: CSSStyleSheet | undefined
  #adopted = false
  readonly #hosts = new Map<Host, HTMLStyleElement | undefined>()

  constructor(ctl: Controller, options: EffectsOptions) {
    this.#ctl = ctl
    const { root } = options
    this.#main = typeof root === 'object' && root ? root : document.documentElement
    this.#selector = typeof root === 'string' ? root : undefined
    this.#markup = options.markup
    this.#observer = new MutationObserver((records) => this.#collect(records))
  }

  start(): void {
    this.#roots.add(this.#main)
    this.#observe(this.#main)
    this.scan()
  }

  destroy(): void {
    this.#observer.disconnect()
    this.#classes?.disconnect()
    for (const el of [...this.veiled]) this.veil(el, false)
    this.adopt(false)
    this.#roots.clear()
  }

  inRoot(el: Element): boolean {
    if (!el.isConnected) return false
    const host = el.getRootNode()
    for (const root of this.#roots) {
      if (!(root as Node).contains(el)) continue
      return !this.#selector || host !== document || el.closest(this.#selector) !== null
    }
    return false
  }

  *query(selector: string): Iterable<Element> {
    for (const root of this.#roots) {
      for (const el of root.querySelectorAll(selector)) if (this.inRoot(el)) yield el
    }
  }

  claim(el: Element): boolean {
    const owner = claims.get(el)
    if (owner === undefined) claims.set(el, this)
    else if (owner !== this) {
      const error = new EffectError('EFFECT_TARGET', 'element is taken by another app', {
        element: el,
      })
      this.#ctl.warn('claimed', error)
      return false
    }
    return true
  }

  release(el: Element): void {
    if (claims.get(el) === this && !this.veiled.has(el)) claims.delete(el)
  }

  free(el: Element): boolean {
    return (claims.get(el) ?? this) === this
  }

  /**
   * A veil claims an element nobody owns yet. Otherwise another app would strip `entering` as
   * foreign state and the two would rewrite it forever.
   */
  veil(el: Element, on: boolean): void {
    if (on) {
      this.veiled.add(el)
      if (!claims.has(el)) claims.set(el, this)
    } else {
      this.veiled.delete(el)
      if (!this.#ctl.of(el).length) this.release(el)
    }
    this.sync(el)
  }

  queue(el: Element): void {
    this.#added.add(el)
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => this.flush())
  }

  /** Derives `data-dio-state`. A veil wins, then the runtime's 'live' or 'drawn', then status. */
  sync(el: Element): void {
    const records = this.#ctl.of(el)
    let state: string | undefined = this.veiled.has(el) ? 'entering' : this.present.get(el)
    if (!state && records.length) {
      if (records.some((r) => r.status === 'loading')) state = 'loading'
      else if (records.every((r) => r.status === 'failed')) state = 'failed'
      else if (
        records.some((r) => r.status === 'unavailable') ||
        (this.#ctl.engine.blocked === 'off' && records.some((r) => r.status === 'off'))
      ) {
        state = 'off'
      }
    }
    if (state === undefined) this.#expected.delete(el)
    else this.#expected.set(el, state)
    this.#fix(el)
  }

  /** Writes only when the DOM differs, so our own mutation records come back as no-ops. */
  #fix(el: Element): void {
    const want = this.#expected.get(el)
    if (el.getAttribute('data-dio-state') === (want ?? null)) return
    const owner = claims.get(el)
    if (owner && owner !== this) return
    if (want === undefined) el.removeAttribute('data-dio-state')
    else el.setAttribute('data-dio-state', want)
  }

  watch(el: Element, attributes: readonly string[]): void {
    if (this.#roots.has(el)) return
    if (!attributes.length) {
      // MutationObserver cannot unobserve one node, but an empty filter observes nothing.
      if (!this.#watched.has(el)) return
      this.#watched.delete(el)
    } else this.#watched.add(el)
    this.#observer.observe(el, { attributes: true, attributeFilter: [...attributes] })
  }

  /** A separate observer watches `class` and `id`, only while selector rules exist. */
  rules(active: boolean): void {
    if (active === !!this.#classes) return
    this.#classes?.disconnect()
    this.#classes = active ? new MutationObserver((records) => this.#collect(records)) : undefined
    for (const root of this.#roots) this.#observe(root)
  }

  #observe(root: ParentNode): void {
    const node = root as Node
    const options = { childList: true, subtree: true, attributes: true }
    this.#observer.observe(node, { ...options, attributeFilter: ['data-dio', 'data-dio-state'] })
    this.#classes?.observe(node, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id'],
    })
  }

  observe(root: ParentNode): Off {
    if (this.#roots.has(root)) return () => {}
    this.#roots.add(root)
    this.#observe(root)
    this.#apply()
    this.scan(root)
    return () => {
      if (!this.#roots.delete(root)) return
      this.#apply()
      for (const rec of [...this.#ctl.live]) if (!this.inRoot(rec.element)) this.#ctl.update(rec)
    }
  }

  /** Reconciles a subtree now, including foreign state and rules. */
  scan(root?: ParentNode): void {
    const node = root ?? this.#main
    const elements = node instanceof Element ? [node] : [...node.children]
    for (const el of elements) {
      this.#added.add(el)
      this.#subtrees.add(el)
    }
    this.flush()
  }

  #collect(records: MutationRecord[]): void {
    for (const r of records) {
      if (r.type === 'childList') {
        if (r.removedNodes.length) this.#removed = true
        for (const node of r.addedNodes) if (node.nodeType === 1) this.#added.add(node as Element)
      } else if (r.attributeName && r.target.nodeType === 1) {
        const el = r.target as Element
        if (r.attributeName === 'class' || r.attributeName === 'id') this.#subtrees.add(el)
        else {
          const names = this.#attrs.get(el) ?? new Set()
          this.#attrs.set(el, names.add(r.attributeName))
        }
      }
    }
    if (this.#scheduled || !records.length) return
    this.#scheduled = true
    queueMicrotask(() => this.flush())
  }

  /** Reconciles by final state, not by records, so a node moved within one task is left alone. */
  flush(): void {
    this.#collect(this.#observer.takeRecords())
    if (this.#classes) this.#collect(this.#classes.takeRecords())
    this.#scheduled = false
    const ctl = this.#ctl
    const added = this.#added
    const subtrees = this.#subtrees
    const attrs = this.#attrs
    this.#added = new Set()
    this.#subtrees = new Set()
    this.#attrs = new Map()

    // Layer queries and effect order are re-read only after structural changes.
    let structural = this.#removed || added.size > 0 || subtrees.size > 0

    // 1. Disconnected instances park if running and go otherwise.
    if (this.#removed) {
      this.#removed = false
      for (const rec of [...ctl.live]) if (!this.inRoot(rec.element)) ctl.update(rec)
    }

    // 2. Added subtrees: foreign state, markup, element targets, returning instances.
    let moved = false
    for (const node of added) {
      if (!node.isConnected) continue
      // With a selector root, check each candidate: the added node may contain the root.
      const inside = this.inRoot(node)
      if (!inside && !this.#selector) continue
      for (const rec of [...ctl.live]) {
        if (!node.contains(rec.element)) continue
        moved = true
        ctl.update(rec)
      }
      const candidates = ctl.targets
        ? [node, ...node.querySelectorAll('*')]
        : [node, ...node.querySelectorAll(MARKUP)]
      for (const el of candidates) {
        if (!inside && !this.inRoot(el)) continue
        this.#fix(el)
        if (this.#markup && el.hasAttribute('data-dio')) ctl.markup(el, this.#tokens(el))
        ctl.added(el)
      }
    }
    if (moved) ctl.app.anchors.refresh()

    // 3. Selector rules, both ways.
    if (ctl.rules.size) {
      for (const el of new Set([...added, ...subtrees])) if (el.isConnected) ctl.match(el)
    }

    // 4. Attributes.
    for (const [el, names] of attrs) {
      let params = false
      for (const name of names) {
        if (name === 'data-dio') {
          structural = true
          if (this.#markup && this.inRoot(el)) ctl.markup(el, this.#tokens(el))
        } else if (name === 'data-dio-state') this.#fix(el)
        else if (name === 'crossorigin') ctl.retry(el)
        else if (name === 'data-dio-load') for (const rec of ctl.of(el)) ctl.advance(rec)
        // The runtime re-reads the track mode with the styles of a re-measured layer.
        else if (name === 'data-dio-track') ctl.app.anchors.refresh()
        else params = true
      }
      if (params) ctl.attributeChanged(el)
    }
    if (structural) ctl.engine.runtime?.scanned()
  }

  #tokens(el: Element): string[] {
    const tokens = new Set<string>()
    for (const token of (el.getAttribute('data-dio') ?? '').split(/\s+/)) {
      if (!token) continue
      if (!isEffectName(token)) {
        const error = new EffectError('EFFECT_UNKNOWN', `"${token}" is not an effect name`, {
          element: el,
        })
        this.#ctl.warn(`token:${token}`, error)
      } else if (tokens.has(token)) {
        const error = new EffectError('EFFECT_PARAM', `"${token}" is repeated in data-dio`, {
          element: el,
        })
        this.#ctl.warn(`repeat:${token}`, error)
      } else tokens.add(token)
    }
    return [...tokens]
  }

  /** Adds the hiding sheet to the document and observed shadow roots, or removes it. */
  adopt(on: boolean): void {
    this.#adopted = on
    this.#apply()
  }

  #apply(): void {
    const want = new Set<Host>()
    if (this.#adopted)
      for (const root of this.#roots) want.add((root as Node).getRootNode() as Host)
    for (const [host, style] of this.#hosts) {
      if (want.has(host)) continue
      this.#hosts.delete(host)
      if (style) style.remove()
      else host.adoptedStyleSheets = host.adoptedStyleSheets.filter((s) => s !== this.#sheet)
    }
    for (const host of want) {
      if (this.#hosts.has(host)) continue
      if ('adoptedStyleSheets' in host && typeof CSSStyleSheet === 'function') {
        if (!this.#sheet) {
          this.#sheet = new CSSStyleSheet()
          this.#sheet.replaceSync(HIDE)
        }
        host.adoptedStyleSheets = [...host.adoptedStyleSheets, this.#sheet]
        this.#hosts.set(host, undefined)
      } else {
        const style = document.createElement('style')
        style.textContent = HIDE
        ;(host instanceof Document ? host.head : host).append(style)
        this.#hosts.set(host, style)
      }
    }
  }
}
