// The light entry. No three at runtime, the effects come through import().
import { color, type EffectEntries } from '@dioramajs/effects'
import * as intro from './intro'

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
  // reducedMotion here too: under reduce neither the module nor the engine loads for them.
  reveal: {
    load: () => import('./reveal'),
    params: { duration: 1.2, delay: 0, threshold: 0.2, zoom: 1.12, softness: 0.12 },
    reducedMotion: 'off',
  },
  parallax: {
    load: () => import('./parallax'),
    params: { depth: 0.04, scroll: 0.12, ease: 0.12, focus: 0.5 },
    reducedMotion: 'off',
  },
  gallery: {
    load: () => import('./gallery'),
    params: {
      index: 0,
      duration: 1.1,
      strength: 0.25,
      interval: 0,
      click: true,
      swipe: true,
      loop: true,
    },
  },
  ambient: {
    load: () => import('./ambient'),
    params: { strength: 0.5, spread: 0.35, blur: 0.6, saturation: 1.2, fps: 10, ease: 0.5 },
  },
  // when here too: on touch screens neither the module nor the engine loads for it.
  'hover-preview': {
    load: () => import('./hover-preview'),
    params: {
      width: 320,
      ease: 0.15,
      stretch: 0.4,
      tilt: 6,
      duration: 0.35,
      offset: [0, 0],
      radius: 0,
    },
    when: '(hover: hover) and (pointer: fine)',
  },
  sequence: {
    load: () => import('./sequence'),
    params: { start: 0, end: 1, frame: 0, blend: false, ease: 0, cache: 6 },
    reducedMotion: 'off',
  },
  expand: {
    load: () => import('./expand'),
    params: { position: 0, start: 0, end: 0.5, out: 1, zoom: 1.1, radius: 0, ease: 0 },
    reducedMotion: 'off',
  },
  'zoom-scroll': {
    load: () => import('./zoom-scroll'),
    params: { start: 0, end: 0.7, zoom: 1.2, radius: 0, reverse: false, ease: 0 },
    reducedMotion: 'off',
  },
  compare: {
    load: () => import('./compare'),
    params: {
      position: 0.5,
      radius: 120,
      softness: 0,
      thickness: 2,
      color: color('#ffffff'),
      handle: true,
      start: 0.2,
      end: 0.8,
      hint: true,
    },
  },
  zoom: {
    load: () => import('./zoom'),
    params: { zoom: 2.5, radius: 80, ease: 0.08 },
    when: '(hover: hover) and (pointer: fine)',
  },
  lightbox: {
    load: () => import('./lightbox'),
    params: {
      index: -1,
      margin: 24,
      zoom: 3,
      duration: 0.45,
      backdrop: color('#0b0b0c'),
      dim: 0.92,
      loop: false,
      swipe: true,
    },
  },
  panorama: {
    load: () => import('./panorama'),
    params: {
      yaw: 0,
      pitch: 0,
      fov: 75,
      range: [35, 100],
      spin: 0,
      drag: true,
      zoom: true,
      gyro: false,
      marker: color('#ffffff'),
      markerSize: 28,
      fps: 30,
    },
  },
  tilt: {
    load: () => import('./tilt'),
    params: {
      tilt: 12,
      lift: 20,
      perspective: 800,
      ease: 0.12,
      glare: 0.25,
      foil: 0,
      shadow: 0.35,
      reverse: false,
      gyro: false,
    },
  },
  tone: {
    load: () => import('./tone'),
    params: {
      color: color('#000000'),
      background: color('#ffffff'),
      strength: 1,
      contrast: 1,
      cell: 6,
      angle: 45,
      radius: 140,
      duration: 0.4,
    },
  },
  flipbook: {
    load: () => import('./flipbook'),
    params: {
      index: 0,
      cover: true,
      duration: 0.9,
      curl: 0.6,
      shade: 0.5,
      click: true,
      swipe: true,
    },
  },
  spin: {
    load: () => import('./spin'),
    params: {
      frame: 0,
      row: 0,
      sensitivity: 1,
      spin: 0,
      inertia: 0,
      loop: true,
      reverse: false,
      blend: false,
      hint: true,
      cache: 8,
      fps: 30,
    },
  },
  glitch: {
    load: () => import('./glitch'),
    params: { strength: 1, blocks: 12, split: 8, interval: 3, duration: 0.45, seed: 1 },
    reducedMotion: 'off',
  },
  pixelate: {
    load: () => import('./pixelate'),
    params: { cell: 32, duration: 1.2, delay: 0 },
    intro: intro.pixelate,
  },
  // when and reducedMotion here too: on touch screens and under reduce nothing loads for it.
  'video-hover': {
    load: () => import('./video-hover'),
    params: { duration: 0.3, delay: 0.15, from: 0, loop: true },
    when: '(hover: hover) and (pointer: fine)',
    reducedMotion: 'off',
  },
  stack: {
    load: () => import('./stack'),
    params: {
      index: 0,
      rotate: 6,
      offset: 12,
      duration: 0.6,
      shadow: 0.35,
      loop: true,
      swipe: true,
      click: true,
      seed: 1,
    },
  },
  coverflow: {
    load: () => import('./coverflow'),
    params: {
      index: 0,
      angle: 60,
      spacing: 0.3,
      depth: 0.6,
      shade: 0.4,
      reflection: 0,
      perspective: 900,
      duration: 0.5,
      loop: false,
      drag: true,
      wheel: true,
      click: true,
    },
  },
  carousel: {
    load: () => import('./carousel'),
    params: {
      index: 0,
      interval: 0,
      spacing: 0.4,
      tilt: 8,
      focus: 1.15,
      shade: 0.5,
      reflection: 0,
      perspective: 1200,
      duration: 0.7,
      drag: true,
      wheel: true,
      click: true,
      pause: true,
    },
  },
  polaroids: {
    load: () => import('./polaroids'),
    params: {
      index: 0,
      open: -1,
      rotate: 8,
      spread: 1,
      border: 10,
      paper: color('#fbfaf6'),
      shadow: 0.45,
      zoom: 2,
      duration: 0.5,
      drag: true,
      seed: 1,
    },
  },
  spotlight: {
    load: () => import('./spotlight'),
    params: {
      radius: 140,
      softness: 0.5,
      dim: 0.8,
      color: color('#000000'),
      blur: 12,
      rest: 0,
      ease: 0.08,
      duration: 0.3,
    },
  },
  // reducedMotion here too: under reduce neither the module nor the engine loads for it.
  scrub: {
    load: () => import('./scrub'),
    params: { start: 0, end: 1, position: 0, from: 0, ease: 0.1, blend: 0.12 },
    reducedMotion: 'off',
  },
  // An intro: the green screen of the DOM video never shows before the keyed copy.
  chroma: {
    load: () => import('./chroma'),
    params: {
      screen: color('#00b140'),
      similarity: 0.45,
      softness: 0.1,
      spill: 0.5,
      blur: 1,
      crop: [0, 0, 0, 0],
    },
    intro: true,
  },
  // reducedMotion here too: under reduce neither the module nor the engine loads for it.
  liquid: {
    load: () => import('./liquid'),
    params: { strength: 1, radius: 80, duration: 1.5, swirl: 0.5, shine: 0.5, split: 1 },
    reducedMotion: 'off',
  },
  // reducedMotion here too: under reduce neither the module nor the engine loads for them.
  horizontal: {
    load: () => import('./horizontal'),
    params: { strength: 1, stretch: 0.15, parallax: 0.06, pace: 1, reverse: false, ease: 0.3 },
    reducedMotion: 'off',
  },
  curtain: {
    load: () => import('./curtain'),
    params: {
      position: 0,
      start: 0.15,
      end: 0.85,
      out: 1,
      count: 5,
      color: color('#0b0b0c'),
      zoom: 1.1,
      shade: 0.5,
      ease: 0,
    },
    reducedMotion: 'off',
    intro: intro.curtain,
  },
  flare: {
    load: () => import('./flare'),
    params: {
      strength: 0.6,
      glow: 0.25,
      ghosts: 4,
      streak: 0,
      color: color('#ffe8c8'),
      position: [0.8, 0.2],
      travel: 0.6,
      angle: 115,
      width: 0.3,
      rest: 0,
      ease: 0.12,
      duration: 0.4,
    },
  },
  frost: {
    load: () => import('./frost'),
    params: {
      blur: 22,
      strength: 0.45,
      grain: 0.5,
      radius: 70,
      refog: 4,
      refill: 1,
      duration: 1.2,
      start: 0.15,
      end: 0.5,
      cover: 1,
      x: 0.5,
      y: 0.5,
      middle: 0,
      color: color('#eef3f7'),
    },
  },
  reflection: {
    load: () => import('./reflection'),
    params: {
      strength: 0.35,
      reach: 0.45,
      blur: 8,
      gap: 0,
      trim: true,
      ripple: 0,
      shadow: 0,
      fps: 30,
    },
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    image: typeof import('./image').default
    ripple: typeof import('./ripple').default
    bend: typeof import('./bend').default
    reveal: typeof import('./reveal').default
    parallax: typeof import('./parallax').default
    gallery: typeof import('./gallery').default
    ambient: typeof import('./ambient').default
    'hover-preview': typeof import('./hover-preview').default
    sequence: typeof import('./sequence').default
    expand: typeof import('./expand').default
    'zoom-scroll': typeof import('./zoom-scroll').default
    compare: typeof import('./compare').default
    zoom: typeof import('./zoom').default
    lightbox: typeof import('./lightbox').default
    panorama: typeof import('./panorama').default
    tilt: typeof import('./tilt').default
    tone: typeof import('./tone').default
    flipbook: typeof import('./flipbook').default
    spin: typeof import('./spin').default
    glitch: typeof import('./glitch').default
    pixelate: typeof import('./pixelate').default
    'video-hover': typeof import('./video-hover').default
    stack: typeof import('./stack').default
    coverflow: typeof import('./coverflow').default
    carousel: typeof import('./carousel').default
    polaroids: typeof import('./polaroids').default
    spotlight: typeof import('./spotlight').default
    scrub: typeof import('./scrub').default
    chroma: typeof import('./chroma').default
    liquid: typeof import('./liquid').default
    horizontal: typeof import('./horizontal').default
    curtain: typeof import('./curtain').default
    flare: typeof import('./flare').default
    frost: typeof import('./frost').default
    reflection: typeof import('./reflection').default
  }
}
