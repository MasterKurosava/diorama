import type { Off } from '@dioramajs/core'
import type { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import type { WebGPURenderer } from 'three/webgpu'
import { AssetError, isAbort } from '../errors'
import type { DecoderOptions, LoaderContext } from '../types'

type Meshopt = typeof import('three/addons/libs/meshopt_decoder.module.js').MeshoptDecoder
type Options = Readonly<Partial<DecoderOptions>>

const DRACO = 'KHR_draco_mesh_compression'
export const KTX2 = 'KTX2 (KHR_texture_basisu)'

const CSP =
  "decoders run in blob: workers and WebAssembly: the Content Security Policy needs worker-src blob: and script-src 'wasm-unsafe-eval'"

/** A worker or WebAssembly refused, most likely by the CSP. */
const blocked = (cause: unknown): boolean =>
  (cause as { name?: string } | null)?.name === 'SecurityError' ||
  /Content Security Policy|wasm-unsafe-eval|WebAssembly|Worker/i.test(String(cause))

const decoderError = (message: string, url: string, cause?: unknown): AssetError =>
  cause instanceof AssetError
    ? cause
    : new AssetError('ASSET_DECODER', blocked(cause) ? `${message}: ${CSP}` : message, {
        url,
        cause,
      })

export const refused = (what: string, option: keyof DecoderOptions, url: string): AssetError =>
  new AssetError('ASSET_DECODER', `the file uses ${what} and decoders.${option} is false`, { url })

/** Aborts pass through, a refused decoder worker is ASSET_DECODER, the rest ASSET_PARSE. */
export function parseError(cause: unknown, context: LoaderContext, decoders: boolean): unknown {
  if (context.signal.aborted || isAbort(cause) || cause instanceof AssetError) return cause
  if (decoders && blocked(cause)) return decoderError('a decoder failed', context.url, cause)
  return new AssetError('ASSET_PARSE', `cannot parse ${context.url}`, { url: context.url, cause })
}

// Shared by every app of the page. three's MeshoptDecoder is a module singleton with global
// workers, and a second active KTX2Loader warns. Created on first need and freed after the last
// app. `workers` comes from the app that created the decoder.
let apps = 0
let draco: Promise<DRACOLoader> | undefined
let meshopt: Promise<Meshopt> | undefined
let meshoptWorkers = false
const ktx2 = new Map<object, Promise<KTX2Loader>>()
let probe: Promise<void> | undefined

/** One per app that loads through this module. The last one out frees the decoders. */
export function join(): Off {
  apps++
  let done = false
  return () => {
    if (done) return
    done = true
    if (--apps > 0) return
    const workers = meshoptWorkers
    void draco?.then((loader) => loader.dispose(), noop)
    void meshopt?.then((decoder) => workers && decoder.useWorkers(0), noop)
    for (const renderer of [...ktx2.keys()]) forget(renderer)
    draco = meshopt = probe = undefined
    meshoptWorkers = false
  }
}

/** Drops the KTX2Loader of a stopped renderer, since it read that renderer's formats. */
export function forget(renderer: object): void {
  const pending = ktx2.get(renderer)
  ktx2.delete(renderer)
  void pending?.then((loader) => loader.dispose(), noop)
}

// Local copy. Importing it from ../errors adds a binding across the lazy chunk boundary.
const noop = (): void => {}

/**
 * three's decoders run in blob: workers. A worker refused by the CSP doesn't throw in Chrome, it
 * fires `error`, and DRACOLoader and KTX2Loader would wait for its answer forever. Probe first
 * with an empty worker that compiles an empty WebAssembly module, as theirs do.
 */
function workers(): Promise<void> {
  if (typeof Worker === 'undefined') return Promise.resolve()
  probe ??= new Promise<void>((resolve, reject) => {
    const url = URL.createObjectURL(
      new Blob([
        'WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(()=>postMessage(""),e=>postMessage(String(e)))',
      ]),
    )
    let worker: Worker | undefined
    const done = (error?: string): void => {
      worker?.terminate()
      URL.revokeObjectURL(url)
      if (error) reject(new Error(error))
      else resolve()
    }
    try {
      worker = new Worker(url)
      worker.onmessage = (event) => done(event.data)
      worker.onerror = () => done('a blob: Worker was refused')
    } catch (cause) {
      done(String(cause))
    }
  })
  return probe
}

/** Keeps a decoder promise for reuse unless it failed, so the next file tries again. */
function shared<T>(pending: Promise<T>, clear: () => void): Promise<T> {
  pending.catch(clear)
  return pending
}

export function dracoLoader(options: Options, url: string): Promise<DRACOLoader> {
  const path = options.draco
  if (path === false) return Promise.reject(refused(DRACO, 'draco', url))
  if (!draco) {
    const pending = (async () => {
      const [{ DRACOLoader, DRACO_GLTF_CONFIG }] = await Promise.all([
        import('three/addons/loaders/DRACOLoader.js'),
        workers(),
      ])
      const loader = new DRACOLoader().setDecoderPath(path ?? DRACO_GLTF_CONFIG)
      if (options.workers) loader.setWorkerLimit(options.workers)
      // three keeps the decoder files' promise on the loader after preload().
      await (loader.preload() as unknown as { decoderPending: Promise<void> }).decoderPending
      return loader
    })()
    draco = shared(pending, () => {
      if (draco === pending) draco = undefined
    })
  }
  const where = typeof path === 'object' ? path.js : (path ?? 'three/examples/jsm/libs/draco/gltf/')
  return draco.catch((cause: unknown) => {
    throw decoderError(`the Draco decoder did not load from ${where}`, url, cause)
  })
}

export function meshoptDecoder(options: Options, url: string): Promise<Meshopt> {
  if (options.meshopt === false)
    return Promise.reject(refused('meshopt compression', 'meshopt', url))
  if (!meshopt) {
    const pending = (async () => {
      const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js')
      if (!MeshoptDecoder.supported) {
        throw new AssetError('ASSET_DECODER', 'meshopt decoding needs WebAssembly', { url })
      }
      await MeshoptDecoder.ready
      if (options.workers) {
        await workers()
        MeshoptDecoder.useWorkers(options.workers)
        meshoptWorkers = true
      }
      return MeshoptDecoder
    })()
    meshopt = shared(pending, () => {
      if (meshopt === pending) meshopt = undefined
    })
  }
  return meshopt.catch((cause: unknown) => {
    throw decoderError('the meshopt decoder did not start', url, cause)
  })
}

/** One per renderer, after its init, since detectSupport reads the renderer's features. */
export function ktx2Loader(renderer: object, options: Options, url: string): Promise<KTX2Loader> {
  const path = options.ktx2
  if (path === false) return Promise.reject(refused(KTX2, 'ktx2', url))
  let pending = ktx2.get(renderer)
  if (!pending) {
    const created = (async () => {
      const [{ KTX2Loader }] = await Promise.all([
        import('three/addons/loaders/KTX2Loader.js'),
        workers(),
      ])
      const loader = new KTX2Loader()
      if (path) loader.setTranscoderPath(path)
      if (options.workers) loader.setWorkerLimit(options.workers)
      loader.detectSupport(renderer as WebGPURenderer)
      try {
        await loader.init()
      } catch (cause) {
        loader.dispose()
        throw cause
      }
      return loader
    })()
    pending = shared(created, () => {
      if (ktx2.get(renderer) === created) ktx2.delete(renderer)
    })
    ktx2.set(renderer, pending)
  }
  const where = path || 'three/examples/jsm/libs/basis/'
  return pending.catch((cause: unknown) => {
    throw decoderError(`the Basis transcoder did not load from ${where}`, url, cause)
  })
}
