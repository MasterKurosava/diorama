import type { EffectDoc } from '@dioramajs/effects'
import type horizontal from './horizontal'

const doc: EffectDoc<typeof horizontal> = {
  category: 'scroll',
  tags: ['gallery'],
  summary:
    'A row of cards on a pinned stage slides sideways as the page scrolls down, its pictures bending with the speed.',
  looks:
    'While the section is pinned, scrolling down moves the row of cards to the left, one pixel sideways per pixel of scroll. The pictures bow like paper dragged through air, shear or ride a wave across the screen, stretch a little with the speed and settle when the scroll stops; inside each card the picture drifts slower than its frame. The row is a real horizontal scroller, so links, focus, arrow keys and swipes move it too, and the page follows.',
  target:
    'a row with overflow-x: auto (cards with images inside) on a sticky stage inside its section',
  params: {
    style: {
      description:
        'bend bows each picture against the motion; skew shears it, top leading; wave sends one wave across the screen that the cards ride through.',
    },
    strength: {
      description: 'How far the pictures bend, shear or wave at full speed; 0 keeps them flat.',
      range: [0, 2],
    },
    stretch: {
      description: 'Extra width at full speed, as a share of the card; 0 for none.',
      range: [0, 0.5],
      unit: 'fraction',
    },
    parallax: {
      description:
        'How far the picture drifts inside its card as it crosses the screen, as a share of the card; 0 for none.',
      range: [0, 0.2],
      unit: 'fraction',
    },
    pace: {
      description:
        'Pixels of scroll per pixel the row travels: the effect sets the section height to fit. 0 keeps the height from your CSS.',
      range: [0, 3],
    },
    reverse: { description: 'Starts the row at its end and moves it right.' },
    ease: {
      description: 'How long the pictures take to follow the speed and flatten again.',
      range: [0, 1],
      unit: 's',
    },
    items: {
      description: 'Pictures in the row that get a bending copy.',
    },
  },
  frames:
    'Scroll draws its own frames; ease keeps drawing until the pictures are flat. None at rest.',
  touch:
    'Scrolling the page moves the row, and a sideways swipe on the row scrolls it natively while the page follows.',
  reducedMotion:
    'Off: the row stays a plain horizontal scroller in a section of its own height, and the engine does not load for it.',
  presence: 'The copies of the pictures fade with the page transition; the row itself is the DOM.',
  quality: {},
  cost: {
    gpu: 'One texture read per pixel of each picture, on a plane of 24 rows for bend and wave.',
    memory: 'The textures of the pictures in the row.',
  },
  children: [
    {
      element: 'img, video',
      description:
        'Pictures inside the row (items): each gets a copy that bends; text, links and buttons stay DOM.',
    },
  ],
  examples: [
    {
      title: 'Selected work, sideways',
      html: '<section><div style="position: sticky; top: 0; height: 100vh; display: grid; align-content: center"><ul style="display: flex; gap: 24px; overflow-x: auto; padding: 40px 6vw; margin: 0; list-style: none" data-dio="horizontal"><li><a href="/work/coast"><img src="/img/coast.avif" alt="Outer coast" style="width: 32vw; aspect-ratio: 3 / 4; object-fit: cover" /></a></li><li><a href="/work/ice"><img src="/img/ice.avif" alt="Sea ice" style="width: 32vw; aspect-ratio: 3 / 4; object-fit: cover" /></a></li></ul></div></section>',
    },
    {
      title: 'Shear instead of bend',
      html: '<ul class="row" data-dio="horizontal" data-dio-style="skew" data-dio-stretch="0"></ul>',
    },
    {
      title: 'A wave through a slower row',
      html: '<ul class="row" data-dio="horizontal" data-dio-style="wave" data-dio-pace="1.5"></ul>',
    },
  ],
}

export default doc
