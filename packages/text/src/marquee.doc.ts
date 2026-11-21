import type { EffectDoc } from '@dioramajs/effects'
import type marquee from './marquee'

const doc: EffectDoc<typeof marquee> = {
  category: 'text',
  tags: ['scroll', 'block'],
  summary:
    'An endless ticker of a row of text, logos or images that speeds up and leans as the page scrolls.',
  looks:
    'The content of the element runs sideways in a seamless loop, with copies following each other at an even gap, and fades out softly at both ends. Scrolling the page pushes it faster and tips it forward in the direction it runs; it can also turn around when the page scrolls up. It slows to a stop under the mouse or keyboard focus and picks up again after. The content stays in the page once, so screen readers read it once while the copies you see are drawn by the GPU.',
  target:
    'a row of text, logos, inline SVGs or images laid out on one line, such as a flex row. Not img, video, canvas, svg or form fields',
  params: {
    direction: { description: 'left runs the content to the left; right runs it to the right.' },
    speed: {
      description: 'Pace without scrolling; 0 moves it only while the page scrolls.',
      range: [0, 400],
      unit: 'px',
    },
    gap: {
      description: 'Extra space between copies, on top of the row gap (1em for plain text).',
      range: [0, 400],
      unit: 'px',
    },
    boost: {
      description: 'Extra travel per pixel of page scroll; 0 ignores the scroll.',
      range: [0, 2],
    },
    skew: {
      description: 'Lean into the motion during a fast scroll; 0 keeps it upright.',
      range: [0, 30],
      unit: 'deg',
    },
    reverse: { description: 'Scrolling up turns the ticker around until the page scrolls down.' },
    pause: { description: 'Slows to a stop under the mouse or keyboard focus.' },
    fade: {
      description: 'Soft edge at each side, as a share of the width; 0 for hard edges.',
      range: [0, 0.5],
      unit: 'fraction',
    },
  },
  frames:
    'Up to 60 a second while it moves and is on screen; none off screen, paused or at speed 0 without scrolling.',
  touch: 'The same, without the pause: a finger on it scrolls the page and pushes the ticker.',
  reducedMotion: 'Static: the row stands still with its copies, and scrolling does not move it.',
  presence: 'Fades with the page.',
  quality: {
    low: 'The content is drawn at 1 device pixel per CSS pixel.',
  },
  cost: {
    gpu: 'One quad over the element, one texture read per pixel.',
    memory:
      'A canvas of one copy of the content at the screen density, without mip levels: about 1.4 MB for a 3000 x 60 row at 2x.',
  },
  examples: [
    {
      title: 'A row of logos',
      html: '<ul class="logos" data-dio="marquee"><li><img src="/logos/arc.svg" alt="Arc"></li><li><img src="/logos/vale.svg" alt="Vale"></li><li><img src="/logos/nord.svg" alt="Nord"></li></ul>',
    },
    {
      title: 'A big headline ticker that turns with the scroll',
      html: '<p class="ticker" data-dio="marquee" data-dio-speed="90" data-dio-reverse="true" data-dio-skew="10">Now booking spring 2027 · Lisbon · Kyoto · Mexico City ·</p>',
    },
    {
      title: 'Moves only while the page scrolls',
      html: '<p class="band" data-dio="marquee" data-dio-speed="0" data-dio-boost="0.6" data-dio-direction="right">Design · Build · Ship · Repeat ·</p>',
    },
    {
      title: 'From code',
      html: '<div class="press">As seen in Wired, Monocle and Dezeen</div>',
      ts: "app.attach('.press', 'marquee', { speed: 40, fade: 0.15 })",
    },
  ],
}

export default doc
