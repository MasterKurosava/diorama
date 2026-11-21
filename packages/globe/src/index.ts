// The light entry. No three at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'

/** The globe effect as a lazy entry, to spread into `effects({ effects })`. */
export const globe: EffectEntries = {
  // The live params, readable and tweenable before the module loads.
  globe: {
    load: () => import('./globe'),
    params: {
      lat: 20,
      lng: 0,
      spin: 3.6,
      drag: true,
      scale: 0.8,
      color: color('#0d1220'),
      land: color('#5b6b8c'),
      marker: color('#ffb547'),
      arc: color('#ffb547'),
      atmosphere: color('#6ea8ff'),
      glow: 0.4,
      markerSize: 6,
      fps: 30,
    },
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    globe: typeof import('./globe').default
  }
}
