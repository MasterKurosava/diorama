import type { EffectDoc } from '@dioramajs/effects'
import type unfold from './unfold'

const doc: EffectDoc<typeof unfold> = {
  category: 'text',
  tags: ['3d', 'scroll'],
  summary:
    'A headline unfolds out of the page like paper: strips, a zig-zag band, letter cards or folded squares open in 3D.',
  looks:
    'The text block is cut into pieces of paper hinged to each other. Before it opens you see the folded packet: off-white paper backs with a faint fiber, the letters showing through a little. As it comes into view the pieces swing open one after another in perspective, standing out of the page on the way: the side turned to the light brightens, folds darken toward the crease, and the raised paper casts a soft shadow on the page. Strips roll down line by line like a letter out of an envelope, an accordion stretches open sideways, each letter of cards stands up like a little card on its bottom edge, and origami opens squares folded corner to center. Once everything lies flat the heading is plain text again.',
  target:
    'a heading or short text block in a large font. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'strips rolls down; accordion stretches; cards stands letters up; origami opens squares.',
    },
    trigger: {
      description:
        'view opens it once in view; scroll scrubs with the page; hover folds a little under the pointer.',
    },
    bands: {
      description:
        'Strips, pleats or rows of squares; auto cuts one per line, or a pleat per two ems.',
      range: [1, 24],
      step: 1,
    },
    angle: {
      description: 'How far each piece is folded before it opens; 180 lies folded flat.',
      range: [30, 180],
      unit: 'deg',
    },
    duration: { description: 'Time one piece takes to open.', range: [0.3, 2.5], unit: 's' },
    stagger: {
      description: 'Time between neighboring pieces, shortened so all start within 1.4 durations.',
      range: [0, 1],
      unit: 's',
    },
    paper: { description: 'Color of the backs of the pieces, the paper seen while folded.' },
    shade: {
      description: 'Strength of the shading on the faces and at the folds; 0 keeps flat colors.',
      range: [0, 1],
    },
    delay: {
      description: 'Wait between the trigger and the first fold.',
      range: [0, 2],
      unit: 's',
    },
    threshold: {
      description:
        'Share of the heading in view that opens it with the view trigger, or starts the scrub.',
      range: [0, 1],
    },
  },
  frames:
    'While the paper opens, and with the scroll trigger while scrolling through it; with the hover trigger while the pointer moves over it and the folds settle; none at rest.',
  touch: 'With trigger hover a tap folds the pieces under the finger for a moment.',
  reducedMotion: 'Off: the heading stays flat text.',
  presence:
    'Leaving a page folds the paper back up, entering one unfolds it; at rest it leaves as text.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'Three instanced draws of a quad per piece (lying flat, raised, and their shadows) while the paper moves; nothing at rest.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels and a 256 px tile of paper fiber.',
  },
  examples: [
    {
      title: 'A hero headline that unrolls line by line',
      html: '<h1 class="hero" data-dio="unfold">Letters from the coast, folded by hand</h1>',
    },
    {
      title: 'A sale banner that stretches open like an accordion',
      html: '<h2 data-dio="unfold" data-dio-style="accordion">Summer sale</h2>',
    },
    {
      title: 'Pop-up letter cards for an event title',
      html: '<h2 data-dio="unfold" data-dio-style="cards" data-dio-paper="#fff4d6">Paper Week</h2>',
    },
    {
      title: 'Origami squares opened by the scroll',
      html: '<h2 data-dio="unfold" data-dio-style="origami" data-dio-trigger="scroll">Studio Kami</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Made to order</h2>',
      ts: "app.attach('.title', 'unfold', { style: 'strips', bands: 4, duration: 1.2 })",
    },
  ],
}

export default doc
