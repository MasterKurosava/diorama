import type { EffectDoc } from '@dioramajs/effects'
import type extrude from './extrude'

const doc: EffectDoc<typeof extrude> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'A headline becomes a solid 3D block: beveled letters with lit side walls, seen in perspective, that turn toward the pointer.',
  looks:
    'The letters keep their font and layout but gain real depth: each one is a block extruded behind its face, with a rounded bevel that catches the light, walls shaded by which way they face and darker toward the back, and a soft shadow on the page behind. The depth recedes in perspective, so letters far from the center show more of their sides. As the pointer moves, the block turns to face it and the light slides over the bevels; with scroll it turns as the heading crosses the viewport. Other styles stack the glyphs as paper layers in your colors, or draw a flat long shadow.',
  target:
    'a heading or short text in a large, heavy font. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'solid is a lit, beveled block; layers stacks paper cutouts; shadow is a flat long shadow.',
    },
    by: {
      description:
        'pointer turns it toward the pointer; scroll turns it as the page scrolls; none holds it.',
    },
    depth: {
      description:
        'How far the depth reaches behind the face at rest; a long shadow runs 5 times this.',
      range: [0, 80],
      unit: 'px',
    },
    layers: {
      description: 'Number of paper layers behind the face in the layers style.',
      range: [1, 12],
      step: 1,
    },
    tilt: {
      description: 'Largest turn of the block toward the pointer or with the scroll; 0 holds it.',
      range: [0, 30],
      unit: 'deg',
    },
    light: {
      description:
        'Where the light comes from as a CSS angle, 0 above and 90 right; depth falls away from it.',
      range: [0, 360],
      unit: 'deg',
    },
    color: {
      description:
        'Wall color for solid, paper base for layers, shadow color for shadow; empty derives it.',
    },
    colors: {
      description:
        'Colors of the paper layers from front to back, repeated; empty uses darker shades.',
    },
  },
  frames:
    'While the depth grows in once, while the pointer moves or the block settles after it, and while scrolling; none at rest.',
  touch:
    'With by pointer, a touch screen turns the block with the scroll instead, since there is no hover.',
  reducedMotion: 'The block is drawn at full depth without growing in, and it does not turn.',
  presence: 'The block fades with the page.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2, so the depth takes fewer steps.',
  },
  cost: {
    gpu: 'One quad over the text and its depth: a march of about one texture read per device pixel of depth, a few reads for the bevel, walls and shadow.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, and a distance field of it at up to a million samples, made once when the page is idle.',
  },
  examples: [
    {
      title: 'A launch headline that turns toward the pointer',
      html: '<h1 class="hero" data-dio="extrude">Build in 3D</h1>',
    },
    {
      title: 'Paper layers in brand colors',
      html: '<h2 data-dio="extrude" data-dio-style="layers" data-dio-colors="#ffd23f #2ec4b6 #1d3557" data-dio-depth="28">Summer fest</h2>',
    },
    {
      title: 'A flat long shadow on a colored band',
      html: '<section class="band"><h2 data-dio="extrude" data-dio-style="shadow">Flat is back</h2></section>',
    },
    {
      title: 'A deep block that turns with the scroll',
      html: '<h2 data-dio="extrude" data-dio-by="scroll" data-dio-depth="40" data-dio-tilt="18">Since 1998</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Make it real</h2>',
      ts: "app.attach('.title', 'extrude', { light: 30, color: '#3b2a80' })",
    },
  ],
}

export default doc
