import type { EffectDoc } from '@dioramajs/effects'
import type image from './image'

const doc: EffectDoc<typeof image> = {
  category: 'photo',
  summary:
    'Draws the image or video unchanged, as a GL copy that page flights and other effects build on.',
  looks:
    'Looks exactly like the element: the same object-fit, object-position, border-radius and clipping. It is what a keyed image flies as between pages.',
  target: 'img, video',
  params: {},
  frames:
    'Only when the layout or the picture changes; none at rest. A playing video draws its frames.',
  touch: 'The same as with a mouse.',
  reducedMotion: 'Unchanged, it does not move.',
  presence: 'Fades with the page transition.',
  quality: {},
  cost: { gpu: 'One textured quad.', memory: 'One texture the size of the decoded picture.' },
  examples: [
    { title: 'In markup', html: '<img src="/photo.avif" alt="" data-dio="image" />' },
    {
      title: 'A keyed preview that flies to the next page',
      html: '<a href="/work/north"><img src="/north.avif" alt="North" data-dio-key="north" /></a>',
    },
  ],
}

export default doc
