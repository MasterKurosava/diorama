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

/** One loop's connection. A driver can serve several apps, each through its own link. */
interface Link extends DriverLink {
  requested: boolean
  readonly tick: FrameTick
}

/** The links of one driver and their frame requests. */
interface Links {
  readonly all: ReadonlySet<Link>
  attach(tick: FrameTick): DriverLink
  anyRequested(): boolean
  /** Ticks every requested link once. True if any drew a frame. */
  tickRequested(now: number): boolean
}

/** `onRequest` fires on every request, `onIdle` when none remain. */
function createLinks(onRequest: () => void, onIdle: () => void): Links {
  const all = new Set<Link>()
  const anyRequested = (): boolean => {
    for (const link of all) if (link.requested) return true
    return false
  }
  const attach = (tick: FrameTick): DriverLink => {
    const link: Link = {
      tick,
      requested: false,
      request() {
        if (!all.has(link)) return
        link.requested = true
        onRequest()
      },
      cancel() {
        link.requested = false
        if (!anyRequested()) onIdle()
      },
      detach() {
        all.delete(link)
        link.cancel()
      },
    }
    all.add(link)
    return link
  }
  const tickRequested = (now: number): boolean => {
    let ticked = false
    for (const link of all) {
      if (!link.requested) continue
      link.requested = false
      if (link.tick(now)) ticked = true
    }
    return ticked
  }
  return { all, attach, anyRequested, tickRequested }
}

/** Frames on `requestAnimationFrame`. The default driver in the browser. */
export function rafDriver(): FrameDriver {
  let handle: number | undefined
  const frame = (now: number): void => {
    handle = undefined
    links.tickRequested(now)
  }
  const links = createLinks(
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
  return { name: 'raf', now: perfNow, attach: links.attach }
}

/** A driver that frames only on `tick()` or `flush()`, for tests. */
export function manualDriver(options: ManualDriverOptions = {}): ManualDriver {
  let time = options.start ?? 0
  const step = options.step ?? 1 / 60
  const links = createLinks(noop, noop)
  const driver: ManualDriver = {
    name: 'manual',
    now: () => time,
    attach: links.attach,
    get pending() {
      return links.anyRequested()
    },
    tick(seconds = step) {
      time += seconds * 1000
      return links.tickRequested(time)
    },
    advance(seconds) {
      time += seconds * 1000
    },
    flush(limit = 1000) {
      let frames = 0
      for (let i = 0; i < limit && links.anyRequested(); i++) {
        if (driver.tick()) frames++
      }
      return frames
    },
  }
  return driver
}

/** A fixed-step driver that frames on `step()`, for video capture. */
export function offlineDriver(options: OfflineDriverOptions): OfflineDriver {
  const start = options.start ?? 0
  const fps = options.fps
  let frame = 0
  const links = createLinks(noop, noop)
  return {
    name: 'offline',
    fps,
    get frame() {
      return frame
    },
    now: () => start + (frame * 1000) / fps,
    attach: links.attach,
    // Ticks every link, requested or not: a capture frame is forced.
    step(count = 1) {
      for (let i = 0; i < count; i++) {
        frame++
        const now = start + (frame * 1000) / fps
        for (const link of links.all) link.tick(now, 1 / fps)
      }
    },
  }
}

/** A driver on an external ticker, such as `gsap.ticker`. `subscribe` returns its own Off. */
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
    links.tickRequested(time ?? now())
    if (!links.anyRequested()) stop()
  }
  let subscribing = false
  const links = createLinks(() => {
    // A ticker may tick synchronously inside subscribe. Don't subscribe twice from there.
    if (unsubscribe || subscribing) return
    subscribing = true
    try {
      unsubscribe = subscribe(onTick)
    } finally {
      subscribing = false
    }
    if (!links.anyRequested()) stop()
  }, stop)
  return { name: options.name ?? 'ticker', now, attach: links.attach }
}
