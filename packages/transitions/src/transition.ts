import { type AnchorsApi, type PluginApp, type Signal, type StageApi, signal } from '@diorama/core'
import type { Box, Copy, EffectsApi, ReleaseRequest } from '@diorama/effects'
import type { TransitionError } from './errors'
import {
  boxOf,
  clamp,
  FlightImpl,
  flightCrop,
  frameOf,
  here,
  hold,
  inView,
  lerp,
  lerpBox,
  noop,
  type Owner,
  type Pose,
  PresenceImpl,
  place,
  poseOf,
  push,
  radiusOf,
  rate,
  show,
  sized,
  smooth,
  travel,
} from './flight'
import type { Page } from './page'
import type { Pool } from './pool'
import type {
  FlightState,
  PresenceOptions,
  Swap,
  Transition,
  TransitionApi,
  TransitionOptions,
  TransitionPhase,
  TransitionResult,
  TransitionsOptions,
} from './types'

export type View = PluginApp<{
  readonly stage: StageApi
  readonly anchors: AnchorsApi
  readonly effects?: EffectsApi
  /** `@diorama/assets`, typed structurally. Low-priority work waits while a flight runs. */
  readonly assets?: { pause(reason?: string): () => void }
}>
/** `leave` and `enter` stay unset unless the site sets them (0.25 s in a view transition). */
export type Settings = Omit<TransitionsOptions, keyof PresenceOptions> & Partial<PresenceOptions>

/** A copy a transition starts from: taken in the snapshot, by the hook, or carried over. */
export interface Source {
  readonly key: string
  readonly named: boolean
  readonly element: Element
  readonly copy: Copy
  readonly pose: Pose
  /** Flight of a superseded transition and the seconds it has flown. */
  readonly flight?: FlightImpl
  readonly flown?: number
  /** Other copy of the pair still shown under it, with its weight. It fades out first. */
  readonly trail?: Copy
  readonly share?: number
}

export interface Host {
  readonly app: View
  readonly options: Settings
  /** Plugin scope signal. Copies live as long as it does. */
  readonly signal: AbortSignal
  readonly current: Signal<TransitionImpl | undefined>
  readonly pool: Pool
  readonly page: Page
  gen: number
  /** Ends the current transition and returns its visible copies. */
  supersede(): Source[]
  open(transition: TransitionImpl): void
  close(transition: TransitionImpl): void
  rotate(url: string): void
  /** Keeps a copy veiled until its element leaves, or until `partner` is removed or hidden. */
  remnant(copy: Copy, gen: number, partner?: Element): void
  reclaim(element: Element): Copy | undefined
  /** Releases remnants older than `gen`. */
  prune(gen: number): void
  fade(
    copy: Copy,
    prop: 'opacity' | 'presence',
    to: number,
    seconds: number,
    then: () => void,
  ): void
  /** Copy of a connected element that a superseded transition's fade still shows. */
  adopt(element: Element): Copy | undefined
  attr(phase: TransitionPhase | undefined): void
  warn(code: TransitionError['code'], message: string, once?: string): void
  report(code: TransitionError['code'], message: string, cause: unknown): void
}

// Seconds a copy fades in place when its target is lost, and under reduced motion.
const LEAVE = 0.15
const REDUCED = 0.2
/** Seconds of the browser's default root crossfade in a view transition. */
export const NATIVE = 0.25
// Entering copies: how long their DOM waits for one (ms), the earliest share of the flight they
// may start at, and the stagger between them.
const ENTER_WAIT = 500
const ENTER_AT = 0.2
const ENTER_STEP = 0.04
// Progress range where the target's copy takes over under the flying one. Early, so the rest of
// the flight already shows the target as it lands.
const MIX_FROM = 0.15
const MIX_TO = 0.5
// Minimum takeover length for a target that turns drawable late, even past the landing.
const MIX_MIN = 0.3
// Draw levels over the page. A flying copy goes over one that has faded in place, and the copy
// shown under either sits one level lower.
const GONE = 2
const TOP = 4
// A copy fading in place coasts on, slowing as (1 - k)^COAST until it stops at the end.
const COAST = 2
// Minimum share of `duration` for a flight that supersedes a moving one.
const SHORTEST = 0.3
// Decay of a carried velocity. It adds v * duration * p * (1 - p)^DAMP to the box.
const DAMP = 5
// A takeover this close to done at the landing just ends there, with no crossfade.
const TAKEN = 1e-3
const TIMEOUT = 10
// Frames with no writes after which an `animate` that never settles is ended.
const QUIET_FRAMES = 2
// Elements a view-transition-name may key. Matched in document order like any selector list.
const NAMEABLE = '[data-dio-key],[data-dio],img,video'
const NOT_NAMES = new Set(['', 'none', 'auto', 'match-element'])

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null)?.then === 'function'
export const sel = (key: string): string => `[data-dio-key="${CSS.escape(key)}"]`
/** The node itself if it matches, plus matching descendants. */
export const within = (node: Element, selector: string): Element[] => [
  ...(node.matches(selector) ? [node] : []),
  ...node.querySelectorAll(selector),
]
const nameOf = (el: Element): string | undefined => {
  const name = getComputedStyle(el).getPropertyValue('view-transition-name').trim()
  return NOT_NAMES.has(name) ? undefined : name
}
/** Inside a browser view transition. Browsers that don't know the selector throw on it. */
export const nativeActive = (): boolean => {
  try {
    return document.documentElement.matches(':active-view-transition')
  } catch {
    return false
  }
}
// Marked up or attached from code.
const effectElements = (fx: EffectsApi): Element[] => [
  ...document.querySelectorAll('[data-dio]'),
  ...fx.instances().map((i) => i.element),
]
const isViewTransition = (vt: unknown): vt is ViewTransition =>
  typeof ViewTransition === 'function' && vt instanceof ViewTransition
// 2 is DOCUMENT_POSITION_PRECEDING, i.e. `b` comes first.
const inDocumentOrder = (a: Element, b: Element): number =>
  a.compareDocumentPosition(b) & 2 ? 1 : -1
