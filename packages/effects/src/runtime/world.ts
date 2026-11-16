import type { AppScope, Off } from '@diorama/core'
import type { RenderApi } from '@diorama/render'
import { uniform } from 'three/tsl'
import { Group, type Mesh, type Object3D, type UniformNode } from 'three/webgpu'
import { DEV } from '../define'
import { EffectError } from '../errors'
import {
  type EffectsView,
  type InstanceRecord,
  inertCopy,
  type ReleaseReason,
  type Runtime,
  type RuntimeHost,
} from '../instances'
import type {
  AnyParamValue,
  Copy,
  Effect,
  EffectHandle,
  EffectsStats,
  EffectUse,
  Layer,
  PlaceOptions,
  PoseTarget,
  Surface,
  TakeOptions,
} from '../types'
import { Copies } from './copies'
import { Frame } from './frame'
import { Inst, type Phase, type PhaseHost, setUniform } from './instance'
import { LayerImpl } from './layer'
import { isMedia, Media } from './media'
import { ABORTED, Phases, settle } from './phases'
import { Pool } from './pool'
import { Queries } from './queries'
import { compiler, Planes, SurfaceImpl } from './surface'

/** Runtime of one app. Owns layers and instances and wires phases, copies and the frame. */
export class World implements Runtime {
  readonly app: EffectsView
  readonly host: RuntimeHost
  readonly render: RenderApi
  readonly scope: AppScope
  readonly root: Group = new Group()
  readonly velocity: UniformNode<'float'> = uniform(0)
  readonly motion: UniformNode<'float'> = uniform(1)
  readonly layers: Map<Element, LayerImpl> = new Map()
  readonly insts: Map<InstanceRecord, Inst> = new Map()
  readonly copies: Copies
  readonly phases: Phases
  readonly context: PhaseHost
  readonly #frame: Frame
  readonly #queries: Queries
  readonly #pool: Pool
  readonly #planes = new Planes()
  readonly #compile: (mesh: Mesh, alive?: () => boolean) => Promise<unknown>
  /** One retry listener per failed media element. */
  readonly #retries = new WeakMap<Element, () => void>()
  #order: LayerImpl[] = []
  #sorted = false
  #disposed = false

  constructor(view: EffectsView, host: RuntimeHost) {
    this.app = view
    this.host = host
    this.render = view.find('render') as RenderApi
    const gl = view.scope() as unknown as AppScope
    this.scope = gl
    this.#pool = new Pool(view)
    this.#compile = compiler(this.render)
    this.copies = new Copies(this)
    this.phases = new Phases(this)
    this.#queries = new Queries(this)
    // Registered before the side effect, so a dispose mid-way leaves no root behind.
    gl.onDispose(() => this.root.removeFromParent())
    this.render.scene.add(this.root)
    this.#frame = new Frame(this)
    gl.onDispose(view.stage.reducedMotion.subscribe(() => this.invalidate()))

    // Device loss, a lost WebGL context or the render system disabled by the kernel.
    const { renderer } = this.render
    const previous = renderer.onDeviceLost
    const lost = (info: unknown): void => {
      previous.call(renderer, info as never)
      host.lost()
    }
    renderer.onDeviceLost = lost
    gl.onDispose(() => {
      if (renderer.onDeviceLost === lost) renderer.onDeviceLost = previous
    })
    renderer.domElement?.addEventListener('webglcontextlost', () => host.lost(), {
      signal: gl.abortSignal,
    })
    gl.on('app:error', ({ error, target }) => {
      // The kernel drops reports made inside an app:error listener, so leave it first.
      if (error.code === 'SYSTEM_DISABLED' && target === 'render') queueMicrotask(() => host.lost())
    })

    this.context = {
      render: this.render,
      velocity: (phase) => this.#frame.velocity(phase),
      motion: this.motion,
      root: this.root,
      invalidate: () => this.invalidate(),
      surface: (phase) => this.#surface(phase),
      media: (phase) => this.#media(phase.inst.layer),
      place: (phase, object, options) => this.#place(phase, object, options),
      layers: (phase, selector) => this.#queries.add(phase, selector),
      pose: (phase, layer, target, weight) => this.#pose(phase, layer, target, weight),
      attach: (phase, target, use) => this.#attach(phase, target, use),
    }
  }

