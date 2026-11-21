import type { EffectDoc } from '@dioramajs/effects'
import type beam from './beam'

const doc: EffectDoc<typeof beam> = {
  category: 'block',
  summary:
    'A light beam that runs around the rounded border of a feature card, an input field or a highlight box.',
  looks:
    'A bright head of the first color with a soft trail of length px that turns into the second color and fades, running clockwise along the element’s edge at speed px per second and following its border radius, with a glow around the line. The pulse motion sends two beams from the top middle both ways round to meet at the bottom, then rests; hover runs the beam only while the element is hovered or has focus inside. The element stays DOM; the light draws over its edge.',
  target: 'any element with a box: a card, a form field wrapper, a pricing plan, a callout',
  params: {
    motion: {
      description:
        'loop runs all the time; pulse sweeps from the top now and then; hover on hover or focus.',
    },
    color: { description: 'Color of the beam’s head, any CSS color.' },
    color2: { description: 'Color the trail turns into toward its end, any CSS color.' },
    length: {
      description: 'Length of the beam with its trail along the border.',
      range: [20, 600],
      unit: 'px',
    },
    speed: {
      description: 'Speed along the border; 0 stops the beam where it is.',
      range: [0, 1000],
      unit: 'px/s',
    },
    thickness: { description: 'Thickness of the line.', range: [0.5, 8], step: 0.5, unit: 'px' },
    glow: {
      description: 'Strength and reach of the soft light around the line; 0 draws the line alone.',
      range: [0, 2],
      step: 0.05,
    },
    fps: {
      description: 'Most frames a second while the beam runs; 0 holds it still.',
      range: [0, 120],
      step: 1,
    },
  },
  frames:
    'At most fps a second while on screen for loop and pulse; for hover only while hovered, focused or fading out, none at rest.',
  touch: 'A tap runs the hover beam while the finger is down; a focused field keeps it running.',
  reducedMotion:
    'Static: a faint still border in the two colors instead of the moving beam; with hover it shows while hovered or focused.',
  presence: 'The beam fades with the page as it leaves.',
  quality: { low: 'At most 30 frames a second.', medium: 'At most 45 frames a second.' },
  cost: {
    gpu: 'One draw of a thin frame around the box; the inside of the element is never shaded.',
    memory: 'Eight vertices.',
  },
  examples: [
    {
      title: 'A featured card with a beam running round it',
      html: '<article class="feature" data-dio="beam"><h3>Realtime sync</h3><p>Every change lands on every device in under 100 ms.</p></article>',
    },
    {
      title: 'An email field that lights up while focused or hovered',
      html: '<label class="field" data-dio="beam" data-dio-motion="hover" data-dio-color="#38bdf8" data-dio-color2="#6366f1"><input type="email" placeholder="you@company.com"></label>',
    },
    {
      title: 'A callout that pulses every few seconds',
      html: '<aside class="callout" data-dio="beam" data-dio-motion="pulse" data-dio-thickness="1.5" data-dio-glow="1"><p>New: export to PDF.</p></aside>',
    },
  ],
}

export default doc
