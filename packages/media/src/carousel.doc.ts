import type { EffectDoc } from '@dioramajs/effects'
import type carousel from './carousel'

const doc: EffectDoc<typeof carousel> = {
  category: 'gallery',
  tags: ['3d'],
  summary:
    'Pictures on a 3D ring that turns with a drag, the keys, the page scroll or by itself, the front one enlarged.',
  looks:
    'The images stand around a ring seen a little from above, the front one larger, the ones at the back smaller and darker, with an optional reflection on the floor. A drag, a sideways wheel or the arrow keys turn the ring and it settles with a picture at the front; a click on a picture turns it to the front, a click on the front one follows its link. In inside the viewer stands at the middle of the ring and the pictures curve around like a wall. Autoplay steps or drifts round, with a pause button over the corner of the box.',
  target: 'a list of linked images: products, a team, projects',
  params: {
    index: {
      description:
        'Picture at the front from 0; a fraction holds the ring between two, for a tween.',
      range: [0, 10],
      step: 1,
    },
    style: {
      description:
        'ring shows the ring from outside, the pictures facing out; inside puts the viewer at its middle, the pictures facing in and curving away at the sides.',
    },
    by: {
      description:
        'drag turns the ring by pointer, wheel, keys, clicks and autoplay; scroll turns it once round as the list crosses the viewport, for a showcase in a long page.',
    },
    motion: {
      description:
        'How autoplay turns it: step rests on each picture for interval seconds and moves on; drift turns slowly and steadily, a picture every interval seconds.',
    },
    interval: {
      description: 'Seconds per picture of autoplay, 0 for none.',
      range: [0, 10],
      unit: 's',
    },
    radius: {
      description: 'Radius of the ring in px; auto sizes it so the pictures stand spacing apart.',
      range: [1, 2000],
      unit: 'px',
    },
    spacing: {
      description: 'Gap between pictures on the ring, in widths of a picture.',
      range: [0, 2],
    },
    tilt: {
      description: 'How far from above the ring is seen; 0 at eye level.',
      range: [-30, 30],
      unit: 'deg',
    },
    focus: {
      description: 'Size of the front picture against the others; 1 for the same.',
      range: [1, 2],
    },
    shade: { description: 'Darkening of the pictures at the back, 0 for none.', range: [0, 1] },
    reflection: {
      description: 'Opacity of the pictures mirrored on the floor, 0 for none.',
      range: [0, 1],
    },
    perspective: {
      description: 'Distance of the eye from the ring, like CSS perspective; lower is stronger.',
      range: [300, 4000],
      unit: 'px',
    },
    duration: { description: 'Length of a turn by one picture.', range: [0.15, 3], unit: 's' },
    drag: { description: 'A drag or a swipe turns the ring.' },
    wheel: { description: 'A sideways wheel or trackpad swipe turns the ring.' },
    click: { description: 'A click on a picture turns it to the front.' },
    pause: {
      description:
        'Shows the pause button while autoplay runs; off, the page must give a control of its own.',
    },
    items: { description: 'Selector of the images inside the list.' },
  },
  frames:
    'While the ring turns and the whole time drift plays; with step autoplay only during each step. None at rest.',
  touch:
    'A swipe turns the ring with touch-action: pan-y on the list; without it the browser scrolls the list and the ring follows that scroll. A tap on a picture turns it to the front, on the front one follows its link.',
  reducedMotion:
    'No autoplay and no pause button, no turning with the page scroll; changes are at once. Keys, clicks and swipes still turn the ring.',
  presence: 'Fades with the page transition.',
  quality: { low: 'No reflection.' },
  cost: {
    gpu: 'A quad per picture, up to 24, one texture read per pixel; the reflection doubles the pixels of each.',
    memory: 'Every picture on the ring.',
  },
  examples: [
    {
      title: 'Products on a ring with a reflection',
      html: '<ul class="shelf" data-dio="carousel" data-dio-reflection="0.25" aria-label="New arrivals" style="touch-action: pan-y"><li><a href="/p/kettle"><img src="/shop/kettle.avif" alt="Enamel kettle" /></a></li><li><a href="/p/mug"><img src="/shop/mug.avif" alt="Stoneware mug" /></a></li><li><a href="/p/tray"><img src="/shop/tray.avif" alt="Oak tray" /></a></li></ul>',
    },
    {
      title: 'A team that turns by itself, step by step, with the pause button',
      html: '<ul class="team" data-dio="carousel" data-dio-interval="3" data-dio-tilt="0" aria-label="The studio"><li><img src="/team/desk.avif" alt="The front desk" /></li><li><img src="/team/kiln.avif" alt="The kiln room" /></li><li><img src="/team/yard.avif" alt="The yard" /></li></ul>',
    },
  ],
  events: [
    {
      name: 'dio:index',
      description:
        'A picture reached the front after a turn; index is its place among the images, from 0. Bubbles.',
      detail: '{ index: number }',
    },
    {
      name: 'dio:open',
      description:
        'The front picture was clicked and its image is in no link or button; index is its place. Bubbles.',
      detail: '{ index: number }',
    },
  ],
  parts: [
    {
      name: 'pause',
      description:
        'The pause button of autoplay, after the list in the page; aria-pressed says whether it holds.',
    },
  ],
}

export default doc
