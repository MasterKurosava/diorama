// The param cascade of an instance: defaults < attach params < attributes < runtime writes.
// Also checks written values against the param types once they are known, warning on rejects.
import { EffectError } from './errors'
import type { Controller } from './instances'
import { camel, coerce, defaultOf, kebab, plausible } from './params'
import type { HandleState, InstanceRecord, Write } from './ports'
import type { AnyParamValue } from './types'

/** The value of one param, the latest layer of the cascade that has it. */
export function resolve(
  controller: Controller,
  record: InstanceRecord,
  key: string,
): AnyParamValue | undefined {
  const kind = controller.registry.spec(record.name)?.[key]
  let latestWrite = record.writes.get(key)
  let attached: unknown
  let newestHandle = 0
  for (const handle of record.handles) {
    const write = handle.writes.get(key)
    if (write && (!latestWrite || write.sequence > latestWrite.sequence)) latestWrite = write
    if (key in handle.params && handle.id > newestHandle) {
      newestHandle = handle.id
      attached = handle.params[key]
    }
  }
  if (latestWrite) return latestWrite.value as AnyParamValue
  const text = attribute(controller, record, key)
  if (text !== undefined) {
    // Without a known type, the attribute reads as a number if it can.
    const value = coerce(kind ?? 0, text)
    if (value !== undefined) return value
    if (kind !== undefined) reject(controller, record.name, record.element, `data-dio ${key}`, text)
  }
  if (attached !== undefined) return attached as AnyParamValue
  return kind === undefined ? undefined : defaultOf(kind)
}

/** Every param of the definition, resolved. */
export function values(
  controller: Controller,
  record: InstanceRecord,
): Record<string, AnyParamValue> {
  const resolved: Record<string, AnyParamValue> = {}
  for (const key of Object.keys(controller.registry.spec(record.name) ?? {})) {
    resolved[key] = resolve(controller, record, key) as AnyParamValue
  }
  return resolved
}

/** Stores a runtime write, or warns if it is rejected. Returns true if stored. */
export function write(
  controller: Controller,
  writes: Map<string, Write>,
  name: string,
  key: string,
  value: unknown,
  element?: Element,
): boolean {
  const accepted = accept(controller, name, key, value)
  if (accepted === undefined) reject(controller, name, element, key, value)
  else writes.set(key, { value: accepted, sequence: ++controller.sequence })
  return accepted !== undefined
}

/** Re-checks stored values once more is known. Bad ones warn and are dropped. */
export function recheck(
  controller: Controller,
  writes: Map<string, Write>,
  name: string,
  element?: Element,
): void {
  for (const [key, stored] of writes) {
    const value = accept(controller, name, key, stored.value)
    if (value !== undefined) writes.set(key, { value, sequence: stored.sequence })
    else {
      writes.delete(key)
      reject(controller, name, element, key, stored.value)
    }
  }
}

/** Checks a handle's params and writes against what is known of its definition. */
export function validate(controller: Controller, handle: HandleState): void {
  for (const [key, value] of Object.entries(handle.params)) {
    const accepted = accept(controller, handle.name, key, value)
    if (accepted !== undefined) handle.params[key] = accepted
    else {
      delete handle.params[key]
      reject(controller, handle.name, undefined, key, value)
    }
  }
  recheck(controller, handle.writes, handle.name)
}

/**
 * `data-dio-<effect>-<param>`, else the short `data-dio-<param>` if no other effect of the
 * element owns the param or is addressed by it.
 */
function attribute(
  controller: Controller,
  record: InstanceRecord,
  key: string,
): string | undefined {
  const { element } = record
  const param = kebab(key)
  const addressed = element.getAttribute(`data-dio-${record.name}-${param}`)
  if (addressed !== null) return addressed
  const short = element.getAttribute(`data-dio-${param}`)
  if (short === null) return undefined
  for (const other of controller.of(element)) {
    if (other === record) continue
    const spec = controller.registry.spec(other.name)
    const prefix = `${other.name}-`
    const owned = spec && key in spec
    const addressedElsewhere =
      spec && param.startsWith(prefix) && camel(param.slice(prefix.length)) in spec
    if (!owned && !addressedElsewhere) continue
    const message = owned
      ? `data-dio-${param} matches ${record.name} and ${other.name}; use data-dio-${record.name}-${param}`
      : `data-dio-${param} addresses ${other.name}; use data-dio-${record.name}-${param} for ${record.name}`
    controller.warn(`short:${param}`, new EffectError('EFFECT_PARAM', message, { element }))
    return undefined
  }
  return short
}

/**
 * Converts a value once the param type is known. Before the definition loads, a plausible value
 * is kept as is. Returns undefined to reject.
 */
function accept(controller: Controller, name: string, key: string, value: unknown): unknown {
  const { registry } = controller
  const kind = registry.spec(name)?.[key]
  if (kind !== undefined) return coerce(kind, value)
  if (registry.entries.get(name)?.effect || !plausible(value)) return undefined
  const iterable = typeof value === 'object' && value !== null && Symbol.iterator in value
  return iterable ? [...(value as Iterable<unknown>)] : value
}

function reject(
  controller: Controller,
  name: string,
  element: Element | undefined,
  key: string,
  value: unknown,
): void {
  const message = `"${name}" rejects ${key} = ${JSON.stringify(value)}`
  const error = new EffectError('EFFECT_PARAM', message, { effect: name, element })
  controller.warn(`param:${name}:${key}:${String(value)}`, error)
}
