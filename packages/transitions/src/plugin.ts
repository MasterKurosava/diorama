import {
  type Anchor,
  definePlugin,
  definePreset,
  type FrameTime,
  type Off,
  type Plugin,
  type Preset,
  type Signal,
  signal,
} from '@dioramajs/core'
import { DEV } from '@dioramajs/core/dev'
import type { Copy, ReleaseRequest } from '@dioramajs/effects'
import { keySelector, NATIVE, nativeActive, within } from './dom'
import { TransitionError } from './errors'
import { clamp, cubic, hold, lerp, noop, poseOf, sized } from './geometry'
import { Page, pathOf } from './page'
import { Pool } from './pool'
import { stageSheet } from './sheet'
import {
  type Host,
  type Settings,
  type Source,
  skipped,
  TransitionImpl,
  type View,
} from './transition'
import type {
  PageScope,
  Swap,
  Transition,
  TransitionApi,
  TransitionOptions,
  TransitionPhase,
  TransitionsOptions,
} from './types'

// The `transition` plugin. It owns the current transition, and what outlives one: the pool of
// waiting ghosts, hidden remnants, fades handed over by a superseded transition, page scopes, and
// auto mode, which flies keyed copies when a router swaps the DOM without calling a transition.

/** A copy kept hidden on an element a flight left from, until a later transition flies back. */
interface Remnant {
  readonly copy: Copy
  readonly gen: number
  /** Where its flight landed. The remnant shows again once this goes away. */
  readonly partner: Anchor | undefined
}

/** A presence or opacity fade the plugin plays on its own clock. */
interface Fade {
  readonly copy: Copy
  readonly prop: 'opacity' | 'presence'
  readonly from: number
  readonly to: number
  /** Seconds it takes. */
  readonly span: number
  end: () => void
  /** Seconds played so far. */
  time: number
}

/** Routers move these into the new page themselves, so they keep their instances. */
const PERSIST = '[data-turbo-permanent],[data-astro-transition-persist]'
/** A long frame counts as at most this many display frames, so the picture freezes, not jumps. */
const MAX_FRAMES_PER_STEP = 2
/** `Node.ELEMENT_NODE`. */
const ELEMENT_NODE = 1

/** Plugin state: current transition, pool, remnants, page scopes and auto mode. */
class Director implements Host {
  readonly app: View
  readonly options: Settings
  readonly signal: AbortSignal
  readonly current: Signal<TransitionImpl | undefined> = signal<TransitionImpl | undefined>(
    undefined,
  )
  readonly pool: Pool
  readonly api: TransitionApi
  page: Page
  gen = 0
  readonly #remnants = new Map<Element, Remnant>()
  readonly #fades = new Set<Fade>()
  readonly #observer: MutationObserver
  readonly #warned = new Set<string>()
  /** Ghosts taken by auto mode in this reconcile, flown together in a microtask. */
  #batch: Source[] = []
  /** Keeps frames coming while anything moves. */
  #awake: Off | undefined
  #watching = false
  #path: string
  /** `performance.now()` of the last pathname change. */
  #navigated = Number.NEGATIVE_INFINITY
  // Pathname an explicit transition just left while history still shows it. Astro pushes the new
  // URL after the swap, and that push must not count as a navigation.
  #leftPath: string | undefined

