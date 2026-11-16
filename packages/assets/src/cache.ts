import { type Off, type Signal, signal } from '@diorama/core'
import type { RenderApi } from '@diorama/render'
import { AssetError, isAbort, noop } from './errors'
import { abortError, type Queue, RANK } from './queue'
import type {
  Asset,
  AssetStatus,
  CrossOrigin,
  DecoderOptions,
  Loaded,
  LoaderContext,
  LoadOptions,
  Priority,
} from './types'
import type { Item, Wave } from './wave'

/** Progress weight of work of unknown size. */
export const ESTIMATE = 100_000

export type Make = (context: LoaderContext) => Promise<Loaded<unknown>>

export interface Spec {
  readonly key: string
  readonly url: string
  readonly type: string
  readonly crossOrigin: CrossOrigin
  readonly options: Readonly<Record<string, string | number | boolean>>
  /** Resolves the loader. A lazy module may fail with ASSET_TYPE. */
  readonly make: () => Make | Promise<Make>
  /** `load()` leases see foreign errors as AssetError, `acquire()` leases see them as they are. */
  readonly wrap: boolean
  readonly weight?: number
}

export interface CacheHost {
  readonly queue: Queue
  readonly wave: Wave
  readonly retain: number
  readonly decoders: Readonly<Partial<DecoderOptions>>
  report(error: unknown, url: string): void
  transform(value: unknown, type: string, url: string): unknown
  render(signal: AbortSignal): Promise<RenderApi>
  load(url: string, options: LoadOptions): Asset<unknown>
}

interface Lease {
  readonly entry: Entry
  readonly priority: Priority
  /** Load leases report a failure, preloads and acquire don't. */
  readonly report: boolean
  readonly wrap: boolean
  readonly status: Signal<AssetStatus>
  readonly ready: Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
  released: boolean
  off?: () => void
}

class Entry implements Item {
  readonly spec: Omit<Spec, 'make'>
  /** Cleared once run, since the loader may hold its source (an <img> of a page that is gone). */
  make: Spec['make'] | undefined
  readonly leases: Set<Lease> = new Set()
  readonly abort: AbortController = new AbortController()
  state: 'loading' | 'ready' | 'failed' = 'loading'
  result: Loaded<unknown> | undefined
  value: unknown
  /** What the loader threw, and the same wrapped as AssetError. */
  cause: unknown
  error: AssetError | undefined
  bytes = 0
  total: number
  loaded = 0
  waved = false
  /** Out of the cache because the plugin stopped. Freed with its last lease. */
  detached = false
  /** Its renderer stopped (KTX2). Freed with its last lease, never retained. */
  stale = false

  constructor({ make, ...spec }: Spec) {
    this.spec = spec
    this.make = make
    this.total = spec.weight ?? ESTIMATE
  }

  priority(): Priority {
    let best: Priority = 'low'
    for (const lease of this.leases) if (RANK[lease.priority] > RANK[best]) best = lease.priority
    return best
  }
}

/** Unknown sizes weigh ESTIMATE. At 0 bytes `retain` would keep them forever. */
const estimate = (value: unknown): number => {
  const v = value as { byteLength?: number; width?: number; height?: number } | null
  return v?.byteLength || (v?.width ?? 0) * (v?.height ?? 0) * 4 || ESTIMATE
}

const failure = (lease: Lease): unknown => (lease.wrap ? lease.entry.error : lease.entry.cause)

/**
 * Entries by key with leases. An entry lives while any lease does, then it is aborted, retained
 * (LRU by bytes, no timers) or disposed once.
 */
export class Cache {
  readonly #host: CacheHost
  readonly #entries = new Map<string, Entry>()
  /** Ready entries without leases, oldest first. */
  readonly #retained = new Set<Entry>()
  /** Stale entries out of the map that still have leases. Counted until their last lease. */
  readonly #stale = new Set<Entry>()

  constructor(host: CacheHost) {
    this.#host = host
  }

  get<T, E = AssetError>(
    spec: Spec,
    priority: Priority,
    report: boolean,
    signal?: AbortSignal,
  ): Asset<T, E> {
    let entry = this.#entries.get(spec.key)
    const created = !entry
    if (!entry) {
      entry = new Entry(spec)
      this.#entries.set(spec.key, entry)
    }
    this.#retained.delete(entry)
    const lease = this.#lease(entry, priority, report, spec.wrap)
    if (created) void this.#run(entry)
    this.#changed(entry)
    const asset = this.#asset<T, E>(lease)
    if (signal?.aborted) asset.release()
    else if (signal) {
      signal.addEventListener('abort', asset.release, { once: true })
      lease.off = () => signal.removeEventListener('abort', asset.release)
    }
    return asset
  }

