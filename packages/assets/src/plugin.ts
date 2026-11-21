import {
  definePlugin,
  isCancel,
  type Off,
  type Plugin,
  type PluginApp,
  signal,
} from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import { Cache, ESTIMATE, type Make, type Spec } from './cache'
import { AssetError, DEV, linked, noop } from './errors'
import { absolute, BY_EXTENSION, extensionOf, keyOf, parseKey, textureCors } from './keys'
import { buffer, image, json } from './loaders'
import { frugal, Preloads } from './preload'
import { abortError, Queue } from './queue'
import type {
  Asset,
  AssetLoader,
  AssetStatus,
  AssetsApi,
  AssetsOptions,
  LoadOptions,
  Preload,
} from './types'
import { Wave } from './wave'

type View = PluginApp<{ readonly render?: RenderApi }>
type ThreeModule = typeof import('./three/index')

const BUILT_IN: Readonly<Record<string, AssetLoader>> = { image, buffer, json }
const THREE_TYPES = ['texture', 'gltf', 'ktx2'] as const
/** KTX2 waits for `render`. Show a development hint after this long. */
const RENDER_WAIT_MS = 5000

const defaults: AssetsOptions = {
  loaders: {},
  decoders: {},
  concurrency: 6,
  retain: 32 * 1024 * 1024,
  preload: true,
}

const isThree = (type: string): type is (typeof THREE_TYPES)[number] =>
  (THREE_TYPES as readonly string[]).includes(type)

/** A lease that failed before it began, for SSR or a URL that doesn't parse. */
function failed<T>(url: string, error: AssetError): Asset<T> {
  linked(error)
  const ready = Promise.reject(error)
  ready.catch(noop)
  // A fresh function, since the handle carries its own key and url.
  const release = (): void => {}
  return Object.assign(release, {
    release,
    dispose: release,
    key: url,
    url,
    status: signal<AssetStatus>('failed'),
    ready,
    value: undefined,
    error,
  }) as unknown as Asset<T>
}

const settled: Preload = Object.freeze({
  release: noop,
  dispose: noop,
  // biome-ignore lint/suspicious/noThenProperty: a preload is thenable by design
  then: (fulfilled, rejected) => Promise.resolve().then(fulfilled, rejected),
} satisfies Preload)

/** Without a DOM (SSR) loads fail silently and nothing waits. */
function inert(): AssetsApi {
  const none = (url: string): Asset<never> =>
    failed(url, new AssetError('ASSET_LOAD', 'no DOM to load in', { url }))
  return {
    load: none,
    acquire: none,
    preload: () => settled,
    track: noop,
    pause: () => noop,
    progress: signal(0),
    ready: () => Promise.resolve(),
    stats: () => ({ entries: 0, used: 0, retained: 0, pending: 0 }),
  }
}

/** One cache, queue, wave and preloads per app. */
class Assets {
  readonly api: AssetsApi
  readonly #app: View
  readonly #options: AssetsOptions
  readonly #queue: Queue
  readonly #wave: Wave
  readonly #cache: Cache
  readonly #preloads: Preloads
  #three: Promise<ThreeModule> | undefined
  #module: ThreeModule | undefined
  #leave: Off | undefined
  #renderer: object | undefined
  #destroying = false

