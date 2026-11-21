// The surface: an element's single GL copy, a plane in its layer's box. Effects add position, uv
// and color transforms through `ctx.surface`; the surface assembles them in effect order into one
// material, compiles it off the frame and swaps it in. Also the compile queue of the runtime.
import type { Off } from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import { clamp, positionLocal, texture, uv, vec4 } from 'three/tsl'
import {
  type BufferGeometry,
  getConsoleFunction,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Object3D,
  PlaneGeometry,
  setConsoleFunction,
  type WebGPURenderer,
} from 'three/webgpu'
import { EffectError } from '../errors'
import { canSlice, slice } from '../slice'
import type { Surface, SurfaceInput } from '../types'
import type { Phase } from './instance'
import type { LayerImpl } from './layer'

type TransformKind = 'position' | 'uv' | 'color'
type TransformFn = (...args: never[]) => Node

interface Transform {
  readonly phase: Phase
  readonly kind: TransformKind
  readonly fn: TransformFn
}

/** A material assembled for these phases, compiling or ready to swap in. */
interface Build {
  readonly material: MeshBasicNodeMaterial
  readonly geometry: BufferGeometry
  readonly phases: readonly Phase[]
}

export interface SurfaceHost {
  readonly render: RenderApi
  geometry(segments: number): BufferGeometry
  release(geometry: BufferGeometry): void
  /** Queues a compile. Skipped, resolving undefined, if `alive` is false by its turn. */
  compile(mesh: Mesh, alive: () => boolean): Promise<unknown>
  /** A phase failed at assembly or compile. Fails its mount, rebuild or running instance. */
  failed(phase: Phase, error: EffectError): void
  activate(phase: Phase): void
  later(task: () => void): void
  invalidate(): void
  warn(key: string, error: EffectError): void
}

/** Most subdivisions per side `surface.segments()` gives. */
const MAX_SEGMENTS = 512
/** Console errors of three that mean a compile failed. */
const FAILURE = /^(THREE\.)?(TSL:|WebGPURenderer: Async render pipeline creation failed)/

/**
 * Compiles one object at a time. `compileAsync` in r187 never rejects, so errors are caught from
 * three's console function, `debug.onShaderError` (WebGL 2) and `onError` (WebGPU). A job whose
 * `alive` is false by its turn is skipped, because compiling a disposed object would create
 * render objects whose dispose events already fired.
 */
export function compiler(
  render: RenderApi,
): (object: Object3D, alive?: () => boolean) => Promise<unknown> {
  let queue: Promise<unknown> = Promise.resolve()
  return (object, alive) => {
    const run = queue.then(async () => {
      if (alive && !alive()) return undefined
      // A compile's first slice is long: not in the task of the setup or frame that queued it.
      if (canSlice()) {
        await slice()
        if (alive && !alive()) return undefined
      }
      const { renderer, camera, scene } = render
      let failure: unknown
      const restore = catchFailures(renderer, (error) => {
        failure ??= error
      })
      const hideAgain = showHidden(object)
      try {
        let job: Promise<void>
        try {
          job = renderer.compileAsync(object, camera, scene)
        } finally {
          hideAgain()
        }
        await job
      } catch (error) {
        failure ??= error
      } finally {
        restore()
      }
      return failure
    })
    queue = run.catch(() => {})
    return run
  }
}

/** Plane geometries shared by subdivision count, with a reference count. */
export class Planes {
  readonly #all = new Map<number, { geometry: PlaneGeometry; refs: number }>()

  get(segments: number): BufferGeometry {
    let entry = this.#all.get(segments)
    if (!entry) {
      entry = { geometry: new PlaneGeometry(1, 1, segments, segments), refs: 0 }
      this.#all.set(segments, entry)
    }
    entry.refs++
    return entry.geometry
  }

  release(geometry: BufferGeometry): void {
    for (const [segments, entry] of this.#all) {
      if (entry.geometry !== geometry || --entry.refs > 0) continue
      this.#all.delete(segments)
      geometry.dispose()
    }
  }

