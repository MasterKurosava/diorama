import type { EffectDoc } from '@dioramajs/effects'
import type polaroids from './polaroids'

const doc: EffectDoc<typeof polaroids> = {
  category: 'gallery',
  tags: ['photo'],
  summary:
    'Photos scattered like prints on a table: drag one to the top, click it to hold it up large.',
  looks:
    'Each image becomes a print with a white border and a wider bottom edge, lying at a small angle with a soft shadow: scattered over the box, over the places the page gives the images, or in a loose pile. A drag lifts a print, carries it on top of the others and puts it down where it is let go. A click brings a print to the top; a click on the top one holds it up in the middle, straight and larger, while the others dim, and a click anywhere or Escape puts it back. A print whose image is a link follows it instead.',
  target: 'a container of images: a trip, an event, a studio',
  params: {
    index: { description: 'Print on top, from 0.', range: [0, 10], step: 1 },
    open: {
      description: 'Print held up in the middle, from 0; -1 for none.',
      range: [-1, 10],
      step: 1,
    },
    style: {
      description:
        'scatter spreads the prints over the box; grid lays each over its image as the page places it, like a pinboard; pile heaps them near the middle.',
    },
    rotate: {
      description: 'Largest angle of a print; 0 lays them straight.',
      range: [0, 30],
      unit: 'deg',
    },
    spread: {
      description: 'How far the prints stray from their places, 0 for none.',
      range: [0, 1],
    },
    border: {
      description:
        'Width of the paper border; the bottom one is 3.4 times wider. 0 for bare photos with the images’ own corners.',
      range: [0, 40],
      unit: 'px',
    },
    paper: { description: 'Color of the paper border.' },
    shadow: { description: 'Darkness of the shadow under each print, 0 for none.', range: [0, 1] },
    zoom: {
      description:
        'Largest size of a print held up, in its own sizes, never past nine tenths of the box; 0 never holds one up.',
      range: [0, 4],
    },
    duration: { description: 'Length of a print’s move.', range: [0.1, 2], unit: 's' },
    drag: { description: 'A drag carries a print.' },
    seed: {
      description: 'Arrangement of the table; a new value lays it out again.',
      range: [1, 100],
      step: 1,
    },
    items: { description: 'Selector of the images inside the container.' },
  },
  frames: 'Only while a print moves, is carried or is held up; none at rest.',
  touch:
    'A tap brings a print to the top or holds it up. Carrying one needs touch-action: none on the container, so the page keeps scrolling otherwise.',
  reducedMotion:
    'Prints move at once: no easing when one is raised, held up or put back. Carrying a print still follows the pointer.',
  presence: 'Fades with the page transition.',
  quality: {},
  cost: {
    gpu: 'A quad per print, up to 40, with a shadow, one texture read per pixel.',
    memory: 'Every picture on the table.',
  },
  examples: [
    {
      title: 'A trip on the table',
      html: '<section class="trip" data-dio="polaroids" tabindex="0" aria-label="Photos from the coast. Arrow keys bring the next one to the top, Enter holds it up."><img src="/trip/1.avif" alt="The headland" /><img src="/trip/2.avif" alt="The islets" /><img src="/trip/3.avif" alt="The shore" /></section>',
    },
    {
      title: 'A pinboard of linked projects with a shuffle button',
      html: '<ul class="board" data-dio="polaroids" data-dio-style="grid" data-dio-rotate="4"><li><a href="/work/kiln"><img src="/work/kiln.avif" alt="Kiln" /></a></li><li><a href="/work/loom"><img src="/work/loom.avif" alt="Loom" /></a></li></ul><button type="button" class="shuffle">Shuffle</button>',
      ts: [
        "const board = document.querySelector('.board')",
        "document.querySelector('.shuffle').addEventListener('click', () => {",
        "  const prints = app.effects.get(board, 'polaroids')",
        '  prints?.set({ seed: prints.params.seed + 1 })',
        '})',
      ].join('\n'),
    },
  ],
  events: [
    {
      name: 'dio:index',
      description: 'A print came on top; index is its place among the images, from 0. Bubbles.',
      detail: '{ index: number }',
    },
    {
      name: 'dio:open',
      description: 'A print was held up, or put back with index -1. Bubbles.',
      detail: '{ index: number }',
    },
  ],
}

export default doc
