// The public faces of the controller's state: `EffectInstance` for a record and `EffectHandle`
// for an attach call. Both expose live `params` objects that read through the cascade.
import { resolve, write } from './cascade'
import { RESERVED_ATTRS } from './define'
import type { Controller } from './instances'
import { camel, defaultOf, defineKeys, specKeys } from './params'
import type { HandleState, InstanceRecord } from './ports'
import type { AnyParamValue, EffectHandle, EffectInstance } from './types'

const PREFIX = 'data-dio-'

/** `EffectInstance` of a record. */
export function instanceFacade(controller: Controller, record: InstanceRecord): EffectInstance {
  const params = {}
  const target = {
    read: (key: string) => resolve(controller, record, key),
    write: (key: string, value: unknown) => {
      if (write(controller, record.writes, record.name, key, value, record.element)) {
        controller.changed(record, [key])
      }
    },
    keys: (): Set<string> => {
      const spec = controller.registry.spec(record.name)
      const keys = specKeys(spec, ...[...record.handles].map((handle) => handle.params))
      if (spec) return keys
      // Before the definition loads, the element's `data-dio-*` attributes name keys too, in
      // short or addressed form.
      const addressed = `${record.name}-`
      for (const attribute of record.element.getAttributeNames()) {
        const rest = attribute.slice(PREFIX.length)
        if (!attribute.startsWith(PREFIX) || RESERVED_ATTRS.includes(rest)) continue
        keys.add(camel(rest.startsWith(addressed) ? rest.slice(addressed.length) : rest))
      }
      return keys
    },
  }
  record.sync = () => defineKeys(params, target)
  record.sync()
  return Object.freeze({
    effect: record.name,
    element: record.element,
    params,
    status: record.state,
    get error() {
      return record.error
    },
    set: (values: object) => {
      for (const [key, value] of Object.entries(values)) target.write(key, value)
    },
    // Drops the handles' writes too, not just the pair's.
    reset: (param?: string) => {
      const all = [record.writes, ...[...record.handles].map((handle) => handle.writes)]
      for (const writes of all) {
        if (param) writes.delete(param)
        else writes.clear()
      }
      controller.changed(record)
    },
    loaded: async () => (await controller.registry.load(record.name)) !== undefined,
  }) as unknown as EffectInstance
}

/** `EffectHandle` of an attach call: a detach function with its own params and writes. */
export function handleFacade(controller: Controller, handle: HandleState): EffectHandle {
  const params = {}
  const target = {
    read: (key: string): AnyParamValue | undefined => {
      const kind = controller.registry.spec(handle.name)?.[key]
      const value = handle.writes.get(key)?.value ?? handle.params[key]
      return (value ?? (kind === undefined ? undefined : defaultOf(kind))) as AnyParamValue
    },
    write: (key: string, value: unknown) => {
      if (!handle.live || !write(controller, handle.writes, handle.name, key, value)) return
      for (const record of handle.records) controller.changed(record, [key])
    },
    keys: () => specKeys(controller.registry.spec(handle.name), handle.params),
  }
  handle.sync = () => defineKeys(params, target)
  handle.sync()
  const detach = (): void => controller.detach(handle)
  Object.defineProperty(detach, 'instances', {
    get: () =>
      [...handle.records]
        .filter((record) => record.status !== 'disposed')
        .map((record) => record.facade),
  })
  return Object.freeze(
    Object.assign(detach, {
      detach,
      effect: handle.name,
      params,
      set: (values: object) => {
        for (const [key, value] of Object.entries(values)) target.write(key, value)
      },
      reset: (param?: string) => {
        if (param) handle.writes.delete(param)
        else handle.writes.clear()
        for (const record of handle.records) controller.changed(record)
      },
      loaded: async () => {
        const effect = handle.live ? await controller.registry.load(handle.name) : undefined
        return effect !== undefined && handle.live
      },
      ready: () => controller.ready([...handle.records]),
    }),
  ) as unknown as EffectHandle
}
