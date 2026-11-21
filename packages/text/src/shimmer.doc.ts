import type { EffectDoc } from '@dioramajs/effects'
import type shimmer from './shimmer'

const doc: EffectDoc<typeof shimmer> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'A heading becomes polished chrome, gold, holographic foil or clear glass that catches the light as the pointer moves.',
  looks:
    'Every letter gets a rounded bevel built from its own shape and is lit as a real material in a small photo studio: a bright sky over a sharp horizon, a dark floor, a softbox overhead and tall strips at the sides. The reflections slide over the letters as the pointer moves and the page scrolls, a light sweeps across them on hover, as they come into view or on a loop, and a soft shadow falls on the page beside them. Chrome and gold are mirror metals, holo is a rainbow foil whose colors shift with the viewing angle and glitter in fine points, and glass is clear in the middle with bright or dark rims and light gathered inside its edges.',
  target:
    'a large heading, a logo word or a short label in a bold font, on a dark or a light page. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'chrome a mirror metal; gold a warm metal; holo a rainbow foil; glass clear tinted letters.',
    },
    trigger: {
      description:
        'hover sweeps on pointer, focus or tap; loop every few seconds; view once; pointer a lamp.',
    },
    colors: {
      description: 'CSS colors that tint the material, spaces apart; empty uses its own colors.',
    },
    bevel: {
      description: 'Width of the rounded edge of each letter in ems of the font size; 0 is flat.',
      range: [0, 0.2],
      unit: 'em',
    },
    angle: {
      description:
        'Direction the light sweeps in, in degrees like a CSS gradient: 90 is to the right.',
      range: [0, 360],
      step: 1,
      unit: 'deg',
    },
    width: {
      description:
        'Width of the sweeping light or the pointer lamp; larger is a softer, wider glint.',
      range: [0.3, 3],
    },
    speed: {
      description: 'Pace of the sweep and the loop; 0 never sweeps.',
      range: [0, 3],
    },
    strength: {
      description:
        'Brightness of the moving light, the glitter and the light inside glass; 0 for none.',
      range: [0, 3],
    },
    follow: {
      description:
        'How far the reflections turn with the pointer and the scroll; 0 holds them still.',
      range: [0, 2],
    },
    shadow: {
      description: 'Darkness of the soft shadow the letters cast on the page; 0 for none.',
      range: [0, 1],
    },
  },
  frames:
    'None at rest: the material is drawn once and stays. Full rate while the light sweeps and while the reflections settle after the pointer, one frame per scroll or pointer move, and with trigger loop nothing between sweeps.',
  touch:
    'The reflections still turn with the scroll; with trigger hover a tap sweeps the light, and with trigger pointer the lamp follows a finger while it touches the text.',
  reducedMotion:
    'The material is drawn still: no sweeps, and the reflections no longer follow the pointer or the scroll.',
  presence: 'The letters and their shadow fade with the page.',
  quality: {
    low: 'The text and its bevel are rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'One instanced quad per line of text, three or four texture reads and a few dozen operations per pixel.',
    memory:
      'A canvas of the text at twice its CSS size and a half-float map of the bevel, built once on the CPU from a distance field of the letters.',
  },
  examples: [
    {
      title: 'A chrome headline that catches the light on hover',
      html: '<h1 class="hero" data-dio="shimmer">Chrome Edition</h1>',
    },
    {
      title: 'A gold badge that glints every few seconds',
      html: '<span class="badge" data-dio="shimmer" data-dio-style="gold" data-dio-trigger="loop" data-dio-bevel="0.05">Pro</span>',
    },
    {
      title: 'Holographic foil on a launch page, lit by a lamp at the pointer',
      html: '<h2 data-dio="shimmer" data-dio-style="holo" data-dio-trigger="pointer">Limited drop</h2>',
    },
    {
      title: 'Blue glass that sweeps once as it comes into view',
      html: '<h2 data-dio="shimmer" data-dio-style="glass" data-dio-trigger="view" data-dio-colors="#4aa8ff">Clear thinking</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="name">Aurum</h2>',
      ts: "app.attach('.name', 'shimmer', { style: 'gold', colors: '#f0b8a4', angle: 135 })",
    },
  ],
}

export default doc
