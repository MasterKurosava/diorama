import type { EffectDoc } from '@dioramajs/effects'
import type gradient from './gradient'

const doc: EffectDoc<typeof gradient> = {
  category: 'background',
  summary:
    'A living background of four soft color blobs or of aurora curtains, mixed in OKLab, without banding, with a light film grain.',
  looks:
    'Four soft blobs of color drift slowly over the element on looping paths that take minutes to repeat, their edges bent by noise. They lean toward the pointer and shift as the page scrolls. Colors mix in OKLab, so two colors meet through a clean middle instead of a muddy gray, and every pixel is dithered, so smooth ramps show no bands. A light film grain sits on top; set grain to 0 for a clean gradient or around 0.08 for a film look. The aurora style draws the first color as a night sky and the other three as curtains of light that wave along it, sharp at their lower edge and rising in uneven rays.',
  target:
    'an empty decorative element behind the content, such as an aria-hidden div filling a hero; its CSS background is the look without WebGL',
  params: {
    style: {
      description:
        'mesh drifts four soft blobs into a wash of color, for most heroes and sections; aurora draws the first color as a dark sky with the other three as waving curtains of light, for a night or tech hero over a dark page.',
    },
    color1: {
      description: 'Color of the first blob, any CSS color; with aurora, the sky.',
    },
    color2: { description: 'Color of the second blob; with aurora, the first curtain.' },
    color3: { description: 'Color of the third blob; with aurora, the second curtain.' },
    color4: { description: 'Color of the fourth blob; with aurora, the third curtain.' },
    speed: { description: 'How fast the blobs travel along their paths.', range: [0, 1] },
    scale: {
      description: 'Size of the blobs: below 1 sharper patches, above 1 softer washes.',
      range: [0.3, 3],
    },
    warp: { description: 'How much noise bends the blobs’ edges.', range: [0, 1] },
    attract: {
      description: 'How far the blobs lean toward the pointer while it is over the element.',
      range: [0, 1],
    },
    scroll: {
      description:
        'How far the blobs move along their paths while the element crosses the viewport.',
      range: [0, 1],
    },
    grain: {
      description:
        'Strength of the film grain, one CSS pixel per grain; 0 leaves only the dithering.',
      range: [0, 0.2],
    },
    fps: {
      description: 'Most frames a second the drift draws; 0 holds it still.',
      range: [0, 60],
      step: 1,
    },
    octaves: { description: 'Layers of noise in the warp, 1 to 3.', range: [1, 3], step: 1 },
    seed: { description: 'Paths of the blobs and shape of the noise.', range: [1, 100], step: 1 },
  },
  frames:
    'Up to fps frames a second while on screen, none off screen or at fps 0; pointer and scroll draw at full rate. The grain changes with those frames and adds none.',
  touch: 'The blobs lean toward a finger while it is on the screen; scrolling works as usual.',
  reducedMotion:
    'A still gradient: the blobs and the grain stop, and neither the pointer nor scroll moves them.',
  presence: 'Fades with the page transition.',
  quality: {
    low: 'At most 15 frames a second, one layer of noise in the warp.',
    medium: 'At most 24 frames a second.',
  },
  cost: {
    gpu: 'One pass over the element: one to three reads of a small noise tile, four exponentials and a hash per pixel.',
    memory: 'A 64 × 64 noise tile shared by every gradient on the page.',
  },
  examples: [
    {
      title: 'Behind a hero',
      html: '<header class="hero"><div class="hero-bg" aria-hidden="true" data-dio="gradient" data-dio-color1="#0b1d3a" data-dio-color2="#3a2b8c" data-dio-color3="#e35d6a" data-dio-color4="oklch(85% 0.12 80)"></div><h1>Northern lights</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'A first screen with film grain',
      html: '<section class="intro"><div class="intro-bg" aria-hidden="true" data-dio="gradient" data-dio-grain="0.08" data-dio-speed="0.2"></div><h1>Studio</h1></section>',
    },
    {
      title: 'Calm and still for a long page',
      html: '<div class="backdrop" aria-hidden="true" data-dio="gradient" data-dio-fps="0" data-dio-scroll="0.6" data-dio-grain="0"></div>',
    },
    {
      title: 'Aurora over a dark hero',
      html: '<header class="hero"><div class="hero-bg" aria-hidden="true" data-dio="gradient" data-dio-style="aurora" data-dio-color1="#050b1a" data-dio-color2="#2bd59a" data-dio-color3="#4f7cff" data-dio-color4="#b45cff"></div><h1>Night shift</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'From code',
      html: '<div class="bg" aria-hidden="true"></div>',
      ts: "app.attach('.bg', 'gradient', { color1: '#101820', color4: '#fee715', attract: 0.4 })",
    },
  ],
}

export default doc
