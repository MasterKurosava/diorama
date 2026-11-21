import type { EffectDoc } from '@dioramajs/effects'
import type expand from './expand'

const doc: EffectDoc<typeof expand> = {
  category: 'scroll',
  tags: ['photo'],
  summary: 'The image of a card grows to fill its sticky stage as the section scrolls.',
  looks:
    'Between start and end of the pin a copy of the image grows from the box of its card to the box of the sticky stage, usually the whole screen, easing in and out. Its corners go to radius, object-fit frames it anew at every size, so cover never stretches, and the content swells a little on the way and lands at its size. It then holds the screen; when the section lets the stage go, it leaves with it. With out below 1 it folds back into the card before the pin ends. Scrolling up plays it all backward.',
  target: 'img, video inside a card on a sticky stage',
  params: {
    into: {
      description:
        'Selector of the ancestor to grow into; empty for the nearest sticky one, or the viewport.',
    },
    by: {
      description:
        'What drives it: pin of the sticky section, viewport progress, or position alone.',
    },
    position: {
      description:
        'Expansion by hand, for a button or a GSAP tween; with pin or progress it is a floor.',
      range: [0, 1],
      unit: 'fraction',
    },
    start: { description: 'Pin at which it starts to grow.', range: [0, 1], unit: 'fraction' },
    end: { description: 'Pin at which it fills the stage.', range: [0, 1], unit: 'fraction' },
    out: {
      description: 'Pin from which it folds back into the card; 1 holds it to the end.',
      range: [0, 1],
      unit: 'fraction',
    },
    zoom: {
      description: 'How much the content swells halfway, back to 1 at both ends; 1 or 0 for none.',
      range: [0, 1.5],
    },
    radius: { description: 'Corner radius once it fills the stage.', range: [0, 64], unit: 'px' },
    ease: {
      description: 'Smoothing behind scroll; 0 follows it at once (Lenis already smooths it).',
      range: [0, 1],
      unit: 's',
    },
  },
  frames: 'Scroll draws its own frames, ease keeps drawing until it settles. None at rest.',
  touch:
    'Works from scroll. On iOS without Lenis the full-screen copy can trail composited scroll by a frame as the stage is let go; Lenis avoids it.',
  reducedMotion: 'Off: the image stays in its card, as the DOM shows it.',
  presence:
    'Fades with the page transition. A keyed flight takes the copy and starts from the box it was drawn at, expanded or not.',
  quality: {},
  cost: {
    gpu: 'One texture read per pixel, up to the whole viewport once expanded.',
    memory:
      'The image the browser picked for the card. For a sharp full screen, let sizes allow it, such as sizes="100vw".',
  },
  examples: [
    {
      title: 'A card that opens to the screen',
      html: '<section class="detail" style="height: 250vh"><div class="stage" style="position: sticky; top: 0; height: 100vh"><figure class="card" style="overflow: hidden; border-radius: 24px"><img src="/img/cushion.avif" alt="Memory foam cushion" style="border-radius: inherit" data-dio="expand" /></figure></div></section>',
    },
    {
      title: 'Open, then close before the section ends',
      html: '<img src="/img/cushion.avif" alt="Memory foam cushion" data-dio="expand" data-dio-start="0.1" data-dio-end="0.4" data-dio-out="0.8" data-dio-radius="16" />',
    },
    {
      title: 'Text over the full-screen image',
      html: '<div class="stage"><img src="/img/cushion.avif" alt="" data-dio="expand" /><p class="caption">Memory foam that remembers you.</p></div>',
      ts: "start({ canvas: 'behind' }) // the stage background transparent, the caption above the copy",
    },
  ],
}

export default doc
