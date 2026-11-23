// The runtime of one app, started once the engine has loaded. It owns the layers (one per element
// with an effect) and the runtime side of each instance, and wires setup phases, taken copies,
// the frame pipeline and the services `ctx` offers to effects.
import type { Anchor, AppScope, Off, ReadonlySignal } from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import { uniform } from 'three/tsl'
import {
  type AnimationClip,
  Box3,
  Group,
  type Mesh,
  type Object3D,
  type Texture,
  type UniformNode,
  Vector3,
} from 'three/webgpu'
import { DEV } from '../define'
import { EffectError } from '../errors'
import { inertCopy } from '../instances'
import { rebuilds } from '../params'
import type { EffectsView, InstanceRecord, ReleaseReason, Runtime, RuntimeHost } from '../ports'
import { canSlice, slice } from '../slice'
import type {
  AnyParamValue,
  Copy,
  Effect,
  EffectDefinition,
  EffectHandle,
  EffectsStats,
  EffectUse,
  Fit,
  FitOptions,
  Layer,
  ModelOptions,
  ParamSpec,
  PlaceOptions,
  PoseTarget,
  QualityTier,
  Surface,
  TakeOptions,
  TextureOptions,
} from '../types'
import { flies, flying, TURN } from './adrift'
import { Copies } from './copies'
import { FitImpl } from './fit'
import { Frame } from './frame'
import { capped, Inst, type Phase, type PhaseHost, qualityProblem, rank } from './instance'
import { LayerImpl } from './layer'
import { isMedia, Media, readsMedia } from './media'
import { type Painter, paint } from './order'
import { ABORTED, Phases, settle } from './phases'
import { Pool } from './pool'
import { Queries } from './queries'
import { keep, raise } from './raise'
import { marked, Sections, sectionOf } from './sections'
import { compiler, Planes, SurfaceImpl } from './surface'

type MountResult = 'running' | 'failed' | 'aborted' | 'off'

