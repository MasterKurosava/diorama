import type { AnchorsApi } from '../web/anchors'
import type { PointerApi } from '../web/pointer'
import type { ScrollApi } from '../web/scroll'
import type { StageApi } from '../web/stage'
import type { VisibilityApi } from '../web/visibility'
import type { RESERVED } from './config'
import type { DioramaError } from './errors'

/** Undoes a registration immediately. Calling it again does nothing. */
export type Off = () => void
/** A value or a promise of it. */
export type MaybePromise<T> = T | Promise<T>
/** An object type with no keys. */
export type Empty = Record<never, never>
/** Anything with `dispose()`. */
export interface DisposableLike {
  /** Frees what the object holds. */
  dispose(): unknown
}
/** A function or anything with `dispose()`, so Three.js resources fit as is. */
export type Cleanup = (() => unknown) | DisposableLike

/** Services by plugin name, exposed as `app.<name>`. Extend via declaration merging. */
export interface Services {
  /** Tab visibility. */
  visibility: VisibilityApi
  /** The canvas and the viewport. */
  stage: StageApi
  /** Page scroll. */
  scroll: ScrollApi
  /** The pointer. */
  pointer: PointerApi
  /** Element boxes kept in sync with the page. */
  anchors: AnchorsApi
}

/** Event payloads by name (`undefined` for none). Extend via declaration merging. */
export interface Events {
  /** The app started. */
  'app:start': undefined
  /** The app is being destroyed. */
  'app:destroy': undefined
  /** An error was reported. */
  'app:error': ErrorReport
  /** A plugin changed status. */
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
  /** Reads input: pointer, scroll. */
  input: true
  /** Measures the page: anchors. */
  layout: true
  /** Updates state and animations. */
  update: true
  /** Draws. */
  render: true
  /** Runs after drawing. */
  afterRender: true
}

/** Names of the registered services. */
export type ServiceName = keyof Services & string
/** Names of the registered events. */
export type EventName = keyof Events & string
/** Names of the registered hooks. */
export type HookName = {
  [K in keyof Hooks & string]: Hooks[K] extends (...args: infer A) => unknown
    ? A['length'] extends 1 | 2
      ? K
      : never
    : never
}[keyof Hooks & string]
/** Names of the frame stages. */
export type StageName = keyof Stages & string
/** A plugin name: a registered service or any string. */
export type PluginName = ServiceName | (string & Empty)

/** Codes of errors from the kernel and the built-in web layer. */
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

/**
 * Codes of warnings and notes that adapters and `start()` log as `CODE: message`, outside the
 * error code unions of the packages.
 */
export type LogCode =
  | 'EFFECT_OVERRIDE'
  | 'GSAP_SCROLLTRIGGER'
  | 'LENIS_AUTORAF'
  | 'LENIS_DESTROYED'
  | 'LENIS_RAF_ABSORBED'
  | 'LENIS_SHARED_DRIVER'
  | 'LENIS_UNSYNCED'
  | 'LENIS_WRAPPER'

/** Where a reported error was caught. */
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

/** Options of `DioramaError`. */
export interface DioramaErrorOptions {
  /** Plugin the error comes from. */
  readonly plugin?: string | undefined
  /** The original error. */
  readonly cause?: unknown
  /** Every problem found, when there are several. */
  readonly problems?: readonly DioramaError[]
}

/** What `app:error` listeners and `onError` receive. */
export interface ErrorReport {
  /** The error, wrapped as `DioramaError` when it was something else. */
  readonly error: DioramaError
  /** Where the error was caught. */
  readonly source: ErrorSource
  /** Plugin that owns the failed code, if any. */
  readonly plugin: string | undefined
  /** What failed, such as `effect:ripple@img`, if the reporter said. */
  readonly target: string | undefined
}

/** Least severe level that is logged. `silent` logs nothing. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/** Console-like sink for logs. `console` by default. */
export interface Logger {
  /** Logs details for debugging. */
  debug(...data: unknown[]): void
  /** Logs a note. */
  info(...data: unknown[]): void
  /** Logs a warning. */
  warn(...data: unknown[]): void
  /** Logs an error. */
  error(...data: unknown[]): void
}

