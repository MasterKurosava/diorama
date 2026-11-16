import { definePlugin, definePreset, type Preset, signal } from '@diorama/core'
import { values } from './cascade'
import { DEV, isEffect, onDefine, onRedefine } from './define'
import { Dom } from './dom'
import { Engine } from './gate'
import {
  Controller,
  type EffectsView,
  inertCopy,
  NO_STATS,
  noop,
  type RuntimeHost,
} from './instances'
import { Registry } from './registry'
import type {
  Attach,
  AttachPlugin,
  Effect,
  EffectHandle,
  EffectsApi,
  EffectsOptions,
  EffectsPlugin,
} from './types'

const defaults: EffectsOptions = {
  effects: {},
  root: undefined,
  markup: true,
  load: 'near',
  margin: '100% 0px',
  prefetch: true,
  render: {},
  extend: [],
  enabled: 'auto',
}

/** Progress weight of the first screen (engine chunk, render init, images). */
const FIRST_SCREEN = 230_000

/** Used without a DOM (SSR). Observes, loads and attaches nothing. */
function inert(): EffectsApi {
  const handle = (name: string): EffectHandle =>
    Object.freeze(
      Object.assign(() => {}, {
        detach: noop,
        effect: name,
        params: {},
        instances: [],
        set: noop,
        reset: noop,
        loaded: () => Promise.resolve(false),
        ready: () => Promise.resolve(),
      }),
    ) as unknown as EffectHandle
  return {
    attach: ((_: unknown, use: string | { name: string; effect?: { name: string } }) =>
      handle(typeof use === 'string' ? use : (use.effect?.name ?? use.name))) as Attach,
    get: () => undefined,
    instances: () => [],
    register: () => noop,
    disable: () => noop,
    scan: noop,
    observe: () => noop,
    pin: () => noop,
    load: () => Promise.resolve(false),
    status: signal('off'),
    render: undefined,
    take: inertCopy,
    stats: () => NO_STATS,
  }
}

