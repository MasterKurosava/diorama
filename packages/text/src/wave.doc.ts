import type { EffectDoc } from '@dioramajs/effects'
import type wave from './wave'

const doc: EffectDoc<typeof wave> = {
  category: 'text',
  tags: ['scroll'],
  summary:
    'The letters of a heading ride a wave: one pulse when it comes into view, on hover or with the scroll, or an endless float.',
  looks:
    'When the heading scrolls into view a wave runs through it from left to right: each letter lifts and settles in turn, like a crowd doing the wave in a stadium. Other axes rock the letters, swell them or tip their tops towards you. With the loop trigger the letters float on an endless wave instead, for a festival title or a playful brand line. Between pulses the heading is the real text: selectable, crisp and styled by your CSS.',
  target:
    'a heading, a label, a link or a button with text. Not img, video, canvas, svg or form fields',
  params: {
    trigger: {
      description:
        'view sends one pulse when the text enters; loop floats the letters on an endless wave; hover sends a pulse each time the pointer or focus reaches it; scroll ties the pulse to the scroll position, both ways.',
    },
    axis: {
      description:
        'y lifts the letters; rotate rocks them; scale swells them from the baseline; flip tips their tops towards the viewer.',
    },
    amplitude: {
      description:
        'Height of the wave in em for y; for rotate and flip a quarter turn per 1 (0.25 is 22.5°); for scale the growth (0.25 is 125%). 0 turns the effect off.',
      range: [0, 1],
      unit: 'em',
    },
    wavelength: {
      description: 'Loop trigger: distance between two crests.',
      range: [1, 30],
      unit: 'em',
    },
    speed: {
      description: 'Loop trigger: waves per second; 0 holds the wave still.',
      range: [0, 3],
    },
    duration: {
      description: 'View, hover and scroll: time one letter takes to rise and settle.',
      range: [0.1, 3],
      unit: 's',
    },
    stagger: {
      description: 'View, hover and scroll: delay between neighboring letters.',
      range: [0, 0.3],
      unit: 's',
    },
    delay: { description: 'Wait after the trigger, for a cascade.', range: [0, 2], unit: 's' },
    threshold: {
      description: 'Share of the element height in view, above the bottom tenth, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
    fps: {
      description: 'Loop trigger: most frames per second; the pulses always run at full rate.',
      range: [0, 60],
      step: 1,
    },
  },
  frames:
    'Only while a pulse runs, and with the scroll trigger while scrolling; the loop draws at most fps frames a second while on screen. None at rest.',
  touch: 'The same as with a mouse, except that the hover trigger needs keyboard focus on touch.',
  reducedMotion: 'Off: the text is shown as it is, and the engine does not load for it.',
  presence: 'The copy fades with the page.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2, and the loop draws at most 24 frames a second.',
  },
  cost: {
    gpu: 'One instanced draw of a quad per letter, one texture read per pixel.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, kept while the element lives.',
  },
  examples: [
    { title: 'A heading', html: '<h1 data-dio="wave">Summer Sound Festival</h1>' },
    {
      title: 'An endless float',
      html: '<h2 data-dio="wave" data-dio-trigger="loop" data-dio-amplitude="0.15">Open all weekend</h2>',
    },
    {
      title: 'A link that rocks on hover',
      html: '<a href="/tickets" data-dio="wave" data-dio-trigger="hover" data-dio-axis="rotate" data-dio-duration="0.4">Get tickets</a>',
    },
    {
      title: 'Tipped by the scroll',
      html: '<h2 data-dio="wave" data-dio-trigger="scroll" data-dio-axis="flip" data-dio-amplitude="0.5">Lineup</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Hello there</h2>',
      ts: "app.attach('.title', 'wave', { axis: 'scale', amplitude: 0.2 })",
    },
  ],
}

export default doc
