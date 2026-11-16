import {
  type Off,
  type PluginApp,
  type ReadonlySignal,
  type Services,
  type Signal,
  signal,
} from '@diorama/core'
import type { RenderApi } from '@diorama/render'
import { recheck, resolve, validate, values } from './cascade'
import { isEffect, query } from './define'
import { EffectError, targetOf } from './errors'
import { facade, handle } from './facades'
import { kebab, rebuilds } from './params'
import type { Registry } from './registry'
import type {
  AnyParamValue,
  AttachOptions,
  Copy,
  Effect,
  EffectHandle,
  EffectInstance,
  EffectsStats,
  EffectsStatus,
  EffectUse,
  InstanceStatus,
  TakeOptions,
  Target,
} from './types'

/** The part of `@diorama/assets` effects uses, typed structurally to avoid importing it. */
export interface AssetsPort {
  acquire<T>(
    key: string,
    make: (context: {
      readonly signal: AbortSignal
      decode<R>(work: () => Promise<R>): Promise<R>
    }) => Promise<{ readonly value: T; readonly bytes?: number; dispose?(): void }>,
    options?: { readonly priority?: 'high' | 'normal' | 'low'; readonly weight?: number },
  ): { readonly ready: Promise<T>; release(): void }
  track(
    work: PromiseLike<unknown>,
    options?: { readonly weight?: number; readonly priority?: 'high' | 'normal' | 'low' },
  ): void
}

export type EffectsView = PluginApp<
  Pick<Services, 'stage' | 'scroll' | 'pointer' | 'anchors'> & {
    readonly render?: RenderApi
    readonly assets?: AssetsPort
  }
>

export type ReleaseReason =
  | 'removed'
  | 'detached'
  | 'disabled'
  | 'failed'
  | 'engine'
  | 'destroy'
  | 'handover'
  | 'restart'

/** What the light part needs from the runtime. Internal. */
export interface Runtime {
  /**
   * Prepares media if declared, runs setup and compiles. Resolves once the attempt settles.
   * 'aborted' means a newer generation took over.
   */
  mount(instance: InstanceRecord, signal: AbortSignal): Promise<'running' | 'failed' | 'aborted'>
  /** Hides or brings back a mounted instance. `connected` picks the drawn rule. */
  park(instance: InstanceRecord, parked: boolean, connected: boolean): void
  /** Writes a live param into its uniform and requests a frame if visible. */
  write(instance: InstanceRecord, name: string, value: AnyParamValue): void
  /** Re-runs setup in two phases at the next frame where the instance is visible. */
  rebuild(instance: InstanceRecord): void
  /** Disposes everything the instance created and releases layer leases. Needs no frame. */
  unmount(instance: InstanceRecord, reason: ReleaseReason): void
  /** Leases a layer for an element without an effect, for `layers()`. */
  lease(element: Element, owner: InstanceRecord): Off
  /** Called after a reconcile pass to re-read live `layers()` queries and effect order. */
  scanned(): void
  /** The element left the document. Returns true if its copy stays as a ghost. */
  handover(element: Element): boolean
  take(element: Element, options?: TakeOptions): Copy
  stats(): EffectsStats
  dispose(): void
}

/** What the runtime gets from the light part. */
export interface RuntimeHost {
  /** Recomputed on each call. */
  values(instance: InstanceRecord): Readonly<Record<string, AnyParamValue>>
  /** In effect order: markup tokens first, then code sources. */
  instancesOf(element: Element): readonly InstanceRecord[]
  /** Sets the runtime-owned `data-dio-state`. `undefined` hands it back. */
  present(element: Element, state: 'live' | 'drawn' | undefined): void
  /** Records a failure inside `mount`, which then resolves 'failed'. */
  report(instance: InstanceRecord, error: unknown): void
  /** A mounted instance failed in update or compile. Reports and unmounts it. */
  fail(instance: InstanceRecord, error: unknown): void
  /** Device lost or render disabled. Every instance becomes `unavailable`. */
  lost(): void
  /** A pose touched this element's layer, so its waiting instances load at once. */
  wake(element: Element): void
  pin(element: Element): (() => number) | undefined
  /** `data-dio-track`, else the attach options. */
  track(element: Element): 'live' | 'layout' | 'frame'
  /** The runtime saw the element disconnected. Re-evaluates its instances. */
  check(element: Element): void
  /** Media of a failed element changed, so EFFECT_MEDIA and EFFECT_CORS failures wait again. */
  retry(element: Element): void
  /** Attach owned by the runtime (`ctx.attach`, `layers()`). A selector stays inside `within`. */
  attach(target: string | Element, use: Effect | EffectUse, within?: Element): EffectHandle
  /** Plugins started after `effects`. The drawn hook runs after them. */
  plugins(): readonly string[]
  /** One warning per (element, key). */
  warn(key: string, error: EffectError): void
  /** Sets `data-dio-state="entering"`. The light part owns veils. */
  veil(element: Element, on: boolean): void
  /** Adds the element to the next reconcile without flushing now. */
  queue(element: Element): void
}

