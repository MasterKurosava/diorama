import type { EffectDoc } from '@dioramajs/effects'
import type lens from './lens'

const doc: EffectDoc<typeof lens> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'A glass reading lens follows the pointer over the text, magnifying it through real curved glass.',
  looks:
    'A thick biconvex lens in a thin steel ring hovers over the page under the pointer. Every pixel is traced through both curved faces of the glass: the text comes up sharp and magnified in the middle, bends and splits into colors toward the rim, and the glass reflects a softbox and a dim studio, strongest at its edge. On the page beside it lies its shadow with the bright spot of light it focuses, and the shadow of its handle. The lens leans into its motion and settles with a little sway.',
  target:
    'a block of text: an article, a column of fine print, a spec sheet or a caption; the lens shows its text over its solid background. Not img, video, canvas, svg or form fields',
  params: {
    radius: { description: 'Radius of the lens on screen in px.', range: [40, 200], unit: 'px' },
    zoom: {
      description: 'Magnification in the middle of the lens; 1 is plain glass.',
      range: [1, 4],
    },
    dispersion: {
      description: 'How far the glass splits colors toward the rim; 0 has no color fringes.',
      range: [0, 3],
    },
    thickness: {
      description: 'How domed the glass is; thicker bends the rim more and hovers lower.',
      range: [0, 1],
    },
    tilt: {
      description: 'Largest lean into the motion in degrees; 0 keeps the lens level.',
      range: [0, 30],
      unit: 'deg',
    },
    ease: {
      description: 'Seconds the lens lags behind the pointer; 0 follows it exactly.',
      range: [0, 0.5],
      unit: 's',
    },
  },
  frames:
    'None at rest and none while the lens is hidden. Full rate while it moves, leans, settles or fades in and out.',
  touch:
    'The lens appears while a finger is pressed on the text, held a little above the finger so it stays visible, and leaves when the finger lifts or the page scrolls.',
  reducedMotion: 'The lens jumps with the pointer: no lag, no lean.',
  presence: 'The lens fades with the page.',
  quality: {
    low: 'The text is rastered at the screen resolution instead of up to four times it.',
  },
  cost: {
    gpu: 'One quad around the lens and its shadow while it shows; three rays through the glass per pixel, one per color.',
    memory:
      'A canvas of the text at up to four device pixels per CSS px with mip levels, at most about six million pixels.',
  },
  examples: [
    {
      title: 'A column of fine print',
      html: '<article data-dio="lens" tabindex="0"><h2>Terms of carriage</h2><p>Liability for checked baggage is limited to…</p></article>',
    },
    {
      title: 'A stronger lens with no color fringes',
      html: '<div class="specs" data-dio="lens" data-dio-zoom="3" data-dio-dispersion="0">Sensor 24.6 MP…</div>',
    },
    {
      title: 'From code',
      html: '<p class="caption">Plate XII. The harbour at low water, 1871.</p>',
      ts: "app.attach('.caption', 'lens', { radius: 70, zoom: 2.5, tilt: 0 })",
    },
  ],
}

export default doc
