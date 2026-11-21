// Runs of `setup`. A phase is prepared (setup, environment, pipeline compiles), takes over from
// the previous one, and closes with everything it made. Rebuilds prepare a new phase while the
// current one keeps drawing.
import type { Mesh } from 'three/webgpu'
import { DEV } from '../define'
import { EffectError } from '../errors'
import type { InstanceRecord } from '../ports'
import type { AnyParamValue, EffectDefinition, ParamSpec } from '../types'
import { deepDispose } from './dispose'
import { capped, type Inst, Phase } from './instance'
import type { World } from './world'

/** Rebuilds of one instance within this many ms that earn a dev warning. */
const REBUILD_WINDOW = 1000
const MAX_REBUILDS = 3

/** The phase was superseded or aborted. Expected, never reported. */
export const ABORTED: unique symbol = Symbol('aborted')

/** Resolves with the promise, or with ABORTED as soon as the signal aborts. */
export const settle = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return resolve(ABORTED)
    const abort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })

export class Phases {
  readonly #world: World
  /** Rebuilt phases ready to take over in the next compose. */
  readonly #swaps: Phase[] = []

  constructor(world: World) {
    this.#world = world
  }

  /**
   * Runs setup into a new phase and waits until it is active (mount) or swapped in (rebuild).
   * Resolves `undefined`, the failure, or ABORTED.
   */
  async prepare(
    inst: Inst,
    def: EffectDefinition<ParamSpec>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const world = this.#world
    const values: Record<string, AnyParamValue> = { ...world.host.values(inst.rec) }
    for (const key in values) {
      values[key] = capped(def, world.tier, key, values[key]) as AnyParamValue
    }
    const phase = new Phase(inst, def, values, world.scope.scope(), world.context)
    inst.next = phase
    const abort = (): void => this.close(phase)
    signal?.addEventListener('abort', abort, { once: true })
    const activated = new Promise<unknown>((resolve) => {
      phase.done = resolve
    })
    // Closed meanwhile, either aborted or failed by its media: `activated` holds which.
    const closed = (): boolean => (phase.state as Phase['state']) === 'closed'
    try {
      const setup = Promise.resolve().then(() => def.setup(phase.ctx))
      inst.settled = setup.catch(() => {})
      const result = await setup
      if (closed()) return activated
      phase.update = typeof result === 'function' ? result : undefined
      // The first frame of a lit object is lit already.
      if (!phase.lit && usesLitMaterial(phase)) phase.lit = world.environment(phase)
      if (phase.lit) {
        await phase.lit
        if (closed()) return activated
      }
      if (phase.placed.length) {
        await this.#compilePlaced(phase)
        if (closed()) return activated
      }
    } catch (error) {
      if (closed()) return activated
      this.close(phase, false)
      return setupError(error, inst.rec)
    }
    phase.state = 'ready'
    this.#handOver(phase)
    const result = await activated
    signal?.removeEventListener('abort', abort)
    return result
  }

  /** The phase takes over and is shown. The previous one closes after it. */
  activate(phase: Phase): void {
    const { inst } = phase
    if (phase.state !== 'ready' || !inst.live) return
    const previous = inst.current
    inst.current = phase
    if (inst.next === phase) inst.next = undefined
    phase.state = 'active'
    phase.show(!inst.parked)
    if (previous) this.close(previous)
    const done = phase.done
    phase.done = undefined
    done?.()
    // Drawn in this frame, which also decides `animate`.
    this.#world.invalidate()
  }

