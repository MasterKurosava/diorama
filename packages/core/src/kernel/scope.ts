import { DioramaError } from './errors'
import type { ErrorSource, Logger, Off } from './types'
import { isThenable, noop, resolved } from './util'

export type Report = (
  error: unknown,
  source: ErrorSource,
  owner: Owner | undefined,
  target?: string,
) => void

export interface OwnerEnv {
  readonly report: Report
  logFor(owner: Owner): Logger
}

export interface OwnerOptions {
  readonly env: OwnerEnv
  readonly label: string
  readonly rank: number
  readonly plugin?: string | undefined
  /** Services this owner may read. `undefined` means unrestricted. */
  readonly allowed?: ReadonlySet<string> | undefined
}

/** Tracks everything registered through it and undoes it, newest first, on dispose. */
export class Owner {
  readonly env: OwnerEnv
  readonly label: string
  readonly rank: number
  readonly plugin: string | undefined
  readonly allowed: ReadonlySet<string> | undefined
  disposed = false
  /** Set when a running setup is cut short, so its later registrations throw ABORTED. */
  abortOnAdd = false
  #ownReady: boolean | undefined
  #parent: Owner | undefined
  #unlink: (() => void) | undefined
  readonly #cleanups = new Set<() => unknown>()
  #controller: AbortController | undefined
  #done: Promise<void> | undefined
  #logger: Logger | undefined

  constructor(options: OwnerOptions) {
    this.env = options.env
    this.label = options.label
    this.rank = options.rank
    this.plugin = options.plugin
    this.allowed = options.allowed
  }

  /** Systems run only while their owner is ready. Children inherit it. */
  get ready(): boolean {
    return this.#ownReady ?? this.#parent?.ready ?? true
  }

  set ready(value: boolean) {
    this.#ownReady = value
  }

  get signal(): AbortSignal {
    if (!this.#controller) {
      this.#controller = new AbortController()
      if (this.disposed) this.#controller.abort()
    }
    return this.#controller.signal
  }

  get log(): Logger {
    this.#logger ??= this.env.logFor(this)
    return this.#logger
  }

  /**
   * Registration guard. `false` once disposed, after a warning (or ABORTED for an orphaned
   * setup). Call it before touching shared state.
   */
  open(): boolean {
    if (!this.disposed) return true
    if (this.abortOnAdd)
      throw new DioramaError('ABORTED', 'setup was aborted', { plugin: this.plugin })
    this.log.warn('registration on a closed scope ignored')
    return false
  }

  /** Registers an undo. The returned Off runs it now, once. */
  add(undo: () => unknown): Off {
    if (this.disposed) {
      // Undo first. The orphaned setup gets ABORTED, but its resource must not leak.
      this.#run(undo)
      this.open()
      return noop
    }
    this.#cleanups.add(undo)
    return () => {
      if (this.#cleanups.delete(undo)) this.#run(undo)
    }
  }

  child(options?: Partial<OwnerOptions>): Owner {
    const child = new Owner({
      env: this.env,
      label: options?.label ?? this.label,
      rank: options?.rank ?? this.rank,
      plugin: options && 'plugin' in options ? options.plugin : this.plugin,
      allowed: options && 'allowed' in options ? options.allowed : this.allowed,
    })
    child.#parent = this
    if (this.disposed) child.disposed = true
    else {
      const undo = (): Promise<void> => child.dispose()
      this.#cleanups.add(undo)
      child.#unlink = () => this.#cleanups.delete(undo)
    }
    return child
  }

  /** Aborts, then runs undos synchronously. The promise covers async undos only. */
  dispose(): Promise<void> {
    if (this.#done) return this.#done
    // Claim `#done` and empty the list before running anything, since undos may re-enter.
    let finish: (value: Promise<void>) => void = noop
    this.#done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.disposed = true
    this.#unlink?.()
    const undos = [...this.#cleanups].reverse()
    this.#cleanups.clear()
    this.#controller?.abort()
    const async = undos.map((undo) => this.#run(undo)).filter(isThenable)
    finish(async.length ? Promise.all(async).then(noop) : resolved)
    return this.#done
  }

  #run(undo: () => unknown): unknown {
    try {
      const result = undo()
      return isThenable(result)
        ? Promise.resolve(result).then(undefined, (e) => this.env.report(e, 'dispose', this))
        : undefined
    } catch (e) {
      this.env.report(e, 'dispose', this)
    }
  }
}
