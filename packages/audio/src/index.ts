// The light entry. No three and no WebAudio at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'

/** Sound effects as lazy entries, to spread into `effects({ effects })`. */
export const audio: EffectEntries = {
  // The live params, readable and tweenable before the module loads.
  beat: {
    load: () => import('./beat'),
    params: {
      color: color('#ff5a36'),
      zoom: 1.06,
      shake: 0,
      glow: 0.8,
      spread: 28,
      sensitivity: 0.5,
      duration: 0.25,
      fps: 60,
    },
  },
  visualizer: {
    load: () => import('./visualizer'),
    params: {
      bars: 48,
      color: color('#ffffff'),
      accent: color('#ff5a36'),
      gap: 0.3,
      radius: 2,
      range: [-90, -20],
      smooth: 0.75,
      mirror: false,
      seek: true,
      fps: 30,
    },
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    beat: typeof import('./beat').default
    visualizer: typeof import('./visualizer').default
  }
}
