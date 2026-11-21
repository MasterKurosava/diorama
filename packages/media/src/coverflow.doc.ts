import type { EffectDoc } from '@dioramajs/effects'
import type coverflow from './coverflow'

const doc: EffectDoc<typeof coverflow> = {
  category: 'gallery',
  tags: ['3d'],
  summary:
    'A row of covers as the classic cover flow: the middle one faces you, its neighbours turn away in perspective.',
  looks:
    'The cover in the middle faces the viewer at the size of its image; the covers beside it turn towards it and step back, darker the farther they are, with an optional reflection on the floor. A drag, a sideways wheel or trackpad swipe, the arrow keys or a click on a side cover glide the next one to the middle; a click on the middle cover follows its link. The list stays in the page as written, a row of links that scrolls sideways without WebGL.',
  target: 'a list of linked images, such as albums, books, products or case studies',
  params: {
    index: {
      description:
        'Cover in the middle from 0; a fraction holds the row between two covers, for a tween.',
      range: [0, 10],
      step: 1,
    },
    style: {
      description:
        'classic turns the side covers towards the middle; arc lays the row on a wheel turning about a point below it; cards stacks them behind the middle one, smaller and slightly turned.',
    },
    angle: {
      description: 'Turn of the side covers in classic, and of the cards behind; 0 lays them flat.',
      range: [0, 80],
      unit: 'deg',
    },
    spacing: {
      description: 'Gap between side covers, in widths of a cover.',
      range: [0.05, 1],
    },
    depth: {
      description: 'How far the side covers step back, in widths of a cover; 0 keeps them level.',
      range: [0, 2],
    },
    shade: { description: 'Darkening of the side covers, 0 for none.', range: [0, 1] },
    reflection: {
      description: 'Opacity of the covers mirrored on the floor below them, 0 for none.',
      range: [0, 1],
    },
    perspective: {
      description: 'Distance of the eye from the row, like CSS perspective; lower is stronger.',
      range: [300, 3000],
      unit: 'px',
    },
    duration: { description: 'Length of a move by one cover.', range: [0.15, 2], unit: 's' },
    loop: { description: 'Goes round: after the last cover comes the first.' },
    drag: { description: 'A drag or a swipe carries the row.' },
    wheel: { description: 'A sideways wheel or trackpad swipe moves the row.' },
    click: { description: 'A click on a side cover brings it to the middle.' },
    items: { description: 'Selector of the images inside the list.' },
  },
  frames: 'Only while the row moves; none at rest.',
  touch:
    'A swipe moves the row. With touch-action: pan-y on the list the row follows the finger; without it the browser scrolls the list sideways and the row follows that scroll. A tap on a side cover brings it to the middle, on the middle one follows its link.',
  reducedMotion:
    'Covers change at once: no glide, and a drag lands on its cover without coasting. Keys, clicks and swipes still move the row.',
  presence: 'Fades with the page transition.',
  quality: { low: 'No reflection.' },
  cost: {
    gpu: 'A quad per cover in reach, up to fifteen, one texture read per pixel; the reflection doubles the pixels of each cover.',
    memory: 'The pictures of the covers in reach and one more on each side.',
  },
  examples: [
    {
      title: 'Albums as a cover flow with a reflection',
      html: '<ul class="albums" data-dio="coverflow" data-dio-reflection="0.3" aria-label="Albums" style="touch-action: pan-y"><li><a href="/albums/tides"><img src="/covers/tides.avif" alt="Tides" /></a></li><li><a href="/albums/salt"><img src="/covers/salt.avif" alt="Salt" /></a></li><li><a href="/albums/north"><img src="/covers/north.avif" alt="North" /></a></li></ul>',
    },
    {
      title: 'Case studies stacked as cards, with the title of the one in the middle',
      html: '<ul class="work" data-dio="coverflow" data-dio-style="cards" data-dio-loop="true" aria-label="Case studies"><li><a href="/work/harbour"><img src="/work/harbour.avif" alt="Harbour: a new identity for a ferry line" /></a></li><li><a href="/work/orchard"><img src="/work/orchard.avif" alt="Orchard: packaging for a cider house" /></a></li></ul><p class="title" aria-live="polite">Harbour</p>',
      ts: [
        "const work = document.querySelector('.work')",
        "const names = [...work.querySelectorAll('img')].map((img) => img.alt.split(':')[0])",
        "work.addEventListener('dio:index', (e) => {",
        "  document.querySelector('.title').textContent = names[e.detail.index]",
        '})',
      ].join('\n'),
    },
  ],
  events: [
    {
      name: 'dio:index',
      description:
        'A cover reached the middle after a move; index is its place among the images, from 0. Bubbles.',
      detail: '{ index: number }',
    },
    {
      name: 'dio:open',
      description:
        'The middle cover was clicked and its image is in no link or button; index is its place. Bubbles.',
      detail: '{ index: number }',
    },
  ],
}

export default doc
