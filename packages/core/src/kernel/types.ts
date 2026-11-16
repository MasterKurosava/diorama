import type { AnchorsApi } from '../web/anchors'
import type { PointerApi } from '../web/pointer'
import type { ScrollApi } from '../web/scroll'
import type { StageApi } from '../web/stage'
import type { VisibilityApi } from '../web/visibility'
import type { RESERVED } from './config'
import type { DioramaError } from './errors'

/** Undoes a registration immediately. Calling it again does nothing. */
export type Off = () => void
export type MaybePromise<T> = T | Promise<T>
export type Empty = Record<never, never>
export interface DisposableLike {
  dispose(): unknown
}
/** A function or anything with `dispose()`, so Three.js resources fit as is. */
export type Cleanup = (() => unknown) | DisposableLike

/** Services by plugin name, exposed as `app.<name>`. Extend via declaration merging. */
export interface Services {
  visibility: VisibilityApi
  stage: StageApi
  scroll: ScrollApi
  pointer: PointerApi
  anchors: AnchorsApi
}

/** Event payloads by name (`undefined` for none). Extend via declaration merging. */
export interface Events {
  'app:start': undefined
  'app:destroy': undefined
  'app:error': ErrorReport
  'plugin:status': PluginStatusEvent
}

/**
 * Hook signatures by name, `(value, context?) => result`. A `Promise` result makes the hook
 * async. A handler returns a new value, nothing, or `cancel()`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: registry for declaration merging
export interface Hooks {}

/** Frame stages in run order. `addStage` inserts more, extend this to type them. */
export interface Stages {
  input: true
  layout: true
  update: true
  render: true
  afterRender: true
}

export type ServiceName = keyof Services & string
export type EventName = keyof Events & string
export type HookName = {
  [K in keyof Hooks & string]: Hooks[K] extends (...args: infer A) => unknown
    ? A['length'] extends 1 | 2
      ? K
      : never
    : never
}[keyof Hooks & string]
export type StageName = keyof Stages & string
export type PluginName = ServiceName | (string & Empty)

export type ErrorCode =
  | 'PLUGIN_INVALID'
  | 'PLUGIN_DUPLICATE'
  | 'PLUGIN_MISSING_DEPENDENCY'
  | 'PLUGIN_INCOMPATIBLE'
  | 'PLUGIN_OPTIONS'
  | 'CONFIG_INVALID'
  | 'PLUGIN_CYCLE'
  | 'PLUGIN_SETUP'
  | 'PLUGIN_TIMEOUT'
  | 'PLUGIN_DEPENDENCY_FAILED'
  | 'PLUGIN_REENTRANT'
  | 'PLUGIN_HAS_DEPENDENTS'
  | 'UNDECLARED_DEPENDENCY'
  | 'SERVICE_UNAVAILABLE'
  | 'APP_STATE'
  | 'APP_DESTROYED'
  | 'ABORTED'
  | 'STAGE_UNKNOWN'
  | 'STAGE_DUPLICATE'
  | 'ORDER_CYCLE'
  | 'LISTENER'
  | 'HOOK'
  | 'SYSTEM'
  | 'SYSTEM_DISABLED'
  | 'EFFECT'
  | 'DISPOSE'
  | 'RECURSION'
  | 'SIGNAL_CYCLE'
  | 'LOOP'
  | 'REPORTED'

export type ErrorSource =
  | 'config'
  | 'setup'
  | 'listener'
  | 'hook'
  | 'system'
  | 'effect'
  | 'dispose'
  | 'loop'
  | 'report'

export interface DioramaErrorOptions {
  readonly plugin?: string | undefined
  readonly cause?: unknown
  readonly problems?: readonly DioramaError[]
}

