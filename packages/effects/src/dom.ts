// The DOM side of the light part. One MutationObserver feeds a reconcile per microtask that
// finds markup, element targets and selector matches, and `data-dio-state` is derived here
// from the records, veils and intros. Also owns the stylesheet that hides drawn elements.
import type { Off } from '@dioramajs/core'
import { isEffectName } from './define'
import { EffectError } from './errors'
import type { Controller } from './instances'
import type { DomPort } from './ports'
import type { EffectsOptions, InstanceStatus } from './types'

type SheetHost = Document | ShadowRoot

/** Which app owns an element. A second app skips it. */
const claims = new WeakMap<Element, object>()

/** While the GL copy draws the element (or it is entering), the DOM element is invisible. */
const HIDE_CSS =
  '@media not print { [data-dio-state="drawn"], [data-dio-state="entering"] { filter: opacity(0) !important } }'
const MARKUP = '[data-dio], [data-dio-state]'
const STATE = 'data-dio-state'
/** How long an intro veil waits for the copy to draw, ms. */
const INTRO_WAIT = 3000
/** How long an intro veil stays once its instance runs without drawing, ms. */
const INTRO_LIVE = 500
/** Statuses from which an instance may still draw its element. */
const PENDING: ReadonlySet<InstanceStatus> = new Set(['waiting', 'loading', 'running'])
const ELEMENT_NODE = 1

export class Dom implements DomPort {
  readonly present: WeakMap<Element, 'live' | 'drawn'> = new WeakMap()
  /** A Set rather than a WeakSet, so destroy can lift every veil. */
  readonly veiled: Set<Element> = new Set()
  /** Intro veils (`EffectEntry.intro`) and their fallback timers, 0 once the timer is short. */
  readonly #intro = new Map<Element, ReturnType<typeof setTimeout> | 0>()
  readonly #controller: Controller
  readonly #main: ParentNode
  /** A string `root` option: only elements inside a match belong to the app. */
  readonly #selector: string | undefined
  readonly #markup: boolean
  readonly #observer: MutationObserver
  readonly #roots = new Set<ParentNode>()
  /** Expected `data-dio-state`. Absent means no attribute. */
  readonly #expected = new WeakMap<Element, string>()
  /** Elements whose param attributes are observed. */
  readonly #watched = new WeakSet<Element>()
  readonly #sheetHosts = new Map<SheetHost, HTMLStyleElement | undefined>()
  /** Watches `class` and `id` while selector rules exist. */
  #ruleObserver: MutationObserver | undefined
  #added = new Set<Element>()
  /** Subtrees whose selector matches may have changed. */
  #subtrees = new Set<Element>()
  #changedAttributes = new Map<Element, Set<string>>()
  #removed = false
  #scheduled = false
  #sheet: CSSStyleSheet | undefined
  #hiding = false

  constructor(controller: Controller, options: EffectsOptions) {
    this.#controller = controller
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
    this.#ruleObserver?.disconnect()
    for (const element of [...this.veiled]) this.veil(element, false)
    this.adopt(false)
    this.#roots.clear()
  }

  inRoot(element: Element): boolean {
    if (!element.isConnected) return false
    const host = element.getRootNode()
    for (const root of this.#roots) {
      if (!(root as Node).contains(element)) continue
      return !this.#selector || host !== document || element.closest(this.#selector) !== null
    }
    return false
  }

  *query(selector: string): Iterable<Element> {
    for (const root of this.#roots) {
      for (const element of root.querySelectorAll(selector)) {
        if (this.inRoot(element)) yield element
      }
    }
  }

  claim(element: Element): boolean {
    const owner = claims.get(element)
    if (owner === undefined) claims.set(element, this)
    else if (owner !== this) {
      const error = new EffectError('EFFECT_TARGET', 'element is taken by another app', { element })
      this.#controller.warn('claimed', error)
      return false
    }
    return true
  }