/** Listener of event `K`. */
export type Listener<K extends EventName> = (payload: Events[K]) => unknown
/** Arguments of `emit` for event `K`: none when the payload is `undefined`. */
export type EventArgs<K extends EventName> = [Events[K]] extends [undefined]
  ? []
  : [payload: Events[K]]

/** Result of `cancel()`: stops a hook chain. */
export interface Cancel {
  /** Marks the object as a cancel. */
  readonly '~cancel': true
  /** Why the chain stopped, if given. */
  readonly reason: string | undefined
}

/** Arguments of hook `K`. */
export type HookArgs<K extends HookName> = Hooks[K] extends (...args: infer A) => unknown
  ? A
  : never
/** Result of hook `K`. */
export type HookResult<K extends HookName> = Hooks[K] extends (...args: never[]) => infer R
  ? R
  : never
/** What a hook handler may return: a new value, nothing, or a promise of either for async hooks. */
// biome-ignore lint/suspicious/noConfusingVoidType: handlers may omit return
export type HandlerReturn<R> = R extends PromiseLike<infer U> ? MaybePromise<U | void> : R | void
/** Handler of hook `K`. */
export type HookHandler<K extends HookName> = (...args: HookArgs<K>) => HandlerReturn<HookResult<K>>
/** Arguments of `callHook` for hook `K`. Async hooks need `callHookAsync`. */
export type SyncHookArgs<K extends HookName> =
  HookResult<K> extends PromiseLike<unknown>
    ? [error: 'This hook is async: use callHookAsync()']
    : HookArgs<K>

/** One name or several, for `before` and `after`. */
export type OrderRef = string | readonly string[]
/** `name` defaults to the owner label. `before`/`after` match entry names or plugin names. */
export interface OrderOptions {
  /** Name of this entry. Defaults to the owner label. */
  readonly name?: string
  /** Runs before these entries or plugins. */
  readonly before?: OrderRef
  /** Runs after these entries or plugins. */
  readonly after?: OrderRef
}
/** Where `addStage` puts a stage: before or after an existing one. */
export type StagePosition =
  | { readonly before: StageName; readonly after?: never }
  | { readonly after: StageName; readonly before?: never }

/** `demand` frames only when something asks, `always` frames continuously. */
export type FrameMode = 'demand' | 'always'
/** Why the last frame ran. */
export type FrameReason = 'invalidate' | 'hold' | 'timed' | 'always' | 'step'

/** One mutable object per app. Durations are seconds, timestamps milliseconds. */
export interface FrameTime {
  /** Seconds since the last frame, scaled by `timeScale` and capped by `maxDelta`. */
  readonly delta: number
  /** Seconds since the last frame, unscaled and uncapped. */
  readonly rawDelta: number
  /** Scaled seconds since the start. */
  readonly elapsed: number
  /** Driver timestamp, ms. */
  readonly now: number
  /** Frame number since the start. */
  readonly frame: number
  /** This is the first frame after a sleep or a pause. */
  readonly resumed: boolean
}

/** Runs once per frame and must be synchronous. */
export type System = (time: FrameTime) => void

/** Calling the handle removes the system. */
export interface SystemHandle {
  (): void
  /** Name of the system. */
  readonly name: string
  /** A disabled system is skipped. */
  enabled: boolean
  /** The error that disabled the system, if any. */
  readonly error: unknown
}

/** A system as the profiler sees it. */
export interface SystemInfo {
  /** Name of the system. */
  readonly name: string
  /** Stage it runs in. */
  readonly stage: StageName
  /** Plugin or scope that registered it. */
  readonly owner: string
}

/** Receives timing points of every frame, see `app.profile`. */
export interface FrameProfiler {
  /** Called before the first system of a frame. */
  frameStart(time: FrameTime): void
  /** Called before a system runs. */
  systemStart(system: SystemInfo): void
  /** Called after a system runs. */
  systemEnd(system: SystemInfo): void
  /** Called after the last system of a frame. */
  frameEnd(time: FrameTime): void
}

