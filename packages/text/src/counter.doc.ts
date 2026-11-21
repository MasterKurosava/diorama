import type { EffectDoc } from '@dioramajs/effects'
import type counter from './counter'

const doc: EffectDoc<typeof counter> = {
  category: 'text',
  tags: ['data', 'scroll'],
  summary:
    'Stats count up to their value on real 3D mechanics: odometer drums, slot machine reels or flip cards.',
  looks:
    'When a number such as 12,480 or $4.2M scrolls into view, each of its digits sits on a drum that turns in 3D: digits curve over the top and bottom of the drum, foreshortened and darker as they turn away, with a soft sheen and seams between the drums. The value counts up from 0 like a mechanical odometer, the last drum overshooting its digit and settling back. The slot style spins deeper reels behind window frames, blurred while they spin, and lands them one by one from right to left with a bounce; the flip style drops the top half of each card about its hinge towards the viewer until the digit lands. The text around the number and its separators stay flat. When the digits land, the drums or cards fold back into the page and the element is its own text again.',
  target:
    'a heading, paragraph or span holding one number, with any text before and after it, such as $4.2M, 99.9% or 12,480 swimmers',
  params: {
    style: {
      description:
        'odometer turns flush drums in a row, for stats sections; slot spins deep reels behind window frames and lands them right to left, for totals and prices; flip drops flip cards through the digits, for dashboards and scores.',
    },
    trigger: {
      description:
        'view counts once when the number enters; scroll ties the count to the scroll, both ways.',
    },
    duration: {
      description: 'Time of the count; with slot and flip, until the last digit lands.',
      range: [0.3, 6],
      unit: 's',
    },
    from: {
      description: 'Value the count starts from, at most what the digits of the number can hold.',
      range: [0, 100000],
      step: 1,
    },
    stagger: {
      description: 'Delay between neighboring digits landing, for slot and flip.',
      range: [0, 0.5],
      unit: 's',
    },
    delay: { description: 'Wait after the trigger, for a row of stats.', range: [0, 3], unit: 's' },
    threshold: {
      description: 'Share of the element height in view, above the bottom tenth, before it counts.',
      range: [0, 1],
      unit: 'fraction',
    },
  },
  frames:
    'Only while the digits turn and fold back, and with the scroll trigger while scrolling; none at rest.',
  touch: 'The same as with a mouse: nothing reads the pointer.',
  reducedMotion: 'Off: the number is shown as it is, and the engine does not load for it.',
  presence:
    'Entering a page the number counts up from its start value; leaving, it counts back down to it.',
  quality: {
    low: 'The text and the digits are rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'A strip of 24 quads per digit with ten texture reads per pixel for the motion blur, a quad per letter around the number.',
    memory:
      'A canvas of the text at twice its CSS size and a small sheet of the digits, kept while the element lives.',
  },
  examples: [
    {
      title: 'A stat',
      html: '<p class="stat" data-dio="counter">12,480 <span>swimmers</span></p>',
    },
    {
      title: 'A total on slot machine reels',
      html: '<p class="stat" data-dio="counter" data-dio-style="slot" data-dio-stagger="0.18">$4.2M</p>',
    },
    {
      title: 'Uptime on flip cards',
      html: '<p class="stat" data-dio="counter" data-dio-style="flip">99.9%</p>',
    },
    {
      title: 'A count tied to the scroll',
      html: '<p class="stat" data-dio="counter" data-dio-trigger="scroll" data-dio-from="1900">2026</p>',
    },
    {
      title: 'From code',
      html: '<p class="downloads">1,204,500</p>',
      ts: "app.attach('.downloads', 'counter', { duration: 3, delay: 0.4 })",
    },
  ],
}

export default doc
