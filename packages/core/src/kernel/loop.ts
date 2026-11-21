import { rafDriver } from './drivers'
import { DioramaError } from './errors'
import { labelsOf } from './hooks'
import { type Orderable, orderRefs, sortOrderables } from './order'
import type { Owner, Report } from './scope'
import type {
  DriverLink,
  FrameDriver,
  FrameMode,
  FrameProfiler,
  FrameReason,
  FrameStats,
  FrameTime,
  Loop,
  LoopOptions,
  LoopSettings,
  Off,
  OrderOptions,
  StageName,
  StagePosition,
  System,
  SystemHandle,
  SystemInfo,
} from './types'
import { isThenable, noop } from './util'

const DEFAULT_STAGES = ['input', 'layout', 'update', 'render', 'afterRender']
/** A system that throws this many frames in a row is disabled. */
const MAX_FAILURES = 10
/** Assumed frame interval, seconds, until frames measure the display. */
const DEFAULT_INTERVAL = 1 / 60
/** A gap of this many frame intervals or more is a pause, not a frame. */
const GAP_FRAMES = 3
/** How far each frame moves the measured interval toward the latest one. */
const INTERVAL_EASING = 0.1
// The measured frame rate stays within these bounds.
const MAX_MEASURED_FPS = 240
const MIN_MEASURED_FPS = 30
/** `maxFps` lets a frame through this many ms early, so a 60 fps cap keeps every 60 Hz frame. */
const FPS_SLACK_MS = 1

interface SystemRecord extends Orderable, SystemInfo {
  readonly run: System
  readonly scope: Owner
  active: boolean
  /** Its stage is gone. Kept for re-adoption, skipped by frames. */
  parked: boolean
  enabled: boolean
  /** Failures in a row. */
  failures: number
  error: unknown
}

interface Stage {
  readonly name: string
  /** Anchor of an `after` placement: later stages with the same anchor go behind it. */
  readonly afterOf: string | undefined
  systems: SystemRecord[]
}

/** Settings or a driver set by `overrideLoop` or `setDriver`. */
interface Override {
  readonly settings?: LoopSettings
  readonly driver?: FrameDriver
}

/**
 * The frame loop. In `demand` mode it sleeps until something asks for a frame, so an idle page
 * holds no timers or frame requests. Frames run the systems of every stage in order.
 */
