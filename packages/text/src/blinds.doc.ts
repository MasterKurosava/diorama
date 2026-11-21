import type { EffectDoc } from '@dioramajs/effects'
import type blinds from './blinds'

const doc: EffectDoc<typeof blinds> = {
  category: 'text',
  tags: ['3d', 'scroll'],
  summary:
    'A heading printed across real 3D slats that turn over in a wave, lit and casting shadows, to show it.',
  looks:
    'The heading starts behind a closed panel of slats in a solid color, like a shutter or a flip sign. The slats turn over one after another, each a thin board in perspective whose painted back and edges catch the light, casting thin shadows on its neighbors and on the page, until the text lies flat and readable. Horizontal slats turn like venetian blinds, vertical ones like a shop shutter, and square tiles flip in a diagonal ripple like a stadium card display. The pointer nudges the slats near it, and the nudge runs on through the others before they settle. A second text can be printed on the backs, so the turn switches between two messages.',
  target:
    'a heading or short text in a large font, on a solid page background. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'horizontal turns strips like blinds; vertical turns upright slats; tiles flips cards.',
    },
    trigger: {
      description:
        'view opens it once in view; scroll opens with the scroll; hover opens near the pointer.',
    },
    slats: {
      description:
        'Slats per line of text, top to bottom; vertical slats and tiles get a like size.',
      range: [2, 16],
      step: 1,
    },
    gap: {
      description: 'Space between neighboring slats while they turn; 0 closes them edge to edge.',
      range: [0, 8],
      unit: 'px',
    },
    duration: { description: 'Time one slat takes to turn over.', range: [0.2, 2.5], unit: 's' },
    stagger: {
      description: 'Time between one slat starting to turn and the next, shortened on long waves.',
      range: [0, 0.3],
      unit: 's',
    },
    delay: {
      description: 'Wait before the first slat turns, with trigger view.',
      range: [0, 2],
      unit: 's',
    },
    threshold: {
      description: 'Share of the heading in view before it opens, with trigger view or scroll.',
      range: [0, 1],
    },
    angle: {
      description:
        'Turn of the slats at rest with trigger hover: 180 closed on their back, 90 edge-on, 0 open.',
      range: [0, 180],
      unit: 'deg',
    },
    light: {
      description: 'Where the light comes from as a CSS angle, 0 above and 90 right.',
      range: [0, 360],
      unit: 'deg',
    },
    back: {
      description: "Color of the slats' backs and edges; currentColor uses the text color.",
    },
    reverse: {
      description:
        'Text printed on the backs, a second message on the closed panel; empty leaves them plain.',
    },
  },
  frames:
    'Only while slats turn or settle after the pointer: with trigger view while the wave runs, with scroll while scrolling, with hover while slats follow the pointer; none at rest.',
  touch:
    'View and scroll work the same; a moving finger nudges the slats. With trigger hover a tap opens every slat in a ripple from the finger, and the next tap closes them.',
  reducedMotion: 'Off: the text is shown as it is, and the engine does not load for it.',
  presence:
    'Leaving a page the slats close again in reverse and fade; entering one, they open as the page comes in.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'One instanced draw of a box per slat, up to 2048, and a shadow quad over the panel that tests up to nine slats per pixel; nothing at rest.',
    memory:
      'The text raster at twice its CSS size, the second text if any, and a small table of slat angles.',
  },
  examples: [
    {
      title: 'A hero headline behind a closed shutter',
      html: '<h1 data-dio="blinds">Quiet rooms, loud ideas.</h1>',
    },
    {
      title: 'A flip sign for a shop page: hover to turn it from Closed to Open',
      html: '<h2 class="sign" data-dio="blinds" data-dio-trigger="hover" data-dio-angle="180" data-dio-back="#d23c26" data-dio-reverse="Closed">Open</h2>',
    },
    {
      title: 'A card display wave scrubbed by the scroll',
      html: '<h2 data-dio="blinds" data-dio-style="tiles" data-dio-trigger="scroll" data-dio-back="#1d3fb8">Made by hand.</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="launch">Opening night</h2>',
      ts: "app.attach('.launch', 'blinds', { style: 'vertical', back: '#ffcf3a', stagger: 0.05 })",
    },
  ],
}

export default doc
