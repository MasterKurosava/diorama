import type {
  DriverLink,
  FrameDriver,
  FrameTick,
  ManualDriver,
  ManualDriverOptions,
  Off,
  OfflineDriver,
  OfflineDriverOptions,
  TickerDriverOptions,
} from './types'
import { noop, perfNow } from './util'

// One driver can serve several apps, each through its own link.

interface Link extends DriverLink {
  requested: boolean
  readonly tick: FrameTick
}

interface Links {
  readonly set: ReadonlySet<Link>
  attach(tick: FrameTick): DriverLink
  anyRequested(): boolean
  /** Ticks every requested link once. True if any drew a frame. */
  tickRequested(now: number): boolean
}

/** `onRequest` fires on every request, `onIdle` when none remain. */
function links(onRequest: () => void, onIdle: () => void): Links {
  const set = new Set<Link>()
  const anyRequested = (): boolean => {
    for (const l of set) if (l.requested) return true
    return false
  }
  const attach = (tick: FrameTick): DriverLink => {
    const link: Link = {
      tick,
      requested: false,
      request() {
        if (!set.has(link)) return
        link.requested = true
        onRequest()
      },
      cancel() {
        link.requested = false
        if (!anyRequested()) onIdle()
      },
      detach() {
        set.delete(link)
        link.cancel()
      },
    }
    set.add(link)
    return link
  }
  const tickRequested = (now: number): boolean => {
    let any = false
    for (const l of set) {
      if (!l.requested) continue
      l.requested = false
      if (l.tick(now)) any = true
    }
    return any
  }
  return { set, attach, anyRequested, tickRequested }
}

export function rafDriver(): FrameDriver {
  let handle: number | undefined
  const frame = (now: number): void => {
    handle = undefined
    state.tickRequested(now)
  }
  const state = links(
    () => {
      if (handle === undefined && typeof requestAnimationFrame === 'function') {
        handle = requestAnimationFrame(frame)
      }
    },
    () => {
      if (handle !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(handle)
        handle = undefined
      }
    },
  )
  return { name: 'raf', now: perfNow, attach: state.attach }
}

export function manualDriver(options: ManualDriverOptions = {}): ManualDriver {
  let time = options.start ?? 0
  const step = options.step ?? 1 / 60
  const state = links(noop, noop)
  const driver: ManualDriver = {
    name: 'manual',
    now: () => time,
    attach: state.attach,
    get pending() {
      return state.anyRequested()
    },
    tick(seconds = step) {
      time += seconds * 1000
      return state.tickRequested(time)
    },
    advance(seconds) {
      time += seconds * 1000
    },
    flush(limit = 1000) {
      let frames = 0
      for (let i = 0; i < limit && state.anyRequested(); i++) if (driver.tick()) frames++
      return frames
    },
  }
  return driver
}

export function offlineDriver(options: OfflineDriverOptions): OfflineDriver {
  const start = options.start ?? 0
  const fps = options.fps
  let frame = 0
  const state = links(noop, noop)
  return {
    name: 'offline',
    fps,
    get frame() {
      return frame
    },
    now: () => start + (frame * 1000) / fps,
    attach: state.attach,
    step(count = 1) {
      for (let i = 0; i < count; i++) {
        frame++
        const now = start + (frame * 1000) / fps
        for (const l of state.set) l.tick(now, 1 / fps)
      }
    },
  }
}

export function tickerDriver(
  subscribe: (tick: (now?: number) => void) => Off,
  options: TickerDriverOptions = {},
): FrameDriver {
  const now = options.now ?? perfNow
  let unsubscribe: Off | undefined
  const stop = (): void => {
    unsubscribe?.()
    unsubscribe = undefined
  }
  const onTick = (time?: number): void => {
    state.tickRequested(time ?? now())
    if (!state.anyRequested()) stop()
  }
  let subscribing = false
  const state = links(() => {
    // A ticker may tick synchronously inside subscribe. Don't subscribe twice from there.
    if (unsubscribe || subscribing) return
    subscribing = true
    try {
      unsubscribe = subscribe(onTick)
    } finally {
      subscribing = false
    }
    if (!state.anyRequested()) stop()
  }, stop)
  return { name: options.name ?? 'ticker', now, attach: state.attach }
}
