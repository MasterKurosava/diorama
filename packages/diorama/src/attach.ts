// `app.attach` that works right after `start()`. The kernel installs the real service later,
// so until then a handle records what the site does and replays it.
import type { App } from '@diorama/core'
import type { Attach, EffectHandle, EffectInstance } from '@diorama/effects'

/** Resolves once the app runs. Rejects if it fails or is destroyed first. */
export function ready(app: App): Promise<App> {
  return new Promise((resolve, reject) => {
    const check = (state: string): boolean => {
      if (state === 'running') resolve(app)
      else if (state === 'failed' || state === 'destroyed')
        reject(new Error(`diorama: app ${state}`))
      else return false
      return true
    }
    if (check(app.state.value)) return
    const off = app.state.subscribe((state) => {
      if (check(state)) off()
    })
  })
}

/** The real service once installed (a getter on the app's prototype). */
const service = (app: App): Attach | undefined =>
  Reflect.get(Object.getPrototypeOf(app) as object, 'attach', app) as Attach | undefined

/** Gives the app an `attach` usable at once. The real one takes over when the app runs. */
export function deferAttach(app: App): void {
  Object.defineProperty(app, 'attach', {
    configurable: true,
    value: (...args: unknown[]) => {
      const real = service(app)
      return real ? (real as (...a: unknown[]) => EffectHandle)(...args) : later(app, args)
    },
  })
}

function later(app: App, args: unknown[]): EffectHandle {
  let real: EffectHandle | undefined
  let cancelled = false
  const writes: Record<string, unknown> = {}
  const [, use] = args
  const name =
    typeof use === 'string'
      ? use
      : typeof use === 'function'
        ? (use as { name: string }).name
        : (use as { effect: { name: string } }).effect.name
  // In the named form the initial params are the third argument and read back at once.
  if (typeof use === 'string' && args[2]) Object.assign(writes, args[2])
  const settled = ready(app).then(
    () => {
      if (cancelled) return undefined
      real = (service(app) as (...a: unknown[]) => EffectHandle)(...args)
      if (Object.keys(writes).length) real.set(writes as never)
      return real
    },
    () => undefined,
  )
  const params = new Proxy(writes, {
    get: (target, key) => (real ? Reflect.get(real.params, key) : Reflect.get(target, key)),
    set: (target, key, value) =>
      real ? Reflect.set(real.params, key, value) : Reflect.set(target, key, value),
  })
  const detach = (): void => {
    cancelled = true
    real?.detach()
  }
  return Object.assign(detach, {
    detach,
    effect: name,
    params,
    set: (values: object) => (real ? real.set(values as never) : Object.assign(writes, values)),
    get instances(): readonly EffectInstance[] {
      return real?.instances ?? []
    },
    loaded: async () => (await settled)?.loaded() ?? false,
    ready: async () => (await settled)?.ready(),
    reset: (param?: string) => {
      if (real) real.reset(param as never)
      else if (param) delete writes[param]
      else for (const key of Object.keys(writes)) delete writes[key]
    },
  }) as unknown as EffectHandle
}
