// The light entry. No three at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'

/** The 3D effects as lazy entries, to spread into `effects({ effects })`. */
export const model: EffectEntries = {
  // The live params, readable and tweenable before the module loads.
  model: {
    load: () => import('./model'),
    params: {
      color: color('#ffffff'),
      duration: 0.4,
      scale: 0.9,
      yaw: 0,
      pitch: 0,
      spin: 0,
      turn: 0,
      tilt: 8.6,
      drag: true,
      exposure: 1,
    },
  },
  device: {
    load: () => import('./device'),
    params: {
      color: color('#1d1e22'),
      yaw: -18,
      pitch: 6,
      tilt: 6.9,
      turn: 0,
      radius: 1,
      shadow: 0.5,
      scale: 0.9,
    },
  },
  book: {
    load: () => import('./book'),
    params: {
      pages: 320,
      yaw: 0,
      swing: 36,
      open: 12,
      tilt: 5.7,
      drag: true,
      shadow: 0.5,
    },
  },
  explode: {
    load: () => import('./explode'),
    params: {
      spread: 1,
      start: 0,
      end: 1,
      position: 0,
      cascade: 0.3,
      twist: 0,
      ease: 0.15,
      contain: true,
    },
  },
  hotspots: {
    load: () => import('./hotspots'),
    params: { face: true },
  },
  box: {
    load: () => import('./box'),
    params: {
      yaw: 0,
      pitch: 0,
      swing: 30,
      open: 0.6,
      tilt: 5.7,
      spin: 0,
      drag: true,
      shadow: 0.5,
    },
  },
  coin: {
    load: () => import('./coin'),
    params: {
      metal: color('#d4af5f'),
      ink: 1,
      relief: 0.6,
      yaw: 0,
      pitch: 0,
      tilt: 14.3,
      turn: 0,
      spin: 0,
      drag: true,
      shadow: 0.5,
    },
  },
  vinyl: {
    load: () => import('./vinyl'),
    params: { color: color('#c8323c'), out: 0.55, rpm: 33, tilt: 6.9, shadow: 0.5 },
  },
  label: {
    load: () => import('./label'),
    params: {
      yaw: 0,
      pitch: 8,
      tilt: 6.9,
      turn: 180,
      spin: 0,
      gloss: 0.5,
      drag: true,
      shadow: 0.5,
    },
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    model: typeof import('./model').default
    device: typeof import('./device').default
    book: typeof import('./book').default
    box: typeof import('./box').default
    explode: typeof import('./explode').default
    hotspots: typeof import('./hotspots').default
    coin: typeof import('./coin').default
    vinyl: typeof import('./vinyl').default
    label: typeof import('./label').default
  }
}
