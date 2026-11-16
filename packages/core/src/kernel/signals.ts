// Push-pull signals. A write marks dependents as maybe stale and reads pull fresh values
// lazily. Every source has a version, so staleness is checked, never guessed.
import { DioramaError } from './errors'
import type { EffectFn, Off, ReadonlySignal, Signal, SignalOptions } from './types'
import { isThenable } from './util'

interface Observer {
  deps: Map<Source, number>
  notify(): void
}

interface Source {
  version: number
  refresh(): void
  watch(observer: Observer): void
  unwatch(observer: Observer): void
}

// Module state is empty between synchronous calls. `current` collects the running
// observer's dependencies.
let current: Map<Source, number> | undefined
let batchDepth = 0
let flushing = false
const queue: EffectNode[] = []

/** Effects that write signals they read can loop. Give up after this many flush passes. */
const MAX_PASSES = 100

/** Reports errors that must not propagate to the code that wrote the signal. */
function reportGlobal(error: unknown): void {
  const report = (globalThis as { reportError?: (e: unknown) => void }).reportError
  if (typeof report === 'function') report(error)
  else console.error(error)
}

function track(source: Source): void {
  if (current && !current.has(source)) current.set(source, source.version)
}

function flush(): void {
  if (flushing || batchDepth > 0) return
  flushing = true
  try {
    let passes = 0
    while (queue.length) {
      if (++passes > MAX_PASSES) {
        for (const e of queue) e.queued = false
        queue.length = 0
        const message = `effects did not settle after ${MAX_PASSES} passes`
        reportGlobal(new DioramaError('SIGNAL_CYCLE', message))
        break
      }
      const pass = queue.splice(0)
      for (const e of pass) {
        e.queued = false
        if (e.stale()) e.run()
      }
    }
  } finally {
    flushing = false
  }
}

// Only observed nodes hold subscriptions. Unobserved computeds keep none, so they can be
// garbage-collected, and verify their sources by version on each read instead.
function relink(observer: Observer, next: Map<Source, number>, watched: boolean): void {
  if (watched) {
    for (const source of observer.deps.keys()) if (!next.has(source)) source.unwatch(observer)
    for (const source of next.keys()) if (!observer.deps.has(source)) source.watch(observer)
  }
  observer.deps = next
}

class SignalNode<T> implements Signal<T>, Source {
  version = 0
  #targets = new Set<Observer>()
  #current: T
  readonly #equals: (a: T, b: T) => boolean

  constructor(value: T, options?: SignalOptions<T>) {
    this.#current = value
    this.#equals = options?.equals ?? Object.is
  }

  get value(): T {
    track(this)
    return this.#current
  }

