import type { EffectDoc } from '@dioramajs/effects'
import type flare from './flare'

const doc: EffectDoc<typeof flare> = {
  category: 'photo',
  tags: ['scroll'],
  summary:
    'A lens flare or a glossy light sweep over a photo that follows the pointer or the scroll.',
  looks:
    'A warm light source sits on the photo: a soft glow with a hot core and, in lens style, a row of tinted ghosts along the line from the light through the centre of the frame, like a real lens. In sweep style a glossy band runs through the light at angle and catches the highlights of the picture, the way light slides over chrome or a watch case. The light follows the pointer and fades out when it leaves, travels across the photo with the scroll, or stays put. It is screened over the photo, so it brightens without clipping to white.',
  target: 'img, video',
  params: {
    style: {
      description:
        'lens draws a glow with ghosts along the axis through the centre; sweep draws a glossy band through the light that brightens the highlights.',
    },
    by: {
      description:
        'pointer: the light follows the pointer and fades out when it leaves; scroll: it travels across the photo as the page scrolls; fixed: it stays at position.',
    },
    strength: {
      description: 'Brightness of the whole flare: 0 turns it off.',
      range: [0, 2],
    },
    glow: {
      description: "Radius of the glow as a share of the photo's shorter side: 0 hides the glow.",
      range: [0, 1],
      unit: 'fraction',
    },
    ghosts: {
      description: 'Number of ghosts along the axis in lens style, up to 8: 0 shows none.',
      range: [0, 8],
      step: 1,
    },
    streak: {
      description:
        'Brightness of a thin anamorphic streak across the frame, in a cool tint: 0 hides it.',
      range: [0, 1],
    },
    color: { description: 'Color of the light; the streak takes a cooler shade of it.' },
    position: {
      description:
        'Where the light rests, sits with by fixed and travels through with by scroll, as shares of the box from its top left.',
      range: [0, 1],
      unit: 'fraction',
    },
    travel: {
      description:
        'With by scroll, how far the light moves across the photo, as a share of its width: 0 keeps it at position.',
      range: [0, 2],
      unit: 'fraction',
    },
    angle: {
      description:
        'Direction the sweep band runs across, like a CSS gradient angle: 90 is vertical.',
      range: [0, 180],
      unit: 'deg',
    },
    width: {
      description: "Width of the sweep band as a share of the photo's diagonal.",
      range: [0.02, 1],
      unit: 'fraction',
    },
    rest: {
      description:
        'With by pointer, the share of the light kept while the pointer is away, at position: 0 shows the plain photo at rest.',
      range: [0, 1],
    },
    ease: {
      description: 'Smoothing of the light following the pointer: 0 sticks to it.',
      range: [0, 0.5],
      unit: 's',
    },
    duration: {
      description: 'Length of the fade as the pointer light comes on and goes off.',
      range: [0, 1.5],
      unit: 's',
    },
  },
  frames:
    'With by pointer, only while the light fades or trails the pointer; with by scroll, only while the page scrolls; none at rest and none with by fixed.',
  touch:
    'With by pointer the light follows a finger while it is pressed and goes when it lifts; add touch-action: none to the image to keep a drag from scrolling the page. by scroll works the same on phones.',
  reducedMotion:
    'No fade and no smoothing: the pointer light appears, jumps and goes at once. With by scroll the light stays at position.',
  presence: 'Fades with the page transition; a flight carries the photo without the pointer light.',
  quality: {},
  cost: {
    gpu: 'One texture read per pixel and a handful of exponentials; the ghosts are math, not reads.',
    memory: 'The image only.',
  },
  examples: [
    {
      title: 'A hero car shot that catches the light under the pointer',
      html: '<img src="/cars/coupe.avif" alt="Silver coupe on a coastal road at dusk" data-dio="flare" data-dio-streak="0.4" data-dio-rest="0.3" />',
    },
    {
      title: 'Light sliding over a watch case as the page scrolls',
      html: '<img src="/watch/case.avif" alt="Steel watch case, side view" data-dio="flare" data-dio-style="sweep" data-dio-by="scroll" data-dio-travel="1.2" data-dio-glow="0.1" />',
    },
    {
      title: 'A low sun fixed in the corner of a landscape',
      html: '<img src="/trips/ridge.avif" alt="Mountain ridge at sunrise" data-dio="flare" data-dio-by="fixed" data-dio-position="0.85 0.15" data-dio-ghosts="6" />',
    },
  ],
}

export default doc
