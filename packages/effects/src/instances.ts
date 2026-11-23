// The controller of the light part. It keeps one record per (element, effect) pair, follows the
// sources that ask for it (markup tokens, `attach` handles, selector rules) and moves each record
// through its statuses: waiting, loading, running, parked, off, unavailable, failed, disposed.
// Params resolve in cascade.ts; the DOM side, the engine gate and the runtime sit behind ports.
import { type Off, signal } from '@dioramajs/core'
import { recheck, resolve, validate, values } from './cascade'
import { isEffect, mediaQuery } from './define'
import { EffectError, targetOf } from './errors'
import { handleFacade, instanceFacade } from './facades'
import { kebab, rebuilds } from './params'
import type {
  DomPort,
  EffectsView,
  EnginePort,
  HandleState,
  InstanceRecord,
  ReleaseReason,
} from './ports'
import type { Registry } from './registry'
import type {
  AnyParamValue,
  AttachOptions,
  Copy,
  Effect,
  EffectHandle,
  EffectInstance,
  EffectsStats,
  EffectUse,
  InstanceStatus,
  Target,
} from './types'

export type {
  AssetsPort,
  DomPort,
  EffectsView,
  EnginePort,
  HandleState,
  InstanceRecord,
  ReleaseReason,
  Runtime,
  RuntimeHost,
  Write,
} from './ports'

type TrackMode = 'live' | 'layout' | 'frame'

const MEDIA_SELECTOR = 'img, video'
const MOUNTED: ReadonlySet<InstanceStatus> = new Set(['running', 'parked'])
/** Parked instances are disposed after the next frame, or after this many ms without one. */
const SWEEP_TIMEOUT = 100

export const noop = (): void => {}

export const NO_STATS: EffectsStats = Object.freeze({
  layers: 0,
  ghosts: 0,
  copies: 0,
  instances: 0,
  textures: 0,
  bitmaps: 0,
})

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

/** An unnamed effect attached directly gets a stable generated name. */
const generatedNames = new WeakMap<Effect, string>()
let unnamedCount = 0

function nameOf(effect: Effect): string {
  if (effect.name) return effect.name
  let name = generatedNames.get(effect)
  if (!name) {
    name = `effect-${++unnamedCount}`
    generatedNames.set(effect, name)
  }
  return name
}

/** Records, their sources and the light lifecycle. */
export class Controller {
  readonly app: EffectsView
  readonly registry: Registry
  dom!: DomPort
  engine!: EnginePort
  /** Records not disposed. */
  readonly live: Set<InstanceRecord> = new Set()
  /** Handles with a selector target. */
  readonly rules: Set<HandleState> = new Set()
  /** `app.effects.pin` sources per element, newest last. */
  readonly pins: WeakMap<Element, { readonly source: () => number }[]> = new WeakMap()
  /** Live handles with element targets. While nonzero, added subtrees are searched for them. */
  targets = 0
  /** Handle ids and write order. The later of two sources wins. */
  sequence = 0
  readonly #pairs = new WeakMap<Element, Map<string, InstanceRecord>>()
  readonly #tokens = new WeakMap<Element, readonly string[]>()
  /** Handles that target each element directly. */
  readonly #targets = new WeakMap<Element, Set<HandleState>>()
  /** `disable(name)` calls not undone yet, per name. */
  readonly #disabled = new Map<string, number>()
  readonly #handles = new Set<HandleState>()
  readonly #warned = new WeakMap<object, Set<string>>()
  readonly #loadErrors = new Map<string, EffectError>()
  /** Disposes parked records once a frame has passed, or after SWEEP_TIMEOUT. */
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

  report(record: InstanceRecord, error: unknown): void {
    record.error = error
    const aborted = (error as { name?: string } | null)?.name === 'AbortError'
    if (!aborted) this.app.report(error, targetOf(record.name, record.element))
  }

  /** The record of the pair, created disposed on first use. */
  pair(element: Element, name: string): InstanceRecord {
    let pairs = this.#pairs.get(element)
    if (!pairs) {
      pairs = new Map()
      this.#pairs.set(element, pairs)
    }
    const existing = pairs.get(name)
    if (existing) return existing
    const record: InstanceRecord = {
      element,
      name,
      state: signal<InstanceStatus>('disposed'),
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
      presence: undefined,
      parkedFrame: 0,
      order: pairs.size,
      sync: noop,
    }
    ;(record as { facade: EffectInstance }).facade = instanceFacade(this, record)
    pairs.set(name, record)
    return record
  }

