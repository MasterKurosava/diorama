// `probe`: mounts an effect on a fixture with the fake render and reports what it reads and
// whether it rests. Used by tests and to write the metadata of effect modules.
import type { App, PluginEntry } from '@dioramajs/core'
import { defineEffect } from '../effect'
import type {
  Effect,
  EffectContext,
  EffectInput,
  EffectUpdate,
  InstanceStatus,
  ParamSpec,
} from '../types'
import { html, run, start } from './gpu'

/** Names `meta.json` lists as inputs: the uniforms of `ctx.u` and the fields of `ctx.input`. */
const INPUT_NAMES: ReadonlySet<string> = new Set([
  'pointer',
  'pointerWorld',
  'hover',
  'velocity',
  'progress',
  'pin',
  'size',
  'time',
  'hoverTime',
  'motion',
  'opacity',
  'presence',
  'x',
  'y',
  'width',
  'height',
  'visible',
  'over',
  'delta',
  'reducedMotion',
])

/** Extra rounds a slow setup may take before the probe moves on. */
const MAX_SETUP_ROUNDS = 400

/** Options of `probe`. */
export interface ProbeOptions {
  /** The fixture. Default `<img src="/probe.png">` for media effects, else an empty `<div>`. */
  readonly markup?: string
  /** Params of the attach. */
  readonly params?: Readonly<Record<string, unknown>>
  /** Plugins next to the fake render, e.g. a fake `assets`. */
  readonly plugins?: readonly PluginEntry[]
}

/** What `probe` found out about an effect. */
export interface ProbeResult {
  /** Status after setup and two updates. */
  readonly status: InstanceStatus
  /** Why it failed, if it did. */
  readonly error: unknown
  /** Inputs the effect read in setup, in its node graph and in two updates, sorted. */
  readonly inputs: readonly string[]
  /**
   * The frame policy as declared, else as the runtime derives it: 'update' when the update
   * answers with a boolean, else from the clocks the effect reads.
   */
  readonly policy: 'input' | 'hover' | 'visible' | 'function' | 'fps' | 'update'
  /** Frames drawn once nothing changes any more: 0 means none at rest. */
  readonly rest: number
}

/** Records the input names read through an object, passing everything else through. */
function recordReads<T extends object>(target: T, read: Set<string>): T {
  return new Proxy({} as T, {
    get(_, key) {
      if (typeof key === 'string' && INPUT_NAMES.has(key)) read.add(key)
      return Reflect.get(target, key)
    },
    has: (_, key) => Reflect.has(target, key),
  })
}

/** Stubs the browser APIs happy-dom lacks for the duration of a probe. */
function stubBrowser(): () => void {
  const globals = globalThis as Record<string, unknown>
  const names = ['IntersectionObserver', 'OffscreenCanvas', 'matchMedia']
  const saved = names.map((name) => [name, globals[name]] as const)
  globals.IntersectionObserver = undefined
  globals.OffscreenCanvas = class {
    getContext(): object {
      // cssColor reads colours it cannot parse itself (currentColor, oklch) through a canvas.
      return {
        drawImage() {},
        fillRect() {},
        fillStyle: '#000',
        globalCompositeOperation: 'source-over',
        getImageData: () => ({ data: [0, 0, 0, 255] }),
      }
    }
  }
  globals.matchMedia = (query: string) => ({
    matches: query !== '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })
  return () => {
    for (const [name, value] of saved) globals[name] = value
  }
}

/**
 * Mounts an effect on a fixture with the fake render, runs setup and two updates with pointer
 * and scroll movement, and reports what it read and whether it rests. For the tests and the
 * metadata of effect modules; needs a DOM such as happy-dom.
 */
export async function probe(effect: Effect, options: ProbeOptions = {}): Promise<ProbeResult> {
  const def = effect['~definition']
  const read = new Set<string>()
  let answers = false
  const wrapped = defineEffect({
    ...def,
    async setup(ctx: EffectContext<ParamSpec>) {
      const u = recordReads(ctx.u, read)
      const input = recordReads(ctx.input, read)
      const proxied = new Proxy({} as EffectContext<ParamSpec>, {
        get: (_, key) => (key === 'u' ? u : key === 'input' ? input : Reflect.get(ctx, key)),
        has: (_, key) => Reflect.has(ctx, key),
      })
      const update = await def.setup(proxied)
      if (typeof update !== 'function') return update
      return ((input: EffectInput, time) => {
        const answer = update(recordReads(input, read), time)
        if (typeof answer === 'boolean') answers = true
        return answer
      }) satisfies EffectUpdate
    },
  } as never) as Effect
  const restore = stubBrowser()
  let app: App | undefined
  try {
    const world = await start({}, {}, undefined, options.plugins)
    app = world.app
    const markup = options.markup ?? (def.media ? '<img src="/probe.png">' : '<div></div>')
    const element = html(markup, 100, 100, 400, 300)
    app.attach(element, wrapped(options.params as never))
    await run(world.driver)
    // A slow setup (a model to load, a compile) may need more rounds on a busy machine.
    const find = () => app?.effects.instances().find((instance) => instance.element === element)
    const status = () => find()?.status.value
    for (let round = 0; round < MAX_SETUP_ROUNDS; round++) {
      if (!['waiting', 'loading'].includes(status() ?? '')) break
      await run(world.driver, 1)
    }
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 200 }))
    Object.defineProperty(window, 'scrollY', { value: 40, configurable: true })
    window.dispatchEvent(new Event('scroll'))
    world.driver.tick()
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 260, clientY: 240 }))
    world.driver.tick()
    document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))
    await run(world.driver, 12)
    const rest = world.driver.flush(120)
    const instance = find()
    const animate = def.animate
    return {
      status: instance?.status.value ?? 'disposed',
      error: instance?.error,
      inputs: [...read].sort(),
      // Without a declared policy the runtime goes by the update's answer, else by the clocks.
      policy:
        typeof animate === 'function'
          ? 'function'
          : typeof animate === 'object'
            ? 'fps'
            : (animate ??
              (answers
                ? 'update'
                : read.has('time')
                  ? 'visible'
                  : read.has('hoverTime')
                    ? 'hover'
                    : 'input')),
      rest,
    }
  } finally {
    await app?.destroy()
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    document.body.innerHTML = ''
    restore()
  }
}
