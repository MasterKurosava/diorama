import type { EffectDoc } from '@dioramajs/effects'
import type flipbook from './flipbook'

const doc: EffectDoc<typeof flipbook> = {
  category: 'gallery',
  summary: 'The page images of a container become a book whose pages bend as they turn.',
  looks:
    'Pages show as a spread of two, or one on a narrow box. Closed on its cover the book stands in the middle of the box; as the cover turns the book slides so the open spread is centered on its spine, and closed on the back cover it stands in the middle again. A turning page bends around a fold from the spine, the fold is shaded and a shadow falls on the page below. A page follows the finger or the mouse from a corner or an edge and, let go, finishes the turn or falls back; a click on a closed book opens it and a click on a half of a spread turns forward or back, and with tabindex on the container the arrows, PageUp, PageDown, Home and End turn too. The images stay in the page in order, so screen readers read them; give the text as HTML or PDF as well, pictures of pages are neither searched nor translated.',
  target: 'a container of page images',
  params: {
    index: {
      description: 'First page of the spread; a fraction holds a frame of a turn.',
      range: [0, 20],
      step: 1,
    },
    items: { description: 'Selector of the page images.' },
    mode: { description: 'auto picks two pages on wide boxes and one on narrow ones.' },
    cover: {
      description:
        'true treats the first page as a cover: the book starts closed in the middle of the box and opens to spreads centered on the spine; with an even number of pages the last is the back cover. false shows a spread from the start.',
    },
    motion: {
      description:
        'curl bends the page around a fold like paper; flat swings it stiff about the spine like a board book or a layflat album; fade crossfades the spreads over duration without a page in the air.',
    },
    duration: { description: 'Length of a turn by click or key.', range: [0.2, 2], unit: 's' },
    curl: { description: 'Tightness of the page bend; curl motion only.', range: [0, 1] },
    shade: { description: 'Darkness of the fold and the cast shadow.', range: [0, 1] },
    click: {
      description:
        'A click on a closed book opens it; on a half of a spread it turns forward or back.',
    },
    swipe: { description: 'Dragging and swiping turn pages.' },
    resolution: {
      description: 'Cap on the long side of a page when decoding.',
      range: [512, 4096],
      unit: 'px',
    },
  },
  frames: 'Only while a page moves; none at rest.',
  touch: 'A tap on a half turns the page; dragging needs touch-action: pan-y on the container.',
  reducedMotion:
    'Turns are a 0.25 s crossfade without bending, and the book moves to the middle at once.',
  presence: 'Fades with the page transition; a keyed flight carries the book.',
  quality: {
    low: 'Pages decode at 1024 px and bend on a 16 × 4 grid.',
    medium: 'Pages decode at 1280 px and bend on a 24 × 6 grid.',
  },
  cost: {
    gpu: 'Two still pages and one or two turning pages on a bend grid.',
    memory: 'Up to six pages as textures, about 9.6 MB each at 1600 px.',
  },
  examples: [
    {
      title: 'A photo album with stiff pages',
      html: '<div class="album" data-dio="flipbook" data-dio-motion="flat" data-dio-cover="false" tabindex="0" role="region" aria-label="Wedding album"><img src="/album/01.webp" alt="The ceremony" /><img src="/album/02.webp" alt="The garden" /></div>',
    },
    {
      title: 'A dinner menu with a page counter and a text version',
      html: '<div class="menu" data-dio="flipbook" tabindex="0" role="region" aria-label="Dinner menu" style="touch-action: pan-y"><img src="/menu/01.webp" alt="Dinner menu, autumn" /><img src="/menu/02.webp" alt="Starters" /><img src="/menu/03.webp" alt="Mains" /></div><p><span aria-live="polite" id="pages">Cover</span> · <a href="/menu.pdf">Menu as PDF</a></p>',
    },
  ],
  events: [
    {
      name: 'dio:index',
      description:
        'A spread is reached; index is its first page, for a counter such as "Pages 2–3 of 12".',
      detail: '{ index: number }',
    },
  ],
}

export default doc