  find(element: Element, name: string): InstanceRecord | undefined {
    return this.#pairs.get(element)?.get(name)
  }

  /** Live instances of an element in effect order: markup tokens first, then code sources. */
  of(element: Element): InstanceRecord[] {
    const pairs = this.#pairs.get(element)
    if (!pairs) return []
    const tokens = this.#tokens.get(element) ?? []
    const rank = (record: InstanceRecord): number => {
      const index = record.markup ? tokens.indexOf(record.name) : -1
      return index < 0 ? tokens.length + record.order : index
    }
    return [...pairs.values()]
      .filter((record) => record.status !== 'disposed')
      .sort((a, b) => rank(a) - rank(b))
  }

  eager(record: InstanceRecord): boolean {
    if (record.element.getAttribute('data-dio-load') === 'eager') return true
    for (const handle of record.handles) if (handle.options.eager) return true
    return false
  }

  /** `data-dio-track`, else the latest attach option among the element's instances. */
  track(element: Element): TrackMode {
    const attribute = element.getAttribute('data-dio-track')
    if (attribute === 'layout' || attribute === 'frame') return attribute
    let track: TrackMode = 'live'
    for (const record of this.of(element)) {
      for (const handle of record.handles) track = handle.options.track ?? track
    }
    return track
  }

