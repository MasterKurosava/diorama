import type { QualityTier } from '@dioramajs/effects'
import type { RenderApi } from '@dioramajs/render'

/** How capable a GPU is, judged by its name. */
export type GpuClass = 'software' | 'mobile' | 'integrated' | 'discrete' | 'unknown'

/** The GPU the renderer runs on. */
export interface GpuInfo {
  /** The renderer backend. */
  readonly backend: 'webgpu' | 'webgl2'
  /** Renderer string as reported, '' when hidden. */
  readonly name: string
  /** Its class, from the name. */
  readonly class: GpuClass
}

/** What the start tier depends on besides the GPU. */
export interface Device {
  /** `navigator.deviceMemory` in GB, where the browser tells it. */
  readonly memory?: number
  /** `navigator.hardwareConcurrency`. */
  readonly cores?: number
  /** The main pointer is coarse (touch). */
  readonly coarse: boolean
  /** `devicePixelRatio`, uncapped. */
  readonly ratio: number
  /** Screen size in device pixels. */
  readonly pixels: number
}

// WebGL 2 names (ANGLE strings) and WebGPU adapter info (vendor, architecture, description).
const CLASSES: readonly (readonly [GpuClass, RegExp])[] = [
  ['software', /swiftshader|llvmpipe|lavapipe|basic render|software/i],
  ['mobile', /mali|adreno|powervr|apple gpu|^(qualcomm|arm|imagination)\b/i],
  ['integrated', /intel.*\b(hd|uhd|iris|gen-\d|xe-lp)|radeon\(tm\) graphics|apple m\d/i],
  ['discrete', /nvidia|geforce|rtx|radeon rx|\barc\b|xe-hp/i],
]

/** The class of a GPU by its renderer string. */
export const classify = (name: string): GpuClass =>
  CLASSES.find(([, pattern]) => pattern.test(name))?.[0] ?? 'unknown'

/** The tier to start at, before anything is measured. */
export function initialTier(gpu: Pick<GpuInfo, 'name' | 'class'>, device: Device): QualityTier {
  const low = (device.memory ?? 8) <= 3 || (device.cores ?? 8) <= 4
  const tier: QualityTier =
    gpu.class === 'software'
      ? 'low'
      : gpu.class === 'mobile'
        ? low
          ? 'low'
          : 'medium'
        : gpu.class === 'integrated'
          ? /apple m\d/i.test(gpu.name)
            ? 'high'
            : 'medium'
          : gpu.class === 'discrete' || !device.coarse
            ? 'high'
            : 'medium'
  // Dense large screens pay per pixel: a step down, which the pixel ratio bound makes cheap.
  return tier === 'high' && device.ratio >= 3 && device.pixels >= 1.5e6 ? 'medium' : tier
}

interface Backend {
  readonly device?: { readonly adapterInfo?: Partial<Record<string, string>> }
  readonly gl?: WebGL2RenderingContext
}

/** The GPU behind the renderer: adapter info on WebGPU, the unmasked renderer on WebGL 2. */
export function gpuInfo(render: RenderApi): GpuInfo {
  const { backend } = render
  const threeBackend = (render.renderer as unknown as { backend?: Backend }).backend
  let name = ''
  try {
    const info = threeBackend?.device?.adapterInfo
    const gl = threeBackend?.gl
    if (info) name = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
    else if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '')
    }
  } catch {
    // A lost context or a browser that hides the name: unknown.
  }
  return { backend, name, class: classify(name) }
}

/** The device as the browser reports it. */
export function device(): Device {
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as {
    deviceMemory?: number
    hardwareConcurrency?: number
  }
  const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
  const screen = typeof window === 'undefined' ? undefined : window.screen
  return {
    memory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    coarse: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    ratio,
    pixels: (screen?.width ?? 0) * (screen?.height ?? 0) * ratio * ratio,
  }
}
