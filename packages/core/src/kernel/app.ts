import {
  type Config,
  collectEntries,
  cycleError,
  type Entry,
  missingHint,
  orderPlugins,
  type PluginRecord,
  RESERVED,
  resolveEntries,
} from './config'
import { DioramaError, isDioramaError, messageOf, toDioramaError } from './errors'
import { type Depth, EventBus } from './events'
import { HookBus } from './hooks'
import { LoopImpl } from './loop'
import { definitionOf, isPreset, refName } from './plugin'
import { Owner } from './scope'
import { ownedEffect, signal } from './signals'
import type {
  AnyPlugin,
  AppOptions,
  AppState,
  Cleanup,
  DependencyRef,
  ErrorReport,
  ErrorSource,
  FrameDriver,
  FrameProfiler,
  Logger,
  LoopSettings,
  Off,
  OrderOptions,
  PluginStatus,
  ReadonlySignal,
  RemoveOptions,
  StagePosition,
  System,
  SystemHandle,
} from './types'
import { createLogger, isThenable, noop, resolved, shallowEqual } from './util'

const OWNER: unique symbol = Symbol('diorama.owner') as never
const KERNEL: unique symbol = Symbol('diorama.kernel') as never
const MAX_TIMER_MS = 2 ** 31 - 1

interface View {
  readonly [OWNER]: Owner
  readonly [KERNEL]: Kernel
}

const aborted = (plugin?: string): DioramaError =>
  new DioramaError('ABORTED', 'start was aborted', { plugin })
const destroyed = (): DioramaError => new DioramaError('APP_DESTROYED', 'the app is destroyed')

// Views share one prototype and reach their kernel and owner through two symbols, so a scope
// per entity stays cheap and a call allocates nothing.
const kernelOf = (view: unknown): Kernel => (view as View)[KERNEL]
const ownerOf = (view: unknown): Owner => (view as View)[OWNER]

const VIEW_METHODS = {
  use(entry: unknown): Promise<unknown> {
    return kernelOf(this).use(entry, ownerOf(this))
  },
  remove(ref: DependencyRef, options?: RemoveOptions): Promise<boolean> {
    return kernelOf(this).remove(ref, options, ownerOf(this))
  },
  has(ref: DependencyRef): boolean {
    return kernelOf(this).has(ref)
  },
  get(ref: DependencyRef): unknown {
    return kernelOf(this).service(ownerOf(this), ref, true)
  },
  find(ref: DependencyRef): unknown {
    return kernelOf(this).service(ownerOf(this), ref, false)
  },
  on(name: string, listener: (payload: unknown) => unknown): Off {
    return kernelOf(this).events.on(name, listener, ownerOf(this), false)
  },
  once(name: string, listener: (payload: unknown) => unknown): Off {
    return kernelOf(this).events.on(name, listener, ownerOf(this), true)
  },
  emit(name: string, payload?: unknown): void {
    if (!ownerOf(this).disposed) kernelOf(this).events.emit(name, payload)
  },
  hook(name: string, handler: (v: unknown, c: unknown) => unknown, options?: OrderOptions): Off {
    return kernelOf(this).hooks.add(name, handler, ownerOf(this), options)
  },
  callHook(name: string, value: unknown, context?: unknown): unknown {
    return ownerOf(this).disposed ? value : kernelOf(this).hooks.call(name, value, context)
  },
  callHookAsync(name: string, value: unknown, context?: unknown): Promise<unknown> {
    return ownerOf(this).disposed
      ? Promise.resolve(value)
      : kernelOf(this).hooks.callAsync(name, value, context)
  },
  hookVersion(name: string): number {
    return kernelOf(this).hooks.version(name)
  },
  get loop(): LoopImpl {
    return kernelOf(this).loop
  },
  system(stage: string, run: System, options?: OrderOptions): SystemHandle {
    return kernelOf(this).loop.system(stage, run, options, ownerOf(this))
  },
  addStage(name: string, position: StagePosition): Off {
    return kernelOf(this).loop.addStage(name, position, ownerOf(this))
  },
  invalidate(): void {
    const o = ownerOf(this)
    if (!o.disposed) kernelOf(this).loop.invalidate(o)
  },
  keepAwake(seconds: number): void {
    const o = ownerOf(this)
    if (!o.disposed) kernelOf(this).loop.keepAwake(o, seconds)
  },
  hold(): Off {
    return kernelOf(this).loop.hold(ownerOf(this))
  },
  pause(): Off {
    return kernelOf(this).loop.pause(ownerOf(this))
  },
  overrideLoop(settings: LoopSettings): Off {
    return kernelOf(this).loop.overrideLoop(ownerOf(this), settings)
  },
  setDriver(driver: FrameDriver): Off {
    return kernelOf(this).loop.setDriver(ownerOf(this), driver)
  },
  profile(profiler: FrameProfiler): Off {
    return kernelOf(this).loop.profile(ownerOf(this), profiler)
  },
  effect(fn: () => unknown): Off {
    const k = kernelOf(this)
    const o = ownerOf(this)
    return o.open() ? o.add(ownedEffect(fn, (e) => k.report(e, 'effect', o))) : noop
  },
  scope(): unknown {
    return kernelOf(this).view(ownerOf(this).child(), true)
  },
  onDispose(cleanup: Cleanup): Off {
    return ownerOf(this).add(typeof cleanup === 'function' ? cleanup : () => cleanup.dispose())
  },
  get abortSignal(): AbortSignal {
    return ownerOf(this).signal
  },
  get log(): Logger {
    return ownerOf(this).log
  },
  report(error: unknown, target?: string): void {
    const o = ownerOf(this)
    // An AbortError after this view's own abort is the expected outcome, not a failure.
    if ((error as { name?: unknown } | null)?.name === 'AbortError' && o.signal.aborted) return
    kernelOf(this).report(error, 'report', o, target)
  },
}

