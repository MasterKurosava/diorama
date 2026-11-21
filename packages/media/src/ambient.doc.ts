import type { EffectDoc } from '@dioramajs/effects'
import type ambient from './ambient'

const doc: EffectDoc<typeof ambient> = {
  category: 'video',
  tags: ['photo'],
  summary: 'A soft glow in the colors of the frame around a video or an image, like ambient mode.',
  looks:
    'Around the box lies a large, heavily blurred copy of the frame’s main colors that fades out past the edge. While the video plays the light follows its frames a few times a second and flows from color to color; on pause it stands still. The video itself stays DOM: native controls, captions, fullscreen and picture-in-picture work as without the effect. As a shadow the light falls below the box instead, narrower than it, like a drop shadow in the picture’s colors under a cover or a card. Best on dark pages; the glow is not cut by an ancestor’s overflow, unlike box-shadow.',
  target: 'video, img',
  params: {
    style: {
      description:
        'glow lights all around the box, like ambient mode; shadow falls below it like a colored drop shadow, for covers and cards on light pages too.',
    },
    strength: { description: 'Strength of the glow at the edge of the box.', range: [0, 1] },
    spread: {
      description:
        'How far the glow reaches past the box, as a share of its shorter side, at most 240 px.',
      range: [0, 1],
      unit: 'fraction',
    },
    blur: { description: 'How much the colors of the frame are blurred together.', range: [0, 1] },
    saturation: { description: 'Saturation of the light; 1 keeps the frame’s.', range: [0, 2] },
    fps: {
      description:
        'Color updates a second while the video plays; 0 updates only on pause, seeking and start.',
      range: [0, 30],
      step: 1,
    },
    ease: {
      description: 'Time the light takes to flow to new colors.',
      range: [0, 2],
      unit: 's',
    },
    resolution: {
      description: 'Width of the grid of colors read from the frame; its height follows the frame.',
      range: [8, 32],
      step: 1,
    },
  },
  frames:
    'At most fps a second while the video plays and while colors flow; none on pause or for an image once its colors are in. Scrolling moves the glow at full rate without reading the frame again.',
  touch: 'The same as with a mouse; the quality tiers lower the update rate on weak devices.',
  reducedMotion:
    'The light changes only on start, pause and seeking, flowing for a second, so it does not breathe with the video.',
  presence: 'The glow fades with the page as it leaves.',
  quality: {
    low: 'At most 4 updates a second from an 8-cell grid.',
    medium: 'At most 8 updates a second.',
  },
  cost: {
    gpu: 'One plane the size of the box and its glow, one read of a tiny texture per pixel.',
    memory:
      'A few kilobytes. Each update draws the frame into a 16 × 9 canvas and reads it back on the CPU.',
  },
  examples: [
    {
      title: 'A video with native controls',
      html: '<video src="/film/aurum.mp4" poster="/film/aurum.avif" controls="" playsinline="" muted="" loop="" data-dio="ambient" data-dio-strength="0.6"></video>',
    },
    {
      title: 'A still image',
      html: '<img src="/shots/lamp.avif" alt="A brass lamp" data-dio="ambient" data-dio-spread="0.2">',
    },
    {
      title: 'A cover with a shadow in its colors',
      html: '<img src="/covers/night.avif" alt="Night, the album" data-dio="ambient" data-dio-style="shadow" data-dio-strength="0.7">',
    },
    {
      title: 'From another origin, which needs CORS',
      html: '<video src="https://cdn.example.com/reel.mp4" crossorigin="anonymous" controls="" data-dio="ambient"></video>',
    },
  ],
}

export default doc
