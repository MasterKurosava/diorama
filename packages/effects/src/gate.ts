import { isDioramaError, type PluginEntry, type Signal, signal } from '@diorama/core'
import type { RenderApi } from '@diorama/render'
import { EffectError } from './errors'
import type { Controller, EnginePort, Runtime, RuntimeHost } from './instances'
import type { EffectsOptions, EffectsStatus } from './types'

type RuntimeModule = typeof import('./runtime/index')

interface Probe {
  connection?: { saveData?: boolean }
  gpu?: { requestAdapter(): Promise<unknown> }
}
const nav = (): Probe => (typeof navigator === 'undefined' ? {} : (navigator as Probe))
const saveData = (): boolean => nav().connection?.saveData === true

/** Resolves after the first paint, so the engine does not compete with critical loads. */
const painted = (): Promise<void> =>
  new Promise((resolve) => {
    const frames = (): void => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', frames, { once: true })
    } else frames()
  })

/** WebGPURenderer falls back to WebGL 2, so either backend is enough. */
async function probe(): Promise<'ok' | 'off' | 'unavailable'> {
  if (saveData()) return 'off'
  const gl = document.createElement('canvas').getContext('webgl2')
  if (gl) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return 'ok'
  }
  const gpu = nav().gpu
  if (!gpu) return 'unavailable'
  const adapter = await gpu.requestAdapter().catch(() => null)
  return adapter ? 'ok' : 'unavailable'
}

/** Nearness, the engine boot, the GPU gate, media queries and prefetch. */
export class Engine implements EnginePort {
  readonly status: Signal<EffectsStatus> = signal<EffectsStatus>('idle')
  readonly intersections: Signal<number> = signal(0)
  runtime: Runtime | undefined
  render: RenderApi | undefined
  blocked: 'off' | 'unavailable' | undefined
  loading = false
  /** Plugins that started after `effects` (extend, postfx from a panel). */
  readonly plugins: Set<string> = new Set()
  readonly #ctl: Controller
  readonly #options: EffectsOptions
  readonly #host: RuntimeHost
  readonly #io: IntersectionObserver | undefined
  readonly #near = new WeakSet<Element>()
  readonly #reported = new WeakSet<Element>()
  readonly #queries = new Map<string, MediaQueryList>()
  #boot: Promise<Runtime | undefined> | undefined
  #gate: Promise<'ok' | 'off' | 'unavailable'> | undefined
  #module: Promise<RuntimeModule> | undefined
  #painted: Promise<void> | undefined
  #failures = 0
  /** Someone else stopped `render`. Don't fight the site for it. */
  #external = false
  #requested = false
  #lost = false

