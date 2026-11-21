import type { EffectDoc } from '@dioramajs/effects'
import type blobs from './blobs'

const doc: EffectDoc<typeof blobs> = {
  category: 'background',
  summary:
    'Soft blobs of brand color drifting behind a hero: merging like a lava lamp, as blurred orbs or as glossy glass drops.',
  looks:
    'Up to eight round blobs in four brand colors float slowly over a flat background on looping paths, each swelling and shrinking a little on its own rhythm. In the lava style they merge where they meet and pull apart again, with soft edges and colors that blend in OKLab where two blobs join. Orbs keeps them apart as blurred discs layered over each other, the look behind frosted glass cards. Glass shades the merged shapes as glossy drops with a highlight and a bright rim, the background showing through their middle. They lean toward the pointer and move along their paths as the page scrolls. Unlike gradient, which fills the whole box with one wash of color, blobs keeps distinct shapes with the background between them.',
  target:
    'an empty decorative element behind the content, such as an aria-hidden div filling a hero; its CSS background is the look without WebGL',
  params: {
    style: {
      description:
        'lava merges the blobs like a lava lamp, for SaaS and startup heroes; orbs draws separate blurred discs, for frosted glass cards over them; glass shades the merged shapes as glossy drops, for product and app launches.',
    },
    count: {
      description:
        'How many blobs show, up to 8; a fraction fades the last one in; 0 leaves the background.',
      range: [0, 8],
    },
    color1: { description: 'Color of the first and fifth blobs, any CSS color.' },
    color2: { description: 'Color of the second and sixth blobs.' },
    color3: { description: 'Color of the third and seventh blobs.' },
    color4: { description: 'Color of the fourth and eighth blobs.' },
    background: { description: 'Color between the blobs.' },
    scale: { description: 'Size of the blobs.', range: [0.3, 2.5] },
    softness: {
      description:
        'How soft the edges are: 0 crisp shapes, 1 a wide blur; with orbs, the blur of each disc.',
      range: [0, 1],
    },
    warp: { description: 'How much noise wobbles the edges; 0 keeps them round.', range: [0, 1] },
    speed: { description: 'How fast the blobs travel; 0 holds them in place.', range: [0, 1] },
    attract: {
      description:
        'How far the blobs lean toward the pointer while it is over the element; 0 ignores it.',
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
    seed: { description: 'Paths, sizes and rhythms of the blobs.', range: [1, 100], step: 1 },
  },
  frames:
    'Up to fps frames a second while on screen, none off screen or at fps 0; pointer and scroll draw at full rate.',
  touch: 'The blobs lean toward a finger while it is on the screen; scrolling works as usual.',
  reducedMotion:
    'A still frame: the blobs and the grain stop, and neither the pointer nor scroll moves them.',
  presence: 'Fades with the page transition.',
  quality: {
    low: 'At most 15 frames a second and 4 blobs.',
    medium: 'At most 24 frames a second.',
  },
  cost: {
    gpu: 'One pass over the element: one read of a small noise tile and a few operations per blob and pixel.',
    memory: 'A 64 × 64 noise tile shared with gradient.',
  },
  examples: [
    {
      title: 'Behind a SaaS hero',
      html: '<header class="hero"><div class="hero-bg" aria-hidden="true" data-dio="blobs" data-dio-background="#0b1026"></div><h1>Ship on Friday</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'Orbs behind frosted glass cards',
      html: '<section class="plans"><div class="plans-bg" aria-hidden="true" data-dio="blobs" data-dio-style="orbs" data-dio-count="4" data-dio-softness="0.6" data-dio-background="#f5f3ff" data-dio-color1="#a78bfa" data-dio-color2="#67e8f9" data-dio-color3="#f9a8d4" data-dio-color4="#fde68a"></div><h2>Plans</h2></section>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'Glass drops for a launch',
      html: '<div class="launch-bg" aria-hidden="true" data-dio="blobs" data-dio-style="glass" data-dio-count="5" data-dio-scale="1.2" data-dio-grain="0"></div>',
    },
    {
      title: 'From code',
      html: '<div class="bg" aria-hidden="true"></div>',
      ts: "app.attach('.bg', 'blobs', { color1: '#ff5a1f', color2: '#ffb800', background: '#1a0b05', attract: 0.5 })",
    },
  ],
}

export default doc