  dispose(): void {
    for (const { geometry } of this.#all.values()) geometry.dispose()
    this.#all.clear()
  }
}

/** The element's single GL copy. Effects add transforms, applied in effect order. */
export class SurfaceImpl {
  readonly layer: LayerImpl
  readonly mesh: Mesh
  /** Phases that accessed `ctx.surface`. The surface lives while any does. */
  readonly users: Set<Phase> = new Set()
  /** A compiled material is on the mesh. */
  ready = false
  /** The transforms changed since the last build started. */
  dirty = true
  disposed = false
  readonly #host: SurfaceHost
  readonly #transforms = new Set<Transform>()
  /** Framings set by `zoom`, per phase: scale, x, y. */
  readonly #zooms = new Map<Phase | undefined, readonly [number, number, number]>()
  /** Phases built into the material on the mesh. */
  #built = new Set<Phase>()
  #building = false
  /** A compiled build waiting for the next compose. */
  #swap: Build | undefined

  constructor(layer: LayerImpl, host: SurfaceHost) {
    this.layer = layer
    this.#host = host
    this.mesh = new Mesh(host.geometry(1), flatMaterial())
    this.mesh.visible = false
    layer.box.add(this.mesh)
  }

  /** `ctx.surface` of one phase, with transforms tagged by that phase. */
  facade(phase: Phase): Surface {
    this.users.add(phase)
    const add =
      (kind: TransformKind) =>
      (fn: TransformFn): Off => {
        const transform: Transform = { phase, kind, fn }
        this.#transforms.add(transform)
        this.changed(phase)
        let done = false
        return () => {
          if (done || !this.#transforms.delete(transform)) return
          done = true
          this.changed(phase)
        }
      }
    const mesh = this.mesh
    return {
      mesh,
      get material() {
        return mesh.material as MeshBasicNodeMaterial
      },
      segments: (count) => {
        const segments = Math.min(MAX_SEGMENTS, Math.floor(count) || 1)
        phase.segments = Math.max(phase.segments, segments)
        this.changed(phase)
      },
      position: add('position') as Surface['position'],
      uv: add('uv') as Surface['uv'],
      color: add('color') as Surface['color'],
      zoom: (scale, x = 0, y = 0) => {
        if (phase.state !== 'closed') this.#zooms.set(phase, [scale > 0 ? scale : 1, x, y])
      },
    }
  }

  /** An effect frames the media with `zoom`, so compose applies it after the updates. */
  get zoomed(): boolean {
    return this.#zooms.size > 0
  }

  /** Compiled, media ready, held by a running effect and not replaced. */
  get drawable(): boolean {
    const media = this.layer.media
    if (!this.ready || (media && media.state !== 'ready') || this.layer.replaced()) return false
    for (const phase of this.#built) {
      if (phase.state === 'active' && !phase.inst.parked && !phase.dom) return true
    }
    return false
  }

  /**
   * Applies the effects' `zoom` framings to a crop (scale u, scale v, offset u, offset v). Like
   * `uv` transforms, the first effect's framing is applied to box UV first.
   */
  frame(crop: number[]): void {
    const insts = this.layer.insts
    for (let index = insts.length; index-- > 0; ) {
      const inst = insts[index]
      const zoom = this.#zooms.get(inst?.current) ?? this.#zooms.get(inst?.next)
      if (!zoom) continue
      const [s, x, y] = zoom
      const [w = 1, h = 1, u = 0, v = 0] = crop
      // Box UV b shows the media at (b - 0.5 - x) / s + 0.5 before the crop.
      crop.splice(0, 4, w / s, h / s, u + w * (0.5 - (0.5 + x) / s), v + h * (0.5 - (0.5 + y) / s))
    }
  }

  /** The transform set changed. Transforms of a phase still in setup wait for it. */
  changed(phase?: Phase): void {
    if (phase?.state === 'setup') return
    this.dirty = true
    this.#host.invalidate()
  }

  /** A phase leaves. Its transforms go and the material is rebuilt without them. */
  remove(phase: Phase): void {
    this.users.delete(phase)
    this.#zooms.delete(phase)
    for (const transform of this.#transforms) {
      if (transform.phase === phase) this.#transforms.delete(transform)
    }
    // A phase that never reached a material (abandoned in setup, replaced by its rebuild)
    // leaves the one on the mesh valid. No recompile, so a ghost keeps its look.
    if (this.#built.delete(phase) || this.#building || this.#swap) this.changed()
  }

  /** Swaps in a compiled material, then starts the next build if needed. Runs in compose. */
  compose(): void {
    this.#takeSwap()
    const media = this.layer.media
    if (media?.state === 'failed') {
      for (const phase of [...this.users]) this.#host.failed(phase, media.error as EffectError)
      return
    }
    if (!this.dirty || this.#building || (media && media.state !== 'ready')) return
    this.dirty = false
    const phases = this.#select()
    if (!phases.length) return
    const build = this.#build(phases)
    if (!build) return
    this.#building = true
    // Skip the build if the surface is gone by its turn, or it would upload a disposed texture.
    const alive = (): boolean => !this.disposed && !isStale(build)
    void this.#host
      .compile(new Mesh(build.geometry, build.material), alive)
      .then((cause) => this.#compiled(build, cause))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mesh.removeFromParent()
    const material = this.mesh.material as MeshBasicNodeMaterial
    const geometry = this.mesh.geometry
    this.#host.later(() => {
      material.dispose()
      this.#host.release(geometry)
      if (this.#swap) this.#discard(this.#swap)
    })
  }

  /** Puts a compiled build on the mesh and activates its ready phases. */
  #takeSwap(): void {
    const swap = this.#swap
    this.#swap = undefined
    if (!swap) return
    // A phase closed after its build compiled. The follow-up build (dirty) replaces it.
    if (isStale(swap)) {
      this.#discard(swap)
      return
    }
    const old = this.mesh.material as MeshBasicNodeMaterial
    const geometry = this.mesh.geometry
    this.mesh.material = swap.material
    this.mesh.geometry = swap.geometry
    this.#host.later(() => {
      old.dispose()
      this.#host.release(geometry)
    })
    this.#built = new Set(swap.phases)
    this.ready = true
    for (const phase of swap.phases) if (phase.state === 'ready') this.#host.activate(phase)
  }

