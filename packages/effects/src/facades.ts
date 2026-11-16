import { resolve, write } from './cascade'
import { RESERVED_ATTRS } from './define'
import type { Controller, HandleState, InstanceRecord } from './instances'
import { camel, defaultOf, defineKeys, specKeys } from './params'
import type { AnyParamValue, EffectHandle, EffectInstance } from './types'

/** Public face of an instance record. */
export function facade(ctl: Controller, rec: InstanceRecord): EffectInstance {
  const params = {}
  const keys = (): Set<string> => {
    const spec = ctl.registry.spec(rec.name)
    const set = specKeys(spec, ...[...rec.handles].map((h) => h.params))
    if (!spec) {
      for (const attr of rec.element.getAttributeNames()) {
        const rest = attr.slice(9)
        if (!attr.startsWith('data-dio-') || RESERVED_ATTRS.includes(rest)) continue
        set.add(camel(rest.startsWith(`${rec.name}-`) ? rest.slice(rec.name.length + 1) : rest))
      }
    }
    return set
  }
  const target = {
    read: (key: string) => resolve(ctl, rec, key),
    write: (key: string, value: unknown) => {
      if (write(ctl, rec.writes, rec.name, key, value, rec.element)) ctl.changed(rec, [key])
    },
    keys,
  }
  rec.sync = () => defineKeys(params, target)
  rec.sync()
  return Object.freeze({
    effect: rec.name,
    element: rec.element,
    params,
    status: rec.state,
    get error() {
      return rec.error
    },
    set: (values: object) => {
      for (const [key, value] of Object.entries(values)) target.write(key, value)
    },
    // Drops the handles' writes too, not just the pair's.
    reset: (param?: string) => {
      for (const writes of [rec.writes, ...[...rec.handles].map((h) => h.writes)]) {
        if (param) writes.delete(param)
        else writes.clear()
      }
      ctl.changed(rec)
    },
    loaded: async () => (await ctl.registry.load(rec.name)) !== undefined,
  }) as unknown as EffectInstance
}

/** A detach function with its own params and writes. */
export function handle(ctl: Controller, h: HandleState): EffectHandle {
  const params = {}
  const target = {
    read: (key: string): AnyParamValue | undefined => {
      const kind = ctl.registry.spec(h.name)?.[key]
      const value = h.writes.get(key)?.value ?? h.params[key]
      return (value ?? (kind === undefined ? undefined : defaultOf(kind))) as AnyParamValue
    },
    write: (key: string, value: unknown) => {
      if (!h.live || !write(ctl, h.writes, h.name, key, value)) return
      for (const rec of h.records) ctl.changed(rec, [key])
    },
    keys: () => specKeys(ctl.registry.spec(h.name), h.params),
  }
  h.sync = () => defineKeys(params, target)
  h.sync()
  const detach = (): void => ctl.detach(h)
  Object.defineProperty(detach, 'instances', {
    get: () => [...h.records].filter((r) => r.status !== 'disposed').map((r) => r.facade),
  })
  return Object.freeze(
    Object.assign(detach, {
      detach,
      effect: h.name,
      params,
      set: (values: object) => {
        for (const [key, value] of Object.entries(values)) target.write(key, value)
      },
      reset: (param?: string) => {
        if (param) h.writes.delete(param)
        else h.writes.clear()
        for (const rec of h.records) ctl.changed(rec)
      },
      loaded: async () => {
        const effect = h.live ? await ctl.registry.load(h.name) : undefined
        return effect !== undefined && h.live
      },
      ready: () => ctl.ready([...h.records]),
    }),
  ) as unknown as EffectHandle
}
