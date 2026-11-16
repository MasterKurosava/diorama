import { EffectError } from './errors'
import type { Controller, HandleState, InstanceRecord, Write } from './instances'
import { camel, coerce, defaultOf, kebab, plausible } from './params'
import type { AnyParamValue } from './types'

/** `data-dio-<effect>-<param>`, else the short form if this effect alone owns the param. */
function attribute(ctl: Controller, rec: InstanceRecord, key: string): string | undefined {
  const el = rec.element
  const k = kebab(key)
  const addressed = el.getAttribute(`data-dio-${rec.name}-${k}`)
  if (addressed !== null) return addressed
  const short = el.getAttribute(`data-dio-${k}`)
  if (short === null) return undefined
  for (const other of ctl.of(el)) {
    if (other === rec) continue
    const spec = ctl.registry.spec(other.name)
    const prefix = `${other.name}-`
    const owned = spec && key in spec
    const addressedElsewhere = spec && k.startsWith(prefix) && camel(k.slice(prefix.length)) in spec
    if (owned || addressedElsewhere) {
      const message = owned
        ? `data-dio-${k} matches ${rec.name} and ${other.name}; use data-dio-${rec.name}-${k}`
        : `data-dio-${k} addresses ${other.name}; use data-dio-${rec.name}-${k} for ${rec.name}`
      ctl.warn(`short:${k}`, new EffectError('EFFECT_PARAM', message, { element: el }))
      return undefined
    }
  }
  return short
}

/** The cascade: defaults < attach < attributes < runtime writes. */
export function resolve(
  ctl: Controller,
  rec: InstanceRecord,
  key: string,
): AnyParamValue | undefined {
  const kind = ctl.registry.spec(rec.name)?.[key]
  let last = rec.writes.get(key)
  let attached: unknown
  let order = 0
  for (const h of rec.handles) {
    const w = h.writes.get(key)
    if (w && (!last || w.seq > last.seq)) last = w
    if (key in h.params && h.id > order) {
      order = h.id
      attached = h.params[key]
    }
  }
  if (last) return last.value as AnyParamValue
  const attr = attribute(ctl, rec, key)
  if (attr !== undefined) {
    // Without a known type, the attribute reads as a number if it can.
    const value = coerce(kind ?? 0, attr)
    if (value !== undefined) return value
    if (kind !== undefined) reject(ctl, rec.name, rec.element, `data-dio ${key}`, attr)
  }
  if (attached !== undefined) return attached as AnyParamValue
  return kind === undefined ? undefined : defaultOf(kind)
}

export function values(ctl: Controller, rec: InstanceRecord): Record<string, AnyParamValue> {
  const values: Record<string, AnyParamValue> = {}
  for (const key of Object.keys(ctl.registry.spec(rec.name) ?? {})) {
    values[key] = resolve(ctl, rec, key) as AnyParamValue
  }
  return values
}

/**
 * Converts a value once the param type is known. Before the definition loads, a plausible value
 * is kept as is. Returns undefined to reject.
 */
function accept(ctl: Controller, name: string, key: string, value: unknown): unknown {
  const kind = ctl.registry.spec(name)?.[key]
  if (kind !== undefined) return coerce(kind, value)
  if (ctl.registry.entries.get(name)?.effect || !plausible(value)) return undefined
  const iterable = typeof value === 'object' && value !== null && Symbol.iterator in value
  return iterable ? [...(value as Iterable<unknown>)] : value
}

function reject(
  ctl: Controller,
  name: string,
  element: Element | undefined,
  key: string,
  value: unknown,
): void {
  const message = `"${name}" rejects ${key} = ${JSON.stringify(value)}`
  const error = new EffectError('EFFECT_PARAM', message, { effect: name, element })
  ctl.warn(`param:${name}:${key}:${String(value)}`, error)
}

/** Stores a runtime write, or warns if it is rejected. Returns true if stored. */
export function write(
  ctl: Controller,
  writes: Map<string, Write>,
  name: string,
  key: string,
  value: unknown,
  el?: Element,
): boolean {
  const accepted = accept(ctl, name, key, value)
  if (accepted === undefined) reject(ctl, name, el, key, value)
  else writes.set(key, { value: accepted, seq: ++ctl.seq })
  return accepted !== undefined
}

/** Re-checks stored values once more is known. Bad ones warn and are dropped. */
export function recheck(
  ctl: Controller,
  values: Map<string, Write>,
  name: string,
  el?: Element,
): void {
  for (const [key, w] of values) {
    const value = accept(ctl, name, key, w.value)
    if (value !== undefined) values.set(key, { value, seq: w.seq })
    else {
      values.delete(key)
      reject(ctl, name, el, key, w.value)
    }
  }
}

/** Checks a handle's params and writes against what is known of its definition. */
export function validate(ctl: Controller, h: HandleState): void {
  for (const [key, value] of Object.entries(h.params)) {
    const accepted = accept(ctl, h.name, key, value)
    if (accepted !== undefined) h.params[key] = accepted
    else {
      delete h.params[key]
      reject(ctl, h.name, undefined, key, value)
    }
  }
  recheck(ctl, h.writes, h.name)
}