/** Counters of the frame loop. */
export interface FrameStats {
  /** Frames run so far. */
  readonly frames: number
  /** Times the loop woke up from sleep. */
  readonly wakes: number
  /** Why the last frame ran. */
  readonly reason: FrameReason | 'none'
  /** Owner that last called `invalidate`. */
  readonly invalidatedBy: string
  /** Measured display frame interval, seconds. */
  readonly interval: number
}

/** Live loop state. Change settings with `overrideLoop`. */
export interface Loop {
  /** Current frame mode. */
  readonly mode: FrameMode
  /** Upper bound of `delta`, seconds. */
  readonly maxDelta: number
  /** Frame rate cap. 0 means none. */
  readonly maxFps: number
  /** Multiplier of `delta` and `elapsed`. */
  readonly timeScale: number
  /** Time of the current or last frame. */
  readonly time: FrameTime
  /** Driver that schedules frames. */
  readonly driver: FrameDriver
  /** A frame is requested or running. */
  readonly awake: boolean
  /** Frames are paused by `pause`. */
  readonly paused: boolean
  /** Loop counters. */
  readonly stats: FrameStats
}

/** Loop settings that `overrideLoop` can change. */
export interface LoopSettings {
  /** `demand` (default) or `always`. */
  readonly mode?: FrameMode
  /** Upper bound of `delta`, seconds. */
  readonly maxDelta?: number
  /** Frame rate cap. 0 means none. */
  readonly maxFps?: number
  /** Multiplier of `delta` and `elapsed`. 0 freezes time. */
  readonly timeScale?: number
}

/** Loop options of `createApp`. */
export interface LoopOptions extends LoopSettings {
  /** Driver to start with. `rafDriver()` by default. */
  readonly driver?: FrameDriver
}

/** Runs one frame at `now` (ms). Returns whether a frame ran. */
export type FrameTick = (now: number, step?: number) => boolean

/** The loop's connection to a driver. */
export interface DriverLink {
  /** Asks for a frame. */
  request(): void
  /** Withdraws a pending request. */
  cancel(): void
  /** Disconnects the loop from the driver. */
  detach(): void
}

/** Decides when frames happen, while the loop decides whether one is needed. `now()` is in ms. */
export interface FrameDriver {
  /** Label for logs and stats. */
  readonly name: string
  /** Current time, ms. */
  now(): number
  /** Connects a loop. The driver calls `tick` for each frame it grants. */
  attach(tick: FrameTick): DriverLink
}

/** Options of `manualDriver`. */
export interface ManualDriverOptions {
  /** Starting time, ms. Default 0. */
  readonly start?: number
  /** Seconds per `tick()` without an argument. Default 1/60. */
  readonly step?: number
}

/** Frames only on `tick()` or `flush()`, for deterministic tests. */
export interface ManualDriver extends FrameDriver {
  /** A frame is requested. */
  readonly pending: boolean
  /** Advances time and runs a frame if one is requested. Returns whether it ran. */
  tick(seconds?: number): boolean
  /** Advances time without running a frame. */
  advance(seconds: number): void
  /** Ticks while frames are requested, up to `limit`. Returns the number of frames. */
  flush(limit?: number): number
}

/** Options of `offlineDriver`. */
export interface OfflineDriverOptions {
  /** Frames per second of the capture. */
  readonly fps: number
  /** Starting time, ms. Default 0. */
  readonly start?: number
}

/** Fixed-step frames on `step()` for video capture. Runs even while paused. */
export interface OfflineDriver extends FrameDriver {
  /** Frames per second of the capture. */
  readonly fps: number
  /** Frames stepped so far. */
  readonly frame: number
  /** Runs `count` frames of `1 / fps` seconds each. */
  step(count?: number): void
}

/** Options of `tickerDriver`. */
export interface TickerDriverOptions {
  /** Label for logs. Default `ticker`. */
  readonly name?: string
  /** Clock in ms when the ticker passes no time. Default `performance.now`. */
  readonly now?: () => number
}

