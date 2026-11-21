import type { EffectDoc } from '@dioramajs/effects'
import type inflate from './inflate'

const doc: EffectDoc<typeof inflate> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'Letters puff up into round 3D shapes, like balloons or soft clay, that dent and wobble under the pointer.',
  looks:
    'Each letter swells into a soft, rounded volume, as if it were filled with air: straight strokes become round tubes, dots become domes and the joints of strokes bulge a little. A studio light from the upper left shades the volume, a glossy highlight runs along it and a soft shadow sits on the page under the letters. As the text comes into view the letters inflate from flat one after another with a springy overshoot. Where the pointer rests the skin dents in and nearby letters lean toward it; a press dents deeper, and on release the letters spring back with a wobble. The soft style looks like matte clay, and the jelly style like translucent gummy candy, clear at the rims and deeper in color where it is thick.',
  target:
    'a heading, a label or the text inside a button, in a bold or display font. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description: 'balloon is glossy foil; soft is matte clay; jelly is clear gummy candy.',
    },
    trigger: {
      description:
        'view inflates as it shows; hover inflates on pointer, focus or tap; always starts round.',
    },
    color: {
      description: 'Color of the letters, any CSS color; empty keeps the color of each letter.',
    },
    depth: {
      description: 'How far the letters puff out: 1 makes round tubes, 0 leaves them flat.',
      range: [0, 2],
    },
    gloss: {
      description: 'Strength of the highlights and of the sheen at the rims; 0 for none.',
      range: [0, 1.5],
    },
    squish: {
      description: 'How deep the pointer dents the letters under it; 0 turns the dent off.',
      range: [0, 1.5],
    },
    tilt: {
      description: 'Largest lean of the letters near the pointer, degrees; 0 keeps them upright.',
      range: [0, 20],
      unit: 'deg',
    },
    duration: {
      description: 'Time one letter takes to inflate, overshoot included.',
      range: [0, 3],
      unit: 's',
    },
    stagger: {
      description: 'Delay between neighboring letters as they inflate.',
      range: [0, 0.3],
      unit: 's',
    },
    delay: { description: 'Wait after the trigger, for a cascade.', range: [0, 2], unit: 's' },
    threshold: {
      description: 'Share of the element height in view, above the bottom tenth, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
  },
  frames:
    'Full rate while letters inflate or deflate and while the dent and the lean follow the pointer and spring back; none at rest, under a still pointer or with the pointer away.',
  touch:
    'A finger pressing the letters dents them and they spring back when it lifts; nothing follows a hover. With trigger hover a tap inflates the label and the next one lets it go flat.',
  reducedMotion:
    'The letters are round from the start and stay still: no inflating, no dent and no lean, and no frames of their own. With trigger hover the label switches between flat and round without motion.',
  presence: 'Leaving a page the letters go flat and fade; entering, they puff up again.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2, and its field holds at most 600,000 texels instead of 1.6 million.',
  },
  cost: {
    gpu: 'Two draws: a grid of about one vertex per 3 CSS px for each letter, raised in the vertex shader, with six texture reads per pixel for the light, and one quad for the shadow.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, and a half-float field of it with a margin for the shadow, 8 bytes a texel, built once on the CPU in short steps.',
  },
  examples: [
    {
      title: 'A heading that inflates as it shows',
      html: '<h1 data-dio="inflate">Bubble pop</h1>',
    },
    {
      title: 'Matte clay letters',
      html: '<h2 data-dio="inflate" data-dio-style="soft">Clay studio</h2>',
    },
    {
      title: 'Gummy candy in its own color',
      html: '<h2 data-dio="inflate" data-dio-style="jelly" data-dio-color="#19b48a">Gummy bears</h2>',
    },
    {
      title: 'A button label that puffs up on hover',
      html: '<a class="button" href="/start"><span data-dio="inflate" data-dio-trigger="hover" data-dio-duration="0.7" data-dio-stagger="0.03">Get started</span></a>',
    },
    {
      title: 'From code',
      html: '<h2 class="sale">Summer sale</h2>',
      ts: "app.attach('.sale', 'inflate', { depth: 1.3, gloss: 1, tilt: 14 })",
    },
  ],
}

export default doc
