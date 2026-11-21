// The `render` plugin: a three.js WebGPURenderer (WebGL 2 as the fallback) on the stage canvas,
// with a camera that maps CSS px to world units, frames drawn on demand, and a shared
// image-based environment.
import {
  definePlugin,
  type Off,
  type Plugin,
  type PluginApp,
  type Signal,
  type StageApi,
  signal,
} from '@dioramajs/core'
import {
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  type RenderTarget,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'
import { hasAdapter } from './adapter'
import { cssColor } from './color'
import { serialCompile } from './compile'
import { holdLoop } from './loop'
import { warm } from './warm'

export { cssColor } from './color'

declare module '@dioramajs/core' {
  // Types `app.render` and `find('render')` even where the plugin is only imported as a type.
  interface Services {
    /** The renderer, see `RenderApi`. */
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

/** Options of the `render` plugin. */
export interface RenderOptions {
  /** MSAA. 'auto' takes it when the pixel ratio at start is below 2, where it is worth its memory. */
  readonly antialias: boolean | 'auto'
  /** Camera distance in CSS px. Smaller means stronger perspective. Default 1000. */
  readonly distance: number
  /**
   * Upper bound for the drawing buffer, in device pixels. The pixel ratio drops to fit, so a
   * large high-DPI screen cannot demand gigabytes of GPU memory. Default 4 million.
   */
  readonly maxPixels: number
  /**
   * Use the WebGL 2 backend even where WebGPU is available. Default false: WebGPU when the
   * browser gives an adapter, else WebGL 2, chosen before the renderer is made.
   */
  readonly forceWebGL: boolean
  /**
   * Clear colour, a number or any CSS colour. Default `null` keeps the canvas transparent for a
   * canvas over the page. Use an opaque colour for a canvas behind transparent page content.
   */
  readonly background: number | string | null
  /**
   * Image-based light for lit materials: 'room' (three's RoomEnvironment through PMREM, made on
   * the first lease) or 'none' (default).
   */
  readonly environment: 'none' | 'room'
}

/** A lease on `scene.environment`, see `RenderApi.environment`. */
export interface EnvironmentLease {
  /** Resolves once `scene.environment` is set. At once with 'none'. */
  readonly ready: Promise<void>
  /** Releases the lease. */
  readonly off: Off
}

/** A viewport box in CSS px, as anchors report it. */
export interface Box {
  /** Viewport x, CSS px. */
  readonly x: number
  /** Viewport y, CSS px. */
  readonly y: number
  /** Width, CSS px. */
  readonly width: number
  /** Height, CSS px. */
  readonly height: number
}

/** The `render` service: the three.js renderer, scene and camera. */
export interface RenderApi {
  /** The three.js renderer. */
  readonly renderer: WebGPURenderer
  /** The scene GL copies live in. */
  readonly scene: Scene
  /** Camera that maps CSS px to world units at z = 0. */
  readonly camera: PerspectiveCamera
  /** Backend in use: WebGPU, or WebGL 2 as the fallback. */
  readonly backend: 'webgpu' | 'webgl2'
  /** Fits a unit-sized object, centred at its origin, onto a viewport box. */
  place(object: Object3D, box: Box): void
  /** Converts a viewport point in CSS px to world x/y on the z = 0 plane. Fills `out` if given. */
  toWorld(x: number, y: number, out?: { x: number; y: number }): { x: number; y: number }
  /** Upper bound of the pixel ratio, applied at the next frame. Default Infinity. */
  readonly maxPixelRatio: Signal<number>
  /**
   * A lease on `scene.environment`: the first creates it, the last frees it. Ready at once with
   * `environment: 'none'`.
   */
  environment(): EnvironmentLease
}

const defaults: RenderOptions = {
  antialias: true,
  distance: 1000,
  maxPixels: 4_000_000,
  forceWebGL: false,
  background: null,
  environment: 'none',
}

/** Starting field of view in degrees. Every resize sets it from the viewport and `distance`. */
const FOV = 45
/** The far plane sits this many `distance`s from the camera. */
const FAR = 10
/** Blur of the room environment in PMREM, as three's examples use it. */
const ROOM_BLUR = 0.04

type App = PluginApp<{ readonly stage: StageApi }>

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
    const renderer = await createRenderer(app, options, canvas)
    const scene = new Scene()
    const { distance } = options
    const camera = new PerspectiveCamera(FOV, 1, 1, distance * FAR)
    camera.position.z = distance
    const maxPixelRatio = signal(Number.POSITIVE_INFINITY)
    drawFrames(app, options, renderer, scene, camera, maxPixelRatio)

    const toWorld = (x: number, y: number, out = { x: 0, y: 0 }): { x: number; y: number } => {
      out.x = x - stage.width.peek() / 2
      out.y = stage.height.peek() / 2 - y
      return out
    }
    const centre = { x: 0, y: 0 }
    return {
      maxPixelRatio,
      environment: environments(app, options, renderer, scene),
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

/** Makes, initialises and warms up the renderer, and takes over three's own frame loop. */
async function createRenderer(
  app: App,
  options: RenderOptions,
  canvas: HTMLCanvasElement,
): Promise<WebGPURenderer> {
  let background = options.background
  if (typeof background === 'string') {
    const parsed = cssColor(background)
    if (!parsed)
      app.log.warn(`render: background "${background}" is not a colour, kept transparent`)
    background = parsed ?? null
  }
  // samples are fixed in the constructor, so 'auto' decides once.
  const antialias =
    options.antialias === 'auto' ? app.stage.pixelRatio.peek() < 2 : options.antialias
  // Without an adapter three would try WebGPU, warn and fall back: take WebGL 2 at once.
  const forceWebGL = options.forceWebGL || !(await hasAdapter())
  const renderer = new WebGPURenderer({
    canvas,
    antialias,
    alpha: background === null,
    forceWebGL,
  })
  await renderer.init()
  serialCompile(renderer)
  app.onDispose(renderer)
  renderer.setClearColor(background ?? 0x000000, background === null ? 0 : 1)
  // The page's first node build, the slowest, apart from the first frame.
  await warm(renderer)
  // three runs its own animation frames from the first render on, which would keep the page
  // awake at rest. Its per-frame work runs at the start of each app frame instead, before
  // anything renders or reads `renderer.info`.
  const three = holdLoop(renderer)
  if (three) app.system('input', (time) => three.tick(time.now), { name: 'render:three' })
  else app.log.warn('render: unknown three.js frame loop, three keeps asking for frames at rest')
  return renderer
}

/**
 * Draws the scene in the `render` phase, through the `render:frame` hook. Resize fires dozens of
 * times a second while a window is dragged, and reallocating GPU buffers on each one can stall
 * the driver, so a change only marks the size dirty and the frame resizes once.
 */
function drawFrames(
  app: App,
  options: RenderOptions,
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  maxPixelRatio: Signal<number>,
): void {
  const { stage } = app
  const { distance } = options
  let resized = true
  app.effect(() => {
    stage.width.value
    stage.height.value
    stage.pixelRatio.value
    maxPixelRatio.value
    resized = true
    app.invalidate()
  })
  const resize = (): void => {
    const width = stage.width.peek()
    const height = stage.height.peek()
    const budget = Math.sqrt(options.maxPixels / Math.max(1, width * height))
    renderer.setPixelRatio(Math.min(stage.pixelRatio.peek(), budget, maxPixelRatio.peek()))
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
}

/** `RenderApi.environment`: the room environment, made on the first lease and freed with the last. */
function environments(
  app: App,
  options: RenderOptions,
  renderer: WebGPURenderer,
  scene: Scene,
): () => EnvironmentLease {
  let leases = 0
  let made: Promise<void> | undefined
  let target: RenderTarget | undefined
  const free = (): void => {
    if (scene.environment === target?.texture) scene.environment = null
    target?.dispose()
    target = undefined
    made = undefined
  }
  app.onDispose(() => {
    leases = 0
    free()
  })
  return () => {
    if (options.environment !== 'room') return { ready: Promise.resolve(), off: () => {} }
    leases++
    made ??= import('three/addons/environments/RoomEnvironment.js').then(({ RoomEnvironment }) => {
      // Every lease went while the module loaded, or a later build replaced this one.
      if (!leases || made !== build) return
      const room = new RoomEnvironment()
      const pmrem = new PMREMGenerator(renderer)
      target = pmrem.fromScene(room, ROOM_BLUR)
      pmrem.dispose()
      room.dispose()
      scene.environment = target.texture
      app.invalidate()
    })
    const build = made
    let done = false
    return {
      ready: build,
      off: () => {
        if (done) return
        done = true
        if (--leases === 0) free()
      },
    }
  }
}
