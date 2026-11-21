import type { EffectDoc } from '@dioramajs/effects'
import type box from './box'

const doc: EffectDoc<typeof box> = {
  category: '3d',
  tags: ['photo', 'gallery'],
  summary: 'A product box built from pictures of its faces: turn it, tilt it, open its lid.',
  looks:
    'At rest the front of the box lies exactly where the image was, with a soft shadow under it. Under the pointer the box turns to show its right side and leans toward the pointer; a drag turns it all the way round and tips it to show the top and the bottom. With a motion set, the box also opens on hover: the top flap of a folding carton swings back, the lid of a gift box lifts off, or the tray of a sleeve box slides out, and the box leans forward so the inside shows.',
  target:
    'img: the front of the box; its aspect is the front of the box, and without WebGL the plain front image shows',
  params: {
    motion: {
      description:
        'How the box opens on hover, click or Enter. none stays closed; flap swings the top back on a hinge, as on a folding carton of tea or cosmetics; lift raises a lid over the top fifth, as on a rigid gift box; drawer slides a tray out of a sleeve to the right, as on a box of chocolates or a phone.',
    },
    back: {
      description: 'Back face image URL or color; empty prints the front on the back too.',
    },
    left: {
      description:
        'Left side image URL or color; empty takes the right side picture, else the color of the left edge of the front.',
    },
    right: {
      description:
        'Right side image URL or color; empty takes the left side picture, else the color of the right edge of the front.',
    },
    top: {
      description:
        'Top face image URL or color, its top edge toward the back; empty takes the bottom picture, else the color of the top edge of the front.',
    },
    bottom: {
      description:
        'Bottom face image URL or color; empty takes the top picture, else the color of the bottom edge of the front.',
    },
    inside: {
      description: 'Color of the bare board inside an opening box; empty is an off-white board.',
    },
    depth: {
      description:
        'Depth as a share of the front width, so an 18 × 24 × 6 cm box has 0.33, and 0 a flat card; auto takes it from the side picture, else the top picture, else 0.3.',
      range: [0, 2],
    },
    yaw: {
      description: 'Rest turn; positive shows the right side.',
      range: [-180, 180],
      unit: 'deg',
    },
    pitch: {
      description: 'Rest tilt; positive shows the top.',
      range: [-80, 80],
      unit: 'deg',
    },
    swing: {
      description: 'Turn under the pointer or keyboard focus: 0 keeps it facing the viewer.',
      range: [-90, 90],
      unit: 'deg',
    },
    open: {
      description:
        'Share of the full opening shown on hover; a click or Enter opens it all the way. 0 keeps it shut.',
      range: [0, 1],
    },
    tilt: {
      description: 'How far it leans toward the pointer: 0 turns the lean off.',
      range: [0, 25],
      unit: 'deg',
    },
    spin: {
      description:
        'Idle turn while nobody touches the box, pausing under the pointer and for 1.5 s after: 0 turns it off.',
      range: [-180, 180],
      unit: 'deg/s',
    },
    drag: {
      description:
        'Turns and tips it under a drag, and with the arrow keys when it has a tabindex.',
    },
    shadow: { description: 'Density of the shadow on the page.', range: [0, 1] },
  },
  frames:
    'Only while it turns, leans, opens, coasts after a drag or eases back, and while spin turns it; none at rest, and pointer moves elsewhere draw nothing.',
  touch:
    'Nothing hovers. A tap opens and closes a box with a motion, unless the image sits in a link or a button. A finger turns the box only when the element has `touch-action: pan-y` or `none`, and tips it only with `none`; otherwise the gesture scrolls the page.',
  reducedMotion:
    'It rests as posed: no swing, lean or spin, and hover does not open it. A click or Enter still opens it, at once; dragging and arrow keys still turn it, without coasting.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, and its shadow fades with it.',
  quality: {},
  cost: {
    gpu: 'Six to twenty flat faces with a simple light, no environment map.',
    memory: 'The front image, and the pictures of the other faces when given.',
  },
  examples: [
    {
      title: 'A carton from its front and one side',
      html: '<img src="/shop/tea-front.webp" alt="Morning Hills green tea, 20 bags" width="600" height="800" data-dio="box" data-dio-right="/shop/tea-side.webp" />',
    },
    {
      title: 'A gift box that lifts its lid, turned by the keys',
      html: '<img src="/shop/gift-front.webp" alt="The holiday gift set" width="900" height="600" data-dio="box" data-dio-motion="lift" data-dio-top="/shop/gift-top.webp" data-dio-inside="#7a1f2b" data-dio-depth="0.6" tabindex="0" />',
    },
    {
      title: 'A game box that turns on its own',
      html: '<img src="/games/harbor-front.webp" alt="Harbor Lights, a board game for 2 to 4 players" width="800" height="800" data-dio="box" data-dio-depth="0.25" data-dio-back="/games/harbor-back.webp" data-dio-yaw="-20" data-dio-spin="18" />',
    },
  ],
}

export default doc
