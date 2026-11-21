import type { EffectDoc } from '@dioramajs/effects'
import type sequence from './sequence'

const doc: EffectDoc<typeof sequence> = {
  category: 'scroll',
  tags: ['3d'],
  summary: 'An image sequence scrubbed by scroll, frame by frame, from a poster <img>.',
  looks:
    'The image becomes a flip book driven by the sticky section it sits in: scrolling down plays the frames forward, scrolling up plays them back, the way product pages take a device apart. Each frame is framed by the object-fit and object-position of the <img>. With blend, neighboring frames mix by the fraction of the index, so a short sequence of 24 to 36 frames moves smoothly.',
  target: 'img, the poster frame',
  params: {
    frames: {
      description:
        'Frame URLs by commas, or a range like /seq/{0001..0096}.webp padded as its first number.',
    },
    atlas: {
      description:
        'Atlas pages instead of frames, a range or list; cells read left to right, top to bottom.',
    },
    grid: {
      description: 'Columns and rows of cells on an atlas page.',
      range: [1, 16],
      step: 1,
    },
    count: {
      description:
        'Number of frames; auto takes all of the range, or every cell of every atlas page.',
      range: [1, 2000],
      step: 1,
    },
    by: {
      description:
        'What drives the frame: pin of the sticky section, viewport progress, or frame alone.',
    },
    start: {
      description: 'Progress at which the first frame shows.',
      range: [0, 1],
      unit: 'fraction',
    },
    end: {
      description: 'Progress at which the last frame shows.',
      range: [0, 1],
      unit: 'fraction',
    },
    frame: {
      description:
        'Frame shown when by is manual, for a tween or a slider; with blend a fraction mixes two.',
      range: [0, 100],
    },
    blend: { description: 'Mix neighboring frames by the fraction of the index.' },
    ease: {
      description:
        'Smoothing of the index behind scroll; 0 follows scroll at once (Lenis already smooths it).',
      range: [0, 1],
      unit: 's',
    },
    cache: {
      description:
        'Decoded frames kept around the current one, two of them ahead in the scroll direction.',
      range: [1, 32],
      step: 1,
    },
    density: {
      description:
        'Share of the frames loaded: 0.5 loads every second one and the others show the nearest.',
      range: [0.1, 1],
      unit: 'fraction',
    },
    resolution: {
      description: 'Longest side in px a frame is decoded at; larger frames shrink while decoding.',
      range: [320, 3840],
      unit: 'px',
    },
  },
  frames:
    'Scroll draws its own frames; a frame that finishes decoding asks for one, and ease keeps drawing until the index settles. None at rest.',
  touch: 'Works as on desktop: scroll drives it.',
  reducedMotion:
    'Off: the <img> shows its poster and not a single frame is downloaded. The poster is what people with reduced motion and without WebGL see, so choose it on purpose; another still frame for them is a <picture> with <source media="(prefers-reduced-motion: reduce)">.',
  presence: 'Fades with the page transition; a keyed flight carries the frame shown at the time.',
  quality: {
    medium: 'Up to 4 decoded frames, decoded at up to 1440 px.',
    low: 'Every second frame, up to 2 decoded frames at up to 960 px.',
  },
  cost: {
    gpu: 'Two texture reads per pixel of the box; one upload of the frame per drawn frame at most.',
    memory:
      'The compressed bytes of every frame it loads, cache decoded frames on the CPU and one texture of a frame on the GPU (two with blend). An atlas holds its pages instead, .webp, .avif or .ktx2 images, and compressed .ktx2 pages take 4 to 8 times less GPU memory. Under Save-Data or on 2G it loads a quarter of the frames at up to 960 px.',
  },
  examples: [
    {
      title: 'Scrubbed in a sticky section',
      html: '<section class="explode" style="height: 400vh"><div class="stage" style="position: sticky; top: 0; height: 100vh"><img src="/seq/0001.webp" alt="The headphones, layer by layer" data-dio="sequence" data-dio-frames="/seq/{0001..0096}.webp" /></div></section>',
    },
    {
      title: 'A short loop from an atlas',
      html: '<img src="/seq/spin-poster.avif" alt="The chair, turning" data-dio="sequence" data-dio-atlas="/seq/spin-{0..3}.webp" data-dio-grid="6 4" data-dio-count="90" data-dio-blend="true" />',
    },
    {
      title: 'Driven by a tween',
      html: '<img class="spin" src="/seq/0001.webp" alt="The chair, turning" data-dio="sequence" data-dio-frames="/seq/{0001..0048}.webp" data-dio-by="manual" />',
      ts: [
        "const spin = app.effects.get(document.querySelector('.spin'), 'sequence')",
        "gsap.to(spin.params, { frame: 47, scrollTrigger: { trigger: '.spin', scrub: true } })",
      ].join('\n'),
    },
  ],
}

export default doc