/** A reactive value that can be read and watched. */
export interface ReadonlySignal<T> {
  /** Current value. Reading it inside `effect` or `computed` tracks it. */
  readonly value: T
  /** Current value, without tracking. */
  peek(): T
  /** Calls the listener now and after every change (Svelte store contract). */
  subscribe(listener: (value: T) => void): Off
}
/** A reactive value that can be written. */
export interface Signal<T> extends ReadonlySignal<T> {
  /** Current value. Writing a different value notifies its readers. */
  value: T
}
/** Options of `signal` and `computed`. */
export interface SignalOptions<T> {
  /** Decides whether a new value is the same. `Object.is` by default. */
  readonly equals?: (a: T, b: T) => boolean
}
/** May return a cleanup, run before the next run and on disposal. */
export type EffectFn = () => unknown

/** Standard Schema v1, inlined to stay dependency-free (Zod, Valibot, ArkType implement it). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema interface. */
  readonly '~standard': StandardSchemaProps<Input, Output>
}
/** Standard Schema properties. */
export interface StandardSchemaProps<Input = unknown, Output = Input> {
  /** Version of the Standard Schema spec. */
  readonly version: 1
  /** Library that implements the schema. */
  readonly vendor: string
  /** Validates a value and returns the result or the issues. */
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>
  /** Input and output types, for inference only. */
  readonly types?: StandardSchemaTypes<Input, Output> | undefined
}
/** Input and output types of a schema. */
export interface StandardSchemaTypes<Input, Output> {
  /** Type the schema accepts. */
  readonly input: Input
  /** Type the schema returns. */
  readonly output: Output
}
/** Result of a Standard Schema validation. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] }
/** One validation problem. */
export interface StandardSchemaIssue {
  /** What is wrong. */
  readonly message: string
  /** Where in the value it is. */
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
}

/** Service registered under name `N` in `Services`, or `void`. */
// biome-ignore lint/suspicious/noConfusingVoidType: matches what TypeScript infers for setup without return
export type RegisteredService<N extends string> = N extends keyof Services ? Services[N] : void

/** Phantom types of a plugin, for inference. */
export interface PluginTypes<O, S> {
  /** Options type. */
  readonly options: O
  /** Service type. */
  readonly service: S
}

/** Arguments of a plugin call: partial options, with the keys in `R` required. */
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
  /** Name, also the service key on `app`. */
  readonly name: N
  /** Version of the plugin, if it declares one. */
  readonly version: string | undefined
  /** Options passed so far. */
  readonly options: Readonly<Partial<O>>
  /** Default options. */
  readonly defaults: Readonly<Partial<O>>
  /** Schema that validates the options, if any. */
  readonly schema: StandardSchemaV1 | undefined
  /** Plugins that must be installed first. */
  readonly dependencies: readonly string[]
  /** Plugins that go first when present. */
  readonly optionalDependencies: readonly string[]
  /** Phantom types, for inference only. */
  readonly '~types'?: PluginTypes<O, S>
}

/** A plugin of any name, options and service. */
export type AnyPlugin = Plugin<string, object, unknown>

/** A plugin or anything with its name and types, for `get`, `find` and dependencies. */
export interface PluginRef {
  /** Plugin name. */
  readonly name: string
  /** Phantom types, for inference only. */
  readonly '~types'?: { readonly service: unknown }
}

/** Service type of a plugin. */
export type ServiceOf<P> = P extends { readonly '~types'?: { readonly service: infer S } }
  ? S
  : never

/** A dependency by name or by plugin. */
export type DependencyRef = PluginName | PluginRef

/** Names a plugin cannot take, since the app API uses them. */
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

/** Why `N` is not a valid plugin name, or `never` when it is. */
export type PluginNameProblem<N extends string> = string extends N
  ? never
  : N extends ReservedName
    ? `"${N}" is reserved by the App API`
    : N extends `${Lower}${infer R}`
      ? IdentifierTail<R> extends true
        ? never
        : `"${N}": plugin names are lowerCamelCase identifiers`
      : `"${N}": plugin names are lowerCamelCase identifiers`