const ROOT_METHODS = {
  get name(): string {
    return kernelOf(this).name
  },
  get state(): ReadonlySignal<AppState> {
    return kernelOf(this).state
  },
  start(): Promise<unknown> {
    return kernelOf(this).start()
  },
  destroy(): Promise<void> {
    return kernelOf(this).destroy()
  },
}

const SCOPE_METHODS = {
  dispose(): Promise<void> {
    return ownerOf(this).dispose()
  },
  get disposed(): boolean {
    return ownerOf(this).disposed
  },
}

const describe = (methods: object): PropertyDescriptorMap =>
  Object.getOwnPropertyDescriptors(methods)
const VIEW_PROTO: object = Object.defineProperties({}, describe(VIEW_METHODS))

// Check the method objects, not a live view, which also carries service getters.
const isReserved = (name: string): boolean =>
  name in VIEW_PROTO ||
  name in ROOT_METHODS ||
  name in SCOPE_METHODS ||
  (RESERVED as readonly string[]).includes(name)

class Kernel {
  readonly name: string
  readonly state = signal<AppState>('idle')
  readonly events: EventBus
  readonly hooks: HookBus
  readonly loop: LoopImpl
  readonly root: Owner
  readonly rootView: View
  readonly #errorLog: Logger
  readonly #config: Config
  readonly #timeout: number
  /** Service getters, shared by every view of this app. */
  readonly #proto: object
  readonly #scopeProto: object
  readonly #records = new Map<string, PluginRecord>()
  readonly #orphans = new Set<Promise<unknown>>()
  #starting: Promise<unknown> | undefined
  #stopping: Promise<void> | undefined
  #queue: Promise<unknown> = resolved
  #abort = new AbortController()
  #inSetup = false
  #reporting = false
  #ordinal = 0
  readonly #rollback: Promise<unknown>[] = []
  readonly #options: AppOptions