  /** A build finished compiling: it waits for compose, or fails the phases new in it. */
  #compiled(build: Build, cause: unknown): void {
    this.#building = false
    // A phase closed during compilation (its removal made the surface dirty again).
    if (this.disposed || isStale(build)) this.#discard(build)
    else if (cause === undefined) this.#swap = build
    else {
      this.#discard(build)
      const fresh = build.phases.filter((phase) => !this.#built.has(phase))
      const error = (phase: Phase): EffectError =>
        new EffectError('EFFECT_COMPILE', `"${phase.inst.rec.name}" does not compile`, {
          effect: phase.inst.rec.name,
          element: this.layer.element,
          cause,
        })
      if (!fresh.length) this.#host.warn('compile', error(build.phases[0] as Phase))
      for (const phase of fresh) this.#host.failed(phase, error(phase))
      this.dirty = fresh.length > 0
    }
    this.#host.invalidate()
  }

  #discard(build: Build): void {
    build.material.dispose()
    this.#host.release(build.geometry)
  }

  /** The phase of each instance that the next material is built for, in effect order. */
  #select(): Phase[] {
    const phases: Phase[] = []
    for (const inst of this.layer.insts) {
      const { next, current } = inst
      const replacing = this.users.has(next as Phase) || this.users.has(current as Phase)
      if (next?.state === 'ready' && replacing) phases.push(next)
      else if (current?.state === 'active' && this.users.has(current)) phases.push(current)
    }
    return phases
  }

  /** Assembles the material. A throwing transform fails only its own phase. */
  #build(phases: readonly Phase[]): Build | undefined {
    const layer = this.layer
    const map = layer.media?.texture
    const box = uv()
    // A point displaced past the box reads the picture past its edge, like ClampToEdge. Masking
    // at the nearest box point keeps the box edge, and `contain` bands stay clear.
    const sample = (at: Node<'vec2'>): Node<'vec4'> => {
      if (!map) return vec4(0)
      const color = texture(map, layer.coverUV(at))
      const mask = layer.containMask(clamp(at, 0, 1) as Node<'vec2'>)
      return vec4(color.rgb, color.a.mul(mask, layer.radiusMask(box)))
    }
    const ordered = (kind: TransformKind): Transform[] =>
      phases.flatMap((phase) =>
        [...this.#transforms].filter((t) => t.phase === phase && t.kind === kind),
      )
    let failed: Transform | undefined
    let thrown: unknown
    const apply = <T>(
      kind: TransformKind,
      start: T,
      call: (fn: TransformFn, value: T) => unknown,
    ): T => {
      let value = start
      for (const transform of ordered(kind)) {
        if (failed) break
        try {
          value = call(transform.fn, value) as T
        } catch (error) {
          failed = transform
          thrown = error
        }
      }
      return value
    }
    type Call = (fn: TransformFn, value: Node) => unknown
    const position = apply<Node>('position', positionLocal, ((fn, value) =>
      (fn as (position: Node, uv: Node) => Node)(value, box)) as Call)
    const mapped = apply<Node>('uv', box, ((fn, value) =>
      (fn as (uv: Node) => Node)(value)) as Call)
    const input: SurfaceInput = {
      uv: mapped as Node<'vec2'>,
      box,
      sample,
      radius: layer.radiusMask(box),
    }
    const color = apply<Node>('color', sample(mapped as Node<'vec2'>), ((fn, value) =>
      (fn as (color: Node, input: SurfaceInput) => Node)(value, input)) as Call)
    if (failed) {
      const { phase } = failed
      const name = phase.inst.rec.name
      const error = new EffectError('EFFECT_COMPILE', `a surface transform of "${name}" threw`, {
        effect: name,
        element: layer.element,
        cause: thrown,
      })
      this.#host.failed(phase, error)
      this.dirty = true
      return undefined
    }
    const rgba = color as Node<'vec4'>
    const material = flatMaterial()
    material.positionNode = position
    material.colorNode = vec4(rgba.rgb, rgba.a.mul(layer.clipMask(box), layer.opacity()))
    const segments = Math.max(1, ...phases.map((phase) => phase.segments))
    return { material, geometry: this.#host.geometry(segments), phases }
  }
}

