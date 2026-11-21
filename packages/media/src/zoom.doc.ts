import type { EffectDoc } from '@dioramajs/effects'
import type zoom from './zoom'

const doc: EffectDoc<typeof zoom> = {
  category: 'photo',
  tags: ['gallery'],
  summary: 'Hovering an image shows a sharp, magnified view of it under the pointer.',
  looks:
    'Over the image a high-resolution version shows magnified zoom times. In inner mode the whole box shows it and follows the pointer without empty margins; in lens mode a round loupe with a glassy rim; in side mode another element shows it and the image marks the area. Until the large file arrives the image itself is magnified, then it crossfades.',
  target: 'img',
  params: {
    mode: { description: 'inner fills the box, lens shows a loupe, side uses another element.' },
    trigger: {
      description:
        'hover shows the view while the pointer is over the image; click shows it on a click and hides it on the next click or when the pointer leaves, so moving across the page does not zoom.',
    },
    zoom: { description: 'Magnification over the shown picture.', range: [1, 8] },
    radius: { description: 'Radius of the loupe.', range: [20, 200], unit: 'px' },
    ease: {
      description: 'Smoothing of the view following the pointer.',
      range: [0, 0.5],
      unit: 's',
    },
    full: {
      description: 'URL of the large picture; empty takes a linked image, srcset or currentSrc.',
    },
    into: { description: 'Selector of the empty element that shows the view in side mode.' },
    resolution: {
      description: 'Cap on the long side when decoding the large picture.',
      range: [512, 8192],
      unit: 'px',
    },
  },
  frames:
    'Only while the view appears, follows or leaves; none at rest, and pointer moves outside the image draw nothing.',
  touch:
    'Not loaded on touch screens: it runs where (hover: hover) and (pointer: fine) match. With when: all, a tap toggles the view at its point, and a drag moves it where the image has touch-action: none or pinch-zoom.',
  reducedMotion: 'No smoothing and no fade: the view follows the pointer at once.',
  presence: 'Fades with the page transition; a flight starts without magnification.',
  quality: {
    low: 'Decodes at most 2048 px on the long side.',
    medium: 'Decodes at most 3072 px on the long side.',
  },
  cost: {
    gpu: 'One or two texture reads per pixel.',
    memory: 'The large picture while hovered and 10 s after: about 31 MB at 2400 px with mipmaps.',
  },
  examples: [
    {
      title: 'A product photo with a larger source',
      html: '<img src="/p/watch-800.avif" srcset="/p/watch-800.avif 800w, /p/watch-2400.avif 2400w" sizes="50vw" alt="Field watch, steel case" data-dio="zoom" data-dio-full="/p/watch-3600.avif" />',
    },
    {
      title: 'Zoom on click, with a cursor that says so',
      html: '<img src="/p/fabric.avif" alt="Wool tweed, close weave" data-dio="zoom" data-dio-trigger="click" data-dio-zoom="4" style="cursor: zoom-in" />',
    },
    {
      title: 'The view in a pane next to the image',
      html: '<img src="/p/bag.avif" alt="Weekender bag" data-dio="zoom" data-dio-mode="side" data-dio-into="#pane" /><div id="pane" aria-hidden="true"></div>',
    },
  ],
}

export default doc
