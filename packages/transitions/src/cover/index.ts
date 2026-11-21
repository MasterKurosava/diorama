// Entry `@dioramajs/transitions/cover`: a GL cover over the page while it changes. Light: the looks
// and three load in their own chunks on first use.
//
// The cover runs on a clock from 0 to 2: it closes over the old page (0 to 1), waits while the
// page changes under it, then opens off the new page (1 to 2). Link clicks are held until it has
// closed and then passed on to the router or the browser.
import {
  definePlugin,
  definePreset,
  type FrameTime,
  type Off,
  type Plugin,
  type Preset,
  type Signal,
  signal,
} from '@dioramajs/core'
import type { Effect, EffectHandle } from '@dioramajs/effects'
import type {} from '../types'
import type {
  CoverApi,
  CoverName,
  CoverOptions,
  CoverOrigin,
  CoverState,
  CoverTiming,
} from './types'

export type * from './types'

/** Settings of the `cover` plugin; `cover()` makes them from flat options. */
export interface CoverSettings extends CoverTiming {
  /** A ready-made cover by name, or an effect with a `position` param. */
  readonly look: CoverName | Effect
  /** Params of the look's effect. */
  readonly params: Readonly<Record<string, unknown>>
}

interface View {
  readonly abortSignal: AbortSignal
  readonly effects: import('@dioramajs/effects').EffectsApi
  readonly assets?: { ready(): Promise<void> } | undefined
  readonly stage: import('@dioramajs/core').StageApi
  readonly loop: {
    readonly stats: { readonly reason: string; readonly interval: number }
    readonly timeScale: number
  }
  system(phase: 'layout', fn: (time: FrameTime) => void, options: object): unknown
  hold(reason: string): Off
  invalidate(): void
  on(event: 'page:enter', fn: () => void): Off
  onDispose(cleanup: () => void): unknown
  report(error: unknown, origin?: string): void
}

/** The event Astro's ClientRouter fires before it fetches the next page. */
interface AstroPreparation extends Event {
  loader: () => Promise<void>
  readonly sourceElement?: Element | null
}

// Each look is a chunk of its own, with three.
const LOOKS: Record<CoverName, () => Promise<{ readonly default: object }>> = {
  curtain: () => import('./curtain'),
  pixel: () => import('./pixel'),
  ink: () => import('./ink'),
}

/** Options of `cover()` that are timing, not params of the look. */
const TIMING: readonly (keyof CoverTiming)[] = [
  'duration',
  'ease',
  'wait',
  'timeout',
  'links',
  'arrive',
]
/** Seconds a click on a not yet loaded cover may wait for it before the page changes plainly. */
const LOAD_WAIT = 0.4
/** ms a pointerdown counts as the origin of the navigation that follows it. */
const POINTER_FRESH = 1500
/** ms the idle preload waits for an idle moment at most. */
const IDLE_TIMEOUT = 3000
/** ms before the preload where `requestIdleCallback` is missing. */
const IDLE_FALLBACK = 200
/** A long frame moves the cover by at most this many display frames. */
const MAX_FRAMES_PER_STEP = 2
/** Frames the new page draws under the closed cover before it asks the assets whether they are in. */
const SETTLE_FRAMES = 2
/** Closed, the page under the cover may change without a view transition of its own. */
const QUIET =
  '::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}' +
  '::view-transition-old(*){display:none}'

const cubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

const defaults: CoverSettings = {
  look: 'curtain',
  params: {},
  duration: 0.6,
  ease: cubic,
  wait: 0.5,
  timeout: 10,
  links: true,
  arrive: true,
}

