import type { EffectDoc } from '@dioramajs/effects'
import type stack from './stack'

const doc: EffectDoc<typeof stack> = {
  category: 'gallery',
  tags: ['photo'],
  summary:
    'The images of a container become a pile of cards; a swipe, a click or a key throws the top one off.',
  looks:
    'The top card covers the box, framed like its image, and the next cards lie under it with a soft shadow: scattered at small angles, fanned about a point under the box, or stepped back and smaller. The top card follows a drag and tilts with it; let go far or fast enough, it flies off the way it was thrown while the pile moves up a place, otherwise it springs back. A click flicks it away from the side that was clicked, and with tabindex on the container the arrows bring the next or the previous card. The images stay in the page in order with their alt text; without WebGL the container is the layout you wrote.',
  target: 'a container of images the size of one card',
  params: {
    index: {
      description: 'Card on top from 0; a fraction holds the top card that far in flight.',
      range: [0, 10],
      step: 1,
    },
    style: {
      description:
        'pile scatters the cards; fan opens them to both sides; cascade steps each one back.',
    },
    rotate: {
      description: 'Largest angle of a card under the top one; pile and fan only.',
      range: [0, 30],
      unit: 'deg',
    },
    offset: {
      description: 'Scatter of the pile, step of the cascade, depth of the fan, in px.',
      range: [0, 60],
      unit: 'px',
    },
    duration: { description: 'Length of a throw by click or key.', range: [0.2, 2], unit: 's' },
    shadow: { description: 'Darkness of the shadow under each card, 0 for none.', range: [0, 1] },
    loop: {
      description: 'A thrown card goes under the pile; off, the last card stays on top.',
    },
    swipe: { description: 'Dragging or swiping the top card throws it.' },
    click: { description: 'A click on the pile throws the top card.' },
    items: { description: 'Selector of the images inside the container.' },
    seed: { description: 'Arrangement of the scattered pile.', range: [1, 100], step: 1 },
  },
  frames: 'Only while a card is in flight or held; none at rest.',
  touch:
    'A tap throws the top card. Dragging it needs touch-action: pan-y or none on the container, so the page keeps its own gestures otherwise.',
  reducedMotion:
    'Cards change at once: no flight and no card following the finger, while a swipe, a click or a key still brings the next one.',
  presence: 'Fades with the page transition.',
  quality: {},
  cost: {
    gpu: 'Up to five card quads with a picture and a shadow each, one texture read per pixel.',
    memory:
      'Up to six pictures at a time: the top card, the pile under it and the card thrown last.',
  },
  examples: [
    {
      title: 'Picks of the week as a pile',
      html: '<section class="picks" data-dio="stack" tabindex="0" aria-label="Picks of the week. Use the arrow keys or swipe to see the next." style="touch-action: pan-y"><img src="/picks/1.avif" alt="Linen shirt" /><img src="/picks/2.avif" alt="Canvas tote" /><img src="/picks/3.avif" alt="Field watch" /></section>',
    },
    {
      title: 'A fanned deck that stops at the last card, with a counter',
      html: '<section class="deck" data-dio="stack" data-dio-style="fan" data-dio-loop="false" tabindex="0" aria-label="Destinations"><img src="/trip/1.avif" alt="Lisbon" /><img src="/trip/2.avif" alt="Porto" /></section><p class="count" aria-live="polite">Lisbon</p>',
      ts: [
        "const deck = document.querySelector('.deck')",
        "const names = [...deck.querySelectorAll('img')].map((img) => img.alt)",
        "deck.addEventListener('dio:index', (e) => {",
        "  document.querySelector('.count').textContent = names[e.detail.index]",
        '})',
      ].join('\n'),
    },
  ],
  events: [
    {
      name: 'dio:index',
      description:
        'A card is on top, after a throw or a change of index; index is its place among the images, from 0. Bubbles.',
      detail: '{ index: number }',
    },
  ],
}

export default doc
