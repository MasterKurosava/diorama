import type { EffectDoc } from '@dioramajs/effects'
import type confetti from './confetti'

const doc: EffectDoc<typeof confetti> = {
  category: 'celebration',
  summary:
    'A burst of confetti from an element, a shower or fireworks to celebrate a sign-up, an order or a donation.',
  looks:
    'count pieces fly out of the element’s box at angle with spread and speed, slow down in the air, fall with gravity and tumble in 3D, face and back in different shades; ribbons bend, and every piece fades over the last fifth of its life. The rain motion lets the pieces fall from above the viewport over its whole width instead, and fireworks bursts five shells one after another at random points of its upper half. The pieces draw over everything and the element stays as it is.',
  target: 'any element: a button, a section, a form',
  params: {
    trigger: { description: 'click, view once on screen, a DOM event, or manual through fire.' },
    motion: {
      description:
        'burst fires the pieces out of the element, for a button or a form; rain lets them fall from above the whole viewport for a few seconds, for a thank-you or results page; fireworks bursts shells in every direction over the upper viewport, for a launch or a big win. Rain and fireworks ignore origin, angle and spread.',
    },
    event: { description: 'Name of the DOM event on the element for the event trigger.' },
    fire: {
      description: 'Every increase fires a burst with the manual trigger.',
      range: [0, 10],
      step: 1,
    },
    once: { description: 'At most one burst per page.' },
    origin: { description: 'center of the box, its edges, or the pointer.' },
    count: { description: 'Pieces per burst.', range: [1, 1200], step: 1 },
    angle: { description: 'Direction of the burst; 90 is up.', range: [0, 360], unit: 'deg' },
    spread: { description: 'Spread around the direction.', range: [0, 360], unit: 'deg' },
    speed: { description: 'Initial speed of the pieces.', range: [100, 4000], unit: 'px/s' },
    gravity: { description: 'Gravity in px per second squared.', range: [0, 5000] },
    decay: { description: 'Air drag per second, as in canvas-confetti.', range: [0, 5] },
    duration: { description: 'Life of a piece.', range: [0.5, 10], unit: 's' },
    scale: { description: 'Size of the pieces over a base of 10 px.', range: [0.2, 4] },
    colors: { description: 'Colors separated by spaces, any CSS colors.' },
    shapes: { description: 'mix, rect, circle or ribbon.' },
    seed: { description: 'Seed of the randomness.', range: [1, 100], step: 1 },
  },
  frames: 'Only while pieces fly; none at rest.',
  touch: 'A tap fires like a click.',
  reducedMotion: 'Off: neither the module nor the engine loads for it, and the page is unchanged.',
  presence: 'A burst fades with the page as it leaves.',
  quality: { low: 'At most 80 pieces.', medium: 'At most 140 pieces.' },
  cost: {
    gpu: 'One instanced draw for a pool of 1200 pieces.',
    memory: 'Instance attributes of the pool, under 100 KB.',
  },
  examples: [
    {
      title: 'On a button; its click still works',
      html: '<button type="button" data-dio="confetti" data-dio-count="120">Add to calendar</button>',
    },
    {
      title: 'On a thank-you page, once, when it shows up',
      html: '<section class="thanks" data-dio="confetti" data-dio-trigger="view" data-dio-origin="edges"><h1>See you in October!</h1></section>',
    },
    {
      title: 'A shower over the whole page when the order is confirmed',
      html: '<section class="confirmed" data-dio="confetti" data-dio-trigger="view" data-dio-motion="rain" data-dio-count="400"><h1>Order confirmed</h1></section>',
    },
    {
      title: 'Fireworks for a launch, fired by the site',
      html: '<div class="launch" data-dio="confetti" data-dio-trigger="manual" data-dio-motion="fireworks" data-dio-shapes="circle"></div>',
      ts: "app.effects.get(document.querySelector('.launch'), 'confetti').params.fire++",
    },
    {
      title: 'After the site’s own success event',
      html: '<form data-dio="confetti" data-dio-trigger="event" data-dio-event="signup:done"><button>Sign up</button></form>',
    },
  ],
}

export default doc
