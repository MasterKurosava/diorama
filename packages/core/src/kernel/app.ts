import {
  type Config,
  collectEntries,
  cycleError,
  type Entry,
  LAYER_RUNTIME,
  missingHint,
  orderPlugins,
  type PluginRecord,
  resolveEntries,
} from './config'
import { DioramaError, isDioramaError, messageOf, toDioramaError } from './errors'
import { type Depth, EventBus } from './events'
import { HookBus } from './hooks'
import { LoopImpl } from './loop'
import { definitionOf, isPreset, refName } from './plugin'
import { Owner } from './scope'
import { signal } from './signals'
import type {
  AnyPlugin,
  AppOptions,
  AppState,
  DependencyRef,
  ErrorReport,
  ErrorSource,
  Logger,
  PluginStatus,
  RemoveOptions,
  Signal,
} from './types'
import { createLogger, isThenable, noop, resolved, shallowEqual } from './util'
import {
  describe,
  isReserved,
  KERNEL,
  OWNER,
  ROOT_METHODS,
  SCOPE_METHODS,
  VIEW_PROTO,
  type View,
} from './view'

/** `setTimeout` fires at once for longer delays, so such timeouts are not set at all. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** Seconds a setup may take unless `setupTimeout` says otherwise. */
const DEFAULT_SETUP_TIMEOUT = 30

const aborted = (plugin?: string): DioramaError =>
  new DioramaError('ABORTED', 'start was aborted', { plugin })
const destroyed = (): DioramaError => new DioramaError('APP_DESTROYED', 'the app is destroyed')

/**
 * One app: its plugins, lifecycle, events, hooks and frame loop. Plugins start in dependency
 * order, each under its own owner, and stop in reverse order.
 */