/** Effects from markup and code. This light part loads the runtime when needed. */
export const effectsPlugin: EffectsPlugin = /*#__PURE__*/ definePlugin({
  name: 'effects',
  dependencies: ['stage', 'scroll', 'pointer', 'anchors'],
  optionalDependencies: ['render', 'assets'],
  defaults,
  setup(app, options): EffectsApi {
    if (typeof document === 'undefined') return inert()
    const view = app as unknown as EffectsView
    const registry = new Registry({
      loaded: (name) => ctl.loaded(name),
      failed: (name, error) => ctl.loadFailed(name, error),
      warn: (message) => app.log.warn(message),
    })
    const ctl = new Controller(view, registry)
    const host: RuntimeHost = {
      values: (rec) => {
        rec.values = values(ctl, rec)
        return rec.values
      },
      instancesOf: (element) => ctl.of(element),
      present: (element, state) => {
        if (state) dom.present.set(element, state)
        else dom.present.delete(element)
        dom.sync(element)
      },
      report: (rec, error) => ctl.report(rec, error),
      fail: (rec, error) => ctl.fail(rec, error),
      lost: () => engine.lost(),
      wake: (element) => engine.force(element),
      pin: (element) => ctl.pins.get(element)?.at(-1)?.source,
      track: (element) => ctl.track(element),
      check: (element) => {
        for (const rec of ctl.of(element)) ctl.update(rec)
      },
      retry: (element) => ctl.retry(element),
      attach: (target, use, within) => ctl.attach(target, use, undefined, undefined, within),
      plugins: () => [...engine.plugins],
      warn: (key, error) => ctl.warn(key, error),
      veil: (element, on) => dom.veil(element, on),
      queue: (element) => dom.queue(element),
    }
    const dom = new Dom(ctl, options)
    const engine = new Engine(ctl, options, host)
    ctl.dom = dom
    ctl.engine = engine
    for (const [name, source] of Object.entries(options.effects)) registry.set(name, source)

    // Dev HMR: a re-evaluated definition replaces the one its loader brought.
    if (DEV) {
      const swap = (name: string, effect: Effect): void => {
        const entry = registry.entries.get(name)
        const old = entry?.effect
        if (!entry || !old || old === effect || isEffect(entry.source)) return
        entry.effect = effect
        entry.pending = Promise.resolve(effect)
        ctl.loaded(name)
        ctl.replaced(name)
      }
      app.onDispose(
        onDefine((effect) => {
          // Unnamed effects are matched by key through `redefine`.
          if (!effect.name) return
          for (const [name, entry] of registry.entries) {
            if (entry.effect?.name === effect.name) swap(name, effect)
          }
        }),
      )
      app.onDispose(onRedefine(swap))
    }
    app.onDispose(app.stage.reducedMotion.subscribe(() => ctl.refresh()))
    // Synchronous, so an app created right after destroy sees the elements free.
    app.onDispose(() => {
      ctl.destroy()
      engine.destroy()
      dom.destroy()
    })
    dom.start()
    engine.start()
    // Join the preloader's first wave now. With load 'near' the engine boots after the first
    // paint, when that wave may already have settled.
    const { assets } = view
    if (assets && ctl.live.size && engine.canBoot()) {
      assets.track(ctl.ready([...ctl.live]), { weight: FIRST_SCREEN, priority: 'high' })
    }

    const attach = ((target, use, params, options) =>
      ctl.attach(target, use, params, options)) as Attach
    return {
      attach,
      get(element, name) {
        const live = (): boolean => (ctl.find(element, name)?.status ?? 'disposed') !== 'disposed'
        // Not reconciled yet, so scan this element now instead of missing it.
        if (!live() && element.getAttribute('data-dio')?.split(/\s+/).includes(name)) {
          dom.scan(element)
        }
        return live() ? (ctl.find(element, name)?.facade as never) : undefined
      },
      instances: (name) =>
        [...ctl.live].filter((r) => !name || r.name === name).map((r) => r.facade),
      register(entries) {
        const added = Object.entries(entries).flatMap(([name, source]) => {
          const previous = registry.entries.get(name)
          // The same source after a rejected import is a new attempt.
          if (previous?.source === source && !previous.failed) return []
          if (previous && DEV) app.log.warn(`register() replaces "${name}"`)
          const entry = registry.set(name, source)
          ctl.replaced(name)
          return [[name, entry] as const]
        })
        return () => {
          for (const [name, entry] of added) {
            if (registry.entries.get(name) !== entry) continue
            registry.entries.delete(name)
            ctl.replaced(name)
          }
        }
      },
      disable: (name) => ctl.disable(name),
      scan: (root) => dom.scan(root),
      observe: (root) => dom.observe(root),
      pin(element, source) {
        // A stack per element. The newest source wins and removing it restores the previous one.
        const stack = ctl.pins.get(element) ?? []
        ctl.pins.set(element, stack)
        const entry = { source }
        stack.push(entry)
        app.invalidate()
        return () => {
          const index = stack.indexOf(entry)
          if (index < 0) return
          stack.splice(index, 1)
          if (!stack.length) ctl.pins.delete(element)
          app.invalidate()
        }
      },
      load: () => engine.load(),
      status: engine.status,
      get render() {
        return engine.render
      },
      take(element, options) {
        const { runtime } = engine
        return runtime && dom.free(element) ? runtime.take(element, options) : inertCopy(element)
      },
      stats: () => engine.runtime?.stats() ?? NO_STATS,
    }
  },
})

/** `app.attach`, the same function as `app.effects.attach`. */
export const attachPlugin: AttachPlugin = /*#__PURE__*/ definePlugin({
  name: 'attach',
  dependencies: ['effects'],
  setup: (app): Attach => app.effects.attach,
})

/** Preset of the `effects` and `attach` plugins. */
/*#__NO_SIDE_EFFECTS__*/
export function effects(
  options: Partial<EffectsOptions> = {},
): Preset<EffectsPlugin | AttachPlugin> {
  return definePreset({ name: 'effects', plugins: [effectsPlugin(options), attachPlugin] })
}
