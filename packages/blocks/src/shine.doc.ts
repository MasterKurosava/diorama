import type { EffectDoc } from '@dioramajs/effects'
import type shine from './shine'

const doc: EffectDoc<typeof shine> = {
  category: 'block',
  tags: ['photo'],
  summary:
    'A glint that sweeps across a button, a card or an image on hover, on a timer or as it comes into view.',
  looks:
    'A soft bright band with a brighter core, width of the element’s length across, travels over the element at angle in duration seconds, easing in and out, clipped to its rounded corners, each one as CSS draws it. Between sweeps nothing is drawn and the element is just DOM.',
  target: 'any element: a button, a link, a pricing card, a badge, an image',
  params: {
    trigger: {
      description:
        'hover sweeps on pointer enter and keyboard focus; interval also sweeps on a timer while on screen, for a call to action; view sweeps once as it comes into view, for a badge or a plan.',
    },
    angle: {
      description: 'Direction of the sweep, like a CSS gradient angle; 90 goes left to right.',
      range: [0, 360],
      unit: 'deg',
    },
    width: {
      description: 'Width of the band as a share of the element’s length along the sweep.',
      range: [0.05, 1],
      step: 0.01,
    },
    color: { description: 'Color of the band, any CSS color.' },
    duration: { description: 'Time one sweep takes.', range: [0.2, 4], step: 0.05, unit: 's' },
    interval: {
      description: 'Pause between timed sweeps with the interval trigger; 0 sweeps on hover only.',
      range: [0, 20],
      step: 0.5,
      unit: 's',
    },
    strength: {
      description: 'Opacity of the band at its core; 0 hides it.',
      range: [0, 1],
      step: 0.01,
    },
  },
  frames: 'Only during a sweep; none at rest and none while waiting for the next timed sweep.',
  touch: 'A tap sweeps like a hover; the interval and view triggers work as on desktop.',
  reducedMotion:
    'Off: neither the module nor the engine loads for it, and the element is unchanged.',
  presence: 'A sweep fades with the page as it leaves.',
  quality: {},
  cost: {
    gpu: 'One quad over the element, drawn only during a sweep.',
    memory: 'None beyond the quad.',
  },
  examples: [
    {
      title: 'A glint on a call to action when the pointer comes over it',
      html: '<a class="button" href="/signup" data-dio="shine">Start free trial</a>',
    },
    {
      title: 'The featured plan catches the eye every five seconds',
      html: '<article class="plan featured" data-dio="shine" data-dio-trigger="interval" data-dio-interval="5" data-dio-width="0.25"><h3>Team</h3><p>$49 per month</p></article>',
    },
    {
      title: 'A gold badge sweeps once as it scrolls into view',
      html: '<span class="badge" data-dio="shine" data-dio-trigger="view" data-dio-color="#ffe7a3" data-dio-strength="0.6">Premium</span>',
    },
  ],
}
export default doc
