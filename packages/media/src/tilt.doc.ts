import type { EffectDoc } from '@dioramajs/effects'
import type tilt from './tilt'

const doc: EffectDoc<typeof tilt> = {
  category: 'photo',
  tags: ['block'],
  summary: 'A card image tilts toward the pointer in its own perspective, with glare and foil.',
  looks:
    'The image tilts toward the pointer up to tilt degrees with its own perspective, as CSS perspective on the card would, lifts toward the viewer and catches a glare. With foil a rainbow holographic sheen shifts with the viewing angle inside the mask. A soft shadow lies under it, and leaving lets it settle flat.',
  target: 'img, video',
  params: {
    tilt: { description: 'Largest tilt.', range: [0, 45], unit: 'deg' },
    lift: { description: 'Rise toward the viewer while hovered.', range: [0, 100], unit: 'px' },
    perspective: {
      description: 'Perspective distance of the card.',
      range: [200, 3000],
      unit: 'px',
    },
    ease: { description: 'Smoothing of the tilt.', range: [0, 1], unit: 's' },
    glare: { description: 'Strength of the glare.', range: [0, 1] },
    foil: { description: 'Strength of the holographic foil.', range: [0, 1] },
    mask: { description: 'URL of the foil mask, white where the foil shows.' },
    shadow: { description: 'Density of the shadow under the card.', range: [0, 1] },
    reverse: { description: 'Tilts away from the pointer.' },
    gyro: {
      description:
        'Tilting the phone leans the card where no pointer does, against the angle the phone is held at, which it follows over a few seconds; iOS asks for permission on the first tap.',
    },
  },
  frames:
    'Only while the card tilts or settles; none at rest, and pointer moves outside the card draw nothing.',
  touch:
    'The card tilts toward the finger while it is down; scrolling is never blocked. With gyro the phone tilt leans it, and glare and foil follow.',
  reducedMotion: 'No tilt or lift; glare and foil still follow the pointer.',
  presence: 'Fades with the page transition; a flight carries the flat copy.',
  quality: {},
  cost: {
    gpu: 'A 16 × 16 surface, one noise read for the foil and a shadow plane.',
    memory: 'The image and the optional foil mask.',
  },
  examples: [
    {
      title: 'A collectible card whose foil follows the phone',
      html: '<img src="/cards/0427.png" alt="Card No. 0427" data-dio="tilt" data-dio-foil="0.8" data-dio-gyro="true" />',
    },
    {
      title: 'A ticket with foil',
      html: '<a href="/tickets/0427" class="pass"><img src="/tickets/pass-0427.png" alt="Weekend pass No. 0427" data-dio="tilt" data-dio-foil="0.7" data-dio-mask="/tickets/pass-foil.png" /></a>',
    },
  ],
}

export default doc