/** The cover of one app: its state machine, held clicks, and the look's effect. */
class Controller {
  readonly state: Signal<CoverState> = signal<CoverState>('idle')
  readonly api: CoverApi
  readonly #app: View
  readonly #options: CoverSettings
  #handle: EffectHandle | undefined
  #loading: Promise<boolean> | undefined
  /** Time along the cover: 0 shown, 1 covered, 2 shown again. Eased into `position`. */
  #time = 0
  /** The `position` last written to the look. */
  #written = -1
  #waiters: ((covered: boolean) => void)[] = []
  /** A link click held until the cover has closed. */
  #pending: { readonly link: HTMLAnchorElement; readonly event: MouseEvent } | undefined
  #replaying = false
  /** Seconds since the page changed under the closed cover, -1 before it did. */
  #since = -1
  /** Frames drawn since the page changed under the closed cover. */
  #frames = 0
  /** The new page's assets are in. */
  #assetsReady = false
  /** Opens a closed cover whose page never changed. */
  #timer: ReturnType<typeof setTimeout> | undefined
  /** Keeps frames coming while the cover moves or waits. */
  #awake: Off | undefined
  #sheet: CSSStyleSheet | undefined
  #pointer: { x: number; y: number; at: number } | undefined
  /** Where the cover starts, in viewport fractions. */
  #origin = { x: 0.5, y: 0.5 }

  constructor(app: View, options: CoverSettings) {
    this.#app = app
    this.#options = options
    app.system('layout', (time) => this.#tick(time), {
      name: 'cover',
      after: 'anchors',
      before: 'effects:inputs',
    })
    app.on('page:enter', () => this.entered())
    app.onDispose(app.stage.hold(() => this.state.peek() !== 'idle'))
    app.onDispose(() => this.#dispose())
    this.#listen(app.abortSignal)
    this.api = {
      state: this.state,
      close: (at) => this.close(at),
      open: () => this.open(),
      load: () => this.load(),
    }
  }

  #listen(signal: AbortSignal): void {
    const capture = { capture: true, signal }
    addEventListener('click', (event) => this.#click(event), capture)
    addEventListener(
      'pointerdown',
      (event) => {
        this.#pointer = { x: event.clientX, y: event.clientY, at: performance.now() }
      },
      capture,
    )
    // Loads ahead of the first click: on intent, and once the page is idle.
    const intent = (event: Event): void => {
      if ((event.target as Element | null)?.closest?.('a[href]')) void this.load()
    }
    for (const type of ['pointerover', 'focusin', 'touchstart'])
      addEventListener(type, intent, { ...capture, passive: true })
    const idle = (): void => this.#loadWhenIdle(signal)
    if (document.readyState === 'complete') idle()
    else addEventListener('load', idle, { once: true, signal })
    addEventListener(
      'pageshow',
      (event) => {
        // Back to a page that left through the cover: the browser kept it covered.
        if (event.persisted && this.state.peek() !== 'idle') this.open()
      },
      { signal },
    )
    document.addEventListener(
      'astro:before-preparation',
      (event) => this.#astro(event as AstroPreparation),
      { signal },
    )
    document.addEventListener('astro:after-swap', () => this.entered(), { signal })
  }

