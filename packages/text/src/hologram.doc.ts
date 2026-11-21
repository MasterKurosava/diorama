import type { EffectDoc } from '@dioramajs/effects'
import type hologram from './hologram'

const doc: EffectDoc<typeof hologram> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'A heading becomes a 3D hologram: projected from a glowing emitter, built of slices in depth, crossed by scan lines.',
  looks:
    'A small emitter disc lies below the text, tipped toward you, with a lit ring, a turning ring of dashes and a bright core; it lights the page around it and throws a faint cone of light up through the text. The letters float in front of the page as several translucent slices stacked in depth: the front one solid and bright, the ones behind showing only the edges, so the text has volume. Fine scan lines cross it, a brighter band sweeps up through it, rows shimmer sideways, the color splits into red and blue fringes at the edges, and now and then the projection stutters or a band tears sideways. It sways slowly a few degrees and tips toward a pointer near it, and the parallax between the slices shows the depth. The card style mounts the slices on a dark holographic trading card with a foil border and a glossy foil in front: tipping it with the pointer shifts the slices against each other and sweeps a rainbow sheen across, and it keeps its last pose. The ghost style drops the projector: a cool, pale apparition that fades in from noise, drifts back and forth in depth and trails echoes behind it.',
  target:
    'a heading, a label or a short line of text, best on a dark background. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'projector stands on an emitter; card sits on a foil card that tilts; ghost trails echoes.',
    },
    trigger: {
      description:
        'view scans in as it shows; hover powers up on pointer, focus or tap; loop shimmers all the time.',
    },
    color: {
      description:
        'Color of the projection and its light, any CSS color; empty uses cyan (ghost: ice blue).',
    },
    layers: {
      description: 'Slices stacked in depth; 1 draws a flat projection.',
      range: [1, 12],
      step: 1,
    },
    depth: {
      description: 'Depth of the stack of slices, in ems of the font size.',
      range: [0, 1],
      unit: 'em',
    },
    scan: {
      description:
        'Strength of the scan lines, the sweep and the row shimmer; 0 for a clean projection.',
      range: [0, 2],
    },
    flicker: {
      description: 'How often the projection stutters, drops out or tears; 0 holds it steady.',
      range: [0, 1],
    },
    sway: {
      description: 'Largest slow turn of the hologram, degrees; 0 keeps it still.',
      range: [0, 20],
      unit: 'deg',
    },
    tilt: {
      description: 'Largest tip toward a pointer near it, degrees (card: 1.8 times); 0 ignores it.',
      range: [0, 20],
      unit: 'deg',
    },
  },
  frames:
    'trigger view: full rate while it scans in (about 1.5 s), then none. hover: 30 a second while powered up, full rate while powering up or down, none at rest. loop: 30 a second while on screen, none off screen. Full rate while it tips toward the pointer.',
  touch: 'No tip toward the pointer. With trigger hover a tap powers it up and down.',
  reducedMotion:
    'A still hologram at full power: no scan-in, no sweep, no shimmer, no flicker, no sway, no tip; it draws no frames of its own.',
  presence: 'The projection fades with the page.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'Four draws: the light on the page, the emitter, the cone and one instanced quad per slice with five texture reads per pixel.',
    memory: 'A canvas of the text at twice its CSS size, with its mip levels for the glow.',
  },
  examples: [
    {
      title: 'A launch heading projected as it scrolls into view',
      html: '<h1 data-dio="hologram">Launch day</h1>',
    },
    {
      title: 'A holographic trading card that tilts with the pointer',
      html: '<h2 data-dio="hologram" data-dio-style="card" data-dio-color="#7cf3ff">Rare #07</h2>',
    },
    {
      title: 'A ghostly title that keeps drifting',
      html: '<h2 data-dio="hologram" data-dio-style="ghost" data-dio-trigger="loop">Apparition</h2>',
    },
    {
      title: 'A call to action that powers up on hover',
      html: '<a href="/beta" data-dio="hologram" data-dio-trigger="hover" data-dio-color="#ffb84a">Join the beta</a>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Orbital 7</h2>',
      ts: "app.attach('.title', 'hologram', { trigger: 'loop', layers: 8, depth: 0.4, sway: 10 })",
    },
  ],
}

export default doc
