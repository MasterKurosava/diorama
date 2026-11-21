// The light entry. No three at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'

/** Background effects as lazy entries, to spread into `effects({ effects })`. */
export const backgrounds: EffectEntries = {
  // The live params, readable and tweenable before the module loads.
  gradient: {
    load: () => import('./gradient'),
    params: {
      color1: color('#0b1d3a'),
      color2: color('#3a2b8c'),
      color3: color('#e35d6a'),
      color4: color('#f6c177'),
      speed: 0.2,
      scale: 1,
      warp: 0.4,
      attract: 0.15,
      scroll: 0.25,
      grain: 0.03,
      fps: 30,
    },
  },
  dots: {
    load: () => import('./dots'),
    params: {
      gap: 24,
      dot: 2,
      color: color('#a3acb9'),
      accent: color('#5b6cff'),
      radius: 140,
      strength: 0.6,
      speed: 0,
      fade: 0,
    },
  },
  waves: {
    load: () => import('./waves'),
    params: {
      lines: 16,
      color: color('#3b6a8f'),
      background: color('#0c1424'),
      warp: 0.5,
      speed: 0.3,
      thickness: 1.2,
      scroll: 0.3,
      fps: 30,
    },
  },
  stars: {
    load: () => import('./stars'),
    params: {
      count: 800,
      depth: 0.5,
      twinkle: 0.5,
      speed: 0.3,
      warp: 0.5,
      scale: 1,
      color: color('#ffffff'),
      background: color('#04060f'),
      shooting: 4,
      fps: 30,
    },
  },
  blobs: {
    load: () => import('./blobs'),
    params: {
      count: 6,
      color1: color('#6d5dfc'),
      color2: color('#22d3ee'),
      color3: color('#f472b6'),
      color4: color('#fbbf24'),
      background: color('#0b1026'),
      scale: 1,
      softness: 0.3,
      warp: 0.3,
      speed: 0.15,
      attract: 0.2,
      scroll: 0.25,
      grain: 0.03,
      fps: 30,
    },
  },
  clouds: {
    load: () => import('./clouds'),
    params: { cover: 0.5, speed: 0.2, scale: 1, sun: 0.6, depth: 0.2, scroll: 0.3, fps: 30 },
  },
  grid: {
    load: () => import('./grid'),
    params: {
      color: color('#ff4fd8'),
      background: color('#0d0221'),
      accent: color('#ff8a3d'),
      cells: 14,
      horizon: 0.5,
      speed: 0.4,
      sun: 0.5,
      thickness: 1.2,
      depth: 0.2,
      scroll: 0.3,
      fps: 30,
    },
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    gradient: typeof import('./gradient').default
    dots: typeof import('./dots').default
    waves: typeof import('./waves').default
    stars: typeof import('./stars').default
    blobs: typeof import('./blobs').default
    clouds: typeof import('./clouds').default
    grid: typeof import('./grid').default
  }
}
