import type { EffectDoc } from '@dioramajs/effects'
import type keycaps from './keycaps'

const doc: EffectDoc<typeof keycaps> = {
  category: 'text',
  tags: ['3d', 'block'],
  summary:
    'Each letter sits on a 3D mechanical keycap that presses down as if the word were typed, with a click under the pointer.',
  looks:
    'The heading becomes a row of real 3D keycaps on a darker keyboard case, seen at an angle in the page perspective. Each cap is rounded, slightly dished and tapered, lit like plastic with a soft sheen, and the letter is printed on its top in the text color; a space becomes a wide space bar. When the heading comes into view the keys go down one after another as if someone typed the word: a quick press, a small bounce back and a flash of light on each. Keys under the pointer sink a little and a click sends one down hard. Modern sculpted caps with an accent key, beige retro caps, or dark caps with an RGB glow under them.',
  target:
    'a short heading, a word mark or a button label. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'keycap draws modern sculpted caps in neutral colors with an accent key; retro thick beige caps, a little yellowed; glow dark caps with RGB light under them.',
    },
    trigger: {
      description:
        'view types the word once in view; hover types it when the pointer comes over the keys; loop types it again every few seconds.',
    },
    depth: {
      description: 'Key travel as a share of the key size; 0 keeps the keys still.',
      range: [0, 0.5],
    },
    gap: {
      description: 'Space between neighboring keys as a share of the key size.',
      range: [0, 0.3],
    },
    radius: {
      description: 'Rounding of the cap corners as a share of the key; 0 is square, 0.5 round.',
      range: [0, 0.5],
    },
    color: {
      description: 'Cap color; empty picks the style color that contrasts with the text.',
    },
    accent: {
      description: 'Color of the first key; empty uses the style accent, none matches the others.',
    },
    speed: {
      description: 'Typing speed in keys per second.',
      range: [2, 20],
    },
    sound: {
      description:
        'Plays a short synthesized click per key press, only after the visitor touched the page.',
    },
  },
  frames: 'Only while keys move or flash; none at rest, when the keyboard stays drawn.',
  touch: 'A tap presses the key under the finger hard; the hover trigger types the word on a tap.',
  reducedMotion: 'The keys are drawn but never press, flash or type.',
  presence: 'Fades with the page.',
  quality: {
    low: 'The legends are rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'Three instanced draws: a shell of about 600 triangles per cap, switch and the case, and a soft quad per key for its shadow and its light.',
    memory: 'An atlas of the letters at twice their CSS size, kept while the element lives.',
  },
  examples: [
    {
      title: 'A headline typed on view',
      html: '<h1 data-dio="keycaps">Type it</h1>',
    },
    {
      title: 'A gaming launch with RGB caps that type again and again',
      html: '<h2 data-dio="keycaps" data-dio-style="glow" data-dio-trigger="loop">Press start</h2>',
    },
    {
      title: 'A retro word mark on a dark card',
      html: '<p class="mark" style="background: #3a362f; padding: 0.3em" data-dio="keycaps" data-dio-style="retro">1984</p>',
    },
    {
      title: 'A shortcut hint that clicks',
      html: '<p data-dio="keycaps" data-dio-trigger="hover" data-dio-sound="true">Ctrl K</p>',
    },
  ],
}

export default doc
