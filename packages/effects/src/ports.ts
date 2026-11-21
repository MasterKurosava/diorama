// Contracts between the parts of the effects plugin: the controller of instance records
// (instances.ts), its DOM side (dom.ts), the engine gate (gate.ts) and the runtime, which loads
// with three (runtime/). Types only.
import type { Off, PluginApp, ReadonlySignal, Services, Signal } from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import type { EffectError } from './errors'
import type {
  AnyParamValue,
  AttachOptions,
  Copy,
  Effect,
  EffectHandle,
  EffectInstance,
  EffectsStats,
  EffectsStatus,
  EffectUse,
  InstanceStatus,
  TakeOptions,
} from './types'

/** The part of `@dioramajs/assets` effects uses, typed structurally to avoid importing it. */
export interface AssetsPort {
  acquire<T>(
    key: string,
    make: (context: {
      readonly signal: AbortSignal
      decode<R>(work: () => Promise<R>): Promise<R>
    }) => Promise<{ readonly value: T; readonly bytes?: number; dispose?(): void }>,
    options?: { readonly priority?: 'high' | 'normal' | 'low'; readonly weight?: number },
  ): { readonly ready: Promise<T>; release(): void }
  track(
    work: PromiseLike<unknown>,
    options?: { readonly weight?: number; readonly priority?: 'high' | 'normal' | 'low' },
  ): void
  load(
    url: string,
    options: {
      readonly type: string
      readonly priority?: 'high' | 'normal' | 'low'
      readonly options?: Readonly<Record<string, string>>
    },
  ): { readonly ready: Promise<unknown>; release(): void }
}

/** The app as the effects plugin sees it. */
export type EffectsView = PluginApp<
  Pick<Services, 'stage' | 'scroll' | 'pointer' | 'anchors'> & {
    readonly render?: RenderApi
    readonly assets?: AssetsPort
  }
>

/** Why the runtime lets go of an instance. */
export type ReleaseReason =
  | 'removed'
  | 'detached'
  | 'disabled'
  | 'failed'
  | 'engine'
  | 'destroy'
  | 'handover'
  | 'restart'

/** A runtime write of one param, ordered against the writes of other sources. */
export interface Write {
  readonly value: unknown
  readonly sequence: number
}

/** One effect on one element: the pair the light part tracks through its whole life. */
export interface InstanceRecord {
  readonly element: Element
  readonly name: string
  readonly facade: EffectInstance
  readonly state: Signal<InstanceStatus>
  status: InstanceStatus
  error: unknown
  effect: Effect | undefined
  /** Bumped by each mount attempt and each abandoned one. A stale attempt sees a newer one. */
  generation: number
  abort: AbortController | undefined
  /** Previous mount attempt. A new one waits for it, so a pair never runs two setups. */
  settled: Promise<unknown>
  /** Listed in the element's `data-dio`. */
  markup: boolean
  readonly handles: Set<HandleState>
  /** `instance.params` writes. They belong to the pair and survive re-creation. */
  readonly writes: Map<string, Write>
  /** Values last given to the runtime. */
  values: Record<string, AnyParamValue>
  /** The entry's `presence`, which beats the definition's. */
  presence: 'fade' | 'custom' | undefined
  /** Loop frame at which the instance was parked. */
  parkedFrame: number
  /** Creation order on the element, for code sources. */
  readonly order: number
  /** Adds accessors for param keys known by now. */
  sync(): void
}

/** One `attach` call: its params, writes, and the records it feeds. */
export interface HandleState {
  readonly id: number
  readonly name: string
  readonly params: Record<string, unknown>
  readonly writes: Map<string, Write>
  readonly options: AttachOptions
  /** The selector of a selector target. */
  readonly rule: string | undefined
  /** Runtime-owned rules match descendants of this element only. */
  readonly within: Element | undefined
  /** Element targets, held weakly. */
  readonly refs: WeakRef<Element>[]
  readonly records: Set<InstanceRecord>
  live: boolean
  sync(): void
}

