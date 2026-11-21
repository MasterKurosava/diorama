import type { EffectDoc } from '@dioramajs/effects'
import type reflection from './reflection'

const doc: EffectDoc<typeof reflection> = {
  category: 'photo',
  tags: ['3d'],
  summary:
    'A soft reflection on a glossy floor under a product photo, without baking it into the image.',
  looks:
    "Below the image the picture is mirrored, as if the product stood on polished stone or glass: the reflection starts at the product's base, fades out over reach of the image's height and blurs with distance. For a cutout with transparent padding the base is its lowest solid row, so the reflection touches the product, not the edge of the file. A contact shadow can ground it, and a ripple turns the floor into still water.",
  target: 'img, video',
  params: {
    strength: {
      description: 'Opacity of the reflection at the base: 0 hides it and leaves only the shadow.',
      range: [0, 1],
    },
    reach: {
      description: "How far the reflection runs down, as a share of the element's height.",
      range: [0, 1],
      unit: 'fraction',
    },
    blur: {
      description:
        'Blur at the far end of the reflection, growing from sharp at the base: 0 is a mirror.',
      range: [0, 40],
      unit: 'px',
    },
    gap: {
      description: 'Space between the base and the reflection; negative pulls it up.',
      range: [-40, 40],
      unit: 'px',
    },
    trim: {
      description:
        'Mirror at the lowest solid row of a transparent picture and at the drawn bottom under object-fit; false mirrors at the bottom of the box.',
    },
    ripple: {
      description: 'Sway of a water ripple in the reflection: 0 is a still floor.',
      range: [0, 20],
      unit: 'px',
    },
    shadow: {
      description: 'Darkness of a soft contact shadow under the base: 0 draws none.',
      range: [0, 1],
    },
    fps: {
      description: 'Frames a second the ripple draws at while visible.',
      range: [1, 60],
      step: 1,
    },
  },
  frames:
    'Once when it appears and on layout changes; with a ripple, at most fps a second while visible. None at rest.',
  touch: 'The same as on desktop: the reflection does not react to input.',
  reducedMotion: 'The ripple stands still; the reflection itself is not motion.',
  presence: 'Fades with the page transition.',
  quality: {
    low: 'No blur, one texture read per pixel of the reflection; the ripple at most 15 frames a second.',
  },
  cost: {
    gpu: 'Twelve texture reads per pixel of the reflection for the blur and eight for the shadow, only below the image.',
    memory: 'The image as a texture; the element itself stays DOM.',
  },
  examples: [
    {
      title: 'A speaker cutout on a glossy shelf',
      html: '<img src="/shop/speaker.png" alt="Bookshelf speaker in walnut" data-dio="reflection" data-dio-shadow="0.35" style="margin-bottom: 160px" />',
    },
    {
      title: 'A phone mockup on dark glass',
      html: '<img src="/app/phone.png" alt="The app on a phone, home screen" data-dio="reflection" data-dio-strength="0.25" data-dio-reach="0.3" data-dio-blur="4" />',
    },
    {
      title: 'A boathouse photo over still water',
      html: '<img src="/stays/boathouse.avif" alt="Wooden boathouse at dawn" data-dio="reflection" data-dio-strength="0.6" data-dio-reach="0.6" data-dio-ripple="6" />',
    },
  ],
}

export default doc
