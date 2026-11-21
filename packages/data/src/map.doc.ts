import type { EffectDoc } from '@dioramajs/effects'
import type map from './map'

const doc: EffectDoc<typeof map> = {
  category: 'data',
  summary:
    'A flat map of the world or a region with markers for a list of places and arcs between them.',
  looks:
    'The continents as a grid of dots or a solid fill on an Equal Earth projection, fitted to the box with no frame or ocean unless asked. Each place is a round marker; the one under the pointer or in focus grows and gets a ring. Arcs between places bow towards the north and draw themselves in once the map scrolls into view.',
  target:
    'an element with a list of places inside, or an empty element with `markers` pointing at a list elsewhere, sized with CSS',
  params: {
    markers: {
      description:
        'Selector of the places: inside the element, or in the document when none are inside.',
    },
    style: { description: 'Land as a grid of dots, or as a solid fill of the land mask.' },
    region: {
      description:
        'Part of the world to frame: world without Antarctica; europe; americas; asia; africa; oceania. The box shows more map around it.',
    },
    dots: {
      description: 'Dots across the width of the box, in the dots style.',
      range: [40, 400],
      step: 10,
    },
    center: {
      description: 'Moves the middle of the map east (positive) or west, in degrees of longitude.',
      range: [-180, 180],
      unit: 'deg',
    },
    zoom: {
      description: 'Magnifies the region about its middle; 1 fits the whole region.',
      range: [1, 8],
      step: 0.1,
    },
    color: { description: 'Color of the sea, drawn only when `sea` is above 0.' },
    sea: {
      description: 'Opacity of the sea dots or fill; 0 leaves the page background.',
      range: [0, 1],
    },
    land: { description: 'Color of the land.' },
    marker: { description: 'Color of the markers.' },
    arc: { description: 'Color of the arcs.' },
    markerSize: { description: 'Diameter of a marker.', range: [2, 24], unit: 'px' },
  },
  frames:
    'Only while the arcs draw in and for a few frames as a marker lights up or goes dark; none at rest.',
  touch: 'Nothing hovers: a tap on a marker works as a click on its link.',
  reducedMotion: 'Arcs stand drawn from the first frame and markers light up without easing.',
  presence: 'Fades with the page while settling from 98% of its size.',
  quality: { low: '100 dots across.', medium: '130 dots across.' },
  cost: {
    gpu: 'Three draw calls: all dots (or the land mesh), all markers and all arcs.',
    memory:
      'About 12 bytes per dot (under 150 KB at 160 across), or a 260 KB land mask texture for `solid`.',
  },
  examples: [
    {
      title: 'Offices with routes from the head office',
      html: '<div class="map" data-dio="map"><ul><li id="ams" data-dio-lat="52.37" data-dio-lng="4.90" data-dio-to="nyc sin"><a href="/offices/amsterdam">Amsterdam</a></li><li id="nyc" data-dio-lat="40.71" data-dio-lng="-74.01"><a href="/offices/new-york">New York</a></li><li id="sin" data-dio-lat="1.35" data-dio-lng="103.82"><a href="/offices/singapore">Singapore</a></li></ul></div>',
    },
    {
      title: 'Stores in Europe as a solid map with a visible list',
      html: '<div class="map" data-dio="map" data-dio-region="europe" data-dio-style="solid" data-dio-markers="#stores li" aria-hidden="true"></div><ul id="stores"><li data-dio-lat="48.86" data-dio-lng="2.35"><a href="/stores/paris">Paris</a></li><li data-dio-lat="41.39" data-dio-lng="2.17"><a href="/stores/barcelona">Barcelona</a></li></ul>',
    },
    {
      title: 'A tooltip from the marker event',
      html: '<div class="map" data-dio="map" data-dio-markers="#events li"></div><p class="tip"></p>',
      ts: [
        "document.querySelector('.map').addEventListener('dio:marker', (e) => {",
        "  document.querySelector('.tip').textContent = e.detail.marker?.textContent ?? ''",
        '})',
      ].join('\n'),
    },
  ],
  events: [
    {
      name: 'dio:marker',
      description:
        'A marker lights up under the pointer, from a hovered legend item or a focused link, or goes dark (marker and id null). Bubbles.',
      detail: '{ marker: Element | null; id: string | null }',
    },
  ],
  children: [
    { attribute: 'data-dio-lat', description: 'Latitude of the place in degrees, -90 to 90.' },
    { attribute: 'data-dio-lng', description: 'Longitude of the place in degrees, -180 to 180.' },
    {
      attribute: 'data-dio-to',
      description: 'Ids of other places to draw arcs to, separated by spaces.',
    },
  ],
  credits: 'Land data: Natural Earth (public domain)',
}

export default doc