export class Kernel {
  readonly name: string
  readonly state: Signal<AppState> = signal<AppState>('idle')
  readonly events: EventBus
  readonly hooks: HookBus
  readonly loop: LoopImpl
  readonly root: Owner
  readonly rootView: View
  readonly #options: AppOptions
  readonly #config: Config
  readonly #errorLog: Logger
  /** Seconds. */
  readonly #setupTimeout: number
  /** Prototype of every view: the App API plus a getter per running service. */
  readonly #viewProto: object
  readonly #scopeProto: object
  readonly #records = new Map<string, PluginRecord>()
  /** Setups that lost their race and still run. `destroy` waits for them. */
  readonly #orphanSetups = new Set<Promise<unknown>>()
  /** Cleanups of a failed start, awaited by `destroy`. */
  readonly #rollbacks: Promise<unknown>[] = []
  #starting: Promise<unknown> | undefined
  #stopping: Promise<void> | undefined
  /** Tail of the `use`/`remove` queue. */
  #operations: Promise<unknown> = resolved
  /** Aborts on `destroy`. */
  #abortController = new AbortController()
  /** A setup function is running synchronously right now. */
  #inSyncSetup = false
  #reporting = false
  #nextOrdinal = 0

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
    this.#setupTimeout =
      typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_SETUP_TIMEOUT
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
    this.loop = new LoopImpl(options.loop, report, (message) => this.root.log.warn(message))
    this.#viewProto = Object.create(VIEW_PROTO, { [KERNEL]: { value: this } })
    this.#scopeProto = Object.create(this.#viewProto, describe(SCOPE_METHODS))
    this.rootView = Object.create(Object.create(this.#viewProto, describe(ROOT_METHODS)), {
      [OWNER]: { value: this.root },
    })
  }

  view(owner: Owner, scope: boolean): View {
    return Object.create(scope ? this.#scopeProto : this.#viewProto, { [OWNER]: { value: owner } })
  }

  report(error: unknown, source: ErrorSource, owner: Owner | undefined, target?: string): void {
    const wrapped = toDioramaError(error, source, owner?.plugin)
    // A failure inside an app:error listener or onError must not recurse.
    if (this.#reporting) {
      console.error(wrapped)
      return
    }
    this.#reporting = true
    try {
      this.#errorLog.error(wrapped)
      const report: ErrorReport = {
        error: wrapped,
        source,
        plugin: owner?.plugin ?? wrapped.plugin,
        target,
      }
      this.events.emit('app:error', report)
      this.#options.onError?.(report)
    } catch (failure) {
      console.error(failure)
    } finally {
      this.#reporting = false
    }
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
    const record = this.#records.get(name)
    if (!owner.disposed && record?.status === 'running') return record.service
    if (!required) return undefined
    throw new DioramaError('SERVICE_UNAVAILABLE', this.#whyUnavailable(name, record, owner), {
      plugin: owner.plugin,
    })
  }

  #whyUnavailable(name: string, record: PluginRecord | undefined, owner: Owner): string {
    if (this.state.peek() === 'destroyed') return `"${name}": the app is destroyed`
    if (owner.disposed) return `"${name}": this view is closed`
    if (!record) return `"${name}" is not installed${missingHint(this.#config, name)}`
    return `"${name}" is ${record.status}${record.error ? `: ${record.error.message}` : ''}`
  }

  start(): Promise<unknown> {
    if (this.#starting) return this.#starting
    if (this.#stopping) return Promise.reject(destroyed())
    // The queue must exist before #run flips the state: effects on `state` may call use().
    let release: () => void = noop
    this.#operations = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#starting = this.#run()
    void this.#starting.then(release, release)
    return this.#starting
  }

  async #run(): Promise<unknown> {
    this.state.value = 'starting'
    const { signal } = this.#abortController
    try {
      const problems: DioramaError[] = []
      const entries = collectEntries(this.#config, problems)
      const { list, failures } = await resolveEntries(this.#config, entries)
      if (signal.aborted) throw aborted()
      const ordered = this.#register(list, failures, problems)
      for (const record of ordered) {
        if (signal.aborted) throw aborted()
        if (record.status === 'failed') continue
        const stopped = record.deps.find((name) => !this.has(name))
        const error =
          stopped === undefined
            ? await this.#startPlugin(record, signal)
            : this.#skip(record, stopped)
        // failFast ends the start on a plugin's own failure, not on a skipped dependent.
        if (error && (record.critical || (this.#options.failFast && stopped === undefined))) {
          return this.#fail(error)
        }
      }
      if (signal.aborted) throw aborted()
    } catch (error) {
      if (signal.aborted || this.state.peek() !== 'starting') throw error
      // An unexpected throw must not leave the app stuck in `starting`.
      const wrapped = toDioramaError(error, 'config', undefined)
      this.report(wrapped, 'config', undefined)
      return this.#fail(wrapped)
    }

    this.state.value = 'running'
    // A `state` subscriber may have destroyed the app on this very transition.
    if (this.#stopping) throw aborted()
    this.loop.attach()
    this.events.emit('app:start', undefined)
    return this.rootView
  }

  /**
   * Orders the resolved plugins and registers them. Fails the start on a fatal configuration
   * problem; other problems only fail their plugin.
   */
  #register(
    list: readonly PluginRecord[],
    failures: ReadonlyMap<PluginRecord, DioramaError>,
    problems: DioramaError[],
  ): PluginRecord[] {
    const ordered = orderPlugins(list)
    if (!Array.isArray(ordered)) problems.push(cycleError(ordered.cycle))
    // Configuration errors only cost the plugin unless it is critical or failFast is set.
    for (const [record, error] of failures) {
      if (record.critical || this.#options.failFast) problems.push(error)
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

    for (const record of ordered) {
      record.ordinal = this.#nextOrdinal++
      this.#records.set(record.name, record)
    }
    for (const [record, error] of failures) {
      record.error = error
      this.#setStatus(record, 'failed', error)
      this.report(error, 'config', undefined)
    }
    return ordered
  }

  /** Skips a plugin whose dependency is not running. The root cause is reported already. */
  #skip(record: PluginRecord, stopped: string): DioramaError {
    const error = new DioramaError(
      'PLUGIN_DEPENDENCY_FAILED',
      `dependency "${stopped}" is not running`,
      { plugin: record.name },
    )
    record.error = error
    this.root.log.warn(error.message)
    this.#setStatus(record, 'skipped', error)
    return error
  }

  /** Rolls back a start and enters `failed`. */
  #fail(error: DioramaError): never {
    for (const record of this.#live()) this.#rollbacks.push(this.#stopPlugin(record))
    this.#rollbacks.push(this.root.dispose())
    this.loop.stop()
    this.state.value = 'failed'
    throw error
  }

  /** Plugins holding a scope, latest first. */
  #live(): PluginRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.scope)
      .sort((a, b) => b.ordinal - a.ordinal)
  }

  #setStatus(record: PluginRecord, status: PluginStatus, error?: DioramaError): void {
    const previous = record.status
    record.status = status
    this.events.emit('plugin:status', { name: record.name, status, previous, error })
  }

  /** Runs one setup and returns its failure. ABORTED is thrown to the caller. */
  async #startPlugin(record: PluginRecord, signal: AbortSignal): Promise<DioramaError | undefined> {
    const scope = this.root.child({
      label: record.name,
      rank: record.ordinal,
      plugin: record.name,
      allowed: new Set([record.name, ...record.deps, ...record.optional]),
    })
    scope.ready = false
    record.scope = scope
    record.error = undefined
    this.#setStatus(record, 'starting')
    let service: unknown
    try {
      let result: unknown
      this.#inSyncSetup = true
      try {
        result = record.def.setup(this.view(scope, false), record.options)
      } finally {
        this.#inSyncSetup = false
      }
      service = isThenable(result) ? await this.#race(result, record.name, signal, scope) : result
      // The scope may have closed, or a required dependency stopped, while setup was awaiting.
      if (scope.disposed) throw aborted(record.name)
      const stopped = record.deps.find((name) => !this.has(name))
      if (stopped !== undefined) {
        throw new DioramaError(
          'PLUGIN_DEPENDENCY_FAILED',
          `dependency "${stopped}" stopped during setup`,
          { plugin: record.name },
        )
      }
    } catch (error) {
      return this.#setupFailed(record, scope, signal, error)
    }
    // Running from here on: expose the service as `app.<name>` on every view.
    record.service = service
    record.hasService = service !== undefined
    scope.ready = true
    if (record.hasService) {
      const kernel = this
      Object.defineProperty(this.#viewProto, record.name, {
        configurable: true,
        get(this: View) {
          return kernel.service(this[OWNER], record.name, false)
        },
      })
    }
    this.#setStatus(record, 'running')
    return undefined
  }

  /** Undoes a failed setup and returns its error. Rethrows ABORTED of a cancelled start. */
  #setupFailed(
    record: PluginRecord,
    scope: Owner,
    signal: AbortSignal,
    error: unknown,
  ): DioramaError {
    scope.abortOnAdd = true
    void scope.dispose()
    if (record.scope === scope) record.scope = undefined
    if (isDioramaError(error, 'ABORTED') && (signal.aborted || record.status !== 'starting')) {
      throw error
    }
    const failure =
      isDioramaError(error, 'PLUGIN_TIMEOUT') || isDioramaError(error, 'PLUGIN_DEPENDENCY_FAILED')
        ? error
        : new DioramaError('PLUGIN_SETUP', messageOf(error), { plugin: record.name, cause: error })
    record.error = failure
    this.#setStatus(record, 'failed', failure)
    this.report(failure, 'setup', scope)
    return failure
  }

  /**
   * Races a setup against the timeout, the app's abort and the plugin scope closing. The
   * losing setup keeps running as an orphan, and `destroy` waits for it, bounded by the timeout.
   */
  #race(
    setup: PromiseLike<unknown>,
    plugin: string,
    appSignal: AbortSignal,
    scope: Owner,
  ): Promise<unknown> {
    const settled = Promise.resolve(setup)
    const orphan = settled.then(noop, noop)
    this.#orphanSetups.add(orphan)
    void orphan.then(() => this.#orphanSetups.delete(orphan))
    return new Promise((resolve, reject) => {
      const signals = [appSignal, scope.signal]
      if (signals.some((s) => s.aborted)) return reject(aborted(plugin))
      const ms = this.#setupTimeout * 1000
      const timer =
        ms <= MAX_TIMER_MS
          ? setTimeout(() => {
              const message = `setup did not finish in ${this.#setupTimeout} s (awaiting use() or remove() from setup deadlocks)`
              reject(new DioramaError('PLUGIN_TIMEOUT', message, { plugin }))
            }, ms)
          : undefined
      const onAbort = (): void => reject(aborted(plugin))
      for (const s of signals) s.addEventListener('abort', onAbort, { once: true })
      const cleanup = (): void => {
        clearTimeout(timer)
        for (const s of signals) s.removeEventListener('abort', onAbort)
      }
      settled.then(
        (value) => {
          cleanup()
          resolve(value)
        },
        (error: unknown) => {
          cleanup()
          reject(error)
        },
      )
    })
  }

  #stopPlugin(record: PluginRecord): Promise<void> {
    const { scope } = record
    if (!scope) return resolved
    if (record.status === 'starting') scope.abortOnAdd = true
    this.#setStatus(record, 'stopping')
    if (record.hasService) Reflect.deleteProperty(this.#viewProto, record.name)
    record.hasService = false
    record.service = undefined
    record.scope = undefined
    record.release?.()
    record.release = undefined
    const done = scope.dispose()
    this.#setStatus(record, 'stopped')
    return done
  }

  /** Stops required dependents first (latest first), then the plugin itself. */
  #stopTree(record: PluginRecord): Promise<unknown> {
    // A stale record (replaced by a re-install) must not stop its namesake's dependents.
    if (this.#records.get(record.name) !== record) return resolved
    const dependents = this.#dependentsOf(record.name).sort((a, b) => b.ordinal - a.ordinal)
    return Promise.all([...dependents, record].map((r) => this.#stopPlugin(r)))
  }

  destroy(): Promise<void> {
    if (this.#stopping) return this.#stopping
    // Claim the promise first so a listener or cleanup calling destroy() again gets this one.
    let finish: (done: Promise<void>) => void = noop
    this.#stopping = new Promise<void>((resolve) => {
      finish = resolve
    })
    const previous = this.state.peek()
    const pending: Promise<unknown>[] = [...this.#rollbacks]
    const waiting = new Set<string>()
    if (previous !== 'idle' && previous !== 'failed') {
      this.state.value = 'destroying'
      this.#abortController.abort()
      // Services are still alive for app:destroy listeners.
      if (previous === 'running') this.events.emit('app:destroy', undefined)
      this.loop.stop()
      for (const record of this.#live()) {
        waiting.add(record.name)
        pending.push(this.#stopPlugin(record).finally(() => waiting.delete(record.name)))
      }
    }
    pending.push(this.root.dispose(), ...this.#orphanSetups)
    this.state.value = 'destroyed'
    finish(this.#settle(pending, waiting))
    return this.#stopping
  }

  /** Waits for every cleanup, or warns and gives up after the setup timeout. */
  #settle(pending: Promise<unknown>[], waiting: ReadonlySet<string>): Promise<void> {
    const all = Promise.allSettled(pending).then(noop)
    const ms = this.#setupTimeout * 1000
    if (ms > MAX_TIMER_MS) return all
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const message = `destroy: cleanups still pending after ${this.#setupTimeout} s`
        this.root.log.warn(message, [...waiting])
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
    const ownerStarting = owner.plugin && this.#records.get(owner.plugin)?.status === 'starting'
    if (this.#inSyncSetup || ownerStarting) {
      return Promise.reject(
        new DioramaError('PLUGIN_REENTRANT', 'use() and remove() cannot be called from setup', {
          plugin: owner.plugin,
        }),
      )
    }
    const run = this.#operations.then(() => {
      if (this.#stopping) throw destroyed()
      if (owner.disposed) throw aborted()
      if (this.state.peek() !== 'running') {
        throw new DioramaError('APP_STATE', 'the app did not start')
      }
      return operation()
    })
    this.#operations = run.then(noop, noop)
    return run
  }

  use(entry: unknown, owner: Owner): Promise<unknown> {
    return this.#enqueue(owner, () => this.#install(entry, owner))
  }

  async #install(entry: unknown, owner: Owner): Promise<unknown> {
    const entries = flattenPlugins(entry).map((plugin, index): Entry => {
      const def = definitionOf(plugin)
      if (!def) throw new DioramaError('PLUGIN_INVALID', `not a plugin: ${String(plugin)}`)
      return { plugin: plugin as AnyPlugin, def, layer: LAYER_RUNTIME, index }
    })
    const { list, failures } = await resolveEntries(this.#config, entries, (name) => this.has(name))
    const cancelled = (): boolean => this.#abortController.signal.aborted || owner.disposed
    if (cancelled()) throw aborted()
    for (const error of failures.values()) throw error
    const ordered = orderPlugins(list.filter((record) => this.#needsInstall(record)))
    if (!Array.isArray(ordered)) throw cycleError(ordered.cycle)

    const started: PluginRecord[] = []
    try {
      for (const record of ordered) {
        if (cancelled()) throw aborted()
        record.ordinal = this.#nextOrdinal++
        this.#records.set(record.name, record)
        // Owned before setup, so closing the owner also interrupts a running setup.
        if (owner !== this.root) {
          record.release = owner.add(() => (record.scope ? this.#stopTree(record) : undefined))
        }
        const error = await this.#startPlugin(record, this.#abortController.signal)
        if (error) throw error
        started.push(record)
      }
    } catch (error) {
      for (const record of started.reverse()) await this.#stopPlugin(record)
      // Drop owner links of records that never ran, or a later close could hit a namesake.
      for (const record of ordered) {
        record.release?.()
        record.release = undefined
      }
      throw error
    }
    return typeof entry === 'function' ? this.#records.get(entry.name)?.service : undefined
  }

  /**
   * Whether `use` must start this record. Re-installing a running plugin with the same
   * definition and options is a no-op.
   * @throws {DioramaError} `PLUGIN_DUPLICATE` when it runs with other options.
   */
  #needsInstall(record: PluginRecord): boolean {
    const running = this.#records.get(record.name)
    if (running?.status !== 'running') return true
    if (running.def === record.def && shallowEqual(running.raw, record.raw)) return false
    throw new DioramaError(
      'PLUGIN_DUPLICATE',
      `"${record.name}" is already running with other options`,
      { plugin: record.name },
    )
  }

  remove(ref: DependencyRef, options: RemoveOptions | undefined, owner: Owner): Promise<boolean> {
    return this.#enqueue(owner, async () => {
      const name = refName(ref) ?? ''
      const record = this.#records.get(name)
      if (!record) return false
      if (record.status === 'running') {
        const dependents = this.#dependentsOf(name)
        if (dependents.length && !options?.cascade) {
          const names = dependents.map((dependent) => dependent.name).join(', ')
          throw new DioramaError('PLUGIN_HAS_DEPENDENTS', `required by ${names}`, { plugin: name })
        }
        await this.#stopTree(record)
      }
      record.release?.()
      this.#records.delete(name)
      return true
    })
  }

  /** Running plugins that require `name`, directly or transitively. */
  #dependentsOf(name: string): PluginRecord[] {
    const found = new Set<PluginRecord>()
    const visit = (target: string): void => {
      for (const record of this.#records.values()) {
        if (record.status === 'running' && record.deps.includes(target) && !found.has(record)) {
          found.add(record)
          visit(record.name)
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

/** Plugins of a `use()` argument: arrays and presets are opened, falsy entries skipped. */
function flattenPlugins(entry: unknown): unknown[] {
  const plugins: unknown[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (isPreset(value)) [...value.presets, ...value.plugins].forEach(visit)
    else if (value) plugins.push(value)
  }
  visit(entry)
  return plugins
}