  constructor(options: AppOptions, defaults: readonly AnyPlugin[]) {
    this.#options = options
    this.#config = {
      options,
      defaults,
      disabled: new Set(Array.isArray(options.disable) ? options.disable : []),
      reserved: isReserved,
    }
    this.name = options.name ?? 'app'
    const sink = options.logger ?? console
    const level = options.logLevel ?? 'warn'
    this.#errorLog = createLogger(sink, level, '')
    const timeout = options.setupTimeout
    this.#timeout = typeof timeout === 'number' && timeout > 0 ? timeout : 30
    const depth: Depth = { value: 0 }
    const report = this.report.bind(this)
    this.events = new EventBus(report, depth)
    this.hooks = new HookBus(report, depth)
    // One lazily built logger per owner. The root's is the app-wide one.
    const logFor = (owner: Owner): Logger => {
      const parts = ['diorama', options.name, owner.plugin].filter(Boolean)
      return createLogger(sink, level, `[${parts.join(':')}]`)
    }
    this.root = new Owner({ env: { report, logFor }, label: 'app', rank: Number.POSITIVE_INFINITY })
    this.loop = new LoopImpl(options.loop, report, (m) => this.root.log.warn(m))
    this.#proto = Object.create(VIEW_PROTO, { [KERNEL]: { value: this } })
    this.#scopeProto = Object.create(this.#proto, describe(SCOPE_METHODS))
    this.rootView = Object.create(Object.create(this.#proto, describe(ROOT_METHODS)), {
      [OWNER]: { value: this.root },
    })
  }

  view(owner: Owner, scope: boolean): View {
    return Object.create(scope ? this.#scopeProto : this.#proto, { [OWNER]: { value: owner } })
  }

  report(error: unknown, source: ErrorSource, owner: Owner | undefined, target?: string): void {
    const err = toDioramaError(error, source, owner?.plugin)
    // A failure inside an app:error listener or onError must not recurse.
    if (this.#reporting) {
      console.error(err)
      return
    }
    this.#reporting = true
    try {
      this.#errorLog.error(err)
      const report: ErrorReport = {
        error: err,
        source,
        plugin: owner?.plugin ?? err.plugin,
        target,
      }
      this.events.emit('app:error', report)
      this.#options.onError?.(report)
    } catch (e) {
      console.error(e)
    } finally {
      this.#reporting = false
    }
  }

  #setStatus(rec: PluginRecord, status: PluginStatus, error?: DioramaError): void {
    const previous = rec.status
    rec.status = status
    this.events.emit('plugin:status', { name: rec.name, status, previous, error })
  }

  has(ref: DependencyRef): boolean {
    return this.#records.get(refName(ref) ?? '')?.status === 'running'
  }

  service(owner: Owner, ref: DependencyRef, required: boolean): unknown {
    const name = refName(ref) ?? String(ref)
    // Plugin views see only their declared dependencies, in every build.
    if (owner.allowed && !owner.allowed.has(name)) {
      throw new DioramaError('UNDECLARED_DEPENDENCY', `"${name}" is not a declared dependency`, {
        plugin: owner.plugin,
      })
    }
    const rec = this.#records.get(name)
    if (!owner.disposed && rec?.status === 'running') return rec.service
    if (!required) return undefined
    throw new DioramaError('SERVICE_UNAVAILABLE', this.#whyUnavailable(name, rec, owner), {
      plugin: owner.plugin,
    })
  }

  #whyUnavailable(name: string, rec: PluginRecord | undefined, owner: Owner): string {
    if (this.state.peek() === 'destroyed') return `"${name}": the app is destroyed`
    if (owner.disposed) return `"${name}": this view is closed`
    if (rec) return `"${name}" is ${rec.status}${rec.error ? `: ${rec.error.message}` : ''}`
    return `"${name}" is not installed${missingHint(this.#config, name)}`
  }

  start(): Promise<unknown> {
    if (this.#starting) return this.#starting
    if (this.#stopping) return Promise.reject(destroyed())
    // The queue must exist before #run flips the state: effects on `state` may call use().
    let release: () => void = noop
    this.#queue = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#starting = this.#run()
    void this.#starting.then(release, release)
    return this.#starting
  }

  async #run(): Promise<unknown> {
    this.state.value = 'starting'
    const { signal } = this.#abort
    try {
      const problems: DioramaError[] = []
      const { list, failures } = await resolveEntries(
        this.#config,
        collectEntries(this.#config, problems),
      )
      if (signal.aborted) throw aborted()

      const ordered = orderPlugins(list)
      if (!Array.isArray(ordered)) problems.push(cycleError(ordered.cycle))
      // Configuration errors only cost the plugin unless it is critical or failFast is set.
      for (const [rec, error] of failures) {
        if (rec.critical || this.#options.failFast) problems.push(error)
      }
      if (problems.length || !Array.isArray(ordered)) {
        const error =
          problems.length === 1
            ? (problems[0] as DioramaError)
            : new DioramaError('CONFIG_INVALID', `${problems.length} configuration problems`, {
                problems,
              })
        this.report(error, 'config', undefined)
        return this.#fail(error)
      }

      for (const rec of ordered) {
        rec.ordinal = this.#ordinal++
        this.#records.set(rec.name, rec)
      }
      for (const [rec, error] of failures) {
        rec.error = error
        this.#setStatus(rec, 'failed', error)
        this.report(error, 'config', undefined)
      }

      for (const rec of ordered) {
        if (signal.aborted) throw aborted()
        if (rec.status === 'failed') continue
        const dead = rec.deps.find((d) => !this.has(d))
        let error: DioramaError | undefined
        if (dead !== undefined) {
          // The root cause is already reported, so only log and emit status.
          error = new DioramaError(
            'PLUGIN_DEPENDENCY_FAILED',
            `dependency "${dead}" is not running`,
            {
              plugin: rec.name,
            },
          )
          rec.error = error
          this.root.log.warn(error.message)
          this.#setStatus(rec, 'skipped', error)
        } else error = await this.#startPlugin(rec, signal)
        if (error && (rec.critical || (this.#options.failFast && dead === undefined))) {
          return this.#fail(error)
        }
      }
      if (signal.aborted) throw aborted()
    } catch (e) {
      if (signal.aborted || this.state.peek() !== 'starting') throw e
      // An unexpected throw must not leave the app stuck in `starting`.
      const error = toDioramaError(e, 'config', undefined)
      this.report(error, 'config', undefined)
      return this.#fail(error)
    }

    this.state.value = 'running'
    // A `state` subscriber may have destroyed the app on this very transition.
    if (this.#stopping) throw aborted()
    this.loop.attach()
    this.events.emit('app:start', undefined)
    return this.rootView
  }

  /** Rolls back a start and enters `failed`. */
  #fail(error: DioramaError): never {
    for (const rec of this.#live()) this.#rollback.push(this.#stopPlugin(rec))
    this.#rollback.push(this.root.dispose())
    this.loop.stop()
    this.state.value = 'failed'
    throw error
  }

  /** Plugins holding a scope, latest first. */
  #live(): PluginRecord[] {
    return [...this.#records.values()].filter((r) => r.scope).sort((a, b) => b.ordinal - a.ordinal)
  }

  /** Runs one setup and returns its failure. ABORTED is thrown to the caller. */
  async #startPlugin(rec: PluginRecord, signal: AbortSignal): Promise<DioramaError | undefined> {
    const scope = this.root.child({
      label: rec.name,
      rank: rec.ordinal,
      plugin: rec.name,
      allowed: new Set([rec.name, ...rec.deps, ...rec.optional]),
    })
    scope.ready = false
    rec.scope = scope
    rec.error = undefined
    this.#setStatus(rec, 'starting')
    let service: unknown
    try {
      let result: unknown
      this.#inSetup = true
      try {
        result = rec.def.setup(this.view(scope, false), rec.options)
      } finally {
        this.#inSetup = false
      }
      service = isThenable(result) ? await this.#race(result, rec.name, signal, scope) : result
      if (scope.disposed) throw aborted(rec.name)
      // A required dependency may have stopped while this setup was awaiting.
      const dead = rec.deps.find((d) => !this.has(d))
      if (dead !== undefined) {
        throw new DioramaError(
          'PLUGIN_DEPENDENCY_FAILED',
          `dependency "${dead}" stopped during setup`,
          {
            plugin: rec.name,
          },
        )
      }
    } catch (e) {
      scope.abortOnAdd = true
      void scope.dispose()
      if (rec.scope === scope) rec.scope = undefined
      if (isDioramaError(e, 'ABORTED') && (signal.aborted || rec.status !== 'starting')) throw e
      const error =
        isDioramaError(e, 'PLUGIN_TIMEOUT') || isDioramaError(e, 'PLUGIN_DEPENDENCY_FAILED')
          ? e
          : new DioramaError('PLUGIN_SETUP', messageOf(e), { plugin: rec.name, cause: e })
      rec.error = error
      this.#setStatus(rec, 'failed', error)
      this.report(error, 'setup', scope)
      return error
    }
    rec.service = service
    rec.hasService = service !== undefined
    scope.ready = true
    if (rec.hasService) {
      const kernel = this
      Object.defineProperty(this.#proto, rec.name, {
        configurable: true,
        get(this: View) {
          return kernel.service(this[OWNER], rec.name, false)
        },
      })
    }
    this.#setStatus(rec, 'running')
    return undefined
  }

  /**
   * Races a setup against the timeout, the app's abort and the plugin scope closing. The
   * losing setup keeps running as an orphan, and `destroy` waits for it, bounded by the timeout.
   */
  #race(
    setup: PromiseLike<unknown>,
    plugin: string,
    app: AbortSignal,
    scope: Owner,
  ): Promise<unknown> {
    const settled = Promise.resolve(setup)
    const orphan = settled.then(noop, noop)
    this.#orphans.add(orphan)
    void orphan.then(() => this.#orphans.delete(orphan))
    return new Promise((resolve, reject) => {
      const signals = [app, scope.signal]
      if (signals.some((s) => s.aborted)) return reject(aborted(plugin))
      const ms = this.#timeout * 1000
      const timer =
        ms <= MAX_TIMER_MS
          ? setTimeout(() => {
              const message = `setup did not finish in ${this.#timeout} s (awaiting use() or remove() from setup deadlocks)`
              reject(new DioramaError('PLUGIN_TIMEOUT', message, { plugin }))
            }, ms)
          : undefined
      const onAbort = (): void => reject(aborted(plugin))
      for (const s of signals) s.addEventListener('abort', onAbort, { once: true })
      const done = (): void => {
        clearTimeout(timer)
        for (const s of signals) s.removeEventListener('abort', onAbort)
      }
      settled.then(
        (value) => {
          done()
          resolve(value)
        },
        (error: unknown) => {
          done()
          reject(error)
        },
      )
    })
  }

  #stopPlugin(rec: PluginRecord): Promise<void> {
    const { scope } = rec
    if (!scope) return resolved
    if (rec.status === 'starting') scope.abortOnAdd = true
    this.#setStatus(rec, 'stopping')
    if (rec.hasService) Reflect.deleteProperty(this.#proto, rec.name)
    rec.hasService = false
    rec.service = undefined
    rec.scope = undefined
    rec.release?.()
    rec.release = undefined
    const done = scope.dispose()
    this.#setStatus(rec, 'stopped')
    return done
  }

  /** Stops required dependents first (latest first), then the plugin itself. */
  #stopTree(rec: PluginRecord): Promise<unknown> {
    // A stale record (replaced by a re-install) must not stop its namesake's dependents.
    if (this.#records.get(rec.name) !== rec) return resolved
    const dependents = this.#dependentsOf(rec.name).sort((a, b) => b.ordinal - a.ordinal)
    return Promise.all([...dependents, rec].map((r) => this.#stopPlugin(r)))
  }

  destroy(): Promise<void> {
    if (this.#stopping) return this.#stopping
    // Claim the promise first so a listener or cleanup calling destroy() again gets this one.
    let finish: (done: Promise<void>) => void = noop
    this.#stopping = new Promise<void>((resolve) => {
      finish = resolve
    })
    const prev = this.state.peek()
    const pending: Promise<unknown>[] = [...this.#rollback]
    const waiting = new Set<string>()
    if (prev !== 'idle' && prev !== 'failed') {
      this.state.value = 'destroying'
      this.#abort.abort()
      // Services are still alive for app:destroy listeners.
      if (prev === 'running') this.events.emit('app:destroy', undefined)
      this.loop.stop()
      for (const rec of this.#live()) {
        waiting.add(rec.name)
        pending.push(this.#stopPlugin(rec).finally(() => waiting.delete(rec.name)))
      }
    }
    pending.push(this.root.dispose(), ...this.#orphans)
    this.state.value = 'destroyed'
    finish(this.#settle(pending, waiting))
    return this.#stopping
  }

  #settle(pending: Promise<unknown>[], waiting: ReadonlySet<string>): Promise<void> {
    const all = Promise.allSettled(pending).then(noop)
    const ms = this.#timeout * 1000
    if (ms > MAX_TIMER_MS) return all
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.root.log.warn(`destroy: cleanups still pending after ${this.#timeout} s`, [...waiting])
        resolve()
      }, ms)
      void all.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Runtime operations run one at a time, after start, in call order. Calling one from a
   * running setup is rejected at once: awaiting it there would deadlock the start.
   */
  #enqueue<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
    const state = this.state.peek()
    if (state === 'destroying' || state === 'destroyed') return Promise.reject(destroyed())
    if (state === 'idle' || state === 'failed') {
      return Promise.reject(new DioramaError('APP_STATE', `the app is ${state}`))
    }
    if (this.#inSetup || (owner.plugin && this.#records.get(owner.plugin)?.status === 'starting')) {
      return Promise.reject(
        new DioramaError('PLUGIN_REENTRANT', 'use() and remove() cannot be called from setup', {
          plugin: owner.plugin,
        }),
      )
    }
    const run = this.#queue.then(() => {
      if (this.#stopping) throw destroyed()
      if (owner.disposed) throw aborted()
      if (this.state.peek() !== 'running')
        throw new DioramaError('APP_STATE', 'the app did not start')
      return operation()
    })
    this.#queue = run.then(noop, noop)
    return run
  }

  use(entry: unknown, owner: Owner): Promise<unknown> {
    return this.#enqueue(owner, () => this.#install(entry, owner))
  }

  async #install(entry: unknown, owner: Owner): Promise<unknown> {
    const plugins: unknown[] = []
    const flatten = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(flatten)
      else if (isPreset(value)) [...value.presets, ...value.plugins].forEach(flatten)
      else if (value) plugins.push(value)
    }
    flatten(entry)

    const entries = plugins.map((plugin, index): Entry => {
      const def = definitionOf(plugin)
      if (!def) throw new DioramaError('PLUGIN_INVALID', `not a plugin: ${String(plugin)}`)
      return { plugin: plugin as AnyPlugin, def, layer: 3, index }
    })
    const { list, failures } = await resolveEntries(this.#config, entries, (name) => this.has(name))
    const cancelled = (): boolean => this.#abort.signal.aborted || owner.disposed
    if (cancelled()) throw aborted()
    for (const error of failures.values()) throw error
    // Re-installing a running plugin with the same definition and options is a no-op.
    const fresh = list.filter((rec) => {
      const running = this.#records.get(rec.name)
      if (running?.status !== 'running') return true
      if (running.def === rec.def && shallowEqual(running.raw, rec.raw)) return false
      throw new DioramaError(
        'PLUGIN_DUPLICATE',
        `"${rec.name}" is already running with other options`,
        {
          plugin: rec.name,
        },
      )
    })
    const ordered = orderPlugins(fresh)
    if (!Array.isArray(ordered)) throw cycleError(ordered.cycle)

    const started: PluginRecord[] = []
    try {
      for (const rec of ordered) {
        if (cancelled()) throw aborted()
        rec.ordinal = this.#ordinal++
        this.#records.set(rec.name, rec)
        // Owned before setup, so closing the owner also interrupts a running setup.
        if (owner !== this.root) {
          rec.release = owner.add(() => (rec.scope ? this.#stopTree(rec) : undefined))
        }
        const error = await this.#startPlugin(rec, this.#abort.signal)
        if (error) throw error
        started.push(rec)
      }
    } catch (error) {
      for (const r of started.reverse()) await this.#stopPlugin(r)
      // Drop owner links of records that never ran, or a later close could hit a namesake.
      for (const r of ordered) {
        r.release?.()
        r.release = undefined
      }
      throw error
    }
    return typeof entry === 'function' ? this.#records.get(entry.name)?.service : undefined
  }

  remove(ref: DependencyRef, options: RemoveOptions | undefined, owner: Owner): Promise<boolean> {
    return this.#enqueue(owner, async () => {
      const name = refName(ref) ?? ''
      const rec = this.#records.get(name)
      if (!rec) return false
      if (rec.status === 'running') {
        const dependents = this.#dependentsOf(name)
        if (dependents.length && !options?.cascade) {
          const names = dependents.map((d) => d.name).join(', ')
          throw new DioramaError('PLUGIN_HAS_DEPENDENTS', `required by ${names}`, { plugin: name })
        }
        await this.#stopTree(rec)
      }
      rec.release?.()
      this.#records.delete(name)
      return true
    })
  }

  /** Running plugins that require `name`, directly or transitively. */
  #dependentsOf(name: string): PluginRecord[] {
    const found = new Set<PluginRecord>()
    const visit = (target: string): void => {
      for (const rec of this.#records.values()) {
        if (rec.status === 'running' && rec.deps.includes(target) && !found.has(rec)) {
          found.add(rec)
          visit(rec.name)
        }
      }
    }
    visit(name)
    return [...found]
  }
}

/** Synchronous and never throws. Plugins start on `app.start()`. */
export function createKernelApp(
  options: AppOptions | undefined,
  defaults: readonly AnyPlugin[],
): unknown {
  return new Kernel(options ?? {}, defaults).rootView
}
