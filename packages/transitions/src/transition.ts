// One page transition from start to end. Before the swap it takes the drawn copies of keyed
// elements. After the swap it pairs each with its new element and flies it there, fades unpaired
// copies out and new effect elements in, then lands every flight and lets the copies go.
import {
  type AnchorsApi,
  type PluginApp,
  type Signal,
  type StageApi,
  signal,
} from '@dioramajs/core'
import type { Box, Copy, EffectsApi, ReleaseRequest } from '@dioramajs/effects'
import {
  effectElements,
  inDocumentOrder,
  isViewTransition,
  keySelector,
  NAMEABLE,
  NATIVE,
  nativeActive,
  viewTransitionName,
  within,
} from './dom'
import type { TransitionError } from './errors'
import { FlightImpl, flightCrop, here, type Owner, PresenceImpl, show } from './flight'
import {
  boxOf,
  clamp,
  frameOf,
  hold,
  inView,
  lerp,
  lerpBox,
  moved,
  noop,
  type Pose,
  place,
  poseOf,
  push,
  radiusOf,
  rate,
  sized,
  smooth,
  travel,
} from './geometry'
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
  /** `@dioramajs/assets`, typed structurally. Low-priority work waits while a flight runs. */
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

/** What a transition needs from the plugin that runs it. */
export interface Host {
  readonly app: View
  readonly options: Settings
  /** Plugin scope signal. Copies live as long as it does. */
  readonly signal: AbortSignal
  readonly current: Signal<TransitionImpl | undefined>
  readonly pool: Pool
  readonly page: Page
  /** Number of the latest transition. Remnants remember the one that made them. */
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

/** Seconds a copy fades in place when its target is lost. */
const LEAVE = 0.15
/** Seconds a copy fades in place under reduced motion. */
const REDUCED = 0.2
/** Milliseconds an entering element's DOM waits for its copy before it shows instead. */
const ENTER_WAIT = 500
/** Earliest share of the flight duration entering copies may start at. */
const ENTER_AT = 0.2
/** Seconds between one entering copy and the next. */
const ENTER_STEP = 0.04
// Progress range where the target's copy takes over under the flying one. Early, so the rest of
// the flight already shows the target as it lands.
const MIX_FROM = 0.15
const MIX_TO = 0.5
/** Minimum takeover length for a target that turns drawable late, even past the landing. */
const MIX_MIN = 0.3
// Draw levels over the page. A flying copy goes over one that has faded in place, and the copy
// shown under either sits one level lower.
const GONE = 2
const TOP = 4
/** A copy fading in place coasts on, slowing as (1 - t)^COAST until it stops at the end. */
const COAST = 2
/** Minimum share of `duration` for a flight that supersedes a moving one. */
const SHORTEST = 0.3
/** Decay of a carried velocity. It adds v * duration * p * (1 - p)^DAMP to the box. */
const DAMP = 5
/** A takeover this close to done at the landing just ends there, with no crossfade. */
const TAKEN = 1e-3
/** Default seconds the swap, and `animate`, may take before the transition ends anyway. */
const TIMEOUT = 10
/** Frames with no writes after which an `animate` that never settles is ended. */
const QUIET_FRAMES = 2

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null)?.then === 'function'