  constructor(ctl: Controller, options: EffectsOptions, host: RuntimeHost) {
    this.#ctl = ctl
    this.#options = options
    this.#host = host
    if (typeof IntersectionObserver === 'function') {
      this.#io = new IntersectionObserver((entries) => this.#intersect(entries), {
        rootMargin: options.margin,
      })
    }
  }

  start(): void {
    const { app } = this.#ctl
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
    this.#io?.disconnect()
    this.runtime?.dispose()
    this.runtime = undefined
  }

  #intersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      this.#reported.add(e.target)
      if (e.isIntersecting) this.#near.add(e.target)
      else this.#near.delete(e.target)
    }
    for (const e of entries) {
      if (e.isIntersecting) for (const rec of this.#ctl.of(e.target)) this.#ctl.advance(rec)
    }
    this.intersections.value++
  }

  near(el: Element): boolean {
    return !this.#io || this.#near.has(el)
  }

  reported(el: Element): boolean {
    return !this.#io || this.#reported.has(el)
  }

  /** A posed layer loads its waiting instances without waiting for the observer. */
  force(el: Element): void {
    this.#near.add(el)
    for (const rec of this.#ctl.of(el)) this.#ctl.advance(rec)
  }

  watch(el: Element, on: boolean): void {
    if (on) this.#io?.observe(el)
    else {
      this.#io?.unobserve(el)
      this.#near.delete(el)
      this.#reported.delete(el)
    }
  }

  matches(query: string): boolean {
    if (typeof matchMedia !== 'function') return true
    let list = this.#queries.get(query)
    if (!list) {
      list = matchMedia(query)
      this.#queries.set(query, list)
      const signal = this.#ctl.app.abortSignal
      list.addEventListener('change', () => this.#ctl.refresh(), { signal })
    }
    return list.matches
  }

  reducedMotion(): boolean {
    return this.#ctl.app.stage.reducedMotion.peek()
  }

  canBoot(): boolean {
    if (this.blocked || this.#external || this.#failures >= 2) return false
    return this.#options.load !== 'manual' || this.#requested || this.loading || !!this.runtime
  }

  request(eager: boolean): void {
    if (this.#boot || this.runtime || !this.canBoot()) return
    if (eager) void this.boot()
    else if (this.#options.load === 'near') {
      this.#painted ??= painted()
      void this.#painted.then(() => {
        if (!this.#ctl.app.abortSignal.aborted) void this.boot()
      })
    }
  }

  load(): Promise<boolean> {
    this.#requested = true
    this.#external = false
    return this.boot().then((runtime) => runtime !== undefined)
  }

  fetch(): void {
    if (this.runtime || this.#boot || !this.canBoot()) return
    void this.#gated().then((gate) => {
      if (gate === 'ok' && !this.#ctl.app.abortSignal.aborted) void this.#import()
    })
  }

  /** Probed once per app. */
  #gated(): Promise<'ok' | 'off' | 'unavailable'> {
    const { enabled } = this.#options
    this.#gate ??= enabled === 'auto' ? probe() : Promise.resolve(enabled ? 'ok' : 'off')
    return this.#gate
  }

  /** Downloaded once. A rejection is handled where it is awaited. */
  #import(): Promise<RuntimeModule> {
    if (!this.#module) {
      this.#module = import('./runtime/index')
      this.#module.catch(() => {})
    }
    return this.#module
  }

  boot(): Promise<Runtime | undefined> {
    if (this.runtime) return Promise.resolve(this.runtime)
    if (this.blocked || this.#failures >= 2) return Promise.resolve(undefined)
    this.#boot ??= this.#start()
    return this.#boot
  }

  /** Runs once per app. Every await is followed by an abort check. */
  async #start(): Promise<Runtime | undefined> {
    const { app } = this.#ctl
    const signal = app.abortSignal
    const options = this.#options
    // Always awaited: `boot()` must store this promise before anything below re-enters it.
    const gate = await this.#gated()
    if (signal.aborted) return undefined
    if (gate !== 'ok') return this.#block(gate, true)
    this.loading = true
    this.status.value = 'loading'
    this.#ctl.refresh()
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
    if (signal.aborted) return undefined
    try {
      const found = app.find('render')
      if (found && Object.keys(options.render).length) {
        app.log.warn('render is already running: the render options of effects are ignored')
      }
      // Use it through the effects view, so removing effects also stops the render it added.
      this.render = found ?? (await app.use(module.render(options.render)))
    } catch {
      // The kernel already reported the failed setup.
      return signal.aborted ? undefined : this.#block('unavailable', false)
    }
    for (const extend of options.extend) {
      if (signal.aborted) return undefined
      try {
        // Own transaction, so a failing postfx does not roll back render.
        await app.use([await extend()].flat() as PluginEntry[])
      } catch (error) {
        if (!signal.aborted && !isDioramaError(error, 'PLUGIN_SETUP')) {
          app.report(error, 'effects:extend')
        }
      }
    }
    if (signal.aborted) return undefined
    this.runtime = module.start(app, this.#host)
    this.loading = false
    this.#ctl.dom.adopt(true)
    this.status.value = 'ready'
    this.#ctl.refresh()
    return this.runtime
  }

  #block(kind: 'off' | 'unavailable', report: boolean): undefined {
    this.blocked = kind
    this.loading = false
    this.status.value = kind
    if (report && kind === 'unavailable') {
      const error = new EffectError('RENDER_UNAVAILABLE', 'neither WebGPU nor WebGL 2 is available')
      this.#ctl.app.report(error, 'engine')
    }
    this.#ctl.refresh()
    return undefined
  }

  /** `render` was stopped from outside. Instances wait and the page is plain again. */
  #stop(): void {
    this.#ctl.orphan()
    this.runtime?.dispose()
    this.runtime = undefined
    this.render = undefined
    this.#boot = undefined
    this.#external = true
    this.#ctl.dom.adopt(false)
    this.status.value = 'idle'
  }

  /** Device lost or render disabled. Everything becomes `unavailable`. */
  lost(): void {
    if (!this.runtime) return
    if (!this.#lost) {
      this.#lost = true
      this.#ctl.app.report(new EffectError('RENDER_LOST', 'the GPU device was lost'), 'engine')
    }
    this.blocked = 'unavailable'
    this.#ctl.refresh()
    this.runtime.dispose()
    this.runtime = undefined
    this.#ctl.dom.adopt(false)
    this.status.value = 'unavailable'
  }

  /** Downloads (not starts) the engine and the markup's effects in idle time. */
  #prefetch(): void {
    if (!this.#options.prefetch || saveData() || this.#options.enabled === false) return
    const { app } = this.#ctl
    const fetch = (): void => {
      if (app.abortSignal.aborted || this.blocked) return
      const { live, registry } = this.#ctl
      // Off instances and unknown names load neither module.
      const waiting = [...live].filter(
        (r) => r.markup && r.status === 'waiting' && registry.entries.has(r.name),
      )
      if (!waiting.length) return
      void this.#import()
      for (const name of new Set(waiting.map((r) => r.name))) void registry.load(name)
    }
    const idle = (): void => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fetch)
      else setTimeout(fetch, 1)
    }
    if (document.readyState === 'complete') idle()
    else window.addEventListener('load', idle, { once: true, signal: app.abortSignal })
  }
}
