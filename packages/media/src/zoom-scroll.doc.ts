import type { EffectDoc } from '@dioramajs/effects'
import type zoomScroll from './zoom-scroll'

const doc: EffectDoc<typeof zoomScroll> = {
  category: 'scroll',
  tags: ['photo'],
  summary: 'A picture in a pinned section zooms from its box to fill the screen as you scroll.',
  looks:
    'While the section is pinned, between start and end, a copy of the picture grows from its box to the box of the sticky stage, usually the whole screen. zoom scales the picture up with its box and pushes in a little more; mask keeps the picture still at its full-screen framing and opens a rounded window onto it, the picture easing back from zoom as the window opens; through grows it, flies past the screen and fades out to show the content behind. Corners go from the element radius to radius. Scrolling up plays it backward; reverse plays it from the full screen into the box.',
  target: 'img, video on a sticky stage inside a tall section',
  params: {
    style: {
      description:
        'zoom grows with its box; mask opens a window on a still picture; through flies past.',
    },
    start: { description: 'Pin at which the zoom starts.', range: [0, 1], unit: 'fraction' },
    end: {
      description: 'Pin at which it fills the screen, or for through has faded out.',
      range: [0, 1],
      unit: 'fraction',
    },
    zoom: {
      description:
        'Extra zoom of the picture: push-in for zoom, start zoom for mask, 2x for through; 1 or 0 for none.',
      range: [1, 2],
    },
    radius: { description: 'Corner radius once it fills the screen.', range: [0, 64], unit: 'px' },
    reverse: {
      description:
        'Plays it backward: full screen at the start of the pin, back in its box at end.',
    },
    ease: {
      description: 'Smoothing behind scroll; 0 follows it at once (Lenis already smooths it).',
      range: [0, 1],
      unit: 's',
    },
  },
  frames: 'Scroll draws its own frames, ease keeps drawing until it settles. None at rest.',
  touch:
    'Works from scroll. On iOS without Lenis the full-screen copy can trail composited scroll by a frame as the stage is let go; Lenis avoids it.',
  reducedMotion: 'Off: the picture stays in its box, as the DOM shows it.',
  presence: 'Fades with the page transition; a keyed flight starts from the box it was drawn at.',
  quality: {},
  cost: {
    gpu: 'One texture read per pixel, up to the whole viewport once zoomed.',
    memory:
      'The image the browser picked for the box. For a sharp full screen, let sizes allow it, such as sizes="100vw".',
  },
  examples: [
    {
      title: 'Scroll into the picture',
      html: '<section style="height: 300vh"><div style="position: sticky; top: 0; height: 100vh; display: grid; place-items: center"><img src="/img/coast.avif" alt="Cliffs above a turquoise bay" style="width: 40vw; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 24px" data-dio="zoom-scroll" /></div></section>',
    },
    {
      title: 'A window that opens onto the scene',
      html: '<img src="/img/coast.avif" alt="Cliffs above a turquoise bay" style="object-fit: cover; border-radius: 32px" data-dio="zoom-scroll" data-dio-style="mask" data-dio-zoom="1.3" />',
    },
    {
      title: 'Fly through the picture into the next chapter',
      html: '<img src="/img/coast.avif" alt="" style="object-fit: cover" data-dio="zoom-scroll" data-dio-style="through" data-dio-end="0.8" />',
    },
  ],
}

export default doc