  constructor(app: View, options: AssetsOptions) {
    this.#app = app
    this.#options = options
    this.#queue = new Queue(options.concurrency)
    this.#wave = new Wave(() => [...document.querySelectorAll<HTMLElement>('[data-dio-progress]')])
    const decoders = { meshopt: true, workers: undefined, ...options.decoders }
    this.#cache = new Cache({
      queue: this.#queue,
      wave: this.#wave,
      retain: options.retain,
      decoders,
      report: (error, url) => app.report(error, `asset:${url}`),
      transform: (value, type, url) => {
        const result = app.callHook('assets:transform', value, { type, url })
        return isCancel(result) ? value : result
      },
      render: (abort) => this.#render(abort),
      load: (url, options) => this.#load(url, options, false),
    })
    this.#preloads = new Preloads({
      load: (url, options) => this.#load(url, options, false),
      acquire: (key, make, priority) => this.api.acquire(key, make, { priority }),
      has: (key) => this.#cache.has(key),
      slot: (priority, abort) => this.#queue.slot('request', () => priority, abort),
      typeOf: (url) => this.#typeOf(url),
      track: (work, priority) => this.api.track(work, { priority }),
      warn: (message) => app.log.warn(message),
    })
    if (options.preload && !frugal()) this.#preloads.listen(app.abortSignal)
    app.on('app:destroy', () => {
      this.#destroying = true
    })
    // Emitted by @dioramajs/transitions on every page change, explicit or auto.
    const events = app as unknown as { on(name: string, fn: () => void): void }
    events.on('page:leave', () => this.#wave.page())
    app.on('plugin:status', ({ name, status }) => {
      if (name !== 'render' || status !== 'stopping') return
      if (this.#renderer) this.#module?.forget(this.#renderer)
      this.#renderer = undefined
      this.#cache.rebind()
    })
    app.onDispose(() => {
      this.#preloads.close()
      this.#cache.close(this.#destroying)
      this.#leave?.()
    })

    const wave = this.#wave
    this.api = {
      load: (url: string, options?: LoadOptions) => this.#load(url, options ?? {}, true),
      acquire: (key, make, { priority, weight } = {}) =>
        this.#cache.get(
          {
            key,
            // `type url` keys (effects bitmaps) name their URL. Other keys are their own URL.
            ...parseKey(key),
            crossOrigin: '',
            options: {},
            make: () => make as Make,
            wrap: false,
            weight,
          },
          priority ?? 'normal',
          false,
        ),
      preload: (source, preload) => this.#preloads.preload(source, preload),
      track(work, { priority, weight } = {}) {
        if (priority === 'low') return
        const item = { total: weight ?? ESTIMATE, loaded: 0 }
        wave.add(item)
        const done = (): void => wave.done(item)
        Promise.resolve(work).then(done, done)
      },
      pause: () => this.#queue.pause(),
      progress: wave.progress,
      ready: () => wave.ready(),
      stats: () => this.#cache.stats(),
    } as AssetsApi
  }

  #load<T>(url: string, options: LoadOptions, report: boolean): Asset<T> {
    let href: string
    try {
      href = absolute(url)
    } catch (cause) {
      const error = linked(new AssetError('ASSET_LOAD', `${url} is not a URL`, { url, cause }))
      if (report) this.#app.report(error, `asset:${url}`)
      return failed(url, error)
    }
    const type = options.type ?? this.#typeOf(href)
    const name = type ?? '?'
    const crossOrigin =
      name === 'texture'
        ? textureCors(href, options.crossOrigin ?? '')
        : (options.crossOrigin ?? '')
    const params = options.options ?? {}
    const spec: Spec = {
      key: keyOf(name, href, crossOrigin, params),
      url: href,
      type: name,
      crossOrigin,
      options: params,
      make: () => this.#loader(type, href).then((loader) => (context) => loader.load(context)),
      wrap: true,
    }
    return this.#cache.get(spec, options.priority ?? 'normal', report, options.signal)
  }

  /** Own loaders' extensions first, then the built-in table. */
  #typeOf(url: string): string | undefined {
    const extension = extensionOf(url)
    if (!extension) return undefined
    for (const [type, entry] of Object.entries(this.#options.loaders)) {
      const extensions = typeof entry === 'function' ? undefined : entry.extensions
      if (extensions?.some((e) => e.replace(/^\./, '').toLowerCase() === extension)) return type
    }
    return BY_EXTENSION[extension]
  }

  async #loader(type: string | undefined, url: string): Promise<AssetLoader> {
    const known = [
      ...new Set([...Object.keys(this.#options.loaders), ...Object.keys(BUILT_IN), ...THREE_TYPES]),
    ]
    if (type === undefined) {
      const message = `no type for ${url}: pass { type } (known: ${known.join(', ')}); a page address is not an asset`
      throw new AssetError('ASSET_TYPE', message, { url })
    }
    const own = this.#options.loaders[type]
    try {
      if (own) {
        const found = typeof own === 'function' ? await own() : own
        const loader = 'default' in found ? found.default : found
        if (typeof loader?.load === 'function') return loader
      } else if (BUILT_IN[type]) return BUILT_IN[type]
      else if (isThree(type)) return (await this.#import())[type] as AssetLoader
    } catch (cause) {
      throw new AssetError('ASSET_TYPE', `the loader of "${type}" did not load`, { url, cause })
    }
    throw new AssetError('ASSET_TYPE', `no loader for "${type}" (known: ${known.join(', ')})`, {
      url,
    })
  }

  /** The three loaders, once per app. The app joins the decoders shared by the page. */
  #import(): Promise<ThreeModule> {
    if (!this.#three) {
      const pending = import('./three/index').then((module) => {
        if (!this.#app.abortSignal.aborted && !this.#module) this.#leave = module.join()
        this.#module = module
        return module
      })
      this.#three = pending
      pending.catch(() => {
        if (this.#three === pending) this.#three = undefined
      })
    }
    return this.#three
  }

  #render(abort: AbortSignal): Promise<RenderApi> {
    const app = this.#app
    const found = app.find('render')
    if (found) {
      this.#renderer = found.renderer
      return Promise.resolve(found)
    }
    if (abort.aborted || app.abortSignal.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const timer = DEV
        ? setTimeout(() => app.log.warn('assets: a KTX2 load waits for render'), RENDER_WAIT_MS)
        : undefined
      const done = (): void => {
        off()
        clearTimeout(timer)
        abort.removeEventListener('abort', stop)
      }
      const stop = (): void => {
        done()
        reject(abortError())
      }
      const off = app.on('plugin:status', ({ name, status }) => {
        const render = name === 'render' && status === 'running' ? app.find('render') : undefined
        if (!render) return
        done()
        this.#renderer = render.renderer
        resolve(render)
      })
      abort.addEventListener('abort', stop, { once: true })
    })
  }
}

/**
 * `app.assets`. One cache with leases for media and models, a priority queue, preloading of
 * the next page and the progress wave of a preloader.
 */
export const assets: Plugin<'assets', AssetsOptions, AssetsApi> = /*#__PURE__*/ definePlugin<
  'assets',
  AssetsOptions,
  typeof defaults,
  AssetsApi,
  [],
  ['render']
>({
  name: 'assets',
  optionalDependencies: ['render'],
  defaults,
  setup(app, options): AssetsApi {
    return typeof document === 'undefined'
      ? inert()
      : new Assets(app as unknown as View, options).api
  },
})
