import type { EffectDoc } from '@dioramajs/effects'
import type pins from './pins'

const doc: EffectDoc<typeof pins> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'The text becomes pin art: a field of metal pins around the words with the letters pushed out in relief.',
  looks:
    'A field of thin metal pins seen through the page camera gathers around the words, their domed tips catching a studio light. The field follows the shape of the text and thins out at its edge, the last pins smaller and sunk into the page, so no plate or box shows. The pins inside the letters stand out toward the viewer, so the text rises as a crisp relief over the low pins, which sit dimmer and fainter in its shade; the raised pins cast soft shadows on the field and the page, and their shafts show at the edges in perspective. Pins are spaced in ems, so a letter is the same number of pins wide at any font size. As the heading comes into view the letters rise out of the flat field in a wave from left to right, overshooting a little, while the flat pins bob as the wave passes. The pointer presses the pins in under a soft circle, or pushes them out with press out, and they spring back with a wobble when it moves on. The bars style turns the pins into square bars, like a city skyline, and the domes style into round buttons, like a tactile display.',
  target:
    'a heading or a short label in a bold or display font, 48 px and larger. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'pins are thin metal pins; bars are square bars; domes are round plastic buttons.',
    },
    press: {
      description:
        'in presses the pins under the pointer down; out pushes them up toward the viewer.',
    },
    gap: {
      description:
        'Distance between the centers of neighboring pins in ems; it widens on long text to keep the pin count.',
      range: [0.03, 0.15],
      unit: 'em',
    },
    height: {
      description: 'How far the letters stand out of the field; 0 leaves the field flat.',
      range: [0, 80],
      unit: 'px',
    },
    radius: {
      description: 'Reach of the soft circle the pointer presses; 0 turns the pointer off.',
      range: [0, 200],
      unit: 'px',
    },
    color: {
      description: 'Color of the pins, any CSS color; currentColor takes the text color.',
    },
    duration: {
      description:
        'Time from the first pin rising to the last, the wave across the field included.',
      range: [0, 4],
      unit: 's',
    },
    seed: {
      description: 'Picks the small differences between pins and their timing.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'Full rate while the letters rise and while pressed pins move and spring back; none at rest, under a still pointer or with the pointer away. The relief stays drawn at rest.',
  touch:
    'A finger pressing the field presses the pins under it and drags the soft circle along; they spring back when it lifts. Nothing follows a hover.',
  reducedMotion:
    'The letters stand in relief from the start and stay still: no rising wave, no pressing, and no frames of their own.',
  presence: 'Leaving a page the pins sink back into the field and fade; entering, they rise again.',
  quality: {
    low: 'At most 4,000 pins instead of 16,000, so the gap widens on long text, and fewer samples for the shadows.',
    medium: 'At most 8,800 pins.',
  },
  cost: {
    gpu: 'Two draws: one instanced mesh of lit pins, about 200 triangles each (18 for bars), with up to 18 reads of a small height texture per pixel for the shadows and the shade between pins, and one quad for the shadow on the page.',
    memory:
      'A canvas of the text at its CSS size and its distance field, read once on the CPU, and a half-float texture of one texel per pin, rewritten only while pins move.',
  },
  examples: [
    {
      title: 'A heading in pin art',
      html: '<h1 data-dio="pins">Press here</h1>',
    },
    {
      title: 'Square bars, like a city skyline',
      html: '<h2 data-dio="pins" data-dio-style="bars" data-dio-height="48">Skyline</h2>',
    },
    {
      title: 'Round buttons that rise under the pointer',
      html: '<h2 data-dio="pins" data-dio-style="domes" data-dio-press="out" data-dio-gap="0.1">Touch</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="relief">Made by hand</h2>',
      ts: "app.attach('.relief', 'pins', { height: 40, radius: 90, color: '#c0c4cc' })",
    },
  ],
}

export default doc
