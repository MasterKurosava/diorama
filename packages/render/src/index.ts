import { definePlugin, type Plugin } from '@diorama/core'
import { type Object3D, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'

declare module '@diorama/core' {
  // Types `app.render` and `find('render')` even where the plugin is only imported as a type.
  interface Services {
    render: RenderApi
  }
  interface Hooks {
    /**
     * Decides how a frame is drawn. A handler returns its own draw function, for example a
     * post-processing pipeline. When its owner goes away the default drawing comes back.
     */
    'render:frame': (draw: () => void) => () => void
  }
}

export interface RenderOptions {
  readonly antialias: boolean
  /** Camera distance in CSS px. Smaller means stronger perspective. Default 1000. */
  readonly distance: number
  /**
   * Upper bound for the drawing buffer, in device pixels. The pixel ratio drops to fit, so a
   * large high-DPI screen cannot demand gigabytes of GPU memory. Default 4 million.
   */
  readonly maxPixels: number
  /** Use the WebGL 2 backend even where WebGPU is available. Default false. */
  readonly forceWebGL: boolean
  /**
   * Clear colour. Default `null` keeps the canvas transparent for a canvas over the page. Use
   * an opaque colour for a canvas behind transparent page content.
   */
  readonly background: number | null
}

/** A viewport box in CSS px, as anchors report it. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface RenderApi {
  readonly renderer: WebGPURenderer
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  readonly backend: 'webgpu' | 'webgl2'
  /** Fits a unit-sized object, centred at its origin, onto a viewport box. */
  place(object: Object3D, box: Box): void
  /** Converts a viewport point in CSS px to world x/y on the z = 0 plane. Fills `out` if given. */
  toWorld(x: number, y: number, out?: { x: number; y: number }): { x: number; y: number }
}

const defaults: RenderOptions = {
  antialias: true,
  distance: 1000,
  maxPixels: 4_000_000,
  forceWebGL: false,
  background: null,
}

/**
 * Three.js on the stage canvas. At z = 0 one world unit is one CSS pixel, so objects line up
 * with the DOM and depth still reads as real perspective.
 */
export const render: Plugin<'render', RenderOptions, RenderApi> = /*#__PURE__*/ definePlugin({
  name: 'render',
  dependencies: ['stage'],
  defaults,
  async setup(app, options): Promise<RenderApi> {
    const { stage } = app
    const canvas = stage.canvas
    if (!canvas) throw new Error('render needs a DOM')

    const renderer = new WebGPURenderer({
      canvas,
      antialias: options.antialias,
      alpha: options.background === null,
      forceWebGL: options.forceWebGL,
    })
    await renderer.init()
    app.onDispose(renderer)
    renderer.setClearColor(options.background ?? 0x000000, options.background === null ? 0 : 1)

    const scene = new Scene()
    const { distance } = options
    const camera = new PerspectiveCamera(45, 1, 1, distance * 10)
    camera.position.z = distance

    // Resize fires dozens of times a second while a window is dragged, and reallocating GPU
    // buffers on each one can stall the driver. Mark it dirty and resize once per frame.
    let resized = true
    app.effect(() => {
      stage.width.value
      stage.height.value
      stage.pixelRatio.value
      resized = true
      app.invalidate()
    })
    const resize = (): void => {
      const width = stage.width.peek()
      const height = stage.height.peek()
      const budget = Math.sqrt(options.maxPixels / Math.max(1, width * height))
      renderer.setPixelRatio(Math.min(stage.pixelRatio.peek(), budget))
      // CSS sizes the canvas. Only the drawing buffer follows the viewport.
      renderer.setSize(width, height, false)
      camera.aspect = width / (height || 1)
      camera.fov = (2 * Math.atan(height / 2 / distance) * 180) / Math.PI
      camera.updateProjectionMatrix()
    }
    const draw = (): void => renderer.render(scene, camera)
    app.system(
      'render',
      () => {
        if (resized) {
          resized = false
          resize()
        }
        app.callHook('render:frame', draw)()
      },
      { name: 'render' },
    )

    const toWorld = (x: number, y: number, out = { x: 0, y: 0 }): { x: number; y: number } => {
      out.x = x - stage.width.peek() / 2
      out.y = stage.height.peek() / 2 - y
      return out
    }
    const centre = { x: 0, y: 0 }
    return {
      renderer,
      scene,
      camera,
      backend: 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl2',
      toWorld,
      place(object, box) {
        toWorld(box.x + box.width / 2, box.y + box.height / 2, centre)
        object.position.set(centre.x, centre.y, 0)
        object.scale.set(box.width, box.height, 1)
      },
    }
  },
})