export interface ErrorReport {
  readonly error: DioramaError
  readonly source: ErrorSource
  readonly plugin: string | undefined
  readonly target: string | undefined
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export interface Logger {
  debug(...data: unknown[]): void
  info(...data: unknown[]): void
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}

export type Listener<K extends EventName> = (payload: Events[K]) => unknown
export type EventArgs<K extends EventName> = [Events[K]] extends [undefined]
  ? []
  : [payload: Events[K]]

export interface Cancel {
  readonly '~cancel': true
  readonly reason: string | undefined
}

export type HookArgs<K extends HookName> = Hooks[K] extends (...args: infer A) => unknown
  ? A
  : never
export type HookResult<K extends HookName> = Hooks[K] extends (...args: never[]) => infer R
  ? R
  : never
// biome-ignore lint/suspicious/noConfusingVoidType: handlers may omit return
export type HandlerReturn<R> = R extends PromiseLike<infer U> ? MaybePromise<U | void> : R | void
export type HookHandler<K extends HookName> = (...args: HookArgs<K>) => HandlerReturn<HookResult<K>>
export type SyncHookArgs<K extends HookName> =
  HookResult<K> extends PromiseLike<unknown>
    ? [error: 'This hook is async: use callHookAsync()']
    : HookArgs<K>

export type OrderRef = string | readonly string[]
/** `name` defaults to the owner label. `before`/`after` match entry names or plugin names. */
export interface OrderOptions {
  readonly name?: string
  readonly before?: OrderRef
  readonly after?: OrderRef
}
export type StagePosition =
  | { readonly before: StageName; readonly after?: never }
  | { readonly after: StageName; readonly before?: never }

export type FrameMode = 'demand' | 'always'
export type FrameReason = 'invalidate' | 'hold' | 'timed' | 'always' | 'step'

/** One mutable object per app. Durations are seconds, timestamps milliseconds. */
export interface FrameTime {
  readonly delta: number
  readonly rawDelta: number
  readonly elapsed: number
  readonly now: number
  readonly frame: number
  readonly resumed: boolean
}

/** Runs once per frame and must be synchronous. */
export type System = (time: FrameTime) => void

/** Calling the handle removes the system. */
export interface SystemHandle {
  (): void
  readonly name: string
  enabled: boolean
  readonly error: unknown
}

export interface SystemInfo {
  readonly name: string
  readonly stage: StageName
  readonly owner: string
}

export interface FrameProfiler {
  frameStart(time: FrameTime): void
  systemStart(system: SystemInfo): void
  systemEnd(system: SystemInfo): void
  frameEnd(time: FrameTime): void
}

export interface FrameStats {
  readonly frames: number
  readonly wakes: number
  readonly reason: FrameReason | 'none'
  readonly invalidatedBy: string
  readonly interval: number
}

/** Live loop state. Change settings with `overrideLoop`. */
export interface Loop {
  readonly mode: FrameMode
  readonly maxDelta: number
  readonly maxFps: number
  readonly timeScale: number
  readonly time: FrameTime
  readonly driver: FrameDriver
  readonly awake: boolean
  readonly paused: boolean
  readonly stats: FrameStats
}

export interface LoopSettings {
  readonly mode?: FrameMode
  readonly maxDelta?: number
  readonly maxFps?: number
  readonly timeScale?: number
}

export interface LoopOptions extends LoopSettings {
  readonly driver?: FrameDriver
}

export type FrameTick = (now: number, step?: number) => boolean

export interface DriverLink {
  request(): void
  cancel(): void
  detach(): void
}

/** Decides when frames happen, while the loop decides whether one is needed. `now()` is in ms. */
export interface FrameDriver {
  readonly name: string
  now(): number
  attach(tick: FrameTick): DriverLink
}

export interface ManualDriverOptions {
  readonly start?: number
  readonly step?: number
}

/** Frames only on `tick()` or `flush()`, for deterministic tests. */
export interface ManualDriver extends FrameDriver {
  readonly pending: boolean
  tick(seconds?: number): boolean
  advance(seconds: number): void
  flush(limit?: number): number
}

export interface OfflineDriverOptions {
  readonly fps: number
  readonly start?: number
}

/** Fixed-step frames on `step()` for video capture. Runs even while paused. */
export interface OfflineDriver extends FrameDriver {
  readonly fps: number
  readonly frame: number
  step(count?: number): void
}

export interface TickerDriverOptions {
  readonly name?: string
  readonly now?: () => number
}

export interface ReadonlySignal<T> {
  readonly value: T
  peek(): T
  /** Calls the listener now and after every change (Svelte store contract). */
  subscribe(listener: (value: T) => void): Off
}
export interface Signal<T> extends ReadonlySignal<T> {
  value: T
}
export interface SignalOptions<T> {
  readonly equals?: (a: T, b: T) => boolean
}
/** May return a cleanup, run before the next run and on disposal. */
export type EffectFn = () => unknown

/** Standard Schema v1, inlined to stay dependency-free (Zod, Valibot, ArkType implement it). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaProps<Input, Output>
}
export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1
  readonly vendor: string
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>
  readonly types?: StandardSchemaTypes<Input, Output> | undefined
}
export interface StandardSchemaTypes<Input, Output> {
  readonly input: Input
  readonly output: Output
}
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] }
export interface StandardSchemaIssue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
}

// biome-ignore lint/suspicious/noConfusingVoidType: matches what TypeScript infers for setup without return
export type RegisteredService<N extends string> = N extends keyof Services ? Services[N] : void

export interface PluginTypes<O, S> {
  readonly options: O
  readonly service: S
}

export type PluginArgs<O, R extends PropertyKey> = [R] extends [never]
  ? [options?: Partial<O>]
  : [options: Partial<O> & Pick<O, R & keyof O>]

/**
 * A plugin is a frozen function. Calling it with options returns a configured copy.
 * N is the name and service key, O the options, S the service, R the keys required at call time.
 */
export interface Plugin<
  N extends string = string,
  O extends object = Empty,
  S = RegisteredService<N>,
  R extends PropertyKey = never,
> {
  (...options: PluginArgs<O, R>): Plugin<N, O, S>
  readonly name: N
  readonly version: string | undefined
  readonly options: Readonly<Partial<O>>
  readonly defaults: Readonly<Partial<O>>
  readonly schema: StandardSchemaV1 | undefined
  readonly dependencies: readonly string[]
  readonly optionalDependencies: readonly string[]
  readonly '~types'?: PluginTypes<O, S>
}

export type AnyPlugin = Plugin<string, object, unknown>

export interface PluginRef {
  readonly name: string
  readonly '~types'?: { readonly service: unknown }
}

export type ServiceOf<P> = P extends { readonly '~types'?: { readonly service: infer S } }
  ? S
  : never

export type DependencyRef = PluginName | PluginRef

export type ReservedName =
  | keyof AppCore
  | keyof AppControls
  | keyof ScopeControls
  | 'constructor'
  | 'hasOwnProperty'
  | 'isPrototypeOf'
  | 'propertyIsEnumerable'
  | 'toLocaleString'
  | 'toString'
  | 'valueOf'
  | (typeof RESERVED)[number]

type Lower =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
type Alnum = Lower | Uppercase<Lower> | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type IdentifierTail<S extends string> = S extends `${infer C}${infer R}`
  ? C extends Alnum
    ? IdentifierTail<R>
    : false
  : true

export type PluginNameProblem<N extends string> = string extends N
  ? never
  : N extends ReservedName
    ? `"${N}" is reserved by the App API`
    : N extends `${Lower}${infer R}`
      ? IdentifierTail<R> extends true
        ? never
        : `"${N}": plugin names are lowerCamelCase identifiers`
      : `"${N}": plugin names are lowerCamelCase identifiers`

export type ServiceFor<N extends string, S> = N extends keyof Services ? Services[N] : S

type DependencyName<R> = R extends string
  ? R
  : R extends { readonly name: infer N extends string }
    ? N
    : never

type DependencyService<R> = R extends keyof Services
  ? Services[R]
  : R extends string
    ? unknown
    : ServiceOf<R>

export type DependenciesOf<
  D extends readonly DependencyRef[],
  OD extends readonly DependencyRef[],
> = { readonly [R in D[number] as DependencyName<R>]: DependencyService<R> } & {
  readonly [R in OD[number] as DependencyName<R>]?: DependencyService<R>
}

export type OptionsOf<O, DO, SO = Empty> = [keyof O] extends [never]
  ? [keyof SO] extends [never]
    ? DO
    : SO
  : O

type RequiredKeys<T> = { [K in keyof T]-?: Empty extends Pick<T, K> ? never : K }[keyof T]

export type RequiredOptions<O, DO, SI> = unknown extends SI
  ? Exclude<RequiredKeys<O>, keyof DO>
  : Exclude<RequiredKeys<SI> & keyof O, keyof DO>

export interface PluginDefinition<
  N extends string,
  O extends object,
  DO,
  S,
  D extends readonly DependencyRef[],
  OD extends readonly DependencyRef[],
  SI = unknown,
  SO extends object = Empty,
> {
  /** lowerCamelCase, e.g. `scrollScenes` for `app.scrollScenes`. */
  readonly name: [PluginNameProblem<N>] extends [never] ? N : PluginNameProblem<N>
  readonly version?: string
  /** Semver range of compatible core versions. */
  readonly core?: string
  readonly dependencies?: D
  readonly optionalDependencies?: OD
  readonly defaults?: DO
  readonly schema?: StandardSchemaV1<SI, OptionsOf<O, NoInfer<DO>, SO>>
  /** A failure rolls back the whole start, not just this plugin. */
  readonly critical?: boolean
  setup(
    app: PluginApp<DependenciesOf<D, OD>>,
    options: Readonly<OptionsOf<O, DO, SO>>,
  ): MaybePromise<ServiceFor<N, S>>
}

/** Falsy entries are skipped, so `dev && devtools` works. */
export type PluginEntry = AnyPlugin | false | null | undefined
export type PresetEntry = Preset | false | null | undefined

export interface Preset<P extends AnyPlugin = AnyPlugin> {
  readonly name: string
  readonly plugins: readonly PluginEntry[]
  readonly presets: readonly PresetEntry[]
  readonly '~types'?: { readonly plugins: P }
}

export interface PresetDefinition<
  E extends readonly PluginEntry[],
  PS extends readonly PresetEntry[],
> {
  readonly name: string
  readonly presets?: PS
  readonly plugins?: E
}

export type PresetPlugins<X> = X extends Preset<infer P> ? P : never

// biome-ignore lint/suspicious/noConfusingVoidType: matches what TypeScript infers for setup without return
type ServiceKey<P> = [ServiceOf<P>] extends [void]
  ? never
  : P extends { readonly name: infer N extends string }
    ? string extends N
      ? never
      : N
    : never

export type ServicesOf<X> = { readonly [P in X as ServiceKey<P>]: ServiceOf<P> }

export type PluginSource = 'default' | 'preset' | 'app' | 'runtime'

export type AppState = 'idle' | 'starting' | 'running' | 'destroying' | 'destroyed' | 'failed'
export type PluginStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'skipped'

export interface PluginStatusEvent {
  readonly name: string
  readonly status: PluginStatus
  readonly previous: PluginStatus
  readonly error: DioramaError | undefined
}

export interface AppOptions<
  P extends readonly PresetEntry[] = readonly PresetEntry[],
  E extends readonly PluginEntry[] = readonly PluginEntry[],
> {
  readonly name?: string
  readonly presets?: P
  readonly plugins?: E
  /** Built-in web-layer plugins. Default `true`. */
  readonly defaults?: boolean
  /** Names to drop from built-ins and presets. */
  readonly disable?: readonly PluginName[]
  readonly loop?: LoopOptions
  /** Seconds allowed per setup, default 30. Also bounds how long `destroy` waits. */
  readonly setupTimeout?: number
  /** Any setup or configuration failure rolls back the start. */
  readonly failFast?: boolean
  readonly logger?: Logger
  readonly logLevel?: LogLevel
  readonly onError?: (report: ErrorReport) => void
}

export interface RemoveOptions {
  readonly cascade?: boolean
}

export interface AppControls {
  readonly name: string
  readonly state: ReadonlySignal<AppState>
  start(): Promise<this>
  destroy(): Promise<void>
}

export interface ScopeControls {
  dispose(): Promise<void>
  readonly disposed: boolean
}

export type AppScope<X extends object = Empty, A extends string = string> = AppCore<X, A> &
  X &
  ScopeControls

/**
 * The kernel API seen by the app, plugins and scopes. Registrations belong to the view's
 * owner and are undone with it. Methods are unbound: pass arrows to callbacks.
 */
export interface AppCore<X extends object = Empty, A extends string = string> {
  use<P extends AnyPlugin>(plugin: P): Promise<ServiceOf<P>>
  use(entry: Preset | readonly PluginEntry[]): Promise<void>
  remove(plugin: DependencyRef, options?: RemoveOptions): Promise<boolean>
  has(plugin: DependencyRef): boolean
  get<K extends keyof X & string>(name: K): Required<X>[K]
  get<P extends PluginRef & { readonly name: A }>(plugin: P): ServiceOf<P>
  find<K extends keyof X & string>(name: K): Required<X>[K] | undefined
  find<P extends PluginRef & { readonly name: A }>(plugin: P): ServiceOf<P> | undefined

