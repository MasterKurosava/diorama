import type { EffectDoc } from '@dioramajs/effects'
import type stars from './stars'

const doc: EffectDoc<typeof stars> = {
  category: 'background',
  summary:
    'A night sky of twinkling stars in depth layers that lean with the pointer and the scroll, with shooting stars and a warp flight.',
  looks:
    'Hundreds of small stars over a flat sky color, most faint and a few bright, some warmer and some cooler. They twinkle, drift slowly sideways, nearer ones faster, and lean with the pointer and the scroll, so the sky has depth. A fast scroll stretches them into vertical streaks, and now and then a shooting star crosses the upper sky and fades. The warp motion flies through the field instead: stars rush out from the center and stretch into trails.',
  target:
    'an empty decorative element behind the content, such as an aria-hidden div filling a hero; its CSS background is the look without WebGL',
  params: {
    motion: {
      description:
        'drift twinkles and drifts slowly; warp flies through the stars; still keeps them in place.',
    },
    count: { description: 'Stars over the whole element.', range: [0, 4000], step: 1 },
    depth: {
      description: 'How far the stars lean with the pointer and the scroll; 0 turns parallax off.',
      range: [0, 1],
    },
    twinkle: {
      description: 'How deeply the stars twinkle; 0 keeps their brightness steady.',
      range: [0, 1],
    },
    speed: {
      description: 'How fast the stars drift, or how fast the warp flies.',
      range: [0, 2],
    },
    warp: {
      description: 'How far a fast scroll stretches the stars into streaks; 0 never stretches.',
      range: [0, 1],
    },
    scale: { description: 'Size of the stars over a base of about 1 px.', range: [0.3, 4] },
    color: { description: 'Color of the stars, any CSS color; each star tints it slightly.' },
    background: { description: 'Color of the sky behind the stars, any CSS color.' },
    shooting: {
      description: 'Shooting stars a minute on average; 0 turns them off.',
      range: [0, 30],
      step: 1,
    },
    fps: {
      description: 'Most frames a second the motion draws; 0 holds the stars still.',
      range: [0, 60],
      step: 1,
    },
    seed: { description: 'Positions, sizes and colors of the stars.', range: [1, 100], step: 1 },
  },
  frames:
    'Up to fps frames a second while on screen, none off screen, at fps 0 or with the still motion; pointer and scroll draw at full rate.',
  touch:
    'The stars lean with a finger while it is on the screen; scroll parallax and streaks work as usual.',
  reducedMotion:
    'A still sky: no twinkle, drift, warp, shooting stars, parallax or streaks, and no frames.',
  presence: 'Fades with the page transition.',
  quality: {
    low: 'At most 300 stars and 24 frames a second.',
    medium: 'At most 550 stars.',
  },
  cost: {
    gpu: 'One pass for the sky and one instanced draw of small quads for all the stars.',
    memory: 'Two instance buffers of 4003 entries, about 128 KB.',
  },
  examples: [
    {
      title: 'Behind a hero',
      html: '<header class="hero"><div class="hero-sky" aria-hidden="true" data-dio="stars"></div><h1>Launch night</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'A warp for an event countdown',
      html: '<section class="countdown"><div class="countdown-bg" aria-hidden="true" data-dio="stars" data-dio-motion="warp" data-dio-speed="0.6" data-dio-count="1200"></div><p>Doors open in 03:12:44</p></section>',
    },
    {
      title: 'A calm sky with no shooting stars',
      html: '<div class="night" aria-hidden="true" data-dio="stars" data-dio-shooting="0" data-dio-twinkle="0.3" data-dio-background="#0b1026"></div>',
    },
    {
      title: 'From code',
      html: '<div class="sky" aria-hidden="true"></div>',
      ts: "app.attach('.sky', 'stars', { count: 1500, color: '#cfe3ff', shooting: 8 })",
    },
  ],
}

export default doc
