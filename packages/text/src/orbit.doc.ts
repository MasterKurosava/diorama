import type { EffectDoc } from '@dioramajs/effects'
import type orbit from './orbit'

const doc: EffectDoc<typeof orbit> = {
  category: 'text',
  tags: ['3d', 'scroll'],
  summary:
    'A line of text wraps around a 3D form that turns: a spinning drum, a globe of text, or a tilted ring around a product.',
  looks:
    'The letters bend around a real 3D shape seen through the page camera. On the drum the front letters face you, bright and beveled, while the ones on the far side show mirrored through the gaps, smaller and dimmed by depth. Lit by their normals, letters darken as they turn away and a highlight runs over their bevels as they pass the light. The globe wraps rows of the text from pole to pole, and the ring orbits the middle of the element, passing behind its image and in front of it again.',
  target:
    'a heading, a short line or a badge; for the ring, a box with an image and a one-line caption. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'cylinder wraps lines around a drum; sphere covers a globe; ring orbits the box center.',
    },
    by: {
      description:
        'scroll turns it with the page; drag lets the visitor spin it; auto turns it by itself.',
    },
    radius: {
      description:
        'Radius of the form as a share of half the box width (half its shorter side for sphere).',
      range: [0.1, 2],
    },
    tilt: {
      description:
        'Lean of the form toward the viewer, so you look down onto it; 0 sees it edge on.',
      range: [-60, 60],
      unit: 'deg',
    },
    roll: {
      description: 'Sideways lean of the form; positive lifts its right side.',
      range: [-45, 45],
      unit: 'deg',
    },
    speed: {
      description:
        'Turn rate: degrees a second with auto, degrees per 100 px of scroll; 0 holds it.',
      range: [-90, 90],
      unit: 'deg',
    },
    repeat: {
      description: 'Copies the text to fill the circle all the way around; off shows it once.',
    },
    fade: {
      description:
        'How much the far side of the form fades with depth; 0 keeps it as solid as the front.',
      range: [0, 1],
    },
    pause: {
      description: 'With auto, eases the turn to a stop under the pointer or keyboard focus.',
    },
    fps: {
      description: 'Most frames a second while it turns by itself.',
      range: [10, 60],
      step: 1,
    },
    color: {
      description: 'Color of the letters; currentColor or empty keeps the text color.',
    },
  },
  children: [
    {
      element: 'img',
      description:
        'Images inside are drawn in their place with the form, which passes behind and in front of them.',
    },
  ],
  frames:
    'While the form spins in once, while the page scrolls and the turn catches up, while a drag or its coast lasts; with auto, up to fps while on screen and not paused.',
  touch:
    'With by drag, a finger spins the form only where the element has touch-action: pan-y or none, so the page keeps its vertical scroll.',
  reducedMotion:
    'The form holds still with the front of the text facing the viewer: no scroll turn, no spin and no coast after a drag.',
  presence: 'The form fades with the page.',
  quality: {
    low: 'The letters are rastered at 1 device pixel per CSS pixel instead of 2, and auto turns at up to 30 frames a second.',
  },
  cost: {
    gpu: 'Two instanced draws of a bent mesh per letter, one for the near side and one for the far side, with two texture reads per pixel; two more quads per image.',
    memory:
      'An atlas of the letters at twice their CSS size with mip levels, and a relief map of the same size made when the page is idle.',
  },
  examples: [
    {
      title: 'A headline on a drum that turns with the scroll',
      html: '<h2 data-dio="orbit" data-dio-radius="0.6">Made to be noticed ✦</h2>',
    },
    {
      title: 'A ring of text around a product',
      html: '<figure data-dio="orbit" data-dio-style="ring" data-dio-by="auto" data-dio-tilt="18"><img src="/bottle.png" alt="Cold brew bottle"><figcaption>Cold brew · Small batch · Since 2014 ·</figcaption></figure>',
    },
    {
      title: 'A globe of text to spin by hand',
      html: '<p class="globe" data-dio="orbit" data-dio-style="sphere" data-dio-by="drag" style="touch-action: pan-y">Shipping worldwide ·</p>',
    },
    {
      title: 'A slow spinning badge',
      html: '<a href="#work" data-dio="orbit" data-dio-by="auto" data-dio-radius="0.9" data-dio-speed="30">Scroll to explore ✦</a>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Around the world</h2>',
      ts: "app.attach('.title', 'orbit', { style: 'sphere', by: 'auto', color: '#1f4fd1' })",
    },
  ],
}

export default doc
