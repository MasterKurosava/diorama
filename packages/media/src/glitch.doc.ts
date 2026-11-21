import type { EffectDoc } from '@dioramajs/effects'
import type glitch from './glitch'

const doc: EffectDoc<typeof glitch> = {
  category: 'photo',
  tags: ['video', 'scroll'],
  summary:
    'A digital glitch in short bursts: blocks slide sideways, color channels split, scanlines flicker.',
  looks:
    'For a fraction of a second the picture breaks up: horizontal blocks jump sideways and wrap around, red and blue part ways, scanlines darken and the frame flickers, with flashes of static. The pattern jumps twenty times a second and the burst stutters, so it reads as a broken signal rather than an animation. Between bursts the copy is the image as it is. The same seed gives the same glitch on every visit.',
  target: 'img, video',
  params: {
    style: {
      description:
        'rgb splits the colors in thin slices; slice shifts big blocks; vhs wobbles like worn tape.',
    },
    trigger: {
      description:
        'hover plays on enter or tap; interval every few seconds; scroll with speed; load once.',
    },
    strength: {
      description: 'How many blocks break and how far they jump; 0 keeps only split and lines.',
      range: [0, 2],
    },
    blocks: {
      description: 'About how many bands the picture breaks into.',
      range: [2, 40],
      step: 1,
    },
    split: {
      description: 'How far red and blue part, at the peak of a burst.',
      range: [0, 40],
      unit: 'px',
    },
    interval: {
      description: 'Average time between bursts with trigger interval, varied by the seed.',
      range: [0.5, 10],
      unit: 's',
    },
    duration: { description: 'Length of one burst.', range: [0.1, 2], unit: 's' },
    seed: {
      description: 'Which glitch plays: the same seed gives the same one.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'Only during a burst, and with trigger scroll while the page scrolls fast; none at rest. A timer waits between interval bursts without drawing.',
  touch: 'hover plays a burst on tap. The other triggers work the same as with a mouse.',
  reducedMotion:
    'Nothing glitches: sudden flicker can trouble people sensitive to motion and flashing.',
  presence:
    'Leaving a page breaks the copy up and drops it block by block; entering brings it back.',
  quality: {},
  cost: {
    gpu: 'Three texture reads and a few integer hashes per pixel.',
    memory: 'The shared texture of the image or video.',
  },
  examples: [
    { title: 'On hover', html: '<img src="/cover.avif" alt="Album cover" data-dio="glitch" />' },
    {
      title: 'A launch video that glitches every few seconds',
      html: '<video src="/teaser.mp4" autoplay="" muted="" loop="" playsinline="" data-dio="glitch" data-dio-trigger="interval" data-dio-style="vhs"></video>',
    },
    {
      title: 'A hero that breaks up with scroll speed',
      html: '<img src="/drop.avif" alt="The new collection" data-dio="glitch" data-dio-trigger="scroll" data-dio-style="slice" />',
    },
    {
      title: 'A grid whose cards glitch at different moments',
      html: '<div class="grid"><img src="/a.avif" alt="" data-dio="glitch" data-dio-trigger="interval" data-dio-seed="1" /><img src="/b.avif" alt="" data-dio="glitch" data-dio-trigger="interval" data-dio-seed="2" /></div>',
    },
  ],
}

export default doc
