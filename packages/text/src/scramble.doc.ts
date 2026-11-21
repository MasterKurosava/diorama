import type { EffectDoc } from '@dioramajs/effects'
import type scramble from './scramble'

const doc: EffectDoc<typeof scramble> = {
  category: 'text',
  tags: ['scroll'],
  summary:
    'Headings and labels decode into place: each letter cycles through random glyphs before it settles.',
  looks:
    'When the text scrolls into view, its letters appear one after another as random glyphs that flicker a few times a second and then lock into the real letters, left to right like a terminal decoding a message. Other motions show every letter scrambled at once and settle them in a random order, or add a brief red and cyan split and jitter, like a glitching screen. When the last letter settles the element is the real text again: selectable, crisp and styled by your CSS. With the hover trigger a label stays as it is and scrambles again each time the pointer or keyboard focus reaches it.',
  target:
    'a heading, a label, a link or a button with text. Not img, video, canvas, svg or form fields',
  params: {
    motion: {
      description:
        'decode settles letters left to right, each scrambling in turn, for most headings; random scrambles every letter at once and settles them in a random order, for numbers and codes; glitch decodes with a red and cyan split and a jitter, for a louder tech look.',
    },
    by: {
      description:
        'letter gives each letter its own turn; word lets the letters of a word settle together.',
    },
    trigger: {
      description:
        'view plays when the text enters; scroll ties it to the scroll position, both ways; hover plays it each time the pointer or focus reaches it.',
    },
    chars: {
      description:
        'Glyph set: mixed, latin, upper, digits, hex, binary, symbols, or your own string.',
    },
    duration: {
      description: 'Time one letter scrambles before it settles.',
      range: [0, 3],
      unit: 's',
    },
    stagger: {
      description: 'Delay between neighboring letters or words in their turn order.',
      range: [0, 0.3],
      unit: 's',
    },
    delay: { description: 'Wait after the trigger, for a cascade.', range: [0, 2], unit: 's' },
    cycle: {
      description: 'Time each random glyph shows before the next one.',
      range: [0.02, 0.3],
      unit: 's',
    },
    threshold: {
      description: 'Share of the element height in view, above the bottom tenth, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
    seed: {
      description: 'Picks the random glyphs and order; the same seed plays the same way.',
      range: [1, 100],
      step: 1,
    },
  },
  frames: 'Only while letters scramble, and with the scroll trigger while scrolling; none at rest.',
  touch: 'The same as with a mouse, except that the hover trigger needs keyboard focus on touch.',
  reducedMotion: 'Off: the text is shown as it is, and the engine does not load for it.',
  presence:
    'Leaving a page, the settled letters scramble again in reverse order and go; entering, they decode in order.',
  quality: {
    low: 'The text and the glyphs are rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'Two instanced draws of a quad per letter, one or three texture reads per pixel.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, and a small sheet of the glyph set, kept while the element lives.',
  },
  examples: [
    { title: 'A heading', html: '<h1 data-dio="scramble">Ship the fix before the page.</h1>' },
    {
      title: 'A number that settles in a random order',
      html: '<p class="stat" data-dio="scramble" data-dio-motion="random" data-dio-chars="digits">$4,812,330</p>',
    },
    {
      title: 'A navigation link that scrambles on hover',
      html: '<a href="/work" data-dio="scramble" data-dio-trigger="hover" data-dio-stagger="0.02">Selected work</a>',
    },
    {
      title: 'A glitching headline, word by word',
      html: '<h2 data-dio="scramble" data-dio-motion="glitch" data-dio-by="word" data-dio-stagger="0.12">Zero trust. Zero downtime.</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Changelog</h2>',
      ts: "app.attach('.title', 'scramble', { chars: 'binary', duration: 0.8 })",
    },
  ],
}

export default doc