  set value(next: T) {
    if (this.#equals(this.#current, next)) return
    this.#current = next
    this.version++
    for (const t of this.#targets) t.notify()
    flush()
  }

  peek(): T {
    return this.#current
  }

  subscribe(listener: (value: T) => void): Off {
    return subscribe(this, listener)
  }

  refresh(): void {}

  watch(observer: Observer): void {
    this.#targets.add(observer)
  }

  unwatch(observer: Observer): void {
    this.#targets.delete(observer)
  }
}

class ComputedNode<T> implements ReadonlySignal<T>, Source, Observer {
  version = 0
  deps: Map<Source, number> = new Map()
  #targets = new Set<Observer>()
  #current: T | undefined
  #error: unknown
  #failed = false
  #initialized = false
  #dirty = true
  #running = false
  readonly #fn: () => T
  readonly #equals: (a: T, b: T) => boolean

  constructor(fn: () => T, options?: SignalOptions<T>) {
    this.#fn = fn
    this.#equals = options?.equals ?? Object.is
  }

  get value(): T {
    this.refresh()
    track(this)
    if (this.#failed) throw this.#error
    return this.#current as T
  }

  peek(): T {
    this.refresh()
    if (this.#failed) throw this.#error
    return this.#current as T
  }

  subscribe(listener: (value: T) => void): Off {
    return subscribe(this, listener)
  }

  notify(): void {
    if (this.#dirty) return
    this.#dirty = true
    for (const t of this.#targets) t.notify()
  }

  refresh(): void {
    if (this.#running) throw new DioramaError('SIGNAL_CYCLE', 'computed depends on itself')
    if (this.#initialized && !this.#dirty && this.#targets.size > 0) return
    if (this.#initialized) {
      let changed = false
      for (const [source, seen] of this.deps) {
        source.refresh()
        if (source.version !== seen) {
          changed = true
          break
        }
      }
      if (!changed) {
        this.#dirty = false
        return
      }
    }
    this.#recompute()
  }

  #recompute(): void {
    const prev = current
    const next = new Map<Source, number>()
    current = next
    this.#running = true
    let value: T | undefined
    let error: unknown
    let failed = false
    try {
      value = this.#fn()
    } catch (e) {
      error = e
      failed = true
    } finally {
      current = prev
      this.#running = false
    }
    relink(this, next, this.#targets.size > 0)
    const changed =
      !this.#initialized ||
      failed !== this.#failed ||
      (failed ? error !== this.#error : !this.#equals(this.#current as T, value as T))
    this.#initialized = true
    this.#dirty = false
    if (changed) {
      this.#current = value
      this.#error = error
      this.#failed = failed
      this.version++
    }
  }

  watch(observer: Observer): void {
    if (this.#targets.size === 0) {
      // Sources may have changed while nobody watched. Catch up first so the new observer
      // sees a fresh version and `#dirty` keeps meaning "observers notified".
      try {
        this.refresh()
      } catch {}
      for (const source of this.deps.keys()) source.watch(this)
    }
    this.#targets.add(observer)
  }

  unwatch(observer: Observer): void {
    this.#targets.delete(observer)
    if (this.#targets.size === 0) for (const source of this.deps.keys()) source.unwatch(this)
  }
}

class EffectNode implements Observer {
  deps: Map<Source, number> = new Map()
  queued = false
  #disposed = false
  #cleanup: (() => unknown) | undefined
  readonly #fn: EffectFn
  readonly #onError: (error: unknown) => void

  constructor(fn: EffectFn, onError: (error: unknown) => void) {
    this.#fn = fn
    this.#onError = onError
  }

  notify(): void {
    if (this.queued || this.#disposed) return
    this.queued = true
    queue.push(this)
  }

  // Rerun only if a source really changed. A computed that recomputed to an equal value
  // stops propagation here, which also keeps diamonds glitch-free.
  stale(): boolean {
    if (this.#disposed) return false
    for (const [source, seen] of this.deps) {
      try {
        source.refresh()
      } catch {
        return true
      }
      if (source.version !== seen) return true
    }
    return false
  }

  run(): void {
    if (this.#disposed) return
    this.#runCleanup()
    const prev = current
    const next = new Map<Source, number>()
    current = next
    try {
      const result = this.#fn()
      if (typeof result === 'function') this.#cleanup = result as () => unknown
      else if (isThenable(result)) result.then(undefined, this.#onError)
    } catch (e) {
      this.#onError(e)
    } finally {
      current = prev
      if (this.#disposed) this.#runCleanup()
      else this.#settle(next)
    }
  }

  // Subscriptions start only after the run, so a write made during the run reached no
  // one. Compare versions now and rerun if a dependency moved under us.
  #settle(next: Map<Source, number>): void {
    relink(this, next, true)
    for (const [source, seen] of next) {
      if (source.version !== seen) {
        this.notify()
        flush()
        return
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const source of this.deps.keys()) source.unwatch(this)
    this.deps.clear()
    this.#runCleanup()
  }

  #runCleanup(): void {
    const cleanup = this.#cleanup
    this.#cleanup = undefined
    if (!cleanup) return
    const prev = current
    current = undefined
    try {
      cleanup()
    } catch (e) {
      this.#onError(e)
    } finally {
      current = prev
    }
  }
}

function subscribe<T>(node: ReadonlySignal<T>, listener: (value: T) => void): Off {
  let first = true
  const e = new EffectNode(
    () => {
      const value = node.value
      untracked(() => listener(value))
    },
    (error) => {
      if (first) throw error
      reportGlobal(error)
    },
  )
  try {
    e.run()
  } catch (error) {
    e.dispose()
    throw error
  } finally {
    first = false
  }
  return () => e.dispose()
}

export function signal<T>(value: T, options?: SignalOptions<T>): Signal<T> {
  return new SignalNode(value, options)
}

export function computed<T>(compute: () => T, options?: SignalOptions<T>): ReadonlySignal<T> {
  return new ComputedNode(compute, options)
}

/** `effect` with a custom error sink. `app.effect` reports through the app. */
export function ownedEffect(fn: EffectFn, onError: (error: unknown) => void): Off {
  const e = new EffectNode(fn, onError)
  e.run()
  return () => e.dispose()
}

export function effect(fn: EffectFn): Off {
  return ownedEffect(fn, reportGlobal)
}

export function batch<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    flush()
  }
}

export function untracked<T>(fn: () => T): T {
  const prev = current
  current = undefined
  try {
    return fn()
  } finally {
    current = prev
  }
}
