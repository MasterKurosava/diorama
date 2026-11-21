import type { EffectDoc } from '@dioramajs/effects'
import type emboss from './emboss'

const doc: EffectDoc<typeof emboss> = {
  category: 'text',
  tags: ['3d', 'block'],
  summary:
    'Letters pressed into or raised out of paper, leather, brushed metal, stone or plaster, lit by a light that follows the pointer.',
  looks:
    'The element becomes a piece of material in its own background color, with the text as a real relief built from the shape of every letter: raised like a book cover, pressed in like a business card, printed into thick paper with ink in the bottom, or stood up on a wax seal. A lamp follows the pointer and drifts as the page scrolls, so the walls of the letters catch the light on one side and fall into shadow on the other, the letters cast soft shadows on the surface, and the fibres, grain, brushing or speckle of the material glint across the whole card. Small print stays printed in its color.',
  target:
    'a card, cover, label or heading with a background color and short text in a bold font; text without a background is pressed into the page as it is. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'emboss raised; deboss pressed in; letterpress an inked impression; stamp a wax seal.',
    },
    material: {
      description:
        'paper fibres; leather pebble grain; metal brushed; stone speckled; plaster troweled.',
    },
    depth: {
      description: 'Height or depth of the relief in ems of the font size; 0 is flat.',
      range: [0, 0.15],
      unit: 'em',
    },
    bevel: {
      description: 'Width of the sloped edge of each letter in ems; larger is softer and rounder.',
      range: [0, 0.1],
      unit: 'em',
    },
    light: {
      description: 'Where the light comes from at rest as a CSS angle, 0 above and 90 right.',
      range: [0, 360],
      step: 1,
      unit: 'deg',
    },
    follow: {
      description: 'How far the light moves toward the pointer; 0 keeps it at its angle.',
      range: [0, 1],
    },
    grain: {
      description: "Strength of the material's own texture and mottle; 0 is smooth.",
      range: [0, 2],
    },
    color: {
      description:
        'Ink or wax color, empty for the text color; given, it also inks emboss and deboss.',
    },
  },
  frames:
    'None at rest: the relief is drawn once and stays. Full rate while the light settles after the pointer moves, and one frame per scroll while it drifts with the page.',
  touch:
    'The light drifts with the scroll; a finger does not move it, so a tap or a swipe never flickers the relief.',
  reducedMotion:
    'The light stays at its angle: it does not follow the pointer or drift with the scroll.',
  presence: 'The surface fades with the page.',
  quality: {
    low: 'The relief is built at 1 px per CSS px instead of 2, and the shadow takes 8 steps toward the light instead of 16.',
  },
  cost: {
    gpu: 'One quad over the box; about twenty texture reads per pixel, sixteen of them for the shadow march toward the light.',
    memory:
      'A half-float relief of the text built once on the CPU from a distance field, a 512 px tile of the material per page and a canvas of the text.',
  },
  examples: [
    {
      title: 'A letterpress business card',
      html: '<div class="card" data-dio="emboss" data-dio-style="letterpress"><h3>Ines Albrecht</h3><p>Bookbinder, Leipzig</p></div>',
    },
    {
      title: 'A journal cover debossed in leather',
      html: '<div class="cover" data-dio="emboss" data-dio-style="deboss" data-dio-material="leather">Field Notes</div>',
    },
    {
      title: 'A wax seal on an invitation',
      html: '<span class="seal" data-dio="emboss" data-dio-style="stamp" data-dio-color="#8c1d1d">R &amp; M</span>',
    },
    {
      title: 'A serial plate in brushed metal, lit from the right',
      html: '<div class="plate" data-dio="emboss" data-dio-material="metal" data-dio-light="60">No. 0417</div>',
    },
    {
      title: 'From code',
      html: '<div class="tile">MMXXVI</div>',
      ts: "app.attach('.tile', 'emboss', { style: 'deboss', material: 'stone', follow: 0.6 })",
    },
  ],
}

export default doc