  #loadWhenIdle(signal: AbortSignal): void {
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(() => void this.load(), { timeout: IDLE_TIMEOUT })
      signal.addEventListener('abort', () => cancelIdleCallback(id), { once: true })
    } else {
      const id = setTimeout(() => void this.load(), IDLE_FALLBACK)
      signal.addEventListener('abort', () => clearTimeout(id), { once: true })
    }
  }

  get #ready(): boolean {
    return this.#handle?.instances[0]?.status.peek() === 'running'
  }

  /** Reduced motion and pages without 3D change at once. */
  #playable(): boolean {
    const status = this.#app.effects.status.peek()
    return !this.#app.stage.reducedMotion.peek() && status !== 'unavailable' && status !== 'off'
  }

  load(): Promise<boolean> {
    // An idle or intent preload may fire after the app is gone.
    if (this.#app.abortSignal.aborted || this.#app.stage.reducedMotion.peek())
      return Promise.resolve(false)
    this.#loading ??= this.#boot().catch((error: unknown) => {
      this.#app.report(error, 'cover')
      return false
    })
    return this.#loading
  }

  /** Loads the look and attaches it to `<html>`. Resolves true once it runs. */
  async #boot(): Promise<boolean> {
    const { effects } = this.#app
    const { look } = this.#options
    const [ok, effect] = await Promise.all([
      effects.load(),
      typeof look === 'string' ? LOOKS[look]().then((module) => module.default as Effect) : look,
    ])
    if (!ok || this.#app.abortSignal.aborted) return false
    const handle = effects.attach(
      document.documentElement,
      { effect, params: { ...this.#options.params, position: 0 } },
      // A cached box: <html> only needs to count as on screen, not to be measured every frame.
      { eager: true, track: 'layout' },
    )
    this.#app.onDispose(handle)
    const running = await settledRunning(handle)
    if (!running || this.#app.abortSignal.aborted) {
      handle.detach()
      return false
    }
    this.#handle = handle
    this.#write(true)
    return true
  }

  /** Waits for the cover to load, at most `seconds`. */
  #loaded(seconds: number): Promise<boolean> {
    if (this.#ready) return Promise.resolve(true)
    return Promise.race([
      this.load(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), seconds * 1000)),
    ]).then(() => this.#ready)
  }

  async close(at?: CoverOrigin): Promise<boolean> {
    if (!this.#playable() || !(await this.#loaded(LOAD_WAIT)) || !this.#playable()) return false
    const state = this.state.peek()
    if (state === 'covered') return true
    if (state === 'idle') this.#aim(at)
    this.#set('closing')
    return new Promise<boolean>((resolve) => this.#waiters.push(resolve))
  }

  open(): void {
    if (this.state.peek() === 'idle') return
    this.#pending = undefined
    this.#since = -1
    clearTimeout(this.#timer)
    this.#settle(false)
    // Cut short while closing: open back along the same way.
    if (this.#time < 1) this.#time = 2 - this.#time
    this.#set('opening')
  }

  /** The page changed: show it once its first screen is ready. */
  entered(): void {
    // The page went somewhere else meanwhile, so the held click is stale.
    this.#pending = undefined
    const state = this.state.peek()
    if (state === 'opening' || this.#since >= 0) return
    if (state === 'idle') {
      if (!this.#options.arrive || !this.#ready || !this.#playable()) return
      this.#origin = { x: 0.5, y: 0.5 }
    }
    // A router that did not wait: the cover closes at once rather than over the new page.
    this.#time = 1
    this.#since = 0
    this.#frames = 0
    this.#assetsReady = false
    this.#reach()
  }

  #set(state: CoverState): void {
    this.state.value = state
    this.#quiet(state !== 'idle')
    this.#app.invalidate()
  }

  /** Sets the origin from a click, an element or a point. Defaults to the viewport centre. */
  #aim(at: CoverOrigin | undefined): void {
    // The canvas's size, which the look measures in too.
    const width = this.#app.stage.width.peek() || 1
    const height = this.#app.stage.height.peek() || 1
    let x = width / 2
    let y = height / 2
    const centre = (element: Element): void => {
      const rect = element.getBoundingClientRect()
      x = rect.left + rect.width / 2
      y = rect.top + rect.height / 2
    }
    // A keyboard click has no pointer position: the link is the origin.
    if (at instanceof MouseEvent && at.detail === 0 && at.target instanceof Element)
      centre(at.target)
    else if (at instanceof MouseEvent) {
      x = at.clientX
      y = at.clientY
    } else if (at instanceof Element) centre(at)
    else if (at) ({ x, y } = at)
    this.#origin = { x: x / width, y: y / height }
  }

  /** The cover is closed: resolve the waiters and pass a held click on. */
  #reach(): void {
    this.#set('covered')
    this.#settle(true)
    clearTimeout(this.#timer)
    if (this.#since < 0)
      this.#timer = setTimeout(() => this.open(), Math.max(0, this.#options.timeout) * 1000)
    const held = this.#pending
    this.#pending = undefined
    if (held?.link.isConnected) this.#replay(held.link, held.event)
  }

  #settle(covered: boolean): void {
    for (const resolve of this.#waiters.splice(0)) resolve(covered)
  }

  #replay(link: HTMLAnchorElement, event: MouseEvent): void {
    this.#replaying = true
    try {
      // A router takes it and changes the page; otherwise the browser follows the link.
      link.dispatchEvent(new MouseEvent('click', event))
    } finally {
      this.#replaying = false
    }
  }

  #click(event: MouseEvent): void {
    if (this.#replaying || !this.#options.links || event.defaultPrevented || astro()) return
    const link = linkOf(event)
    if (!link || !this.#playable()) return
    if (!this.#ready) {
      void this.load()
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    const state = this.state.peek()
    this.#pending = { link, event }
    if (state === 'covered') this.#reach()
    else void this.close(event)
  }

  #astro(event: AstroPreparation): void {
    if (!this.#playable() || !this.#ready) {
      void this.load()
      return
    }
    const pointer = this.#pointer
    const fresh = pointer && performance.now() - pointer.at < POINTER_FRESH
    const closing = this.close(fresh ? pointer : (event.sourceElement ?? undefined))
    const load = event.loader
    // Astro fetches the next page while the cover closes, and swaps once both are done.
    event.loader = async () => {
      await Promise.all([load(), closing])
    }
  }

  #tick(time: FrameTime): void {
    const state = this.state.peek()
    let busy = state === 'closing' || state === 'opening'
    if (state !== 'idle') {
      const { stats, timeScale } = this.#app.loop
      // A long frame (a shader compile, the new page's setup) holds the cover rather than skipping it.
      const dt =
        stats.reason === 'step'
          ? time.delta
          : Math.min(time.delta, MAX_FRAMES_PER_STEP * stats.interval * timeScale)
      const step = dt / Math.max(this.#options.duration, 1e-3)
      if (state === 'closing') this.#stepClosing(step)
      else if (state === 'opening') this.#stepOpening(step)
      else if (this.#since >= 0) {
        busy = true
        this.#stepWaiting(dt)
      }
    }
    this.#write(false)
    if (busy && !this.#awake) this.#awake = this.#app.hold('cover')
    else if (!busy && this.#awake) {
      this.#awake()
      this.#awake = undefined
    }
  }

  #stepClosing(step: number): void {
    // Forward from the page, or back along the opening when it was cut short.
    this.#time = this.#time < 1 ? Math.min(1, this.#time + step) : Math.max(1, this.#time - step)
    if (this.#time === 1) this.#reach()
  }

  #stepOpening(step: number): void {
    this.#time = Math.min(2, this.#time + step)
    if (this.#time < 2) return
    this.#time = 0
    this.#since = -1
    this.#set('idle')
  }

  /** The page has changed under the closed cover: open once it is ready, or after `wait`. */
  #stepWaiting(dt: number): void {
    this.#since += dt
    if (++this.#frames === SETTLE_FRAMES) {
      const done = (): void => {
        this.#assetsReady = true
      }
      const ready = this.#app.assets?.ready()
      if (ready) ready.then(done, done)
      else done()
    }
    const settled = this.#assetsReady && this.#frames > SETTLE_FRAMES
    if (settled || this.#since >= this.#options.wait) this.open()
  }

  /** Writes the eased position and the origin to the look, if it changed. */
  #write(force: boolean): void {
    const time = this.#time
    const { ease } = this.#options
    const position = time <= 1 ? ease(time) : 1 + ease(time - 1)
    if (!this.#handle || (position === this.#written && !force)) return
    this.#written = position
    this.#handle.set({ position, x: this.#origin.x, y: this.#origin.y })
  }

  /** Native view transitions under a closed cover end at once. */
  #quiet(on: boolean): void {
    if (typeof CSSStyleSheet !== 'function') return
    const sheets = document.adoptedStyleSheets
    if (on) {
      if (!this.#sheet) {
        this.#sheet = new CSSStyleSheet()
        this.#sheet.replaceSync(QUIET)
      }
      if (!sheets.includes(this.#sheet)) document.adoptedStyleSheets = [...sheets, this.#sheet]
    } else if (this.#sheet && sheets.includes(this.#sheet)) {
      document.adoptedStyleSheets = sheets.filter((sheet) => sheet !== this.#sheet)
    }
  }

  #dispose(): void {
    clearTimeout(this.#timer)
    this.#settle(false)
    this.#pending = undefined
    this.#awake?.()
    this.#quiet(false)
  }
}

/** Provides `app.cover`, a GL cover over the page while it changes. */
export const coverPlugin: Plugin<'cover', CoverSettings, CoverApi> = /*#__PURE__*/ definePlugin<
  'cover',
  CoverSettings,
  typeof defaults,
  CoverApi,
  ['stage', 'effects'],
  ['transition', 'assets']
>({
  name: 'cover',
  dependencies: ['stage', 'effects'],
  optionalDependencies: ['transition', 'assets'],
  defaults,
  setup(app, options): CoverApi {
    return typeof document === 'undefined'
      ? inert()
      : new Controller(app as unknown as View, options).api
  },
})

/** Splits flat options into the look's params and the timing. */
export function coverSettings(options: CoverName | CoverOptions): Partial<CoverSettings> {
  if (typeof options === 'string') return { look: options }
  const settings: Record<string, unknown> = { look: options.name }
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (key === 'name' || value === undefined) continue
    if ((TIMING as readonly string[]).includes(key)) settings[key] = value
    else if (key === 'params') Object.assign(params, value)
    else params[key] = value
  }
  settings.params = params
  return settings as Partial<CoverSettings>
}

/**
 * Preset with the `cover` plugin: the old page leaves and the new one arrives through a GL cover.
 * Needs `effects` and works with the `transitions` preset, which tells it when the page changed.
 *
 *     createApp({ presets: [effects(), transitions(), cover({ name: 'ink', color: '#e4002b' })] })
 */
/*#__NO_SIDE_EFFECTS__*/
export function cover(options: CoverName | CoverOptions = 'curtain'): Preset<typeof coverPlugin> {
  return definePreset({ name: 'cover', plugins: [coverPlugin(coverSettings(options))] })
}

/**
 * Closes the cover of `app` and resolves true once the page is covered, for routers that change
 * the page from code: `await covered(app, event); router.push(href)`. Resolves false at once
 * without the plugin, before the app runs, or when the cover can't play.
 */
export function covered(
  app: { readonly cover?: CoverApi | undefined },
  at?: CoverOrigin,
): Promise<boolean> {
  return app.cover?.close(at) ?? Promise.resolve(false)
}

/** The link a plain click follows to another page of this site, if it is one. */
export function linkOf(event: MouseEvent): HTMLAnchorElement | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event
    .composedPath()
    .find(
      (node): node is HTMLAnchorElement =>
        node instanceof HTMLAnchorElement && node.hasAttribute('href'),
    )
  if (!link || link.hasAttribute('download') || link.closest('[data-dio-cover="off"]')) return
  if (link.target && link.target !== '_self') return
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return
  // The same page, or only its #hash: no page change to cover.
  if (url.pathname === location.pathname && url.search === location.search) return
  return link
}

/** Astro's ClientRouter waits for `astro:before-preparation` loaders, so it needs no hold. */
const astro = (): boolean => !!document.querySelector('meta[name="astro-view-transitions-enabled"]')

/**
 * Resolves whether the look's instance got to `running`. The look is not a registered effect, so
 * `handle.ready()` would not wait for its setup.
 */
function settledRunning(handle: EffectHandle): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const instance = handle.instances[0]
    if (!instance) return resolve(false)
    const off = instance.status.subscribe((status) => {
      if (status === 'waiting' || status === 'loading') return
      queueMicrotask(() => off())
      resolve(status === 'running')
    })
  })
}

/** Without a DOM (SSR) nothing covers. */
const inert = (): CoverApi => ({
  state: signal<CoverState>('idle'),
  close: () => Promise.resolve(false),
  open: () => {},
  load: () => Promise.resolve(false),
})
