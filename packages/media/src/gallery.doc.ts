import type { EffectDoc } from '@dioramajs/effects'
import type gallery from './gallery'

const doc: EffectDoc<typeof gallery> = {
  category: 'gallery',
  tags: ['photo'],
  summary:
    'A container of images shows one at a time and changes them with a displacement, a slide, a crossfade or a zoom.',
  looks:
    'The container shows one of its images, framed by that image’s own object-fit and object-position. A change runs a soft noisy wave across the picture that pushes the old one out and draws the new one in, slides the new one over the old, crossfades, or fades the new one in as it settles from a zoom. A whole index changes to its picture, a fraction from a tween holds the exact point between two, and clicks, swipes and the interval timer move the index too. Without WebGL the container is the layout you wrote, every image and alt text in place; keep captions and controls outside it, since its copy covers the whole box.',
  target: 'a container of images, such as a scroll-snap strip',
  params: {
    index: {
      description:
        'Picture shown from 0, counting on past the last when it loops; a fraction holds a point between two.',
      range: [0, 10],
      step: 1,
    },
    duration: { description: 'Length of a change.', range: [0.2, 3], unit: 's' },
    style: {
      description:
        'displace pushes the pictures with a noisy wave; slide moves the new one in from the side, like a carousel; fade crossfades, for a calm page; zoom fades the new one in as it settles from a zoom, for a hero slideshow.',
    },
    strength: {
      description: 'How far the displacement pushes the pictures.',
      range: [0, 1],
    },
    interval: {
      description:
        'Time before the next picture, 0 for none; the timer pauses on hover and with focus inside.',
      range: [0, 10],
      unit: 's',
    },
    click: { description: 'A click on the container shows the next picture.' },
    swipe: {
      description:
        'A horizontal swipe changes the picture; needs touch-action: pan-y on the container.',
    },
    loop: {
      description:
        'After the last picture comes the first. Off, the ends hold: a click or swipe past them does nothing and the interval timer stops at the last.',
    },
    items: { description: 'Selector of the images inside the container.' },
    seed: { description: 'Shape of the displacement.', range: [1, 100], step: 1 },
  },
  frames:
    'Only during a change; none at rest. The interval timer draws nothing while it waits, and it pauses under the pointer, with focus inside, off screen and in a background tab.',
  touch:
    'A tap shows the next picture. A swipe works when the container has touch-action: pan-y, so the page keeps vertical scrolling; without it the gesture belongs to the page.',
  reducedMotion: 'Every change is a short crossfade, and the interval timer does not advance.',
  presence: 'Fades with the page transition; a keyed flight carries the current picture.',
  quality: {},
  cost: {
    gpu: 'Two or three texture reads per pixel, four during a displacement.',
    memory:
      'Up to three pictures at a time, the current one and its neighbors, however long the gallery is.',
  },
  examples: [
    {
      title: 'In markup, with a timer',
      html: '<div class="shots" data-dio="gallery" data-dio-interval="5" style="touch-action: pan-y"><img src="/p/1.avif" alt="Front" /><img src="/p/2.avif" alt="Side" /><img src="/p/3.avif" alt="Detail" /></div>',
    },
    {
      title: 'Buttons and a counter',
      html: '<div class="shots" data-dio="gallery"><img src="/p/1.avif" alt="Front" /><img src="/p/2.avif" alt="Side" /></div><button class="next">Next</button><output class="count">1</output>',
      ts: [
        "const shots = document.querySelector('.shots')",
        "shots.addEventListener('dio:index', (e) => {",
        "  document.querySelector('.count').value = String(e.detail.index + 1)",
        '})',
        "document.querySelector('.next').onclick = () => {",
        "  const gallery = app.effects.get(shots, 'gallery')",
        '  gallery?.set({ index: Math.round(gallery.params.index) + 1 })',
        '}',
      ].join('\n'),
    },
    {
      title: 'A product gallery that stops at its ends',
      html: '<div class="shots" data-dio="gallery" data-dio-style="slide" data-dio-loop="false" style="touch-action: pan-y"><img src="/p/1.avif" alt="Front" /><img src="/p/2.avif" alt="Side" /></div>',
    },
    {
      title: 'Scrubbed by GSAP',
      html: '<div class="shots" data-dio="gallery" data-dio-style="slide"><img src="/p/1.avif" alt="" /><img src="/p/2.avif" alt="" /></div>',
      ts: "gsap.to(app.attach('.shots', 'gallery').params, { index: 1, duration: 1.5 })",
    },
  ],
  events: [
    {
      name: 'dio:index',
      description:
        'A picture is reached, at the end of a change or when a tween stops on a whole index; index is its place among the pictures, from 0. Bubbles, for captions, dots and counters.',
      detail: '{ index: number }',
    },
  ],
}

export default doc
