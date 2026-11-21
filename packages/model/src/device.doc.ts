import type { EffectDoc } from '@dioramajs/effects'
import type device from './device'

const doc: EffectDoc<typeof device> = {
  category: '3d',
  tags: ['photo', 'video'],
  summary: 'A screenshot or a video shown in a 3D phone, tablet, laptop or browser window.',
  looks:
    'The picture becomes the screen of a device built in 3D with the proportions of the real one: a phone with its camera island and side keys, a tablet, an open laptop with its keyboard and trackpad, or a browser window with its toolbar. The picture covers the screen, centered across and from the top down. It rests in a slight three-quarter view, lit by a soft studio light, with a soft shadow on the page under it. It leans toward the pointer and can turn as the page scrolls.',
  target:
    'img, video: the screenshot or screen recording; the box holds the whole device and shows the plain picture without WebGL. A phone or a tablet takes the box aspect within the range of real ones, a laptop screen is 16:10, a browser window 5:4 to 12:5',
  params: {
    frame: {
      description:
        'phone with a camera island and side keys, 16:9 to 19.5:9; tablet, 4:3 to 16:10; laptop, open with its keyboard, a 16:10 screen; browser, a window with a toolbar, 5:4 to 12:5.',
    },
    color: { description: 'Color of the body, any CSS color; the browser toolbar takes it too.' },
    yaw: {
      description: 'Rest turn around the vertical; negative shows the right side.',
      range: [-60, 60],
      unit: 'deg',
    },
    pitch: {
      description: 'Rest tilt toward the viewer; positive shows it from above.',
      range: [-30, 30],
      unit: 'deg',
    },
    tilt: { description: 'How far it leans toward the pointer.', range: [0, 30], unit: 'deg' },
    turn: {
      description: 'Turns it as the element passes through the viewport.',
      range: [-360, 360],
      unit: 'deg',
    },
    radius: { description: 'Corner rounding: 1 is the device as made, 0 square.', range: [0, 2] },
    shadow: { description: 'Density of the shadow on the page.', range: [0, 1] },
    scale: {
      description:
        'Size in the box: 1 fits the device as it is seen in its rest pose, near parts larger in perspective.',
      range: [0.3, 1],
    },
  },
  frames:
    'Only while it leans toward the pointer, settles, or eases to a new rest pose, plus scroll frames with turn and video frames while a video plays. None at rest.',
  touch: 'Nothing hovers, so it rests in its pose; turn still follows the scroll.',
  reducedMotion: 'It rests in its pose: no lean, no scroll turn, and a new pose is taken at once.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, and its shadow fades with it.',
  quality: {},
  cost: {
    gpu: 'A few hundred triangles lit by one prefiltered environment, the screen as one texture read.',
    memory: 'The picture or the video frame, and the environment map.',
  },
  examples: [
    {
      title: 'An app screenshot in a phone',
      html: '<img src="/shots/app.png" alt="The Tidewell app: today\'s tasks" width="1170" height="2532" data-dio="device" />',
    },
    {
      title: 'A dashboard in a browser window',
      html: '<img src="/shots/dashboard.png" alt="Analytics dashboard" width="2880" height="1800" data-dio="device" data-dio-frame="browser" data-dio-color="#e9eaee" />',
    },
    {
      title: 'A screen recording in a laptop that turns with the scroll',
      html: '<video src="/shots/tour.mp4" autoplay="" muted="" loop="" playsinline="" data-dio="device" data-dio-frame="laptop" data-dio-color="#c8cad0" data-dio-turn="54"></video>',
    },
  ],
}

export default doc