/** Copy nobody controls. Released, never ready, ignores writes. */
export function inertCopy(element: Element): Copy {
  const copy = {
    element,
    state: 'released',
    drawable: false,
    ready: Promise.resolve(false),
    drawn: undefined,
    source: '',
    effects: [],
    cssOpacity: 1,
    cropAt: () => undefined,
    release: noop,
    dispose: noop,
  }
  const fixed = {
    box: undefined,
    radius: undefined,
    clip: undefined,
    opacity: 1,
    presence: 1,
    veil: false,
    above: 0,
    crop: undefined,
    leave: 'ghost',
  }
  for (const [key, value] of Object.entries(fixed)) {
    Object.defineProperty(copy, key, { get: () => value, set: noop, enumerable: true })
  }
  return copy as unknown as Copy
}

export const NO_STATS: EffectsStats = Object.freeze({
  layers: 0,
  ghosts: 0,
  copies: 0,
  instances: 0,
  textures: 0,
  bitmaps: 0,
})

export interface Write {
  readonly value: unknown
  readonly seq: number
}

export interface InstanceRecord {
  readonly element: Element
  readonly name: string
  readonly facade: EffectInstance
  readonly state: Signal<InstanceStatus>
  status: InstanceStatus
  error: unknown
  effect: Effect | undefined
  generation: number
  abort: AbortController | undefined
  /** Previous mount attempt. A new one waits for it, so a pair never runs two setups. */
  settled: Promise<unknown>
  markup: boolean
  readonly handles: Set<HandleState>
  /** `instance.params` writes. They belong to the pair and survive re-creation. */
  readonly writes: Map<string, Write>
  /** Values last given to the runtime. */
  values: Record<string, AnyParamValue>
  parkedFrame: number
  /** Creation order on the element, for code sources. */
  readonly order: number
  /** Adds accessors for param keys known by now. */
  sync(): void
}

export interface HandleState {
  readonly id: number
  readonly name: string
  readonly params: Record<string, unknown>
  readonly writes: Map<string, Write>
  readonly options: AttachOptions
  readonly rule: string | undefined
  /** Runtime-owned rules match descendants of this element only. */
  readonly within: Element | undefined
  readonly refs: WeakRef<Element>[]
  readonly records: Set<InstanceRecord>
  live: boolean
  sync(): void
}

export const noop = (): void => {}
const MEDIA = 'img, video'
const MOUNTED: ReadonlySet<InstanceStatus> = new Set(['running', 'parked'])
const same = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : Object.is(a, b)

