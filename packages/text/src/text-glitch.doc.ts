import type { EffectDoc } from '@dioramajs/effects'
import type textGlitch from './text-glitch'

const doc: EffectDoc<typeof textGlitch> = {
  category: 'text',
  tags: ['scroll'],
  summary:
    'A heading glitches in depth: it breaks into slabs that jump at the viewer, then snaps back flat.',
  looks:
    'For about two thirds of a second the text breaks into horizontal slabs that jump sideways and towards or away from the viewer, turning in real perspective. Red and cyan layers sit at different depths behind and in front of the letters, so they part as the line tilts. The slice style turns struck slabs into solid blocks with shaded sides; vhs leans the line back with a hologram of scanlines trailing behind it and bends it like worn tape. The pattern jumps twenty times a second; a burst hits twice, with a moment of lost signal between the hits where the text dims, then the element is the real text again, selectable and crisp.',
  target:
    'a heading, a label, a link or a button with text. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'rgb tilts the line and parts its color layers; slice extrudes blocks; vhs is a hologram.',
    },
    trigger: {
      description:
        'hover on pointer, focus or tap; interval every few seconds; scroll with speed; load once.',
    },
    strength: {
      description: 'How many slabs break and how far they jump and turn; 0 keeps them in place.',
      range: [0, 2],
    },
    split: {
      description: 'How far the red and cyan layers part in depth and sideways; 0 for none.',
      range: [0, 40],
      unit: 'px',
    },
    slices: {
      description: 'About how many slabs each line of text breaks into.',
      range: [1, 16],
      step: 1,
    },
    interval: {
      description: 'Average time between bursts with trigger interval, varied by the seed.',
      range: [0.5, 10],
      unit: 's',
    },
    duration: {
      description: 'Length of one burst; from 0.4 s it hits twice with the signal lost between.',
      range: [0.1, 2],
      unit: 's',
    },
    seed: {
      description: 'Which glitch plays: the same seed gives the same one.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'Only during a burst, and with trigger scroll while the page scrolls fast; none at rest. A timer waits between interval bursts without drawing.',
  touch:
    'hover plays a burst on tap and on keyboard focus. The other triggers work the same as with a mouse.',
  reducedMotion:
    'Off: the text is shown as it is, and the engine does not load for it. Sudden flicker can trouble people sensitive to motion and flashing. With motion on, the text dims at most 3 times in any second, under the WCAG flash threshold.',
  presence:
    'Leaving a page the slabs fly at the viewer and drop out one by one; entering they fall back into place.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'One instanced draw of a quad per layer of a slab, one texture read per pixel; a block adds 14 layers to its slab, the hologram 7.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, kept while the element lives.',
  },
  examples: [
    { title: 'On hover', html: '<h2 data-dio="text-glitch">Signal lost</h2>' },
    {
      title: 'A launch headline that breaks into blocks every few seconds',
      html: '<h1 data-dio="text-glitch" data-dio-trigger="interval" data-dio-style="slice">Drop 07 is live</h1>',
    },
    {
      title: 'A hologram title, once as it shows',
      html: '<h2 data-dio="text-glitch" data-dio-style="vhs" data-dio-trigger="load">Transmission 1994</h2>',
    },
    {
      title: 'A card title that glitches when its card is hovered',
      html: '<a class="card" href="/games/afterlight"><img src="/afterlight.avif" alt="" /><h3 data-dio="text-glitch">Afterlight</h3></a>',
    },
  ],
}

export default doc
