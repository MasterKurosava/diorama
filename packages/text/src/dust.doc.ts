import type { EffectDoc } from '@dioramajs/effects'
import type dust from './dust'

const doc: EffectDoc<typeof dust> = {
  category: 'text',
  tags: ['scroll', 'celebration'],
  summary:
    'A heading crumbles into fine sand that lifts off the page and drifts away in depth as it scrolls out, or on a click.',
  looks:
    'The text breaks into grains made of its own pixels, so the first grain to come loose looks exactly like the ink it leaves. A ragged edge sweeps across the heading from the side the wind blows to; behind it the grains lift off the page towards the viewer, tumble and catch a soft light from the upper left, and stream away along swirling paths, growing and blurring as they come closer and casting faint shadows on the page below. Other motions let the grains rise like ash or blow the heading apart into tiles that fly out of the page in every direction. Scrolling back gathers the sand into the heading again, and at rest the heading is plain DOM text.',
  target:
    'a large heading, a short line of display text or a dismissible message. Not img, video, canvas, svg or form fields. Text with text-shadow, a text stroke, background-clip: text or vertical writing stays as it is',
  params: {
    motion: {
      description:
        'wind blows the grains along angle in swirling streams, for most headings; rise lets them float up like ash; explode bursts the text into tiles that fly out of the page, front and back.',
    },
    trigger: {
      description:
        'scroll ties it to the heading leaving the top of the viewport, both ways; click plays it on a click or Enter, then leaves the element empty; view plays it once the heading scrolls out and gathers it back on return.',
    },
    density: {
      description: 'Grains per area of the glyphs; 2 doubles them, up to the tier limit.',
      range: [0.3, 3],
    },
    dot: {
      description: 'Size of a grain in flight on the page plane; closer grains look larger.',
      range: [0.6, 6],
      unit: 'px',
    },
    duration: {
      description: 'Time the click and view triggers take to blow the whole text away.',
      range: [0.5, 6],
      unit: 's',
    },
    angle: {
      description: 'Where the wind blows, counterclockwise from the right; 90 blows straight up.',
      range: [-180, 180],
      unit: 'deg',
    },
    turbulence: {
      description: 'Strength of the swirls the grains ride; 0 lets them fly straight.',
      range: [0, 3],
    },
    depth: {
      description: 'How far the grains travel towards the viewer and back; 0 keeps them flat.',
      range: [0, 2],
    },
    shadow: {
      description: 'Darkness of the shadows lifted grains cast on the page; 0 turns them off.',
      range: [0, 1],
      unit: 'fraction',
    },
    seed: {
      description: 'Picks the ragged edge, paths and sizes; the same seed blows the same way.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'While scrolling through the sweep with the scroll trigger, and while the sand flies with the click and view triggers; none at rest.',
  touch: 'The same as with a mouse; a tap plays the click trigger.',
  reducedMotion:
    'The scroll and view triggers show the text as it is; the click trigger fades the text out in 0.4 s instead.',
  presence:
    'Leaving a page, the heading blows away as sand; entering, the sand gathers back into the text.',
  quality: {
    low: 'A quarter of the grains, density at most 0.6, no shadows, and the text rastered at 1 device pixel per CSS pixel instead of 2.',
    medium: 'About half of the grains.',
  },
  cost: {
    gpu: 'Two instanced draws of up to 20,000 small quads, each tracing its path through the flow in five steps, and one instanced draw of a quad per line for the text that is left.',
    memory:
      'A canvas of the text at twice its CSS size, a small map of when each grain comes loose, and 48 bytes per grain: about 1 MB at the high tier.',
  },
  events: [
    {
      name: 'dio:dust',
      description:
        'The click trigger has blown the text away; the element keeps its space, so remove or collapse it here.',
      detail: 'null',
    },
  ],
  children: [
    {
      attribute: 'data-dio-dust',
      description:
        'Set by the click trigger on its element: playing while the sand flies, then done for good.',
    },
  ],
  examples: [
    {
      title: 'A hero heading that blows away as it scrolls out',
      html: '<h1 data-dio="dust">The end of summer</h1>',
    },
    {
      title: 'A notice the visitor dismisses',
      html: '<p class="notice" role="button" tabindex="0" data-dio="dust" data-dio-trigger="click" data-dio-motion="rise">Saved. Click to dismiss.</p>',
      ts: "document.querySelector('.notice')?.addEventListener('dio:dust', (e) => (e.target as Element).remove())",
    },
    {
      title: 'Shattered once it scrolls out',
      html: '<h2 data-dio="dust" data-dio-trigger="view" data-dio-motion="explode">Sold out</h2>',
    },
    {
      title: 'Ash rising straight up, without shadows',
      html: '<h2 data-dio="dust" data-dio-motion="rise" data-dio-angle="90" data-dio-shadow="0">Ashes, ashes</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Last call</h2>',
      ts: "app.attach('.title', 'dust', { angle: 160, turbulence: 2 })",
    },
  ],
}

export default doc