  /** Called in compose to let rebuilt phases take over. */
  swap(): void {
    for (const phase of this.#swaps.splice(0)) this.activate(phase)
  }

  /** Starts a rebuild at a visible frame, abandoning one in preparation. */
  rebuild(inst: Inst): void {
    const { host } = this.#world
    inst.rebuild = false
    if (inst.next) this.close(inst.next)
    if (DEV) this.#warnFrequentRebuilds(inst)
    const ticket = ++inst.ticket
    void inst.settled.then(async () => {
      const def = inst.rec.effect?.['~definition']
      if (!inst.live || !def || ticket !== inst.ticket) return
      const error = await this.prepare(inst, def)
      if (error !== undefined && error !== ABORTED && inst.live) host.fail(inst.rec, error)
    })
  }

  /** A phase failed outside setup. A waiting one settles with the error, a running one fails. */
  failed(phase: Phase, error: EffectError): void {
    if (phase.state === 'closed') return
    const world = this.#world
    const { layer } = phase.inst
    if (world.copies.ghosts.has(layer)) {
      world.copies.fault(layer, error)
      return
    }
    if (world.orphans.has(layer)) {
      world.bury(layer)
      return
    }
    if (phase.state === 'active') {
      world.host.fail(phase.inst.rec, error)
      return
    }
    const done = phase.done
    phase.done = undefined
    this.close(phase)
    done?.(error)
  }

  /** Closes in order: scope, surface transforms, placed objects, leases. */
  close(phase: Phase, settle = true): void {
    if (phase.state === 'closed') return
    phase.state = 'closed'
    const world = this.#world
    const { inst } = phase
    const { layer } = inst
    if (inst.next === phase) inst.next = undefined
    if (inst.current === phase) inst.current = undefined
    phase.scope.dispose()
    const surface = layer.surface
    if (surface?.users.has(phase)) {
      surface.remove(phase)
      if (!surface.users.size) {
        surface.dispose()
        layer.surface = undefined
      }
    }
    const shared = (resource: object): boolean =>
      resource === layer.media?.texture || resource === surface?.mesh.geometry
    const pinned = [phase.viewport, phase.overlay].filter((group) => group !== undefined)
    const objects = [...phase.placed.filter((p) => p.dispose).map((p) => p.object), ...pinned]
    const groups = [...phase.groups, ...pinned]
    const { compiling } = world.copies
    world.later(() => {
      for (const group of groups) group.removeFromParent()
      for (const object of objects) {
        object.removeFromParent()
        // A compile under way would create render objects after the dispose events, so wait for it.
        const job = compiling.get(object)
        if (job) void job.then(() => deepDispose(object, shared))
        else deepDispose(object, shared)
      }
    })
    for (const off of phase.offs.splice(0).reverse()) off()
    const done = phase.done
    phase.done = undefined
    if (settle) done?.(ABORTED)
    world.invalidate()
  }

  /**
   * Placed objects build their pipelines before they show, hidden ones too: a pipeline built in
   * a frame blocks the GPU process, the whole page with it.
   */
  #compilePlaced(phase: Phase): Promise<unknown> {
    const world = this.#world
    const alive = (): boolean => phase.state !== 'closed'
    const { compiling } = world.copies
    return Promise.all(
      phase.placed.map(({ object }) => {
        // A dispose waits for a compile under way (see close).
        const job: Promise<void> = world
          .compileWith(phase.inst.layer, object as Mesh, alive)
          .then(() => {
            if (compiling.get(object) === job) compiling.delete(object)
          })
        compiling.set(object, job)
        return job
      }),
    )
  }

  /**
   * A ready phase on the surface waits for its material (the surface activates it), a rebuild
   * waits for the next compose, a first phase takes over at once.
   */
  #handOver(phase: Phase): void {
    const { inst } = phase
    const surface = inst.layer.surface
    if (surface?.users.has(phase) || (inst.current && surface?.users.has(inst.current))) {
      surface?.changed()
    } else if (inst.current) {
      this.#swaps.push(phase)
      this.#world.invalidate()
    } else this.activate(phase)
  }

  #warnFrequentRebuilds(inst: Inst): void {
    const now = performance.now()
    inst.rebuilds = [...inst.rebuilds.filter((time) => now - time < REBUILD_WINDOW), now]
    if (inst.rebuilds.length <= MAX_REBUILDS) return
    const { name, element } = inst.rec
    const message = `"${name}" rebuilds more than 3 times a second: do not tween rebuild params`
    const error = new EffectError('EFFECT_PARAM', message, { effect: name, element })
    this.#world.host.warn(`rebuild:${name}`, error)
  }
}

/** Lit materials need the environment: the classic standard ones and their node twins. */
function usesLitMaterial(phase: Phase): boolean {
  let found = false
  const roots = [...phase.placed.map((placed) => placed.object), phase.viewport, phase.overlay]
  for (const root of roots) {
    root?.traverse((object) => {
      for (const material of [(object as { material?: object }).material ?? []].flat()) {
        const flags = material as {
          isMeshStandardMaterial?: boolean
          isMeshStandardNodeMaterial?: boolean
        }
        if (flags.isMeshStandardMaterial || flags.isMeshStandardNodeMaterial) found = true
      }
    })
  }
  return found
}

/** A setup failure as an EffectError: its own if it threw one, else EFFECT_SETUP. */
function setupError(error: unknown, record: InstanceRecord): EffectError {
  if (error instanceof EffectError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new EffectError('EFFECT_SETUP', message, {
    effect: record.name,
    element: record.element,
    cause: error,
  })
}