/** Definitions whose `quality` field was checked. */
const checkedQuality = new WeakSet<object>()

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
  /** Layers of removed elements whose burst flies on. */
  readonly orphans: Set<LayerImpl> = new Set()
  readonly copies: Copies
  readonly phases: Phases
  readonly sections: Sections
  readonly context: PhaseHost
  /** Draws layers in document order, undefined on the test fake. */
  readonly painter: Painter | undefined
  /** From `@dioramajs/quality` when installed. */
  tier: QualityTier = 'high'
  /** Updates are running, so `ctx.quality` reads there are live. */
  updating = false
  readonly #frame: Frame
  readonly #queries: Queries
  readonly #pool: Pool
  readonly #planes = new Planes()
  readonly #compile: (object: Object3D, alive?: () => boolean) => Promise<unknown>
  /** One retry listener per failed media element. */
  readonly #retries = new WeakMap<Element, () => void>()
  /** Records turned off for being below their effect's minimum tier. */
  readonly #belowTier = new Set<InstanceRecord>()
  #order: LayerImpl[] = []
  #sorted = false
  #disposed = false
  /** Driver ms of the last page leave or enter. */
  #turned = Number.NEGATIVE_INFINITY
  /** The raise of a canvas under the page while a taken copy is over it; false: not under. */
  #canvasRaise: Off | false | undefined

  constructor(view: EffectsView, host: RuntimeHost) {
    this.app = view
    this.host = host
    this.render = view.find('render') as RenderApi
    const scope = view.scope() as unknown as AppScope
    this.scope = scope
    this.#pool = new Pool(view)
    this.sections = new Sections(view.anchors)
    this.#compile = compiler(this.render)
    this.copies = new Copies(this)
    this.phases = new Phases(this)
    this.#queries = new Queries(this)
    // Registered before the side effect, so a dispose mid-way leaves no root behind.
    scope.onDispose(() => this.root.removeFromParent())
    this.render.scene.add(this.root)
    this.painter = paint(this.render.renderer, scope)
    this.#frame = new Frame(this)
    scope.onDispose(view.stage.reducedMotion.subscribe(() => this.invalidate()))
    // A pinned stage stands still on screen: the canvas must not ride the scroll ahead of frames.
    scope.onDispose(view.stage.pin(() => this.sections.spans))
    this.#watchDevice()
    this.#watchPages()
    const quality = view.find('quality' as never) as
      | { readonly tier: ReadonlySignal<QualityTier> }
      | undefined
    if (quality?.tier) scope.onDispose(quality.tier.subscribe((tier) => this.#setTier(tier)))
    this.context = this.#phaseHost()
  }

  invalidate(): void {
    if (!this.#disposed) this.app.invalidate()
  }

  /** Runs a scene change now, or after the render stage if one is in progress. */
  later(task: () => void): void {
    this.#frame.later(task)
  }

  // Runtime

  async mount(record: InstanceRecord, signal: AbortSignal): Promise<MountResult> {
    const def = record.effect?.['~definition']
    if (!def || this.#disposed) return 'aborted'
    // Instances that come near together (the first screen at boot) set up in separate tasks.
    if (canSlice()) {
      await slice()
      if (signal.aborted || this.#disposed) return 'aborted'
    }
    if (!checkedQuality.has(def)) {
      const problem = qualityProblem(def)
      if (problem) {
        const error = new EffectError('EFFECT_DEFINITION', problem, { effect: record.name })
        this.host.report(record, error)
        return 'failed'
      }
      checkedQuality.add(def)
    }
    if (this.#belowMinimum(def)) {
      this.#belowTier.add(record)
      return 'off'
    }
    this.#belowTier.delete(record)
    const old = this.insts.get(record)
    if (old) this.close(old)
    const layer = this.#acquire(record.element)
    const inst = new Inst(record, layer)
    this.insts.set(record, inst)
    layer.insts.push(inst)
    this.#sort(layer)
    let result: unknown
    try {
      if (readsMedia(def, record.element)) {
        result = await settle(this.#media(layer).ready(), signal)
      }
      if (result !== ABORTED) result = await this.phases.prepare(inst, def, signal)
    } catch (error) {
      result = error
    }
    if (result === ABORTED || signal.aborted || !inst.live) {
      this.close(inst)
      return 'aborted'
    }
    if (result === undefined) return 'running'
    this.host.report(record, result)
    const code = (result as { code?: string }).code
    if (code === 'EFFECT_MEDIA' || code === 'EFFECT_CORS') this.#retry(record.element)
    this.close(inst)
    return 'failed'
  }

  park(record: InstanceRecord, parked: boolean, connected: boolean): void {
    const inst = this.insts.get(record)
    if (!inst) return
    inst.parked = parked
    inst.current?.show(!parked)
    const { layer } = inst
    // A connected element without sources shows its DOM again at once.
    if (parked && connected && layer.state === 'drawn' && !layer.copy()) {
      layer.present(layer.running() ? 'live' : undefined)
    }
    this.invalidate()
  }

  write(record: InstanceRecord, name: string, value: AnyParamValue): void {
    const inst = this.insts.get(record)
    if (!inst) return
    for (const phase of [inst.current, inst.next]) {
      phase?.write(name, capped(phase.def, this.tier, name, value) as AnyParamValue)
    }
    if (inst.layer.visible) this.invalidate()
  }

  rebuild(record: InstanceRecord): void {
    const inst = this.insts.get(record)
    if (!inst) return
    inst.rebuild = true
    if (inst.layer.visible) this.invalidate()
  }

  unmount(record: InstanceRecord, reason: ReleaseReason): void {
    const inst = this.insts.get(record)
    if (!inst) return
    const copy = inst.layer.taken
    if (reason === 'handover' && copy && !copy.released) {
      if (!copy.ghost) this.copies.haunt(inst.layer, copy)
      // The running instance keeps drawing in the ghost. The others close.
      if (inst.current?.state === 'active' && !inst.parked) {
        this.#detachInstance(inst)
        return
      }
    } else if (reason === 'handover' && flies(inst)) {
      this.#strand(inst)
      return
    }
    this.close(inst)
  }

  /** An orphan ends: its instances close, then its layer. */
  bury(layer: LayerImpl): void {
    if (!this.orphans.has(layer)) return
    for (const inst of [...layer.insts]) this.close(inst)
    this.release(layer)
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
    if (this.copies.handover(element)) return true
    const layer = this.layers.get(element)
    return !!layer && flying(layer)
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
    const all = [...this.layers.values(), ...ghosts, ...this.orphans]
    let instances = this.insts.size
    for (const layer of [...ghosts, ...this.orphans]) instances += layer.insts.length
    return {
      layers: this.layers.size + this.orphans.size,
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
    for (const layer of [...this.orphans]) this.bury(layer)
    for (const inst of [...this.insts.values()]) this.close(inst)
    for (const layer of [...this.layers.values()]) this.release(layer)
    this.#disposed = true
    this.over(false)
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
    layer.insts = layer.insts.filter((other) => other !== inst)
    this.#settle(layer)
  }

  // Layers

  /** The only way a layer ends, ghosts included. */
  release(layer: LayerImpl): void {
    if (!this.copies.ghosts.delete(layer) && !this.orphans.delete(layer)) {
      if (this.layers.get(layer.element) !== layer) return
      this.layers.delete(layer.element)
      this.copies.drop(layer)
    }
    this.#sorted = false
    layer.present(undefined)
    layer.lower()
    layer.section = this.sections.swap(layer.section, undefined)
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

  /** Leases the environment for the phase. Undefined when render has none. */
  environment(phase: Phase): Promise<void> | undefined {
    const lease = this.render.environment?.()
    if (!lease) return undefined
    phase.offs.push(lease.off)
    return lease.ready
  }

  /**
   * A taken copy over the page (`above` > 0, a flight) is drawn over its elements, as on a canvas
   * over the page, so a canvas under the page goes into the top layer while one is drawn.
   */
  over(on: boolean): void {
    const canvas = this.render.renderer.domElement as HTMLCanvasElement | undefined
    if (canvas) keep(canvas)
    if (!on || this.#disposed) {
      if (this.#canvasRaise) this.#canvasRaise()
      this.#canvasRaise = undefined
      return
    }
    if (this.#canvasRaise !== undefined) return
    // Raised only from under the page.
    this.#canvasRaise = !!canvas && Number(getComputedStyle(canvas).zIndex) < 0 && raise(canvas)
  }

  /** Device loss, a lost WebGL context or the render system disabled by the kernel. */
  #watchDevice(): void {
    const { host, scope } = this
    const { renderer } = this.render
    const previous = renderer.onDeviceLost
    const lost = (info: unknown): void => {
      previous.call(renderer, info as never)
      host.lost()
    }
    renderer.onDeviceLost = lost
    scope.onDispose(() => {
      if (renderer.onDeviceLost === lost) renderer.onDeviceLost = previous
    })
    renderer.domElement?.addEventListener('webglcontextlost', () => host.lost(), {
      signal: scope.abortSignal,
    })
    scope.on('app:error', ({ error, target }) => {
      // The kernel drops reports made inside an app:error listener, so leave it first.
      if (error.code === 'SYSTEM_DISABLED' && target === 'render') queueMicrotask(() => host.lost())
    })
  }

  /**
   * A leaving page fades orphans out, and so do elements its swap removes around then: a router
   * may emit the leave before or after it swaps the DOM.
   */
  #watchPages(): void {
    const turn = (): void => {
      this.#turned = this.app.loop.driver.now()
      for (const { adrift } of this.orphans) {
        if (adrift?.leave === Infinity) adrift.leave = Number.NaN
      }
      this.invalidate()
    }
    this.scope.on('page:leave' as never, turn)
    this.scope.on('page:enter' as never, turn)
  }

  /** The services behind `ctx`, one set shared by every phase. */
  #phaseHost(): PhaseHost {
    return {
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
      texture: (phase, url, options) => this.#texture(phase, url, options),
      model: (phase, url, options) => this.#model(phase, url, options),
      fit: (phase, texture, options) => this.#fit(phase, texture, options),
      showDom: (phase, show) => this.#showDom(phase, show),
      compile: async (phase, object) => {
        const failure = await this.#compile(object, () => !phase.scope.abortSignal.aborted)
        if (failure) throw failure
      },
      section: (phase) => this.#section(phase),
      raise: (phase) => this.#raise(phase),
      tier: () => this.tier,
      updating: () => this.updating,
    }
  }

  /** Below the effect's minimum tier, so its instances are off. */
  #belowMinimum(def: EffectDefinition<ParamSpec>): boolean {
    return rank(this.tier) < rank(def.quality?.min)
  }

  /**
   * A new tier: instances below their minimum go off, ones back above it mount again, phases
   * with a baked capped param or a `ctx.quality` read rebuild, live params get new uniforms.
   */
  #setTier(tier: QualityTier): void {
    if (tier === this.tier) return
    this.tier = tier
    for (const inst of [...this.insts.values()]) this.#retier(inst, tier)
    for (const record of [...this.#belowTier]) {
      const def = record.effect?.['~definition']
      if (def && this.#belowMinimum(def) && record.status === 'off') continue
      this.#belowTier.delete(record)
      if (record.status === 'off') this.host.restart(record)
    }
    this.invalidate()
  }

  #retier(inst: Inst, tier: QualityTier): void {
    const phase = inst.current ?? inst.next
    if (!phase) return
    const { def } = phase
    const { rec: record } = inst
    if (this.#belowMinimum(def)) {
      this.host.restart(record)
      return
    }
    let rebuild = phase.tiered
    for (const [key, spec] of Object.entries(def.params ?? {})) {
      const value = record.values[key] as AnyParamValue
      if (rebuilds(spec) || def.rebuild?.includes(key)) {
        rebuild ||= capped(def, tier, key, value) !== phase.values[key]
      } else this.write(record, key, value)
    }
    if (rebuild) this.rebuild(record)
  }

  /**
   * The instance leaves the runtime but its phases keep drawing for a ghost or an orphan. A
   * ghost never rebuilds, so one under way is dropped and a queued one never starts. The record
   * may live again on the node, so a late rebuild failure must not reach it.
   */
  #detachInstance(inst: Inst): void {
    this.insts.delete(inst.rec)
    inst.ticket++
    if (inst.next) this.phases.close(inst.next)
  }

  /** The element left mid-burst: its layer flies on as an orphan until the burst ends. */
  #strand(inst: Inst): void {
    const { layer } = inst
    if (this.layers.get(layer.element) === layer) {
      const { x, y, width, height } = layer.input
      this.layers.delete(layer.element)
      this.copies.drop(layer)
      this.orphans.add(layer)
      this.reorder()
      layer.detach()
      const since = this.app.loop.driver.now()
      const turning = since - this.#turned < TURN
      layer.adrift ??= {
        box: { x, y, width, height },
        since,
        leave: turning ? Number.NaN : Infinity,
      }
      layer.anchor.dispose()
      layer.section = this.sections.swap(layer.section, undefined)
      layer.media?.freeze()
    }
    this.#detachInstance(inst)
  }

  #acquire(element: Element): LayerImpl {
    let layer = this.layers.get(element)
    if (layer) return layer
    const mode = this.host.track(element)
    const anchor = this.app.anchors.track(element, { live: mode !== 'layout' })
    layer = new LayerImpl(element, anchor, (state) => this.host.present(element, state))
    layer.mode = mode
    layer.section = this.sections.swap(undefined, marked(element))
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
    const orphan = this.orphans.has(layer)
    if (!layer.insts.length && (orphan || !layer.leases.size)) {
      this.release(layer)
      return
    }
    if (orphan) return
    if (layer.state === 'drawn' && !layer.copy()) {
      layer.present(layer.running() ? 'live' : undefined)
      this.invalidate()
    } else if (layer.state && !layer.running()) layer.present(undefined)
  }

  /** Re-sorts instances by effect order. The surface material follows. */
  #sort(layer: LayerImpl): void {
    const order = this.host.instancesOf(layer.element)
    const sorted = [...layer.insts].sort((a, b) => order.indexOf(a.rec) - order.indexOf(b.rec))
    if (sorted.every((inst, index) => inst === layer.insts[index])) return
    layer.insts = sorted
    layer.surface?.changed()
  }

  #media(layer: LayerImpl): Media {
    if (layer.media) return layer.media
    const element = layer.element as HTMLImageElement
    layer.media = new Media(element, {
      acquire: (image, anonymous) => this.#pool.acquire(image, anonymous),
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
      failed: (failedPhase, error) => this.phases.failed(failedPhase, error),
      activate: (readyPhase) => this.phases.activate(readyPhase),
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
      (other) => other !== inst && (other.current?.replace || other.next?.replace),
    )
    if (!taken) {
      phase.replace = object
      return
    }
    object.visible = false
    const { name, element } = inst.rec
    const message = `"${name}": the element already has a replace object; this one is hidden`
    this.host.warn(
      `replace:${name}`,
      new EffectError('EFFECT_TARGET', message, { effect: name, element }),
    )
  }

  #pose(phase: Phase, target: Layer, pose: PoseTarget, weight: number): void {
    const layer = this.layers.get(target.element)
    if (!layer) return
    if (DEV && layer.pose && layer.pose.owner !== phase.inst) {
      const message = 'two effects pose one layer: the later wins'
      this.host.warn('pose', new EffectError('EFFECT_TARGET', message, { element: layer.element }))
    }
    layer.pose = { target: pose, weight, owner: phase.inst }
    // A pose loads the layer's waiting effects without the observer.
    if (weight > 0 && layer.posed === 0) this.host.wake(layer.element)
  }

  /** A lease on the assets cache that dies with the phase. */
  #asset(
    phase: Phase,
    url: string,
    type: string,
    priority?: 'high' | 'normal' | 'low',
    options?: Record<string, string>,
  ): Promise<unknown> {
    const { assets } = this.app
    const { name, element } = phase.inst.rec
    if (!assets) {
      const message = `"${name}" loads ${url}: it needs the assets plugin`
      return Promise.reject(new EffectError('EFFECT_SETUP', message, { effect: name, element }))
    }
    const lease = assets.load(url, { type, priority, options })
    phase.scope.onDispose(() => lease.release())
    return lease.ready
  }

  #texture(phase: Phase, url: string, options: TextureOptions = {}): Promise<Texture> {
    const { colorSpace, priority } = options
    const loader = colorSpace === 'linear' ? { colorSpace } : undefined
    return this.#asset(phase, url, 'texture', priority, loader) as Promise<Texture>
  }

  async #model(phase: Phase, url: string, options: ModelOptions = {}): Promise<Object3D> {
    // Lit in its first frame: the environment is made while the file loads.
    phase.lit ??= this.environment(phase)
    const model = (await this.#asset(phase, url, 'gltf', options.priority)) as {
      instance(): Object3D
      readonly animations: readonly AnimationClip[]
    }
    const object = model.instance()
    if (options.normalize === false) {
      object.animations = [...model.animations]
      return object
    }
    // Centred and scaled so its largest side is 1.
    const box = new Box3().setFromObject(object)
    const size = box.getSize(new Vector3())
    object.position.sub(box.getCenter(new Vector3()))
    const wrapper = new Group()
    wrapper.scale.setScalar(1 / (Math.max(size.x, size.y, size.z) || 1))
    wrapper.add(object)
    wrapper.animations = [...model.animations]
    return wrapper
  }

  #fit(phase: Phase, texture: Texture, options?: FitOptions): Fit {
    const fit = new FitImpl(texture, options)
    phase.fits.push(fit)
    const { layer } = phase.inst
    fit.update(layer.input.width, layer.input.height)
    return fit
  }

  #showDom(phase: Phase, show: boolean): void {
    if (phase.dom === show) return
    phase.dom = show
    if (phase.replace) phase.replace.visible = !show
    const { layer } = phase.inst
    // Drops drawn at once when no copy is left. Taking it back waits for a drawn frame.
    if (show && layer.state === 'drawn' && !layer.copy()) {
      layer.present(layer.running() ? 'live' : undefined)
    }
    this.invalidate()
  }

  /** `ctx.section()`, looked up again when the layer's anchor re-measures. */
  #section(phase: Phase): Anchor {
    const { anchor, element } = phase.inst.layer
    const held = phase.section
    if (held?.by === anchor && held.version === anchor.version) return held.anchor
    if (!held) phase.offs.push(() => phase.section && this.sections.release(phase.section.anchor))
    const section = this.sections.swap(held?.anchor, sectionOf(element)) as Anchor
    phase.section = { anchor: section, by: anchor, version: anchor.version }
    return section
  }

  /** `ctx.raise()`: the canvas the renderer draws into, lowered at the latest with the phase. */
  #raise(phase: Phase): Off {
    const canvas = this.render.renderer.domElement as HTMLCanvasElement | undefined
    if (!canvas) return () => {}
    const off = raise(canvas)
    const lower = (): void => {
      const index = phase.offs.indexOf(lower)
      if (index >= 0) phase.offs.splice(index, 1)
      off()
    }
    phase.offs.push(lower)
    return lower
  }

  #attach(phase: Phase, target: string | Element, use: Effect | EffectUse): EffectHandle {
    const handle = this.host.attach(target, use, phase.inst.rec.element)
    phase.offs.push(handle)
    return handle
  }
}