const moved = (a: Box, b: Box): boolean =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  ) > 1

/** One transition: snapshot, swap, pairing, flights, landing and cleanup. */
export class TransitionImpl implements Transition, Owner {
  readonly phase: Signal<TransitionPhase> = signal<TransitionPhase>('swapping')
  readonly auto: boolean
  readonly swapped: Promise<void>
  readonly finished: Promise<TransitionResult>
  readonly flights: FlightImpl[] = []
  readonly leaving: PresenceImpl[] = []
  readonly entering: PresenceImpl[] = []
  readonly gen: number
  readonly #host: Host
  readonly #options: TransitionOptions
  readonly #duration: number
  readonly #stagger: number
  readonly #crossfade: number
  readonly #wait: number
  #leave: number
  readonly #enter: number
  /** A browser view transition was active at the snapshot. Entering copies come with its root. */
  readonly #native: boolean
  /** `leave` is still the default, so a view transition that starts after the snapshot sets it. */
  #late: boolean
  readonly #timeout: number
  readonly #reduced: boolean
  #sources: Source[] = []
  /** Keyed (and nameable) elements before the swap. New nodes are preferred as targets. */
  #snapshot = new Set<Element>()
  /** Effect elements before the swap. Any others are entering. */
  #known: Set<Element> | undefined
  /** Targets the observer veiled as they arrived during an async swap, by key. */
  readonly #early = new Map<string, Copy>()
  #called = false
  #settled = false
  #rotated = false
  #ended = false
  #started = false
  /** Set by finish() or abort() before the swap settled. Ends once the page has changed. */
  #stopped: 'done' | 'aborted' | undefined
  #clock = 0
  #landings = 0
  /** Frames in a row with no writes while `animate` runs. */
  #quiet = 0
  #touched = false
  #animating = false
  #swapTimer: ReturnType<typeof setTimeout> | undefined
  #animateTimer: ReturnType<typeof setTimeout> | undefined
  /** Timers after which entering copies give way to their DOM. */
  readonly #waits = new Set<ReturnType<typeof setTimeout>>()
  #offAbort: () => void = noop
  #pause: () => void = noop
  #ok: () => void = noop
  #fail: (error: unknown) => void = noop
  #done: (result: TransitionResult) => void = noop

  constructor(host: Host, options: TransitionOptions, auto: boolean) {
    const settings = host.options
    this.#host = host
    this.#options = options
    this.auto = auto
    this.gen = ++host.gen
    this.#reduced = host.app.stage.reducedMotion.peek()
    this.#duration = options.duration ?? settings.duration
    this.#stagger = options.stagger ?? settings.stagger
    this.#crossfade = options.crossfade ?? settings.crossfade
    this.#wait = options.wait ?? settings.wait
    this.#timeout = options.timeout ?? TIMEOUT
    // Unpaired copies fade with the root crossfade of a browser view transition. null means none.
    // undefined or a look-alike falls back to the selector. Astro passes a look-alike when it only
    // simulates a transition (no API, or the browser's own back-swipe animation).
    const given = options.viewTransition
    const vt = given === null || isViewTransition(given) ? given : undefined
    this.#native = !auto && (vt === undefined ? nativeActive() : !!vt)
    const native = this.#native ? NATIVE : 0
    const leave = options.leave ?? settings.leave
    // Reduced motion skips the site's choreography and keeps only the root crossfade, on opacity.
    this.#leave = this.#reduced ? native : (leave ?? native)
    this.#enter = this.#reduced ? native : (options.enter ?? settings.enter ?? native)
    this.#late = !auto && !native && vt === undefined && (this.#reduced || leave === undefined)
    this.swapped = new Promise<void>((ok, fail) => {
      this.#ok = ok
      this.#fail = fail
    })
    this.swapped.catch(noop)
    this.finished = new Promise((done) => {
      this.#done = done
    })
  }

  // biome-ignore lint/suspicious/noThenProperty: a transition is thenable by design
  then<A = TransitionResult, B = never>(
    fulfilled?: ((result: TransitionResult) => A | PromiseLike<A>) | null,
    rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.finished.then(fulfilled, rejected)
  }

  /** An explicit transition between its snapshot and its end. */
  get window(): boolean {
    return !this.auto && !this.#ended
  }

  /** The swap has settled and pairs are made. */
  get settled(): boolean {
    return this.#settled
  }

  touch(): void {
    this.#touched = true
    this.#host.app.invalidate()
  }

  // Snapshot and swap