  invalidate(): void {
    if (!this.#disposed) this.app.invalidate()
  }

  later(task: () => void): void {
    this.#frame.later(task)
  }

  // Runtime

  async mount(rec: InstanceRecord, signal: AbortSignal): Promise<'running' | 'failed' | 'aborted'> {
    const def = rec.effect?.['~definition']
    if (!def || this.#disposed) return 'aborted'
    const old = this.insts.get(rec)
    if (old) this.close(old)
    const layer = this.#acquire(rec.element)
    const inst = new Inst(rec, layer)
    this.insts.set(rec, inst)
    layer.insts.push(inst)
    this.#sort(layer)
    let result: unknown
    try {
      if (def.media) result = await settle(this.#media(layer).ready(), signal)
      if (result !== ABORTED) result = await this.phases.prepare(inst, def, signal)
    } catch (error) {
      result = error
    }
    if (result === ABORTED || signal.aborted || !inst.live) {
      this.close(inst)
      return 'aborted'
    }
    if (result === undefined) return 'running'
    this.host.report(rec, result)
    const code = (result as { code?: string }).code
    if (code === 'EFFECT_MEDIA' || code === 'EFFECT_CORS') this.#retry(rec.element)
    this.close(inst)
    return 'failed'
  }

  park(rec: InstanceRecord, parked: boolean, connected: boolean): void {
    const inst = this.insts.get(rec)
    if (!inst) return
    inst.parked = parked
    inst.current?.show(!parked)
    const layer = inst.layer
    // A connected element without sources shows its DOM again at once.
    if (parked && connected && layer.state === 'drawn' && !layer.copy()) {
      layer.present(layer.running() ? 'live' : undefined)
    }
    this.invalidate()
  }

  write(rec: InstanceRecord, name: string, value: AnyParamValue): void {
    const inst = this.insts.get(rec)
    if (!inst) return
    for (const phase of [inst.current, inst.next]) {
      const node = phase?.uniforms.get(name)
      if (node) setUniform(node, value)
    }
    if (inst.layer.visible) this.invalidate()
  }

  rebuild(rec: InstanceRecord): void {
    const inst = this.insts.get(rec)
    if (!inst) return
    inst.rebuild = true
    if (inst.layer.visible) this.invalidate()
  }

  unmount(rec: InstanceRecord, reason: ReleaseReason): void {
    const inst = this.insts.get(rec)
    if (!inst) return
    const { layer } = inst
    const copy = layer.taken
    if (reason === 'handover' && copy && !copy.released) {
      if (!copy.ghost) this.copies.haunt(layer, copy)
      // The running instance keeps drawing in the ghost. The others close.
      if (inst.current?.state === 'active' && !inst.parked) {
        this.insts.delete(rec)
        // A ghost never rebuilds. Drop one under way and keep a queued one from starting. The
        // record may live again on the node, so a late rebuild failure must not reach it.
        inst.ticket++
        if (inst.next) this.phases.close(inst.next)
        return
      }
    }
    this.close(inst)
  }

  lease(element: Element): Off {
    const layer = this.#acquire(element)
    const token = {}
    layer.leases.add(token)
    return () => {
      if (layer.leases.delete(token)) this.#settle(layer)
    }
  }

  scanned(): void {
    this.#queries.scanned()
    for (const layer of this.layers.values()) this.#sort(layer)
    // Elements may have moved, and update and pose order follow the document.
    this.#sorted = false
    this.copies.scanned()
  }

  handover(element: Element): boolean {
    return this.copies.handover(element)
  }

  take(element: Element, options?: TakeOptions): Copy {
    if (this.#disposed || this.copies.taken.has(element)) {
      if (DEV && !this.#disposed) {
        const message = 'the copy is taken already: one owner per element'
        this.host.warn('taken', new EffectError('EFFECT_TARGET', message, { element }))
      }
      return inertCopy(element)
    }
    const copy = this.copies.take(element, options)
    // Waiting instances load without the observer. An element without records gets reconciled.
    this.host.wake(element)
    if (!this.host.instancesOf(element).length) this.host.queue(element)
    return copy
  }

  stats(): EffectsStats {
    const { taken, ghosts } = this.copies
    const all = [...this.layers.values(), ...ghosts]
    let instances = this.insts.size
    for (const layer of ghosts) instances += layer.insts.length
    return {
      layers: this.layers.size,
      ghosts: ghosts.size,
      copies: taken.size + ghosts.size,
      instances,
      textures: all.filter((layer) => layer.media?.texture).length,
      bitmaps: this.#pool.bitmaps,
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.copies.dispose()
    for (const inst of [...this.insts.values()]) this.close(inst)
    for (const layer of [...this.layers.values()]) this.release(layer)
    this.#disposed = true
    this.#frame.dispose()
    this.scope.dispose()
    this.#planes.dispose()
  }

  /** Disposes an instance on the runtime side. Safe in any state (unknown, loading). */
  close(inst: Inst): void {
    if (!inst.live) return
    inst.live = false
    if (this.insts.get(inst.rec) === inst) this.insts.delete(inst.rec)
    if (inst.next) this.phases.close(inst.next)
    if (inst.current) this.phases.close(inst.current)
    const { layer } = inst
    layer.insts = layer.insts.filter((i) => i !== inst)
    this.#settle(layer)
  }

  // Layers

  #acquire(element: Element): LayerImpl {
    let layer = this.layers.get(element)
    if (layer) return layer
    const mode = this.host.track(element)
    const anchor = this.app.anchors.track(element, { live: mode !== 'layout' })
    layer = new LayerImpl(element, anchor, (state) => this.host.present(element, state))
    layer.mode = mode
    this.layers.set(element, layer)
    this.root.add(layer.root)
    this.#sorted = false
    const copy = this.copies.taken.get(element)
    if (copy) this.copies.adopt(layer, copy)
    return layer
  }

  /** Releases an empty layer, otherwise drops `drawn` if the copy is gone. */
  #settle(layer: LayerImpl): void {
    // A ghost belongs to its copy's owner. Only `copy.release()` ends it.
    if (this.copies.ghosts.has(layer)) return
    if (!layer.insts.length && !layer.leases.size) {
      this.release(layer)
      return
    }
    if (layer.state === 'drawn' && !layer.copy()) {
      layer.present(layer.running() ? 'live' : undefined)
      this.invalidate()
    } else if (layer.state && !layer.running()) layer.present(undefined)
  }

  /** The only way a layer ends, ghosts included. */
  release(layer: LayerImpl): void {
    if (!this.copies.ghosts.delete(layer)) {
      if (this.layers.get(layer.element) !== layer) return
      this.layers.delete(layer.element)
      this.copies.drop(layer)
    }
    this.#sorted = false
    layer.present(undefined)
    layer.surface?.dispose()
    layer.surface = undefined
    // Objects placed with ctx.map may still draw in this frame, so the texture goes with them.
    this.later(() => {
      layer.root.removeFromParent()
      // r187 uploads a material's textures after its node build yields. A compile under way
      // would upload the disposed texture again and nothing would free it.
      const { media, compiling } = layer
      if (compiling) void compiling.then(() => media?.dispose())
      else media?.dispose()
      layer.anchor.dispose()
    })
    this.invalidate()
  }

  /** Re-sorts instances by effect order. The surface material follows. */
  #sort(layer: LayerImpl): void {
    const order = this.host.instancesOf(layer.element)
    const sorted = [...layer.insts].sort((a, b) => order.indexOf(a.rec) - order.indexOf(b.rec))
    if (sorted.every((inst, i) => inst === layer.insts[i])) return
    layer.insts = sorted
    layer.surface?.changed()
  }

  /** Layers in document order, ancestors first. */
  ordered(): LayerImpl[] {
    if (!this.#sorted) {
      this.#order = [...this.layers.values()].sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      this.#sorted = true
    }
    return this.#order
  }

  /** A layer joined or left, so `ordered()` sorts again. */
  reorder(): void {
    this.#sorted = false
  }

  /** Queues a compile with the layer's objects. Its media is disposed after it. */
  compileWith(layer: LayerImpl, mesh: Mesh, alive: () => boolean): Promise<unknown> {
    const job = this.#compile(mesh, alive)
    layer.compiling = job
    void job.then(() => {
      if (layer.compiling === job) layer.compiling = undefined
    })
    return job
  }

  #media(layer: LayerImpl): Media {
    if (!layer.media) {
      const element = layer.element as HTMLImageElement
      layer.media = new Media(element, {
        acquire: (el) => this.#pool.acquire(el),
        invalidate: () => this.invalidate(),
        visible: () => layer.visible,
        stale: () => {
          // The browser shows the new source itself while the copy waits for the new texture.
          if (layer.state === 'drawn') layer.present('live')
          this.invalidate()
        },
        failed: (error) => {
          for (const inst of [...layer.insts]) {
            const phase = inst.current
            if (phase && (phase.def.media || phase.surface)) this.host.fail(inst.rec, error)
          }
          this.#retry(element)
        },
      })
    }
    return layer.media
  }

