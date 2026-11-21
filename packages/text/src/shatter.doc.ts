import type { EffectDoc } from '@dioramajs/effects'
import type shatter from './shatter'

const doc: EffectDoc<typeof shatter> = {
  category: 'text',
  tags: ['3d', 'scroll'],
  summary:
    'A heading breaks into lit 3D shards that fly apart and tumble, then fly back together: on a click, on scroll, under the pointer or once in view.',
  looks:
    'The text box cracks into pieces along seeded fracture lines that follow the letters, and each piece is a real slab with the heading printed on its face. On a click the cracks run out from the point of impact in rings, the pieces nearest it burst out first, and every piece flies off with its own spin, seen through the page camera so the ones coming toward the viewer grow. When the text comes back (hold above 0) the pieces slow down and hang in the air close to the heading, so the break stays in its box; with hold 0 they arc over and fall away under gravity. Turning pieces catch the light: faces brighten and darken, the cut edges glint, the walls show their thickness, and lifted pieces cast soft shadows on the page. Glass breaks into thin clear panes with green edges and reflections, stone into thick chunks with rough walls and a puff of dust, paper into torn scraps with pale fibers that flutter down and show their blank backs. After a pause the pieces fly back along their own paths and lock into place.',
  target:
    'a large heading or short line of display text. Not img, video, canvas, svg or form fields. Text with text-shadow, a text stroke, background-clip: text or vertical writing stays as it is',
  params: {
    style: {
      description:
        'glass is thin clear panes; stone is thick rough chunks with dust; paper is torn scraps.',
    },
    trigger: {
      description:
        'click breaks where clicked; scroll as it leaves; hover lifts pieces; view flies it in.',
    },
    pieces: {
      description:
        'About how many pieces the text box is cut into; pieces with no ink are left out.',
      range: [6, 140],
      step: 1,
    },
    strength: {
      description: 'Speed the pieces leave with, and how high they lift with the hover trigger.',
      range: [0, 3],
    },
    spin: {
      description: 'How fast the pieces tumble; 0 keeps them flat to the page as they fly.',
      range: [0, 3],
    },
    gravity: {
      description:
        'Pull that bends the paths down; 0 lets the pieces drift off in a straight line.',
      range: [0, 3],
    },
    depth: {
      description: 'Thickness of a piece, times the thickness of its style; 0 makes flat pieces.',
      range: [0, 3],
    },
    hold: {
      description:
        'Time the click trigger waits before the pieces fly back; 0 leaves the text gone.',
      range: [0, 10],
      unit: 's',
    },
    seed: {
      description: 'Picks the fracture lines, paths and spins; the same seed breaks the same way.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'While the pieces fly, fly back or settle, and while scrolling through the break with the scroll trigger; none at rest.',
  touch:
    'A tap breaks it with the click trigger; with the hover trigger a finger on the text lifts the pieces under it.',
  reducedMotion:
    'The click trigger fades the text out instead, and back in after hold; the other triggers keep the text as it is.',
  presence: 'The pieces fade with the page.',
  quality: {
    low: 'At most 24 pieces, a shorter march through stone, no dust, and the text rastered at 1 device pixel per CSS pixel instead of 2.',
    medium: 'At most 64 pieces and a shorter march through stone.',
  },
  cost: {
    gpu: 'One draw of every piece as a prism of a few dozen triangles, back to front, with a short march through stone; one draw of their shadows and one of up to 420 dust motes.',
    memory:
      'A canvas of the text at twice its CSS size and two small float textures of the pieces: a few MB for a large heading.',
  },
  events: [
    {
      name: 'dio:shatter',
      description:
        'The click trigger with hold 0 has broken the text for good; the element keeps its space, so remove or collapse it here.',
      detail: 'null',
    },
  ],
  children: [
    {
      attribute: 'data-dio-shatter',
      description:
        'Set by the click trigger on its element: broken while the pieces fly, gone once the text is gone for good.',
    },
  ],
  examples: [
    {
      title: 'A heading that breaks where it is clicked and comes back',
      html: '<h1 data-dio="shatter">Break the silence</h1>',
    },
    {
      title: 'Stone that crumbles as the heading scrolls out',
      html: '<h2 data-dio="shatter" data-dio-style="stone" data-dio-trigger="scroll">Built to last</h2>',
    },
    {
      title: 'Torn paper that assembles once in view',
      html: '<h2 data-dio="shatter" data-dio-style="paper" data-dio-trigger="view">Cut and paste</h2>',
    },
    {
      title: 'A label that cracks under the pointer',
      html: '<h2 data-dio="shatter" data-dio-trigger="hover" data-dio-strength="0.6">Fragile</h2>',
    },
    {
      title: 'A notice that breaks for good',
      html: '<p class="notice" role="button" tabindex="0" data-dio="shatter" data-dio-hold="0">Offer expired. Click to dismiss.</p>',
      ts: "document.querySelector('.notice')?.addEventListener('dio:shatter', (e) => (e.target as Element).remove())",
    },
  ],
}

export default doc
