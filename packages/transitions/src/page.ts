import type { Cleanup, Off } from '@diorama/core'
import type { PageScope } from './types'

/** Scope of one page, closed when the next page replaces it. */
export class Page implements PageScope {
  readonly url: string
  readonly #abort = new AbortController()
  #cleanups: (() => unknown)[] = []

  constructor(url: string) {
    this.url = url
  }

  get signal(): AbortSignal {
    return this.#abort.signal
  }

  onDispose(cleanup: Cleanup): Off {
    const run = typeof cleanup === 'function' ? cleanup : () => cleanup.dispose()
    if (this.#abort.signal.aborted) {
      run()
      return () => {}
    }
    this.#cleanups.push(run)
    return () => {
      this.#cleanups = this.#cleanups.filter((c) => c !== run)
    }
  }

  /** Runs cleanups newest first. A failing one is reported and the rest still run. */
  close(report: (error: unknown) => void): void {
    if (this.#abort.signal.aborted) return
    this.#abort.abort()
    for (const run of this.#cleanups.splice(0).reverse()) {
      try {
        run()
      } catch (error) {
        report(error)
      }
    }
  }
}

/** Pathname only, so a `?query` or `#hash` change doesn't count as a navigation. */
export const pathOf = (url: string): string => new URL(url, location.href).pathname
