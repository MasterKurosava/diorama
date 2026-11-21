import type { EffectDoc } from '@dioramajs/effects'
import type hoverPreview from './hover-preview'

const doc: EffectDoc<typeof hoverPreview> = {
  category: 'gallery',
  tags: ['photo'],
  summary:
    'Over a list of projects, the picture of the item under the pointer follows the pointer, stands beside the item or holds a fixed place.',
  looks:
    'While the pointer is over an item, its picture floats at the pointer: it appears from a slight shrink, trails behind with a stretch along the motion, a soft bow and a tilt from the speed, and crossfades into the next item’s picture with a small settle. Leaving the list fades it out. In beside mode the picture stands next to the hovered item’s text and glides from row to row; in fixed mode it holds one place by the list and only crossfades. The list stays as you wrote it: text, links, focus and selection are the DOM, nothing is hidden.',
  target: 'a list of links, such as an index of projects',
  params: {
    mode: {
      description:
        'follow floats the picture at the pointer; beside places it after the item’s text, gliding between rows, for a wide list; fixed keeps it at the middle of the list moved by offset, for a preview column next to the list.',
    },
    items: { description: 'Selector of the items inside the list.' },
    width: { description: 'Width of the picture.', range: [80, 800], unit: 'px' },
    ratio: {
      description:
        'Width over height of the picture frame; auto takes the proportions of the picture.',
      range: [0.1, 3],
    },
    ease: {
      description: 'How far the picture trails the pointer or the row, as a time constant.',
      range: [0, 1],
      unit: 's',
    },
    stretch: {
      description: 'Stretch and bow from the pointer’s speed; 0 keeps the picture flat.',
      range: [0, 1],
    },
    tilt: { description: 'Most tilt from horizontal speed.', range: [0, 30], unit: 'deg' },
    duration: {
      description: 'Length of the appearance and the crossfade.',
      range: [0, 1.5],
      unit: 's',
    },
    offset: {
      description:
        'Shift of the picture’s center from the pointer, the item or the list’s middle, x and y down as in CSS.',
      range: [-400, 400],
      unit: 'px',
    },
    radius: { description: 'Corner radius of the picture.', range: [0, 64], unit: 'px' },
  },
  frames:
    'Only while the picture appears, moves, crossfades or leaves; none at rest, and pointer moves elsewhere on the page draw nothing.',
  touch:
    'Not loaded on touch screens: the effect only runs where (hover: hover) and (pointer: fine) match, and the list stays a list.',
  reducedMotion:
    'The picture sits at its place without stretch, tilt or trailing; it appears and changes by a 0.15 s fade.',
  presence: 'The picture fades with the page as it leaves.',
  quality: {},
  cost: {
    gpu: 'One small plane of 16 × 16 cells over everything, two texture reads during a crossfade.',
    memory:
      'Up to eight pictures at a time: the item, its neighbors and the latest ones. Keep them at 800 px or less on the long side.',
  },
  examples: [
    {
      title: 'Pictures from attributes',
      html: '<ol class="index" data-dio="hover-preview" data-dio-width="360"><li data-dio-src="/work/north.avif"><a href="/work/north">North</a><span>2026</span></li><li data-dio-src="/work/tide.avif"><a href="/work/tide">Tide</a><span>2025</span></li></ol>',
    },
    {
      title: 'A preview column beside the list',
      html: '<ol class="index" data-dio="hover-preview" data-dio-mode="fixed" data-dio-offset="420 0" data-dio-width="360"><li data-dio-src="/work/north.avif"><a href="/work/north">North</a></li><li data-dio-src="/work/tide.avif"><a href="/work/tide">Tide</a></li></ol>',
    },
    {
      title: 'An image inside the item, hidden by the site, keeps srcset',
      html: '<ul class="index" data-dio="hover-preview" data-dio-ratio="1.333"><li><a href="/work/arc">Arc <img src="/work/arc.avif" srcset="/work/arc-800.avif 800w" alt="" hidden=""></a></li></ul>',
    },
    {
      title: 'Under the text, with a blend mode on the names',
      html: '<ol class="index" data-dio="hover-preview" data-dio-offset="40 -20" data-dio-radius="8"><li data-dio-src="/work/north.avif"><a href="/work/north" style="color: #fff; mix-blend-mode: difference">North</a></li></ol>',
      ts: "start({ canvas: 'behind' })",
    },
  ],
  children: [
    {
      attribute: 'data-dio-src',
      description:
        'URL of the item’s picture; without it, the current source of the first <img> inside the item. An item with neither shows nothing.',
    },
  ],
}

export default doc
