import type { EffectDoc } from '@dioramajs/effects'
import type videoText from './video-text'

const doc: EffectDoc<typeof videoText> = {
  category: 'text',
  tags: ['video'],
  summary:
    'The letters of a headline become a window onto a video or a photo, while the page shows around them.',
  looks:
    'The headline keeps its font, size and layout, but its letters show a muted video playing inside them, framed over the text as a whole, and the page’s own background shows around and between them. Once the first frame is ready the letters turn from their CSS color into the video in about half a second. A photo works the same way and stands still. The text stays in the DOM for screen readers, search and selection.',
  target:
    'a heading or short text in a large, heavy font. Not img, video, canvas, svg or form fields',
  params: {
    src: {
      description:
        'URL of a video, or several by spaces such as WebM then MP4; an image URL shows a photo.',
    },
    fit: {
      description:
        'cover fills every letter; contain shows all of it, some letters empty; fill stretches it.',
    },
    fps: {
      description: 'Most frames drawn a second while the video plays; 0 holds the first frame.',
      range: [0, 60],
    },
    loop: { description: 'Plays the video again from the start; off holds its last frame.' },
    dim: {
      description:
        'How far the picture inside the letters goes dark, for contrast on a light page; 0 keeps it as is.',
      range: [0, 1],
    },
  },
  frames:
    'Only while the video plays and the text is on screen, at most fps a second, and for half a second as the picture fades in; none for a photo or a paused video.',
  touch: 'The same as with a mouse: the video plays while the text is on screen.',
  reducedMotion:
    'The video stands on its first frame and does not play; the letters still show it.',
  presence: 'The text fades with the page.',
  quality: {
    low: 'At most 24 frames a second, and the text is rastered at 1 device pixel per CSS pixel.',
  },
  cost: {
    gpu: 'One quad over the text: a texture read of the text and one of the video per pixel.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, and one video frame. A video of 1280 px wide or less is enough for a headline.',
  },
  examples: [
    {
      title: 'A travel headline',
      html: '<h1 class="hero" data-dio="video-text" data-dio-src="/media/coast.webm /media/coast.mp4">Go further</h1>',
    },
    {
      title: 'A photo in the letters, darkened on a light page',
      html: '<h2 data-dio="video-text" data-dio-src="/media/forest.avif" data-dio-dim="0.2">Wild Atlantic</h2>',
    },
    {
      title: 'A festival date played once',
      html: '<p class="date" data-dio="video-text" data-dio-src="/media/stage.mp4" data-dio-loop="false">07.08 Blue Signal</p>',
    },
  ],
}

export default doc