  constructor(app: View, options: Settings) {
    this.app = app
    this.options = options
    this.signal = app.abortSignal
    this.page = new Page(location.href)
    this.#path = location.pathname
    this.pool = new Pool(
      () => (app.stage.reducedMotion.peek() ? 0 : options.grace),
      () => this.watch(),
    )
    // Must be created after the effects observer. That one runs first and only schedules the
    // reconcile, so this one gets to hide arriving targets before effects sees them.
    this.#observer = new MutationObserver((records) => this.#mutated(records))
    app.system('layout', (time) => this.#frame(time), {
      name: 'transition',
      after: 'anchors',
      before: 'effects:inputs',
    })
    app.hook('effects:release', (request) => this.#released(request))
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.current.peek()?.hidden()
      },
      { signal: this.signal },
    )
    // Its own listener per app: the first one to run stops the click for the others.
    addEventListener('click', (event) => passClick(event), { capture: true, signal: this.signal })
    stageSheet(app)
    app.onDispose(() => this.#dispose())
    this.watch()
    this.api = apiOf(
      (swap, options = {}) =>
        this.signal.aborted ? skipped(swap) : new TransitionImpl(this, options, false).run(swap),
      this.current,
      () => this.page,
    )
  }

  supersede(): Source[] {
    return this.current.peek()?.handOver() ?? []
  }

  open(transition: TransitionImpl): void {
    this.current.value = transition
    if (!transition.auto) this.attr('swapping')
    this.watch()
  }

  close(transition: TransitionImpl): void {
    if (this.current.peek() === transition) {
      this.current.value = undefined
      this.attr(undefined)
    }
    this.watch()
  }

  rotate(url: string): void {
    const old = this.page
    this.app.emit('page:leave', { url: old.url })
    old.close((error) => this.app.report(error, 'page'))
    this.page = new Page(url)
    const path = location.pathname
    this.#leftPath = pathOf(url) === path ? undefined : path
  }

  remnant(copy: Copy, gen: number, partner?: Element): void {
    const { element } = copy
    this.#forget(element)
    if (copy.state === 'released' || !element.isConnected) {
      copy.release()
      return
    }
    copy.veil = true
    copy.leave = 'release'
    copy.box = copy.radius = copy.clip = undefined
    copy.opacity = copy.presence = 1
    copy.above = 0
    this.#remnants.set(element, {
      copy,
      gen,
      partner: partner && this.app.anchors.track(partner),
    })
  }

  reclaim(element: Element): Copy | undefined {
    // A fade may still show it (a remnant coming back, an entering copy). Hand it over veiled.
    for (const fade of this.#fades) {
      if (fade.copy.element !== element || fade.copy.state === 'ghost') continue
      this.#fades.delete(fade)
      this.remnant(fade.copy, 0)
    }
    const remnant = this.#forget(element)
    return remnant?.copy.state === 'released' ? undefined : remnant?.copy
  }

  prune(gen: number): void {
    for (const [element, remnant] of this.#remnants) {
      if (remnant.gen >= gen && element.isConnected && remnant.copy.state !== 'released') continue
      this.#forget(element)
      remnant.copy.release()
    }
  }

  #forget(element: Element): Remnant | undefined {
    const remnant = this.#remnants.get(element)
    this.#remnants.delete(element)
    remnant?.partner?.dispose()
    return remnant
  }

  // Fades remnants back in once their partner is gone, e.g. a modal closed without a transition.
  // Not inside a window, whose transition may still fly back to them.
  #restore(): void {
    if (this.current.peek()?.window) return
    for (const [element, { copy, partner }] of this.#remnants) {
      const hidden = partner && partner.version > 0 && !sized(partner)
      if (!partner || (partner.element.isConnected && !hidden)) continue
      this.#forget(element)
      if (copy.state === 'released') continue
      copy.veil = false
      copy.presence = 0
      this.fade(copy, 'presence', 1, this.options.crossfade, () => copy.release())
    }
  }

  fade(copy: Copy, prop: 'opacity' | 'presence', to: number, span: number, end: () => void): void {
    this.#fades.add({ copy, prop, from: copy[prop], to, span, end, time: 0 })
    this.app.invalidate()
  }

  adopt(element: Element): Copy | undefined {
    for (const fade of this.#fades) {
      const { copy } = fade
      if (copy.element !== element || copy.state === 'ghost' || copy.state === 'released') continue
      // The fade keeps playing and the caller owns the copy from here. An opacity fade (reduced
      // motion) would fight the caller's writes, so that one stops where it is.
      if (fade.prop === 'opacity') this.#fades.delete(fade)
      else fade.end = noop
      copy.leave = 'ghost'
      return copy
    }
    return undefined
  }

  attr(phase: TransitionPhase | undefined): void {
    const root = document.documentElement
    if (phase) root.setAttribute('data-dio-transition', phase)
    else root.removeAttribute('data-dio-transition')
  }

  warn(code: TransitionError['code'], message: string, once?: string): void {
    if (!DEV || (once !== undefined && this.#warned.has(code + once))) return
    if (once !== undefined) this.#warned.add(code + once)
    this.app.log.warn(new TransitionError(code, message).message)
  }

  report(code: TransitionError['code'], message: string, cause: unknown): void {
    this.app.report(new TransitionError(code, message, { cause }))
  }

  /** Observe only in auto mode, during a transition, or while ghosts wait in the pool. */
  watch(): void {
    const on = this.options.auto || !!this.current.peek() || this.pool.size > 0
    if (on === this.#watching || this.signal.aborted) return
    this.#watching = on
    if (on) this.#observer.observe(document.documentElement, { childList: true, subtree: true })
    else this.#observer.disconnect()
  }

  #frame(time: FrameTime): void {
    // Cap a long frame (first shader compile, GC pause) so the picture freezes instead of
    // jumping. Offline steps use the exact delta.
    const { loop } = this.app
    const most =
      loop.stats.reason === 'step'
        ? time.delta
        : MAX_FRAMES_PER_STEP * loop.stats.interval * loop.timeScale
    const dt = Math.min(time.delta, most)
    let busy = this.current.peek()?.frame(dt) ?? false
    this.#restore()
    // Fades handed over by superseded transitions play on here.
    for (const fade of this.#fades) {
      fade.time += dt
      const t = fade.span > 0 ? clamp(fade.time / fade.span) : 1
      fade.copy[fade.prop] = lerp(fade.from, fade.to, t)
      if (t < 1) busy = true
      else {
        this.#fades.delete(fade)
        fade.end()
      }
    }
    if (busy && !this.#awake) this.#awake = this.app.hold('transition')
    else if (!busy && this.#awake) {
      this.#awake()
      this.#awake = undefined
    }
  }

  /** Marks a pathname change as a navigation for auto mode. Query and hash don't count. */
  #noteNavigation(): void {
    if (location.pathname !== this.#leftPath) this.#leftPath = undefined
    if (location.pathname === this.#path) return
    this.#path = location.pathname
    this.#navigated = performance.now()
  }

  /** Only takes copies. Transitions open after the reconcile, in #flush. */
  #released(request: ReleaseRequest): void {
    const { element } = request
    const key = element.getAttribute('data-dio-key')
    const active = this.current.peek()
    if (active?.window) {
      active.released(request, key)
      return
    }
    this.#noteNavigation()
    if (!this.options.auto || !request.visible || element.closest(PERSIST)) return
    if (key === null) {
      // An unkeyed copy fades out with a browser view transition, if one runs.
      const seconds = this.#nativeFade()
      const copy = seconds > 0 ? request.take({ signal: this.signal }) : undefined
      if (copy) {
        hold(copy, request.drawn)
        this.#fadeOut(copy, seconds, () => copy.release())
      }
      return
    }
    // Worth taking only if a partner is already in the document or a navigation just happened.
    const recent = performance.now() - this.#navigated < this.options.grace * 1000
    if (!recent && !document.querySelector(keySelector(key))) return
    const copy = request.take({ signal: this.signal })
    if (!copy) return
    hold(copy, request.drawn)
    this.#batch.push({ key, named: false, element, copy, pose: request.drawn })
    if (this.#batch.length === 1) queueMicrotask(() => this.#flush())
  }

  /** After the reconcile. Paired ghosts fly together, the rest go to the pool. */
  #flush(): void {
    const items = this.#batch.splice(0).filter((source) => source.copy.state !== 'released')
    const active = this.current.peek()
    if (active?.window) {
      active.adopt(items)
      return
    }
    const paired = items.filter((source) => document.querySelector(keySelector(source.key)))
    const seconds = this.#nativeFade()
    for (const source of items) {
      if (paired.includes(source)) continue
      const wait = (): void => this.pool.add(source.key, source.copy)
      if (seconds > 0) this.#fadeOut(source.copy, seconds, wait)
      else wait()
    }
    if (paired.length) new TransitionImpl(this, {}, true).fly(paired)
  }

  // Seconds unpaired copies fade in auto mode. They only fade inside a browser view transition,
  // whose old root snapshot has holes where they were. Elsewhere they go with their DOM.
  #nativeFade(): number {
    if (!nativeActive()) return 0
    return this.app.stage.reducedMotion.peek() ? NATIVE : (this.options.leave ?? NATIVE)
  }

  // Reduced motion fades opacity, since custom effects may animate on u.presence.
  #fadeOut(copy: Copy, seconds: number, then: () => void): void {
    const prop = this.app.stage.reducedMotion.peek() ? 'opacity' : 'presence'
    this.fade(copy, prop, 0, seconds, then)
  }

  /** Takes pooled ghosts whose partners were just added. */
  #partners(added: readonly Element[]): Source[] {
    const found: Source[] = []
    if (!this.pool.size) return found
    for (const element of added.flatMap((node) => within(node, '[data-dio-key]'))) {
      const key = element.getAttribute('data-dio-key') as string
      const ghost = element.isConnected ? this.pool.take(key) : undefined
      const pose = ghost && poseOf(ghost)
      if (ghost && pose)
        found.push({ key, named: false, element: ghost.element, copy: ghost, pose })
      else ghost?.release()
    }
    return found
  }

  #mutated(records: MutationRecord[]): void {
    this.#noteNavigation()
    // Elements added, and whether any was removed. The stage canvas is not a page change.
    let removed = false
    const added: Element[] = []
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType === ELEMENT_NODE && !isStage(node)) removed = true
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === ELEMENT_NODE && !isStage(node)) added.push(node as Element)
      }
    }
    if (!removed && !added.length) return
    const active = this.current.peek()
    let late = this.#partners(added)
    const path = location.pathname
    if (active?.window) {
      // A window that is still swapping pairs them itself when it settles. An implicit transition
      // would supersede it before the page changed.
      if (!active.settled) {
        active.adopt(late)
        late = []
      }
      active.mutated(added)
    } else if (
      removed &&
      this.options.auto &&
      path !== pathOf(this.page.url) &&
      path !== this.#leftPath
    ) {
      // Auto mode turns the page when the old DOM goes, not on popstate, since routers change the
      // URL first. Skip the path an explicit transition just left (Astro pushes after its swap).
      this.rotate(location.href)
      this.app.emit('page:enter', { url: this.page.url })
    }
    active?.relink(added, removed)
    if (removed) {
      this.prune(0)
      this.#restore()
    }
    for (const source of late) new TransitionImpl(this, {}, true).fly([source])
  }

  #dispose(): void {
    this.#observer.disconnect()
    this.current.peek()?.destroy()
    this.pool.clear()
    this.prune(Number.POSITIVE_INFINITY)
    for (const fade of this.#fades) fade.copy.release()
    this.#fades.clear()
    for (const source of this.#batch.splice(0)) source.copy.release()
    this.#awake?.()
    this.page.close((error) => this.app.report(error, 'page'))
    this.attr(undefined)
  }
}

