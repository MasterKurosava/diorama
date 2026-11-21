import type { EffectDoc } from '@dioramajs/effects'
import type neon from './neon'

const doc: EffectDoc<typeof neon> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'A heading becomes a 3D neon sign: round glass tubes that stutter on, light the wall and cast a shadow.',
  looks:
    'The letters become round glass tubes mounted a little in front of the page. Lit, the gas glows white hot along the middle of each tube and saturated at its sides, a highlight runs along the glass, and the tubes throw a soft colored light onto the wall behind them, where their shadow falls too. When the sign comes into view its tubes stutter on one after another like a real sign warming up, and once lit it buzzes now and then. The light that casts the shadow sits above the screen, so the shadow shifts as the page scrolls; a mouse near the sign takes its place, the shadow swings away from it, the highlights slide along the tubes and the sign turns a little toward it. The outline style bends one thin tube along the edge of each letter instead of filling it.',
  target:
    'a heading, a label or a short line of text, best on a dark background. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description: 'tube makes each stroke a round tube; outline bends a thin tube along the edge.',
    },
    trigger: {
      description:
        'view turns on as it shows; hover lights on pointer, focus or tap; always stays lit.',
    },
    color: {
      description: 'Color of the gas and its light, any CSS color; empty uses the text color.',
    },
    glow: {
      description: 'Radius of the light thrown on the wall, in ems of the font size; 0 for none.',
      range: [0, 1.5],
      unit: 'em',
    },
    strength: {
      description: 'Brightness of the light on the wall and around the tubes; 0 leaves bare tubes.',
      range: [0, 3],
    },
    depth: {
      description: 'How far the tubes stand off the wall, in ems; 0 mounts them flat on it.',
      range: [0, 0.4],
      unit: 'em',
    },
    shadow: {
      description: 'Darkness of the shadow the tubes cast on the wall; 0 for none.',
      range: [0, 1],
    },
    tilt: {
      description: 'Largest turn of the sign toward a mouse near it, degrees; 0 keeps it still.',
      range: [0, 12],
      unit: 'deg',
    },
    flicker: {
      description: 'How often and how deep the lit sign buzzes and dims; 0 holds it steady.',
      range: [0, 1],
    },
    broken: {
      description: 'Share of the letters that keep stuttering and going dark; 0 for none.',
      range: [0, 1],
      unit: 'fraction',
    },
    seed: {
      description: 'Picks the flicker, the broken letters and the turn-on; the same seed repeats.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'Full rate while tubes switch on or off and while the lamp or the sign follows the mouse, 30 a second while a tube flickers, none in between: a timer wakes the sign for its next flicker. With flicker and broken at 0 it draws nothing once lit, except on scroll.',
  touch:
    'No mouse lamp and no turn: the light stays above the screen. With trigger hover a tap switches the sign on and off.',
  reducedMotion:
    'The sign is lit from the start: no turn-on, no flicker, no broken letters, the shadow does not follow the scroll or the mouse, and it draws no frames of its own.',
  presence:
    'Leaving a page the tubes go dark from the last letter back and the glass fades; entering they light up in reading order.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2, and the distance field at half that.',
  },
  cost: {
    gpu: 'Three instanced draws of a quad per letter (wall light and shadow, bloom, tubes), at most three texture reads per pixel; nothing is blurred on the GPU.',
    memory:
      'A canvas of the text at twice its CSS size, a distance field of it with its direction, and a small atlas of each letter’s light blurred once on the CPU.',
  },
  examples: [
    {
      title: 'A sign that turns on as it shows',
      html: '<h2 class="sign" data-dio="neon">Open late</h2>',
    },
    {
      title: 'An outline sign in its own color, with one tube on the way out',
      html: '<h1 data-dio="neon" data-dio-style="outline" data-dio-color="#38e8ff" data-dio-broken="0.15">Night Market</h1>',
    },
    {
      title: 'A navigation link that lights up on hover',
      html: '<a href="/tickets" data-dio="neon" data-dio-trigger="hover" data-dio-flicker="0">Tickets</a>',
    },
    {
      title: 'From code',
      html: '<h2 class="bar">Cocktails</h2>',
      ts: "app.attach('.bar', 'neon', { color: '#ff3fa4', glow: 0.7, depth: 0.15, flicker: 0.5 })",
    },
  ],
}

export default doc