const isStale = (build: Build): boolean => build.phases.some((phase) => phase.state === 'closed')

/**
 * A copy is flat: it never tests or writes depth, so between layers only their order counts.
 * Depth stays for an effect's own 3D content.
 */
const flatMaterial = (): MeshBasicNodeMaterial =>
  new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })

/**
 * Routes compile errors to `fail` from three's console function, `debug.onShaderError` and
 * `onError`, each still passed on. Returns the function that puts the originals back.
 */
function catchFailures(renderer: WebGPURenderer, fail: (error: unknown) => void): () => void {
  const log = getConsoleFunction()
  setConsoleFunction((type, message, ...params) => {
    if (type === 'error' && FAILURE.test(message)) fail(new Error(message))
    if (log) log(type, message, ...params)
    else console[type](message, ...params)
  })
  const debug = renderer.debug as { onShaderError: ((...args: unknown[]) => void) | null }
  const shaderError = debug.onShaderError
  debug.onShaderError = (...args) => {
    fail(new Error('shader compilation failed'))
    shaderError?.(...args)
  }
  // Typed as (message: string) in @types/three, but r187 passes { api, type, message }.
  const gpu = renderer as unknown as { onError: (info: { message?: string }) => void }
  const onError = gpu.onError
  gpu.onError = (info) => {
    fail(new Error(info?.message ?? 'uncaptured GPU error'))
    onError.call(renderer, info)
  }
  return () => {
    setConsoleFunction(log as Parameters<typeof setConsoleFunction>[0])
    debug.onShaderError = shaderError
    gpu.onError = onError
  }
}

/**
 * r187 projects synchronously at the compile call and skips hidden objects, so an object hidden
 * until it is needed (hotspots, a dialog's backdrop) would build its pipeline in the frame it
 * first shows, blocking the GPU process. It counts as visible for that call only: the returned
 * function hides it again.
 */
function showHidden(object: Object3D): () => void {
  const hidden: Object3D[] = []
  object.traverse((child) => {
    if (child.visible) return
    hidden.push(child)
    child.visible = true
  })
  return () => {
    for (const child of hidden) child.visible = false
  }
}
