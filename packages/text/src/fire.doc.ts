import type { EffectDoc } from '@dioramajs/effects'
import type fire from './fire'

const doc: EffectDoc<typeof fire> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'The letters burn: flames rise from their tops, sparks drift up in depth and the firelight flickers on the page.',
  looks:
    'Flames rise from the tops of the strokes that face open air, in a plume built from the shape of the letters: white-yellow where they leave the strokes, orange higher up, red at the tips, swaying and torn into tongues by turbulence carried up through them, taller over one letter and lower over the next as the fire breathes. Over the strokes the flames thin out, so the text stays readable. The tops of the letters glow like embers, their faces warm toward the fire and darken with soot where it burned. A few sparks rise in front of and behind the letters and cool from yellow to red as they climb. The firelight flickers on the page around the text in step with the flames, and the letters cast a soft shadow below. The embers style turns the letters into hot coals with light in their cracks and low flames; the candle style puts one calm, swaying flame on top of each letter.',
  target:
    'a heading, a label or a short line of text, best on a dark background. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'flame burns tall; embers makes glowing coals; candle lights one calm flame per letter.',
    },
    trigger: {
      description:
        'loop burns on; hover lights near the pointer; view flares up once; scroll follows the page.',
    },
    strength: {
      description: 'Brightness of the flames, the sparks and the firelight; 0 puts the fire out.',
      range: [0, 2],
    },
    height: {
      description:
        'Height of the flames over the letters, in ems; embers and candle keep theirs lower.',
      range: [0.2, 2],
      unit: 'em',
    },
    speed: {
      description: 'Pace of the flames and the sparks; 0 holds the fire still.',
      range: [0, 3],
    },
    embers: {
      description: 'Sparks in the air at once; candle sends up a third as many, 0 for none.',
      range: [0, 400],
      step: 1,
    },
    color: {
      description:
        'Tint of the fire, any CSS color, such as a blue gas flame; empty for natural fire.',
    },
    char: {
      description:
        'How dark the flames scorch the tops of the letters, recovering after; 0 for none.',
      range: [0, 1],
    },
    seed: {
      description: 'Picks the shape of the flames, the sparks and where the fire catches first.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    '30 a second while the fire burns and is on screen, none off screen. Hover and view draw nothing once the fire has died down and the char has faded, and view with embers stops once the coals settle; scroll draws while the text burns.',
  touch:
    'With trigger hover a tap lights the letters around it for a moment; focus on the element or its link lights them all.',
  reducedMotion:
    'A still warm glow: the letters lit and the page warm around them, no moving flames and no sparks. Candles stand still, coals keep their glow, and nothing is drawn after.',
  presence:
    'Leaving a page the fire dies down and the letters fade with it; entering they catch fire again.',
  quality: {
    low: 'At most 10 sparks, flames with less turbulence, and the text rastered at 1 device pixel per CSS pixel.',
    medium: 'At most 20 sparks.',
  },
  cost: {
    gpu: 'A quad over the letters, one over the air above them for the flames (seven texture reads a pixel), one for the firelight around the text (two reads), and one small quad per spark or candle. Pixels with nothing to add are discarded.',
    memory:
      'A canvas of the text, a distance field of it, the plume the flames rise in, a small texture of the firelight and one of the heat of each letter.',
  },
  examples: [
    {
      title: 'A burning headline',
      html: '<h1 data-dio="fire">Burn bright</h1>',
    },
    {
      title: 'Letters like hot coals',
      html: '<h2 data-dio="fire" data-dio-style="embers" data-dio-embers="90">Smokehouse</h2>',
    },
    {
      title: 'Candles on a quiet heading',
      html: '<h2 data-dio="fire" data-dio-style="candle" data-dio-embers="20">Silent night</h2>',
    },
    {
      title: 'A link that catches fire under the pointer',
      html: '<a href="/menu" data-dio="fire" data-dio-trigger="hover">Grill menu</a>',
    },
    {
      title: 'From code',
      html: '<h2 class="launch">Ignition</h2>',
      ts: "app.attach('.launch', 'fire', { trigger: 'view', height: 1.2, char: 0.6 })",
    },
  ],
}

export default doc
