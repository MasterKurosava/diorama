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

const STAGES = ['input', 'layout', 'update', 'render', 'afterRender']
const MAX_FAILURES = 10

interface SystemRecord extends Orderable, SystemInfo {
  readonly run: System
  readonly scope: Owner
  active: boolean
  /** Its stage is gone. Kept for re-adoption, skipped by frames. */
  parked: boolean
  enabled: boolean
  failures: number
  error: unknown
}

interface Stage {
  readonly name: string
  /** Anchor of an `after` placement: later stages with the same anchor go behind it. */
  readonly afterOf: string | undefined
  systems: SystemRecord[]
}

interface Override {
  readonly settings?: LoopSettings
  readonly driver?: FrameDriver
}

/** Eases the nominal frame interval toward a measured one, kept between 30 and 240 fps. */
const trackInterval = (nominal: number, raw: number): number => {
  const next = raw > 0 && raw < 3 * nominal ? nominal + (raw - nominal) * 0.1 : nominal
  return Math.min(Math.max(next, 1 / 240), 1 / 30)
}

const isValid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export class LoopImpl implements Loop {
  readonly time: FrameTime
  readonly stats: FrameStats
  // Backing objects of `time` and `stats`, updated in place every frame.
  readonly #t = { delta: 0, rawDelta: 0, elapsed: 0, now: 0, frame: 0, resumed: true }
  readonly #s = {
    frames: 0,
    wakes: 0,
    reason: 'none' as FrameReason | 'none',
    invalidatedBy: '',
    interval: 1 / 60,
  }
  readonly #base: Required<LoopSettings>
  readonly #baseDriver: FrameDriver
  readonly #overrides: Override[] = []
  readonly #stages: Stage[] = STAGES.map((name) => ({
    name,
    afterOf: undefined,
    systems: [],
  }))
  readonly #parked: SystemRecord[] = []
  readonly #warned = new Set<string>()
  readonly #holds = new Set<object>()
  readonly #pauses = new Set<object>()
  // Copy-on-write and captured per frame, so changes mid-frame apply from the next one.
  #profilers: FrameProfiler[] = []
  #frameProfilers: FrameProfiler[] = []
  #compiled: SystemRecord[] = []
  #stale = true
  #link: DriverLink | undefined
  #attached = false
  #requested = false
  #inFrame = false
  #dirty = false
  /** The previous frame asked for the next one. */
  #continuous = false
  /** Forces a wake frame next, after a driver switch or a pause. */
  #wake = true
  #awakeUntil = 0
  #last: number | undefined
  #nominal = 1 / 60
  #seq = 0
  readonly #report: Report

  constructor(options: LoopOptions | undefined, report: Report, warn: (message: string) => void) {
    this.#report = report
    this.time = this.#t
    this.stats = this.#s
    this.#base = {
      mode: 'demand',
      maxDelta: 0.1,
      maxFps: 0,
      timeScale: 1,
      ...clean(options ?? {}, warn),
    }
    this.#baseDriver = options?.driver ?? rafDriver()
  }

  // The newest override that sets a field wins.
  #setting<K extends keyof LoopSettings>(key: K): Required<LoopSettings>[K] {
    for (let i = this.#overrides.length; i--; ) {
      const value = this.#overrides[i]?.settings?.[key]
      if (value !== undefined) return value as Required<LoopSettings>[K]
    }
    return this.#base[key]
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
    return this.#override(owner, { settings: clean(settings, (m) => owner.log.warn(m)) })
  }

  setDriver(owner: Owner, driver: FrameDriver): Off {
    return this.#override(owner, { driver })
  }

  #override(owner: Owner, entry: Override): Off {
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
    apply(() => this.#overrides.push(entry))
    return owner.add(() => apply(() => remove(this.#overrides, entry)))
  }

  profile(owner: Owner, profiler: FrameProfiler): Off {
    if (!owner.open()) return noop
    this.#profilers = [...this.#profilers, profiler]
    return owner.add(() => {
      this.#profilers = this.#profilers.filter((p) => p !== profiler)
    })
  }

  addStage(name: string, position: StagePosition, owner: Owner): Off {
    if (!owner.open()) return noop
    const plugin = owner.plugin
    if (this.#stages.some((s) => s.name === name)) {
      throw new DioramaError('STAGE_DUPLICATE', `stage "${name}" exists`, { plugin })
    }
    const anchor = position.before ?? position.after
    let index = this.#stages.findIndex((s) => s.name === anchor)
    if (index < 0) throw new DioramaError('STAGE_UNKNOWN', `no stage "${anchor}"`, { plugin })
    if (position.after !== undefined) while (this.#stages[++index]?.afterOf === anchor);
    // Parked systems were cycle-checked when parked, so this sort always succeeds.
    const stage: Stage = {
      name,
      afterOf: position.after,
      systems: sortOrderables(this.#parked.filter((r) => r.stage === name)) as SystemRecord[],
    }
    for (const r of stage.systems) {
      remove(this.#parked, r)
      r.parked = false
    }
    this.#stages.splice(index, 0, stage)
    this.#stale = true
    return owner.add(() => {
      if (!remove(this.#stages, stage)) return
      for (const r of stage.systems) r.parked = true
      this.#parked.push(...stage.systems)
      this.#stale = true
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
      seq: this.#seq++,
      active: false,
      parked: false,
      enabled: true,
      failures: 0,
      error: undefined,
    }
    let off: Off = noop
    const handle = (() => off()) as SystemHandle
    Object.defineProperties(handle, {
      name: { value: record.name },
      enabled: {
        get: () => record.enabled,
        set: (value: boolean) => {
          record.enabled = value
          if (value) {
            record.failures = 0
            record.error = undefined
          }
        },
      },
      error: { get: () => record.error },
    })
    if (!owner.open()) return handle

    const target = this.#stages.find((s) => s.name === stage)
    const peers = target ? target.systems : this.#parked.filter((r) => r.stage === stage)
    const sorted = sortOrderables([...peers, record])
    if (!Array.isArray(sorted)) {
      const path = sorted.cycle.map((r) => r.name).join(' → ')
      throw new DioramaError('ORDER_CYCLE', `stage "${stage}": ${path}`, { plugin: owner.plugin })
    }
    if (target) target.systems = sorted
    else {
      // Systems may arrive before the plugin that adds their stage.
      record.parked = true
      this.#parked.push(record)
      if (!this.#warned.has(stage)) {
        this.#warned.add(stage)
        owner.log.warn(`stage "${stage}" does not exist yet; system parked`)
      }
    }
    record.active = true
    this.#stale = true
    off = owner.add(() => {
      record.active = false
      for (const s of this.#stages) s.systems = s.systems.filter((r) => r !== record)
      remove(this.#parked, record)
      this.#stale = true
    })
    return handle
  }

  invalidate(owner: Owner): void {
    this.#dirty = true
    this.#s.invalidatedBy = owner.label
    this.#schedule()
  }

  keepAwake(owner: Owner, seconds: number): void {
    if (seconds > 0)
      this.#awakeUntil = Math.max(this.#awakeUntil, this.driver.now() + seconds * 1000)
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
        this.#wake = true
        this.#schedule()
      }
    })
  }

  attach(): void {
    this.#attached = true
    this.#relink()
    this.#dirty = true
    this.#schedule()
  }

  stop(): void {
    this.#attached = false
    this.#unlink()
  }

  #wanted(): boolean {
    return (
      this.#dirty ||
      this.#holds.size > 0 ||
      this.mode === 'always' ||
      (this.#awakeUntil > 0 && this.driver.now() < this.#awakeUntil)
    )
  }

  /** Requests at most one frame. An idle loop holds no timers or requests. */
  #schedule(): void {
    if (!this.#attached || this.#pauses.size || this.#requested || this.#inFrame || !this.#wanted())
      return
    this.#requested = true
    this.#link?.request()
  }

  #relink(): void {
    this.#link = this.driver.attach((now, step) => this.#tick(now, step))
    this.#wake = true
    this.#last = undefined
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
    if (!Number.isFinite(now)) now = this.#last ?? 0
    this.#requested = false
    if (step === undefined) {
      if (this.#pauses.size || !this.#wanted()) {
        this.#continuous = false
        return false
      }
      const fps = this.maxFps
      const since = this.#last === undefined ? Number.POSITIVE_INFINITY : now - this.#last
      // Throttles event-driven frames too. The 1 ms slack keeps a 60 fps cap from skipping
      // frames on a 60 Hz display. A clock going backwards never throttles.
      if (fps > 0 && !this.#wake && since >= 0 && since < 1000 / fps - 1) {
        this.#requested = true
        this.#link?.request()
        return false
      }
    }
    this.#frame(now, step)
    return true
  }

  #frame(now: number, step: number | undefined): void {
    const t = this.#t
    const s = this.#s
    s.reason = this.#reason(step)

    // A frame continues the previous one if that one requested it, or if it follows closely
    // (event-driven invalidation). Anything else is a wake frame after idle, a pause or a
    // driver switch.
    const raw = this.#last === undefined ? this.#nominal : Math.max(0, (now - this.#last) / 1000)
    const wake =
      this.#wake || this.#last === undefined || (!this.#continuous && raw >= 3 * this.#nominal)
    this.#wake = false
    // Continuing frames clamp to maxDelta and track the display interval. A wake frame gets at
    // most one nominal frame.
    t.delta = (step ?? Math.min(raw, wake ? this.#nominal : this.maxDelta)) * this.timeScale
    if (step === undefined && !wake) this.#nominal = trackInterval(this.#nominal, raw)
    t.rawDelta = raw
    t.elapsed += t.delta
    t.now = now
    t.frame++
    t.resumed = wake && step === undefined
    this.#last = now
    s.frames++
    if (t.resumed) s.wakes++
    s.interval = this.#nominal
    this.#dirty = false

    if (this.#stale) {
      this.#compiled.length = 0
      for (const stage of this.#stages) this.#compiled.push(...stage.systems)
      this.#stale = false
    }

    this.#frameProfilers = this.#profilers
    this.#inFrame = true
    try {
      this.#profiled('frameStart', t)
      // Removals during a frame apply at once through `active`, additions wait a frame.
      for (const r of this.#compiled) {
        if (!this.#attached) break
        if (r.active && !r.parked && r.enabled && r.scope.ready) this.#runSystem(r)
      }
      this.#profiled('frameEnd', t)
    } finally {
      this.#inFrame = false
    }

    this.#continuous = this.#attached && !this.#pauses.size && this.#wanted()
    if (this.#continuous) {
      this.#requested = true
      this.#link?.request()
    }
  }

  #reason(step: number | undefined): FrameReason {
    if (step !== undefined) return 'step'
    if (this.#dirty) return 'invalidate'
    if (this.#holds.size) return 'hold'
    return this.mode === 'always' ? 'always' : 'timed'
  }

  #runSystem(r: SystemRecord): void {
    this.#profiled('systemStart', r)
    try {
      const result: unknown = r.run(this.#t)
      if (isThenable(result)) {
        result.then(undefined, noop)
        throw new Error(`system "${r.name}" returned a promise`)
      }
      r.failures = 0
    } catch (e) {
      // Report the first failure of a streak, disable after MAX_FAILURES in a row.
      if (++r.failures === 1) this.#report(e, 'system', r.scope, r.name)
      if (r.failures >= MAX_FAILURES) {
        r.enabled = false
        r.error = e
        const error = new DioramaError(
          'SYSTEM_DISABLED',
          `"${r.name}" failed ${MAX_FAILURES} frames in a row`,
          {
            plugin: r.scope.plugin,
            cause: e,
          },
        )
        this.#report(error, 'system', r.scope, r.name)
      }
    }
    this.#profiled('systemEnd', r)
  }

  #profiled(method: keyof FrameProfiler, arg: FrameTime | SystemInfo): void {
    for (const p of this.#frameProfilers) {
      if (!this.#profilers.includes(p)) continue
      try {
        p[method](arg as never)
      } catch (e) {
        this.#profilers = this.#profilers.filter((x) => x !== p)
        this.#report(e, 'loop', undefined, 'profiler')
      }
    }
  }
}

/** Drops invalid values with a warning. */
function clean(settings: LoopSettings, warn: (message: string) => void): LoopSettings {
  const result: { -readonly [K in keyof LoopSettings]: LoopSettings[K] } = {}
  const { mode } = settings
  if (mode === 'demand' || mode === 'always') result.mode = mode
  else if (mode !== undefined) warn(`loop: invalid mode "${String(mode)}" ignored`)
  for (const key of ['maxDelta', 'maxFps', 'timeScale'] as const) {
    const value = settings[key]
    if (isValid(value)) result[key] = value
    else if (value !== undefined) warn(`loop: invalid ${key} ignored`)
  }
  return result
}

function remove<T>(list: T[], item: T): boolean {
  const i = list.indexOf(item)
  if (i >= 0) list.splice(i, 1)
  return i >= 0
}
