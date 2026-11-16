import type { DriverLink, FrameDriver, FrameTick } from '@diorama/core'
import type { LenisLike } from './types'

declare const process: { env: Record<string, string | undefined> } | undefined
export const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

/** Longest Lenis step while frames run back to back, ms. */
const MAX_STEP = 100
const NOMINAL_STEP = 1000 / 60

type Wrapped = 'raf' | 'scrollTo' | 'destroy'
type Fn = (...args: unknown[]) => unknown
/** Lenis keeps its pending autoRaf frame here and `destroy()` cancels it. */
type RafId = { _rafId?: number | null }

/**
 * Replaces a member with an own property. Unwrapping restores the previous own property, or
 * deletes ours to uncover the prototype method. If someone wrapped on top of us, ours turns
 * transparent instead and only forwards.
 */
export function wrap(lenis: LenisLike, key: Wrapped, active: (original: Fn) => Fn): () => void {
  const target = lenis as unknown as Record<Wrapped, Fn>
  const own = Object.hasOwn(target, key)
  const previous = target[key]
  const original: Fn = (...args) => previous.apply(lenis, args)
  const behaviour = active(original)
  let transparent = false
  const wrapper: Fn = (...args) => (transparent ? original(...args) : behaviour(...args))
  target[key] = wrapper
  return () => {
    if (target[key] !== wrapper) transparent = true
    else if (own) target[key] = previous
    else delete (target as Partial<Record<Wrapped, Fn>>)[key]
  }
}

export interface PumpOwner {
  readonly warn: (code: string, message: string) => void
  readonly info: (code: string, message: string) => void
  readonly report: (error: unknown, source: string) => void
  /** Called after `lenis.destroy()`. The owner drops its source, listener and driver override. */
  readonly destroyed: () => void
}

interface Link extends DriverLink {
  requested: boolean
  readonly tick: FrameTick
}

/** Drives one Lenis as the only caller of its `raf`, ahead of the loops of every app using it. */
export interface Pump {
  /** Multiplexes loop links. The Lenis step runs first, then the loops. */
  readonly driver: FrameDriver
  readonly base: FrameDriver
  /** Live users, newest last. Warnings and reports go to the last one. */
  readonly owners: readonly PumpOwner[]
  /** `autoRaf` was on and is now held off. */
  readonly captured: boolean
}

interface PumpImpl extends Pump {
  base: FrameDriver
  owners: PumpOwner[]
  rebase(base: FrameDriver): void
  dispose(destroyed: boolean): void
}

const pumps = new WeakMap<LenisLike, PumpImpl>()

/** Tab visibility changes so far. A step across one is nominal, not the time away. */
let flips = 0
let watching = false

export const pumpOf = (lenis: LenisLike): Pump | undefined => pumps.get(lenis)

