import type { EffectDoc } from '@dioramajs/effects'
import type curtain from './curtain'

const doc: EffectDoc<typeof curtain> = {
  category: 'scroll',
  tags: ['photo'],
  summary:
    'A cover picture opens from behind a curtain as you scroll: strips slide away, halves part or a liquid edge drains past.',
  looks:
    'The picture starts covered by a curtain of a solid color or a second picture. As the element scrolls toward the middle of the screen, or as its pinned section scrolls, the curtain opens and casts a soft shadow on the picture at its edge, while the picture settles from a slight zoom. strips slide off one after another, each carrying its slice of the curtain; split parts two halves from the seam, gathering in folds; liquid drains past with a wavy edge and a light rim. Scrolling back closes it again, and with out it closes before the section lets go. Once open it is the picture as it is.',
  target: 'img, video; for by pin, on a sticky stage inside a tall section',
  params: {
    style: {
      description:
        'strips slide off one after another; split parts two halves from the seam with folds; liquid drains past with a wavy edge.',
    },
    by: {
      description:
        'view opens it as the element scrolls from the bottom of the screen to its middle; pin follows the pinned section; manual only position.',
    },
    direction: {
      description:
        'Where the curtain goes: up opens from the bottom. split parts sideways for left and right, up and down for up and down. auto parts split sideways, like a stage curtain, and lifts the others.',
    },
    position: {
      description: 'Opening set by hand, 0 shut to 1 open; with view or pin the least opening.',
      range: [0, 1],
      unit: 'fraction',
    },
    start: {
      description: 'Progress at which it starts to open.',
      range: [0, 1],
      unit: 'fraction',
    },
    end: { description: 'Progress at which it is open.', range: [0, 1], unit: 'fraction' },
    out: {
      description: 'Progress from which it closes again; 1 keeps it open.',
      range: [0, 1],
      unit: 'fraction',
    },
    count: {
      description: 'Strips of strips, folds of each half in split, waves of the liquid edge.',
      range: [1, 12],
      step: 1,
    },
    color: { description: 'Color of the curtain, or what shows while src loads.' },
    src: {
      description:
        'A second picture to use as the curtain, framed like the image, such as a sketch, a title card or the brand pattern.',
    },
    zoom: { description: 'Scale the picture settles from; 1 or 0 for none.', range: [0, 1.5] },
    shade: {
      description:
        'Depth of the shadow at the edge, the folds of split and the rim of liquid; 0 flat.',
      range: [0, 1],
    },
    ease: {
      description: 'Smoothing behind scroll; 0 follows it at once (Lenis already smooths it).',
      range: [0, 1],
      unit: 's',
    },
    seed: { description: 'Shape of the liquid edge.', range: [1, 100], step: 1 },
  },
  frames: 'Scroll draws its own frames, ease keeps drawing until it settles. None at rest.',
  touch: 'The same as with a mouse: it follows the scroll.',
  reducedMotion:
    'Off: the picture is shown as it is, without the curtain, and the engine does not load for it.',
  presence:
    'Leaving a page closes the curtain, entering opens it up to where the scroll has it. A picture on the first screen waits behind a veil until the curtain is drawn.',
  quality: {},
  cost: {
    gpu: 'One texture read of the image per pixel, one more with src, and one of a small noise tile for liquid.',
    memory: 'The image, the src picture when given and a shared 64 x 64 noise tile.',
  },
  examples: [
    {
      title: 'A case study cover that opens as you reach it',
      html: '<img src="/img/cover.avif" alt="Harbour at dawn" style="width: 100%; aspect-ratio: 16 / 9; object-fit: cover" data-dio="curtain" data-dio-color="#f4f1ea" />',
    },
    {
      title: 'A chapter opening in a pinned section',
      html: '<section style="height: 250vh"><div style="position: sticky; top: 0; height: 100vh"><img src="/img/chapter.avif" alt="The valley" style="width: 100%; height: 100%; object-fit: cover" data-dio="curtain" data-dio-by="pin" data-dio-style="split" data-dio-end="0.6" /></div></section>',
    },
    {
      title: 'From the sketch to the photo',
      html: '<img src="/img/house.avif" alt="The finished house" style="object-fit: cover" data-dio="curtain" data-dio-style="liquid" data-dio-src="/img/house-sketch.avif" />',
    },
  ],
}

export default doc