  /**
   * Off by name: disabled, or the entry's (else the definition's) reducedMotion or when. With a
   * record, its element's `data-dio-when` and its handles' `when` come before the entry's.
   */
  skips(
    name: string,
    effect: Effect | undefined = this.registry.entries.get(name)?.effect,
    record?: InstanceRecord,
  ): boolean {
    if (this.#disabled.has(name)) return true
    const def = effect?.['~definition']
    const motion = this.registry.reducedMotion(name) ?? def?.reducedMotion
    if (motion === 'off' && this.engine.reducedMotion()) return true
    const when =
      (record && this.#ownWhen(record)) ?? this.registry.when(name) ?? mediaQuery(def?.when)
    return when !== undefined && !this.engine.matches(when)
  }

  /** `data-dio-<name>-when`, else `data-dio-when`, else the latest attach option. */
  #ownWhen({ element, name, handles }: InstanceRecord): string | undefined {
    const attribute =
      element.getAttribute(`data-dio-${name}-when`) ?? element.getAttribute('data-dio-when')
    if (attribute?.trim()) return mediaQuery(attribute.trim())
    let when: string | undefined
    for (const handle of handles) when = mediaQuery(handle.options.when) ?? when
    return when
  }

  /** Re-evaluates a record after its sources, connection or conditions changed. */
  update(record: InstanceRecord): void {
    const connected = this.dom.inRoot(record.element)
    if (!connected || (!record.markup && record.handles.size === 0)) {
      this.#drop(record, connected)
      return
    }
    const created = record.status === 'disposed'
    if (created) {
      // Another app owns the element. Keep no source, so it can be claimed later.
      if (!this.dom.claim(record.element)) {
        this.#unlink(record)
        return
      }
      record.sync()
      this.#setStatus(record, 'waiting')
      // `data-dio-when` can turn an instance on that never loaded.
      this.#watchAttributes(record.element)
    }
    if (this.#isOff(record)) {
      this.#stop(record, 'off', 'disabled')
      return
    }
    if (this.engine.blocked === 'unavailable') {
      this.#stop(record, 'unavailable', 'engine')
      return
    }
    const { element, name } = record
    if (created && this.registry.intro(name, element) && this.engine.canBoot()) {
      this.dom.intro(element)
    }
    this.#resume(record)
  }

  /** Moves a waiting record toward running as far as the engine and the observer allow. */
  advance(record: InstanceRecord): void {
    if (record.status !== 'waiting') return
    const { engine } = this
    const entry = this.registry.entries.get(record.name)
    if (!entry) {
      if (engine.runtime) {
        const known = [...this.registry.entries.keys()].join(', ')
        const message = `unknown effect "${record.name}"; known: ${known}`
        this.warn(`unknown:${record.name}`, new EffectError('EFFECT_UNKNOWN', message))
      }
      return
    }
    const eager = this.eager(record)
    if (!eager && !engine.near(record.element)) return
    // The definition may have loaded since `update` (loaded(), prefetch) and turned it off.
    if (this.#isOff(record)) {
      this.#stop(record, 'off', 'disabled')
      return
    }
    const engineComing = !!engine.runtime || engine.loading
    if (this.registry.unresolved(record.name) && (engineComing || engine.canBoot())) {
      // The package's map first: its when or reducedMotion may turn the instance off.
      this.#fetchThenUpdate(record)
    } else if (engineComing) void this.#mount(record)
    else if (entry.failed) this.#setStatus(record, 'failed', this.#loadErrors.get(record.name))
    else if (entry.effect || !engine.canBoot()) engine.request(eager)
    // Load the definition first, once the gate is open. It may turn the instance off, and
    // render should start only for one that stays on.
    else this.#fetchThenUpdate(record)
  }

  dispose(record: InstanceRecord, reason: ReleaseReason): void {
    if (record.status === 'disposed') return
    this.#stop(record, 'disposed', reason)
    this.#unlink(record)
    record.effect = undefined
    const { element } = record
    if (this.of(element).length) {
      this.#watchAttributes(element)
      return
    }
    this.dom.release(element)
    this.dom.watch(element, [])
  }

  /** A rejected import is reported once. Every instance of the name then fails as it loads. */
  loadFailed(name: string, error: EffectError): void {
    this.#loadErrors.set(name, error)
    this.app.report(error, targetOf(name))
  }

  /** `crossorigin` changed, so media failures are not final. */
  retry(element: Element): void {
    for (const record of this.of(element)) {
      const code = (record.error as { code?: string } | undefined)?.code
      if (record.status !== 'failed' || (code !== 'EFFECT_CORS' && code !== 'EFFECT_MEDIA')) {
        continue
      }
      this.#setStatus(record, 'waiting')
      this.advance(record)
    }
  }

  restart(record: InstanceRecord): void {
    this.#stop(record, 'waiting', 'restart')
    this.advance(record)
  }

  fail(record: InstanceRecord, error: unknown): void {
    if (record.status === 'disposed' || record.status === 'failed') return
    this.report(record, error)
    this.#stop(record, 'failed', 'failed')
  }

  /** Re-evaluates live instances after a change of engine, reduced motion or a media query. */
  refresh(name?: string): void {
    for (const record of [...this.live]) if (!name || record.name === name) this.update(record)
  }

  /** The runtime is gone (render stopped). Instances wait for the next engine. */
  orphan(): void {
    for (const record of [...this.live]) {
      if (record.status === 'parked') this.dispose(record, 'engine')
      else if (record.status === 'running' || record.status === 'loading') {
        this.#stop(record, 'waiting', 'engine')
      }
    }
  }

  destroy(): void {
    if (this.#sweep) {
      clearTimeout(this.#sweep.timer)
      this.#sweep = undefined
    }
    for (const record of [...this.live]) this.dispose(record, 'destroy')
  }

  /** Markup tokens of an element changed, or the element was added. */
  markup(element: Element, tokens: readonly string[]): void {
    this.#tokens.set(element, tokens)
    const names = new Set(tokens)
    for (const record of this.#pairs.get(element)?.values() ?? []) {
      if (!record.markup || names.has(record.name)) continue
      record.markup = false
      this.update(record)
    }
    for (const name of names) {
      const record = this.pair(element, name)
      if (record.markup) continue
      record.markup = true
      this.update(record)
    }
  }

  /** An element entered the root. Handles that target it take it back. */
  added(element: Element): void {
    for (const handle of this.#targets.get(element) ?? []) {
      if (handle.live) this.#link(element, handle)
    }
    for (const record of this.#pairs.get(element)?.values() ?? []) {
      if (record.status !== 'disposed') this.update(record)
    }
  }

  /** Re-checks selector rules in a subtree. Elements that stopped matching leave, new ones join. */
  match(root: Element): void {
    for (const handle of this.rules) {
      for (const record of [...handle.records]) {
        if (root.contains(record.element) && !this.#fits(handle, record.element)) {
          this.#unlinkHandle(record, handle)
        }
      }
      if (this.#fits(handle, root)) this.#link(root, handle)
      for (const element of root.querySelectorAll(handle.rule as string)) {
        if (this.#fits(handle, element)) this.#link(element, handle)
      }
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
      // `attach(target, effect(params), options)`: the params come with the use.
      const resolved = isEffect(use) ? use() : use
      effect = resolved.effect
      name = nameOf(effect)
      options = params as AttachOptions | undefined
      params = resolved.params
    }
    // Throws a SyntaxError on an invalid selector.
    if (typeof target === 'string') document.createDocumentFragment().querySelector(target)
    const handle: HandleState = {
      id: ++this.sequence,
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
    const api = handleFacade(this, handle)
    if (effect && !this.#claimName(name, effect, handle)) {
      handle.live = false
      return api
    }
    validate(this, handle)
    const signal = options?.signal
    if (signal?.aborted) {
      handle.live = false
      return api
    }
    this.#handles.add(handle)
    signal?.addEventListener('abort', () => this.detach(handle), { once: true })
    if (typeof target === 'string') {
      // A selector rule: matches now, and later ones as the DOM changes.
      this.rules.add(handle)
      this.dom.rules(true)
      const found = within ? within.querySelectorAll(target) : this.dom.query(target)
      for (const element of found) if (this.#fits(handle, element)) this.#link(element, handle)
      return api
    }
    this.targets++
    for (const element of target instanceof Element ? [target] : target) {
      const handles = this.#targets.get(element) ?? new Set()
      this.#targets.set(element, handles.add(handle))
      handle.refs.push(new WeakRef(element))
      if (this.dom.inRoot(element)) this.#link(element, handle)
    }
    return api
  }

  detach(handle: HandleState): void {
    if (!handle.live) return
    handle.live = false
    this.#handles.delete(handle)
    if (this.rules.delete(handle)) {
      if (!this.rules.size) this.dom.rules(false)
    } else this.targets--
    for (const ref of handle.refs) {
      const element = ref.deref()
      if (element) this.#targets.get(element)?.delete(handle)
    }
    for (const record of [...handle.records]) this.#unlinkHandle(record, handle)
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
    for (const record of [...this.live]) {
      if (record.name !== name) continue
      if (gone) {
        if (record.status !== 'off') this.#stop(record, 'waiting', 'disabled')
      } else if (MOUNTED.has(record.status)) this.#reload(record)
      else {
        if (record.status === 'loading') this.restart(record)
        else if (record.status === 'failed') this.#setStatus(record, 'waiting')
        this.update(record)
      }
    }
  }

  /** A definition arrived. Instances get attribute filters, handles and facades get their keys. */
  loaded(name: string): void {
    for (const handle of this.#handles) {
      if (handle.name !== name) continue
      validate(this, handle)
      handle.sync()
    }
    for (const record of this.live) {
      if (record.name !== name) continue
      recheck(this, record.writes, name, record.element)
      record.sync()
      this.#watchAttributes(record.element)
    }
  }

  /** Pushes changed values to the runtime as uniform writes, or as a rebuild where needed. */
  changed(record: InstanceRecord, keys?: Iterable<string>): void {
    const runtime = this.engine.runtime
    const def = record.effect?.['~definition']
    const active = MOUNTED.has(record.status) || record.status === 'loading'
    if (!runtime || !def || !active) return
    const spec = def.params ?? {}
    let rebuild = false
    for (const key of keys ?? Object.keys(spec)) {
      const kind = spec[key]
      if (kind === undefined) continue
      const value = resolve(this, record, key) as AnyParamValue
      if (sameValue(value, record.values[key])) continue
      record.values[key] = value
      if (rebuilds(kind) || def.rebuild?.includes(key)) rebuild = true
      else runtime.write(record, key, value)
    }
    if (!rebuild) return
    if (record.status === 'loading') this.restart(record)
    else runtime.rebuild(record)
  }

  attributeChanged(element: Element): void {
    for (const record of this.of(element)) this.changed(record)
  }

  /** Settles once the near instances among these leave waiting and loading. Never rejects. */
  ready(records: readonly InstanceRecord[]): Promise<void> {
    const { engine } = this
    // An element the observer has not reported yet may be on screen, so it counts until then.
    const near = (record: InstanceRecord): boolean =>
      this.eager(record) || engine.near(record.element) || !engine.reported(record.element)
    const busy = (record: InstanceRecord): boolean =>
      record.status === 'loading' || (record.status === 'waiting' && near(record))
    const pending = records.filter(
      (record) => busy(record) && this.registry.entries.has(record.name),
    )
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
      for (const record of pending) offs.push(record.state.subscribe(check))
      offs.push(engine.status.subscribe(check), engine.intersections.subscribe(check))
      check()
    })
  }

  #setStatus(record: InstanceRecord, status: InstanceStatus, error?: unknown): void {
    if (error !== undefined) record.error = error
    else if (status === 'waiting' || status === 'loading') record.error = undefined
    if (record.status === status) return
    const previous = record.status
    record.status = status
    if (status === 'disposed') this.live.delete(record)
    else this.live.add(record)
    const { element } = record
    if (status === 'waiting') this.engine.watch(element, true)
    else if (
      previous === 'waiting' &&
      !this.of(element).some((other) => other.status === 'waiting')
    ) {
      this.engine.watch(element, false)
    }
    if (!MOUNTED.has(status) && !this.of(element).some((other) => MOUNTED.has(other.status))) {
      this.dom.present.delete(element)
    }
    record.state.value = status
    this.app.emit('effects:status', { element, effect: record.name, status, error: record.error })
    this.dom.sync(element)
  }

  #isOff(record: InstanceRecord): boolean {
    return this.engine.blocked === 'off' || this.skips(record.name, record.effect, record)
  }

  #resume(record: InstanceRecord): void {
    if (record.status === 'off' || record.status === 'unavailable') {
      this.#setStatus(record, 'waiting')
    }
    if (record.status === 'parked') {
      this.engine.runtime?.park(record, false, true)
      this.#setStatus(record, 'running')
      this.changed(record)
    }
    this.advance(record)
  }

  /** The record lost its sources or its element: parks a running one, disposes the rest. */
  #drop(record: InstanceRecord, connected: boolean): void {
    const { element } = record
    // The element left the document. Its copy may live on as a ghost, or a burst in the overlay
    // as an orphan, decided once for all its records.
    if (
      record.status === 'running' &&
      !element.isConnected &&
      this.engine.runtime?.handover(element)
    ) {
      for (const other of this.of(element)) this.dispose(other, 'handover')
      return
    }
    if (record.status === 'running') {
      this.engine.runtime?.park(record, true, connected)
      record.parkedFrame = this.app.loop.time.frame
      this.#setStatus(record, 'parked')
      this.#scheduleSweep()
    } else if (record.status !== 'parked' && record.status !== 'disposed') {
      this.dispose(record, connected ? 'detached' : 'removed')
    }
  }

