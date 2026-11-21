import type { EffectDoc } from '@dioramajs/effects'
import type snow from './snow'

const doc: EffectDoc<typeof snow> = {
  category: 'celebration',
  tags: ['background'],
  summary:
    'Snow, cherry petals or autumn leaves drifting down over a section or the whole page, for a seasonal campaign.',
  looks:
    'Soft round flakes fall at different depths: far ones small, slow and faint, near ones larger, faster and softer, as if out of focus. They sway as they fall, drift with the wind and move aside around the pointer. The petals style lets pink petals tumble and flip on their way down, and leaves turns them into pointed autumn leaves with a darker midrib. With pile set, a soft drift of snow builds up along the bottom edge and the flakes settle into it. Everything draws over the page and clicks go through to it.',
  target:
    'any element, such as a hero or a banner, or <body> for the whole page; it is never hidden',
  params: {
    style: {
      description:
        'snow drops soft round flakes; petals tumble pink petals; leaves drops autumn leaves.',
    },
    count: { description: 'Flakes over the element or the viewport.', range: [0, 1500], step: 1 },
    scale: { description: 'Size of the flakes over their base size.', range: [0.3, 3] },
    speed: { description: 'How fast the flakes fall; 0 holds them in the air.', range: [0, 3] },
    wind: {
      description: 'Sideways drift: positive to the right, negative to the left.',
      range: [-2, 2],
    },
    color: {
      description:
        'Colors of the flakes, any CSS colors separated by spaces; empty uses the style’s own.',
    },
    pile: {
      description: 'Height of the drift that builds up at the bottom edge, snow only; 0 for none.',
      range: [0, 80],
      unit: 'px',
    },
    push: {
      description: 'How far the pointer pushes nearby flakes aside; 0 leaves them alone.',
      range: [0, 1],
    },
    fps: {
      description: 'Most frames a second the snowfall draws; 0 holds it still.',
      range: [0, 60],
      step: 1,
    },
    seed: { description: 'Positions, sizes and colors of the flakes.', range: [1, 100], step: 1 },
  },
  frames:
    'Up to fps frames a second while the element is on screen, none off screen or at fps 0; the pointer draws at full rate while it pushes.',
  touch: 'Flakes move aside from a finger on the element; scrolling works as usual.',
  reducedMotion: 'Off: neither the module nor the engine loads for it, and the page is unchanged.',
  presence: 'Fades with the page as it leaves.',
  quality: {
    low: 'At most 70 flakes and 24 frames a second.',
    medium: 'At most 110 flakes.',
  },
  cost: {
    gpu: 'One instanced draw of small quads over the element or the viewport.',
    memory: 'Three instance buffers of 1501 entries, about 72 KB.',
  },
  examples: [
    {
      title: 'Over a winter sale banner',
      html: '<section class="sale" data-dio="snow" data-dio-pile="24"><h2>Winter sale: 30% off outerwear</h2><a href="/sale">Shop the sale</a></section>',
    },
    {
      title: 'Over the whole page, from code or with data-dio="snow" on the body',
      html: '<main><h1>Holiday gift guide</h1></main>',
      ts: "app.attach(document.body, 'snow', { count: 120, wind: -0.3 })",
    },
    {
      title: 'Cherry petals for a spring collection',
      html: '<header class="spring" data-dio="snow" data-dio-style="petals" data-dio-count="60" data-dio-wind="0.6"><h1>Spring collection</h1></header>',
    },
    {
      title: 'Leaves in brand colors',
      html: '<section class="autumn" data-dio="snow" data-dio-style="leaves" data-dio-color="#c2410c #f59e0b var(--brand)"><h2>Autumn menu</h2></section>',
    },
  ],
}

export default doc
