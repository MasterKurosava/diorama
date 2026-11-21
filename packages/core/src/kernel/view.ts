/**
 * Views are what plugins, scopes and the app itself see as `app`. All views of one app share a
 * prototype and reach their kernel and owner through two symbols, so a scope per entity stays
 * cheap and a call allocates nothing.
 * @module
 */
import type { Kernel } from './app'
import { RESERVED } from './config'
import type { LoopImpl } from './loop'
import type { Owner } from './scope'
import { ownedEffect } from './signals'
import type {
  AppState,
  Cleanup,
  DependencyRef,
  FrameDriver,
  FrameProfiler,
  Logger,
  LoopSettings,
  Off,
  OrderOptions,
  ReadonlySignal,
  RemoveOptions,
  StagePosition,
  System,
  SystemHandle,
} from './types'
import { noop } from './util'

export const OWNER: unique symbol = Symbol('diorama.owner') as never
export const KERNEL: unique symbol = Symbol('diorama.kernel') as never

export interface View {
  readonly [OWNER]: Owner
  readonly [KERNEL]: Kernel
}

const kernelOf = (view: unknown): Kernel => (view as View)[KERNEL]
const ownerOf = (view: unknown): Owner => (view as View)[OWNER]

/** The App API every view has. Registrations belong to the view's owner. */
const VIEW_METHODS = {
  use(entry: unknown): Promise<unknown> {
    return kernelOf(this).use(entry, ownerOf(this))
  },
  remove(ref: DependencyRef, options?: RemoveOptions): Promise<boolean> {
    return kernelOf(this).remove(ref, options, ownerOf(this))
  },
  has(ref: DependencyRef): boolean {
    return kernelOf(this).has(ref)
  },
  get(ref: DependencyRef): unknown {
    return kernelOf(this).service(ownerOf(this), ref, true)
  },
  find(ref: DependencyRef): unknown {
    return kernelOf(this).service(ownerOf(this), ref, false)
  },
  on(name: string, listener: (payload: unknown) => unknown): Off {
    return kernelOf(this).events.on(name, listener, ownerOf(this), false)
  },
  once(name: string, listener: (payload: unknown) => unknown): Off {
    return kernelOf(this).events.on(name, listener, ownerOf(this), true)
  },
  emit(name: string, payload?: unknown): void {
    if (!ownerOf(this).disposed) kernelOf(this).events.emit(name, payload)
  },
  hook(
    name: string,
    handler: (value: unknown, context: unknown) => unknown,
    options?: OrderOptions,
  ): Off {
    return kernelOf(this).hooks.add(name, handler, ownerOf(this), options)
  },
  callHook(name: string, value: unknown, context?: unknown): unknown {
    return ownerOf(this).disposed ? value : kernelOf(this).hooks.call(name, value, context)
  },
  callHookAsync(name: string, value: unknown, context?: unknown): Promise<unknown> {
    return ownerOf(this).disposed
      ? Promise.resolve(value)
      : kernelOf(this).hooks.callAsync(name, value, context)
  },
  hookVersion(name: string): number {
    return kernelOf(this).hooks.version(name)
  },
  get loop(): LoopImpl {
    return kernelOf(this).loop
  },
  system(stage: string, run: System, options?: OrderOptions): SystemHandle {
    return kernelOf(this).loop.system(stage, run, options, ownerOf(this))
  },
  addStage(name: string, position: StagePosition): Off {
    return kernelOf(this).loop.addStage(name, position, ownerOf(this))
  },
  invalidate(): void {
    const owner = ownerOf(this)
    if (!owner.disposed) kernelOf(this).loop.invalidate(owner)
  },
  keepAwake(seconds: number): void {
    const owner = ownerOf(this)
    if (!owner.disposed) kernelOf(this).loop.keepAwake(owner, seconds)
  },
  hold(): Off {
    return kernelOf(this).loop.hold(ownerOf(this))
  },
  pause(): Off {
    return kernelOf(this).loop.pause(ownerOf(this))
  },
  overrideLoop(settings: LoopSettings): Off {
    return kernelOf(this).loop.overrideLoop(ownerOf(this), settings)
  },
  setDriver(driver: FrameDriver): Off {
    return kernelOf(this).loop.setDriver(ownerOf(this), driver)
  },
  profile(profiler: FrameProfiler): Off {
    return kernelOf(this).loop.profile(ownerOf(this), profiler)
  },
  effect(fn: () => unknown): Off {
    const kernel = kernelOf(this)
    const owner = ownerOf(this)
    if (!owner.open()) return noop
    return owner.add(ownedEffect(fn, (error) => kernel.report(error, 'effect', owner)))
  },
  scope(): unknown {
    return kernelOf(this).view(ownerOf(this).child(), true)
  },
  onDispose(cleanup: Cleanup): Off {
    return ownerOf(this).add(typeof cleanup === 'function' ? cleanup : () => cleanup.dispose())
  },
  get abortSignal(): AbortSignal {
    return ownerOf(this).signal
  },
  get log(): Logger {
    return ownerOf(this).log
  },
  report(error: unknown, target?: string): void {
    const owner = ownerOf(this)
    // An AbortError after this view's own abort is the expected outcome, not a failure.
    if ((error as { name?: unknown } | null)?.name === 'AbortError' && owner.signal.aborted) return
    kernelOf(this).report(error, 'report', owner, target)
  },
}

/** Lifecycle members of the view `createApp` returns. */
export const ROOT_METHODS = {
  get name(): string {
    return kernelOf(this).name
  },
  get state(): ReadonlySignal<AppState> {
    return kernelOf(this).state
  },
  start(): Promise<unknown> {
    return kernelOf(this).start()
  },
  destroy(): Promise<void> {
    return kernelOf(this).destroy()
  },
}

/** Members of a view made by `app.scope()`. */
export const SCOPE_METHODS = {
  dispose(): Promise<void> {
    return ownerOf(this).dispose()
  },
  get disposed(): boolean {
    return ownerOf(this).disposed
  },
}

export const describe = (methods: object): PropertyDescriptorMap =>
  Object.getOwnPropertyDescriptors(methods)

export const VIEW_PROTO: object = Object.defineProperties({}, describe(VIEW_METHODS))

/** Whether a plugin name would shadow a member of the App API. */
export const isReserved = (name: string): boolean =>
  // Check the method objects, not a live view, which also carries service getters.
  name in VIEW_PROTO ||
  name in ROOT_METHODS ||
  name in SCOPE_METHODS ||
  (RESERVED as readonly string[]).includes(name)
