// Test helpers: a `render` without a GPU (real three scene objects, a renderer that only counts
// what it draws, compiles and uploads) and helpers that start an app on it in happy-dom.
import {
  type App,
  createApp,
  definePlugin,
  type ErrorReport,
  manualDriver,
  type Plugin,
  type PluginEntry,
  signal,
} from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import {
  type Material,
  type Mesh,
  type Node,
  type Object3D,
  PerspectiveCamera,
  Scene,
  type Sprite,
  type Texture,
} from 'three/webgpu'
import { type EffectEntries, type EffectName, type EffectsOptions, effects } from '../index'

// What the fake renderer has drawn, compiled or uploaded and not seen disposed since: three's
// `Info.memory` in spirit, plus materials and object-material pairs (r187 `RenderObject`).

interface Disposable {
  addEventListener(type: 'dispose', listener: () => void): void
  removeEventListener(type: 'dispose', listener: () => void): void
}
type Kind = 'geometries' | 'materials' | 'textures' | 'renderTargets'

const live: Record<Kind, Set<object>> = {
  geometries: new Set(),
  materials: new Set(),
  textures: new Set(),
  renderTargets: new Set(),
}
/** Materials each object was drawn or compiled with. */
const pairs = new Map<object, Set<object>>()
/** Disposed and not drawn since. */
let disposed = new WeakSet<object>()

const onDispose = (target: object, done: () => void): void => {
  const disposable = target as Disposable
  const listener = (): void => {
    disposable.removeEventListener('dispose', listener)
    done()
  }
  disposable.addEventListener('dispose', listener)
}

/** Counts a resource as live until its dispose event. */
function track(kind: Kind, resource: object): void {
  const set = live[kind]
  if (set.has(resource)) return
  set.add(resource)
  disposed.delete(resource)
  onDispose(resource, () => {
    set.delete(resource)
    disposed.add(resource)
    if (kind === 'materials') for (const used of pairs.values()) used.delete(resource)
  })
}

const DRAWABLE = ['isMesh', 'isPoints', 'isLine', 'isSprite'] as const
const drawable = (object: Object3D): boolean =>
  DRAWABLE.some((flag) => flag in object && (object as never)[flag])

/** Textures of a material: its own properties and the TextureNodes of every node property. */
function texturesOf(material: Material): Set<Texture> {
  const found = new Set<Texture>()
  const seen = new Set<Node>()
  const walk = (node: Node): void => {
    if (seen.has(node)) return
    seen.add(node)
    const value = (node as { isTextureNode?: boolean; value?: Texture }).value
    if ((node as { isTextureNode?: boolean }).isTextureNode && value?.isTexture) found.add(value)
    for (const child of node.getChildren()) walk(child)
  }
  for (const value of Object.values(material)) {
    if ((value as Texture | null)?.isTexture) found.add(value)
    else if ((value as { isNode?: boolean } | null)?.isNode === true) walk(value)
  }
  return found
}

function trackTexture(texture: Texture): void {
  const target = (texture as { isRenderTargetTexture?: boolean; renderTarget?: object })
    .renderTarget
  // A render target's texture has no dispose listener in r187: its target is counted.
  if ((texture as { isRenderTargetTexture?: boolean }).isRenderTargetTexture && target) {
    track('renderTargets', target)
  } else track('textures', texture)
}

function resourcesOf(object: Object3D): { geometry?: object; materials: Material[] } {
  const { geometry, material } = object as Mesh
  return { geometry, materials: [material ?? []].flat() as Material[] }
}

/** Counts what drawing or compiling one object makes live. */
function visit(object: Object3D): void {
  const { geometry, materials } = resourcesOf(object)
  if (geometry) track('geometries', geometry)
  for (const material of materials) {
    track('materials', material)
    let used = pairs.get(object)
    if (!used) {
      const set = new Set<object>()
      used = set
      pairs.set(object, set)
      onDispose(object, () => {
        if (pairs.get(object) === set) pairs.delete(object)
      })
    }
    used.add(material)
    for (const texture of texturesOf(material)) trackTexture(texture)
  }
}

const visitTree = (root: Object3D): void =>
  root.traverseVisible((object) => {
    if (drawable(object)) visit(object)
  })

/** What the fake renderer drew, compiled and uploaded, and switches to make it fail. */
export const gpu = {
  draws: 0,
  compiles: 0,
  /** `initTexture` calls: textures uploaded ahead of their first draw. */
  uploads: [] as Texture[],
  /** Objects whose pipelines `compileAsync` built: those visible at the call. */
  compiled: [] as Object3D[],
  /** Runs inside compileAsync: report a TSL error through three's console function here. */
  compile: undefined as (() => void) | undefined,
  /** Runs inside the draw: throw to simulate a failing frame. */
  draw: undefined as (() => void) | undefined,
  /** Delays compileAsync before it makes render objects and uploads textures, as r187 does. */
  gate: undefined as Promise<void> | undefined,
  /** `render.environment()`: leases held now, environments made and freed. */
  environment: { leases: 0, made: 0, freed: 0 },
  /** Delays the environment's ready. */
  lit: undefined as Promise<void> | undefined,
  reset(): void {
    gpu.draws = 0
    gpu.compiles = 0
    gpu.uploads = []
    gpu.compiled = []
    gpu.compile = undefined
    gpu.draw = undefined
    gpu.gate = undefined
    gpu.environment = { leases: 0, made: 0, freed: 0 }
    gpu.lit = undefined
    for (const set of Object.values(live)) set.clear()
    pairs.clear()
    disposed = new WeakSet()
  },
  /** Live resources and object-material pairs. */
  memory(): Record<Kind | 'renderObjects', number> {
    let renderObjects = 0
    for (const used of pairs.values()) renderObjects += used.size
    return {
      geometries: live.geometries.size,
      materials: live.materials.size,
      textures: live.textures.size,
      renderTargets: live.renderTargets.size,
      renderObjects,
    }
  },
  /** Disposed resources still referenced from the scene: always empty. */
  stale(scene: Object3D | undefined): object[] {
    const found = new Set<object>()
    scene?.traverse((object) => {
      if (!drawable(object)) return
      const { geometry, materials } = resourcesOf(object)
      const textures = materials.flatMap((material) => [...texturesOf(material)])
      for (const resource of [geometry, ...materials, ...textures]) {
        if (resource && disposed.has(resource)) found.add(resource)
      }
    })
    return [...found]
  },
}

