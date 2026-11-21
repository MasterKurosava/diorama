import type { EffectDoc } from '@dioramajs/effects'
import type frost from './frost'

const doc: EffectDoc<typeof frost> = {
  category: 'photo',
  tags: ['scroll'],
  summary:
    'Frosted glass over a photo, or over the whole page, that the pointer wipes clear and that slowly fogs back.',
  looks:
    'The photo sits behind frosted glass: blurred, veiled in a pale tint and laced with ice crystals, or, in steam style, a fogged mirror dotted with droplets. Wiping the pointer across it clears a band with a ragged wet edge, which fogs back over refog seconds. Instead of wiping, the glass can clear from the pointer on hover, clear from the middle as the photo comes into view, or clear along with the scroll. On <body> the screen becomes a frozen window: feathers of ice grow in from the edges over a milky veil, glints catch the light near the pointer, and the page under it stays real, readable and clickable. On any other element the same pane covers its box. cover freezes the glass from the edges and thaws it outwards from a point.',
  target: 'img, video, body, any element',
  params: {
    style: {
      description: 'frost: ice crystals over a milky layer; steam: a fogged mirror with droplets.',
    },
    by: {
      description:
        'pointer: the pointer wipes the glass; hover: it clears from where the pointer came in and fogs back when it leaves; view: it clears once as the photo comes into view; scroll: it clears with the scroll between start and end. The pointer wipes in every mode but hover.',
    },
    blur: {
      description:
        'Blur of the photo behind the glass: 0 keeps it sharp. The pane over a page draws no blur, since it never reads the page.',
      range: [0, 40],
      unit: 'px',
    },
    strength: {
      description: 'How much the glass veils the photo in color: 0 leaves only the blur.',
      range: [0, 1],
    },
    grain: {
      description:
        'Strength of the ice crystals, or the share of droplets in steam style: 0 is plain glass.',
      range: [0, 1],
    },
    radius: { description: 'Radius of the wipe under the pointer.', range: [10, 300], unit: 'px' },
    refog: {
      description:
        'Seconds a wiped area takes to fog back, and with by hover the fog after the pointer leaves: 0 keeps it clear.',
      range: [0, 20],
      unit: 's',
    },
    refill: {
      description:
        'How much of the fog comes back over a wiped area: 1 all of it, 0.3 a thin layer that keeps the page readable, 0 none.',
      range: [0, 1],
    },
    duration: {
      description: 'Length of the clearing with by hover and by view, and of a freeze or thaw.',
      range: [0, 4],
      unit: 's',
    },
    start: {
      description:
        'With by scroll, the scroll progress at which the clearing begins: 0 as the photo enters at the bottom.',
      range: [0, 1],
    },
    end: {
      description:
        'With by scroll, the scroll progress at which the glass is clear: 0.5 is about the photo centred in the viewport.',
      range: [0, 1],
    },
    cover: {
      description:
        'How much of the glass is frozen: rising, ice grows in from the edges over duration; falling, it thaws outwards from x, y. 0 is bare glass. Live, so a script or a scroll handler can freeze and thaw the page.',
      range: [0, 1],
    },
    x: {
      description: 'Where a thaw starts, from the left edge of the box (the viewport on <body>).',
      range: [0, 1],
    },
    y: { description: 'Where a thaw starts, from the top edge.', range: [0, 1] },
    middle: {
      description:
        'How much thinner the ice is in the middle of the pane, so text there stays readable: 0 frosts it evenly, 1 leaves the middle clear. Screens without hover use at least 0.6.',
      range: [0, 1],
    },
    keep: {
      description:
        'A CSS selector of up to six elements the pane keeps a thin veil over, such as the headline and the button, so they stay readable under thick ice. Read when the effect starts; a photo ignores it.',
    },
    color: { description: 'Tint of the glass, a cold white by default.' },
    resolution: {
      description: 'Cells across each side of the wipe mask: more gives a finer edge.',
      range: [16, 256],
      step: 1,
    },
  },
  frames:
    'Only while the pointer wipes, while a wipe fogs back, while a clearing plays and while the ice grows or thaws; none at rest. With by scroll only while the page scrolls.',
  touch:
    'On a photo a pressed finger wipes the glass; a scroll takes the gesture, so add touch-action: none to the image to wipe without scrolling. The pane over a page never takes a gesture: every touch clears the ice around it, also while it scrolls, and the middle stays thin. With by hover a tap clears the glass for good. by view and by scroll need no gesture.',
  reducedMotion:
    'No animated clearing, freeze or thaw: they jump to where they end. On a photo wiping still works and wiped areas still fog back. The pane over a page is only a faint cold tint without crystals, and nothing wipes it.',
  presence: 'Fades with the page transition; no wipes are taken while it plays.',
  quality: {
    low: 'Blur at most 6 px with 8 reads instead of 16; a 32 × 32 mask. The pane drops its finest crystals.',
  },
  cost: {
    gpu: 'On a photo seventeen texture reads per pixel for the blur (nine on low), two of the noise tile and one of the mask; steam adds one for the droplets. The pane reads the noise tile four times and the mask once per pixel of its area, with no blur.',
    memory:
      'The image, a shared 128 × 128 noise tile and a mask of resolution × resolution bytes × 4.',
  },
  examples: [
    {
      title: 'Wipe the window to see the product',
      html: '<img src="/winter/parka.avif" alt="Down parka on a hanger by a frosted window" data-dio="frost" style="touch-action: none" />',
    },
    {
      title: 'A spa photo behind a steamed mirror that clears on hover',
      html: '<img src="/spa/bath.avif" alt="Stone bath with eucalyptus" data-dio="frost" data-dio-style="steam" data-dio-by="hover" data-dio-refog="2" />',
    },
    {
      title: 'A winter landing page behind a frozen window',
      html: '<div class="window" data-dio="frost" data-dio-strength="0.2" data-dio-radius="90" data-dio-keep=".hero h1, .hero .cta" style="position: fixed; inset: 0; pointer-events: none"></div>',
    },
    {
      title: 'A teaser that thaws as it scrolls into view',
      html: '<img src="/launch/bottle.avif" alt="New bottle design, frosted glass" data-dio="frost" data-dio-by="scroll" data-dio-start="0.1" data-dio-end="0.45" />',
    },
  ],
}

export default doc
