import type { EffectDoc } from '@dioramajs/effects'
import type bend from './bend'

const doc: EffectDoc<typeof bend> = {
  category: 'photo',
  tags: ['scroll'],
  summary: 'Scroll speed bends the image like paper and splits its color channels.',
  looks:
    'While the page scrolls the image bows against the motion, like paper dragged through air, and its red and blue channels drift apart. It straightens as the scroll slows, so at rest the copy matches the image.',
  target: 'img, video',
  params: {
    strength: { description: 'How far the image bows at full scroll speed.', range: [0, 3] },
    split: { description: 'How far the red and blue channels drift apart.', range: [0, 3] },
  },
  frames: 'While the page scrolls and its speed settles; none at rest.',
  touch: 'The same on touch: it follows the scroll.',
  reducedMotion: 'Runs with scroll velocity held at 0, which shows the image unchanged.',
  presence: 'Fades with the page transition.',
  quality: {},
  cost: {
    gpu: 'A 32 x 32 grid and three texture reads per pixel.',
    memory: 'The shared texture of the image.',
  },
  examples: [
    { title: 'In markup', html: '<img src="/photo.avif" alt="" data-dio="bend" />' },
    {
      title: 'Together with ripple',
      html: '<img src="/photo.avif" alt="" data-dio="ripple bend" data-dio-bend-split="2" />',
    },
  ],
}

export default doc