/** What the light part needs from the runtime. */
export interface Runtime {
  /**
   * Prepares media if declared, runs setup and compiles. Resolves once the attempt settles.
   * 'aborted' means a newer generation took over, 'off' that the quality tier is below the
   * effect's minimum.
   */
  mount(
    instance: InstanceRecord,
    signal: AbortSignal,
  ): Promise<'running' | 'failed' | 'aborted' | 'off'>
  /** Hides or brings back a mounted instance. `connected` picks the drawn rule. */
  park(instance: InstanceRecord, parked: boolean, connected: boolean): void
  /** Writes a live param into its uniform and requests a frame if visible. */
  write(instance: InstanceRecord, name: string, value: AnyParamValue): void
  /** Re-runs setup in two phases at the next frame where the instance is visible. */
  rebuild(instance: InstanceRecord): void
  /** Disposes everything the instance created and releases layer leases. Needs no frame. */
  unmount(instance: InstanceRecord, reason: ReleaseReason): void
  /** Leases a layer for an element without an effect, for `layers()`. */
  lease(element: Element, owner: InstanceRecord): Off
  /** Called after a reconcile pass to re-read live `layers()` queries and effect order. */
  scanned(): void
  /** The element left the document. True if its copy stays as a ghost or a burst flies on. */
  handover(element: Element): boolean
  take(element: Element, options?: TakeOptions): Copy
  stats(): EffectsStats
  dispose(): void
}

/** What the runtime gets from the light part. */
export interface RuntimeHost {
  /** Recomputed on each call. */
  values(instance: InstanceRecord): Readonly<Record<string, AnyParamValue>>
  /** In effect order: markup tokens first, then code sources. */
  instancesOf(element: Element): readonly InstanceRecord[]
  /** Sets the runtime-owned `data-dio-state`. `undefined` hands it back. */
  present(element: Element, state: 'live' | 'drawn' | undefined): void
  /** Records a failure inside `mount`, which then resolves 'failed'. */
  report(instance: InstanceRecord, error: unknown): void
  /** A mounted instance failed in update or compile. Reports and unmounts it. */
  fail(instance: InstanceRecord, error: unknown): void
  /** Device lost or render disabled. Every instance becomes `unavailable`. */
  lost(): void
  /** A pose touched this element's layer, so its waiting instances load at once. */
  wake(element: Element): void
  /** The newest `app.effects.pin` source of the element. */
  pin(element: Element): (() => number) | undefined
  /** `data-dio-track`, else the attach options. */
  track(element: Element): 'live' | 'layout' | 'frame'
  /** The runtime saw the element disconnected. Re-evaluates its instances. */
  check(element: Element): void
  /** Media of a failed element changed, so EFFECT_MEDIA and EFFECT_CORS failures wait again. */
  retry(element: Element): void
  /** Attach owned by the runtime (`ctx.attach`, `layers()`). A selector stays inside `within`. */
  attach(target: string | Element, use: Effect | EffectUse, within?: Element): EffectHandle
  /** Plugins started after `effects`. The drawn hook runs after them. */
  plugins(): readonly string[]
  /** One warning per (element, key). */
  warn(key: string, error: EffectError): void
  /** Sets `data-dio-state="entering"`. The light part owns veils. */
  veil(element: Element, on: boolean): void
  /** Adds the element to the next reconcile without flushing now. */
  queue(element: Element): void
  /** Unmounts and mounts again, so a quality tier change can turn an instance off or back on. */
  restart(instance: InstanceRecord): void
}

/** What the controller needs from the DOM side. */
export interface DomPort {
  inRoot(element: Element): boolean
  query(selector: string): Iterable<Element>
  claim(element: Element): boolean
  release(element: Element): void
  /** Re-derives `data-dio-state` of an element. */
  sync(element: Element): void
  /** Observes param attributes of loaded effects. An empty list stops observing. */
  watch(element: Element, attributes: readonly string[]): void
  /** Starts or stops watching `class` and `id` for selector rules. */
  rules(active: boolean): void
  /** Adds or removes the hiding stylesheet. */
  adopt(on: boolean): void
  /** Hides an element in view until its intro effect draws it. */
  intro(element: Element): void
  present: WeakMap<Element, 'live' | 'drawn'>
}

/** What the controller needs from the engine gate. */
export interface EnginePort {
  readonly runtime: Runtime | undefined
  /** Set once the gate decided that no instance runs. */
  readonly blocked: 'off' | 'unavailable' | undefined
  boot(): Promise<Runtime | undefined>
  /** A near or eager element asks for the engine. Obeys the load mode. */
  request(eager: boolean): void
  /**
   * Downloads the engine and these definitions once the gate is open, without starting
   * `render`. A closed gate blocks every instance and downloads nothing.
   */
  fetch(names: readonly string[]): Promise<unknown>
  near(element: Element): boolean
  /** The observer has reported the element since it was last watched. */
  reported(element: Element): boolean
  /** Bumped after each observer callback. */
  readonly intersections: ReadonlySignal<number>
  canBoot(): boolean
  readonly loading: boolean
  readonly status: ReadonlySignal<EffectsStatus>
  matches(query: string): boolean
  reducedMotion(): boolean
  watch(element: Element, on: boolean): void
}
