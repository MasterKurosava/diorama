import type { EffectDoc } from '@dioramajs/effects'
import type waves from './waves'

const doc: EffectDoc<typeof waves> = {
  category: 'background',
  tags: ['scroll'],
  summary:
    'Topographic contour lines or flowing wave lines across a hero or footer, slowly changing and shifted by scroll.',
  looks:
    'Thin lines in one color over a flat background. The contour style draws the lines of a topographic map over a relief that slowly changes shape, with every fifth line a little bolder like the index lines of a real map. The waves style draws lines that run across the element and flow sideways in soft swells, and stripes fills every other band between them. Lines keep the same width in CSS pixels wherever they run, and where they crowd together they blend into an even tone instead of flickering.',
  target:
    'an empty decorative element behind the content, such as an aria-hidden div filling a hero or a footer; its CSS background is the look without WebGL',
  params: {
    style: {
      description:
        'contour draws the lines of a topographic map over a slowly changing relief; waves draws lines flowing across the element; stripes fills every other band between those lines.',
    },
    lines: {
      description: 'Lines across the height of the element; more lines pack them closer.',
      range: [2, 60],
      step: 1,
    },
    color: { description: 'Color of the lines or stripes, any CSS color.' },
    background: { description: 'Color behind the lines, any CSS color.' },
    warp: {
      description: 'How far noise bends the lines; 0 draws straight parallel lines.',
      range: [0, 1],
    },
    speed: {
      description: 'How fast the relief and the swells change; 0 keeps their shape.',
      range: [0, 2],
    },
    thickness: {
      description: 'Line width in CSS pixels; stripes ignore it.',
      range: [0.5, 6],
      step: 0.1,
      unit: 'px',
    },
    scroll: {
      description: 'How far the lines move while the element crosses the viewport.',
      range: [0, 1],
    },
    fps: {
      description: 'Most frames a second the motion draws; 0 holds it still.',
      range: [0, 60],
      step: 1,
    },
    seed: { description: 'Shape of the noise that bends the lines.', range: [1, 100], step: 1 },
  },
  frames:
    'Up to fps frames a second while on screen, none off screen or at fps 0; scroll draws at full rate.',
  touch: 'Nothing changes on touch screens: scroll moves the lines as usual.',
  reducedMotion: 'A still frame: the lines neither change nor move with scroll.',
  presence: 'Fades with the page transition.',
  quality: {
    low: 'At most 15 frames a second.',
    medium: 'At most 24 frames a second.',
  },
  cost: {
    gpu: 'One pass over the element: four or eight reads of a small noise tile per pixel.',
    memory: 'A 128 × 128 noise tile in half floats per element, 128 KB.',
  },
  examples: [
    {
      title: 'Contours behind a hero',
      html: '<header class="hero"><div class="hero-bg" aria-hidden="true" data-dio="waves" data-dio-color="#3b6a8f" data-dio-background="#0c1424"></div><h1>Trails for every season</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'Flowing lines in a footer',
      html: '<footer class="site-footer"><div class="footer-bg" aria-hidden="true" data-dio="waves" data-dio-style="waves" data-dio-lines="24" data-dio-warp="0.7"></div><p>Ledger, money for teams</p></footer>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'Bold stripes on a light page',
      html: '<div class="band" aria-hidden="true" data-dio="waves" data-dio-style="stripes" data-dio-lines="10" data-dio-color="#ffd84d" data-dio-background="#ffef9e"></div>',
    },
    {
      title: 'From code',
      html: '<div class="bg" aria-hidden="true"></div>',
      ts: "app.attach('.bg', 'waves', { lines: 20, color: '#c8b68a', background: '#f4efe4' })",
    },
  ],
}

export default doc
