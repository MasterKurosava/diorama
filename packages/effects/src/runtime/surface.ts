import type { Off } from '@diorama/core'
import type { RenderApi } from '@diorama/render'
import { clamp, positionLocal, texture, uv, vec4 } from 'three/tsl'
import {
  type BufferGeometry,
  getConsoleFunction,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  setConsoleFunction,
} from 'three/webgpu'
import { EffectError } from '../errors'
import type { Surface, SurfaceInput } from '../types'
import type { Phase } from './instance'
import type { LayerImpl } from './layer'

type Kind = 'position' | 'uv' | 'color'
type Fn = (...args: never[]) => Node
interface Transform {
  readonly phase: Phase
  readonly kind: Kind
  readonly fn: Fn
}
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

const stale = (build: Build): boolean => build.phases.some((p) => p.state === 'closed')

const FAILURE = /^(THREE\.)?(TSL:|WebGPURenderer: Async render pipeline creation failed)/

/**
 * Compiles one mesh at a time. `compileAsync` in r187 never rejects, so errors are caught from
 * three's console function, `debug.onShaderError` (WebGL 2) and `onError` (WebGPU). A job whose
 * `alive` is false by its turn is skipped, because compiling a disposed object would create
 * render objects whose dispose events already fired.
 */
export function compiler(
  render: RenderApi,
): (mesh: Mesh, alive?: () => boolean) => Promise<unknown> {
  let queue: Promise<unknown> = Promise.resolve()
  return (mesh, alive) => {
    const run = queue.then(async () => {
      if (alive && !alive()) return undefined
      const { renderer, camera, scene } = render
      let failure: unknown
      const fail = (error: unknown): void => {
        failure ??= error
      }
      const log = getConsoleFunction()
      setConsoleFunction((type, message, ...params) => {
        if (type === 'error' && FAILURE.test(message)) fail(new Error(message))
        if (log) log(type, message, ...params)
        else console[type](message, ...params)
      })
      const debug = renderer.debug as { onShaderError: ((...args: unknown[]) => void) | null }
      const shader = debug.onShaderError
      debug.onShaderError = (...args) => {
        fail(new Error('shader compilation failed'))
        shader?.(...args)
      }
      // Typed as (message: string) in @types/three, but r187 passes { api, type, message }.
      const gpu = renderer as unknown as { onError: (info: { message?: string }) => void }
      const onError = gpu.onError
      gpu.onError = (info) => {
        fail(new Error(info?.message ?? 'uncaptured GPU error'))
        onError.call(renderer, info)
      }
      try {
        await renderer.compileAsync(mesh, camera, scene)
      } catch (error) {
        fail(error)
      } finally {
        setConsoleFunction(log as Parameters<typeof setConsoleFunction>[0])
        debug.onShaderError = shader
        gpu.onError = onError
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
  dirty = true
  disposed = false
  readonly #host: SurfaceHost
  readonly #transforms = new Set<Transform>()
  /** Phases built into the material on the mesh. */
  #good = new Set<Phase>()
  #building = false
  #swap: Build | undefined

  constructor(layer: LayerImpl, host: SurfaceHost) {
    this.layer = layer
    this.#host = host
    this.mesh = new Mesh(host.geometry(1), new MeshBasicNodeMaterial({ transparent: true }))
    this.mesh.visible = false
    layer.box.add(this.mesh)
  }

  /** `ctx.surface` of one phase, with transforms tagged by that phase. */
  facade(phase: Phase): Surface {
    this.users.add(phase)
    const add =
      (kind: Kind) =>
      (fn: Fn): Off => {
        const t: Transform = { phase, kind, fn }
        this.#transforms.add(t)
        this.changed(phase)
        let done = false
        return () => {
          if (done || !this.#transforms.delete(t)) return
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
        phase.segments = Math.max(phase.segments, Math.min(512, Math.floor(count) || 1))
        this.changed(phase)
      },
      position: add('position') as Surface['position'],
      uv: add('uv') as Surface['uv'],
      color: add('color') as Surface['color'],
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
    for (const t of this.#transforms) if (t.phase === phase) this.#transforms.delete(t)
    // A phase that never reached a material (abandoned in setup, replaced by its rebuild)
    // leaves the one on the mesh valid. No recompile, so a ghost keeps its look.
    if (this.#good.delete(phase) || this.#building || this.#swap) this.changed()
  }

  /** The phase of each instance that the next material is built for, in effect order. */
  #select(): Phase[] {
    const phases: Phase[] = []
    for (const inst of this.layer.insts) {
      const next = inst.next
      if (
        next?.state === 'ready' &&
        (this.users.has(next) || this.users.has(inst.current as Phase))
      ) {
        phases.push(next)
      } else if (inst.current?.state === 'active' && this.users.has(inst.current)) {
        phases.push(inst.current)
      }
    }
    return phases
  }

  /** Swaps in a compiled material, then starts the next build if needed. Runs in compose. */
  compose(): void {
    const swap = this.#swap
    this.#swap = undefined
    // A phase closed after its build compiled. The follow-up build (dirty) replaces it.
    if (swap && stale(swap)) this.#discard(swap)
    else if (swap) {
      const old = this.mesh.material as MeshBasicNodeMaterial
      const geometry = this.mesh.geometry
      this.mesh.material = swap.material
      this.mesh.geometry = swap.geometry
      this.#host.later(() => {
        old.dispose()
        this.#host.release(geometry)
      })
      this.#good = new Set(swap.phases)
      this.ready = true
      for (const phase of swap.phases) if (phase.state === 'ready') this.#host.activate(phase)
    }
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
    const alive = (): boolean => !this.disposed && !stale(build)
    void this.#host.compile(new Mesh(build.geometry, build.material), alive).then((cause) => {
      this.#building = false
      // A phase closed during compilation (its removal made the surface dirty again).
      if (this.disposed || stale(build)) this.#discard(build)
      else if (cause === undefined) this.#swap = build
      else {
        this.#discard(build)
        const fresh = build.phases.filter((p) => !this.#good.has(p))
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
    })
  }

  #discard(build: Build): void {
    build.material.dispose()
    this.#host.release(build.geometry)
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
    const order = (kind: Kind): Transform[] =>
      phases.flatMap((p) => [...this.#transforms].filter((t) => t.phase === p && t.kind === kind))
    let failed: Transform | undefined
    let error: unknown
    const apply = <T>(kind: Kind, start: T, call: (fn: Fn, value: T) => unknown): T => {
      let value = start
      for (const t of order(kind)) {
        if (failed) break
        try {
          value = call(t.fn, value) as T
        } catch (e) {
          failed = t
          error = e
        }
      }
      return value
    }
    type Call = (fn: Fn, value: Node) => unknown
    const position = apply<Node>('position', positionLocal, ((fn, p) =>
      (fn as (p: Node, uv: Node) => Node)(p, box)) as Call)
    const cur = apply<Node>('uv', box, ((fn, value) => (fn as (uv: Node) => Node)(value)) as Call)
    const input: SurfaceInput = { uv: cur as Node<'vec2'>, box, sample }
    const color = apply<Node>('color', sample(cur as Node<'vec2'>), ((fn, value) =>
      (fn as (c: Node, i: SurfaceInput) => Node)(value, input)) as Call)
    if (failed) {
      const { phase } = failed
      const name = phase.inst.rec.name
      this.#host.failed(
        phase,
        new EffectError('EFFECT_COMPILE', `a surface transform of "${name}" threw`, {
          effect: name,
          element: layer.element,
          cause: error,
        }),
      )
      this.dirty = true
      return undefined
    }
    const rgba = color as Node<'vec4'>
    const material = new MeshBasicNodeMaterial({ transparent: true })
    material.positionNode = position
    material.colorNode = vec4(rgba.rgb, rgba.a.mul(layer.clipMask(box), layer.opacity()))
    const segments = Math.max(1, ...phases.map((p) => p.segments))
    return { material, geometry: this.#host.geometry(segments), phases }
  }

  /** Compiled, media ready, held by a running effect and not replaced. */
  get drawable(): boolean {
    const media = this.layer.media
    if (!this.ready || (media && media.state !== 'ready') || this.layer.replaced()) return false
    for (const phase of this.#good) if (phase.state === 'active' && !phase.inst.parked) return true
    return false
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
}
