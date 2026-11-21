import type { EffectDoc } from '@dioramajs/effects'
import type assemble from './assemble'

const doc: EffectDoc<typeof assemble> = {
  category: 'text',
  tags: ['celebration', 'scroll'],
  summary:
    'Thousands of lit particles fly out of the depth around the page and gather into a heading.',
  looks:
    'When the heading scrolls into view, a cloud of small glossy beads drifts in front of and behind the page, larger and softer the closer it is to the viewer, then streams along curved paths into the shapes of the letters, left to right, and settles without overshoot. As each letter fills, the real text fades in over its particles, so the heading ends as selectable DOM text with no jump. Tiles that tumble and glint, or streaks of light, can stand in for the beads, and the cloud can rise from below, burst out of a point deep behind the heading or pour in from both sides. With the hover trigger the heading stays made of beads, and the ones under the pointer or a finger lift towards the viewer and spring back.',
  target:
    'a large heading or a short line of display text. Not img, video, canvas, svg or form fields. Text with text-shadow, a text stroke, background-clip: text or vertical writing stays as it is',
  params: {
    style: {
      description:
        'dots are glossy beads lit from the upper left, for most headings; squares are flat tiles that tumble and glint, like glitter or gold leaf; dashes are streaks of light along the motion, for a fast tech look.',
    },
    from: {
      description:
        'scatter starts from a cloud around the heading, in front of and behind the page; below rises from under it; center bursts out of a point deep behind its middle; edges pours in from both sides.',
    },
    trigger: {
      description:
        'view gathers when the heading enters; scroll gathers it towards the middle of the viewport and scatters it again above; hover keeps it as beads the pointer lifts.',
    },
    density: {
      description: 'Particles per area of the glyphs; 2 doubles them, up to the tier limit.',
      range: [0.3, 3],
    },
    dot: { description: 'Size of a particle once it has landed.', range: [1, 6], unit: 'px' },
    duration: {
      description: 'Flight time of one particle from its start to its place.',
      range: [0.3, 4],
      unit: 's',
    },
    stagger: {
      description: 'Delay between neighboring letters, so they fill in reading order.',
      range: [0, 0.2],
      unit: 's',
    },
    spread: {
      description:
        'How far from the text particles start; with the hover trigger, the pointer reach.',
      range: [0, 3],
    },
    delay: { description: 'Wait after the trigger, for a cascade.', range: [0, 2], unit: 's' },
    threshold: {
      description: 'Share of the element height in view, above the bottom tenth, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
    color: {
      description: 'Color of the particles in flight; currentColor keeps the color of the text.',
    },
    accent: {
      description: 'Second color shimmering through particles in flight; currentColor for none.',
    },
    seed: {
      description: 'Picks the starts, paths and sizes; the same seed gathers the same way.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'Only while particles fly, while scrolling with the scroll trigger and while lifted beads settle with the hover trigger; none at rest.',
  touch:
    'The same as with a mouse; with the hover trigger the beads follow a finger while it presses on the heading.',
  reducedMotion: 'Off: the text is shown as it is, and the engine does not load for it.',
  presence:
    'Leaving a page, the text breaks back into particles that fly off into the depth; entering, they gather again.',
  quality: {
    low: 'A quarter of the particles, density at most 0.6, and the text rastered at 1 device pixel per CSS pixel instead of 2.',
    medium: 'About half of the particles.',
  },
  cost: {
    gpu: 'One instanced draw of up to 14,000 small quads, and one instanced draw of a quad per letter for the crisp text.',
    memory:
      'A canvas of the text at twice its CSS size, and about 80 bytes per particle: about 1.1 MB at the high tier.',
  },
  examples: [
    { title: 'A hero heading', html: '<h1 data-dio="assemble">Gather into light</h1>' },
    {
      title: 'Gold tiles rising from below',
      html: '<h2 data-dio="assemble" data-dio-style="squares" data-dio-from="below" data-dio-dot="3">Launch day</h2>',
    },
    {
      title: 'A two-tone cloud bursting from the depth',
      html: '<h2 data-dio="assemble" data-dio-from="center" data-dio-color="#ffb347" data-dio-accent="#ff4f8b">Big bang</h2>',
    },
    {
      title: 'Beads the pointer lifts',
      html: '<h2 data-dio="assemble" data-dio-trigger="hover" data-dio-accent="#ff7ad9">Touch the stars</h2>',
    },
    {
      title: 'Tied to scroll',
      html: '<h2 data-dio="assemble" data-dio-trigger="scroll" data-dio-style="dashes" data-dio-from="edges">Signal and noise</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Year in review</h2>',
      ts: "app.attach('.title', 'assemble', { from: 'below', duration: 2 })",
    },
  ],
}

export default doc
