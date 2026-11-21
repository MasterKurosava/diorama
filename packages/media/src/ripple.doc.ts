import type { EffectDoc } from '@dioramajs/effects'
import type ripple from './ripple'

const doc: EffectDoc<typeof ripple> = {
  category: 'photo',
  summary: 'Rings spread from the pointer while the image is hovered.',
  looks:
    'The picture ripples like water around the pointer: round rings whose crests catch a little light, calm right under the pointer. The rings fade out with the distance and settle when the pointer leaves, so at rest the copy matches the image.',
  target: 'img, video',
  params: {
    strength: { description: 'How far the rings displace the picture.', range: [0, 3] },
    frequency: {
      description: 'Rings across the image: higher is denser.',
      range: [5, 100],
      step: 1,
    },
    speed: { description: 'How fast the rings travel outwards.', range: [0, 20] },
  },
  frames: 'While hovered and while the hover fades out; none at rest.',
  touch:
    'Off on touch screens, where nothing hovers: the image stays DOM. An entry with `when: "all"` turns it on.',
  reducedMotion: 'Runs with hover held at 0, which shows the image unchanged.',
  presence: 'Fades with the page transition.',
  quality: {},
  cost: {
    gpu: 'One textured quad with a few math operations per pixel.',
    memory: 'The shared texture of the image.',
  },
  examples: [
    { title: 'In markup', html: '<img src="/photo.avif" alt="" data-dio="ripple" />' },
    {
      title: 'Stronger and denser',
      html: '<img src="/photo.avif" alt="" data-dio="ripple" data-dio-strength="2" data-dio-frequency="60" />',
    },
    {
      title: 'From code',
      html: '<div class="gallery"><img src="/a.avif" alt="" /><img src="/b.avif" alt="" /></div>',
      ts: "app.attach('.gallery img', 'ripple', { strength: 1.5 })",
    },
  ],
}

export default doc
