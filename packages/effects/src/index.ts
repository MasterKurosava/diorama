// Light entry. Never imports three at runtime, the engine comes in through import().
export { color, oneOf, redefine, text } from './define'
export type * from './doc'
export { defineEffect, effect } from './effect'
export { EffectError } from './errors'
export { attachPlugin, effects, effectsPlugin } from './plugin'
export { group } from './registry'
export type * from './types'
