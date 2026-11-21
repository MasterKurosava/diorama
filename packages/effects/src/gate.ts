// The engine gate. Decides once per app whether effects may run at all (Save-Data, WebGPU or
// WebGL 2 present), then downloads and starts the engine when an element comes near, after the
// first paint, eagerly or on `load()`. Also tracks nearness with an IntersectionObserver and
// answers media queries, and prefetches the markup's effects in idle time.
import { isDioramaError, type PluginEntry, type Signal, signal } from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import { DEV } from './define'
import { EffectError } from './errors'
import type { Controller } from './instances'
import type { EnginePort, Runtime, RuntimeHost } from './ports'
import { canSlice, slice } from './slice'
import type { EffectsOptions, EffectsStatus } from './types'

type RuntimeModule = typeof import('./runtime/index')
type GateResult = 'ok' | 'off' | 'unavailable'

/** The navigator features the gate reads. */
interface NavigatorFeatures {
  connection?: { saveData?: boolean }
  gpu?: { requestAdapter(options?: { featureLevel?: string }): Promise<unknown> }
}

/** Longest wait for a WebGPU adapter before WebGL 2 is asked instead, ms. */
const ADAPTER_WAIT = 1000
/** Rejected engine imports after which the app stops trying until `load()`. */
const MAX_BOOT_FAILURES = 2

const features = (): NavigatorFeatures =>
  typeof navigator === 'undefined' ? {} : (navigator as NavigatorFeatures)
const saveData = (): boolean => features().connection?.saveData === true

export class Engine implements EnginePort {
  readonly status: Signal<EffectsStatus> = signal<EffectsStatus>('idle')
  readonly intersections: Signal<number> = signal(0)
  runtime: Runtime | undefined
  render: RenderApi | undefined
  blocked: 'off' | 'unavailable' | undefined
  loading = false
  /** Plugins that started after `effects` (extend, postfx from a panel). */
  readonly plugins: Set<string> = new Set()
  readonly #controller: Controller
  readonly #options: EffectsOptions
  readonly #host: RuntimeHost
  readonly #observer: IntersectionObserver | undefined
  readonly #near = new WeakSet<Element>()
  readonly #reported = new WeakSet<Element>()
  readonly #queries = new Map<string, MediaQueryList>()
  #boot: Promise<Runtime | undefined> | undefined
  #gate: Promise<boolean> | undefined
  #module: Promise<RuntimeModule> | undefined
  #three: Promise<unknown> | undefined
  #painted: Promise<void> | undefined
  #failures = 0
  /** Someone else stopped `render`. Don't fight the site for it. */
  #external = false
  #requested = false
  #lost = false