  run(swap: Swap): this {
    const host = this.#host
    const fx = host.app.effects
    const carried = host.supersede()
    host.pool.clear()
    const { signal } = this.#options
    // Already aborted: the swap still runs, nothing flies.
    if (fx?.status.peek() === 'ready' && !signal?.aborted) this.#collect(fx, carried)
    else for (const s of carried) this.#drop(s)
    host.open(this)
    this.#called = true
    let result: unknown
    try {
      result = swap()
    } catch (error) {
      this.#end('failed', error)
      this.#fail(error)
      throw error
    }
    if (isThenable(result)) {
      this.#swapTimer = setTimeout(() => {
        if (this.#settled || this.#ended) return
        host.warn('TRANSITION_TIMEOUT', `the swap did not settle in ${this.#timeout} s`)
        this.#end(this.#stopped ?? 'failed')
      }, this.#timeout * 1000)
      result.then(
        () => {
          this.#settle()
          this.#ok()
        },
        (error: unknown) => {
          if (!host.signal.aborted) host.report('TRANSITION_SWAP', 'the swap rejected', error)
          if (!this.#settled) this.#end('failed', error)
          this.#fail(error)
        },
      )
    } else {
      this.#settle()
      this.#ok()
    }
    if (signal && !this.#ended) {
      const abort = (): void => this.abort()
      if (signal.aborted) abort()
      else {
        signal.addEventListener('abort', abort, { once: true })
        this.#offAbort = () => signal.removeEventListener('abort', abort)
      }
    }
    return this
  }

  /** Implicit transition with no swap. Pairs ghosts already taken (auto mode, a late partner). */
  fly(items: readonly Source[]): this {
    const keys = new Set<string>()
    for (const s of [...this.#host.supersede(), ...items]) {
      if (keys.has(s.key)) this.#drop(s)
      else {
        keys.add(s.key)
        this.#sources.push(s)
      }
    }
    this.#host.open(this)
    this.#settle()
    this.#ok()
    return this
  }

  /** Takes drawn keyed copies in view before the swap, one per key. */
  #collect(fx: EffectsApi, carried: readonly Source[]): void {
    const host = this.#host
    const width = host.app.stage.width.peek()
    const height = host.app.stage.height.peek()
    const held = host.options.sources !== 'follow'
    const ids = new Set<string>()
    const skip = new Set<Element>()
    const id = (key: string, named: boolean): string => `${+named}${key}`
    for (const s of carried) {
      skip.add(s.element)
      if (ids.has(id(s.key, s.named))) this.#drop(s)
      else {
        ids.add(id(s.key, s.named))
        this.#sources.push(s)
      }
    }
    for (const element of document.querySelectorAll('[data-dio-state="drawn"]')) {
      if (skip.has(element)) continue
      const attr = element.getAttribute('data-dio-key')
      const key = attr ?? nameOf(element)
      if (key === undefined || ids.has(id(key, attr === null))) continue
      const copy = host.adopt(element) ?? fx.take(element, { signal: host.signal })
      const drawn = copy.drawn
      if (copy.state === 'released' || !drawn || !inView(drawn, width, height)) {
        copy.release()
        continue
      }
      ids.add(id(key, attr === null))
      if (held) hold(copy, drawn)
      this.#sources.push({ key, named: attr === null, element, copy, pose: drawn })
    }
    const named = this.#sources.some((s) => s.named)
    const keyed = named ? NAMEABLE : '[data-dio-key]'
    this.#snapshot = new Set(document.querySelectorAll(keyed))
    if (this.#enter > 0) this.#known = new Set(effectElements(fx))
  }

  #drop(s: Source): void {
    s.flight?.anchor?.dispose()
    s.copy.release()
    if (s.trail) this.#host.remnant(s.trail, this.gen)
  }

  /** Veiled copy of a target. Reuses one the plugin still holds if there is one. */
  #targetOf(fx: EffectsApi, el: Element): Copy {
    return (
      this.#host.reclaim(el) ??
      fx.take(el, { veil: true, leave: 'release', signal: this.#host.signal })
    )
  }

  /** After the swap: page scope, pairs, ghosts, entering copies, page:enter. */
  #settle(): void {
    if (this.#settled || this.#ended) return
    this.#settled = true
    clearTimeout(this.#swapTimer)
    const host = this.#host
    const fx = host.app.effects
    // Stopped or aborted during the swap: nothing pairs or enters.
    const stopped = this.#stopped ?? (this.#options.signal?.aborted ? 'aborted' : undefined)
    this.#rotate()
    if (!this.auto) host.attr('swapping')
    if (fx) {
      if (stopped) this.#release()
      else this.#pair(fx)
      // Scan now so removed sources become ghosts in this same reconcile.
      if (!this.auto) fx.scan()
      if (!stopped) this.#enterNew(fx)
    }
    if (!this.auto) host.app.emit('page:enter', { url: host.page.url })
    if (stopped) this.#stop(stopped)
    else if (this.flights.length + this.leaving.length + this.entering.length === 0)
      this.#end('done')
    else host.app.invalidate()
  }

  #rotate(): void {
    if (this.#rotated || this.auto) return
    this.#rotated = true
    const { url } = this.#options
    this.#host.rotate(url === undefined ? location.href : String(url))
  }

  // Pairs

  #pair(fx: EffectsApi): void {
    const sources = this.#sources
    this.#sources = []
    const pairs: [Source, Element][] = []
    const used = new Set<Element>()
    let names: Map<string, Element> | undefined
    for (const s of sources) {
      let to: Element | undefined
      if (s.named) {
        names ??= this.#names()
        to = names.get(s.key)
      } else {
        const all = [...document.querySelectorAll(sel(s.key))].filter((el) => !used.has(el))
        const fresh = all.filter((el) => !this.#snapshot.has(el))
        if (fresh.length > 1) {
          const message = `"${s.key}" is on ${fresh.length} new elements: the first one is the target`
          this.#host.warn('TRANSITION_KEY', message, s.key)
        }
        // The old page may still be in the DOM ahead of the new one (Barba sync, Vue without
        // mode). An old node hidden in place, like a closed modal, is not a target.
        to = fresh[0] ?? all.find((el) => el !== s.element && sized(el.getBoundingClientRect()))
      }
      if (!to && s.element.isConnected) to = s.element
      if (to) {
        used.add(to)
        pairs.push([s, to])
      } else this.#unpaired(s)
    }
    pairs.sort(([, a], [, b]) => inDocumentOrder(a, b))
    for (const [i, [s, to]] of pairs.entries()) this.#pairOf(fx, s, to, i)
    for (const copy of this.#early.values()) copy.release()
    this.#early.clear()
  }

  #names(): Map<string, Element> {
    const names = new Map<string, Element>()
    for (const el of document.querySelectorAll(NAMEABLE)) {
      const name = this.#snapshot.has(el) ? undefined : nameOf(el)
      if (name && !names.has(name)) names.set(name, el)
    }
    return names
  }

  // A keyed source waits invisibly for a late partner, a named one goes with its DOM. One carried
  // over mid-air has no DOM to go with, so it fades in place and then waits.
  #unpaired(s: Source): void {
    const host = this.#host
    if (s.flight) {
      s.flight.anchor?.dispose()
      const f = new FlightImpl(this, s, s.element, s.pose)
      f.trail = s.trail
      f.share = s.trail ? (s.share ?? 0) : 0
      f.toPool = !s.named
      f.kick = s.flight.speed
      f.clipKick = s.flight.clipSpeed
      this.flights.push(f)
      // Same pace as a full crossfade, starting from where its fade got to.
      this.#fadeOut(f, 'leaving', this.#crossfade * s.pose.opacity)
    } else if (s.named) s.copy.release()
    else if (this.#leave > 0) {
      const p = new PresenceImpl(this, s.element, s.copy, this.#reduced)
      p.key = s.key
      this.leaving.push(p)
    } else host.pool.add(s.key, s.copy)
  }

  #pairOf(fx: EffectsApi, s: Source, to: Element, i: number): void {
    const self = to === s.element
    const box = to.getBoundingClientRect()
    // A node paired with itself only flies if it moved (FLIP).
    if (self && (this.#reduced || !moved(s.pose, box))) {
      this.#drop(s)
      return
    }
    let target: Copy | undefined = self ? s.copy : undefined
    if (!self && !this.#reduced) {
      const early = this.#early.get(s.key)
      // The copy shown underneath is the target again (double click), so keep it taken.
      if (s.trail?.element === to && s.trail.state !== 'released') target = s.trail
      else if (early?.element === to) {
        target = early
        this.#early.delete(s.key)
      } else target = this.#targetOf(fx, to)
    }
    const trail = s.trail === target ? undefined : s.trail
    const old = s.flight
    if (old && target && old.copy === s.copy && old.to === to && old.target === target) {
      // Same pair as in the superseded transition: keep flying from where it was. A holding one
      // lands again in its first frame and waits anew.
      old.owner = this
      old.state = 'flying'
      old.startAt = -(s.flown ?? 0)
      this.flights.push(old)
      // The old owner has ended and its `ready` callback no longer fires, so subscribe again.
      this.#ready(old, target)
      return
    }
    old?.anchor?.dispose()
    // Start from where the copy is now: the snapshot when held, the last drawn frame when it
    // followed. A carried copy starts at the alpha its pair covered.
    const pose = old ? s.pose : (poseOf(s.copy) ?? s.pose)
    const f = new FlightImpl(this, s, to, pose)
    f.startAt = i * this.#stagger
    f.duration = this.#duration
    f.trail = trail
    f.share = trail ? (s.share ?? 0) : 0
    // The former trail is the target again, so its takeover resumes where it was.
    if (target && target === s.trail) f.share = f.shareFrom = s.share ?? 0
    if (old) {
      // Cut short mid-flight. Keep its speed and scale the duration by the distance left, with
      // sqrt because that is how time grows with distance at constant acceleration.
      f.speed = f.kick = old.speed
      f.clipSpeed = f.clipKick = old.clipSpeed
      f.lowered = old.lowered
      const whole = travel(old.pose, old.targetBox ?? old.pose)
      const way = sized(box) ? travel(pose, box) : whole
      if (whole > 1) f.duration *= Math.min(1, Math.max(SHORTEST, Math.sqrt(way / whole)))
    }
    this.flights.push(f)
    if (!target || target.state === 'released') {
      // Reduced motion, or a target this app can't hide because another app took it. The copy
      // fades in place and the target shows its DOM or enters like any other element.
      this.#fadeOut(f, 'leaving', this.#reduced ? REDUCED : this.#crossfade)
      return
    }
    this.#aim(f, to, target, box)
    if (!self) this.#ready(f, target)
  }

  /** Points the flight at `el` and its copy, tracked live and cut to its clipping ancestor. */
  #aim(f: FlightImpl, el: Element, target: Copy, box: Box): void {
    f.anchor?.dispose()
    f.to = el
    f.target = target
    f.anchor = this.#host.app.anchors.track(el, { live: true })
    f.frame = frameOf(el)
    f.radius = sized(box) ? radiusOf(el, box) : undefined
  }

  #ready(f: FlightImpl, target: Copy): void {
    void target.ready.then((ready) => {
      if (ready || f.target !== target || this.#ended) return
      f.failed = true
      this.#host.app.invalidate()
    })
  }

  // Entering and leaving

  // Veils new effect elements in view and fades them in once drawable. Under reduced motion
  // nothing flies, so targets enter like the rest.
  #enterNew(fx: EffectsApi, nodes?: readonly Element[]): void {
    const known = this.#known
    if (!(this.#enter > 0) || !known || fx.status.peek() !== 'ready') return
    const { width, height } = this.#host.app.stage
    const skip = new Set([
      ...known,
      ...(this.#reduced ? [] : this.flights.map((f) => f.to)),
      ...this.entering.map((p) => p.element),
      ...[...this.#early.values()].map((c) => c.element),
    ])
    const list = new Set(nodes ?? effectElements(fx))
    for (const el of [...list].sort(inDocumentOrder)) {
      if (skip.has(el) || !el.isConnected) continue
      if (!inView(el.getBoundingClientRect(), width.peek(), height.peek())) continue
      const copy = fx.take(el, { veil: true, leave: 'release', signal: this.#host.signal })
      if (copy.state === 'released') continue
      const p = new PresenceImpl(this, el, copy, this.#reduced)
      p.set(0)
      // Inside a browser view transition they all come at once with its root crossfade.
      p.at = this.#native ? 0 : ENTER_AT * this.#duration + ENTER_STEP * this.entering.length
      this.entering.push(p)
      // No copy coming (off, failed, no effects) or not in time. Show the DOM and let a late
      // copy replace it when ready.
      const give = (): void => {
        if (p.shown || p.done || copy.drawable) return
        p.done = true
        copy.release()
        this.#host.app.invalidate()
      }
      void copy.ready.then((ready) => ready || give())
      const wait = setTimeout(() => {
        this.#waits.delete(wait)
        give()
      }, ENTER_WAIT)
      this.#waits.add(wait)
    }
  }

  /** Release hook inside the window. Takes late keyed sources and copies that play `leave`. */
  released(request: ReleaseRequest, key: string | null): void {
    // Once stopped, everything was let go and nothing more is taken.
    if (!request.visible || this.#ended || this.#stopped) return
    const host = this.#host
    // The router started a view transition after the snapshot (Next). Its old root snapshot has
    // holes where these copies were, so they fade with it.
    if (this.#late && nativeActive()) {
      this.#late = false
      this.#leave = NATIVE
    }
    if (key !== null && !this.#settled) {
      if (this.#sources.some((s) => !s.named && s.key === key)) return
      const copy = request.take({ signal: host.signal })
      if (!copy) return
      if (host.options.sources !== 'follow') hold(copy, request.drawn)
      this.#sources.push({ key, named: false, element: request.element, copy, pose: request.drawn })
    } else if (this.#leave > 0) {
      const copy = request.take({ signal: host.signal })
      if (!copy) return
      hold(copy, request.drawn)
      this.leaving.push(new PresenceImpl(this, request.element, copy, this.#reduced))
    }
  }

  /** Ghosts from auto mode or the pool become sources while this window swaps, else released. */
  adopt(items: readonly Source[]): void {
    for (const s of items) {
      const taken = this.#sources.some((t) => !t.named && t.key === s.key)
      if (this.#settled || this.#stopped || taken) s.copy.release()
      else this.#sources.push(s)
    }
  }

  /** Observer callback during an async swap. Veils late targets as they arrive. */
  mutated(added: readonly Element[]): void {
    if (this.#settled || this.#ended || !this.#called) return
    this.#rotate()
    const fx = this.#host.app.effects
    if (!fx || !added.length || this.#stopped) return
    if (!this.#reduced) {
      const keys = new Set(this.#sources.filter((s) => !s.named).map((s) => s.key))
      for (const el of added.flatMap((node) => within(node, '[data-dio-key]'))) {
        const key = el.getAttribute('data-dio-key') as string
        if (!keys.has(key) || this.#early.has(key) || this.#snapshot.has(el)) continue
        const copy = this.#targetOf(fx, el)
        if (copy.state !== 'released') this.#early.set(key, copy)
      }
    }
    this.#enterNew(
      fx,
      added.flatMap((node) => within(node, '[data-dio]')),
    )
  }

  /** Moves flights whose target was removed to a node with the same key, now or within `grace`. */
  relink(added: readonly Element[], removed: boolean): void {
    for (const f of this.flights) {
      if (f.owner !== this || (f.state !== 'flying' && f.state !== 'holding')) continue
      if (removed && f.target && f.target !== f.copy && !f.to.isConnected) this.lose(f)
      if (!f.lost) continue
      const next = added.flatMap((node) => within(node, sel(f.key)))[0]
      if (next) this.#retarget(f, next)
    }
  }

  lose(f: FlightImpl): void {
    const to = f.target
    f.target = undefined
    f.mixAt = undefined
    f.shareFrom = 0
    // If it shows under the copy, it fades out there as a trail and becomes a ghost once its node
    // is gone. Otherwise release it so no veil stays on a node that left.
    if (to && to !== f.copy && f.share > 0 && !f.trail && to.state !== 'released') f.trail = to
    else to?.release()
    const next = [...document.querySelectorAll(sel(f.key))].find((el) => el !== f.from)
    if (next && this.#retarget(f, next)) return
    f.lost = true
    clearTimeout(f.timer)
    f.timer = setTimeout(() => {
      if (!f.lost || this.#ended || f.state === 'done') return
      this.#fadeOut(f, 'leaving', LEAVE)
      this.#host.app.invalidate()
    }, this.#host.options.grace * 1000)
  }

  #retarget(f: FlightImpl, el: Element): boolean {
    const fx = this.#host.app.effects
    if (!fx || this.#ended) return false
    const target = this.#targetOf(fx, el)
    if (target.state === 'released') return false
    clearTimeout(f.timer)
    const box = el.getBoundingClientRect()
    this.#aim(f, el, target, box)
    f.lost = f.failed = false
    // A holding flight lands again in its next frame and waits for the new copy.
    f.state = 'flying'
    // A node replaced in place (React re-render) changes nothing on screen, so the flight goes on.
    // Anywhere else, start a new flight from where the copy is.
    if (!f.targetBox || !sized(box) || moved(f.targetBox, box)) {
      this.#rebase(f)
      f.targetBox = undefined
      f.kick = f.speed
      f.clipKick = f.clipSpeed
    }
    this.#ready(f, target)
    this.#host.app.invalidate()
    return true
  }

  // Frames

  /** Steps the transition by `dt` seconds. Returns true while it wants more frames. */
  frame(dt: number): boolean {
    if (this.#ended || !this.#settled) return false
    if (this.#started) this.#clock += dt
    else {
      // Frame 0 draws every source where it was seen.
      this.#started = true
      this.phase.value = 'flying'
      if (!this.auto) this.#host.attr('flying')
      // Keep preloads from decoding during the flight.
      this.#pause = this.#host.app.assets?.pause('transition') ?? noop
      this.#animate()
      if (this.#ended) return false
    }
    const touched = this.#touched
    this.#touched = false
    let busy = false
    for (const f of this.flights) if (f.owner === this) busy = this.#step(f, dt) || busy
    for (const p of this.leaving) busy = this.#leaveStep(p) || busy
    for (const p of this.entering) busy = this.#enterStep(p) || busy
    if (this.#animating) {
      // A killed timeline never settles. End once everything has landed and nothing was written
      // for QUIET_FRAMES frames.
      this.#quiet = busy || touched ? 0 : this.#quiet + 1
      if (this.#quiet < QUIET_FRAMES) return true
      this.#host.warn('TRANSITION_ANIMATE', 'animate never settled: ended after its last write')
      this.finish()
      return false
    }
    if (!busy) this.#end('done')
    return busy
  }

  #animate(): void {
    const { animate } = this.#options
    if (!animate) return
    this.#animating = true
    const fail = (error: unknown): void => {
      if (this.#ended) return
      this.#host.report('TRANSITION_ANIMATE', 'animate failed', error)
      this.finish()
    }
    this.#animateTimer = setTimeout(() => {
      this.#host.warn('TRANSITION_ANIMATE', `animate did not settle in ${this.#timeout} s`)
      this.finish()
    }, this.#timeout * 1000)
    try {
      Promise.resolve(animate(this)).then(() => this.#played(), fail)
    } catch (error) {
      fail(error)
    }
  }

  // Flights left in the air land now. Landings already under way (crossfade, hold) play out on
  // the built-in clock instead of being cut.
  #played(): void {
    if (this.#ended) return
    clearTimeout(this.#animateTimer)
    this.#animating = false
    for (const f of this.flights) if (f.owner === this && f.state === 'flying') f.advance(1)
    this.#unpair()
    this.#host.app.invalidate()
  }

  /** Live box of the target once it has a size. An image without width/height may not yet. */
  #live(f: FlightImpl): Box | undefined {
    const a = f.anchor
    if (a && !f.lost && sized(a)) f.targetBox = boxOf(a)
    return f.targetBox
  }

  /** Live box of the target's clipping ancestor, or the target box if it has none. */
  #cut(f: FlightImpl, live: Box): Box {
    const frame = f.frame?.isConnected ? f.frame.getBoundingClientRect() : undefined
    return frame ? { x: frame.left, y: frame.top, width: frame.width, height: frame.height } : live
  }

  #step(f: FlightImpl, dt: number): boolean {
    const c = f.copy
    if (f.state === 'done') return false
    // The runtime stopped (render, device loss, remove('effects')) and released the copies.
    if (c.state === 'released') {
      f.target?.release()
      this.#rest(f)
      return false
    }
    // Stay over the page even when fading in place, or under reduced motion the new page's copies
    // would cut through it. Fresh flights go above copies that faded in place, so a clicked
    // picture flies over the pair it superseded rather than through it.
    c.above = f.lowered ? GONE : TOP
    if (f.state === 'crossfading' || f.state === 'leaving') return this.#fadeStep(f, dt)
    if (f.target && f.target !== c && !f.to.isConnected) this.lose(f)
    const first = !f.targetBox
    const live = this.#live(f)
    // Target lost. The copy stays put with its clock paused until a partner comes or `grace`
    // runs out.
    if (f.lost) {
      f.startAt += dt
      f.speed = f.clipSpeed = undefined
      return true
    }
    if (live && first) f.radius ??= radiusOf(f.to, live)
    const to = live ?? f.pose
    // Land at the target's CSS opacity. A FLIP keeps its own.
    const alpha = (f.target?.cssOpacity ?? 1) * f.opacity
    if (f.state === 'holding' && live && first) {
      // Got its size only after the whole flight. Restart from where the copy waited.
      clearTimeout(f.timer)
      f.state = 'flying'
      this.#rebase(f)
      return true
    }
    // The clip goes from the source's to the target's. A missing clip means the box itself.
    const cut = live ? this.#cut(f, live) : (f.pose.clip ?? f.pose)
    if (f.state === 'holding') {
      c.box = to
      c.crop = flightCrop(f, to, to, 1)
      c.clip = cut
      c.radius = f.radius ?? f.pose.radius
      f.speed = f.clipSpeed = undefined
      this.#blend(f, undefined, alpha, dt)
      this.#land(f)
    } else this.#flyStep(f, dt, to, !!live && first, cut, alpha)
    return (f.state as FlightState) !== 'done'
  }

  // `to` is the target's live box or the source pose. `late` means it got its size this frame.
  #flyStep(f: FlightImpl, dt: number, to: Box, late: boolean, cut: Box, alpha: number): void {
    const c = f.copy
    const animated = !!this.#options.animate
    let progress = clamp(f.progress)
    let eased = progress
    if (!animated) {
      const t = this.#clock - f.startAt
      // `duration: 0` lands at the start. 0 / 0 would draw nothing for a frame.
      progress = f.duration > 0 ? clamp(t / f.duration) : +(t >= 0)
      f.advance(progress)
      eased = (this.#options.ease ?? this.#host.options.ease)(progress)
    }
    // Sized late. Continue from where the copy is so it doesn't jump.
    if (late && eased > 0) {
      f.pose = here(f)
      f.poseAt = eased
    }
    const k = f.poseAt === 0 ? eased : f.poseAt < 1 ? (eased - f.poseAt) / (1 - f.poseAt) : 1
    let box = lerpBox(f.pose, to, k)
    let clip = lerpBox(f.pose.clip ?? f.pose, cut, k)
    // A carried velocity keeps the copy moving and dies out, so there is no dead stop.
    const kick = f.kick && !animated ? f.duration * progress * (1 - progress) ** DAMP : 0
    if (kick > 0 && f.kick) {
      box = push(box, f.kick, kick)
      clip = push(clip, f.clipKick ?? f.kick, kick)
    }
    if (dt > 0 && progress > 0 && c.box) f.speed = rate(c.box, box, dt)
    if (dt > 0 && progress > 0 && c.clip) f.clipSpeed = rate(c.clip, clip, dt)
    c.box = box
    c.crop = flightCrop(f, to, box, k)
    c.clip = clip
    c.radius = lerp(f.pose.radius, f.radius ?? f.pose.radius, k)
    this.#blend(f, progress, lerp(f.pose.opacity, alpha, k), dt)
    if (progress >= 1) this.#land(f)
  }

  /** Finishes the takeover at the target, or fades out together with what is under it. */
  #fadeStep(f: FlightImpl, dt: number): boolean {
    const c = f.copy
    f.fadeTime += dt
    const k = f.fadeSpan > 0 ? clamp(f.fadeTime / f.fadeSpan) : 1
    const live = f.state === 'crossfading' ? this.#live(f) : undefined
    if (live) {
      place(c, live)
      c.clip = this.#cut(f, live)
    } else if (f.kick && !this.#reduced) {
      // Distance covered at speed v * (1 - k)^COAST, with v carried in from a superseded flight.
      const way = (f.fadeSpan * (1 - (1 - k) ** (COAST + 1))) / (COAST + 1)
      const box = push(f.pose, f.kick, way)
      const clip = push(f.pose.clip ?? f.pose, f.clipKick ?? f.kick, way)
      if (dt > 0 && c.box) f.speed = rate(c.box, box, dt)
      if (dt > 0 && c.clip) f.clipSpeed = rate(c.clip, clip, dt)
      place(c, box)
      c.clip = clip
    }
    const to = f.target
    if (f.state === 'crossfading' && to && to !== c) {
      f.share = lerp(f.landedShare, 1, k)
      f.cover = lerp(f.fadeFrom, to.cssOpacity, k)
      show(f, to)
    } else {
      // Whatever shows underneath fades out with it in the same mix.
      if (f.trail?.state === 'released') this.#untrail(f)
      f.cover = f.fadeFrom * (1 - k)
      show(f, f.trail)
    }
    if (k < 1) return true
    this.#rest(f)
    return false
  }

  #rebase(f: FlightImpl): void {
    f.pose = here(f)
    f.poseAt = 0
    f.startAt = this.#clock
    f.advance(0)
  }

  // Picks what shows under the flying copy. A former target fades out first, then the target takes
  // over once drawable. With `progress` undefined (holding) the takeover waits for the landing.
  #blend(f: FlightImpl, progress: number | undefined, cover: number, dt: number): void {
    const to = f.target !== f.copy ? f.target : undefined
    let under: Copy | undefined
    f.cover = cover
    if (f.trail) {
      f.share = this.#crossfade > 0 ? f.share - dt / this.#crossfade : 0
      if (f.share > 0 && f.trail.state !== 'released') under = f.trail
      else this.#untrail(f)
    } else if (progress !== undefined && to?.drawable && !f.failed) {
      f.mixAt ??= Math.max(progress, MIX_FROM)
      const mixTo = Math.max(MIX_TO, f.mixAt + MIX_MIN)
      const next = lerp(f.shareFrom, 1, smooth(f.mixAt, mixTo, progress))
      // Cap at twice the crossfade rate so a progress jump (a stall, a timeline setting 1) doesn't
      // swap the picture in one frame. Whatever is left plays after the landing.
      const most = this.#crossfade > 0 ? f.share + (2 * dt) / this.#crossfade : 1
      f.share = Math.min(next, most)
      if (f.share > 0) under = to
    } else {
      f.share = f.shareFrom = 0
      f.mixAt = undefined
    }
    if (to && to !== under) {
      to.veil = true
      to.leave = 'release'
    }
    show(f, under)
  }

  #untrail(f: FlightImpl): void {
    const trail = f.trail
    f.trail = undefined
    f.share = 0
    if (trail) this.#host.remnant(trail, this.gen)
  }

  // A takeover finished in flight releases both copies with no visible change. An unfinished one
  // plays out as a crossfade in place. A target that isn't ready yet holds the copy there.
  #land(f: FlightImpl): void {
    const c = f.copy
    const to = f.target
    if (!to || to === c) {
      this.#landings++
      this.#rest(f)
      return
    }
    // A former target still fading out under the copy goes first.
    if (f.trail) this.#hold(f)
    else if (to.drawable || f.failed) {
      this.#landings++
      if (!to.drawable) {
        to.release()
        f.target = undefined
        f.share = 0
      }
      const left = f.target ? Math.max(1 - f.share, Math.abs(to.cssOpacity - f.cover)) : 1
      if (left < TAKEN) {
        this.#rest(f)
        return
      }
      this.#fadeOut(f, 'crossfading', this.#crossfade * left)
      f.landedShare = f.share
      if (f.target) show(f, to)
    } else this.#hold(f)
  }

  #hold(f: FlightImpl): void {
    if (f.state === 'holding') return
    f.state = 'holding'
    f.timer = setTimeout(() => {
      if (f.state !== 'holding' || this.#ended) return
      f.failed = true
      this.#host.app.invalidate()
    }, this.#wait * 1000)
  }

  #fadeOut(f: FlightImpl, state: 'crossfading' | 'leaving', span: number): void {
    clearTimeout(f.timer)
    f.state = state
    if (state === 'leaving') f.lowered = true
    f.fadeTime = 0
    f.fadeSpan = span
    f.fadeFrom = f.cover
  }

  /** Stops steps and timers. The anchor is kept only if the flight is carried over. */
  #halt(f: FlightImpl, carried = false): void {
    f.state = 'done'
    clearTimeout(f.timer)
    if (carried) return
    f.anchor?.dispose()
    f.anchor = undefined
  }

  // The flying copy is released, or kept hidden as a remnant while its element is still in the
  // document. The target's copy goes back to following its DOM.
  #rest(f: FlightImpl): void {
    this.#halt(f)
    this.#untrail(f)
    const to = f.target
    if (to && to !== f.copy) {
      to.veil = false
      to.release()
      f.target = undefined
    }
    if (to !== f.copy && f.copy.state !== 'ghost' && f.from.isConnected) {
      this.#host.remnant(f.copy, this.gen, f.to)
    } else if (f.toPool) this.#host.pool.add(f.key, f.copy)
    else f.copy.release()
  }

  #leaveStep(p: PresenceImpl): boolean {
    if (p.copy.state === 'released') p.done = true
    if (p.done) return false
    if (this.#options.animate) return p.presence > 0
    const presence = this.#leave > 0 ? clamp(1 - this.#clock / this.#leave) : 0
    p.set(presence)
    if (presence > 0) return true
    this.#quit(p)
    return false
  }

  #quit(p: PresenceImpl): void {
    p.done = true
    if (p.key !== undefined) this.#host.pool.add(p.key, p.copy)
    else p.copy.release()
  }

  #enterStep(p: PresenceImpl): boolean {
    const c = p.copy
    if (c.state === 'released') p.done = true
    if (p.done) return false
    if (!p.shown) {
      if (c.drawable && (this.#options.animate || this.#clock >= p.at)) {
        c.veil = false
        p.shown = true
        p.at = this.#clock
      }
      return true
    }
    if (this.#options.animate) return p.presence < 1
    const presence = this.#enter > 0 ? clamp((this.#clock - p.at) / this.#enter) : 1
    p.set(presence)
    if (presence < 1) return true
    p.done = true
    c.release()
    return false
  }

  // Endings

  finish(): void {
    this.#stop('done')
  }

  abort(): void {
    this.#stop('aborted')
  }

  /** Tab hidden. No frames will come, and a half-done flight on return looks worse than landing. */
  hidden(): void {
    if (this.#settled) this.finish()
  }

  /** On app destroy. Drops everything now, without reports. */
  destroy(): void {
    this.#end('aborted')
  }

  #stop(status: 'done' | 'aborted'): void {
    if (this.#ended) return
    if (!this.#settled) {
      // The swap is still running. Let go now and end once the page has changed.
      this.#release()
      this.#stopped = status
      return
    }
    for (const f of this.flights) {
      if (f.owner !== this || f.state === 'done') continue
      if ((f.state === 'flying' || f.state === 'holding') && !f.lost) this.#landings++
      this.#rest(f)
    }
    this.#unpair()
    this.#end(status)
  }

  /** Leaving copies go or wait in the pool, entering ones show. */
  #unpair(): void {
    for (const p of this.leaving) if (!p.done) this.#quit(p)
    for (const p of this.entering) {
      if (p.done) continue
      p.done = true
      p.copy.veil = false
      p.copy.release()
    }
  }

  /** Lets go of every copy still held. Connected ones live on as before, ghosts go. */
  #release(): void {
    for (const s of this.#sources) this.#drop(s)
    this.#sources = []
    for (const copy of this.#early.values()) copy.release()
    this.#early.clear()
    for (const f of this.flights) {
      if (f.owner !== this || f.state === 'done') continue
      this.#halt(f)
      f.target?.release()
      f.copy.release()
      this.#untrail(f)
    }
    for (const p of [...this.leaving, ...this.entering]) {
      if (p.done) continue
      p.done = true
      p.copy.release()
    }
  }

  /** Superseded. Visible copies go to the next transition and fades keep playing. */
  handOver(): Source[] {
    const host = this.#host
    const carried = this.#sources
    this.#sources = []
    if (this.#ended) return carried
    for (const copy of this.#early.values()) host.remnant(copy, this.gen)
    this.#early.clear()
    for (const f of this.flights) {
      if (f.owner !== this || f.state === 'done') continue
      const source = this.#carry(f)
      if (source) carried.push(source)
    }
    const rest = (p: PresenceImpl, to: number, span: number, then: () => void): void => {
      p.done = true
      host.fade(p.copy, p.prop, p.scale * to, span * Math.abs(to - p.presence), then)
    }
    for (const p of this.leaving) {
      if (!p.done) rest(p, 0, this.#leave || LEAVE, () => this.#quit(p))
    }
    for (const p of this.entering) {
      if (p.done) continue
      if (p.shown) rest(p, 1, this.#enter || LEAVE, () => p.copy.release())
      else {
        p.done = true
        host.remnant(p.copy, this.gen)
      }
    }
    this.#end('superseded')
    return carried
  }

  /**
   * Turns a superseded flight into a source for the next transition. If a target shows under it,
   * whichever of the two shows more flies on and the other trails, so the picture doesn't change.
   */
  #carry(f: FlightImpl): Source | undefined {
    const c = f.copy
    if (f.state === 'leaving' && c.state !== 'ghost' && f.from.isConnected) {
      // Source still in the document (Barba sync). Make it a remnant the next transition may fly
      // back to. If it kept fading it would stay taken past that transition.
      this.#halt(f)
      this.#host.remnant(c, this.gen)
      this.#untrail(f)
      return undefined
    }
    const to = f.target !== c ? f.target : undefined
    let copy = c
    let element = f.from
    let trail = f.trail
    let share = trail ? f.share : 0
    if (to && !trail && f.share > 0 && to.state !== 'released') {
      to.leave = 'ghost'
      if (f.share < 0.5) {
        trail = to
        share = f.share
      } else {
        copy = to
        element = f.to
        trail = c
        share = 1 - f.share
      }
    } else if (to) {
      if (f.to.isConnected) this.#host.remnant(to, this.gen)
      else to.release()
    }
    const pose = poseOf(copy)
    if (pose && copy.state !== 'released') {
      // Keep the anchor. The next transition either flies it on or disposes of it.
      this.#halt(f, true)
      return {
        key: f.key,
        named: f.named,
        element,
        copy,
        pose: { ...pose, opacity: f.cover },
        flight: f,
        flown: this.#clock - f.startAt,
        trail,
        share,
      }
    }
    this.#halt(f)
    copy.release()
    if (trail) this.#host.remnant(trail, this.gen)
    return undefined
  }

  #end(status: TransitionResult['status'], error?: unknown): void {
    if (this.#ended) return
    this.#ended = true
    clearTimeout(this.#swapTimer)
    clearTimeout(this.#animateTimer)
    this.#offAbort()
    this.#pause()
    const host = this.#host
    if (status !== 'superseded') {
      // A superseded transition hands its entering copies on together with their waits.
      for (const wait of this.#waits) clearTimeout(wait)
      this.#waits.clear()
      this.#release()
      host.prune(this.gen)
    }
    this.phase.value = 'done'
    host.close(this)
    const flights = this.#landings
    const result: TransitionResult =
      error === undefined ? { status, flights } : { status, flights, error }
    host.app.emit('transition:end', { transition: this, result })
    this.#done(result)
  }
}

/** Runs only the swap. Used with no app or plugin, after destroy, and in SSR. */
export function skipped(swap: Swap): Transition {
  const result = swap()
  const swapped = isThenable(result) ? Promise.resolve(result).then(noop) : Promise.resolve()
  swapped.catch(noop)
  const finished = Promise.resolve<TransitionResult>({ status: 'skipped', flights: 0 })
  return {
    phase: signal<TransitionPhase>('done'),
    auto: false,
    swapped,
    finished,
    flights: [],
    leaving: [],
    entering: [],
    finish: noop,
    abort: noop,
    // biome-ignore lint/suspicious/noThenProperty: a transition is thenable by design
    then: (fulfilled, rejected) => finished.then(fulfilled, rejected),
  }
}

/**
 * Calls `app.transition` if the plugin is running, otherwise runs `swap` once and returns a
 * settled 'skipped' transition. Safe for routers that navigate before `app.start()` resolves.
 */
export function transition(
  app: { readonly transition?: TransitionApi | undefined },
  swap: Swap,
  options?: TransitionOptions,
): Transition {
  const api = app.transition
  return typeof api === 'function' ? api(swap, options) : skipped(swap)
}