export interface DomPort {
  inRoot(element: Element): boolean
  query(selector: string): Iterable<Element>
  claim(element: Element): boolean
  release(element: Element): void
  /** Re-derives `data-dio-state` of an element. */
  sync(element: Element): void
  /** Observes param attributes of loaded effects. An empty list stops observing. */
  watch(element: Element, attributes: readonly string[]): void
  rules(active: boolean): void
  /** Adds or removes the hiding stylesheet. */
  adopt(on: boolean): void
  present: WeakMap<Element, 'live' | 'drawn'>
}
export interface EnginePort {
  readonly runtime: Runtime | undefined
  /** Set once the gate decided that no instance runs. */
  readonly blocked: 'off' | 'unavailable' | undefined
  boot(): Promise<Runtime | undefined>
  /** A near or eager element asks for the engine. Obeys the load mode. */
  request(eager: boolean): void
  /** Downloads the engine module without starting `render`. */
  fetch(): void
  near(element: Element): boolean
  /** The observer has reported the element since it was last watched. */
  reported(element: Element): boolean
  /** Bumped after each observer callback. */
  readonly intersections: ReadonlySignal<number>
  canBoot(): boolean
  readonly loading: boolean
  readonly status: ReadonlySignal<EffectsStatus>
  matches(query: string): boolean
  reducedMotion(): boolean
  watch(element: Element, on: boolean): void
}

/** An unnamed effect attached directly gets a stable generated name. */
const names = new WeakMap<Effect, string>()
let unnamedCount = 0
const unnamed = (effect: Effect): string => {
  let name = names.get(effect)
  if (!name) {
    name = `effect-${++unnamedCount}`
    names.set(effect, name)
  }
  return name
}

/** Instances, sources and the light lifecycle. Params resolve in cascade.ts. */
export class Controller {
  readonly app: EffectsView
  readonly registry: Registry
  dom!: DomPort
  engine!: EnginePort
  readonly live: Set<InstanceRecord> = new Set()
  readonly rules: Set<HandleState> = new Set()
  /** `app.effects.pin` sources per element, newest last. */
  readonly pins: WeakMap<Element, { readonly source: () => number }[]> = new WeakMap()
  /** Live handles with element targets. While nonzero, added subtrees are searched for them. */
  targets = 0
  readonly #pairs = new WeakMap<Element, Map<string, InstanceRecord>>()
  readonly #tokens = new WeakMap<Element, readonly string[]>()
  readonly #targets = new WeakMap<Element, Set<HandleState>>()
  readonly #disabled = new Map<string, number>()
  readonly #handles = new Set<HandleState>()
  readonly #warned = new WeakMap<object, Set<string>>()
  readonly #loadErrors = new Map<string, EffectError>()
  /** Handle ids and write order. The later of two sources wins. */
  seq = 0
  #sweep: { timer: ReturnType<typeof setTimeout>; system: Off } | undefined

  constructor(app: EffectsView, registry: Registry) {
    this.app = app
    this.registry = registry
  }

  /** One warning per (element or app, key). */
  warn(key: string, error: EffectError): void {
    const at = error.element ?? this.#warned
    const seen = this.#warned.get(at) ?? new Set<string>()
    this.#warned.set(at, seen)
    if (seen.has(key)) return
    seen.add(key)
    this.app.log.warn(error.message, error.element ?? '')
  }

  report(rec: InstanceRecord, error: unknown): void {
    rec.error = error
    const aborted = (error as { name?: string } | null)?.name === 'AbortError'
    if (!aborted) this.app.report(error, targetOf(rec.name, rec.element))
  }

  pair(element: Element, name: string): InstanceRecord {
    let pairs = this.#pairs.get(element)
    if (!pairs) {
      pairs = new Map()
      this.#pairs.set(element, pairs)
    }
    let rec = pairs.get(name)
    if (rec) return rec
    const state = signal<InstanceStatus>('disposed')
    rec = {
      element,
      name,
      state,
      facade: undefined as unknown as EffectInstance,
      status: 'disposed',
      error: undefined,
      effect: undefined,
      generation: 0,
      abort: undefined,
      settled: Promise.resolve(),
      markup: false,
      handles: new Set(),
      writes: new Map(),
      values: {},
      parkedFrame: 0,
      order: pairs.size,
      sync: noop,
    }
    ;(rec as { facade: EffectInstance }).facade = facade(this, rec)
    pairs.set(name, rec)
    return rec
  }

  find(element: Element, name: string): InstanceRecord | undefined {
    return this.#pairs.get(element)?.get(name)
  }