/** A `render` plugin without a GPU: a real three scene and a renderer that only counts. */
export const fakeRender: Plugin<'render'> = definePlugin({
  name: 'render',
  dependencies: ['stage'],
  setup(app): RenderApi {
    const scene = new Scene()
    const camera = new PerspectiveCamera()
    const renderer = {
      domElement: document.createElement('canvas'),
      debug: { onShaderError: null },
      info: {},
      onDeviceLost() {},
      onError() {},
      async compileAsync(object: Object3D) {
        gpu.compiles++
        // r187 projects at the call, skipping hidden objects, and makes render objects and
        // uploads textures after the node build yields.
        const seen: Object3D[] = []
        object.traverseVisible((child) => {
          if (drawable(child)) seen.push(child)
        })
        await gpu.gate
        for (const child of seen) visit(child)
        gpu.compiled.push(...seen)
        gpu.compile?.()
      },
      initTexture(texture: Texture) {
        gpu.uploads.push(texture)
        trackTexture(texture)
      },
      render() {
        gpu.draws++
        gpu.draw?.()
        visitTree(scene)
      },
    }
    const draw = (): void => renderer.render()
    app.system('render', () => app.callHook('render:frame', draw)(), { name: 'render' })
    const toWorld = (x: number, y: number): { x: number; y: number } => ({
      x: x - app.stage.width.peek() / 2,
      y: app.stage.height.peek() / 2 - y,
    })
    const environment = () => {
      if (gpu.environment.leases++ === 0) gpu.environment.made++
      let done = false
      return {
        ready: Promise.resolve(gpu.lit),
        off() {
          if (done) return
          done = true
          if (--gpu.environment.leases === 0) gpu.environment.freed++
        },
      }
    }
    const maxPixelRatio = signal(Number.POSITIVE_INFINITY)
    return {
      renderer,
      scene,
      camera,
      backend: 'webgl2',
      toWorld,
      place() {},
      environment,
      maxPixelRatio,
    } as never
  },
})

/** Waits one task. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Alternates tasks and frames until both settle; returns the frames drawn. */
export async function run(driver: ReturnType<typeof manualDriver>, rounds = 6): Promise<number> {
  let frames = 0
  for (let i = 0; i < rounds; i++) {
    await tick()
    frames += driver.flush(100)
  }
  return frames
}

/** A viewport box for happy-dom, which lays nothing out. */
export function box(element: Element, x: number, y: number, width: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }) as DOMRect
}

/** Adds an element with a viewport box. */
export function html(markup: string, x = 0, y = 0, width = 200, height = 100): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = markup
  const element = holder.firstElementChild as HTMLElement
  document.body.append(element)
  box(element, x, y, width, height)
  return element
}

/** The element's `data-dio-state`. */
export const state = (element: Element): string | null => element.getAttribute('data-dio-state')

/** The status of an effect instance on an element. */
export const status = (app: App, element: Element, name: string): string | undefined =>
  // The cast: a package that extends EffectTypes (media) narrows names to its own.
  app.effects.get(element, name as EffectName)?.status.value

/** Meshes and sprites in the render scene. */
export function objects(app: App): Object3D[] {
  const found: Object3D[] = []
  app.effects.render?.scene.traverse((object) => {
    if ((object as Mesh).isMesh || (object as Sprite).isSprite) found.push(object)
  })
  return found
}

/** An app started by `start` with its driver and what it reported. */
export interface World {
  /** The running app. */
  readonly app: App
  /** Steps frames by hand. */
  readonly driver: ReturnType<typeof manualDriver>
  /** Errors the app reported. */
  readonly errors: ErrorReport[]
  /** Warnings the app logged. */
  readonly warnings: string[]
}

/** happy-dom has no viewport size: the stage reads these. */
export function viewport(width = 1000, height = 800): void {
  const root = document.documentElement
  Object.defineProperty(root, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(root, 'clientHeight', { value: height, configurable: true })
}

/** Starts an app with the fake render, the effects preset and these entries, engine loaded. */
export async function start(
  entries: EffectEntries,
  options: Partial<EffectsOptions> = {},
  before?: (app: App) => void,
  plugins: readonly PluginEntry[] = [],
): Promise<World> {
  viewport()
  const driver = manualDriver()
  const errors: ErrorReport[] = []
  const warnings: string[] = []
  const app = createApp({
    logger: {
      debug() {},
      info() {},
      error() {},
      warn: (...data: unknown[]) => warnings.push(data.map(String).join(' ')),
    },
    loop: { driver },
    onError: (report) => errors.push(report),
    plugins: [fakeRender, ...plugins],
    presets: [effects({ enabled: true, prefetch: false, effects: entries, ...options })],
  })
  await app.start()
  before?.(app as unknown as App)
  await app.effects.load()
  await run(driver)
  return { app: app as unknown as App, driver, errors, warnings }
}

/** The codes of reported errors, the cause first. */
export const codes = (errors: readonly ErrorReport[]): string[] =>
  errors.map(
    (report) => (report.error.cause as { code?: string } | undefined)?.code ?? report.error.code,
  )
