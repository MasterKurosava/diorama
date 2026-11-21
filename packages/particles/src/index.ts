// The light entry. No three at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'

/** Particle effects as lazy entries, to spread into `effects({ effects })`. */
export const particles: EffectEntries = {
  // The live params, readable and tweenable before the module loads.
  confetti: {
    load: () => import('./confetti'),
    params: {
      fire: 0,
      once: false,
      count: 200,
      angle: 90,
      spread: 70,
      speed: 1400,
      gravity: 1600,
      decay: 1.2,
      duration: 3,
      scale: 1,
    },
    // Under reduce neither the module nor the engine loads for it.
    reducedMotion: 'off',
  },
  sparkles: {
    load: () => import('./sparkles'),
    params: { count: 12, scale: 1, color: color('#ffd75e'), spread: 24, duration: 1.1, fps: 30 },
    reducedMotion: 'off',
  },
  snow: {
    load: () => import('./snow'),
    params: { count: 160, scale: 1, speed: 1, wind: 0.2, pile: 0, push: 0.5, fps: 30 },
    // Under reduce neither the module nor the engine loads for it.
    reducedMotion: 'off',
  },
  emoji: {
    load: () => import('./emoji'),
    params: {
      fire: 0,
      once: false,
      count: 8,
      scale: 1,
      speed: 1,
      spread: 40,
      sway: 12,
      spin: 1,
      duration: 2.4,
      interval: 1.5,
    },
    // Under reduce neither the module nor the engine loads for it.
    reducedMotion: 'off',
  },
  drops: {
    load: () => import('./drops'),
    params: {
      fire: 0,
      rate: 10,
      count: 140,
      scale: 1,
      speed: 1,
      trail: 0.6,
      dry: 8,
      merge: true,
      x: 0.5,
      y: 0.5,
      duration: 2.4,
      color: color('#ffffff'),
    },
    // Under reduce neither the module nor the engine loads for it.
    reducedMotion: 'off',
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    confetti: typeof import('./confetti').default
    sparkles: typeof import('./sparkles').default
    snow: typeof import('./snow').default
    emoji: typeof import('./emoji').default
    drops: typeof import('./drops').default
  }
}
