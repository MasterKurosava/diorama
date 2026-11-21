import type { EffectDoc } from '@dioramajs/effects'
import type physics from './physics'

const doc: EffectDoc<typeof physics> = {
  category: 'text',
  tags: ['3d', 'block'],
  summary:
    'Playful gravity type: the letters of a heading become thick lit 3D tiles that fall, bounce, tumble and pile up, can be thrown with the pointer, and stand back up.',
  looks:
    'Each letter turns into a solid tile cut in the shape of its glyph, as thick as the depth says, with beveled edges and walls that catch the light. When the heading falls, the tiles drop to the bottom of their container, bounce, tip over and tumble about all three axes, seen through the page camera, and come to rest in a pile, lying on their faces or leaning on each other, each casting a soft shadow on the page and the floor. The drop style collapses the heading where it stands, scatter bursts the letters outward so they settle across the floor, and stack drops them in from above one by one into their places with a bounce. A loose letter can be grabbed, dragged and thrown. On demand the letters fly back up and the heading is plain text again.',
  target:
    'a large heading or a short line of display text, in a container with room below it. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'drop collapses the heading into a pile; scatter bursts the letters apart; stack drops them in one by one.',
    },
    trigger: {
      description:
        'view falls once in view; click toggles on a click; scroll falls when scrolled past; hover knocks letters.',
    },
    gravity: {
      description: 'Pull of gravity, 1 is about earth for the page; 0 lets the letters float.',
      range: [0, 3],
    },
    bounce: {
      description: 'How much of its speed a letter keeps when it hits the floor or another letter.',
      range: [0, 1],
    },
    friction: {
      description: 'Grip between letters and the floor; 0 lets them slide like ice.',
      range: [0, 1.5],
    },
    depth: {
      description: 'Thickness of a tile in em of its font size; 0 draws flat letters.',
      range: [0, 1],
      unit: 'em',
    },
    throw: {
      description: 'Strength of a throw with the pointer; 0 turns grabbing and knocking off.',
      range: [0, 3],
    },
    container: {
      description:
        'Selector of an ancestor whose box the letters fall in; empty keeps the heading’s own box.',
    },
  },
  frames:
    'While letters fall, fly, hop or are dragged; none once the pile has settled or the heading stands upright.',
  touch:
    'A finger drags and throws a loose letter without scrolling the page; in the hover trigger a tap knocks a letter off.',
  reducedMotion:
    'Off: the heading stays upright as plain text, and the engine does not load for it.',
  presence: 'Fades with the page.',
  quality: {
    low: 'The letters are rastered at 1 device pixel per CSS pixel instead of 2 and the march through each tile takes 8 steps instead of 24.',
    medium: 'The march through each tile takes 14 steps instead of 24.',
  },
  cost: {
    gpu: 'One instanced draw of a box per letter, marched to the glyph in up to 24 texture reads per pixel, and two instanced draws of shadows.',
    memory:
      'An atlas of the letters at twice their CSS size with room for the shadows, and a relief map of the same size.',
  },
  events: [
    {
      name: 'dio:physics',
      description:
        'The letters changed state: moving while they fall or fly, piled once still, upright once back as text.',
      detail: "{ state: 'moving' | 'piled' | 'upright' }",
    },
  ],
  children: [
    {
      attribute: 'data-dio-physics',
      description:
        'Set on the heading while letters are off their places: moving while any moves, piled once all are still.',
    },
    {
      attribute: 'data-dio-reset',
      description:
        'A click on any element with it stands the letters back up; a selector as its value limits it to matching headings.',
    },
  ],
  examples: [
    {
      title: 'A hero heading that collapses into a pile at the bottom of its section',
      html: '<section class="hero"><h1 data-dio="physics" data-dio-container=".hero">Gravity wins</h1><button data-dio-reset="">Reset</button></section>',
    },
    {
      title: 'Letters that burst apart on a click and stand back up on the next one',
      html: '<h2 data-dio="physics" data-dio-style="scatter" data-dio-trigger="click" tabindex="0">Shake it up</h2>',
    },
    {
      title: 'A heading whose letters stack in one by one once in view',
      html: '<h2 data-dio="physics" data-dio-style="stack">Built to stack</h2>',
    },
    {
      title: 'A word mark whose letters you can knock off with the pointer',
      html: '<p class="mark" data-dio="physics" data-dio-trigger="hover" data-dio-container="header">loose</p>',
    },
    {
      title: 'Standing it back up from code',
      html: '<h2 class="title" data-dio="physics" data-dio-trigger="scroll">Hold on</h2>',
      ts: "document.querySelector('.title')?.dispatchEvent(new Event('dio:reset'))",
    },
  ],
}

export default doc
