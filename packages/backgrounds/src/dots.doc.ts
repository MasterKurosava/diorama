import type { EffectDoc } from '@dioramajs/effects'
import type dots from './dots'

const doc: EffectDoc<typeof dots> = {
  category: 'background',
  tags: ['block'],
  summary:
    'A dot grid behind a hero or in a card that answers the pointer: dots near it grow, move aside or glow, then settle back.',
  looks:
    'An even grid of small dots, plus marks or squares, the same pattern a CSS radial-gradient background draws. Around the pointer a soft lens forms: marks grow and take the accent color, slide away from it, or light up with a halo, depending on the mode. When the pointer stops the lens settles on it, and when it leaves the grid eases back. Drift slides the whole grid slowly, and fade lets it dissolve toward the edges. The background color of the element, read when the effect starts, stays under the grid.',
  target:
    'an empty decorative element behind the content, such as an aria-hidden div filling a hero or the top of a card; a CSS dot pattern on it is the look without WebGL',
  params: {
    style: {
      description:
        'dots draws round dots; plus draws thin plus marks, four times as wide as dot; squares draws small squares.',
    },
    mode: {
      description:
        'grow enlarges and tints marks near the pointer; push moves them aside; glow tints them with a halo.',
    },
    gap: {
      description: 'Distance between mark centers in CSS pixels.',
      range: [8, 64],
      unit: 'px',
    },
    dot: {
      description:
        "Mark size in CSS pixels: a dot's diameter or a square's side; a plus is 4 times wider.",
      range: [1, 8],
      step: 0.5,
      unit: 'px',
    },
    color: { description: 'Color of the marks at rest, any CSS color.' },
    accent: { description: 'Color marks take under the pointer, any CSS color.' },
    radius: {
      description: 'Reach of the pointer lens in CSS pixels; 0 turns the pointer off.',
      range: [0, 400],
      unit: 'px',
    },
    strength: {
      description: 'Strength of the lens: how much marks grow, move or glow; 0 turns it off.',
      range: [0, 1],
    },
    speed: {
      description: 'Speed at which the grid slides; 0 keeps it in place.',
      range: [0, 40],
      unit: 'px/s',
    },
    fade: {
      description: 'How far the grid fades out toward the edges, from none to the middle.',
      range: [0, 1],
    },
  },
  frames:
    'Frames only while the pointer moves over the grid and for about a second while the lens settles; with speed, up to 30 frames a second while on screen.',
  touch:
    'No lens on touch screens, so a finger never draws frames; the slide still runs and scrolling works as usual.',
  reducedMotion: 'A still grid: no slide and no lens.',
  presence: 'Fades with the page transition.',
  quality: { low: 'No slide: the grid moves only under the pointer.' },
  cost: {
    gpu: 'One pass over the element with a little math per pixel; push draws the nine nearest marks per pixel.',
    memory: 'None beyond the shared plane.',
  },
  examples: [
    {
      title: 'Behind a hero',
      html: '<header class="hero"><div class="hero-dots" aria-hidden="true" data-dio="dots" data-dio-fade="0.6"></div><h1>Ship docs your team reads</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'Plus marks that move aside',
      html: '<div class="grid-bg" aria-hidden="true" data-dio="dots" data-dio-style="plus" data-dio-mode="push" data-dio-gap="32" data-dio-color="#3a3f4b"></div>',
    },
    {
      title: 'A glowing grid that drifts',
      html: '<div class="panel-bg" aria-hidden="true" data-dio="dots" data-dio-mode="glow" data-dio-speed="8" data-dio-accent="#22d3ee"></div>',
    },
    {
      title: 'From code',
      html: '<div class="bg" aria-hidden="true"></div>',
      ts: "app.attach('.bg', 'dots', { gap: 20, accent: '#ff5a1f', radius: 200 })",
    },
  ],
}

export default doc