/** Service of plugin `N`: the registered one when `N` is in `Services`, else `S`. */
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

/** Services of the declared dependencies, as `setup` sees them. */
export type DependenciesOf<
  D extends readonly DependencyRef[],
  OD extends readonly DependencyRef[],
> = { readonly [R in D[number] as DependencyName<R>]: DependencyService<R> } & {
  readonly [R in OD[number] as DependencyName<R>]?: DependencyService<R>
}

/** Options type of a plugin from its declared types, defaults and schema. */
export type OptionsOf<O, DO, SO = Empty> = [keyof O] extends [never]
  ? [keyof SO] extends [never]
    ? DO
    : SO
  : O

type RequiredKeys<T> = { [K in keyof T]-?: Empty extends Pick<T, K> ? never : K }[keyof T]

/** Option keys that a plugin call must pass. */
export type RequiredOptions<O, DO, SI> = unknown extends SI
  ? Exclude<RequiredKeys<O>, keyof DO>
  : Exclude<RequiredKeys<SI> & keyof O, keyof DO>

/** What `definePlugin` takes. */
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
  /** Version, shown in errors and devtools. */
  readonly version?: string
  /** Semver range of compatible core versions. */
  readonly core?: string
  /** Plugins that must be installed first. Their services are typed in `setup`. */
  readonly dependencies?: D
  /** Plugins that go first when present. */
  readonly optionalDependencies?: OD
  /** Default options. */
  readonly defaults?: DO
  /** Standard Schema that validates and transforms the options. */
  readonly schema?: StandardSchemaV1<SI, OptionsOf<O, NoInfer<DO>, SO>>
  /** A failure rolls back the whole start, not just this plugin. */
  readonly critical?: boolean
  /** Installs the plugin and returns its service. Registrations made here are undone on removal. */
  setup(
    app: PluginApp<DependenciesOf<D, OD>>,
    options: Readonly<OptionsOf<O, DO, SO>>,
  ): MaybePromise<ServiceFor<N, S>>
}

/** Falsy entries are skipped, so `dev && devtools` works. */
export type PluginEntry = AnyPlugin | false | null | undefined
/** A preset, or a falsy value that is skipped. */
export type PresetEntry = Preset | false | null | undefined

/** A named group of plugins and presets. */
export interface Preset<P extends AnyPlugin = AnyPlugin> {
  /** Preset name. */
  readonly name: string
  /** Plugins of the preset. */
  readonly plugins: readonly PluginEntry[]
  /** Nested presets. */
  readonly presets: readonly PresetEntry[]
  /** Phantom types, for inference only. */
  readonly '~types'?: { readonly plugins: P }
}

/** What `definePreset` takes. */
export interface PresetDefinition<
  E extends readonly PluginEntry[],
  PS extends readonly PresetEntry[],
> {
  /** Preset name. */
  readonly name: string
  /** Nested presets. */
  readonly presets?: PS
  /** Plugins of the preset. */
  readonly plugins?: E
}

/** Plugins of a preset type. */
export type PresetPlugins<X> = X extends Preset<infer P> ? P : never

// biome-ignore lint/suspicious/noConfusingVoidType: matches what TypeScript infers for setup without return
type ServiceKey<P> = [ServiceOf<P>] extends [void]
  ? never
  : P extends { readonly name: infer N extends string }
    ? string extends N
      ? never
      : N
    : never

/** Services of a union of plugins, keyed by name. */
export type ServicesOf<X> = { readonly [P in X as ServiceKey<P>]: ServiceOf<P> }

/** How a plugin came in: built in, from a preset, from `createApp` or from `use`. */
export type PluginSource = 'default' | 'preset' | 'app' | 'runtime'

/** Lifecycle state of an app. */
export type AppState = 'idle' | 'starting' | 'running' | 'destroying' | 'destroyed' | 'failed'
/** Lifecycle state of a plugin. */
export type PluginStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'skipped'

