import type { EffectDoc } from '@dioramajs/effects'
import type textReveal from './text-reveal'

const doc: EffectDoc<typeof textReveal> = {
  category: 'text',
  tags: ['scroll'],
  summary:
    'Headings rise, slide up, fade, pop or type into place letter by letter, word by word or line by line.',
  looks:
    'When the text scrolls into view, each letter, word or line rises from a little below its baseline, standing up from a backward tilt and coming into focus as it fades in, one after another in reading order; other motions slide each one up out of its line, fade it in, pop it in or type it. When the last one lands the element is the real text again: selectable, crisp and styled by your CSS. Text on screen when the page opens is hidden until the effect is ready and then plays the same way; if that takes over 3 seconds it shows as it is. With the scroll trigger such text stays as it is until scrolling reaches it.',
  target:
    'any element with text: a heading, a paragraph, a link. Not img, video, canvas, svg or form fields. Any font-stretch, font-variation-settings and font-feature-settings draw as on the page when the font comes from a readable @font-face (same origin, or a stylesheet served with CORS such as Google Fonts); otherwise such text stays as it is, as does text with text-shadow, a text stroke, background-clip: text or vertical writing',
  params: {
    by: {
      description:
        'Unit that moves as one; over 1500 letters it moves by words, over 1500 words by lines.',
    },
    trigger: {
      description:
        'view plays when the text enters; scroll ties it to the scroll position, both ways.',
    },
    motion: {
      description:
        'rise lifts each unit from below its baseline, tipped back and blurred, for most headings; mask slides it up out of its own line as if from behind an edge, the editorial look; fade fades it in place, coming into focus by blur, for body text; pop grows it from its middle with a slight overshoot, for a playful brand; type shows it at once when its turn comes, like a typewriter (set stagger to the time per unit).',
    },
    duration: {
      description: 'Time one unit takes to land; type ignores it.',
      range: [0.2, 3],
      unit: 's',
    },
    stagger: {
      description: 'Delay between neighboring units in reading order.',
      range: [0, 0.3],
      unit: 's',
    },
    delay: { description: 'Wait after the trigger, for a cascade.', range: [0, 2], unit: 's' },
    rise: {
      description: 'How far below its place a unit starts, with rise.',
      range: [0, 2],
      unit: 'em',
    },
    tilt: {
      description: 'How far a unit starts tipped back around its baseline, with rise.',
      range: [0, 90],
      unit: 'deg',
    },
    blur: {
      description: 'How blurred a unit starts with rise and fade; 0 for sharp.',
      range: [0, 1],
    },
    threshold: {
      description:
        'Share of the element height that must be in view, above the bottom tenth of the viewport, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
  },
  frames: 'Only while units move, and with the scroll trigger while scrolling; none at rest.',
  touch: 'The same as with a mouse: it follows the scroll.',
  reducedMotion: 'Off: the text is shown as it is, and the engine does not load for it.',
  presence:
    'Leaving a page, the units go again in reverse order; entering, they rise in order. A flight to a text element lands on the DOM text.',
  quality: {
    low: 'No blur, and the text is rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'One instanced draw of a quad per unit, one texture read per pixel.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, kept while the element lives: about 2.5 MB for a 1200 x 200 heading.',
  },
  examples: [
    { title: 'A heading', html: '<h1 data-dio="text-reveal">Silence, shaped.</h1>' },
    {
      title: 'Words, tied to scroll',
      html: '<h2 data-dio="text-reveal" data-dio-by="word" data-dio-trigger="scroll">Forty hours. One charge.</h2>',
    },
    {
      title: 'Lines of a paragraph, after the heading',
      html: '<p data-dio="text-reveal" data-dio-by="line" data-dio-delay="0.3">Hand-finished in small batches, tuned by ear and built to be repaired rather than replaced.</p>',
    },
    {
      title: 'Lines slide up out of a mask',
      html: '<h1 data-dio="text-reveal" data-dio-by="line" data-dio-motion="mask" data-dio-stagger="0.12">Built to last.<br>Made to be repaired.</h1>',
    },
    {
      title: 'Typed letter by letter',
      html: '<p class="prompt" data-dio="text-reveal" data-dio-motion="type" data-dio-stagger="0.05">npm install dioramajs</p>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Selected work</h2>',
      ts: "app.attach('.title', 'text-reveal', { by: 'word', stagger: 0.08 })",
    },
  ],
}

export default doc
