import type { EffectDoc } from '@dioramajs/effects'
import type rotator from './rotator'

const doc: EffectDoc<typeof rotator> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'Words take turns in a headline on the faces of a real 3D cube, drum, split flap or folding strip.',
  looks:
    'The word in the headline sits on a face of a solid shape. Every few seconds the shape turns in perspective to show the next word: a cube rolls up, a drum spins with the words above and below curving away, a split flap falls over its hinge, or a strip folds back into the page while the next one unfolds. Faces darken as they turn away from a lamp above the text and catch a glint as they pass it, and the line around the word eases to the new width. Between turns the word is plain text.',
  target:
    'an inline element of a heading or paragraph whose children are the words, one element each, such as spans. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'cube rolls a box; drum spins a wheel; flip drops a split flap; fold folds a paper strip.',
    },
    trigger: {
      description:
        'interval turns on a timer; scroll scrubs the words with the scroll; hover turns on hover.',
    },
    axis: {
      description: 'x turns the words up and over; y turns them sideways, along the line.',
    },
    interval: {
      description: 'Time each word stays before the next turn, with trigger interval.',
      range: [0.5, 8],
      unit: 's',
    },
    duration: { description: 'Time one turn takes.', range: [0.2, 2], unit: 's' },
    depth: {
      description: 'Strength of the perspective; 0 turns the shape flat, without perspective.',
      range: [0, 3],
    },
    shade: {
      description:
        'How much the lamp darkens and lights the turning faces; 0 keeps the text color.',
      range: [0, 1],
    },
    pause: {
      description: 'Holds the timer while the pointer is over the line or focus is in it.',
    },
    loop: {
      description: 'Starts over after the last word; false stops on it.',
    },
  },
  children: [
    {
      element: ':scope > *',
      description:
        'Each child element with text is one word, in order; the first shows before the first turn.',
    },
  ],
  frames:
    'Only while a word turns, and with trigger scroll while scrolling through a turn; none between turns: a timer wakes the next one.',
  touch:
    'The same as with a mouse; with trigger hover a tap turns to the next word, and nothing pauses.',
  reducedMotion:
    'The words still change, but fade into each other in place over a third of a second, without turning.',
  presence:
    'Between turns the word leaves and enters with the page; a turn under way fades with its copy.',
  quality: {
    low: 'The words are rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'One instanced draw of two to six textured quads while a word turns; nothing between turns.',
    memory:
      'A small atlas of the words of the current turn at twice their CSS size, replaced each turn.',
  },
  examples: [
    {
      title: 'A hero headline with a rolling cube',
      html: '<h1>We build <span data-dio="rotator"><span>websites</span> <span>apps</span> <span>brands</span></span></h1>',
    },
    {
      title: 'A departures board for an event page',
      html: '<h2>Next stop <span data-dio="rotator" data-dio-style="flip" data-dio-interval="1.6"><span>Berlin</span> <span>Lisbon</span> <span>Kyoto</span></span></h2>',
    },
    {
      title: 'A drum turned by the scroll while its section is pinned with position: sticky',
      html: '<section class="story"><h2 class="sticky">Made for <span data-dio="rotator" data-dio-style="drum" data-dio-trigger="scroll"><span>founders</span> <span>teams</span> <span>agencies</span></span></h2></section>',
    },
    {
      title: 'From code',
      html: '<h2>Ship <span class="verb"><span>faster</span> <span>safer</span> <span>together</span></span></h2>',
      ts: "app.attach('.verb', 'rotator', { style: 'fold', interval: 3 })",
    },
  ],
}

export default doc