/**
 * While a view transition runs, Chromium hit-tests every click to <html>, whatever the
 * pseudo-elements' `pointer-events`, so a link clicked during a page change does nothing on its
 * own. Such a click ends the transition and goes to the element under the pointer.
 */
function passClick(event: MouseEvent): void {
  const root = document.documentElement
  const viewTransition = document.activeViewTransition
  if (!viewTransition || !event.isTrusted || event.target !== root) return
  event.stopImmediatePropagation()
  viewTransition.skipTransition()
  const under = document.elementFromPoint(event.clientX, event.clientY)
  // The same class, a PointerEvent in Chromium, with the same fields.
  const Click = event.constructor as typeof MouseEvent
  if (under && under !== root) under.dispatchEvent(new Click('click', event))
}

/** The canvas of a stage: the plugin's own DOM, never a page change. */
const isStage = (node: Node): boolean =>
  node.nodeName === 'CANVAS' && (node as Element).hasAttribute('data-dio-canvas')

// `leave` and `enter` stay unset. They resolve to 0, or 0.25 s inside a browser view transition.
const defaults: Settings = {
  leave: undefined,
  enter: undefined,
  duration: 0.8,
  ease: cubic,
  stagger: 0,
  crossfade: 0.25,
  wait: 2,
  auto: true,
  grace: 1,
  sources: 'hold',
}

