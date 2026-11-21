import type { EffectDoc } from '@dioramajs/effects'
import type ribbon from './ribbon'

const doc: EffectDoc<typeof ribbon> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'A headline printed on waving 3D fabric: a flag in the wind, a twisting satin ribbon or slow rippling silk.',
  looks:
    'The text becomes a sheet of cloth in real 3D, folded by travelling waves and seen in perspective. The folds are lit by their own normals, so the sides turned away from the light darken, crests catch a glossy highlight, and the cloth casts a soft shadow on the page that moves with it. A flag is pinned at its left edge and swings wider toward the free end; a ribbon runs one strip per line, and a twist rolls along it, turning the strip past edge-on to show its tinted back; silk ripples slowly while a sheen sweeps across. The pointer presses a dent into the cloth that follows it.',
  target:
    'a heading or short text in a large font, optionally with a solid background color and padding. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'flag is pinned at the left; ribbon twists along each line; silk ripples with a sheen.',
    },
    trigger: {
      description:
        'loop waves all the time; hover raises the wind under the pointer; scroll follows the scroll speed.',
    },
    wind: {
      description: 'How deep the folds are; 0 keeps the cloth flat apart from the twist and dent.',
      range: [0, 2],
    },
    speed: {
      description: 'How fast the waves travel; 0 freezes them in place.',
      range: [0, 3],
    },
    folds: {
      description: 'Number of waves along the cloth.',
      range: [1, 8],
      step: 0.5,
    },
    twist: {
      description: "Largest turn of the ribbon's rolling twist; past 90 its back shows.",
      range: [0, 360],
      unit: 'deg',
    },
    gloss: {
      description: 'Strength of the glossy highlight on the folds; 0 leaves only the shading.',
      range: [0, 2],
    },
    back: {
      description:
        'Color of the back of the cloth; empty uses a darker shade of the surface or text color.',
    },
    color: {
      description:
        "Surface color behind the text, drawn at rest too; empty uses the element's own background.",
    },
  },
  frames:
    'With trigger loop, every frame while on screen; with hover and scroll, only while the cloth moves and settles, none at rest.',
  touch:
    'There is no dent without a mouse. With trigger hover, a tap blows a gust that settles again; scroll works as on desktop.',
  reducedMotion:
    'The cloth stays flat and still: the plain text shows, or the flat copy with its color when color is set.',
  presence: 'The cloth fades with the page.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2, the cloth grid is half as dense, and it waves at 30 frames per second.',
    medium: 'The cloth grid is a little coarser.',
  },
  cost: {
    gpu: 'A grid of a few thousand vertices per heading, each placed by three evaluations of the waves for its normal, drawn twice: once as the cloth and once flattened as its shadow. One texture read per pixel, a blurred one for the shadow.',
    memory: 'A canvas of the text at twice its CSS size with mip levels, and the grid geometry.',
  },
  examples: [
    {
      title: 'A race headline waving like a flag',
      html: '<h1 class="hero" data-dio="ribbon">Final lap</h1>',
    },
    {
      title: 'A red satin ribbon that twists to its back',
      html: '<h2 data-dio="ribbon" data-dio-style="ribbon" data-dio-color="#d7263d" data-dio-back="#7a0f1f">Grand opening</h2>',
    },
    {
      title: 'Silk with a slow sheen',
      html: '<h2 data-dio="ribbon" data-dio-style="silk" data-dio-gloss="1.2">Maison Lune</h2>',
    },
    {
      title: 'A colored label that waves while the page scrolls',
      html: '<h2 class="label" data-dio="ribbon" data-dio-trigger="scroll">Match day</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Spring collection</h2>',
      ts: "app.attach('.title', 'ribbon', { trigger: 'hover', folds: 4 })",
    },
  ],
}

export default doc