function createPump(lenis: LenisLike, initial: FrameDriver): PumpImpl {
  const links = new Set<Link>()
  let ticking = false
  let awake = false
  let continued = false
  let lastNow = 0
  let seen = flips
  let failing = false
  let absorbed = false
  let disposed = false
  let raf: Fn = () => {}

  const owner = (): PumpOwner | undefined => pump.owners.at(-1)
  const report = (error: unknown): void => {
    const to = owner()
    if (to) to.report(error, 'lenis')
    else console.error(error)
  }
  const anyRequested = (): boolean => {
    for (const l of links) if (l.requested) return true
    return false
  }
  const smoothing = (): boolean => lenis.isScrolling === 'smooth'
  const wake = (): void => {
    awake = true
    if (!ticking) pump.inner.request()
  }

  const onTick: FrameTick = (now, step) => {
    let any = false
    ticking = true
    try {
      if (step !== undefined || awake || smoothing()) {
        // One nominal step after idle, or the first wheel step would reach the target at once.
        const dt =
          step !== undefined
            ? step * 1000
            : continued && seen === flips
              ? Math.min(MAX_STEP, Math.max(0, now - lastNow))
              : NOMINAL_STEP
        // Lenis time lives in the driver's clock. Lenis reads 0 as unset.
        lenis.time = now - dt || -Number.MIN_VALUE
        try {
          raf(now)
          failing = false
        } catch (error) {
          if (!failing) report(error)
          failing = true
        }
      }
      awake = false
      for (const l of links) {
        if (step === undefined && !l.requested) continue
        l.requested = false
        try {
          if (l.tick(now, step)) any = true
        } catch (error) {
          report(error)
        }
      }
    } finally {
      ticking = false
      const again = smoothing() || anyRequested()
      if (again && !disposed) pump.inner.request()
      continued = again
      lastNow = now
      seen = flips
    }
    return any
  }

  // A hidden tab stops rAF. One listener serves all pumps and holds none of them.
  if (!watching && typeof document !== 'undefined') {
    watching = true
    document.addEventListener('visibilitychange', () => void flips++)
  }

  const pump = {
    base: initial,
    inner: initial.attach(onTick),
    owners: [] as PumpOwner[],
    captured: false,
    driver: {
      name: 'lenis',
      now: (): number => pump.base.now(),
      attach(tick: FrameTick): DriverLink {
        const link: Link = {
          tick,
          requested: false,
          request() {
            if (!links.has(link)) return
            link.requested = true
            if (!ticking) pump.inner.request()
          },
          cancel() {
            link.requested = false
            if (!ticking && !awake && !smoothing() && !anyRequested()) pump.inner.cancel()
          },
          detach() {
            links.delete(link)
            link.cancel()
          },
        }
        links.add(link)
        return link
      },
    } satisfies FrameDriver,
    rebase(base: FrameDriver): void {
      pump.inner.detach()
      pump.base = base
      pump.inner = base.attach(onTick)
      if (smoothing() || anyRequested()) pump.inner.request()
    },
    dispose(destroyed: boolean): void {
      if (disposed) return
      disposed = true
      pumps.delete(lenis)
      pump.inner.detach()
      for (const unwrap of unwraps.splice(0).reverse()) unwrap()
      if (pump.captured) {
        lenis.options.autoRaf = true
        // Resume the site's own chain where Lenis keeps it, so a `destroy()` in the same task
        // (an unmount) or a new pump (a StrictMode remount) can cancel it.
        if (!destroyed && typeof requestAnimationFrame === 'function') {
          ;(lenis as RafId)._rafId = requestAnimationFrame(lenis.raf)
        }
      }
      if (!destroyed) return
      const owners = pump.owners.splice(0)
      if (DEV)
        owners.at(-1)?.info('LENIS_DESTROYED', 'lenis.destroy(): Diorama is back on native scroll')
      for (const o of owners) o.destroyed()
    },
  }

  const unwraps = [
    wrap(lenis, 'raf', (original) => {
      raf = original
      // Foreign calls (own loop, gsap.ticker, autoRaf) never advance Lenis. It gets one step per pass.
      return () => {
        if (!absorbed && DEV) {
          absorbed = true
          owner()?.info(
            'LENIS_RAF_ABSORBED',
            'lenis.raf() calls are absorbed: Diorama advances Lenis; the line is harmless and can go',
          )
        }
        // An animation started past scrollTo still gets its steps.
        if (smoothing()) wake()
      }
    }),
    wrap(lenis, 'scrollTo', (original) => (...args) => {
      original(...args)
      wake()
    }),
    wrap(lenis, 'destroy', (original) => () => {
      original()
      pump.dispose(true)
    }),
  ]

  if (lenis.options.autoRaf === true) {
    pump.captured = true
    lenis.options.autoRaf = false
    // The frame Lenis already requested holds the original raf, not the property. Cancel it.
    const id = (lenis as RafId)._rafId
    if (id != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id)
    }
  }
  return pump as PumpImpl
}

/** Joins or creates the pump of `lenis` on the `base` driver. */
export function acquire(lenis: LenisLike, base: FrameDriver, owner: PumpOwner): Pump {
  let pump = pumps.get(lenis)
  if (!pump) {
    pump = createPump(lenis, base)
    pumps.set(lenis, pump)
  } else if (!pump.owners.length) pump.rebase(base)
  else if (pump.base !== base && !(pump.base.name === 'raf' && base.name === 'raf')) {
    // rAF drivers are interchangeable. Any other pair keeps the first app's clock.
    owner.warn(
      'LENIS_SHARED_DRIVER',
      `this Lenis is already driven by "${pump.base.name}"; "${base.name}" is not used for it`,
    )
  }
  pump.owners.push(owner)
  return pump
}

/** Leaves the pump. The last owner disposes it unless `handoff` keeps Lenis going. */
export function release(lenis: LenisLike, owner: PumpOwner, handoff: boolean): void {
  const pump = pumps.get(lenis)
  if (!pump) return
  const index = pump.owners.indexOf(owner)
  if (index >= 0) pump.owners.splice(index, 1)
  if (!pump.owners.length && !handoff) pump.dispose(false)
}
