import type { EffectDoc } from '@dioramajs/effects'
import type compare from './compare'

const doc: EffectDoc<typeof compare> = {
  category: 'photo',
  summary: 'Two pictures in one box, before and after, split by a line you drag, hover or scroll.',
  looks:
    'The first image shows up to the line and the second after it. The line has a round handle with arrows and a hard or soft edge; in lens mode a circle at the pointer shows the second image instead. The line follows a drag, the pointer, the scroll of a pinned section or the param, and wiggles once when the box first shows.',
  target: 'a container with two images and an <input type="range">',
  params: {
    position: {
      description: 'Line position as a share of the box along direction; dragging writes it.',
      range: [0, 1],
      unit: 'fraction',
    },
    by: {
      description:
        'What moves the line: drag by hand; hover follows the pointer; scroll a pinned section; manual.',
    },
    direction: { description: 'x moves a vertical line sideways; y moves a horizontal one.' },
    mode: {
      description:
        'split draws a line between the images; lens shows the second image in a circle at the pointer; fade crossfades the whole box from the second image (position 0) to the first (position 1), for then-and-now photos taken from the same spot.',
    },
    radius: { description: 'Radius of the lens.', range: [20, 400], unit: 'px' },
    softness: {
      description: 'Softness of the border between the images; not used by fade.',
      range: [0, 64],
      unit: 'px',
    },
    thickness: { description: 'Width of the line, 0 for none.', range: [0, 12], unit: 'px' },
    color: { description: 'Color of the line and the handle.' },
    handle: { description: 'Draws a round handle with arrows on the line.' },
    start: {
      description: 'Section progress where scrolling starts to move the line.',
      range: [0, 1],
      unit: 'fraction',
    },
    end: {
      description: 'Section progress where scrolling stops moving the line.',
      range: [0, 1],
      unit: 'fraction',
    },
    hint: { description: 'Wiggles the line once when the box first shows.' },
    items: { description: 'Selector of the two images inside the container.' },
  },
  frames:
    'Only while the line eases or the hint plays; none at rest, and pointer moves outside the box draw nothing.',
  touch:
    'A tap moves the line to the point. Dragging works with touch-action: pan-y (pan-x for direction y); hover acts as drag.',
  reducedMotion: 'No hint and no easing: the line follows input at once.',
  presence: 'Fades with the page transition; a keyed flight carries the current split.',
  quality: {},
  cost: {
    gpu: 'Two texture reads per pixel and a distance field for the handle.',
    memory: 'Both images as textures.',
  },
  examples: [
    {
      title: 'Then and now from the same spot, crossfaded instead of split',
      html: '<figure class="compare" data-dio="compare" data-dio-mode="fade" style="touch-action: pan-y"><img src="/harbour-1910.avif" alt="The harbour in 1910" /><img src="/harbour-today.avif" alt="The harbour today" /><input type="range" min="0" max="100" value="50" aria-label="1910 and today" /></figure>',
    },
    {
      title: 'Before and after, with a range for keyboards and screen readers',
      html: '<figure class="compare" data-dio="compare" style="touch-action: pan-y"><img src="/suite-before.avif" alt="Suite before the renovation" /><img src="/suite-after.avif" alt="Suite after the renovation" /><input type="range" min="0" max="100" value="50" aria-label="Before and after" /></figure>',
    },
    {
      title: 'The static split of the site, shown without WebGL',
      html: '<style>.compare { display: grid } .compare > img { grid-area: 1 / 1; width: 100%; height: 100%; object-fit: cover } .compare > img + img { clip-path: inset(0 0 0 50%) } .compare:not([data-dio-state]) > input { display: none }</style>',
    },
  ],
  children: [
    {
      element: 'input[type="range"]',
      description:
        'Keyboard and screen reader control of the line; dragging writes its value and fires input.',
    },
  ],
}

export default doc