/** Payload of `plugin:status`. */
export interface PluginStatusEvent {
  /** Plugin name. */
  readonly name: string
  /** New status. */
  readonly status: PluginStatus
  /** Status before the change. */
  readonly previous: PluginStatus
  /** Why the plugin failed, for `failed`. */
  readonly error: DioramaError | undefined
}

/** Options of `createApp`. */
export interface AppOptions<
  P extends readonly PresetEntry[] = readonly PresetEntry[],
  E extends readonly PluginEntry[] = readonly PluginEntry[],
> {
  /** App name, used in log prefixes. */
  readonly name?: string
  /** Presets to install. */
  readonly presets?: P
  /** Plugins to install. Falsy entries are skipped. */
  readonly plugins?: E
  /** Built-in web-layer plugins. Default `true`. */
  readonly defaults?: boolean
  /** Names to drop from built-ins and presets. */
  readonly disable?: readonly PluginName[]
  /** Frame loop settings and driver. */
  readonly loop?: LoopOptions
  /** Seconds allowed per setup, default 30. Also bounds how long `destroy` waits. */
  readonly setupTimeout?: number
  /** Any setup or configuration failure rolls back the start. */
  readonly failFast?: boolean
  /** Where logs go. `console` by default. */
  readonly logger?: Logger
  /** Least severe level that is logged. Default `warn`. */
  readonly logLevel?: LogLevel
  /** Called for every reported error, after `app:error` listeners. */
  readonly onError?: (report: ErrorReport) => void
}

/** Options of `app.remove`. */
export interface RemoveOptions {
  /** Also remove the plugins that depend on it, instead of failing. */
  readonly cascade?: boolean
}

/** Lifecycle controls of an app. */
export interface AppControls {
  /** App name. */
  readonly name: string
  /** Lifecycle state. */
  readonly state: ReadonlySignal<AppState>
  /**
   * Installs the plugins and starts the loop. Resolves with the app once every plugin is set up.
   * @throws {DioramaError} `CONFIG_INVALID` or the code of the only configuration problem
   * (`PLUGIN_INVALID`, `PLUGIN_DUPLICATE`, `PLUGIN_CYCLE`, `PLUGIN_OPTIONS`, `PLUGIN_INCOMPATIBLE`);
   * `PLUGIN_SETUP`, `PLUGIN_TIMEOUT` or `PLUGIN_DEPENDENCY_FAILED` when a critical plugin fails;
   * `ABORTED` or `APP_DESTROYED` when the app is destroyed first.
   */
  start(): Promise<this>
  /** Disposes every plugin in reverse order and stops the loop. */
  destroy(): Promise<void>
}

/** Lifecycle controls of a scope. */
export interface ScopeControls {
  /** Undoes everything registered through the scope. */
  dispose(): Promise<void>
  /** The scope is disposed. */
  readonly disposed: boolean
}

/** A child view of the app whose registrations are undone together by `dispose()`. */
export type AppScope<X extends object = Empty, A extends string = string> = AppCore<X, A> &
  X &
  ScopeControls

/**
 * The kernel API seen by the app, plugins and scopes. Registrations belong to the view's
 * owner and are undone with it. Methods are unbound: pass arrows to callbacks.
 */
export interface AppCore<X extends object = Empty, A extends string = string> {
  /**
   * Installs a plugin at runtime and resolves with its service.
   * @throws {DioramaError} `APP_STATE` before start, `PLUGIN_REENTRANT` from a running setup,
   * `PLUGIN_DUPLICATE` when it runs with other options, and the setup and configuration codes of
   * `start()`.
   */
  use<P extends AnyPlugin>(plugin: P): Promise<ServiceOf<P>>
  use(entry: Preset | readonly PluginEntry[]): Promise<void>
  /**
   * Uninstalls a plugin. Resolves with whether it was installed.
   * @throws {DioramaError} `PLUGIN_HAS_DEPENDENTS` when running plugins need it and `cascade` is
   * off; `APP_STATE` and `PLUGIN_REENTRANT` as in `use()`.
   */
  remove(plugin: DependencyRef, options?: RemoveOptions): Promise<boolean>
  /** Whether a plugin is installed and running. */
  has(plugin: DependencyRef): boolean
  /**
   * Service of a plugin. Throws when it is not available.
   * @throws {DioramaError} `SERVICE_UNAVAILABLE` when the plugin is not running,
   * `UNDECLARED_DEPENDENCY` in a plugin that did not declare it.
   */
  get<K extends keyof X & string>(name: K): Required<X>[K]
  get<P extends PluginRef & { readonly name: A }>(plugin: P): ServiceOf<P>
  /** Service of a plugin, or `undefined` when it is not available. */
  find<K extends keyof X & string>(name: K): Required<X>[K] | undefined
  find<P extends PluginRef & { readonly name: A }>(plugin: P): ServiceOf<P> | undefined

