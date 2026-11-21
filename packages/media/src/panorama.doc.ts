import type { EffectDoc } from '@dioramajs/effects'
import type panorama from './panorama'

const doc: EffectDoc<typeof panorama> = {
  category: '3d',
  tags: ['photo'],
  summary: 'A 360° photo in a box that turns by drag, keys and gyroscope, with hotspots.',
  looks:
    'The box shows an equirectangular 360° × 180° photo in perspective with the vertical field of view fov. Dragging turns it with inertia, arrows turn it by steps, the wheel with Ctrl or a pinch zooms, and a phone can steer it by tilt. Hotspots are rings on the sphere: hover lights them, a click follows their link, and focus on a link turns the view to it.',
  target: 'an element with a poster img',
  params: {
    src: { description: 'Equirectangular 2:1 panorama: jpg, webp, avif or ktx2.' },
    preview: { description: 'Small panorama of 1 to 2K shown first.' },
    yaw: {
      description: 'View direction; a change turns smoothly.',
      range: [-180, 180],
      unit: 'deg',
    },
    pitch: { description: 'View tilt up or down.', range: [-85, 85], unit: 'deg' },
    fov: { description: 'Vertical field of view.', range: [20, 120], unit: 'deg' },
    range: { description: 'Zoom limits of the field of view.', range: [20, 120], unit: 'deg' },
    spin: {
      description: 'Turning by itself in degrees per second, 0 for none.',
      range: [-30, 30],
      unit: 'deg/s',
    },
    drag: { description: 'Dragging turns the view.' },
    zoom: {
      description:
        'Ctrl or ⌘ with the wheel, a pinch and the + and - keys zoom within range; off keeps fov, and Ctrl with the wheel zooms the page as usual.',
    },
    gyro: { description: 'Phone tilt steers the view; iOS asks for permission on the first tap.' },
    markers: { description: 'Selector of hotspots: inside the element, else in the document.' },
    marker: { description: 'Color of the hotspots.' },
    markerSize: { description: 'Diameter of a hotspot.', range: [8, 64], unit: 'px' },
    fps: { description: 'Frame cap while turning by itself.', range: [1, 60], step: 1 },
    resolution: {
      description:
        'Cap on the long side when decoding a JPEG, PNG or AVIF panorama. A KTX2 file is used as it is, up to the device limit: the way to 8K without a long stall.',
      range: [1024, 8192],
      unit: 'px',
    },
  },
  frames:
    'None at rest; full rate while dragging or coasting, at most fps while turning by itself.',
  touch:
    'With touch-action: pan-y a drag turns only sideways and vertical swipes scroll the page; with none, both, and a pinch zooms.',
  reducedMotion: 'No spin and no inertia; turning to a hotspot is instant.',
  presence: 'Fades with the page transition; a keyed flight carries the panorama.',
  quality: {
    low: 'Decodes at most 2048 px and turns by itself at 20 fps.',
    medium: 'Decodes at most 4096 px.',
  },
  cost: {
    gpu: 'One quad and one texture read with gradients; hotspots as instances.',
    memory:
      'An 8192 × 4096 picture is about 179 MB with mipmaps; serve 8K as KTX2 for about 45 MB.',
  },
  examples: [
    {
      title: 'A room with hotspots in a legend',
      html: '<div class="tour" data-dio="panorama" data-dio-src="/pano/suite.ktx2" data-dio-preview="/pano/suite-1k.webp" data-dio-yaw="40" data-dio-spin="3" tabindex="0" style="touch-action: pan-y"><img src="/img/suite.avif" alt="Garden suite, 360° view" /></div><ul class="tour-legend"><li data-dio-yaw="-95" data-dio-pitch="-8"><a href="/rooms/veranda">Veranda</a></li><li data-dio-yaw="160" data-dio-pitch="-5"><a href="/rooms/lounge">Wooden lounge</a></li></ul>',
    },
  ],
  events: [
    {
      name: 'dio:marker',
      description: 'A hotspot was hovered or left; marker is its element, id its id.',
      detail: '{ marker: Element | null; id: string | null }',
    },
  ],
  children: [
    { attribute: 'data-dio-yaw', description: 'Yaw of a hotspot in degrees.' },
    { attribute: 'data-dio-pitch', description: 'Pitch of a hotspot in degrees, 0 by default.' },
  ],
}

export default doc