  release(lease: Lease): void {
    if (lease.released) return
    lease.released = true
    lease.off?.()
    const { entry } = lease
    entry.leases.delete(lease)
    if (lease.status.peek() === 'loading') {
      lease.reject(
        new AssetError('ASSET_ABORTED', 'released before ready', { url: entry.spec.url }),
      )
    }
    lease.status.value = 'released'
    if (entry.leases.size) {
      this.#changed(entry)
      return
    }
    const { retain } = this.#host
    if (entry.state === 'ready' && !entry.detached && !entry.stale && entry.bytes <= retain) {
      this.#retained.add(entry)
      let bytes = this.#bytes()
      for (const old of this.#retained) {
        if (bytes <= retain) break
        bytes -= old.bytes
        this.#drop(old)
      }
    } else this.#drop(entry)
  }

  /** Whether the key has an entry, loading, ready or retained. */
  has(key: string): boolean {
    return this.#entries.has(key)
  }

  stats(): { entries: number; used: number; retained: number; pending: number } {
    const all = [...this.#entries.values(), ...this.#stale]
    return {
      entries: all.length,
      used: all.filter((e) => e.leases.size > 0).length,
      retained: this.#bytes(),
      pending: all.filter((e) => e.state === 'loading').length,
    }
  }

  /** `render` stopped. Renderer-bound entries go at once or with their last lease. */
  rebind(): void {
    for (const entry of [...this.#entries.values()]) {
      if (!entry.result?.renderBound) continue
      if (!entry.leases.size) this.#drop(entry)
      else {
        // Take it out of the cache so a new load transcodes for the new renderer.
        entry.stale = true
        this.#entries.delete(entry.spec.key)
        this.#stale.add(entry)
      }
    }
  }

  /**
   * The plugin stops. `remove('assets')` keeps entries with leases until their last one, since an
   * effect's texture may still show the bitmap. `destroy` releases everything at once.
   */
  close(hard: boolean): void {
    this.#host.queue.open()
    for (const entry of [...this.#entries.values(), ...this.#stale]) {
      this.#entries.delete(entry.spec.key)
      entry.detached = true
      if (!entry.leases.size) this.#drop(entry)
      else if (hard) for (const lease of [...entry.leases]) this.release(lease)
    }
    this.#host.wave.close()
  }

  #bytes(): number {
    let bytes = 0
    for (const entry of this.#retained) bytes += entry.bytes
    return bytes
  }

  #drop(entry: Entry): void {
    if (this.#entries.get(entry.spec.key) === entry) this.#entries.delete(entry.spec.key)
    this.#retained.delete(entry)
    this.#stale.delete(entry)
    this.#unwave(entry)
    if (entry.state === 'loading') entry.abort.abort()
    const { result } = entry
    entry.result = entry.value = undefined
    result?.dispose?.()
  }

  /** A lease came or went. The queue re-reads priorities and low-only work leaves the wave. */
  #changed(entry: Entry): void {
    if (entry.state === 'loading' && !entry.detached) {
      if (entry.priority() !== 'low') {
        if (!entry.waved) this.#host.wave.add(entry)
        entry.waved = true
      } else this.#unwave(entry)
    }
    this.#host.queue.pump()
  }

  #unwave(entry: Entry): void {
    if (!entry.waved) return
    entry.waved = false
    this.#host.wave.done(entry)
  }

  #lease(entry: Entry, priority: Priority, report: boolean, wrap: boolean): Lease {
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const ready = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Reading `ready` is optional, so nobody awaiting it is not an unhandled rejection.
    ready.catch(noop)
    const initial =
      entry.state === 'ready' ? 'ready' : entry.state === 'failed' ? 'failed' : 'loading'
    const status = signal<AssetStatus>(initial)
    const lease: Lease = {
      entry,
      priority,
      report,
      wrap,
      status,
      ready,
      resolve,
      reject,
      released: false,
    }
    entry.leases.add(lease)
    if (entry.state === 'ready') resolve(entry.value)
    else if (entry.state === 'failed') reject(failure(lease))
    return lease
  }

