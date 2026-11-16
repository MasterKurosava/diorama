import { DEV } from '../define'
import { EffectError } from '../errors'
import type { InstanceRecord } from '../instances'
import type { EffectDefinition, ParamSpec } from '../types'
import { deepDispose } from './dispose'
import { type Inst, Phase } from './instance'
import type { World } from './world'

/** The phase was superseded or aborted. Expected, never reported. */
export const ABORTED: unique symbol = Symbol('aborted')

export const settle = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return resolve(ABORTED)
    const abort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })

const failure = (error: unknown, rec: InstanceRecord): EffectError =>
  error instanceof EffectError
    ? error
    : new EffectError('EFFECT_SETUP', error instanceof Error ? error.message : String(error), {
        effect: rec.name,
        element: rec.element,
        cause: error,
      })

/** Runs of `setup`. A phase is prepared, takes over, and closes with everything it made. */
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
    const phase = new Phase(
      inst,
      def,
      { ...world.host.values(inst.rec) },
      world.scope.scope(),
      world.context,
    )
    inst.next = phase
    const abort = (): void => this.close(phase)
    signal?.addEventListener('abort', abort, { once: true })
    const activated = new Promise<unknown>((resolve) => {
      phase.done = resolve
    })
    try {
      const setup = Promise.resolve().then(() => def.setup(phase.ctx))
      inst.settled = setup.catch(() => {})
      const result = await setup
      // Closed meanwhile, either aborted or failed by its media. `activated` holds which.
      if (phase.state === 'closed') return activated
      phase.update = typeof result === 'function' ? result : undefined
    } catch (error) {
      if (phase.state === 'closed') return activated
      this.close(phase, false)
      return failure(error, inst.rec)
    }
    phase.state = 'ready'
    const surface = inst.layer.surface
    if (surface?.users.has(phase) || (inst.current && surface?.users.has(inst.current))) {
      surface?.changed()
    } else if (inst.current) {
      this.#swaps.push(phase)
      world.invalidate()
    } else this.activate(phase)
    const result = await activated
    signal?.removeEventListener('abort', abort)
    return result
  }

  /** The phase takes over and is shown. The previous one closes after it. */
  activate(phase: Phase): void {
    const inst = phase.inst
    if (phase.state !== 'ready' || !inst.live) return
    const old = inst.current
    inst.current = phase
    if (inst.next === phase) inst.next = undefined
    phase.state = 'active'
    phase.show(!inst.parked)
    if (old) this.close(old)
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
    if (DEV) {
      const now = performance.now()
      inst.rebuilds = [...inst.rebuilds.filter((t) => now - t < 1000), now]
      if (inst.rebuilds.length > 3) {
        const { name, element } = inst.rec
        const message = `"${name}" rebuilds more than 3 times a second: do not tween rebuild params`
        host.warn(
          `rebuild:${name}`,
          new EffectError('EFFECT_PARAM', message, { effect: name, element }),
        )
      }
    }
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
    const { copies, host } = this.#world
    if (copies.ghosts.has(phase.inst.layer)) {
      copies.fault(phase.inst.layer, error)
      return
    }
    if (phase.state === 'active') {
      host.fail(phase.inst.rec, error)
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
    const keep = (resource: object): boolean =>
      resource === layer.media?.texture || resource === surface?.mesh.geometry
    const objects = [...phase.placed.filter((p) => p.dispose).map((p) => p.object)]
    if (phase.viewport) objects.push(phase.viewport)
    const groups = [...phase.groups, ...(phase.viewport ? [phase.viewport] : [])]
    const { compiling } = world.copies
    world.later(() => {
      for (const group of groups) group.removeFromParent()
      for (const object of objects) {
        object.removeFromParent()
        // A compile under way would create render objects after the dispose events, so wait for it.
        const job = compiling.get(object)
        if (job) void job.then(() => deepDispose(object, keep))
        else deepDispose(object, keep)
      }
    })
    for (const off of phase.offs.splice(0).reverse()) off()
    const done = phase.done
    phase.done = undefined
    if (settle) done?.(ABORTED)
    world.invalidate()
  }
}
