import type { EffectDoc } from '@dioramajs/effects'
import type liquid from './liquid'

const doc: EffectDoc<typeof liquid> = {
  category: 'photo',
  tags: ['gallery'],
  summary: 'The pointer leaves a fluid trail on a photo that settles back like water.',
  looks:
    'Where the pointer passes, the picture bends as if seen through moving water: a wake follows the path, spreads, drifts a little and fades out over duration, after which the copy matches the image again. Unlike ripple, which draws rings around a hovering pointer for as long as it stays, liquid reacts only to movement, follows the path the pointer took and goes still on its own.',
  target: 'img, video',
  params: {
    style: {
      description:
        'water refracts the picture by the slope of the wake and lights its edges; smear drags the picture along the path like a finger through wet paint; prism drags it and splits the trail into red and blue fringes.',
    },
    strength: {
      description: 'How far the trail moves the picture: 0 turns the effect off.',
      range: [0, 3],
    },
    radius: { description: 'Width of the trail around the path.', range: [10, 300], unit: 'px' },
    duration: {
      description: 'Time the trail takes to settle after the pointer stops.',
      range: [0.2, 5],
      unit: 's',
    },
    swirl: {
      description: 'How much the wake drifts along itself as it fades: 0 keeps it in place.',
      range: [0, 2],
    },
    shine: {
      description: 'Light on the edges of the wake in water style: 0 refracts without light.',
      range: [0, 2],
    },
    split: {
      description: 'Width of the color fringes in prism style: 0 leaves the colors together.',
      range: [0, 4],
    },
    resolution: {
      description:
        'Cells of the trail along each side of the image: more is finer and costs more CPU.',
      range: [16, 128],
      step: 8,
    },
  },
  frames:
    'Only while a trail is settling, about duration after the last move; none at rest, and a still pointer draws nothing.',
  touch:
    'A pressed finger draws the trail. Without touch-action on the image a vertical swipe still scrolls the page, and the trail stops where the scroll takes over; add touch-action: none for drawing without scrolling.',
  reducedMotion: 'Off: the image stays DOM and nothing loads for it.',
  presence: 'Fades with the page transition, which takes the image without its trail.',
  quality: { low: 'At most 32 cells per side.' },
  cost: {
    gpu: 'One texture read per pixel for the trail plus the picture; three in prism style.',
    memory: 'A 64 × 64 half-float texture, 32 KB, besides the image.',
  },
  examples: [
    {
      title: 'A hero photo under water',
      html: '<img src="/studio/reef.avif" alt="Coral reef in clear shallow water" data-dio="liquid" />',
    },
    {
      title: 'Portfolio covers smeared like wet paint',
      html: '<img src="/work/poster.avif" alt="Poster for the spring show" data-dio="liquid" data-dio-style="smear" data-dio-radius="120" data-dio-duration="2.5" />',
    },
    {
      title: 'A product shot with color fringes, drawn by a finger too',
      html: '<img src="/drops/sneaker.avif" alt="Running shoe, side view" data-dio="liquid" data-dio-style="prism" data-dio-split="2" style="touch-action: none" />',
    },
  ],
}

export default doc
