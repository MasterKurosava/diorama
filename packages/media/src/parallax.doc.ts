import type { EffectDoc } from '@dioramajs/effects'
import type parallax from './parallax'

const doc: EffectDoc<typeof parallax> = {
  category: 'photo',
  tags: ['video', 'scroll'],
  summary:
    'The image drifts inside its frame with the pointer and the scroll; with a depth map, in 2.5D.',
  looks:
    'The picture is shown slightly enlarged and moves within its box: away from the pointer while it is over the image, and down through the frame as the page scrolls, centered when the box is centered. With a depth map (a grayscale image of the same frame, white is near) near parts move more than far ones and pass in front of them, so a flat photo turns into a shallow 3D scene. Where depth jumps sharply the far side shows a stretched sliver; a slightly blurred map hides it.',
  target: 'img, video',
  params: {
    depth: {
      description: 'How far the pointer moves the picture, as a share of the box.',
      range: [0, 0.2],
      unit: 'fraction',
    },
    scroll: {
      description: 'How far the picture travels while the box crosses the viewport.',
      range: [0, 0.5],
      unit: 'fraction',
    },
    ease: { description: 'How softly the picture follows the pointer.', range: [0, 1], unit: 's' },
    map: {
      description: 'URL of a depth map for the same frame, white near; empty for a flat shift.',
    },
    focus: {
      description:
        'Depth that stays put, 0 far to 1 near; nearer parts move one way, farther the other.',
      range: [0, 1],
    },
  },
  frames:
    'While the pointer moves over it and the motion settles, and while scrolling; none at rest.',
  touch:
    'The pointer part is off on devices without hover, so taps do not jolt the picture; the scroll part works.',
  reducedMotion: 'Off: the image is shown as it is, and the engine does not load for it.',
  presence: 'Fades with the page transition. A keyed flight carries the framing it had.',
  quality: {
    low: 'Depth search in 3 layers, refined 3 times.',
    medium: 'Depth search in 6 layers, refined 4 times.',
    high: 'Depth search in 10 layers, refined 5 times.',
  },
  cost: {
    gpu: 'One texture read per pixel; with a depth map 7 to 16 reads of the map, by quality tier.',
    memory:
      'The shared texture of the image, plus the depth map. A map half the size of the image, as a grayscale PNG, is enough.',
  },
  examples: [
    {
      title: 'In markup',
      html: '<img src="/hero.avif" alt="Studio at night" data-dio="parallax" />',
    },
    {
      title: 'A portrait in 2.5D',
      html: '<img src="/portrait.avif" alt="" data-dio="parallax" data-dio-map="/portrait-depth.png" data-dio-depth="0.03" />',
    },
    {
      title: 'Scroll only, a deeper drift',
      html: '<img src="/wide.avif" alt="" data-dio="parallax" data-dio-depth="0" data-dio-scroll="0.2" />',
    },
  ],
}

export default doc
