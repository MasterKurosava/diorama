import type { EffectDoc } from '@dioramajs/effects'
import type vinyl from './vinyl'

const doc: EffectDoc<typeof vinyl> = {
  category: '3d',
  tags: ['audio', 'photo'],
  summary: 'An album cover becomes a record sleeve: the disc slides out and spins.',
  looks:
    'At rest the sleeve lies exactly where the cover image was, with a soft shadow under it. On hover, once in view or while its player plays, a record slides out of the sleeve to the right and spins at 33 rpm, its grooves catching a sheen of light that stays put while the disc turns. The center label carries the cover or a picture of its own. The sleeve leans a little toward the pointer.',
  target:
    'img: the cover, the front of the sleeve. Without WebGL, or with reduced motion and a still record, the plain cover shows',
  params: {
    style: {
      description:
        'Kind of disc. black: classic black vinyl with grooves; color: colored vinyl in color; picture: a picture disc printed with the label image or the cover; cd: a silver compact disc with the rainbow of its tracks.',
    },
    trigger: {
      description:
        'What brings the record out. hover: the pointer or keyboard focus, and a click or Enter keeps it out; view: it slides out once the sleeve is well in view and stays; play: it comes out and spins while the player named by for plays, and a click or Enter plays or pauses it.',
    },
    for: {
      description:
        'CSS selector of the <audio> or <video> for trigger play; empty takes the closest one before the image in its parent, else the first one in the parent.',
    },
    label: {
      description:
        'Center label image URL or color; empty shows the middle of the cover. With style picture, the image printed on the disc.',
    },
    color: { description: 'Color of the vinyl with style color.' },
    out: {
      description:
        'How far the record comes out, as a share of its diameter: 0 keeps it in the sleeve, 1 takes it all the way out.',
      range: [0, 1],
    },
    rpm: {
      description:
        'Turntable speed while it spins, in turns a minute: 33, 45 or 78. 0 keeps it still.',
      range: [0, 78],
    },
    tilt: {
      description: 'How far it leans toward the pointer: 0 turns the lean off.',
      range: [0, 25],
      unit: 'deg',
    },
    shadow: { description: 'Density of the shadow on the page.', range: [0, 1] },
  },
  frames:
    'Only while the record slides, spins up or down, and spins; none at rest, and pointer moves elsewhere draw nothing. With trigger play, none while the player is paused.',
  touch:
    'Nothing hovers. A tap brings the record out and back with trigger hover, plays and pauses with trigger play, unless the image sits in a link or a button.',
  reducedMotion:
    'The record comes out and goes back at once and never spins; the triggers work as usual.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, and its shadow fades with it.',
  quality: {},
  cost: {
    gpu: 'Two thin discs and a sleeve, a few hundred triangles; the grooves are drawn, not modelled.',
    memory: 'The cover image, and the label image when given.',
  },
  examples: [
    {
      title: 'An album that shows its record on hover',
      html: '<img src="/releases/tidelines.webp" alt="Tidelines, the debut album by Harbor Lights" width="600" height="600" data-dio="vinyl" tabindex="0" />',
    },
    {
      title: 'A record that spins while its track plays',
      html: '<figure><audio src="/audio/tidelines-preview.mp3" controls=""></audio><img src="/releases/tidelines.webp" alt="Tidelines cover" width="600" height="600" data-dio="vinyl" data-dio-trigger="play" data-dio-label="/releases/tidelines-label.webp" /></figure>',
    },
    {
      title: 'Colored vinyl that slides out in view',
      html: '<img src="/shop/limited.webp" alt="Limited edition on red vinyl" width="500" height="500" data-dio="vinyl" data-dio-style="color" data-dio-color="#d0342c" data-dio-trigger="view" />',
    },
  ],
}

export default doc
