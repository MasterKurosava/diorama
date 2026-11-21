import type { EffectDoc } from '@dioramajs/effects'
import type emoji from './emoji'

const doc: EffectDoc<typeof emoji> = {
  category: 'celebration',
  tags: ['block'],
  summary:
    'Emoji or small pictures that float up from a like button, burst out of a success state or rain over a section.',
  looks:
    'count emoji pop in with a slight overshoot and fly for duration, then fade and shrink over the last third of their life. float sends them up from the top of the element in a gentle stream, swaying and rocking, like reactions on a live stream; burst throws them out of the box in every direction, slowed by the air; fountain shoots them up in a cone and lets them fall back; rain lets them fall through the element’s part of the viewport over its width. Every emoji keeps moving with the page as it scrolls. The list is drawn once with the system emoji font, so the emoji look native on every device; pictures of the list are drawn the same way. The element stays as it is.',
  target: 'any element: a like or reaction button, a form, a section',
  params: {
    trigger: {
      description:
        'click; view once half the element is on screen; a DOM event; manual through fire; interval, an emission every interval seconds while the element is on screen.',
    },
    motion: {
      description:
        'float rises from the element, for likes and reactions; burst flies out of it all round, for a success state; fountain shoots up and falls back, for a win or a reward; rain falls over the element from its top, for a seasonal section or a thank-you page.',
    },
    emoji: {
      description:
        'Emoji, symbols or words separated by spaces; a run of emoji without spaces counts as one each. A URL or a file name ending in .svg, .png, .webp and the like is a picture. Up to 16 different items; each emoji picks one at random.',
    },
    event: {
      description:
        'Name of the DOM event on the element for the event trigger; its detail may pick one emoji of the list and a count up to count.',
    },
    fire: {
      description: 'Every increase emits once with the manual trigger.',
      range: [0, 10],
      step: 1,
    },
    once: { description: 'At most one emission per page.' },
    origin: {
      description:
        'center: out of the box; pointer: from the click or the pointer. Rain ignores it.',
    },
    count: { description: 'Emoji per emission; 0 emits none.', range: [0, 300], step: 1 },
    scale: {
      description: 'Size of the emoji over a base of 32 px, give or take a fifth.',
      range: [0.25, 5],
    },
    speed: {
      description: 'Speed of the motion as a factor; 0 pops the emoji in place.',
      range: [0, 3],
    },
    spread: {
      description: 'Width of the cone for float and fountain; burst flies all round.',
      range: [0, 360],
      unit: 'deg',
    },
    sway: { description: 'Side to side sway; 0 flies straight.', range: [0, 80], unit: 'px' },
    spin: {
      description: 'Rocking and spin as a factor; 0 keeps the emoji upright.',
      range: [0, 4],
    },
    duration: { description: 'Life of an emoji.', range: [0.4, 8], unit: 's' },
    interval: {
      description: 'Time between two emissions of the interval trigger; 0 stops them.',
      range: [0, 10],
      unit: 's',
    },
    seed: { description: 'Seed of the randomness.', range: [1, 100], step: 1 },
  },
  frames:
    'Only while emoji fly; none at rest. The interval trigger pauses while the element is off screen.',
  touch: 'A tap emits like a click.',
  reducedMotion: 'Off: neither the module nor the engine loads for it, and the page is unchanged.',
  presence: 'The emoji fade with the page as it leaves.',
  quality: { low: 'At most 12 emoji an emission.', medium: 'At most 24 emoji an emission.' },
  cost: {
    gpu: 'One instanced draw for a pool of 300 emoji.',
    memory: 'A glyph atlas of at most 1024 x 1024 px and the pool’s attributes, about 15 KB.',
  },
  examples: [
    {
      title: 'Hearts float up from a like button; its click still counts',
      html: '<button type="button" class="like" data-dio="emoji" aria-pressed="false">Like</button>',
    },
    {
      title: 'A burst after a purchase, from the confirmation',
      html: '<section class="paid" data-dio="emoji" data-dio-trigger="view" data-dio-motion="burst" data-dio-emoji="🎉 🥳 ✨" data-dio-count="24" data-dio-once="true"><h1>Payment received</h1></section>',
    },
    {
      title: 'Pumpkins raining over a seasonal section',
      html: '<section class="halloween" data-dio="emoji" data-dio-trigger="interval" data-dio-motion="rain" data-dio-emoji="🎃 🦇 🍬" data-dio-count="6" data-dio-interval="1.2" data-dio-scale="0.9"><h2>Halloween sale</h2></section>',
    },
    {
      title: 'Reactions from other viewers, sent by the site',
      html: '<div class="reactions" data-dio="emoji" data-dio-trigger="event" data-dio-event="reaction" data-dio-emoji="👍 ❤️ 😂 😮" data-dio-count="3"></div>',
      ts: "document.querySelector('.reactions')?.dispatchEvent(new CustomEvent('reaction', { detail: { emoji: '😂', count: 1 } }))",
    },
    {
      title: 'The site’s own icon in a fountain',
      html: '<button type="button" data-dio="emoji" data-dio-motion="fountain" data-dio-emoji="/icons/star.svg" data-dio-count="16">Claim reward</button>',
    },
  ],
}

export default doc
