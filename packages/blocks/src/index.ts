// The light entry. No three at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'

/** Block effects as lazy entries, to spread into `effects({ effects })`. */
export const blocks: EffectEntries = {
  // The live params, readable and tweenable before the module loads.
  beam: {
    load: () => import('./beam'),
    params: {
      color: color('#ffaa40'),
      color2: color('#9c40ff'),
      length: 240,
      speed: 200,
      thickness: 2,
      glow: 0.8,
      fps: 60,
    },
  },
  glow: {
    load: () => import('./glow'),
    params: {
      color: color('#ffffff'),
      radius: 320,
      border: 1,
      fill: 0.12,
      ease: 0.1,
    },
    // Phones and tablets have no pointer to follow: neither the module nor the engine loads.
    when: 'hover',
  },
  shine: {
    load: () => import('./shine'),
    params: {
      angle: 120,
      width: 0.35,
      color: color('#ffffff'),
      duration: 1.1,
      interval: 4,
      strength: 0.5,
    },
    // Under reduce neither the module nor the engine loads for it.
    reducedMotion: 'off',
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    beam: typeof import('./beam').default
    glow: typeof import('./glow').default
    shine: typeof import('./shine').default
  }
}
