import type { EffectDoc } from '@dioramajs/effects'
import type lightbox from './lightbox'

const doc: EffectDoc<typeof lightbox> = {
  category: 'gallery',
  tags: ['photo'],
  summary: 'A click opens an image full screen: its copy flies out of the grid, pages and zooms.',
  looks:
    'A click lifts the image out of the grid towards the viewer and carries it to the center of the screen while its crop opens to the full picture, the rest of the grid sinks back and the backdrop darkens; the large file crossfades in after the flight. Inside, arrows, buttons and swipes page, and a double click, the wheel or a pinch zoom. Escape, the close button, a click on the backdrop, a swipe down or scrolling the page brings it back to its place the same way.',
  target: 'a container of linked images, or one img',
  params: {
    index: {
      description:
        'Open picture from 0, -1 when closed; the effect writes it, the site can open one.',
      range: [-1, 20],
      step: 1,
    },
    items: { description: 'Selector of the images that open; ignored on a single img.' },
    motion: {
      description:
        'How the picture opens and closes: lift arcs it towards the viewer, tipped back and leaning into the move, while the grid sinks back; fly carries it flat; zoom grows it straight to the center while the grid sinks back; flip turns it over like a card on the way; fade dissolves it in place without a flight.',
    },
    margin: {
      description: 'Space around the open picture, and at least the band a shown caption takes.',
      range: [0, 120],
      unit: 'px',
    },
    zoom: {
      description:
        'Zoom limit over the fitted picture, never below 1:1 of the source; 0 turns zoom off, so the wheel, a pinch, a double click and the + - 0 keys do nothing.',
      range: [0, 8],
    },
    duration: { description: 'Length of the flight in and out.', range: [0.1, 1.5], unit: 's' },
    backdrop: { description: 'Color of the backdrop.' },
    dim: {
      description:
        'Opacity of the backdrop, blended like CSS: copies on the canvas dim like the page.',
      range: [0, 1],
      unit: 'fraction',
    },
    loop: { description: 'Paging wraps around from the last picture to the first.' },
    swipe: { description: 'Swipes page through pictures, and a swipe down closes.' },
    close: {
      description:
        'What closes the viewer, names split by spaces: esc the Escape key, backdrop a click or tap beside the picture, swipe a swipe down, scroll scrolling the page once the picture has landed, button the close button; all for every one. Escape always closes, as a modal dialog must, so an empty list leaves only Escape.',
    },
    controls: {
      description:
        'Parts of the viewer shown, names split by spaces: arrows the previous and next buttons, counter such as 3 / 12, caption, close the close button; all for every one, empty for none. The keys still page, and the screen reader still hears the caption and the counter.',
    },
    labels: { description: 'Labels of the buttons, the counter and the dialog, split by |.' },
    resolution: {
      description: 'Cap on the long side when decoding the large picture.',
      range: [512, 8192],
      unit: 'px',
    },
  },
  frames:
    'Only during flights, paging, zoom easing and inertia; none while open and still, none when closed.',
  touch:
    'Inside the viewer: pinch, double tap, drag, swipe to page and swipe down to close. On the page a tap follows the link as usual.',
  reducedMotion:
    'No flight whatever motion says: opening, closing and paging fade in 0.15 s, and zoom does not animate.',
  presence: 'Fades with the page; leaving the page closes the viewer at once.',
  quality: {
    low: 'Decodes at most 2048 px on the long side.',
    medium: 'Decodes at most 3072 px on the long side.',
  },
  cost: {
    gpu: 'The copies of the previews, a backdrop and one high-resolution plane.',
    memory:
      'Every preview of the container as a texture plus up to three large pictures; keep containers to about 60 previews.',
  },
  examples: [
    {
      title: 'A grid of linked previews',
      html: '<ul class="rooms" data-dio="lightbox"><li><a href="/img/suite-2400.avif"><img src="/img/suite-600.avif" alt="Garden suite" /></a></li><li><figure><a href="/img/veranda-2400.avif"><img src="/img/veranda-600.avif" alt="Veranda" /></a><figcaption>Breakfast on the veranda</figcaption></figure></li></ul>',
    },
    {
      title: 'One image with zoom on hover and the viewer on click',
      html: '<a href="/img/map-6000.webp"><img src="/img/map-1200.webp" alt="The neighborhood in 1905" data-dio="zoom lightbox" data-dio-mode="lens" /></a>',
    },
  ],
  events: [
    {
      name: 'dio:open',
      description: 'The viewer opened a picture; index is its place among the items.',
      detail: '{ index: number }',
    },
    {
      name: 'dio:index',
      description: 'The viewer paged to another picture.',
      detail: '{ index: number }',
    },
    {
      name: 'dio:close',
      description: 'The viewer closed; index is the picture it closed on.',
      detail: '{ index: number }',
    },
  ],
  children: [
    {
      attribute: 'data-dio-full',
      description:
        'URL of an item’s large picture; without it, the linked image, the largest srcset candidate or currentSrc.',
    },
  ],
  parts: [
    { name: 'close', description: 'Close button.' },
    { name: 'prev', description: 'Previous picture button.' },
    { name: 'next', description: 'Next picture button.' },
    { name: 'counter', description: 'Counter such as 3 / 12.' },
    { name: 'caption', description: 'Caption from the item’s figcaption or alt text.' },
  ],
}

export default doc