  /**
   * A failed source waits for the element's next load with another `currentSrc`. One listener
   * per element, held by nothing in the runtime, so a removed element can be collected.
   */
  #retry(element: Element): void {
    const media = element as HTMLImageElement
    const src = media.currentSrc
    const type = element.localName === 'video' ? 'loadeddata' : 'load'
    const { host } = this
    const { abortSignal } = this.scope
    const previous = this.#retries.get(element)
    if (previous) element.removeEventListener(type, previous)
    const listener = (): void => {
      if (media.currentSrc === src && !abortSignal.aborted) return
      element.removeEventListener(type, listener)
      if (!abortSignal.aborted) host.retry(element)
    }
    this.#retries.set(element, listener)
    element.addEventListener(type, listener)
  }

  // Phase services

  #surface(phase: Phase): Surface {
    const { layer } = phase.inst
    // A media element's surface samples it, so the media has to be prepared.
    if (isMedia(layer.element)) {
      this.#media(layer)
        .ready()
        .catch(() => this.invalidate())
    }
    layer.surface ??= new SurfaceImpl(layer, {
      render: this.render,
      geometry: (segments) => this.#planes.get(segments),
      release: (geometry) => this.#planes.release(geometry),
      compile: (mesh, alive) => this.compileWith(layer, mesh, alive),
      failed: (p, error) => this.phases.failed(p, error),
      activate: (p) => this.phases.activate(p),
      later: (task) => this.later(task),
      invalidate: () => this.invalidate(),
      warn: (key, error) => this.host.warn(key, error),
    })
    return layer.surface.facade(phase)
  }

  #place(phase: Phase, object: Object3D, options?: PlaceOptions): void {
    phase.group(options?.fit ?? 'box').add(object)
    phase.placed.push({ object, dispose: options?.dispose !== false })
    if (!options?.replace) return
    const { inst } = phase
    const taken = inst.layer.insts.some(
      (i) => i !== inst && (i.current?.replace || i.next?.replace),
    )
    if (!taken) {
      phase.replace = object
      return
    }
    object.visible = false
    const error = new EffectError(
      'EFFECT_TARGET',
      `"${inst.rec.name}": the element already has a replace object; this one is hidden`,
      { effect: inst.rec.name, element: inst.rec.element },
    )
    this.host.warn(`replace:${inst.rec.name}`, error)
  }

  #pose(phase: Phase, target: Layer, pose: PoseTarget, weight: number): void {
    const layer = this.layers.get(target.element)
    if (!layer) return
    if (DEV && layer.pose && layer.pose.owner !== phase.inst) {
      const error = new EffectError('EFFECT_TARGET', 'two effects pose one layer: the later wins', {
        element: layer.element,
      })
      this.host.warn('pose', error)
    }
    layer.pose = { target: pose, weight, owner: phase.inst }
    // A pose loads the layer's waiting effects without the observer.
    if (weight > 0 && layer.posed === 0) this.host.wake(layer.element)
  }

  #attach(phase: Phase, target: string | Element, use: Effect | EffectUse): EffectHandle {
    const handle = this.host.attach(target, use, phase.inst.rec.element)
    phase.offs.push(handle)
    return handle
  }
}
