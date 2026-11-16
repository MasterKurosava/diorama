import type { Off } from '@diorama/core'
import type { Priority } from './types'

export const RANK: Readonly<Record<Priority, number>> = { low: 0, normal: 1, high: 2 }
/** Parallel decodes: createImageBitmap, glTF parsing. */
const DECODES = 2
/** Low requests at once, and only while no high one waits. */
const LOW = 2

export type Lane = 'request' | 'decode'

interface Ticket {
  readonly lane: Lane
  readonly priority: () => Priority
  readonly seq: number
  grant(): void
}

export const abortError = (): DOMException => new DOMException('aborted', 'AbortError')

/**
 * Request and decode slots. Priorities are read at every step, so a lease that raises an entry's
 * priority moves it up in its lane. Low-only work doesn't start while a pause is held.
 */
export class Queue {
  concurrency: number
  readonly #waiting: Ticket[] = []
  readonly #active: Record<Lane | 'low', number> = { request: 0, decode: 0, low: 0 }
  #pauses = 0
  #seq = 0
  /** Once stopped, every slot is granted at once and detached entries finish on their own. */
  #open = false

  constructor(concurrency: number) {
    this.concurrency = concurrency
  }

  /** Resolves with the slot's release once granted. Rejects with AbortError on abort. */
  slot(lane: Lane, priority: () => Priority, signal: AbortSignal): Promise<Off> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError())
      const abort = (): void => {
        const index = this.#waiting.indexOf(ticket)
        if (index >= 0) this.#waiting.splice(index, 1)
        reject(abortError())
      }
      const ticket: Ticket = {
        lane,
        priority,
        seq: this.#seq++,
        grant: () => {
          signal.removeEventListener('abort', abort)
          const low = lane === 'request' && priority() === 'low'
          this.#active[lane]++
          if (low) this.#active.low++
          let done = false
          resolve(() => {
            if (done) return
            done = true
            this.#active[lane]--
            if (low) this.#active.low--
            this.pump()
          })
        },
      }
      signal.addEventListener('abort', abort, { once: true })
      this.#waiting.push(ticket)
      this.pump()
    })
  }

  pause(): Off {
    this.#pauses++
    let done = false
    return () => {
      if (done) return
      done = true
      this.#pauses--
      this.pump()
    }
  }

  open(): void {
    this.#open = true
    this.pump()
  }

  /** Grants every ticket the rules allow, highest priority first, then in arrival order. */
  pump(): void {
    for (let next = this.#next(); next; next = this.#next()) {
      this.#waiting.splice(this.#waiting.indexOf(next), 1)
      next.grant()
    }
  }

  #next(): Ticket | undefined {
    const ranked = this.#waiting
      .map((ticket) => ({ ticket, priority: ticket.priority() }))
      .sort((a, b) => RANK[b.priority] - RANK[a.priority] || a.ticket.seq - b.ticket.seq)
    if (this.#open) return ranked[0]?.ticket
    const high = ranked.some((t) => t.ticket.lane === 'request' && t.priority === 'high')
    const active = this.#active
    for (const { ticket, priority } of ranked) {
      if (priority === 'low' && this.#pauses > 0) continue
      if (ticket.lane === 'decode') {
        if (active.decode < DECODES) return ticket
      } else if (active.request < this.concurrency) {
        if (priority !== 'low' || (active.low < LOW && !high)) return ticket
      }
    }
    return undefined
  }
}
