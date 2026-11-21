import type { EffectDoc } from '@dioramajs/effects'
import type melt from './melt'

const doc: EffectDoc<typeof melt> = {
  category: 'text',
  tags: ['3d', 'scroll'],
  summary:
    'Letters melt like wet paint, candle wax or liquid metal, running down in glossy drips that stretch, neck and let their drops fall.',
  looks:
    'The shape of each letter turns liquid: its corners round off, its top sinks a little and its foot spreads, while drips run from the undersides of the strokes, widen into a bulb and now and then let a drop go that falls away below the text. The liquid is lit as a 3D surface with a round edge: sharp highlights along the rims, reflections of a small photo studio that slide as the page scrolls, and a soft shadow on the page. Drip is glossy paint in the color of the text, wax is warm and translucent with a pool along the baseline, and chrome is liquid mercury that ripples. The heading melts under the pointer and sets again when it leaves, follows the scroll, melts once as it comes into view and stays that way, or drips on a slow loop.',
  target:
    'a large heading, a logo word or a short label in a bold font, with room below it for the drips. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description: 'drip glossy paint that runs; wax warm, slumping wax; chrome liquid mercury.',
    },
    trigger: {
      description:
        'hover melts under the pointer; scroll follows the page; view melts once; loop drips on.',
    },
    strength: {
      description: 'How far the letters sag and the drips run; 0 keeps the shape and drips none.',
      range: [0, 2],
    },
    drips: {
      description: 'Number of drips across the text, spread along the undersides of the letters.',
      range: [0, 40],
      step: 1,
    },
    speed: {
      description: 'Pace of the melt, of setting again after a hover and of the loop.',
      range: [0, 3],
    },
    gloss: {
      description: 'Strength of the highlights and the reflections; 0 is matte.',
      range: [0, 2],
    },
    color: {
      description: 'Color of the liquid, any CSS color; empty uses the color of the text.',
    },
    seed: {
      description: 'Picks where the drips hang and how long each one runs.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'With trigger hover and scroll the text is plain DOM at rest with no frames: full rate while it melts or sets under the pointer, one frame per scroll. View draws at full rate while it melts, then holds its look with none. Loop draws 30 frames a second while in view and none off screen.',
  touch:
    'With trigger hover a tap melts the spot under the finger, which sets again after a moment. Scroll, view and loop work the same as with a mouse.',
  reducedMotion:
    'Hover and scroll leave the text as it is. View and loop show the melted look, drips hanging, without motion.',
  presence: 'The liquid fades with the page.',
  quality: {
    low: 'At most 8 drips, and the text is rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'One quad over the text and the room below it; per pixel six evaluations of the shape, each a texture read or two and a loop over the drips near it.',
    memory:
      'A canvas of the text and a half-float distance field of it and of its rounded shape, at most 900,000 texels, built once on the CPU; a small heat map for the hover.',
  },
  examples: [
    {
      title: 'A heading that melts under the pointer',
      html: '<h1 data-dio="melt">Hot sauce</h1>',
    },
    {
      title: 'Ice cream drips that run once as the title shows',
      html: '<h2 data-dio="melt" data-dio-trigger="view" data-dio-color="#f49ac1">Soft serve</h2>',
    },
    {
      title: 'A candle that slumps as the page scrolls',
      html: '<h2 data-dio="melt" data-dio-style="wax" data-dio-trigger="scroll">Slow burn</h2>',
    },
    {
      title: 'Liquid chrome that drips on a loop',
      html: '<p class="logo" data-dio="melt" data-dio-style="chrome" data-dio-trigger="loop" data-dio-drips="8">Mercury</p>',
    },
    {
      title: 'From code',
      html: '<h2 class="sale">Meltdown sale</h2>',
      ts: "app.attach('.sale', 'melt', { trigger: 'view', strength: 1.4, drips: 18 })",
    },
  ],
}

export default doc
