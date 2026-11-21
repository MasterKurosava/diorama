import type { EffectDoc } from '@dioramajs/effects'
import type splitFlap from './split-flap'

const doc: EffectDoc<typeof splitFlap> = {
  category: 'text',
  tags: ['data'],
  summary:
    'A departure board: each character flips through a drum of letters to its own, on view and whenever the site changes the text.',
  looks:
    'Every letter sits on a dark tile split across the middle. When the board comes into view the top half of each tile falls over its hinge again and again, showing the next letter of the drum, until it lands on the right one; letters further along the drum take longer, so the line settles unevenly like a real station board. When your code changes the text, only the characters that changed flip to their new letters. The plain style flips the letters without tiles and hands back to the real text at rest.',
  target:
    'a short line of text: a destination, a status, a price, a time, a menu item. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'tiles draws each character on a split tile in the tile color, also at rest; plain flips the letters alone and shows the real text at rest.',
    },
    motion: {
      description:
        'drum walks the drum in order, so each letter takes as many flips as it is far from its target, up to flips; random shows flips random faces on every letter, so they land together.',
    },
    trigger: {
      description:
        'view flips in from blank when the text enters, then on every change; change shows the text as it is and flips only when it changes.',
    },
    chars: {
      description:
        'Characters on the drum: board (A to Z, digits and . , : - / &), letters, digits, time, or your own string in order. Characters not on it are dropped in at the end of the flips.',
    },
    duration: {
      description: 'Time of one flip; 0 swaps the letters without flipping.',
      range: [0, 0.3],
      unit: 's',
    },
    flips: {
      description: 'Most flips per character; 0 or 1 flips straight to the new letter.',
      range: [0, 40],
      step: 1,
    },
    stagger: {
      description: 'Delay between neighboring characters that flip.',
      range: [0, 0.3],
      unit: 's',
    },
    delay: { description: 'Wait after the text enters, for a cascade.', range: [0, 2], unit: 's' },
    threshold: {
      description: 'Share of the element height in view, above the bottom tenth, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
    tile: { description: 'Color of the tiles; the letters take the color of the text.' },
    gap: { description: 'Space between neighboring tiles.', range: [0, 0.5], unit: 'em' },
    shade: {
      description: 'Shadow on a turning flap, the slit and the lighter top half; 0 is flat.',
      range: [0, 1],
    },
    seed: {
      description: 'Picks the random faces; the same seed plays the same way.',
      range: [1, 100],
      step: 1,
    },
  },
  frames: 'Only while flaps turn; none at rest.',
  touch: 'The same as with a mouse.',
  reducedMotion:
    'Static: the tiles stay, and new text shows at once without flips. The plain style is the text as it is.',
  presence: 'The copy fades with the page.',
  quality: {
    low: 'The letters are drawn at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'One instanced draw of three quads per character, one texture read per pixel.',
    memory: 'A small sheet of the drum and the letters of the text, kept while the element lives.',
  },
  examples: [
    {
      title: 'A departures row',
      html: '<p class="board" data-dio="split-flap">LISBON 14:05 BOARDING</p>',
    },
    {
      title: 'A status your code changes',
      html: '<span class="status" data-dio="split-flap" data-dio-trigger="change" aria-live="polite">ON TIME</span>',
      ts: "document.querySelector('.status').textContent = 'DELAYED'",
    },
    {
      title: 'A countdown that flips once a second',
      html: '<time class="clock" data-dio="split-flap" data-dio-trigger="change" data-dio-chars="time" data-dio-flips="1">02:14:09</time>',
    },
    {
      title: 'Plain letters on a menu board',
      html: '<h2 data-dio="split-flap" data-dio-style="plain" data-dio-motion="random" data-dio-flips="6">Today: ramen</h2>',
    },
  ],
}

export default doc
