// The light entry. No three at runtime, the effects come through import().
import type { EffectEntries } from '@diorama/effects'

/** Image effects as lazy entries, to spread into `effects({ effects })`. */
export const media: EffectEntries = {
  image: () => import('./image'),
  // Metadata the light part needs before load. Checked against the definitions in dev.
  ripple: {
    load: () => import('./ripple'),
    params: { strength: 1, frequency: 40, speed: 6 },
    when: 'hover',
  },
  bend: { load: () => import('./bend'), params: { strength: 1, split: 1 } },
}

declare module '@diorama/effects' {
  interface EffectTypes {
    image: typeof import('./image').default
    ripple: typeof import('./ripple').default
    bend: typeof import('./bend').default
  }
}
