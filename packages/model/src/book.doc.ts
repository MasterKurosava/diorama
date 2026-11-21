import type { EffectDoc } from '@dioramajs/effects'
import type book from './book'

const doc: EffectDoc<typeof book> = {
  category: '3d',
  tags: ['photo', 'gallery'],
  summary: 'A cover image made a 3D book that turns to show its spine and opens on hover.',
  looks:
    'At rest the book faces the viewer, its cover exactly where the image was, with a soft shadow under it. Under the pointer it swings to show its spine and the front cover opens a little over the cream page edges. A drag turns it all the way round to the back cover.',
  target:
    'img: the front cover; the box is the cover, and without WebGL the plain cover image shows',
  params: {
    style: {
      description:
        'hardcover has thick boards over the pages and a rounded spine; paperback a thin flush cover and a flat spine.',
    },
    pages: { description: 'Page count, which sets the thickness.', range: [16, 1600] },
    spine: {
      description: 'Spine color or image URL; empty takes the color of the left edge of the cover.',
    },
    back: { description: 'Back cover image URL or color; empty uses the spine color.' },
    yaw: {
      description: 'Rest turn; positive shows the spine.',
      range: [-180, 180],
      unit: 'deg',
    },
    swing: {
      description: 'Turn under the pointer or keyboard focus.',
      range: [0, 60],
      unit: 'deg',
    },
    open: { description: 'How far the front cover opens on hover.', range: [0, 60], unit: 'deg' },
    tilt: { description: 'How far it leans toward the pointer.', range: [0, 25], unit: 'deg' },
    drag: { description: 'Turns it under a drag, and with the arrow keys when it has a tabindex.' },
    shadow: { description: 'Density of the shadow on the page.', range: [0, 1] },
  },
  frames:
    'Only while it swings, opens, leans, coasts after a drag or eases back; none at rest, and pointer moves elsewhere draw nothing.',
  touch:
    'Nothing hovers. A finger turns the book only when the element has `touch-action: pan-y` or `none`, otherwise the gesture scrolls the page.',
  reducedMotion:
    'It rests facing the viewer: no swing, opening or lean. Dragging and arrow keys still turn it, without coasting.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, and its shadow fades with it.',
  quality: {},
  cost: {
    gpu: 'About two thousand triangles with a simple light, no environment map.',
    memory: 'The cover, and the spine and back images when given.',
  },
  examples: [
    {
      title: 'A hardcover from its cover',
      html: '<img src="/books/tidewater.jpg" alt="Tidewater, a novel" width="800" height="1200" data-dio="book" />',
    },
    {
      title: 'A paperback with its own spine and back',
      html: '<img src="/books/field-notes.jpg" alt="Field Notes" width="800" height="1200" data-dio="book" data-dio-style="paperback" data-dio-pages="180" data-dio-spine="/books/field-notes-spine.jpg" data-dio-back="/books/field-notes-back.jpg" />',
    },
    {
      title: 'A course workbook turned by the arrow keys',
      html: '<img src="/course/workbook.png" alt="The course workbook" width="900" height="1200" data-dio="book" data-dio-spine="#1d3b5a" data-dio-yaw="20" tabindex="0" />',
    },
  ],
}

export default doc