/** Keyed and named sources may share a key, so the two kinds are told apart. */
const sourceId = (key: string, named: boolean): string => `${+named}${key}`

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
  /** The swap has been called. */
  #called = false
  #settled = false
  #rotated = false
  #ended = false
  /** Frame 0 has run. */
  #started = false
  /** Set by finish() or abort() before the swap settled. Ends once the page has changed. */
  #stopped: 'done' | 'aborted' | undefined
  /** Seconds since frame 0. */
  #clock = 0
  #landings = 0
  /** Frames in a row with no writes while `animate` runs. */
  #quiet = 0
  /** The site wrote to a flight or presence since the last frame. */
  #touched = false
  #animating = false
  #swapTimer: ReturnType<typeof setTimeout> | undefined
  #animateTimer: ReturnType<typeof setTimeout> | undefined
  /** Timers after which entering copies give way to their DOM. */
  readonly #waits = new Set<ReturnType<typeof setTimeout>>()
  #removeAbortListener: () => void = noop
  #resumeAssets: () => void = noop
  #resolveSwapped: () => void = noop
  #rejectSwapped: (error: unknown) => void = noop
  #resolveFinished: (result: TransitionResult) => void = noop

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
    const viewTransition = given === null || isViewTransition(given) ? given : undefined
    this.#native = !auto && (viewTransition === undefined ? nativeActive() : !!viewTransition)
    const rootFade = this.#native ? NATIVE : 0
    const leave = options.leave ?? settings.leave
    // Reduced motion skips the site's choreography and keeps only the root crossfade, on opacity.
    this.#leave = this.#reduced ? rootFade : (leave ?? rootFade)
    this.#enter = this.#reduced ? rootFade : (options.enter ?? settings.enter ?? rootFade)
    this.#late =
      !auto && !rootFade && viewTransition === undefined && (this.#reduced || leave === undefined)
    this.swapped = new Promise<void>((resolve, reject) => {
      this.#resolveSwapped = resolve
      this.#rejectSwapped = reject
    })
    this.swapped.catch(noop)
    this.finished = new Promise((resolve) => {
      this.#resolveFinished = resolve
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
    const effects = host.app.effects
    const carried = host.supersede()
    host.pool.clear()
    const { signal } = this.#options
    // Already aborted: the swap still runs, nothing flies.
    if (effects?.status.peek() === 'ready' && !signal?.aborted) this.#collect(effects, carried)
    else for (const source of carried) this.#drop(source)
    host.open(this)
    this.#called = true
    let result: unknown
    try {
      result = swap()
    } catch (error) {
      this.#end('failed', error)
      this.#rejectSwapped(error)
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
          this.#resolveSwapped()
        },
        (error: unknown) => {
          if (!host.signal.aborted) host.report('TRANSITION_SWAP', 'the swap rejected', error)
          if (!this.#settled) this.#end('failed', error)
          this.#rejectSwapped(error)
        },
      )
    } else {
      this.#settle()
      this.#resolveSwapped()
    }
    if (signal && !this.#ended) {
      const abort = (): void => this.abort()
      if (signal.aborted) abort()
      else {
        signal.addEventListener('abort', abort, { once: true })
        this.#removeAbortListener = () => signal.removeEventListener('abort', abort)
      }
    }
    return this
  }

  /** Implicit transition with no swap. Pairs ghosts already taken (auto mode, a late partner). */
  fly(items: readonly Source[]): this {
    const keys = new Set<string>()
    for (const source of [...this.#host.supersede(), ...items]) {
      if (keys.has(source.key)) this.#drop(source)
      else {
        keys.add(source.key)
        this.#sources.push(source)
      }
    }
    this.#host.open(this)
    this.#settle()
    this.#resolveSwapped()
    return this
  }

  /** Takes drawn keyed copies in view before the swap, one per key. Carried sources come first. */
  #collect(effects: EffectsApi, carried: readonly Source[]): void {
    const host = this.#host
    const width = host.app.stage.width.peek()
    const height = host.app.stage.height.peek()
    const held = host.options.sources !== 'follow'
    const ids = new Set<string>()
    const skip = new Set<Element>()
    for (const source of carried) {
      skip.add(source.element)
      const id = sourceId(source.key, source.named)
      if (ids.has(id)) this.#drop(source)
      else {
        ids.add(id)
        this.#sources.push(source)
      }
    }
    for (const element of document.querySelectorAll('[data-dio-state="drawn"]')) {
      if (skip.has(element)) continue
      const keyAttribute = element.getAttribute('data-dio-key')
      const named = keyAttribute === null
      const key = keyAttribute ?? viewTransitionName(element)
      if (key === undefined || ids.has(sourceId(key, named))) continue
      const copy = host.adopt(element) ?? effects.take(element, { signal: host.signal })
      const drawn = copy.drawn
      if (copy.state === 'released' || !drawn || !inView(drawn, width, height)) {
        copy.release()
        continue
      }
      ids.add(sourceId(key, named))
      if (held) hold(copy, drawn)
      this.#sources.push({ key, named, element, copy, pose: drawn })
    }
    const named = this.#sources.some((source) => source.named)
    this.#snapshot = new Set(document.querySelectorAll(named ? NAMEABLE : '[data-dio-key]'))
    if (this.#enter > 0) this.#known = new Set(effectElements(effects))
  }

  #drop(source: Source): void {
    source.flight?.anchor?.dispose()
    source.copy.release()
    if (source.trail) this.#host.remnant(source.trail, this.gen)
  }

  /** Veiled copy of a target. Reuses one the plugin still holds if there is one. */
  #targetOf(effects: EffectsApi, element: Element): Copy {
    return (
      this.#host.reclaim(element) ??
      effects.take(element, { veil: true, leave: 'release', signal: this.#host.signal })
    )
  }

  /** After the swap: page scope, pairs, ghosts, entering copies, page:enter. */
  #settle(): void {
    if (this.#settled || this.#ended) return
    this.#settled = true
    clearTimeout(this.#swapTimer)
    const host = this.#host
    const effects = host.app.effects
    // Stopped or aborted during the swap: nothing pairs or enters.
    const stopped = this.#stopped ?? (this.#options.signal?.aborted ? 'aborted' : undefined)
    this.#rotate()
    if (!this.auto) host.attr('swapping')
    if (effects) {
      if (stopped) this.#release()
      else this.#pair(effects)
      // Scan now so removed sources become ghosts in this same reconcile.
      if (!this.auto) effects.scan()
      if (!stopped) this.#enterNew(effects)
    }
    if (!this.auto) host.app.emit('page:enter', { url: host.page.url })
    if (stopped) this.#stop(stopped)
    else if (this.flights.length + this.leaving.length + this.entering.length === 0)
      this.#end('done')
    else host.app.invalidate()
  }

  /** Closes the old page scope and opens the new one, once. */
  #rotate(): void {
    if (this.#rotated || this.auto) return
    this.#rotated = true
    const { url } = this.#options
    this.#host.rotate(url === undefined ? location.href : String(url))
  }

  // Pairs

  #pair(effects: EffectsApi): void {
    const sources = this.#sources
    this.#sources = []
    const pairs: [Source, Element][] = []
    const used = new Set<Element>()
    let names: Map<string, Element> | undefined
    for (const source of sources) {
      let to: Element | undefined
      if (source.named) {
        names ??= this.#newNames()
        to = names.get(source.key)
      } else {
        const all = [...document.querySelectorAll(keySelector(source.key))].filter(
          (element) => !used.has(element),
        )
        // New nodes win over ones from before the swap.
        const fresh = all.filter((element) => !this.#snapshot.has(element))
        if (fresh.length > 1) {
          const message = `"${source.key}" is on ${fresh.length} new elements: the first one is the target`
          this.#host.warn('TRANSITION_KEY', message, source.key)
        }
        // The old page may still be in the DOM ahead of the new one (Barba sync, Vue without
        // mode). An old node hidden in place, like a closed modal, is not a target.
        to =
          fresh[0] ??
          all.find(
            (element) => element !== source.element && sized(element.getBoundingClientRect()),
          )
      }
      if (!to && source.element.isConnected) to = source.element
      if (to) {
        used.add(to)
        pairs.push([source, to])
      } else this.#unpaired(source)
    }
    pairs.sort(([, a], [, b]) => inDocumentOrder(a, b))
    for (const [index, [source, to]] of pairs.entries()) this.#flyPair(effects, source, to, index)
    for (const copy of this.#early.values()) copy.release()
    this.#early.clear()
  }

  /** view-transition-names of nodes that arrived with the swap, first element per name. */
  #newNames(): Map<string, Element> {
    const names = new Map<string, Element>()
    for (const element of document.querySelectorAll(NAMEABLE)) {
      const name = this.#snapshot.has(element) ? undefined : viewTransitionName(element)
      if (name && !names.has(name)) names.set(name, element)
    }
    return names
  }

  // A keyed source waits invisibly for a late partner, a named one goes with its DOM. One carried
  // over mid-air has no DOM to go with, so it fades in place and then waits.
  #unpaired(source: Source): void {
    if (source.flight) {
      source.flight.anchor?.dispose()
      const flight = new FlightImpl(this, source, source.element, source.pose)
      flight.trail = source.trail
      flight.share = source.trail ? (source.share ?? 0) : 0
      flight.toPool = !source.named
      flight.kick = source.flight.speed
      flight.clipKick = source.flight.clipSpeed
      this.flights.push(flight)
      // Same pace as a full crossfade, starting from where its fade got to.
      this.#fadeOut(flight, 'leaving', this.#crossfade * source.pose.opacity)
    } else if (source.named) source.copy.release()
    else if (this.#leave > 0) {
      const presence = new PresenceImpl(this, source.element, source.copy, this.#reduced)
      presence.key = source.key
      this.leaving.push(presence)
    } else this.#host.pool.add(source.key, source.copy)
  }

  /** Starts the flight of `source` to `to`, the `index`th pair in document order. */
  #flyPair(effects: EffectsApi, source: Source, to: Element, index: number): void {
    const self = to === source.element
    const box = to.getBoundingClientRect()
    // A node paired with itself only flies if it moved (FLIP).
    if (self && (this.#reduced || !moved(source.pose, box))) {
      this.#drop(source)
      return
    }
    // The copy that takes over at `to`: the source itself for a FLIP, none under reduced motion.
    let target: Copy | undefined = self ? source.copy : undefined
    if (!self && !this.#reduced) {
      const early = this.#early.get(source.key)
      // The copy shown underneath is the target again (double click), so keep it taken.
      if (source.trail?.element === to && source.trail.state !== 'released') target = source.trail
      else if (early?.element === to) {
        target = early
        this.#early.delete(source.key)
      } else target = this.#targetOf(effects, to)
    }
    const old = source.flight
    if (old && target && old.copy === source.copy && old.to === to && old.target === target) {
      // Same pair as in the superseded transition: keep flying from where it was. A holding one
      // lands again in its first frame and waits anew.
      old.owner = this
      old.state = 'flying'
      old.startAt = -(source.flown ?? 0)
      this.flights.push(old)
      // The old owner has ended and its `ready` callback no longer fires, so subscribe again.
      this.#watchReady(old, target)
      return
    }
    old?.anchor?.dispose()
    // Start from where the copy is now: the snapshot when held, the last drawn frame when it
    // followed. A carried copy starts at the alpha its pair covered.
    const pose = old ? source.pose : (poseOf(source.copy) ?? source.pose)
    const flight = new FlightImpl(this, source, to, pose)
    flight.startAt = index * this.#stagger
    flight.duration = this.#duration
    const trail = source.trail === target ? undefined : source.trail
    flight.trail = trail
    flight.share = trail ? (source.share ?? 0) : 0
    // The former trail is the target again, so its takeover resumes where it was.
    if (target && target === source.trail) flight.share = flight.shareFrom = source.share ?? 0
    if (old) {
      // Cut short mid-flight. Keep its speed and scale the duration by the distance left, with
      // sqrt because that is how time grows with distance at constant acceleration.
      flight.speed = flight.kick = old.speed
      flight.clipSpeed = flight.clipKick = old.clipSpeed
      flight.lowered = old.lowered
      const whole = travel(old.pose, old.targetBox ?? old.pose)
      const left = sized(box) ? travel(pose, box) : whole
      if (whole > 1) flight.duration *= Math.min(1, Math.max(SHORTEST, Math.sqrt(left / whole)))
    }
    this.flights.push(flight)
    if (!target || target.state === 'released') {
      // Reduced motion, or a target this app can't hide because another app took it. The copy
      // fades in place and the target shows its DOM or enters like any other element.
      this.#fadeOut(flight, 'leaving', this.#reduced ? REDUCED : this.#crossfade)
      return
    }
    this.#aim(flight, to, target, box)
    if (!self) this.#watchReady(flight, target)
  }

  /** Points the flight at `element` and its copy, tracked live and cut to its clipping ancestor. */
  #aim(flight: FlightImpl, element: Element, target: Copy, box: Box): void {
    flight.anchor?.dispose()
    flight.to = element
    flight.target = target
    flight.anchor = this.#host.app.anchors.track(element, { live: true })
    flight.frame = frameOf(element)
    flight.radius = sized(box) ? radiusOf(element, box) : undefined
    flight.warm = false
  }

  /** Marks the flight failed if the target's copy turns out never to draw. */
  #watchReady(flight: FlightImpl, target: Copy): void {
    void target.ready.then((ready) => {
      if (ready || flight.target !== target || this.#ended) return
      flight.failed = true
      this.#host.app.invalidate()
    })
  }

  // Entering and leaving

  // Veils new effect elements in view and fades them in once drawable. Under reduced motion
  // nothing flies, so targets enter like the rest.
  #enterNew(effects: EffectsApi, nodes?: readonly Element[]): void {
    const known = this.#known
    if (!(this.#enter > 0) || !known || effects.status.peek() !== 'ready') return
    const { width, height } = this.#host.app.stage
    const skip = new Set([
      ...known,
      ...(this.#reduced ? [] : this.flights.map((flight) => flight.to)),
      ...this.entering.map((presence) => presence.element),
      ...[...this.#early.values()].map((copy) => copy.element),
    ])
    const candidates = new Set(nodes ?? effectElements(effects))
    for (const element of [...candidates].sort(inDocumentOrder)) {
      if (skip.has(element) || !element.isConnected) continue
      if (!inView(element.getBoundingClientRect(), width.peek(), height.peek())) continue
      const copy = effects.take(element, {
        veil: true,
        leave: 'release',
        signal: this.#host.signal,
      })
      if (copy.state === 'released') continue
      const presence = new PresenceImpl(this, element, copy, this.#reduced)
      presence.set(0)
      // Inside a browser view transition they all come at once with its root crossfade.
      presence.at = this.#native ? 0 : ENTER_AT * this.#duration + ENTER_STEP * this.entering.length
      this.entering.push(presence)
      // No copy coming (off, failed, no effects) or not in time. Show the DOM and let a late
      // copy replace it when ready.
      const giveUp = (): void => {
        if (presence.shown || presence.done || copy.drawable) return
        presence.done = true
        copy.release()
        this.#host.app.invalidate()
      }
      void copy.ready.then((ready) => ready || giveUp())
      const wait = setTimeout(() => {
        this.#waits.delete(wait)
        giveUp()
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
      if (this.#sources.some((source) => !source.named && source.key === key)) return
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
    for (const item of items) {
      const taken = this.#sources.some((source) => !source.named && source.key === item.key)
      if (this.#settled || this.#stopped || taken) item.copy.release()
      else this.#sources.push(item)
    }
  }

  /** Observer callback during an async swap. Veils late targets as they arrive. */
  mutated(added: readonly Element[]): void {
    if (this.#settled || this.#ended || !this.#called) return
    this.#rotate()
    const effects = this.#host.app.effects
    if (!effects || !added.length || this.#stopped) return
    if (!this.#reduced) {
      // Veil arriving elements whose key a source waits for, before effects draws them.
      const keys = new Set(
        this.#sources.filter((source) => !source.named).map((source) => source.key),
      )
      for (const element of added.flatMap((node) => within(node, '[data-dio-key]'))) {
        const key = element.getAttribute('data-dio-key') as string
        if (!keys.has(key) || this.#early.has(key) || this.#snapshot.has(element)) continue
        const copy = this.#targetOf(effects, element)
        if (copy.state !== 'released') this.#early.set(key, copy)
      }
    }
    this.#enterNew(
      effects,
      added.flatMap((node) => within(node, '[data-dio]')),
    )
  }

  /** Moves flights whose target was removed to a node with the same key, now or within `grace`. */
  relink(added: readonly Element[], removed: boolean): void {
    for (const flight of this.flights) {
      if (flight.owner !== this || (flight.state !== 'flying' && flight.state !== 'holding'))
        continue
      if (removed && flight.target && flight.target !== flight.copy && !flight.to.isConnected)
        this.lose(flight)
      if (!flight.lost) continue
      const next = added.flatMap((node) => within(node, keySelector(flight.key)))[0]
      if (next) this.#retarget(flight, next)
    }
  }

  lose(flight: FlightImpl): void {
    const target = flight.target
    flight.target = undefined
    flight.mixAt = undefined
    flight.shareFrom = 0
    // If it shows under the copy, it fades out there as a trail and becomes a ghost once its node
    // is gone. Otherwise release it so no veil stays on a node that left.
    const showsUnder =
      target &&
      target !== flight.copy &&
      flight.share > 0 &&
      !flight.trail &&
      target.state !== 'released'
    if (showsUnder) flight.trail = target
    else target?.release()
    const next = [...document.querySelectorAll(keySelector(flight.key))].find(
      (element) => element !== flight.from,
    )
    if (next && this.#retarget(flight, next)) return
    flight.lost = true
    clearTimeout(flight.timer)
    flight.timer = setTimeout(() => {
      if (!flight.lost || this.#ended || flight.state === 'done') return
      this.#fadeOut(flight, 'leaving', LEAVE)
      this.#host.app.invalidate()
    }, this.#host.options.grace * 1000)
  }

  #retarget(flight: FlightImpl, element: Element): boolean {
    const effects = this.#host.app.effects
    if (!effects || this.#ended) return false
    const target = this.#targetOf(effects, element)
    if (target.state === 'released') return false
    clearTimeout(flight.timer)
    const box = element.getBoundingClientRect()
    this.#aim(flight, element, target, box)
    flight.lost = flight.failed = false
    // A holding flight lands again in its next frame and waits for the new copy.
    flight.state = 'flying'
    // A node replaced in place (React re-render) changes nothing on screen, so the flight goes on.
    // Anywhere else, start a new flight from where the copy is.
    if (!flight.targetBox || !sized(box) || moved(flight.targetBox, box)) {
      this.#rebase(flight)
      flight.targetBox = undefined
      flight.kick = flight.speed
      flight.clipKick = flight.clipSpeed
    }
    this.#watchReady(flight, target)
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
      this.#resumeAssets = this.#host.app.assets?.pause('transition') ?? noop
      this.#animate()
      if (this.#ended) return false
    }
    const touched = this.#touched
    this.#touched = false
    let busy = false
    for (const flight of this.flights) {
      if (flight.owner === this) busy = this.#step(flight, dt) || busy
    }
    for (const presence of this.leaving) busy = this.#leaveStep(presence) || busy
    for (const presence of this.entering) busy = this.#enterStep(presence) || busy
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
    for (const flight of this.flights) {
      if (flight.owner === this && flight.state === 'flying') flight.advance(1)
    }
    this.#unpair()
    this.#host.app.invalidate()
  }

  /**
   * Live box of the target once it has a size (an image without width/height may not yet), or
   * the box its own effects pose it to, where its copy will be once let go.
   */
  #live(flight: FlightImpl): Box | undefined {
    const { anchor } = flight
    const posed = flight.target?.posed
    if (anchor && !flight.lost && sized(anchor)) {
      flight.targetBox = boxOf(posed && sized(posed) ? posed : anchor)
    }
    return flight.targetBox
  }

  /** Live box of the target's clipping ancestor, or the target box if it has none or the pose lifts it. */
  #cut(flight: FlightImpl, live: Box): Box {
    const open = flight.target?.posed?.clip === false
    const frame =
      flight.frame?.isConnected && !open ? flight.frame.getBoundingClientRect() : undefined
    return frame ? { x: frame.left, y: frame.top, width: frame.width, height: frame.height } : live
  }

  #step(flight: FlightImpl, dt: number): boolean {
    const copy = flight.copy
    if (flight.state === 'done') return false
    // The runtime stopped (render, device loss, remove('effects')) and released the copies.
    if (copy.state === 'released') {
      flight.target?.release()
      this.#rest(flight)
      return false
    }
    // Stay over the page even when fading in place, or under reduced motion the new page's copies
    // would cut through it. Fresh flights go above copies that faded in place, so a clicked
    // picture flies over the pair it superseded rather than through it.
    copy.above = flight.lowered ? GONE : TOP
    if (flight.state === 'crossfading' || flight.state === 'leaving')
      return this.#fadeStep(flight, dt)
    if (flight.target && flight.target !== copy && !flight.to.isConnected) this.lose(flight)
    const first = !flight.targetBox
    const live = this.#live(flight)
    // Target lost. The copy stays put with its clock paused until a partner comes or `grace`
    // runs out.
    if (flight.lost) {
      flight.startAt += dt
      flight.speed = flight.clipSpeed = undefined
      return true
    }
    // The target's effects posed it, or stopped: a new place to land, flown to from here.
    const posed = flight.target?.posed
    const reposed = !!live && !first && flight.posed !== !!posed
    flight.posed = !!posed
    if (posed) flight.radius = posed.radius
    else if (live && reposed) flight.radius = radiusOf(flight.to, live)
    else if (live && first) flight.radius ??= radiusOf(flight.to, live)
    if (flight.state === 'holding' && live && (first || reposed)) {
      // Got its size or its pose only after the whole flight. Restart from where the copy waited.
      clearTimeout(flight.timer)
      flight.state = 'flying'
      this.#rebase(flight)
      return true
    }
    const to = live ?? flight.pose
    // Land at the target's CSS opacity. A FLIP keeps its own.
    const alpha = (flight.target?.cssOpacity ?? 1) * flight.opacity
    // The clip goes from the source's to the target's. A missing clip means the box itself.
    const cut = live ? this.#cut(flight, live) : (flight.pose.clip ?? flight.pose)
    if (flight.state === 'holding') {
      // Landed, waiting for the target's copy: stay on the target.
      copy.box = to
      copy.crop = flightCrop(flight, to, to, 1)
      copy.clip = cut
      copy.radius = flight.radius ?? flight.pose.radius
      flight.speed = flight.clipSpeed = undefined
      this.#blend(flight, undefined, alpha, dt)
      this.#land(flight)
    } else this.#flyStep(flight, dt, to, !!live && (first || reposed), cut, alpha)
    flight.warm = !!flight.target?.drawable
    return (flight.state as FlightState) !== 'done'
  }

  // `to` is the target's live box or the source pose. `late` means it got its size or its pose
  // this frame.
  #flyStep(flight: FlightImpl, dt: number, to: Box, late: boolean, cut: Box, alpha: number): void {
    const copy = flight.copy
    const animated = !!this.#options.animate
    let progress = clamp(flight.progress)
    let eased = progress
    if (!animated) {
      const elapsed = this.#clock - flight.startAt
      // `duration: 0` lands at the start. 0 / 0 would draw nothing for a frame.
      progress = flight.duration > 0 ? clamp(elapsed / flight.duration) : +(elapsed >= 0)
      flight.advance(progress)
      eased = (this.#options.ease ?? this.#host.options.ease)(progress)
    }
    // Sized late. Continue from where the copy is so it doesn't jump.
    if (late && eased > 0) {
      flight.pose = here(flight)
      flight.poseAt = eased
    }
    // Share of the way from `pose` to `to`, measured from the progress `pose` was taken at.
    const { poseAt } = flight
    const t = poseAt === 0 ? eased : poseAt < 1 ? (eased - poseAt) / (1 - poseAt) : 1
    let box = lerpBox(flight.pose, to, t)
    let clip = lerpBox(flight.pose.clip ?? flight.pose, cut, t)
    // A carried velocity keeps the copy moving and dies out, so there is no dead stop.
    const kick = flight.kick && !animated ? flight.duration * progress * (1 - progress) ** DAMP : 0
    if (kick > 0 && flight.kick) {
      box = push(box, flight.kick, kick)
      clip = push(clip, flight.clipKick ?? flight.kick, kick)
    }
    if (dt > 0 && progress > 0 && copy.box) flight.speed = rate(copy.box, box, dt)
    if (dt > 0 && progress > 0 && copy.clip) flight.clipSpeed = rate(copy.clip, clip, dt)
    copy.box = box
    copy.crop = flightCrop(flight, to, box, t)
    copy.clip = clip
    copy.radius = lerp(flight.pose.radius, flight.radius ?? flight.pose.radius, t)
    this.#blend(flight, progress, lerp(flight.pose.opacity, alpha, t), dt)
    if (progress >= 1) this.#land(flight)
  }

  /** Finishes the takeover at the target, or fades out together with what is under it. */
  #fadeStep(flight: FlightImpl, dt: number): boolean {
    const copy = flight.copy
    flight.fadeTime += dt
    const t = flight.fadeSpan > 0 ? clamp(flight.fadeTime / flight.fadeSpan) : 1
    const live = flight.state === 'crossfading' ? this.#live(flight) : undefined
    if (live) {
      place(copy, live)
      copy.clip = this.#cut(flight, live)
    } else if (flight.kick && !this.#reduced) {
      // Coast on with the velocity carried in, slowing as v * (1 - t)^COAST to a stop.
      const distance = (flight.fadeSpan * (1 - (1 - t) ** (COAST + 1))) / (COAST + 1)
      const box = push(flight.pose, flight.kick, distance)
      const clip = push(flight.pose.clip ?? flight.pose, flight.clipKick ?? flight.kick, distance)
      if (dt > 0 && copy.box) flight.speed = rate(copy.box, box, dt)
      if (dt > 0 && copy.clip) flight.clipSpeed = rate(copy.clip, clip, dt)
      place(copy, box)
      copy.clip = clip
    }
    const target = flight.target
    if (flight.state === 'crossfading' && target && target !== copy) {
      flight.share = lerp(flight.landedShare, 1, t)
      flight.cover = lerp(flight.fadeFrom, target.cssOpacity, t)
      show(flight, target)
    } else {
      // Whatever shows underneath fades out with it in the same mix.
      if (flight.trail?.state === 'released') this.#untrail(flight)
      flight.cover = flight.fadeFrom * (1 - t)
      show(flight, flight.trail)
    }
    if (t < 1) return true
    this.#rest(flight)
    return false
  }

  /** Starts the flight over from where its copy is now. */
  #rebase(flight: FlightImpl): void {
    flight.pose = here(flight)
    flight.poseAt = 0
    flight.startAt = this.#clock
    flight.advance(0)
  }

  // Picks what shows under the flying copy. A former target fades out first, then the target takes
  // over once drawable. With `progress` undefined (holding) the takeover waits for the landing.
  #blend(flight: FlightImpl, progress: number | undefined, cover: number, dt: number): void {
    const target = flight.target !== flight.copy ? flight.target : undefined
    let under: Copy | undefined
    flight.cover = cover
    if (flight.trail) {
      flight.share = this.#crossfade > 0 ? flight.share - dt / this.#crossfade : 0
      if (flight.share > 0 && flight.trail.state !== 'released') under = flight.trail
      else this.#untrail(flight)
    } else if (progress !== undefined && target?.drawable && !flight.failed) {
      flight.mixAt ??= Math.max(progress, MIX_FROM)
      const mixTo = Math.max(MIX_TO, flight.mixAt + MIX_MIN)
      const next = lerp(flight.shareFrom, 1, smooth(flight.mixAt, mixTo, progress))
      // Cap at twice the crossfade rate so a progress jump (a stall, a timeline setting 1) doesn't
      // swap the picture in one frame. Whatever is left plays after the landing.
      const most = this.#crossfade > 0 ? flight.share + (2 * dt) / this.#crossfade : 1
      flight.share = Math.min(next, most)
      if (flight.share > 0) under = target
    } else {
      flight.share = flight.shareFrom = 0
      flight.mixAt = undefined
    }
    if (target && target !== under) {
      target.veil = true
      target.leave = 'release'
    }
    show(flight, under)
  }

  #untrail(flight: FlightImpl): void {
    const trail = flight.trail
    flight.trail = undefined
    flight.share = 0
    if (trail) this.#host.remnant(trail, this.gen)
  }

  // A takeover finished in flight releases both copies with no visible change. An unfinished one
  // plays out as a crossfade in place. A target that isn't ready yet holds the copy there.
  #land(flight: FlightImpl): void {
    const target = flight.target
    if (!target || target === flight.copy) {
      this.#landings++
      this.#rest(flight)
      return
    }
    // A former target still fading out under the copy goes first. One drawable only since this
    // frame has not run its effects yet, so it waits a frame for the pose they may give it.
    if (flight.trail || !((target.drawable && flight.warm) || flight.failed)) {
      this.#hold(flight)
      return
    }
    this.#landings++
    if (!target.drawable) {
      target.release()
      flight.target = undefined
      flight.share = 0
    }
    const left = flight.target
      ? Math.max(1 - flight.share, Math.abs(target.cssOpacity - flight.cover))
      : 1
    if (left < TAKEN) {
      this.#rest(flight)
      return
    }
    this.#fadeOut(flight, 'crossfading', this.#crossfade * left)
    flight.landedShare = flight.share
    if (flight.target) show(flight, target)
  }

  #hold(flight: FlightImpl): void {
    if (flight.state === 'holding') return
    flight.state = 'holding'
    flight.timer = setTimeout(() => {
      if (flight.state !== 'holding' || this.#ended) return
      flight.failed = true
      this.#host.app.invalidate()
    }, this.#wait * 1000)
  }

  #fadeOut(flight: FlightImpl, state: 'crossfading' | 'leaving', seconds: number): void {
    clearTimeout(flight.timer)
    flight.state = state
    if (state === 'leaving') flight.lowered = true
    flight.fadeTime = 0
    flight.fadeSpan = seconds
    flight.fadeFrom = flight.cover
  }

  /** Stops steps and timers. The anchor is kept only if the flight is carried over. */
  #halt(flight: FlightImpl, carried = false): void {
    flight.state = 'done'
    clearTimeout(flight.timer)
    if (carried) return
    flight.anchor?.dispose()
    flight.anchor = undefined
  }

  // The flying copy is released, or kept hidden as a remnant while its element is still in the
  // document. The target's copy goes back to following its DOM.
  #rest(flight: FlightImpl): void {
    this.#halt(flight)
    this.#untrail(flight)
    const target = flight.target
    if (target && target !== flight.copy) {
      target.veil = false
      target.release()
      flight.target = undefined
    }
    if (target !== flight.copy && flight.copy.state !== 'ghost' && flight.from.isConnected) {
      this.#host.remnant(flight.copy, this.gen, flight.to)
    } else if (flight.toPool) this.#host.pool.add(flight.key, flight.copy)
    else flight.copy.release()
  }

  #leaveStep(presence: PresenceImpl): boolean {
    if (presence.copy.state === 'released') presence.done = true
    if (presence.done) return false
    if (this.#options.animate) return presence.presence > 0
    const level = this.#leave > 0 ? clamp(1 - this.#clock / this.#leave) : 0
    presence.set(level)
    if (level > 0) return true
    this.#quit(presence)
    return false
  }

  /** A faded leaving copy waits in the pool if it has a key, else it goes. */
  #quit(presence: PresenceImpl): void {
    presence.done = true
    if (presence.key !== undefined) this.#host.pool.add(presence.key, presence.copy)
    else presence.copy.release()
  }

  #enterStep(presence: PresenceImpl): boolean {
    const copy = presence.copy
    if (copy.state === 'released') presence.done = true
    if (presence.done) return false
    if (!presence.shown) {
      if (copy.drawable && (this.#options.animate || this.#clock >= presence.at)) {
        copy.veil = false
        presence.shown = true
        presence.at = this.#clock
      }
      return true
    }
    if (this.#options.animate) return presence.presence < 1
    const level = this.#enter > 0 ? clamp((this.#clock - presence.at) / this.#enter) : 1
    presence.set(level)
    if (level < 1) return true
    presence.done = true
    copy.release()
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
    for (const flight of this.flights) {
      if (flight.owner !== this || flight.state === 'done') continue
      const inAir = flight.state === 'flying' || flight.state === 'holding'
      if (inAir && !flight.lost) this.#landings++
      this.#rest(flight)
    }
    this.#unpair()
    this.#end(status)
  }

  /** Leaving copies go or wait in the pool, entering ones show. */
  #unpair(): void {
    for (const presence of this.leaving) if (!presence.done) this.#quit(presence)
    for (const presence of this.entering) {
      if (presence.done) continue
      presence.done = true
      presence.copy.veil = false
      presence.copy.release()
    }
  }

  /** Lets go of every copy still held. Connected ones live on as before, ghosts go. */
  #release(): void {
    for (const source of this.#sources) this.#drop(source)
    this.#sources = []
    for (const copy of this.#early.values()) copy.release()
    this.#early.clear()
    for (const flight of this.flights) {
      if (flight.owner !== this || flight.state === 'done') continue
      this.#halt(flight)
      flight.target?.release()
      flight.copy.release()
      this.#untrail(flight)
    }
    for (const presence of [...this.leaving, ...this.entering]) {
      if (presence.done) continue
      presence.done = true
      presence.copy.release()
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
    for (const flight of this.flights) {
      if (flight.owner !== this || flight.state === 'done') continue
      const source = this.#carry(flight)
      if (source) carried.push(source)
    }
    // The plugin finishes the fade from where it is, at the same pace.
    const fadeOn = (presence: PresenceImpl, to: number, pace: number, then: () => void): void => {
      presence.done = true
      const seconds = pace * Math.abs(to - presence.presence)
      host.fade(presence.copy, presence.prop, presence.scale * to, seconds, then)
    }
    for (const presence of this.leaving) {
      if (!presence.done) fadeOn(presence, 0, this.#leave || LEAVE, () => this.#quit(presence))
    }
    for (const presence of this.entering) {
      if (presence.done) continue
      if (presence.shown) {
        fadeOn(presence, 1, this.#enter || LEAVE, () => presence.copy.release())
      } else {
        presence.done = true
        host.remnant(presence.copy, this.gen)
      }
    }
    this.#end('superseded')
    return carried
  }

  /**
   * Turns a superseded flight into a source for the next transition. If a target shows under it,
   * whichever of the two shows more flies on and the other trails, so the picture doesn't change.
   */
  #carry(flight: FlightImpl): Source | undefined {
    const copy = flight.copy
    if (flight.state === 'leaving' && copy.state !== 'ghost' && flight.from.isConnected) {
      // Source still in the document (Barba sync). Make it a remnant the next transition may fly
      // back to. If it kept fading it would stay taken past that transition.
      this.#halt(flight)
      this.#host.remnant(copy, this.gen)
      this.#untrail(flight)
      return undefined
    }
    const target = flight.target !== copy ? flight.target : undefined
    let leader = copy
    let element = flight.from
    let trail = flight.trail
    let share = trail ? flight.share : 0
    if (target && !trail && flight.share > 0 && target.state !== 'released') {
      target.leave = 'ghost'
      if (flight.share < 0.5) {
        trail = target
        share = flight.share
      } else {
        leader = target
        element = flight.to
        trail = copy
        share = 1 - flight.share
      }
    } else if (target) {
      if (flight.to.isConnected) this.#host.remnant(target, this.gen)
      else target.release()
    }
    const pose = poseOf(leader)
    if (pose && leader.state !== 'released') {
      // Keep the anchor. The next transition either flies it on or disposes of it.
      this.#halt(flight, true)
      return {
        key: flight.key,
        named: flight.named,
        element,
        copy: leader,
        pose: { ...pose, opacity: flight.cover },
        flight,
        flown: this.#clock - flight.startAt,
        trail,
        share,
      }
    }
    this.#halt(flight)
    leader.release()
    if (trail) this.#host.remnant(trail, this.gen)
    return undefined
  }

  #end(status: TransitionResult['status'], error?: unknown): void {
    if (this.#ended) return
    this.#ended = true
    clearTimeout(this.#swapTimer)
    clearTimeout(this.#animateTimer)
    this.#removeAbortListener()
    this.#resumeAssets()
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
    this.#resolveFinished(result)
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
