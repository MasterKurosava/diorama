import type { EffectDoc } from '@dioramajs/effects'
import type pixelate from './pixelate'

const doc: EffectDoc<typeof pixelate> = {
  category: 'photo',
  tags: ['video', 'scroll'],
  summary:
    'The image resolves from big pixels to sharp as it scrolls into view, or breaks into pixels on hover.',
  looks:
    'When enough of the image has entered the viewport it shows as large blocks of color that halve in size step by step, 32, 16, 8, 4, 2 px, until the image itself is there, like a picture loading on an old modem. Each block takes the average color of the part it covers. Blocks can be squares, round dots on the page behind or hexagons, and can shrink smoothly instead of in steps. With trigger hover the image is sharp and breaks into blocks under the pointer.',
  target: 'img, video',
  params: {
    style: {
      description:
        'square draws square blocks; round draws dots, the page between; hex draws hexagons.',
    },
    trigger: {
      description:
        'view resolves it once in view; hover pixelates under the pointer; scroll scrubs it.',
    },
    motion: {
      description: 'steps halves the blocks one size at a time; smooth shrinks them continuously.',
    },
    cell: {
      description: 'Side of the biggest blocks, where the reveal starts and hover ends.',
      range: [4, 128],
      unit: 'px',
    },
    duration: {
      description: 'Length of the reveal, or of the change on hover.',
      range: [0.2, 4],
      unit: 's',
    },
    delay: {
      description: 'Wait after the image comes into view, for a cascade across a grid.',
      range: [0, 2],
      unit: 's',
    },
  },
  frames:
    'Only while the blocks change: during the reveal and the hover change, and with trigger scroll while scrolling. None at rest.',
  touch: 'view and scroll work the same as with a mouse; with hover the image stays sharp.',
  reducedMotion:
    'With view and scroll the image is shown as it is, without blocks. With hover the blocks fade in at full size in 0.15 s instead of growing.',
  presence:
    'Leaving a page breaks the copy into blocks and fades it, entering resolves it. A flight lands on the sharp image.',
  quality: {
    low: 'Each block takes the color at its center instead of the average of four reads.',
  },
  cost: {
    gpu: 'Four texture reads per pixel while blocks show, one on the low tier.',
    memory: 'The shared texture of the image or video.',
  },
  examples: [
    { title: 'In markup', html: '<img src="/piece.avif" alt="Artwork" data-dio="pixelate" />' },
    {
      title: 'Hexagons that resolve smoothly',
      html: '<img src="/piece.avif" alt="Artwork" data-dio="pixelate" data-dio-style="hex" data-dio-motion="smooth" />',
    },
    {
      title: 'Game covers that break into pixels on hover',
      html: '<img src="/cover.avif" alt="Game cover" data-dio="pixelate" data-dio-trigger="hover" data-dio-cell="16" data-dio-duration="0.4" />',
    },
    {
      title: 'A grid that cascades',
      html: '<div class="grid"><img src="/a.avif" alt="" data-dio="pixelate" /><img src="/b.avif" alt="" data-dio="pixelate" data-dio-delay="0.15" /></div>',
    },
  ],
}

export default doc