  release(element: Element): void {
    if (claims.get(element) === this && !this.veiled.has(element)) claims.delete(element)
  }

  free(element: Element): boolean {
    return (claims.get(element) ?? this) === this
  }

  /**
   * A veil claims an element nobody owns yet. Otherwise another app would strip `entering` as
   * foreign state and the two would rewrite it forever.
   */
  veil(element: Element, on: boolean): void {
    if (on) {
      this.veiled.add(element)
      if (!claims.has(element)) claims.set(element, this)
    } else {
      this.veiled.delete(element)
      if (!this.#controller.of(element).length) this.release(element)
    }
    this.sync(element)
  }

  /** Hides an element in view until its intro effect draws it. */
  intro(element: Element): void {
    if (this.#intro.has(element)) return
    // Only an element with a box at least partly in the viewport is veiled.
    const rect = element.getBoundingClientRect()
    const { width, height } = this.#controller.app.stage
    if (!(rect.width > 0 && rect.height > 0)) return
    if (rect.bottom <= 0 || rect.right <= 0) return
    if (rect.top >= height.peek() || rect.left >= width.peek()) return
    this.#intro.set(
      element,
      setTimeout(() => this.#liftIntro(element), INTRO_WAIT),
    )
    this.adopt(true)
    this.sync(element)
  }

  queue(element: Element): void {
    this.#added.add(element)
    this.#schedule()
  }

  /** Derives `data-dio-state`. A veil wins, then the runtime's 'live' or 'drawn', then status. */
  sync(element: Element): void {
    const records = this.#controller.of(element)
    const timer = this.#intro.get(element)
    if (timer !== undefined) {
      // Drawn, or nothing will draw it: the intro veil goes. Running without a drawn copy (the
      // effect shows its DOM) lets it go soon after.
      const shown = this.present.get(element)
      const { registry } = this.#controller
      const willDraw = records.some(
        (record) => PENDING.has(record.status) && registry.intro(record.name, element),
      )
      if (shown === 'drawn' || !willDraw) {
        clearTimeout(timer)
        this.#intro.delete(element)
      } else if (shown && timer) {
        clearTimeout(timer)
        this.#intro.set(element, 0)
        setTimeout(() => this.#liftIntro(element), INTRO_LIVE)
      }
    }
    let state: string | undefined =
      this.veiled.has(element) || this.#intro.has(element) ? 'entering' : this.present.get(element)
    if (!state && records.length) state = stateOf(records.map((record) => record.status))
    if (state === undefined) this.#expected.delete(element)
    else this.#expected.set(element, state)
    this.#writeState(element)
  }

  watch(element: Element, attributes: readonly string[]): void {
    if (this.#roots.has(element)) return
    if (!attributes.length) {
      // MutationObserver cannot unobserve one node, but an empty filter observes nothing.
      if (!this.#watched.has(element)) return
      this.#watched.delete(element)
    } else this.#watched.add(element)
    this.#observer.observe(element, { attributes: true, attributeFilter: [...attributes] })
  }

  /** A separate observer watches `class` and `id`, only while selector rules exist. */
  rules(active: boolean): void {
    if (active === !!this.#ruleObserver) return
    this.#ruleObserver?.disconnect()
    this.#ruleObserver = active
      ? new MutationObserver((records) => this.#collect(records))
      : undefined
    for (const root of this.#roots) this.#observe(root)
  }

  observe(root: ParentNode): Off {
    if (this.#roots.has(root)) return () => {}
    this.#roots.add(root)
    this.#observe(root)
    this.#applySheet()
    this.scan(root)
    return () => {
      if (!this.#roots.delete(root)) return
      this.#applySheet()
      this.#updateOutside()
    }
  }

  /** Reconciles a subtree now, including foreign state and rules. */
  scan(root?: ParentNode): void {
    const node = root ?? this.#main
    const elements = node instanceof Element ? [node] : [...node.children]
    for (const element of elements) {
      this.#added.add(element)
      this.#subtrees.add(element)
    }
    this.flush()
  }

  /** Reconciles by final state, not by records, so a node moved within one task is left alone. */
  flush(): void {
    this.#collect(this.#observer.takeRecords())
    if (this.#ruleObserver) this.#collect(this.#ruleObserver.takeRecords())
    this.#scheduled = false
    const added = this.#added
    const subtrees = this.#subtrees
    const attributes = this.#changedAttributes
    this.#added = new Set()
    this.#subtrees = new Set()
    this.#changedAttributes = new Map()
    const removed = this.#removed
    this.#removed = false

    if (removed) this.#updateOutside()
    this.#reconcileAdded(added)
    if (this.#controller.rules.size) {
      for (const element of new Set([...added, ...subtrees])) {
        if (element.isConnected) this.#controller.match(element)
      }
    }
    const markupChanged = this.#reconcileAttributes(attributes)
    // Layer queries and effect order are re-read only after structural changes.
    if (removed || added.size > 0 || subtrees.size > 0 || markupChanged) {
      this.#controller.engine.runtime?.scanned()
    }
  }

  /** Adds the hiding sheet to the document and observed shadow roots, or removes it. */
  adopt(on: boolean): void {
    this.#hiding = on
    this.#applySheet()
  }

  /** Instances whose element left the roots park if running and go otherwise. */
  #updateOutside(): void {
    for (const record of [...this.#controller.live]) {
      if (!this.inRoot(record.element)) this.#controller.update(record)
    }
  }

  #liftIntro(element: Element): void {
    clearTimeout(this.#intro.get(element))
    if (this.#intro.delete(element)) this.sync(element)
  }

  /** Writes only when the DOM differs, so our own mutation records come back as no-ops. */
  #writeState(element: Element): void {
    const expected = this.#expected.get(element)
    if (element.getAttribute(STATE) === (expected ?? null)) return
    const owner = claims.get(element)
    if (owner && owner !== this) return
    if (expected === undefined) element.removeAttribute(STATE)
    else element.setAttribute(STATE, expected)
  }

  #observe(root: ParentNode): void {
    const node = root as Node
    const options = { childList: true, subtree: true, attributes: true }
    this.#observer.observe(node, { ...options, attributeFilter: ['data-dio', STATE] })
    this.#ruleObserver?.observe(node, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id'],
    })
  }

  #schedule(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => this.flush())
  }

  #collect(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === 'childList') {
        if (record.removedNodes.length) this.#removed = true
        for (const node of record.addedNodes) {
          if (node.nodeType === ELEMENT_NODE) this.#added.add(node as Element)
        }
        continue
      }
      const name = record.attributeName
      if (!name || record.target.nodeType !== ELEMENT_NODE) continue
      const element = record.target as Element
      if (name === 'class' || name === 'id') this.#subtrees.add(element)
      else {
        const names = this.#changedAttributes.get(element) ?? new Set()
        this.#changedAttributes.set(element, names.add(name))
      }
    }
    if (records.length) this.#schedule()
  }

  /** Added subtrees: foreign state, markup, element targets, returning instances. */
  #reconcileAdded(added: Set<Element>): void {
    const controller = this.#controller
    let moved = false
    for (const node of added) {
      if (!node.isConnected) continue
      // With a selector root, check each candidate: the added node may contain the root.
      const inside = this.inRoot(node)
      if (!inside && !this.#selector) continue
      for (const record of [...controller.live]) {
        if (!node.contains(record.element)) continue
        moved = true
        controller.update(record)
      }
      const candidates = controller.targets
        ? [node, ...node.querySelectorAll('*')]
        : [node, ...node.querySelectorAll(MARKUP)]
      for (const element of candidates) {
        if (!inside && !this.inRoot(element)) continue
        this.#writeState(element)
        if (this.#markup && element.hasAttribute('data-dio')) {
          controller.markup(element, this.#tokens(element))
        }
        controller.added(element)
      }
    }
    if (moved) controller.app.anchors.refresh()
  }

  /** Changed attributes, by name. Returns true if a `data-dio` changed. */
  #reconcileAttributes(changed: Map<Element, Set<string>>): boolean {
    const controller = this.#controller
    let markupChanged = false
    for (const [element, names] of changed) {
      let params = false
      for (const name of names) {
        if (name === 'data-dio') {
          markupChanged = true
          if (this.#markup && this.inRoot(element)) {
            controller.markup(element, this.#tokens(element))
          }
        } else if (name === STATE) this.#writeState(element)
        else if (name === 'crossorigin') controller.retry(element)
        else if (name === 'data-dio-load') {
          for (const record of controller.of(element)) controller.advance(record)
        }
        // The runtime re-reads the track mode with the styles of a re-measured layer.
        else if (name === 'data-dio-track') controller.app.anchors.refresh()
        else if (name.endsWith('-when') && isWhen(controller, element, name)) {
          for (const record of controller.of(element)) controller.update(record)
        } else params = true
      }
      if (params) controller.attributeChanged(element)
    }
    return markupChanged
  }

  #tokens(element: Element): string[] {
    const tokens = new Set<string>()
    for (const token of (element.getAttribute('data-dio') ?? '').split(/\s+/)) {
      if (!token) continue
      if (!isEffectName(token)) {
        const message = `"${token}" is not an effect name`
        const error = new EffectError('EFFECT_UNKNOWN', message, { element })
        this.#controller.warn(`token:${token}`, error)
      } else if (tokens.has(token)) {
        const message = `"${token}" is repeated in data-dio`
        const error = new EffectError('EFFECT_PARAM', message, { element })
        this.#controller.warn(`repeat:${token}`, error)
      } else tokens.add(token)
    }
    return [...tokens]
  }

  #applySheet(): void {
    const wanted = new Set<SheetHost>()
    if (this.#hiding) {
      for (const root of this.#roots) wanted.add((root as Node).getRootNode() as SheetHost)
    }
    for (const [host, style] of this.#sheetHosts) {
      if (wanted.has(host)) continue
      this.#sheetHosts.delete(host)
      if (style) style.remove()
      else host.adoptedStyleSheets = host.adoptedStyleSheets.filter((s) => s !== this.#sheet)
    }
    for (const host of wanted) {
      if (this.#sheetHosts.has(host)) continue
      // An adopted stylesheet where supported, else a `<style>` element.
      if ('adoptedStyleSheets' in host && typeof CSSStyleSheet === 'function') {
        if (!this.#sheet) {
          this.#sheet = new CSSStyleSheet()
          this.#sheet.replaceSync(HIDE_CSS)
        }
        host.adoptedStyleSheets = [...host.adoptedStyleSheets, this.#sheet]
        this.#sheetHosts.set(host, undefined)
      } else {
        const style = document.createElement('style')
        style.textContent = HIDE_CSS
        ;(host instanceof Document ? host.head : host).append(style)
        this.#sheetHosts.set(host, style)
      }
    }
  }
}

/** `data-dio-state` from the statuses of an element's records, if they set one. */
/** `data-dio-when`, or the addressed form for one of the element's effects. */
function isWhen(controller: Controller, element: Element, name: string): boolean {
  if (name === 'data-dio-when') return true
  for (const record of controller.of(element))
    if (name === `data-dio-${record.name}-when`) return true
  return false
}

function stateOf(statuses: readonly InstanceStatus[]): string | undefined {
  if (statuses.includes('loading')) return 'loading'
  if (statuses.every((status) => status === 'failed')) return 'failed'
  // Turned off by the gate, `when`, reduced motion or `disable`, and nothing else will run.
  const off = statuses.every((status) => status === 'off' || status === 'failed')
  if (statuses.includes('unavailable') || off) return 'off'
  return undefined
}
