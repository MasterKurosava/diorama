import type { EffectDoc } from '@dioramajs/effects'
import type sparkles from './sparkles'

const doc: EffectDoc<typeof sparkles> = {
  category: 'celebration',
  tags: ['block'],
  summary:
    'Small twinkling sparkles around a badge, a "new" label, a premium button or a product highlight.',
  looks:
    'Four-point stars, soft dots or thin lens glints of scale times 30 px twinkle around the element: each grows, turns a little and fades over about duration seconds, spread up to spread px past its edges, some whiter than color. A click bursts count of them out of the pointer and they slow down as they fly. They draw over the page; the element stays DOM and keeps every click.',
  target: 'any element: a badge, a label, a button, a card, a product photo',
  params: {
    trigger: {
      description:
        'hover on hover or focus; click bursts from the pointer; loop nonstop; view once in view.',
    },
    style: {
      description:
        'star draws four-point sparkles; dot draws soft round dots; cross draws thin lens glints.',
    },
    count: {
      description: 'Sparkles twinkling at once, or flying out per burst.',
      range: [1, 64],
      step: 1,
    },
    scale: {
      description: 'Size of the sparkles over a base of 30 px.',
      range: [0.25, 4],
      step: 0.05,
    },
    color: { description: 'Color of the sparkles, any CSS color; some come out whiter.' },
    spread: {
      description: 'How far past the element’s edges sparkles appear and bursts fly.',
      range: [0, 120],
      unit: 'px',
    },
    duration: { description: 'Life of one sparkle.', range: [0.3, 4], step: 0.05, unit: 's' },
    fps: {
      description: 'Most frames a second of the loop trigger; 0 freezes it.',
      range: [0, 60],
      step: 1,
    },
    seed: { description: 'Seed of the randomness.', range: [1, 100], step: 1 },
  },
  frames:
    'Only while sparkles live: none at rest for hover, click and view; at most fps a second while on screen for loop.',
  touch:
    'A tap bursts like a click and starts a few hover sparkles; loop and view work as on desktop.',
  reducedMotion: 'Off: neither the module nor the engine loads for it, and the page is unchanged.',
  presence: 'Sparkles fade with the page as it leaves.',
  quality: { low: 'At most 8 sparkles and 20 frames a second for loop.' },
  cost: {
    gpu: 'One instanced draw of at most 64 small quads, only while sparkles live.',
    memory: 'Instance attributes for 64 sparkles, about 3 KB.',
  },
  examples: [
    {
      title: 'A "new" badge that sparkles on hover',
      html: '<span class="badge" data-dio="sparkles" data-dio-scale="0.75" data-dio-spread="14">New</span>',
    },
    {
      title: 'A premium button bursting with stars on click; the link still opens',
      html: '<a class="button" href="/pro" data-dio="sparkles" data-dio-trigger="click" data-dio-count="16">Go Pro</a>',
    },
    {
      title: 'A highlighted product with soft ambient glints',
      html: '<figure class="pick" data-dio="sparkles" data-dio-trigger="loop" data-dio-style="cross" data-dio-color="#ffffff" data-dio-count="6"><img src="/media/lamp.jpg" alt="Brass desk lamp"><figcaption>Editor’s pick</figcaption></figure>',
    },
    {
      title: 'A reward on a kids’ learning page, once it scrolls into view',
      html: '<section class="reward" data-dio="sparkles" data-dio-trigger="view" data-dio-style="dot" data-dio-count="24"><h2>Level complete!</h2></section>',
    },
  ],
}

export default doc
