// The light entry. No three at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'
import * as intro from './intro'

/** Text effects as lazy entries, to spread into `effects({ effects })`. */
export const text: EffectEntries = {
  // The live params, readable and tweenable before the module loads. reducedMotion here too:
  // under reduce neither the module nor the engine loads for it.
  'text-reveal': {
    load: () => import('./text-reveal'),
    params: {
      duration: 0.9,
      stagger: 0.03,
      delay: 0,
      rise: 0.6,
      tilt: 35,
      blur: 0.5,
      threshold: 0.2,
    },
    reducedMotion: 'off',
    intro: intro.textReveal,
  },
  scramble: {
    load: () => import('./scramble'),
    params: { duration: 0.6, stagger: 0.03, delay: 0, cycle: 0.06, threshold: 0.2 },
    reducedMotion: 'off',
    intro: intro.scramble,
  },
  marquee: {
    load: () => import('./marquee'),
    params: { speed: 60, gap: 0, boost: 0.3, skew: 6, reverse: false, pause: true, fade: 0.08 },
  },
  'video-text': {
    load: () => import('./video-text'),
    params: { fps: 30, loop: true, dim: 0 },
  },
  wave: {
    load: () => import('./wave'),
    params: {
      amplitude: 0.25,
      wavelength: 6,
      speed: 0.5,
      duration: 0.7,
      stagger: 0.04,
      delay: 0,
      threshold: 0.2,
      fps: 30,
    },
    reducedMotion: 'off',
  },
  'split-flap': {
    load: () => import('./split-flap'),
    params: {
      duration: 0.07,
      flips: 10,
      stagger: 0.03,
      delay: 0,
      threshold: 0.2,
      tile: color('#1c1c1f'),
      gap: 0.08,
      shade: 0.5,
    },
    reducedMotion: 'static',
    intro: intro.splitFlap,
  },
  magnet: {
    load: () => import('./magnet'),
    params: { radius: 2.5, strength: 1, rotate: 30, stiffness: 180, damping: 12 },
    reducedMotion: 'off',
  },
  assemble: {
    load: () => import('./assemble'),
    params: {
      dot: 2.2,
      duration: 1.4,
      stagger: 0.03,
      spread: 1,
      delay: 0,
      threshold: 0.2,
      color: color('currentColor'),
      accent: color('currentColor'),
    },
    reducedMotion: 'off',
    // Like text-reveal: a heading on the first screen gathers too, a scrubbed one waits.
    intro: intro.assemble,
  },
  dust: {
    load: () => import('./dust'),
    params: { dot: 1.6, duration: 2.2, angle: 15, turbulence: 1, depth: 1, shadow: 0.5 },
  },
  'text-glitch': {
    load: () => import('./text-glitch'),
    params: { strength: 1, split: 6, slices: 5, interval: 3, duration: 0.7, seed: 1 },
    reducedMotion: 'off',
  },
  neon: {
    load: () => import('./neon'),
    params: {
      glow: 0.5,
      strength: 1,
      depth: 0.12,
      shadow: 0.6,
      tilt: 5,
      flicker: 0.3,
      broken: 0,
      seed: 1,
    },
    // Hidden until drawn, so the plain text never shows before the sign.
    intro: true,
  },
  extrude: {
    load: () => import('./extrude'),
    params: { depth: 24, layers: 4, tilt: 12, light: 315 },
  },
  counter: {
    load: () => import('./counter'),
    params: { duration: 2, from: 0, stagger: 0.12, delay: 0, threshold: 0.3 },
    reducedMotion: 'off',
    // A stat on the first screen counts up too; a scrubbed one waits for the scroll.
    intro: intro.counter,
  },
  shimmer: {
    load: () => import('./shimmer'),
    params: {
      bevel: 0.08,
      angle: 110,
      width: 1,
      speed: 1,
      strength: 1,
      follow: 1,
      shadow: 0.5,
    },
    // Hidden until drawn, so the plain text never shows before the material.
    intro: true,
  },
  rotator: {
    load: () => import('./rotator'),
    params: {
      interval: 2.2,
      duration: 0.8,
      depth: 1,
      shade: 1,
      pause: true,
      loop: true,
    },
  },
  inflate: {
    load: () => import('./inflate'),
    params: {
      depth: 1,
      gloss: 0.7,
      squish: 1,
      tilt: 10,
      duration: 1.1,
      stagger: 0.06,
      delay: 0,
      threshold: 0.3,
    },
    // Hidden until drawn, so the flat text never shows before the letters puff up. A hovered
    // label starts as DOM text.
    intro: intro.inflate,
  },
  ribbon: {
    load: () => import('./ribbon'),
    params: { wind: 1, speed: 1, folds: 2.5, twist: 180, gloss: 0.6 },
    // A `color` paints a surface the DOM does not have: hidden until the cloth draws it.
    intro: intro.ribbon,
  },
  orbit: {
    load: () => import('./orbit'),
    params: {
      radius: 1,
      tilt: 15,
      roll: 0,
      speed: 20,
      repeat: true,
      fade: 0.55,
      pause: true,
      fps: 60,
      color: color('currentColor'),
    },
    // Hidden until drawn: the flat line never shows before it wraps round the form.
    intro: true,
  },
  voxel: {
    load: () => import('./voxel'),
    params: {
      depth: 1,
      drop: 240,
      duration: 0.9,
      stagger: 0.1,
      bounce: 1,
      radius: 120,
      delay: 0,
      threshold: 0.2,
      studs: true,
    },
    reducedMotion: 'static',
    // Like assemble: a heading on the first screen builds too, a scrubbed one waits. Under
    // reduced motion only pixels draw (as still voxels); the rest stays plain text.
    intro: intro.voxel,
  },
  emboss: {
    load: () => import('./emboss'),
    params: { depth: 0.05, bevel: 0.03, light: 315, follow: 1, grain: 1 },
    // Hidden until drawn, so the flat text never shows before the relief.
    intro: true,
  },
  shatter: {
    load: () => import('./shatter'),
    params: { strength: 1, spin: 1, gravity: 1, depth: 1, hold: 1.5 },
    // The view trigger assembles a heading on the first screen too; under reduced motion it is
    // plain text, so nothing waits for it.
    intro: intro.shatter,
  },
  tunnel: {
    load: () => import('./tunnel'),
    params: {
      depth: 1,
      perspective: 1,
      fade: 0.6,
      blur: 10,
      streak: 1,
      twist: 50,
      lines: true,
      color: color('currentColor'),
    },
    reducedMotion: 'off',
    // Hidden until drawn: the phrases never show as a list before they stack in depth.
    intro: true,
  },
  melt: {
    load: () => import('./melt'),
    params: { strength: 1, speed: 1, gloss: 1 },
  },
  unfold: {
    load: () => import('./unfold'),
    params: {
      angle: 180,
      duration: 0.9,
      stagger: 0.3,
      paper: color('#f8f5ee'),
      shade: 0.7,
      delay: 0,
      threshold: 0.2,
    },
    reducedMotion: 'off',
    // Hidden until drawn, so a heading on the first screen unfolds too. A scrubbed one waits for
    // the scroll, a hovered one starts as DOM text.
    intro: intro.unfold,
  },
  pins: {
    load: () => import('./pins'),
    params: { height: 26, radius: 70, duration: 1.6, color: color('currentColor') },
    // Hidden until drawn, so the flat text never shows before the pin field.
    intro: true,
  },
  smoke: {
    load: () => import('./smoke'),
    params: { density: 1, speed: 1, rise: 1, turbulence: 1, duration: 2.4, seed: 1 },
    reducedMotion: 'off',
    // A heading on the first screen condenses too; the other triggers start as DOM text.
    intro: intro.smoke,
  },
  blinds: {
    load: () => import('./blinds'),
    params: {
      gap: 2,
      duration: 0.9,
      stagger: 0.07,
      delay: 0,
      threshold: 0.3,
      angle: 65,
      light: 315,
      back: color('currentColor'),
    },
    reducedMotion: 'off',
    // Hidden until drawn: a heading on the first screen opens too, and hover rests half open. A
    // scrubbed one waits for the scroll.
    intro: intro.blinds,
  },
  physics: {
    load: () => import('./physics'),
    params: { gravity: 1, bounce: 0.35, friction: 0.5, depth: 0.25, throw: 1 },
    reducedMotion: 'off',
    // Stack drops a heading on the first screen in from above; the other styles start as text.
    intro: intro.physics,
  },
  fire: {
    load: () => import('./fire'),
    params: { strength: 1, height: 0.9, speed: 1, embers: 30, char: 0.4 },
  },
  water: {
    load: () => import('./water'),
    params: { depth: 1, caustics: 1, ripples: 1, rain: 6, damping: 0.5, tint: 0.5 },
    // Hidden until drawn, so the dry text never shows before the water.
    intro: true,
  },
  keycaps: {
    load: () => import('./keycaps'),
    params: { depth: 0.22, gap: 0.07, radius: 0.16, speed: 9, sound: false },
    // Hidden until drawn: the flat text never shows before the keyboard.
    intro: true,
  },
  lens: {
    load: () => import('./lens'),
    params: { radius: 90, zoom: 2, dispersion: 1, thickness: 0.4, tilt: 12, ease: 0.12 },
  },
  prism: {
    load: () => import('./prism'),
    params: {
      dispersion: 1,
      spread: 1,
      strength: 1,
      bevel: 0.07,
      light: 300,
      follow: 1,
      fps: 30,
    },
    // Hidden until drawn, so the flat text never shows before the glass.
    intro: true,
  },
  hologram: {
    load: () => import('./hologram'),
    params: { layers: 6, depth: 0.3, scan: 1, flicker: 0.4, sway: 6, tilt: 8 },
    // Hidden until drawn: the flat text never shows before the projection.
    intro: true,
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    'text-reveal': typeof import('./text-reveal').default
    scramble: typeof import('./scramble').default
    marquee: typeof import('./marquee').default
    'video-text': typeof import('./video-text').default
    wave: typeof import('./wave').default
    'split-flap': typeof import('./split-flap').default
    magnet: typeof import('./magnet').default
    assemble: typeof import('./assemble').default
    dust: typeof import('./dust').default
    'text-glitch': typeof import('./text-glitch').default
    neon: typeof import('./neon').default
    extrude: typeof import('./extrude').default
    counter: typeof import('./counter').default
    shimmer: typeof import('./shimmer').default
    rotator: typeof import('./rotator').default
    inflate: typeof import('./inflate').default
    ribbon: typeof import('./ribbon').default
    orbit: typeof import('./orbit').default
    voxel: typeof import('./voxel').default
    emboss: typeof import('./emboss').default
    shatter: typeof import('./shatter').default
    tunnel: typeof import('./tunnel').default
    melt: typeof import('./melt').default
    unfold: typeof import('./unfold').default
    pins: typeof import('./pins').default
    smoke: typeof import('./smoke').default
    blinds: typeof import('./blinds').default
    physics: typeof import('./physics').default
    fire: typeof import('./fire').default
    water: typeof import('./water').default
    keycaps: typeof import('./keycaps').default
    lens: typeof import('./lens').default
    prism: typeof import('./prism').default
    hologram: typeof import('./hologram').default
  }
}
