import type { EffectErrorCode } from './types'

export interface EffectErrorOptions {
  readonly effect?: string | undefined
  readonly element?: Element | undefined
  readonly cause?: unknown
}

/** Goes through `app.report`, which wraps it as `REPORTED` with this as `cause`. */
export class EffectError extends Error {
  override readonly name: 'EffectError' = 'EffectError'
  readonly code: EffectErrorCode
  readonly effect: string | undefined
  readonly element: Element | undefined

  constructor(code: EffectErrorCode, message: string, options: EffectErrorOptions = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.effect = options.effect
    this.element = options.element
  }
}

/** Report target: `effect:<name>@<tag>#<id>.<class>`, at most 60 characters. */
export function targetOf(effect: string, element?: Element): string {
  let label = `effect:${effect}`
  if (element) {
    const cls =
      typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : ''
    label += `@${element.localName}${element.id ? `#${element.id}` : ''}${cls ? `.${cls}` : ''}`
  }
  return label.slice(0, 60)
}