  /** Live instances of an element in effect order. */
  of(element: Element): InstanceRecord[] {
    const pairs = this.#pairs.get(element)
    if (!pairs) return []
    const tokens = this.#tokens.get(element) ?? []
    const rank = (r: InstanceRecord): number => {
      const i = r.markup ? tokens.indexOf(r.name) : -1
      return i < 0 ? tokens.length + r.order : i
    }
    return [...pairs.values()]
      .filter((r) => r.status !== 'disposed')
      .sort((a, b) => rank(a) - rank(b))
  }

  eager(rec: InstanceRecord): boolean {
    if (rec.element.getAttribute('data-dio-load') === 'eager') return true
    for (const h of rec.handles) if (h.options.eager) return true
    return false
  }

  /** `data-dio-track`, else the latest attach option among the element's instances. */
  track(element: Element): 'live' | 'layout' | 'frame' {
    const attr = element.getAttribute('data-dio-track')
    if (attr === 'layout' || attr === 'frame') return attr
    let track: 'live' | 'layout' | 'frame' = 'live'
    for (const rec of this.of(element))
      for (const h of rec.handles) track = h.options.track ?? track
    return track
  }

  #status(rec: InstanceRecord, status: InstanceStatus, error?: unknown): void {
    if (error !== undefined) rec.error = error
    else if (status === 'waiting' || status === 'loading') rec.error = undefined
    if (rec.status === status) return
    const was = rec.status
    rec.status = status
    if (status === 'disposed') this.live.delete(rec)
    else this.live.add(rec)
    const el = rec.element
    if (status === 'waiting') this.engine.watch(el, true)
    else if (was === 'waiting' && !this.of(el).some((r) => r.status === 'waiting')) {
      this.engine.watch(el, false)
    }
    if (!MOUNTED.has(status) && !this.of(el).some((r) => MOUNTED.has(r.status))) {
      this.dom.present.delete(el)
    }
    rec.state.value = status
    this.app.emit('effects:status', { element: el, effect: rec.name, status, error: rec.error })
    this.dom.sync(el)
  }

  #off(rec: InstanceRecord): boolean {
    if (this.#disabled.has(rec.name) || this.engine.blocked === 'off') return true
    const def = rec.effect?.['~definition']
    const motion = this.registry.reducedMotion(rec.name) ?? def?.reducedMotion
    if (motion === 'off' && this.engine.reducedMotion()) return true
    const when = this.registry.when(rec.name) ?? query(def?.when)
    return when !== undefined && !this.engine.matches(when)
  }

  /** Re-evaluates an instance after its sources, connection or conditions changed. */
  update(rec: InstanceRecord): void {
    const connected = this.dom.inRoot(rec.element)
    if (!connected || (!rec.markup && rec.handles.size === 0)) {
      this.#drop(rec, connected)
      return
    }
    if (rec.status === 'disposed') {
      // Another app owns the element. Keep no source, so it can be claimed later.
      if (!this.dom.claim(rec.element)) {
        this.#unlink(rec)
        return
      }
      rec.sync()
      this.#status(rec, 'waiting')
    }
    if (this.#off(rec)) this.#stop(rec, 'off', 'disabled')
    else if (this.engine.blocked === 'unavailable') this.#stop(rec, 'unavailable', 'engine')
    else this.#resume(rec)
  }

  #resume(rec: InstanceRecord): void {
    if (rec.status === 'off' || rec.status === 'unavailable') this.#status(rec, 'waiting')
    if (rec.status === 'parked') {
      this.engine.runtime?.park(rec, false, true)
      this.#status(rec, 'running')
      this.changed(rec)
    }
    this.advance(rec)
  }

  #drop(rec: InstanceRecord, connected: boolean): void {
    const el = rec.element
    // The element left the document. Its copy may live on as a ghost, decided once for all
    // its records.
    if (rec.status === 'running' && !el.isConnected && this.engine.runtime?.handover(el)) {
      for (const r of this.of(el)) this.dispose(r, 'handover')
      return
    }
    if (rec.status === 'running') {
      this.engine.runtime?.park(rec, true, connected)
      rec.parkedFrame = this.app.loop.time.frame
      this.#status(rec, 'parked')
      this.#schedule()
    } else if (rec.status !== 'parked' && rec.status !== 'disposed') {
      this.dispose(rec, connected ? 'detached' : 'removed')
    }
  }

  /** Releases what the instance holds and sets `status`, abandoning a loading attempt. */
  #stop(rec: InstanceRecord, status: InstanceStatus, reason: ReleaseReason): void {
    const loading = rec.status === 'loading'
    if (loading) {
      rec.generation++
      rec.abort?.abort()
    }
    // A mount may have resolved 'running' before its continuation ran, so unmount here too.
    if (loading || MOUNTED.has(rec.status)) this.engine.runtime?.unmount(rec, reason)
    this.#status(rec, status)
  }

  #unlink(rec: InstanceRecord): void {
    for (const h of rec.handles) h.records.delete(rec)
    rec.handles.clear()
    rec.markup = false
  }

  dispose(rec: InstanceRecord, reason: ReleaseReason): void {
    if (rec.status === 'disposed') return
    this.#stop(rec, 'disposed', reason)
    this.#unlink(rec)
    rec.effect = undefined
    if (!this.of(rec.element).length) {
      this.dom.release(rec.element)
      this.dom.watch(rec.element, [])
    } else this.#watchAttrs(rec.element)
  }

  advance(rec: InstanceRecord): void {
    if (rec.status !== 'waiting') return
    const entry = this.registry.entries.get(rec.name)
    if (!entry) {
      if (this.engine.runtime) {
        const known = [...this.registry.entries.keys()].join(', ')
        const error = new EffectError(
          'EFFECT_UNKNOWN',
          `unknown effect "${rec.name}"; known: ${known}`,
        )
        this.warn(`unknown:${rec.name}`, error)
      }
      return
    }
    const eager = this.eager(rec)
    if (!eager && !this.engine.near(rec.element)) return
    // The definition may have loaded since `update` (loaded(), prefetch) and turned it off.
    if (this.#off(rec)) this.#stop(rec, 'off', 'disabled')
    else if (this.engine.runtime || this.engine.loading) void this.#mount(rec)
    else if (entry.failed) this.#status(rec, 'failed', this.#loadError(rec.name))
    else if (entry.effect || !this.engine.canBoot()) this.engine.request(eager)
    else {
      // Load the definition first. It may turn the instance off, and render should start only
      // for one that stays on.
      this.engine.fetch()
      void this.registry.load(rec.name).then(() => {
        if (rec.status === 'waiting') this.update(rec)
      })
    }
  }

  async #mount(rec: InstanceRecord): Promise<void> {
    const gen = ++rec.generation
    rec.abort?.abort()
    const abort = new AbortController()
    rec.abort = abort
    this.#status(rec, 'loading')
    const [effect, runtime] = await Promise.all([this.registry.load(rec.name), this.engine.boot()])
    if (gen !== rec.generation) return
    if (!effect || !runtime) {
      if (effect) this.#status(rec, 'waiting')
      else this.#status(rec, 'failed', this.#loadError(rec.name))
      return
    }
    rec.effect = effect
    rec.values = values(this, rec)
    this.#watchAttrs(rec.element)
    if (this.#off(rec)) {
      this.#stop(rec, 'off', 'disabled')
      return
    }
    const def = effect['~definition']
    const on = def.on ?? (def.media ? MEDIA : undefined)
    // An explicit `on` does not lift `media: true`, since preparation waits for img/video events.
    const media = !def.media || rec.element.matches(MEDIA)
    if (!media || (on && !rec.element.matches(on))) {
      const target = media ? on : MEDIA
      const error = new EffectError('EFFECT_TARGET', `"${rec.name}" applies to "${target}" only`, {
        effect: rec.name,
        element: rec.element,
      })
      this.warn(`target:${rec.name}`, error)
      this.#status(rec, 'failed', error)
      return
    }
    await rec.settled
    if (gen !== rec.generation) return
    rec.values = values(this, rec)
    const attempt = runtime.mount(rec, abort.signal).catch((error: unknown) => {
      this.report(rec, error)
      return 'failed' as const
    })
    rec.settled = attempt
    const result = await attempt
    if (gen !== rec.generation || result === 'aborted') return
    this.#status(rec, result)
    if (result === 'failed') this.engine.runtime?.unmount(rec, 'failed')
  }

  /** A rejected import is reported once. Every instance of the name then fails as it loads. */
  loadFailed(name: string, error: EffectError): void {
    this.#loadErrors.set(name, error)
    this.app.report(error, targetOf(name))
  }
  #loadError(name: string): unknown {
    return this.#loadErrors.get(name)
  }

  /** `crossorigin` changed, so media failures are not final. */
  retry(element: Element): void {
    for (const rec of this.of(element)) {
      const code = (rec.error as { code?: string } | undefined)?.code
      if (rec.status !== 'failed' || (code !== 'EFFECT_CORS' && code !== 'EFFECT_MEDIA')) continue
      this.#status(rec, 'waiting')
      this.advance(rec)
    }
  }

  /** Params of loaded effects in both forms, the modes and `crossorigin`. */
  #watchAttrs(element: Element): void {
    const list = new Set<string>()
    for (const rec of this.of(element)) {
      const def = this.registry.entries.get(rec.name)?.effect?.['~definition']
      if (!def) continue
      for (const key of Object.keys(def.params ?? {})) {
        list.add(`data-dio-${kebab(key)}`).add(`data-dio-${rec.name}-${kebab(key)}`)
      }
      list.add('data-dio-load').add('data-dio-track')
      if (def.media) list.add('crossorigin')
    }
    this.dom.watch(element, [...list])
  }

  restart(rec: InstanceRecord): void {
    this.#stop(rec, 'waiting', 'restart')
    this.advance(rec)
  }

  fail(rec: InstanceRecord, error: unknown): void {
    if (rec.status === 'disposed' || rec.status === 'failed') return
    this.report(rec, error)
    this.#stop(rec, 'failed', 'failed')
  }

  /** Re-evaluates live instances after a change of engine, reduced motion or a media query. */
  refresh(name?: string): void {
    for (const rec of [...this.live]) if (!name || rec.name === name) this.update(rec)
  }

  /** The runtime is gone (render stopped). Instances wait for the next engine. */
  orphan(): void {
    for (const rec of [...this.live]) {
      if (rec.status === 'parked') this.dispose(rec, 'engine')
      else if (rec.status === 'running' || rec.status === 'loading') {
        this.#stop(rec, 'waiting', 'engine')
      }
    }
  }

  #schedule(): void {
    if (this.#sweep) return
    const sweep = (frame?: number): void => {
      let pending = false
      for (const rec of [...this.live]) {
        if (rec.status !== 'parked') continue
        if (frame === undefined || frame > rec.parkedFrame) {
          this.dispose(rec, rec.element.isConnected ? 'detached' : 'removed')
        } else pending = true
      }
      if (pending) return
      clearTimeout(this.#sweep?.timer)
      this.#sweep?.system()
      this.#sweep = undefined
    }
    this.#sweep = {
      timer: setTimeout(sweep, 100),
      system: this.app.system('afterRender', (time) => sweep(time.frame), {
        name: 'effects:sweep',
      }),
    }
  }

  destroy(): void {
    if (this.#sweep) {
      clearTimeout(this.#sweep.timer)
      this.#sweep = undefined
    }
    for (const rec of [...this.live]) this.dispose(rec, 'destroy')
  }

  /** Markup tokens of an element changed, or the element was added. */
  markup(element: Element, tokens: readonly string[]): void {
    this.#tokens.set(element, tokens)
    const names = new Set(tokens)
    for (const rec of this.#pairs.get(element)?.values() ?? []) {
      if (rec.markup && !names.has(rec.name)) {
        rec.markup = false
        this.update(rec)
      }
    }
    for (const name of names) {
      const rec = this.pair(element, name)
      if (rec.markup) continue
      rec.markup = true
      this.update(rec)
    }
  }

  /** An element entered the root. Handles that target it take it back. */
  added(element: Element): void {
    for (const h of this.#targets.get(element) ?? []) if (h.live) this.#add(element, h)
    for (const rec of this.#pairs.get(element)?.values() ?? []) {
      if (rec.status !== 'disposed') this.update(rec)
    }
  }

  #add(element: Element, h: HandleState): void {
    const rec = this.pair(element, h.name)
    if (h.records.has(rec)) return
    h.records.add(rec)
    rec.handles.add(h)
    this.update(rec)
    if (rec.status !== 'disposed') this.changed(rec, Object.keys(h.params))
  }

  #remove(rec: InstanceRecord, h: HandleState): void {
    if (!h.records.delete(rec)) return
    rec.handles.delete(h)
    this.changed(rec, [...Object.keys(h.params), ...h.writes.keys()])
    this.update(rec)
  }

  #fits(h: HandleState, el: Element): boolean {
    const inside = !h.within || (h.within !== el && h.within.contains(el))
    return inside && el.matches(h.rule as string) && this.dom.inRoot(el)
  }

  /** Re-checks selector rules in a subtree. Elements that stopped matching leave, new ones join. */
  match(root: Element): void {
    for (const h of this.rules) {
      for (const rec of [...h.records]) {
        if (root.contains(rec.element) && !this.#fits(h, rec.element)) this.#remove(rec, h)
      }
      if (this.#fits(h, root)) this.#add(root, h)
      for (const el of root.querySelectorAll(h.rule as string))
        if (this.#fits(h, el)) this.#add(el, h)
    }
  }

  attach(
    target: Target,
    use: string | Effect | EffectUse,
    params?: object,
    options?: AttachOptions,
    within?: Element,
  ): EffectHandle {
    let name: string
    let effect: Effect | undefined
    if (typeof use === 'string') name = use
    else {
      const resolved = isEffect(use) ? use() : use
      effect = resolved.effect
      name = effect.name || unnamed(effect)
      options = params as AttachOptions | undefined
      params = resolved.params
    }
    // Throws a SyntaxError on an invalid selector.
    if (typeof target === 'string') document.createDocumentFragment().querySelector(target)
    const h: HandleState = {
      id: ++this.seq,
      name,
      params: { ...params },
      writes: new Map(),
      options: { ...options },
      rule: typeof target === 'string' ? target : undefined,
      within,
      refs: [],
      records: new Set(),
      live: true,
      sync: noop,
    }
    const api = handle(this, h)
    if (effect && !this.#own(name, effect, h)) {
      h.live = false
      return api
    }
    validate(this, h)
    const signal = options?.signal
    if (signal?.aborted) {
      h.live = false
      return api
    }
    this.#handles.add(h)
    signal?.addEventListener('abort', () => this.detach(h), { once: true })
    if (typeof target === 'string') {
      this.rules.add(h)
      this.dom.rules(true)
      const found = within ? within.querySelectorAll(target) : this.dom.query(target)
      for (const el of found) if (this.#fits(h, el)) this.#add(el, h)
    } else {
      this.targets++
      for (const el of target instanceof Element ? [target] : target) {
        const set = this.#targets.get(el) ?? new Set()
        this.#targets.set(el, set.add(h))
        h.refs.push(new WeakRef(el))
        if (this.dom.inRoot(el)) this.#add(el, h)
      }
    }
    return api
  }

  /** An effect passed to `attach` takes a free name only. */
  #own(name: string, effect: Effect, h: HandleState): boolean {
    const entry = this.registry.entries.get(name)
    if (!entry) {
      this.registry.set(name, effect)
      return true
    }
    if (entry.effect === effect) return true
    const taken = (): void => {
      const message = `name "${name}" is taken by another definition; use register() to replace`
      this.app.report(
        new EffectError('EFFECT_DEFINITION', message, { effect: name }),
        targetOf(name),
      )
    }
    // A lazy entry may load this very definition, so check once it has.
    if (!entry.effect && !entry.failed && !isEffect(entry.source)) {
      void this.registry.load(name).then((loaded) => {
        if (loaded === effect || !h.live) return
        taken()
        this.detach(h)
      })
      return true
    }
    taken()
    return false
  }

  detach(h: HandleState): void {
    if (!h.live) return
    h.live = false
    this.#handles.delete(h)
    if (this.rules.delete(h)) {
      if (!this.rules.size) this.dom.rules(false)
    } else this.targets--
    for (const ref of h.refs) {
      const el = ref.deref()
      if (el) this.#targets.get(el)?.delete(h)
    }
    for (const rec of [...h.records]) this.#remove(rec, h)
  }

  disable(name: string): Off {
    this.#disabled.set(name, (this.#disabled.get(name) ?? 0) + 1)
    this.refresh(name)
    let done = false
    return () => {
      if (done) return
      done = true
      const count = (this.#disabled.get(name) ?? 1) - 1
      if (count) this.#disabled.set(name, count)
      else this.#disabled.delete(name)
      this.refresh(name)
    }
  }

  /** A definition was replaced under a key (register, HMR). Instances rebuild or retry. */
  replaced(name: string): void {
    this.#loadErrors.delete(name)
    const gone = !this.registry.entries.has(name)
    for (const rec of [...this.live]) {
      if (rec.name !== name) continue
      if (gone) {
        if (rec.status !== 'off') this.#stop(rec, 'waiting', 'disabled')
        continue
      }
      if (rec.status === 'loading') this.restart(rec)
      else if (rec.status === 'failed') this.#status(rec, 'waiting')
      else if (MOUNTED.has(rec.status)) {
        const gen = rec.generation
        void this.registry.load(name).then((effect) => {
          if (gen !== rec.generation || !MOUNTED.has(rec.status)) return
          if (!effect) {
            this.fail(rec, this.#loadError(name))
            return
          }
          rec.effect = effect
          rec.values = values(this, rec)
          this.engine.runtime?.rebuild(rec)
        })
        continue
      }
      this.update(rec)
    }
  }

  /** A definition arrived. Instances get attribute filters, handles and facades get their keys. */
  loaded(name: string): void {
    for (const h of this.#handles) {
      if (h.name !== name) continue
      validate(this, h)
      h.sync()
    }
    for (const rec of this.live) {
      if (rec.name !== name) continue
      recheck(this, rec.writes, name, rec.element)
      rec.sync()
      this.#watchAttrs(rec.element)
    }
  }

  /** Pushes changed values to the runtime as uniform writes, or as a rebuild where needed. */
  changed(rec: InstanceRecord, keys?: Iterable<string>): void {
    const runtime = this.engine.runtime
    const def = rec.effect?.['~definition']
    if (!runtime || !def || !(MOUNTED.has(rec.status) || rec.status === 'loading')) return
    const spec = def.params ?? {}
    let rebuild = false
    for (const key of keys ?? Object.keys(spec)) {
      const kind = spec[key]
      if (kind === undefined) continue
      const value = resolve(this, rec, key) as AnyParamValue
      if (same(value, rec.values[key])) continue
      rec.values[key] = value
      if (rebuilds(kind) || def.rebuild?.includes(key)) rebuild = true
      else runtime.write(rec, key, value)
    }
    if (!rebuild) return
    if (rec.status === 'loading') this.restart(rec)
    else runtime.rebuild(rec)
  }

  attributeChanged(element: Element): void {
    for (const rec of this.of(element)) this.changed(rec)
  }

  /** Settles once the near instances among these leave waiting and loading. Never rejects. */
  ready(records: readonly InstanceRecord[]): Promise<void> {
    const { engine } = this
    // An element the observer has not reported yet may be on screen, so it counts until then.
    const near = (r: InstanceRecord): boolean =>
      this.eager(r) || engine.near(r.element) || !engine.reported(r.element)
    const busy = (r: InstanceRecord): boolean =>
      r.status === 'loading' || (r.status === 'waiting' && near(r))
    const pending = records.filter((r) => busy(r) && this.registry.entries.has(r.name))
    return new Promise((resolve) => {
      const offs: Off[] = []
      let done = false
      const check = (): void => {
        // After a rejected engine import nothing advances until load() or a new intersection.
        const stuck = !engine.canBoot() || engine.status.peek() === 'unavailable'
        if (done || (!stuck && pending.some(busy))) return
        done = true
        queueMicrotask(() => {
          for (const off of offs) off()
        })
        resolve()
      }
      for (const r of pending) offs.push(r.state.subscribe(check))
      offs.push(engine.status.subscribe(check), engine.intersections.subscribe(check))
      check()
    })
  }
}