  /** Releases what the instance holds and sets `status`, abandoning a loading attempt. */
  #stop(record: InstanceRecord, status: InstanceStatus, reason: ReleaseReason): void {
    const loading = record.status === 'loading'
    if (loading) {
      record.generation++
      record.abort?.abort()
    }
    // A mount may have resolved 'running' before its continuation ran, so unmount here too.
    if (loading || MOUNTED.has(record.status)) this.engine.runtime?.unmount(record, reason)
    this.#setStatus(record, status)
  }

  /** Drops every source of the record. */
  #unlink(record: InstanceRecord): void {
    for (const handle of record.handles) handle.records.delete(record)
    record.handles.clear()
    record.markup = false
  }

  #fetchThenUpdate(record: InstanceRecord): void {
    void this.engine.fetch([record]).then(() => {
      if (record.status === 'waiting') this.update(record)
    })
  }

  async #mount(record: InstanceRecord): Promise<void> {
    const generation = ++record.generation
    record.abort?.abort()
    const abort = new AbortController()
    record.abort = abort
    this.#setStatus(record, 'loading')
    const [effect, runtime] = await Promise.all([
      this.registry.load(record.name),
      this.engine.boot(),
    ])
    if (generation !== record.generation) return
    if (!effect || !runtime) {
      if (effect) this.#setStatus(record, 'waiting')
      else this.#setStatus(record, 'failed', this.#loadErrors.get(record.name))
      return
    }
    record.effect = effect
    record.values = values(this, record)
    record.presence = this.registry.presence(record.name)
    this.#watchAttributes(record.element)
    if (this.#isOff(record)) {
      this.#stop(record, 'off', 'disabled')
      return
    }
    const misfit = targetError(record, effect)
    if (misfit) {
      this.warn(`target:${record.name}`, misfit)
      this.#setStatus(record, 'failed', misfit)
      return
    }
    await record.settled
    if (generation !== record.generation) return
    record.values = values(this, record)
    const attempt = runtime.mount(record, abort.signal).catch((error: unknown) => {
      this.report(record, error)
      return 'failed' as const
    })
    record.settled = attempt
    const result = await attempt
    if (generation !== record.generation || result === 'aborted') return
    this.#setStatus(record, result)
    if (result === 'failed') this.engine.runtime?.unmount(record, 'failed')
  }

  /** A mounted instance takes a replaced definition with a rebuild. */
  #reload(record: InstanceRecord): void {
    const { generation, name } = record
    void this.registry.load(name).then((effect) => {
      if (generation !== record.generation || !MOUNTED.has(record.status)) return
      if (!effect) {
        this.fail(record, this.#loadErrors.get(name))
        return
      }
      record.effect = effect
      record.values = values(this, record)
      this.engine.runtime?.rebuild(record)
    })
  }

  /** Params of loaded effects in both forms, the modes and `crossorigin`. */
  #watchAttributes(element: Element): void {
    const names = new Set<string>()
    for (const record of this.of(element)) {
      names.add('data-dio-when').add(`data-dio-${record.name}-when`)
      const def = this.registry.entries.get(record.name)?.effect?.['~definition']
      if (!def) continue
      for (const key of Object.keys(def.params ?? {})) {
        names.add(`data-dio-${kebab(key)}`).add(`data-dio-${record.name}-${kebab(key)}`)
      }
      names.add('data-dio-load').add('data-dio-track')
      if (def.media) names.add('crossorigin')
    }
    this.dom.watch(element, [...names])
  }

  #scheduleSweep(): void {
    if (this.#sweep) return
    // Without a frame (`frame` undefined) every parked record goes.
    const sweep = (frame?: number): void => {
      let pending = false
      for (const record of [...this.live]) {
        if (record.status !== 'parked') continue
        if (frame === undefined || frame > record.parkedFrame) {
          this.dispose(record, record.element.isConnected ? 'detached' : 'removed')
        } else pending = true
      }
      if (pending) return
      clearTimeout(this.#sweep?.timer)
      this.#sweep?.system()
      this.#sweep = undefined
    }
    this.#sweep = {
      timer: setTimeout(sweep, SWEEP_TIMEOUT),
      system: this.app.system('afterRender', (time) => sweep(time.frame), {
        name: 'effects:sweep',
      }),
    }
  }

  /** The handle starts feeding the element's record. */
  #link(element: Element, handle: HandleState): void {
    const record = this.pair(element, handle.name)
    if (handle.records.has(record)) return
    handle.records.add(record)
    record.handles.add(handle)
    this.update(record)
    if (record.status !== 'disposed') this.changed(record, Object.keys(handle.params))
  }

  #unlinkHandle(record: InstanceRecord, handle: HandleState): void {
    if (!handle.records.delete(record)) return
    record.handles.delete(handle)
    this.changed(record, [...Object.keys(handle.params), ...handle.writes.keys()])
    this.update(record)
  }

  #fits(handle: HandleState, element: Element): boolean {
    const { within } = handle
    const inside = !within || (within !== element && within.contains(element))
    return inside && element.matches(handle.rule as string) && this.dom.inRoot(element)
  }

  /** An effect passed to `attach` takes a free name only. */
  #claimName(name: string, effect: Effect, handle: HandleState): boolean {
    const entry = this.registry.entries.get(name)
    if (!entry) {
      this.registry.set(name, effect)
      return true
    }
    if (entry.effect === effect) return true
    const taken = (): void => {
      const message = `name "${name}" is taken by another definition; use register() to replace`
      const error = new EffectError('EFFECT_DEFINITION', message, { effect: name })
      this.app.report(error, targetOf(name))
    }
    // A lazy entry may load this very definition, so check once it has.
    if (!entry.effect && !entry.failed && !isEffect(entry.source)) {
      void this.registry.load(name).then((loaded) => {
        if (loaded === effect || !handle.live) return
        taken()
        this.detach(handle)
      })
      return true
    }
    taken()
    return false
  }
}

/** Equal values, tuples compared by component. */
function sameValue(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return Object.is(a, b)
  return a.length === b.length && a.every((component, index) => component === b[index])
}

/** The definition's `on` or `media: true` excludes the element. */
function targetError(record: InstanceRecord, effect: Effect): EffectError | undefined {
  const def = effect['~definition']
  const { element, name } = record
  const on = def.on ?? (def.media === true ? MEDIA_SELECTOR : undefined)
  // An explicit `on` does not lift `media: true`, since preparation waits for img/video events.
  const media = def.media !== true || element.matches(MEDIA_SELECTOR)
  if (media && (!on || element.matches(on))) return undefined
  const target = media ? on : MEDIA_SELECTOR
  const message = `"${name}" applies to "${target}" only`
  return new EffectError('EFFECT_TARGET', message, { effect: name, element })
}
