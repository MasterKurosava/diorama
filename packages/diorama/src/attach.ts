// `app.attach` that works right after `start()`. The kernel installs the real service later,
// so until then a handle records what the site does and replays it.
import { type App, DioramaError } from '@dioramajs/core'
import type { Attach, EffectHandle, EffectInstance } from '@dioramajs/effects'

let page: App | undefined
const waiting: ((app: App) => void)[] = []

/** Makes `app` the page's app, the one `ready()` without an argument waits for. */
export function adopt(app: App): void {
  page = app
  for (const resolve of waiting.splice(0)) resolve(app)
}

/**
 * Resolves with the app once it runs: the page's app of `start()` by default, waiting for the
 * call if it has not happened yet. Rejects if the app fails or is destroyed first.
 *
 *     const app = await ready()
 *     app.effects.get(el, 'ripple')
 */
export function ready(app?: App): Promise<App> {
  // A destroyed page app is replaced by the next start().
  app ??= page?.state.value === 'destroyed' ? undefined : page
  if (!app) return new Promise<App>((resolve) => waiting.push(resolve)).then((a) => ready(a))
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

/** Services `start()` installs during the async start, plus the kernel's own. */
const SERVICES = [
  'effects',
  'assets',
  'transition',
  'gsap',
  'lenis',
  'stage',
  'scroll',
  'pointer',
  'anchors',
  'visibility',
]

/**
 * Until the app runs, reading one of its services throws an error that names the fix instead
 * of returning undefined, which fails later as "cannot read properties of undefined".
 */
export function guard(app: App): void {
  const proto = Object.getPrototypeOf(app) as object
  const starting = (): boolean => app.state.value === 'idle' || app.state.value === 'starting'
  for (const name of SERVICES) {
    Object.defineProperty(app, name, {
      configurable: true,
      get() {
        const real = Reflect.get(proto, name, app)
        if (real !== undefined || !starting()) return real
        throw new DioramaError(
          'SERVICE_UNAVAILABLE',
          `app.${name} is not ready yet: start() returns before its services exist. Use \`(await ready()).${name}\`; attach() works at once`,
        )
      },
    })
  }
  const off = app.state.subscribe(() => {
    if (starting()) return
    off()
    for (const name of SERVICES) Reflect.deleteProperty(app, name)
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

/** A handle that records params and replays the attach on the real service once the app runs. */
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