  constructor(controller: Controller, options: EffectsOptions, host: RuntimeHost) {
    this.#controller = controller
    this.#options = options
    this.#host = host
    if (typeof IntersectionObserver === 'function') {
      this.#observer = new IntersectionObserver((entries) => this.#intersect(entries), {
        rootMargin: options.margin,
      })
    }
  }

  start(): void {
    const { app } = this.#controller
    app.on('app:start', () => {
      if (this.#options.load === 'eager') void this.load()
    })
    app.on('plugin:status', ({ name, status }) => {
      if (status === 'running') this.plugins.add(name)
      else if (status !== 'starting') this.plugins.delete(name)
      if (name !== 'render' || app.abortSignal.aborted) return
      if (status === 'stopping' && this.runtime) this.#stop()
      else if (status === 'running' && this.#external) {
        this.#external = false
        void this.boot()
      }
    })
    this.#prefetch()
  }

  destroy(): void {
    this.#observer?.disconnect()
    this.runtime?.dispose()
    this.runtime = undefined
  }

  near(element: Element): boolean {
    return !this.#observer || this.#near.has(element)
  }

  reported(element: Element): boolean {
    return !this.#observer || this.#reported.has(element)
  }

  /** A posed layer loads its waiting instances without waiting for the observer. */
  force(element: Element): void {
    this.#near.add(element)
    for (const record of this.#controller.of(element)) this.#controller.advance(record)
  }

  watch(element: Element, on: boolean): void {
    if (on) {
      this.#observer?.observe(element)
      return
    }
    this.#observer?.unobserve(element)
    this.#near.delete(element)
    this.#reported.delete(element)
  }

  matches(query: string): boolean {
    if (typeof matchMedia !== 'function') return true
    let list = this.#queries.get(query)
    if (!list) {
      list = matchMedia(query)
      this.#queries.set(query, list)
      const signal = this.#controller.app.abortSignal
      list.addEventListener('change', () => this.#controller.refresh(), { signal })
    }
    return list.matches
  }

  reducedMotion(): boolean {
    return this.#controller.app.stage.reducedMotion.peek()
  }

  canBoot(): boolean {
    if (this.blocked || this.#external || this.#failures >= MAX_BOOT_FAILURES) return false
    return this.#options.load !== 'manual' || this.#requested || this.loading || !!this.runtime
  }

  request(eager: boolean): void {
    if (this.#boot || this.runtime || !this.canBoot()) return
    if (eager) void this.boot()
    else if (this.#options.load === 'near') {
      this.#painted ??= painted()
      void this.#painted.then(() => {
        if (!this.#controller.app.abortSignal.aborted) void this.boot()
      })
    }
  }

  load(): Promise<boolean> {
    this.#requested = true
    this.#external = false
    return this.boot().then((runtime) => runtime !== undefined)
  }

  /** Downloads the engine and these definitions once the gate is open. Starts nothing. */
  fetch(names: readonly string[]): Promise<unknown> {
    return this.#gated().then(async (open) => {
      const { app, registry } = this.#controller
      if (!open || app.abortSignal.aborted) return
      // Lazy entries first: what their maps turn off downloads neither module nor engine.
      await Promise.all(names.map((name) => registry.resolve(name)))
      if (app.abortSignal.aborted) return
      const wanted = names.filter(
        (name) => !registry.entries.get(name)?.failed && !this.#controller.skips(name),
      )
      if (!wanted.length) return
      void this.#import()
      return Promise.all(wanted.map((name) => registry.load(name)))
    })
  }

  /**
   * Where tasks can be sliced, three's core and TSL evaluate in a task of their own before the
   * engine and the effect modules, which import them too: otherwise all of three evaluates with
   * the first module that arrives, one long task. Undefined where nothing waits.
   */
  three(): Promise<unknown> | undefined {
    if (!canSlice()) return undefined
    this.#three ??= import('three/tsl').then(slice)
    // A failed import is reported by the module that needs it.
    return this.#three.catch(() => {})
  }

  boot(): Promise<Runtime | undefined> {
    if (this.runtime) return Promise.resolve(this.runtime)
    if (this.blocked || this.#failures >= MAX_BOOT_FAILURES) return Promise.resolve(undefined)
    this.#boot ??= this.#start()
    return this.#boot
  }

  /** Device lost or render disabled. Everything becomes `unavailable`. */
  lost(): void {
    if (!this.runtime) return
    if (!this.#lost) {
      this.#lost = true
      const error = new EffectError('RENDER_LOST', 'the GPU device was lost')
      this.#controller.app.report(error, 'engine')
    }
    this.blocked = 'unavailable'
    this.#controller.refresh()
    this.runtime.dispose()
    this.runtime = undefined
    this.#controller.dom.adopt(false)
    this.status.value = 'unavailable'
  }

  #intersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      this.#reported.add(entry.target)
      if (entry.isIntersecting) this.#near.add(entry.target)
      else this.#near.delete(entry.target)
    }
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      for (const record of this.#controller.of(entry.target)) this.#controller.advance(record)
    }
    this.intersections.value++
  }

  /**
   * Probed once per app, before any effect module or the engine downloads. A refusal blocks
   * every instance.
   */
  #gated(): Promise<boolean> {
    if (!this.#gate) {
      const { enabled, render } = this.#options
      const rendering = Boolean(this.#controller.app.find('render'))
      this.#gate = probeGpu(enabled, rendering, render.forceWebGL === true).then((result) => {
        if (result !== 'ok' && !this.#controller.app.abortSignal.aborted) this.#block(result, true)
        return result === 'ok'
      })
    }
    return this.#gate
  }

  /** Downloaded once. A rejection is handled where it is awaited. */
  #import(): Promise<RuntimeModule> {
    if (!this.#module) {
      const three = this.three()
      this.#module = three ? three.then(() => import('./runtime/index')) : import('./runtime/index')
      this.#module.catch(() => {})
    }
    return this.#module
  }

  /**
   * The boot: gate, engine download, render, `extend` plugins, runtime. Each step runs in its own
   * task where tasks can be sliced. Runs once per app; every await is followed by an abort check.
   */
  async #start(): Promise<Runtime | undefined> {
    const { app } = this.#controller
    const signal = app.abortSignal
    // Always awaited: `boot()` must store this promise before anything below re-enters it.
    if (!(await this.#gated()) || signal.aborted) return undefined
    this.loading = true
    this.status.value = 'loading'
    this.#controller.refresh()
    let module: RuntimeModule
    try {
      module = await this.#import()
    } catch (cause) {
      if (signal.aborted) return undefined
      this.#module = undefined
      this.#failures++
      this.loading = false
      this.#boot = undefined
      this.status.value = 'unavailable'
      app.report(new EffectError('EFFECT_LOAD', 'the engine failed to load', { cause }), 'engine')
      return undefined
    }
    // The engine evaluated in the previous task.
    await slice()
    if (signal.aborted) return undefined
    const options = this.#options
    try {
      const found = app.find('render')
      if (found && Object.keys(options.render).length) {
        app.log.warn('render is already running: the render options of effects are ignored')
      }
      // Use it through the effects view, so removing effects also stops the render it added.
      this.render = found ?? (await app.use(module.render(options.render)))
    } catch {
      // The kernel already reported the failed setup.
      if (!signal.aborted) this.#block('unavailable', false)
      return undefined
    }
    // The `extend` plugins, each in its own transaction so a failing one does not undo render.
    for (const extend of options.extend) {
      if (signal.aborted) return undefined
      try {
        await app.use([await extend()].flat() as PluginEntry[])
      } catch (error) {
        if (!signal.aborted && !isDioramaError(error, 'PLUGIN_SETUP')) {
          app.report(error, 'effects:extend')
        }
      }
    }
    // Render's setup ended in the previous task.
    await slice()
    if (signal.aborted) return undefined
    this.runtime = module.start(app, this.#host)
    this.loading = false
    this.#controller.dom.adopt(true)
    this.status.value = 'ready'
    this.#controller.refresh()
    return this.runtime
  }

  #block(kind: 'off' | 'unavailable', probed: boolean): void {
    this.blocked = kind
    this.loading = false
    this.status.value = kind
    // No GPU is expected on some visitors' browsers, not an error: a dev warning, silent in
    // production. Sites follow `status` and `data-dio-state`.
    if (DEV && probed && kind === 'unavailable') {
      const error = new EffectError('RENDER_UNAVAILABLE', 'neither WebGPU nor WebGL 2 is available')
      this.#controller.warn('unavailable', error)
    }
    this.#controller.refresh()
  }

  /** `render` was stopped from outside. Instances wait and the page is plain again. */
  #stop(): void {
    this.#controller.orphan()
    this.runtime?.dispose()
    this.runtime = undefined
    this.render = undefined
    this.#boot = undefined
    this.#external = true
    this.#controller.dom.adopt(false)
    this.status.value = 'idle'
  }

  /** Downloads (not starts) the engine and the markup's effects in idle time. */
  #prefetch(): void {
    if (!this.#options.prefetch || saveData() || this.#options.enabled === false) return
    const { app } = this.#controller
    const fetch = (): void => {
      if (app.abortSignal.aborted || this.blocked) return
      const { live, registry } = this.#controller
      // Off instances and unknown names load neither module, and nothing loads past a closed gate.
      const waiting = [...live].filter(
        (record) =>
          record.markup && record.status === 'waiting' && registry.entries.has(record.name),
      )
      if (waiting.length) void this.fetch(waiting.map((record) => record.name))
    }
    const idle = (): void => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fetch)
      else setTimeout(fetch, 1)
    }
    if (document.readyState === 'complete') idle()
    else window.addEventListener('load', idle, { once: true, signal: app.abortSignal })
  }
}

