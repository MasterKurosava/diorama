import type { EffectDoc } from '@dioramajs/effects'
import type explode from './explode'

const doc: EffectDoc<typeof explode> = {
  category: '3d',
  tags: ['scroll'],
  summary: 'An exploded view of a model: its parts move apart as the section scrolls.',
  looks:
    'Works on the `model` of the same element. As the visitor scrolls through a sticky section, the parts of the product move apart one after another, the outer ones first, and come back together on the way up, so a page can show what is inside headphones, a watch, a speaker or a chair. The model shrinks a little as it opens so the exploded view stays in its box, and can turn as it opens. Drag, swatches and the rest pose of `model` keep working.',
  target:
    'an element with the `model` effect: `data-dio="model explode"`, inside a tall `data-dio-section` with a sticky stage',
  params: {
    mode: {
      description:
        'radial moves each part away from the center by its own distance; axis stacks the parts in even levels along `axis`, like a watch or a speaker taken apart; extras takes the offsets the modeler wrote as glTF node extras `"explode": [x, y, z]`, in model units.',
    },
    by: {
      description:
        'What drives it: pin of the sticky section, viewport progress, or `position` alone for a button or a tween.',
    },
    pieces: {
      description:
        'Node names of the parts to move, comma separated; empty takes the children of the model root (or every node with extras in extras mode).',
    },
    axis: {
      description: 'Direction of the axis mode, in model coordinates: x y z.',
      range: [-1, 1],
    },
    spread: {
      description: 'How far the parts move: 1 as the mode lays them out, 0 keeps them in place.',
      range: [0, 3],
    },
    start: {
      description: 'Progress at which the parts start to move.',
      range: [0, 1],
      unit: 'fraction',
    },
    end: {
      description: 'Progress at which they are fully apart.',
      range: [0, 1],
      unit: 'fraction',
    },
    position: {
      description: 'How far apart with `by="manual"`: 0 assembled, 1 exploded.',
      range: [0, 1],
      unit: 'fraction',
    },
    cascade: {
      description: 'Share of the run by which the parts start one after another, outer ones first.',
      range: [0, 0.9],
      unit: 'fraction',
    },
    twist: {
      description: 'Turns around the vertical while it opens; 0 does not turn.',
      range: [-360, 360],
      unit: 'deg',
    },
    ease: {
      description: 'Time the parts take to catch up with the scroll; 0 follows it exactly.',
      range: [0, 1],
      unit: 's',
    },
    contain: {
      description:
        'Keeps every part inside the box at every step: the model shrinks and recenters as it opens, measured in its rest pose and in perspective.',
    },
  },
  frames: 'Only on scroll, and while the parts catch up with it for `ease` seconds; none at rest.',
  touch: 'Scroll drives it, so touch works as on desktop.',
  reducedMotion:
    'The exploded view stands still, parts apart and without the turn, wherever the page is scrolled. With `by="manual"` the parts jump to `position` without easing.',
  presence: 'Nothing of its own: the model leaves by dithering, with its parts where they are.',
  quality: {},
  cost: {
    gpu: 'None of its own: the model draws as it does without it.',
    memory: 'A few vectors per part.',
  },
  examples: [
    {
      title: 'Speaker taken apart in a sticky section',
      html: '<section data-dio-section="" style="height: 300vh"><div style="position: sticky; top: 0; height: 100vh"><div class="viewer" data-dio="model explode" data-dio-src="/models/speaker.glb" data-dio-mode="axis"><img src="/models/speaker.avif" alt="Speaker" /></div></div></section>',
    },
    {
      title: 'Offsets from the model file',
      html: '<div class="viewer" data-dio="model explode" data-dio-src="/models/watch.glb" data-dio-mode="extras" data-dio-twist="90"><img src="/models/watch.avif" alt="Watch" /></div>',
    },
    {
      title: 'A button opens it',
      html: '<div class="viewer" data-dio="model explode" data-dio-src="/models/chair.glb" data-dio-by="manual"><img src="/models/chair.avif" alt="Chair" /></div><button type="button" onclick="this.previousElementSibling.dataset.dioPosition = this.previousElementSibling.dataset.dioPosition === \'1\' ? \'0\' : \'1\'">Take apart</button>',
    },
  ],
}

export default doc
