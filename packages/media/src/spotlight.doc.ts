import type { EffectDoc } from '@dioramajs/effects'
import type spotlight from './spotlight'

const doc: EffectDoc<typeof spotlight> = {
  category: 'photo',
  tags: ['video'],
  summary: 'A flashlight over a photo: the image darkens around a soft circle at the pointer.',
  looks:
    'While the pointer is over the image, everything outside a circle of radius px around it fades toward color by dim, and the circle trails the pointer by ease. In reveal style the circle shows a second picture instead, like an x-ray or a before and after; in blur style the outside is also blurred by blur px. When the pointer leaves, the light closes and the image returns to its full look, or to a resting dim set by rest.',
  target: 'img, video',
  params: {
    style: {
      description:
        'light darkens the rest; reveal shows the src picture in the circle; blur blurs the rest too.',
    },
    radius: { description: 'Radius of the lit circle.', range: [20, 600], unit: 'px' },
    softness: {
      description: 'Share of the radius that fades from light to dark: 0 is a hard edge.',
      range: [0, 1],
    },
    dim: {
      description: 'How far the image outside the light goes toward color: 0 keeps it as is.',
      range: [0, 1],
    },
    color: { description: 'Shade the outside fades toward, black by default.' },
    blur: {
      description: 'Blur radius outside the light in blur style.',
      range: [0, 40],
      unit: 'px',
    },
    rest: {
      description: 'Share of dim kept while the pointer is away: 0 shows the full image at rest.',
      range: [0, 1],
    },
    ease: {
      description: 'Smoothing of the light following the pointer: 0 sticks to it.',
      range: [0, 0.5],
      unit: 's',
    },
    duration: {
      description: 'Length of the fade as the light comes on and goes off.',
      range: [0, 1.5],
      unit: 's',
    },
    src: { description: 'URL of the picture the circle shows in reveal style.' },
  },
  frames:
    'Only while the light fades or trails the pointer; none at rest, and a still pointer draws nothing.',
  touch:
    'The light follows a finger while it is pressed and goes when it lifts. Add touch-action: none to the image to keep a drag from scrolling the page.',
  reducedMotion: 'No fade and no smoothing: the light appears, jumps and goes at once.',
  presence: 'Fades with the page transition; a flight carries the image without the light.',
  quality: { low: 'Blur radius at most 8 px.' },
  cost: {
    gpu: 'One texture read per pixel; 17 in blur style, 2 in reveal style.',
    memory: 'The image, plus the second picture in reveal style.',
  },
  examples: [
    {
      title: 'A museum piece seen by flashlight',
      html: '<img src="/collection/astrolabe.avif" alt="Brass astrolabe, 1580" data-dio="spotlight" data-dio-radius="160" data-dio-rest="0.6" />',
    },
    {
      title: 'An x-ray under the pointer',
      html: '<img src="/watch/front.avif" alt="Field watch, front" data-dio="spotlight" data-dio-style="reveal" data-dio-src="/watch/movement.avif" data-dio-dim="0" style="touch-action: none" />',
    },
    {
      title: 'Find the detail: the rest out of focus',
      html: '<img src="/rooms/loft.avif" alt="Loft bedroom with oak beams" data-dio="spotlight" data-dio-style="blur" data-dio-dim="0.3" data-dio-blur="16" />',
    },
  ],
}

export default doc