  #asset<T, E>(lease: Lease): Asset<T, E> {
    const { entry } = lease
    const release = (): void => this.release(lease)
    const asset = Object.assign(release, {
      release,
      dispose: release,
      key: entry.spec.key,
      url: entry.spec.url,
      status: lease.status,
      ready: lease.ready,
    })
    return Object.defineProperties(asset, {
      value: { get: () => (lease.status.peek() === 'ready' ? entry.value : undefined) },
      error: { get: () => (lease.status.peek() === 'failed' ? failure(lease) : undefined) },
    }) as unknown as Asset<T, E>
  }

  async #run(entry: Entry): Promise<void> {
    const { spec } = entry
    const { signal } = entry.abort
    const host = this.#host
    let free: Off | undefined
    const resolve = entry.make as Spec['make']
    entry.make = undefined
    try {
      const make = await resolve()
      if (signal.aborted) throw abortError()
      free = await host.queue.slot('request', () => entry.priority(), signal)
      const result = await make(this.#context(entry, () => free?.()))
      free()
      if (signal.aborted) {
        result.dispose?.()
        return
      }
      const value = entry.detached
        ? result.value
        : host.transform(result.value, spec.type, spec.url)
      entry.result = result
      entry.value = value
      entry.bytes = result.bytes ?? estimate(value)
      entry.state = 'ready'
      this.#unwave(entry)
      for (const lease of entry.leases) {
        lease.status.value = 'ready'
        lease.resolve(value)
      }
    } catch (cause) {
      free?.()
      // Released meanwhile. Nobody waits and nothing is reported.
      if (signal.aborted || entry.leases.size === 0) return
      const error =
        cause instanceof AssetError
          ? cause
          : new AssetError(isAbort(cause) ? 'ASSET_ABORTED' : 'ASSET_PARSE', String(cause), {
              url: spec.url,
              cause,
            })
      entry.cause = cause
      entry.error = error
      entry.state = 'failed'
      this.#unwave(entry)
      const leases = [...entry.leases]
      for (const lease of leases) {
        lease.status.value = 'failed'
        lease.reject(failure(lease))
      }
      if (!entry.detached && leases.some((lease) => lease.report)) host.report(error, spec.url)
    }
  }

  #context(entry: Entry, free: () => void): LoaderContext {
    const { spec } = entry
    const { url, crossOrigin } = spec
    const { signal } = entry.abort
    const host = this.#host
    const wave = host.wave
    return {
      url,
      key: spec.key,
      get priority() {
        return entry.priority()
      },
      crossOrigin,
      options: spec.options,
      signal,
      async fetch(init) {
        const priority = entry.priority()
        let response: Response
        try {
          response = await fetch(url, {
            signal,
            priority: priority === 'normal' ? 'auto' : priority,
            credentials: crossOrigin === 'use-credentials' ? 'include' : 'same-origin',
            ...init,
          } as RequestInit)
        } catch (cause) {
          if (signal.aborted) throw abortError()
          throw new AssetError('ASSET_LOAD', `cannot fetch ${url}`, { url, cause })
        }
        if (!response.ok) {
          throw new AssetError('ASSET_LOAD', `${response.status} ${url}`, { url })
        }
        return response
      },
      async bytes(response) {
        // Content-Length counts the compressed body, so only an identity one is a usable weight.
        const length = Number(response.headers.get('content-length'))
        if (length > 0 && !response.headers.has('content-encoding')) entry.total = length
        const reader = response.body?.getReader()
        if (!reader) {
          const buffer = await response.arrayBuffer()
          entry.loaded = entry.total
          wave.changed()
          return buffer
        }
        const chunks: Uint8Array[] = []
        let size = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          size += value.byteLength
          entry.loaded = Math.min(size, entry.total)
          wave.changed()
        }
        const out = new Uint8Array(size)
        let at = 0
        for (const chunk of chunks) {
          out.set(chunk, at)
          at += chunk.byteLength
        }
        return out.buffer
      },
      async decode(work) {
        free()
        const done = await host.queue.slot('decode', () => entry.priority(), signal)
        try {
          return await work()
        } finally {
          done()
        }
      },
      // Waiting on another entry or on render is not network work. Holding the request slot
      // meanwhile, cold textures would take every slot from the pictures they wait for.
      load(dependency, options) {
        free()
        return host.load(dependency, { ...options, signal }) as never
      },
      render() {
        free()
        return host.render(signal)
      },
      decoders: host.decoders,
    }
  }
}
