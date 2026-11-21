import type { EffectDoc } from '@dioramajs/effects'
import type coin from './coin'

const doc: EffectDoc<typeof coin> = {
  category: '3d',
  tags: ['photo', 'block'],
  summary:
    'A coin, medal or token struck from a logo or a photo: it turns, catches the light and flips over.',
  looks:
    'The image becomes the face of a metal disc with a rim, as thick as a real coin, lying where the image was with a soft shadow under it. A transparent logo is struck into the metal: its shapes stand out in relief, in their own colors or in bare metal, and the field around them is polished metal that mirrors a small studio. A photo of a coin keeps its own look. The coin leans toward the pointer so the light runs over it, turns under a drag to show its edge and its back, and a click turns it over or tosses it so it lands on the other face.',
  target:
    'img: the front face, the circle in the middle of its box; a transparent PNG or SVG logo, or a photo of a coin cut out round. Without WebGL the plain image shows',
  params: {
    style: {
      description:
        'Shape of the object. coin: a thin disc with a narrow rim and a reeded edge, for coins and tokens of crypto and fintech sites; medal: thicker, with a wide polished rim and a smooth edge, for awards and badges; token: a thick enamel token whose edge is striped in metal and white, for loyalty programs and games.',
    },
    motion: {
      description:
        'What a click or Enter does. flip turns it over about its vertical axis; toss throws it up, tumbling, to land on the other face; none keeps the click for the page.',
    },
    back: {
      description:
        'Back face image URL or color; empty strikes the front on the back too. A color makes a plain back of that color with the rim.',
    },
    metal: {
      description:
        'Color of the metal: the rim, the edge and the field around a logo. On a token, the color of its enamel.',
    },
    ink: {
      description:
        'How much the picture keeps its own colors: 1 prints them, 0 strikes it in bare metal, so only its relief shows.',
      range: [0, 1],
    },
    relief: {
      description:
        'How far the shapes of a transparent logo and the rim stand out: 0 keeps the face flat.',
      range: [0, 1],
    },
    yaw: {
      description: 'Rest turn; positive shows the right edge.',
      range: [-180, 180],
      unit: 'deg',
    },
    pitch: {
      description: 'Rest tilt; positive shows the top edge.',
      range: [-70, 70],
      unit: 'deg',
    },
    tilt: {
      description: 'How far it leans toward the pointer: 0 turns the lean off.',
      range: [0, 35],
      unit: 'deg',
    },
    turn: {
      description:
        'Turns while the page scrolls past: 360 is a whole turn from entering the viewport to leaving it. 0 turns it off.',
      range: [-720, 720],
      unit: 'deg',
    },
    spin: {
      description:
        'Idle turn while nobody touches it, pausing under the pointer and for 1.5 s after: 0 turns it off.',
      range: [-360, 360],
      unit: 'deg/s',
    },
    drag: {
      description:
        'Turns and tips it under a drag, and with the arrow keys when it has a tabindex.',
    },
    shadow: { description: 'Density of the shadow on the page.', range: [0, 1] },
  },
  frames:
    'Only while it turns, leans, coasts after a drag, flips, and while spin turns it; none at rest, and pointer moves elsewhere draw nothing. Scroll draws frames only with turn.',
  touch:
    'Nothing leans. A tap flips it, unless the image sits in a link or a button. A finger turns it only when the element has `touch-action: pan-y` or `none`, and tips it only with `none`; otherwise the gesture scrolls the page.',
  reducedMotion:
    'It rests as posed: no lean, spin or scroll turn. A click or Enter turns it over at once, without the flip or the toss; dragging and arrow keys still turn it, without coasting.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, and its shadow fades with it.',
  quality: {},
  cost: {
    gpu: 'A disc of about seven hundred triangles; five reads of the picture per pixel of a face for its relief, no environment map.',
    memory: 'The front image, and the back image when given.',
  },
  examples: [
    {
      title: 'A brand logo struck as a gold coin',
      html: '<img src="/brand/logo.svg" alt="Northwind Bank" width="512" height="512" data-dio="coin" tabindex="0" />',
    },
    {
      title: 'An award medal with its back, tossed on a click',
      html: '<img src="/awards/2026-front.png" alt="Best Studio 2026, gold" width="600" height="600" data-dio="coin" data-dio-style="medal" data-dio-motion="toss" data-dio-back="/awards/2026-back.png" />',
    },
    {
      title: 'A loyalty token that turns with the scroll',
      html: '<img src="/club/star.png" alt="Star member token" width="400" height="400" data-dio="coin" data-dio-style="token" data-dio-metal="#1f6f5c" data-dio-turn="180" />',
    },
  ],
}

export default doc
