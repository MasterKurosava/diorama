import type { EffectDoc } from '@dioramajs/effects'
import type prism from './prism'

const doc: EffectDoc<typeof prism> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'Letters become crystal: their edges split a light into a crisp spectrum that slides around them as the light moves.',
  looks:
    'The text turns into bevelled glass in its own color, standing a little off the page. The face stays crisp ink; across each bevel the glass bends the view outward, and every color by its own amount, so the edge of the ink splits into a clean spectrum, as through a prism. Sharp highlights and thin lines of light caught inside the edges follow a lamp, and where a bevel faces away from it the light leaves in a thin saturated spectrum along the contour, with a fainter one landing on the page just past the letter. The rainbows gather near the lamp and slide around the curves as it moves: it follows the pointer, sweeps with the scroll, orbits slowly or passes once as the text comes into view.',
  target:
    'a large heading or short display line in a bold font, on a plain background. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'prism round glass with smooth spectra; crystal cut facets that flash colors; diamond more facets and fire.',
    },
    trigger: {
      description:
        'pointer follows the pointer; scroll sweeps with the scroll; loop orbits; view passes once.',
    },
    dispersion: {
      description: 'How far the colors pull apart; 0 keeps the light white, with no rainbow.',
      range: [0, 2],
    },
    spread: {
      description: 'How far past the letters the thrown spectrum lands; 0 turns it off.',
      range: [0, 2],
    },
    strength: {
      description: 'Brightness of the rainbows, the highlights and the sparkle.',
      range: [0, 2],
    },
    bevel: {
      description: 'Width of the bevel along every edge in ems; larger is rounder glass.',
      range: [0.01, 0.15],
      unit: 'em',
    },
    light: {
      description: 'Where the light comes from at rest as a CSS angle, 0 above and 90 right.',
      range: [0, 360],
      step: 1,
      unit: 'deg',
    },
    follow: {
      description: 'How far the light moves toward the pointer or with the scroll; 0 holds it.',
      range: [0, 1],
    },
    fps: {
      description: 'Frame rate of the loop; 0 holds the light still.',
      range: [0, 60],
      step: 1,
    },
  },
  frames:
    'None at rest: the glass and its spectra stay drawn. Full rate while the light settles after the pointer moves, one frame per scroll with trigger scroll, `fps` frames a second on a loop while in view, and a short sweep on view.',
  touch:
    'A finger does not move the light, so a tap or a swipe never flickers it; the scroll and loop triggers work as on desktop.',
  reducedMotion: 'The light stays at its angle and the spectra hold still.',
  presence: 'The glass and its light fade with the page.',
  quality: {
    low: 'The glass is built at 1 px per CSS px instead of 2, the light is split into 5 colors instead of 7, and the loop runs at most 24 frames a second.',
  },
  cost: {
    gpu: 'One quad over the text and a margin around it; about 25 texture reads per pixel, three per color of the split light.',
    memory:
      'A half-float relief of the text built once on the CPU from a distance field, and a canvas of the text.',
  },
  examples: [
    {
      title: 'A launch heading in crystal, lit by the pointer',
      html: '<h1 data-dio="prism">Clarity, refined.</h1>',
    },
    {
      title: 'Cut crystal on a dark page',
      html: '<h2 data-dio="prism" data-dio-style="crystal">Brilliant cut</h2>',
    },
    {
      title: 'A diamond line whose light orbits slowly',
      html: '<p class="display" data-dio="prism" data-dio-style="diamond" data-dio-trigger="loop">Forever</p>',
    },
    {
      title: 'From code',
      html: '<h2 class="hero">Spectrum</h2>',
      ts: "app.attach('.hero', 'prism', { trigger: 'scroll', spread: 1.4 })",
    },
  ],
}

export default doc
