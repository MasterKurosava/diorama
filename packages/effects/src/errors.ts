// The error class of effects and the target label their reports carry.
import { withDocs } from '@dioramajs/core/dev'
import type { EffectErrorCode } from './types'

/** What an `EffectError` points at. */
export interface EffectErrorOptions {
  readonly effect?: string | undefined
  readonly element?: Element | undefined
  readonly cause?: unknown
}

/** Longest report target, in characters. */
const MAX_TARGET_LENGTH = 60

/**
 * Goes through `app.report`, which wraps it as `REPORTED` with this as `cause`.
 * `instanceof EffectError` checks the name, so it also holds for definition errors
 * thrown by `@dioramajs/effects/effect`, which cannot import this class, and across two copies.
 */
export class EffectError extends Error {
  static override [Symbol.hasInstance](value: unknown): value is EffectError {
    return value instanceof Error && value.name === 'EffectError'
  }

  override readonly name: 'EffectError' = 'EffectError'
  readonly code: EffectErrorCode
  readonly effect: string | undefined
  readonly element: Element | undefined

  constructor(code: EffectErrorCode, message: string, options: EffectErrorOptions = {}) {
    super(
      withDocs(`${code}: ${message}`, code),
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.code = code
    this.effect = options.effect
    this.element = options.element
  }
}

/** Report target: `effect:<name>@<tag>#<id>.<class>`, cut to MAX_TARGET_LENGTH characters. */
export function targetOf(effect: string, element?: Element): string {
  let label = `effect:${effect}`
  if (element) {
    const firstClass =
      typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : ''
    label += `@${element.localName}${element.id ? `#${element.id}` : ''}${firstClass ? `.${firstClass}` : ''}`
  }
  return label.slice(0, MAX_TARGET_LENGTH)
}
