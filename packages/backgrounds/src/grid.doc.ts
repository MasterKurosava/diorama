import type { EffectDoc } from '@dioramajs/effects'
import type grid from './grid'

const doc: EffectDoc<typeof grid> = {
  category: 'background',
  tags: ['scroll'],
  summary:
    'A grid floor in perspective running toward the viewer under a glowing horizon: neon synthwave, a blueprint or plain thin lines.',
  looks:
    'The lower part of the element is a floor of square cells seen from just above, its lines running toward the viewer and meeting at the horizon. The upper part is the sky. Neon draws bright lines with a soft halo over a dark floor, the sky warming to the accent color at the horizon and a sun with bands cut through its lower half. Blueprint draws pale lines on a blue paper color with every fifth line heavier and the sun as a drawn circle. Minimal draws thin lines that fade out toward the horizon over a flat color, with the sun as a flat disc. Lines keep their width in CSS pixels and blend into an even tone where they crowd near the horizon, so the floor never shimmers. The pointer turns the view a little and the scroll moves the floor forward.',
  target:
    'an empty decorative element behind the content, such as an aria-hidden div filling a hero; its CSS background is the look without WebGL',
  params: {
    style: {
      description:
        'neon, glowing lines and a striped sun, for gaming, music events and synthwave looks; blueprint, pale lines on blue paper with heavier major lines, for engineering, hardware and developer tools; minimal, thin lines fading into a flat color, for calm tech and SaaS pages.',
    },
    color: { description: 'Color of the lines, any CSS color.' },
    background: { description: 'Color of the floor and the sky.' },
    accent: {
      description:
        'Color of the horizon glow and the sun; with minimal, of the sun only; with blueprint, of the haze.',
    },
    cells: {
      description: 'Cells across the bottom edge: more makes a finer grid.',
      range: [2, 60],
      step: 1,
    },
    horizon: {
      description: 'Height of the horizon from the top, as a share of the element.',
      range: [0.1, 0.9],
    },
    speed: { description: 'How fast the floor runs toward the viewer; 0 holds it.', range: [0, 2] },
    sun: { description: 'Size of the sun on the horizon; 0 hides it.', range: [0, 1] },
    thickness: { description: 'Width of the lines in CSS pixels.', range: [0.5, 4], unit: 'px' },
    depth: {
      description: 'How far the view turns with the pointer; 0 ignores the pointer.',
      range: [0, 1],
    },
    scroll: {
      description:
        'How far the floor moves forward while the element crosses the viewport; 0 keeps it.',
      range: [0, 1],
    },
    fps: {
      description: 'Most frames a second the floor draws while it runs; 0 holds it still.',
      range: [0, 60],
      step: 1,
    },
  },
  frames:
    'Up to fps frames a second while on screen, none off screen or at fps 0; pointer and scroll draw at full rate.',
  touch: 'The view turns with a finger while it is on the screen; scrolling works as usual.',
  reducedMotion: 'A still floor: it does not run, and neither the pointer nor scroll moves it.',
  presence: 'Fades with the page transition.',
  quality: { low: 'At most 15 frames a second.', medium: 'At most 24 frames a second.' },
  cost: {
    gpu: 'One pass over the element with a little math per pixel, no textures.',
    memory: 'None beyond the shared plane.',
  },
  examples: [
    {
      title: 'A synthwave hero for a music night',
      html: '<header class="hero"><div class="hero-bg" aria-hidden="true" data-dio="grid"></div><h1>Neon Nights, Friday 22:00</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'A blueprint for a hardware page',
      html: '<section class="spec"><div class="spec-bg" aria-hidden="true" data-dio="grid" data-dio-style="blueprint" data-dio-color="#d6e6ff" data-dio-background="#0d3b8c" data-dio-accent="#9cc3ff" data-dio-sun="0" data-dio-cells="24"></div><h2>Built to spec</h2></section>',
    },
    {
      title: 'Calm lines for a developer tool',
      html: '<div class="bg" aria-hidden="true" data-dio="grid" data-dio-style="minimal" data-dio-color="#9aa4b2" data-dio-background="#0b0d12" data-dio-sun="0" data-dio-speed="0.2"></div>',
    },
    {
      title: 'From code',
      html: '<div class="stage-bg" aria-hidden="true"></div>',
      ts: "app.attach('.stage-bg', 'grid', { color: '#22d3ee', accent: '#a855f7', horizon: 0.35 })",
    },
  ],
}

export default doc
