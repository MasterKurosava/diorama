import type { EffectDoc } from '@dioramajs/effects'
import type reveal from './reveal'

const doc: EffectDoc<typeof reveal> = {
  category: 'photo',
  tags: ['video', 'scroll'],
  summary:
    'The image wipes in with a soft noisy edge as it scrolls into view, or fades, opens in bands or from the center.',
  looks:
    'When enough of the image has entered the viewport, it is uncovered from one side by a soft edge with an uneven, inky rim, while the picture settles from a slight zoom. Once revealed it is the image as it is, pixel for pixel. Images that were already on screen when the page loaded stay as they are: nothing the visitor has seen disappears to play an intro. Other styles fade it in with a short drift, open it in bands one after another, or open a circle from the center.',
  target: 'img, video',
  params: {
    style: {
      description:
        'wipe uncovers it with an uneven edge; fade fades it in, drifting 40 px along the direction; blinds opens it in bands one after another; iris opens a circle from the center, for a centered subject.',
    },
    trigger: {
      description:
        'view plays when the image enters; scroll ties it to the scroll position, both ways.',
    },
    direction: {
      description:
        'Where the wipe travels: up uncovers from the bottom. The fade drifts the same way; the iris ignores it.',
    },
    duration: { description: 'Length of the reveal.', range: [0.2, 3], unit: 's' },
    delay: {
      description: 'Wait after the trigger, for a cascade across a grid.',
      range: [0, 2],
      unit: 's',
    },
    threshold: {
      description:
        'Share of the image height that must be in view, above the bottom tenth of the viewport, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
    zoom: { description: 'Scale the picture settles from; 1 or 0 for none.', range: [0, 1.5] },
    softness: {
      description:
        'Width of the soft edge as a share of the image; uneven in wipe and iris, plain in blinds.',
      range: [0, 0.5],
      unit: 'fraction',
    },
    seed: { description: 'Shape of the uneven edge.', range: [1, 100], step: 1 },
  },
  frames: 'Only while revealing, and with trigger scroll while scrolling; none at rest.',
  touch: 'The same as with a mouse: it follows the scroll.',
  reducedMotion: 'Off: the image is shown as it is, and the engine does not load for it.',
  presence:
    'Leaving a page closes the wipe again, entering opens it. A flight target lands on the revealed image.',
  quality: {},
  cost: {
    gpu: 'One texture read of the image and one of a small noise tile per pixel.',
    memory: 'The shared texture of the image and a shared 64 x 64 noise tile.',
  },
  examples: [
    { title: 'In markup', html: '<img src="/shot.avif" alt="Project shot" data-dio="reveal" />' },
    {
      title: 'A grid that cascades',
      html: '<div class="grid"><img src="/a.avif" alt="" data-dio="reveal" /><img src="/b.avif" alt="" data-dio="reveal" data-dio-delay="0.1" /><img src="/c.avif" alt="" data-dio="reveal" data-dio-delay="0.2" /></div>',
    },
    {
      title: 'Tied to scroll, from the left',
      html: '<img src="/wide.avif" alt="" data-dio="reveal" data-dio-trigger="scroll" data-dio-direction="right" />',
    },
    {
      title: 'A quiet fade for an editorial page',
      html: '<img src="/story.avif" alt="" data-dio="reveal" data-dio-style="fade" />',
    },
    {
      title: 'Bands across a wide banner',
      html: '<img src="/banner.avif" alt="" data-dio="reveal" data-dio-style="blinds" data-dio-direction="down" data-dio-softness="0.02" />',
    },
    {
      title: 'From code',
      html: '<div class="work"><img src="/a.avif" alt="" /><img src="/b.avif" alt="" /></div>',
      ts: "app.attach('.work img', 'reveal', { duration: 1.4 })",
    },
  ],
}

export default doc