  on<K extends EventName>(event: K, listener: Listener<K>): Off
  once<K extends EventName>(event: K, listener: Listener<K>): Off
  emit<K extends EventName>(event: K, ...args: EventArgs<K>): void

  hook<K extends HookName>(hook: K, handler: HookHandler<K>, options?: OrderOptions): Off
  callHook<K extends HookName>(hook: K, ...args: SyncHookArgs<K>): HookResult<K>
  callHookAsync<K extends HookName>(hook: K, ...args: HookArgs<K>): Promise<Awaited<HookResult<K>>>
  hookVersion(hook: HookName): number

  readonly loop: Loop
  system(stage: StageName, run: System, options?: OrderOptions): SystemHandle
  addStage(name: StageName, position: StagePosition): Off
  /** Requests one frame. */
  invalidate(): void
  /** Keeps frames coming for `seconds`. Extends, never shortens. */
  keepAwake(seconds: number): void
  /** Keeps frames coming until released, e.g. while an animation runs. `reason` labels the call. */
  hold(reason?: string): Off
  /** No frames until every pause is released. `reason` labels the call. */
  pause(reason?: string): Off
  overrideLoop(settings: LoopSettings): Off
  setDriver(driver: FrameDriver): Off
  profile(profiler: FrameProfiler): Off

  effect(fn: EffectFn): Off

  scope(): AppScope<X, A>
  onDispose(cleanup: Cleanup): Off
  readonly abortSignal: AbortSignal

  readonly log: Logger
  report(error: unknown, target?: string): void
}

/** What `createApp` returns: the kernel API, lifecycle controls and services. */
export type App<S extends object = Empty> = AppCore<Services & S> & AppControls & Services & S
/** `app` inside setup: its own service and declared dependencies only. */
export type PluginApp<D extends object = Empty> = AppCore<D, keyof D & string> & D
