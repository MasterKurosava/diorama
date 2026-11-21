import type { EffectDoc } from '@dioramajs/effects'
import type globe from './globe'

const doc: EffectDoc<typeof globe> = {
  category: 'data',
  tags: ['3d'],
  summary: 'An interactive globe of land dots with markers and arcs for a list of places.',
  looks:
    'A dark sphere in the box with the continents as dots (or a solid fill) and a thin glow along its rim. Each place is a marker on the surface; the one under the pointer or in focus grows and gets a ring. Arcs between places rise with their length and draw themselves along it once, or carry a dash that keeps running from the first place to the second. The globe turns slowly on its own, stops under the pointer and turns with a drag.',
  target:
    'an element with a list of places inside, or an empty element with `markers` pointing at a list elsewhere',
  params: {
    markers: {
      description:
        'Selector of the places: inside the element, or in the document when none are inside.',
    },
    data: {
      description:
        'URL of JSON `{ markers: [{ id, lat, lng }], arcs: [{ from, to }] }`, added to the places.',
    },
    lat: {
      description: 'Latitude that faces the viewer; a change turns to it.',
      range: [-90, 90],
      unit: 'deg',
    },
    lng: { description: 'Longitude that faces the viewer.', range: [-180, 180], unit: 'deg' },
    spin: {
      description: 'Turns on its own around the poles; 0 stands still.',
      range: [-72, 72],
      step: 0.5,
      unit: 'deg/s',
    },
    drag: { description: 'Turn it by dragging, and with the arrow keys when it has a tabindex.' },
    style: { description: 'Land as dots, or as a solid fill of the land mask.' },
    motion: {
      description:
        'How the arcs move: draw draws each arc once along its length, for offices and showrooms; flow runs a dash along each arc again and again, from the place that names it in data-dio-to to the other, for routes, deliveries and traffic.',
    },
    dots: {
      description: 'Dots over the whole sphere, about a third of them land up on land.',
      range: [1000, 20000],
      step: 500,
    },
    scale: {
      description: 'Diameter as a fraction of the smaller side of the box.',
      range: [0.3, 1],
    },
    color: { description: 'Color of the sphere, the ocean.' },
    land: { description: 'Color of the land.' },
    marker: { description: 'Color of the markers.' },
    arc: { description: 'Color of the arcs.' },
    atmosphere: { description: 'Color of the glow along the rim.' },
    glow: { description: 'Strength of the glow along the rim.', range: [0, 1] },
    markerSize: { description: 'Diameter of a marker.', range: [2, 24], unit: 'px' },
    fps: {
      description: 'Most frames a second while it spins on its own; dragging runs at full rate.',
      range: [0, 60],
      step: 1,
    },
  },
  frames:
    'While it spins or its arcs flow, at most `fps` frames a second; at full rate while dragged, coasting, turning to a place, drawing arcs or lighting a marker. None at rest without spin or flowing arcs, and none off screen.',
  touch:
    'Nothing hovers: a tap on a marker works as a click. A finger turns the globe only when the element has `touch-action: pan-y` or `none`, otherwise the gesture scrolls the page.',
  reducedMotion:
    'No spin, no coasting after a drag, arcs drawn whole at once without a flowing dash, and turns to a focused place made in one step. Dragging, arrow keys and lit markers still work: the visitor starts them.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, so its opaque sphere never switches to transparent mid-transition.',
  quality: {
    low: '4000 dots, spin at 20 frames a second.',
    medium: '8000 dots.',
  },
  cost: {
    gpu: 'Five draw calls: the sphere, all land dots as one instanced call, all markers, all arcs and the glow.',
    memory:
      'About 12 bytes per land dot (40 KB at 12000 dots), or a 260 KB land mask texture for `solid`.',
  },
  examples: [
    {
      title: 'Offices as a list inside the globe',
      html: '<div class="globe" data-dio="globe" data-dio-lat="40" data-dio-lng="10" style="touch-action: pan-y"><ul><li id="ber" data-dio-lat="52.52" data-dio-lng="13.40" data-dio-to="nyc sgp"><a href="/offices/berlin">Berlin</a></li><li id="nyc" data-dio-lat="40.71" data-dio-lng="-74.01"><a href="/offices/new-york">New York</a></li><li id="sgp" data-dio-lat="1.35" data-dio-lng="103.82"><a href="/offices/singapore">Singapore</a></li></ul></div>',
    },
    {
      title: 'A visible legend outside the globe',
      html: '<div class="globe" data-dio="globe" data-dio-markers="#showrooms li" aria-hidden="true"></div><ul id="showrooms"><li data-dio-lat="48.86" data-dio-lng="2.35"><a href="/showrooms/paris">Paris</a></li><li data-dio-lat="35.68" data-dio-lng="139.69"><a href="/showrooms/tokyo">Tokyo</a></li></ul>',
    },
    {
      title: 'Routes from JSON with flowing arcs, solid land',
      html: '<div class="globe" data-dio="globe" data-dio-data="/routes.json" data-dio-style="solid" data-dio-motion="flow" data-dio-spin="0"></div>',
    },
    {
      title: 'A tooltip from the marker event',
      html: '<div class="globe" data-dio="globe" data-dio-markers="#cities li"></div><p class="tip"></p>',
      ts: [
        "document.querySelector('.globe').addEventListener('dio:marker', (e) => {",
        "  document.querySelector('.tip').textContent = e.detail.marker?.textContent ?? ''",
        '})',
      ].join('\n'),
    },
  ],
  events: [
    {
      name: 'dio:marker',
      description:
        'A marker lights up under the pointer, from a hovered legend item or a focused link, or goes dark (marker and id null). Bubbles; tooltips and the pointer cursor are up to the site.',
      detail: '{ marker: Element | null; id: string | null }',
    },
  ],
  children: [
    {
      attribute: 'data-dio-lat',
      description: 'Latitude of the place in degrees, -90 to 90.',
    },
    {
      attribute: 'data-dio-lng',
      description: 'Longitude of the place in degrees, -180 to 180.',
    },
    {
      attribute: 'data-dio-to',
      description: 'Ids of other places to draw arcs to, separated by spaces.',
    },
  ],
  credits: 'Land data: Natural Earth (public domain)',
}

export default doc
