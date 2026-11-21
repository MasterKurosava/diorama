import type { Off, ReadonlySignal } from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import type { AnimationClip, CompressedTexture, Group, Object3D, Texture } from 'three/webgpu'
import type { AssetError } from './errors'

/** Request priority. An entry runs at the highest priority among its leases. */
export type Priority = 'high' | 'normal' | 'low'
/** State of a lease. */
export type AssetStatus = 'loading' | 'ready' | 'failed' | 'released'
/** `''` (default) sends no CORS mode, like an <img> without `crossorigin`. */
export type CrossOrigin = '' | 'anonymous' | 'use-credentials'

/** Value types of typed loads. Extend via declaration merging for your own loaders. */
export interface AssetTypes {
  /** Decoded pixels, flipped like effects textures (`imageOrientation: 'flipY'`). */
  image: ImageBitmap
  /** Origin bottom-left like effects textures, built from the `image` entry. Shared, never dispose it. */
  texture: Texture
  /** A glTF model owned by the cache. */
  gltf: Model
  /** Origin top-left like glTF, and `flipY` can't be changed. Shared, never dispose it. */
  ktx2: CompressedTexture
  /** Raw bytes. */
  buffer: ArrayBuffer
  /** Parsed JSON. */
  json: unknown
}

/** A glTF owned by the cache. Place instances and never dispose their resources. */
export interface Model {
  /** The loaded scene. Place instances, not this group. */
  readonly scene: Group
  /** Animation clips of the file. */
  readonly animations: readonly AnimationClip[]
  /**
   * A clone sharing geometry, materials and textures (SkeletonUtils for skinned). The shared
   * resources carry `userData.keep`. The clone's own objects are disposed with the effect.
   */
  instance(): Object3D
}

/** Options of `assets.load`. */
export interface LoadOptions<K extends string = string> {
  /** Guessed from the extension when omitted: gltf for .glb and .gltf, ktx2 for .ktx2, texture for images. */
  readonly type?: K
  /** Default 'normal'. An entry runs at the highest priority among its leases. */
  readonly priority?: Priority
  /**
   * Part of the key, as the browser keys its image cache by CORS mode. A `texture` of another
   * origin is always asked in CORS mode: `''` becomes `'anonymous'`, since the GPU refuses
   * pixels fetched without it.
   */
  readonly crossOrigin?: CrossOrigin
  /** Loader options, part of the key. For example `{ colorSpace: 'linear' }`. */
  readonly options?: Readonly<Record<string, string | number | boolean>>
  /** Aborting it releases the lease. */
  readonly signal?: AbortSignal
}

/**
 * A lease, returned synchronously. The entry lives while any lease does. Calling it releases it.
 * `E` is the failure type, AssetError for `load()` and whatever `make` threw for `acquire()`.
 */
export interface Asset<T, E = AssetError> {
  (): void
  /** Releases the lease. The entry goes when its last lease does. */
  release(): void
  /** Same as release, so `ctx.onDispose(asset)` ties it to an effect. */
  dispose(): void
  /** Cache key: type, URL, CORS mode and options. */
  readonly key: string
  /** Absolute URL. */
  readonly url: string
  /** State of the lease. */
  readonly status: ReadonlySignal<AssetStatus>
  /** Rejects with `E`, or with an unreported ASSET_ABORTED if released before ready. */
  readonly ready: Promise<T>
  /** The value while the lease is ready, undefined before and after. */
  readonly value: T | undefined
  /** The failure while the lease is failed. */
  readonly error: E | undefined
}

/** What a loader resolves with. */
export interface Loaded<T> {
  /** The loaded value. */
  readonly value: T
  /** Approximate size in bytes for `retain` and progress weights. Estimated when absent. */
  readonly bytes?: number
  /** Frees what the value holds. Called once, by the cache only. */
  dispose?(): void
  /** Depends on the renderer's formats (KTX2), so it is evicted when render restarts. */
  readonly renderBound?: boolean
}

/** What a loader gets for one entry. */
export interface LoaderContext {
  /** Absolute URL to load. */
  readonly url: string
  /** Cache key of the entry. */
  readonly key: string
  /** The highest priority among the entry's leases. */
  readonly priority: Priority
  /** CORS mode of the request. */
  readonly crossOrigin: CrossOrigin
  /** Loader options from `load()`. */
  readonly options: Readonly<Record<string, string | number | boolean>>
  /** Aborts when the last lease goes before the load ends. */
  readonly signal: AbortSignal
  /** fetch() with the priority hint and signal. HTTP errors throw ASSET_LOAD. */
  fetch(init?: RequestInit): Promise<Response>
  /** Reads a body, counting bytes into the progress. */
  bytes(response: Response): Promise<ArrayBuffer>
  /**
   * Runs CPU-heavy work (createImageBitmap, parsing) in one of two decode slots and frees the
   * request slot, so call it once the network part is done. Low-only entries wait while a pause
   * is held.
   */
  decode<R>(work: () => Promise<R>): Promise<R>
  /**
   * Loads a dependency. Its lease is released if this load is aborted, otherwise release it in
   * `dispose`. Like `render()` it frees the request slot, so call both after the network part.
   */
  load<T = unknown>(url: string, options?: LoadOptions): Asset<T>
  /** Resolves once `render` runs (after renderer.init()). */
  render(): Promise<RenderApi>
  /** The app's decoder options. Unset fields take three's defaults. */
  readonly decoders: Readonly<Partial<DecoderOptions>>
}