const apiOf = (
  call: (swap: Swap, options?: TransitionOptions) => Transition,
  current: TransitionApi['current'],
  page: () => PageScope,
): TransitionApi =>
  Object.defineProperties(call as TransitionApi, {
    current: { value: current, enumerable: true },
    page: { get: page, enumerable: true },
  })

// No DOM (SSR): every call just swaps.
function inert(): TransitionApi {
  const page = new Page('')
  return apiOf(
    (swap) => skipped(swap),
    signal(undefined),
    () => page,
  )
}

/** Provides `app.transition`, page transitions that fly the GL copies of keyed elements. */
export const transitionPlugin: Plugin<'transition', TransitionsOptions, TransitionApi> =
  /*#__PURE__*/ definePlugin<
    'transition',
    TransitionsOptions,
    typeof defaults,
    TransitionApi,
    ['stage', 'anchors'],
    ['effects', 'assets']
  >({
    name: 'transition',
    dependencies: ['stage', 'anchors'],
    optionalDependencies: ['effects', 'assets'],
    defaults,
    setup(app, options): TransitionApi {
      return typeof document === 'undefined'
        ? inert()
        : new Director(app as unknown as View, options).api
    },
  })

/** Preset with the `transition` plugin, e.g. `presets: [effects(), transitions()]`. */
/*#__NO_SIDE_EFFECTS__*/
export function transitions(
  options: Partial<TransitionsOptions> = {},
): Preset<typeof transitionPlugin> {
  return definePreset({ name: 'transitions', plugins: [transitionPlugin(options)] })
}