/** Resolves after the first paint, so the engine does not compete with critical loads. */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    const twoFrames = (): void => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', twoFrames, { once: true })
    } else twoFrames()
  })
}

/**
 * WebGPURenderer falls back to WebGL 2, so either backend is enough; `forceWebGL` needs WebGL 2.
 * `true` skips only the Save-Data rule: without a GPU the page stays plain, as with 'auto'. A DOM
 * without either API (a server or test DOM) cannot be asked and is trusted with `true`.
 */
async function probeGpu(
  enabled: boolean | 'auto',
  rendering: boolean,
  webgl: boolean,
): Promise<GateResult> {
  if (!enabled) return 'off'
  if (enabled === 'auto' && saveData()) return 'off'
  // A running render has its context already.
  if (rendering) return 'ok'
  const gpu = features().gpu
  if (enabled === true && !gpu && typeof WebGL2RenderingContext === 'undefined') return 'ok'
  // WebGPU first: an adapter request does not block the page, while a WebGL context does with
  // synchronous GPU calls (over 100 ms at startup on a 4x slower CPU).
  if (gpu && !webgl && (await hasAdapter(gpu))) return 'ok'
  await slice()
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return 'unavailable'
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return 'ok'
}

/** Whether the browser gives a WebGPU adapter, asked as three asks; no answer in time is no. */
function hasAdapter(gpu: NonNullable<NavigatorFeatures['gpu']>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, ADAPTER_WAIT, false)
  })
  const answer = Promise.resolve()
    .then(() => gpu.requestAdapter({ featureLevel: 'compatibility' }))
    .then(
      (found) => found != null,
      () => false,
    )
  return Promise.race([answer, late]).finally(() => clearTimeout(timer))
}