/** Loads one type of asset. */
export interface AssetLoader<T = unknown> {
  /** Extensions this loader handles when no type is given, e.g. ['.glb', '.gltf']. */
  readonly extensions?: readonly string[]
  /** Loads the value of one entry. */
  load(context: LoaderContext): Promise<Loaded<T>>
}
/** A loader, or a lazy module exporting one. Three-based loaders come through import(). */
export type LoaderEntry =
  | AssetLoader
  | (() => Promise<AssetLoader | { readonly default: AssetLoader }>)

/** Where Draco, KTX2 and Meshopt decoders come from. */
export interface DecoderOptions {
  /** A directory or `{ js, wasm }`, false refuses. Defaults to three's glTF-only build next to DRACOLoader. */
  readonly draco: string | { readonly js: string; readonly wasm: string } | false
  /** A directory, false refuses. Defaults to three's Basis transcoder next to KTX2Loader. */
  readonly ktx2: string | false
  /** EXT_/KHR_meshopt_compression through three's decoder module (wasm inside). Default true. */
  readonly meshopt: boolean
  /** Workers per decoder, three's default if unset. The first app that creates a decoder sets it. */
  readonly workers: number | undefined
}

/** What `preload` takes: URLs, a parsed Document or a container element. */
export type PreloadSource = string | readonly string[] | ParentNode

/** Options of `assets.preload`. */
export interface PreloadOptions {
  /** Default 'low'. */
  readonly priority?: Priority
  /**
   * CORS mode of images given as URLs. Match the `<img crossorigin>` that will show them, since
   * it is part of the key. Images from markup or a document carry their own `crossorigin`.
   */
  readonly crossOrigin?: CrossOrigin
  /** Base for relative URLs and srcset, i.e. the next page's URL. Defaults to <base href>, then document.baseURI. */
  readonly base?: string | URL
}

/** Settles once everything has settled. Never rejects. */
export interface Preload extends PromiseLike<void> {
  /** Drops the leases now. Otherwise they are held until the next preload of the same kind. */
  release(): void
  /** Same as release, for `page.onDispose(app.assets.preload(doc))`. */
  dispose(): void
}

/** Counters of the cache. */
export interface AssetsStats {
  /** Entries in the cache. */
  readonly entries: number
  /** Entries with leases. */
  readonly used: number
  /** Bytes of entries without leases, kept by `retain`. */
  readonly retained: number
  /** Entries still loading. */
  readonly pending: number
}

/** Options of the `assets` plugin. */
export interface AssetsOptions {
  /** Own loaders by type, next to the built-in ones. A lazy one is picked by `type` only. */
  readonly loaders: Readonly<Record<string, LoaderEntry>>
  /** Where the Draco, KTX2 and Meshopt decoders come from. */
  readonly decoders: Partial<DecoderOptions>
  /** Parallel requests. Default 6. At most 2 of them low, and only while no high request waits. */
  readonly concurrency: number
  /** Bytes of unused entries kept for reuse (back navigation, preloads), LRU. Default 32 MB, 0 disables. */
  readonly retain: number
  /** Reads data-dio-preload. Default true. Off under Save-Data or 2g. */
  readonly preload: boolean
}

/** The `assets` service: a shared cache of media and models with progress. */
export interface AssetsApi {
  /**
   * Loads a URL and returns a lease at once. The type comes from `type` or the extension.
   * Never throws: `ready` rejects with an AssetError, `ASSET_TYPE` for an unknown type,
   * `ASSET_LOAD` for a network or HTTP failure, `ASSET_PARSE` or `ASSET_DECODER` for bad data.
   */
  load<K extends keyof AssetTypes>(
    url: string,
    options: LoadOptions<K> & { readonly type: K },
  ): Asset<AssetTypes[K]>
  load<T = unknown>(url: string, options?: LoadOptions): Asset<T>
  /**
   * Get-or-create by key with a lease. Plugins share values they build this way (effects
   * bitmaps). Errors of `make` reject `ready` unchanged and the owner reports them.
   */
  acquire<T>(
    key: string,
    make: (context: LoaderContext) => Promise<Loaded<T>>,
    options?: { readonly priority?: Priority; readonly weight?: number },
  ): Asset<T, unknown>
  /** Next page's media and models: URLs, a parsed Document (Astro, Swup) or a container (Barba). */
  preload(source: PreloadSource, options?: PreloadOptions): Preload
  /**
   * Counts outside work in the current wave, like first-screen effects, fonts or page HTML.
   * `weight: 0` holds `ready()` without moving progress or starting a wave of its own.
   */
  track(
    work: PromiseLike<unknown>,
    options?: { readonly weight?: number; readonly priority?: Priority },
  ): void
  /**
   * Low-priority loads and decodes wait while any pause is held (a flight). `reason` labels the
   * call, as in `app.pause`.
   */
  pause(reason?: string): Off
  /** Progress of the current wave of high and normal work, 0..1. Never goes back within a wave. */
  readonly progress: ReadonlySignal<number>
  /** Settles when the current wave is done, or at once without one. Failures count as done. */
  ready(): Promise<void>
  /** Counters of the cache. */
  stats(): AssetsStats
}

/** Codes of `AssetError`. */
export type AssetErrorCode =
  | 'ASSET_LOAD'
  | 'ASSET_PARSE'
  | 'ASSET_TYPE'
  | 'ASSET_DECODER'
  | 'ASSET_ABORTED'

declare module '@dioramajs/core' {
  interface Services {
    /** Asset cache and preloading, see `AssetsApi`. */
    assets: AssetsApi
  }
  interface Hooks {
    /** Runs synchronously once per entry, before caching. For colour space, material tweaks, userData. */
    'assets:transform': (
      value: unknown,
      context: { readonly type: string; readonly url: string },
    ) => unknown
  }
}