  /** Listens to an event. Returns Off. */
  on<K extends EventName>(event: K, listener: Listener<K>): Off
  /** Listens to the next occurrence of an event only. */
  once<K extends EventName>(event: K, listener: Listener<K>): Off
  /** Calls the listeners of an event. */
  emit<K extends EventName>(event: K, ...args: EventArgs<K>): void

  /**
   * Adds a handler to a hook. Returns Off.
   * @throws {DioramaError} `ORDER_CYCLE` when `before` and `after` form a cycle.
   */
  hook<K extends HookName>(hook: K, handler: HookHandler<K>, options?: OrderOptions): Off
  /** Runs the handlers of a sync hook in order and returns the result. */
  callHook<K extends HookName>(hook: K, ...args: SyncHookArgs<K>): HookResult<K>
  /** Runs the handlers of an async hook in order and resolves with the result. */
  callHookAsync<K extends HookName>(hook: K, ...args: HookArgs<K>): Promise<Awaited<HookResult<K>>>
  /** Grows every time the handlers of a hook change, to cache results. */
  hookVersion(hook: HookName): number

  /** Live state of the frame loop. */
  readonly loop: Loop
  /**
   * Runs `run` once per frame in a stage. Returns a handle that removes it.
   * @throws {DioramaError} `ORDER_CYCLE` when `before` and `after` form a cycle.
   */
  system(stage: StageName, run: System, options?: OrderOptions): SystemHandle
  /**
   * Adds a frame stage before or after an existing one.
   * @throws {DioramaError} `STAGE_DUPLICATE` when the name is taken, `STAGE_UNKNOWN` when the
   * anchor stage does not exist.
   */
  addStage(name: StageName, position: StagePosition): Off
  /** Requests one frame. */
  invalidate(): void
  /** Keeps frames coming for `seconds`. Extends, never shortens. */
  keepAwake(seconds: number): void
  /**
   * Keeps frames coming until released, e.g. while an animation runs. `reason` is a note for
   * readers of the call and is not used.
   */
  hold(reason?: string): Off
  /** No frames until every pause is released. `reason` is a note for readers and is not used. */
  pause(reason?: string): Off
  /** Changes loop settings until Off is called. The newest override wins. */
  overrideLoop(settings: LoopSettings): Off
  /** Replaces the frame driver until Off is called. */
  setDriver(driver: FrameDriver): Off
  /** Adds a frame profiler until Off is called. */
  profile(profiler: FrameProfiler): Off

  /** Like `effect`, but owned by this view and reported through the app. */
  effect(fn: EffectFn): Off

  /** Creates a child scope whose registrations go away with its `dispose()`. */
  scope(): AppScope<X, A>
  /** Runs a cleanup when this view's owner goes away. Returns Off to cancel it. */
  onDispose(cleanup: Cleanup): Off
  /** Aborts when this view's owner goes away. */
  readonly abortSignal: AbortSignal

  /** Logger with this owner's prefix. */
  readonly log: Logger
  /** Reports an error through `app:error` and `onError` without throwing. */
  report(error: unknown, target?: string): void
}

/** What `createApp` returns: the kernel API, lifecycle controls and services. */
export type App<S extends object = Empty> = AppCore<Services & S> & AppControls & Services & S
/** `app` inside setup: its own service and declared dependencies only. */
export type PluginApp<D extends object = Empty> = AppCore<D, keyof D & string> & D