export class LoopImpl implements Loop {
  readonly time: FrameTime
  readonly stats: FrameStats
  // Writable backing objects of `time` and `stats`, updated in place every frame.
  readonly #time = { delta: 0, rawDelta: 0, elapsed: 0, now: 0, frame: 0, resumed: true }
  readonly #stats = {
    frames: 0,
    wakes: 0,
    reason: 'none' as FrameReason | 'none',
    invalidatedBy: '',
    interval: DEFAULT_INTERVAL,
  }
  readonly #baseSettings: Required<LoopSettings>
  readonly #baseDriver: FrameDriver
  readonly #overrides: Override[] = []
  readonly #stages: Stage[] = DEFAULT_STAGES.map((name) => ({
    name,
    afterOf: undefined,
    systems: [],
  }))
  /** Systems whose stage does not exist (yet). */
  readonly #parked: SystemRecord[] = []
  readonly #warnedStages = new Set<string>()
  readonly #holds = new Set<object>()
  readonly #pauses = new Set<object>()
  // Copy-on-write and captured per frame, so changes mid-frame apply from the next one.
  #profilers: FrameProfiler[] = []
  #frameProfilers: FrameProfiler[] = []
  /** Systems of all stages in run order, rebuilt when `#runOrderStale`. */
  #runOrder: SystemRecord[] = []
  #runOrderStale = true
  #link: DriverLink | undefined
  #attached = false
  #requested = false
  #inFrame = false
  /** Something called `invalidate` since the last frame. */
  #invalidated = false
  /** The previous frame asked for the next one. */
  #continuous = false
  /** Forces a wake frame next, after a driver switch or a pause. */
  #forceWake = true
  /** Driver time until which `keepAwake` keeps frames coming. */
  #awakeUntil = 0
  /** Driver time of the last frame. */
  #lastNow: number | undefined
  /** Measured display frame interval, seconds. */
  #interval = DEFAULT_INTERVAL
  #nextSeq = 0
  readonly #report: Report

  constructor(options: LoopOptions | undefined, report: Report, warn: (message: string) => void) {
    this.#report = report
    this.time = this.#time
    this.stats = this.#stats
    this.#baseSettings = {
      mode: 'demand',
      maxDelta: 0.1,
      maxFps: 0,
      timeScale: 1,
      ...validSettings(options ?? {}, warn),
    }
    this.#baseDriver = options?.driver ?? rafDriver()
  }

  // The newest override that sets a field wins.
  #setting<K extends keyof LoopSettings>(key: K): Required<LoopSettings>[K] {
    for (let i = this.#overrides.length; i--; ) {
      const value = this.#overrides[i]?.settings?.[key]
      if (value !== undefined) return value as Required<LoopSettings>[K]
    }
    return this.#baseSettings[key]
  }

  get mode(): FrameMode {
    return this.#setting('mode')
  }
  get maxDelta(): number {
    return this.#setting('maxDelta')
  }
  get maxFps(): number {
    return this.#setting('maxFps')
  }
  get timeScale(): number {
    return this.#setting('timeScale')
  }
  get driver(): FrameDriver {
    for (let i = this.#overrides.length; i--; ) {
      const driver = this.#overrides[i]?.driver
      if (driver) return driver
    }
    return this.#baseDriver
  }
  get awake(): boolean {
    return this.#requested || this.#inFrame
  }
  get paused(): boolean {
    return this.#pauses.size > 0
  }

  overrideLoop(owner: Owner, settings: LoopSettings): Off {
    return this.#override(owner, { settings: validSettings(settings, (m) => owner.log.warn(m)) })
  }

  setDriver(owner: Owner, driver: FrameDriver): Off {
    return this.#override(owner, { driver })
  }

  #override(owner: Owner, override: Override): Off {
    if (!owner.open()) return noop
    const apply = (change: () => void): void => {
      const driver = this.driver
      const remaining = this.#awakeUntil - driver.now()
      change()
      if (this.driver !== driver) {
        // Drivers have different clocks, so carry over the remaining keepAwake time.
        this.#awakeUntil = remaining > 0 ? this.driver.now() + remaining : 0
        if (this.#attached) {
          this.#unlink()
          this.#relink()
        }
      }
      this.#schedule()
    }
    apply(() => this.#overrides.push(override))
    return owner.add(() => apply(() => removeItem(this.#overrides, override)))
  }

  profile(owner: Owner, profiler: FrameProfiler): Off {
    if (!owner.open()) return noop
    this.#profilers = [...this.#profilers, profiler]
    return owner.add(() => {
      this.#profilers = this.#profilers.filter((other) => other !== profiler)
    })
  }

  addStage(name: string, position: StagePosition, owner: Owner): Off {
    if (!owner.open()) return noop
    const plugin = owner.plugin
    if (this.#stages.some((stage) => stage.name === name)) {
      throw new DioramaError('STAGE_DUPLICATE', `stage "${name}" exists`, { plugin })
    }
    const anchor = position.before ?? position.after
    let index = this.#stages.findIndex((stage) => stage.name === anchor)
    if (index < 0) throw new DioramaError('STAGE_UNKNOWN', `no stage "${anchor}"`, { plugin })
    if (position.after !== undefined) {
      // Go past the anchor and the stages placed after it earlier.
      index++
      while (this.#stages[index]?.afterOf === anchor) index++
    }
    // Parked systems were cycle-checked when parked, so this sort always succeeds.
    const parked = this.#parked.filter((record) => record.stage === name)
    const stage: Stage = {
      name,
      afterOf: position.after,
      systems: sortOrderables(parked) as SystemRecord[],
    }
    for (const record of stage.systems) {
      removeItem(this.#parked, record)
      record.parked = false
    }
    this.#stages.splice(index, 0, stage)
    this.#runOrderStale = true
    return owner.add(() => {
      if (!removeItem(this.#stages, stage)) return
      for (const record of stage.systems) record.parked = true
      this.#parked.push(...stage.systems)
      this.#runOrderStale = true
    })
  }

  system(
    stage: string,
    run: System,
    options: OrderOptions | undefined,
    owner: Owner,
  ): SystemHandle {
    const record: SystemRecord = {
      name: options?.name ?? owner.label,
      stage: stage as StageName,
      owner: owner.label,
      scope: owner,
      run,
      labels: labelsOf(owner, options?.name),
      before: orderRefs(options?.before),
      after: orderRefs(options?.after),
      rank: owner.rank,
      seq: this.#nextSeq++,
      active: false,
      parked: false,
      enabled: true,
      failures: 0,
      error: undefined,
    }
    let off: Off = noop
    const handle = systemHandle(record, () => off())
    if (!owner.open()) return handle

    const target = this.#stages.find((s) => s.name === stage)
    const peers = target ? target.systems : this.#parked.filter((other) => other.stage === stage)
    const sorted = sortOrderables([...peers, record])
    if (!Array.isArray(sorted)) {
      const path = sorted.cycle.map((other) => other.name).join(' → ')
      throw new DioramaError('ORDER_CYCLE', `stage "${stage}": ${path}`, { plugin: owner.plugin })
    }
    if (target) target.systems = sorted
    else {
      // Systems may arrive before the plugin that adds their stage.
      record.parked = true
      this.#parked.push(record)
      if (!this.#warnedStages.has(stage)) {
        this.#warnedStages.add(stage)
        owner.log.warn(`stage "${stage}" does not exist yet; system parked`)
      }
    }
    record.active = true
    this.#runOrderStale = true
    off = owner.add(() => {
      record.active = false
      for (const s of this.#stages) s.systems = s.systems.filter((other) => other !== record)
      removeItem(this.#parked, record)
      this.#runOrderStale = true
    })
    return handle
  }

  invalidate(owner: Owner): void {
    this.#invalidated = true
    this.#stats.invalidatedBy = owner.label
    this.#schedule()
  }

  keepAwake(owner: Owner, seconds: number): void {
    if (seconds > 0) {
      this.#awakeUntil = Math.max(this.#awakeUntil, this.driver.now() + seconds * 1000)
    }
    this.invalidate(owner)
  }

  hold(owner: Owner): Off {
    if (!owner.open()) return noop
    const token = {}
    this.#holds.add(token)
    this.#schedule()
    // Releasing a hold draws one closing frame with the final state.
    return owner.add(() => this.#holds.delete(token) && this.invalidate(owner))
  }

  pause(owner: Owner): Off {
    if (!owner.open()) return noop
    const token = {}
    this.#pauses.add(token)
    if (this.#requested) {
      this.#link?.cancel()
      this.#requested = false
    }
    return owner.add(() => {
      if (this.#pauses.delete(token) && !this.#pauses.size) {
        this.#forceWake = true
        this.#schedule()
      }
    })
  }

  attach(): void {
    this.#attached = true
    this.#relink()
    this.#invalidated = true
    this.#schedule()
  }

  stop(): void {
    this.#attached = false
    this.#unlink()
  }

  /** Whether anything wants a frame now. */
  #wanted(): boolean {
    return (
      this.#invalidated ||
      this.#holds.size > 0 ||
      this.mode === 'always' ||
      (this.#awakeUntil > 0 && this.driver.now() < this.#awakeUntil)
    )
  }

  /** Requests at most one frame. An idle loop holds no timers or requests. */
  #schedule(): void {
    if (!this.#attached || this.#pauses.size || this.#requested || this.#inFrame) return
    if (this.#wanted()) this.#requestFrame()
  }

  #requestFrame(): void {
    this.#requested = true
    this.#link?.request()
  }

  #relink(): void {
    this.#link = this.driver.attach((now, step) => this.#tick(now, step))
    this.#forceWake = true
    this.#lastNow = undefined
    this.#requested = false
  }

  #unlink(): void {
    this.#link?.cancel()
    this.#link?.detach()
    this.#link = undefined
    this.#requested = false
  }

  /** Driver callback. A forced `step` (offline capture) bypasses pauses and demand checks. */
  #tick(now: number, step?: number): boolean {
    if (this.#inFrame || !this.#attached) return false
    // A non-finite timestamp counts as no time passed, so a broken clock can't poison time.
    if (!Number.isFinite(now)) now = this.#lastNow ?? 0
    this.#requested = false
    if (step === undefined) {
      if (this.#pauses.size || !this.#wanted()) {
        this.#continuous = false
        return false
      }
      // `maxFps` throttles event-driven frames too. A clock going backwards never throttles.
      const fps = this.maxFps
      const since = this.#lastNow === undefined ? Number.POSITIVE_INFINITY : now - this.#lastNow
      if (fps > 0 && !this.#forceWake && since >= 0 && since < 1000 / fps - FPS_SLACK_MS) {
        this.#requestFrame()
        return false
      }
    }
    this.#runFrame(now, step)
    return true
  }

  #runFrame(now: number, step: number | undefined): void {
    this.#stats.reason = this.#reason(step)
    this.#advanceTime(now, step)
    this.#invalidated = false

    if (this.#runOrderStale) {
      this.#runOrder.length = 0
      for (const stage of this.#stages) this.#runOrder.push(...stage.systems)
      this.#runOrderStale = false
    }
    this.#runSystems()

    this.#continuous = this.#attached && !this.#pauses.size && this.#wanted()
    if (this.#continuous) this.#requestFrame()
  }

  #advanceTime(now: number, step: number | undefined): void {
    const time = this.#time
    const stats = this.#stats
    const interval = this.#interval
    const rawDelta =
      this.#lastNow === undefined ? interval : Math.max(0, (now - this.#lastNow) / 1000)
    // A frame continues the previous one if that one requested it, or if it follows closely
    // (event-driven invalidation). Anything else is a wake frame after idle, a pause or a
    // driver switch.
    const wake =
      this.#forceWake ||
      this.#lastNow === undefined ||
      (!this.#continuous && rawDelta >= GAP_FRAMES * interval)
    this.#forceWake = false
    // Continuing frames clamp to maxDelta and track the display interval. A wake frame gets at
    // most one frame interval.
    time.delta = (step ?? Math.min(rawDelta, wake ? interval : this.maxDelta)) * this.timeScale
    if (step === undefined && !wake) this.#interval = measureInterval(interval, rawDelta)
    time.rawDelta = rawDelta
    time.elapsed += time.delta
    time.now = now
    time.frame++
    time.resumed = wake && step === undefined
    this.#lastNow = now
    stats.frames++
    if (time.resumed) stats.wakes++
    stats.interval = this.#interval
  }

  #runSystems(): void {
    this.#frameProfilers = this.#profilers
    this.#inFrame = true
    try {
      this.#profiled('frameStart', this.#time)
      // Removals during a frame apply at once through `active`, additions wait a frame.
      for (const record of this.#runOrder) {
        if (!this.#attached) break
        if (record.active && !record.parked && record.enabled && record.scope.ready) {
          this.#runSystem(record)
        }
      }
      this.#profiled('frameEnd', this.#time)
    } finally {
      this.#inFrame = false
    }
  }

  #reason(step: number | undefined): FrameReason {
    if (step !== undefined) return 'step'
    if (this.#invalidated) return 'invalidate'
    if (this.#holds.size) return 'hold'
    return this.mode === 'always' ? 'always' : 'timed'
  }

  #runSystem(record: SystemRecord): void {
    this.#profiled('systemStart', record)
    try {
      const result: unknown = record.run(this.#time)
      if (isThenable(result)) {
        result.then(undefined, noop)
        throw new Error(`system "${record.name}" returned a promise`)
      }
      record.failures = 0
    } catch (error) {
      // Report the first failure of a streak, disable after MAX_FAILURES in a row.
      if (++record.failures === 1) this.#report(error, 'system', record.scope, record.name)
      if (record.failures >= MAX_FAILURES) {
        record.enabled = false
        record.error = error
        const disabled = new DioramaError(
          'SYSTEM_DISABLED',
          `"${record.name}" failed ${MAX_FAILURES} frames in a row`,
          { plugin: record.scope.plugin, cause: error },
        )
        this.#report(disabled, 'system', record.scope, record.name)
      }
    }
    this.#profiled('systemEnd', record)
  }

  /** Calls one method of every profiler. A profiler that throws is removed and reported. */
  #profiled(method: keyof FrameProfiler, arg: FrameTime | SystemInfo): void {
    for (const profiler of this.#frameProfilers) {
      if (!this.#profilers.includes(profiler)) continue
      try {
        profiler[method](arg as never)
      } catch (error) {
        this.#profilers = this.#profilers.filter((other) => other !== profiler)
        this.#report(error, 'loop', undefined, 'profiler')
      }
    }
  }
}

/** The function handle that `app.system` returns. Calling it removes the system. */
function systemHandle(record: SystemRecord, remove: () => void): SystemHandle {
  const handle = (() => remove()) as SystemHandle
  Object.defineProperties(handle, {
    name: { value: record.name },
    enabled: {
      get: () => record.enabled,
      set: (value: boolean) => {
        record.enabled = value
        if (!value) return
        record.failures = 0
        record.error = undefined
      },
    },
    error: { get: () => record.error },
  })
  return handle
}

/** Eases the frame interval toward a measured one. */
function measureInterval(interval: number, measured: number): number {
  const plausible = measured > 0 && measured < GAP_FRAMES * interval
  const next = plausible ? interval + (measured - interval) * INTERVAL_EASING : interval
  return Math.min(Math.max(next, 1 / MAX_MEASURED_FPS), 1 / MIN_MEASURED_FPS)
}

/** Settings without invalid values. Each dropped value is warned about. */
function validSettings(settings: LoopSettings, warn: (message: string) => void): LoopSettings {
  const result: { -readonly [K in keyof LoopSettings]: LoopSettings[K] } = {}
  const { mode } = settings
  if (mode === 'demand' || mode === 'always') result.mode = mode
  else if (mode !== undefined) warn(`loop: invalid mode "${String(mode)}" ignored`)
  for (const key of ['maxDelta', 'maxFps', 'timeScale'] as const) {
    const value = settings[key]
    if (isNonNegativeNumber(value)) result[key] = value
    else if (value !== undefined) warn(`loop: invalid ${key} ignored`)
  }
  return result
}

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function removeItem<T>(list: T[], item: T): boolean {
  const index = list.indexOf(item)
  if (index >= 0) list.splice(index, 1)
  return index >= 0
}
