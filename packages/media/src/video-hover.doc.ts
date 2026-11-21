import type { EffectDoc } from '@dioramajs/effects'
import type videoHover from './video-hover'

const doc: EffectDoc<typeof videoHover> = {
  category: 'video',
  tags: ['photo', 'gallery'],
  summary:
    'A thumbnail plays a short muted video preview while the pointer rests on it or its link has keyboard focus.',
  looks:
    'At rest the thumbnail is your image. Hovered for a moment, it crossfades into a muted video that plays in the same frame, cropped like the image, and fades back to the image when the pointer leaves. With scrub, the pointer’s position across the thumbnail picks the moment of the video instead, and a thin bar along the bottom edge shows where you are. The video downloads only when someone hovers or focuses the thumbnail.',
  target:
    'an img thumbnail, usually inside a link: course and product cards, portfolio grids, stock footage',
  params: {
    src: {
      description:
        'Video URL, or several by spaces such as WebM then MP4: the first playable one plays.',
    },
    scrub: {
      description:
        'off plays from the from time while hovered; pointer seeks by the pointer’s x, for footage.',
    },
    duration: {
      description: 'Length of the crossfade between image and video.',
      range: [0, 1.5],
      unit: 's',
    },
    delay: {
      description:
        'Hover time before the video loads and plays, so a passing pointer loads nothing.',
      range: [0, 1],
      unit: 's',
    },
    from: { description: 'Time in the video the preview starts from.', range: [0, 60], unit: 's' },
    loop: {
      description:
        'Plays the video again from the from time; off fades back to the image at its end.',
    },
  },
  frames:
    'Only while the video plays or crossfades, at the video’s own frame rate; none at rest, and none for pointer moves while the image shows.',
  touch:
    'Not loaded on touch screens: the effect runs only where (hover: hover) and (pointer: fine) match, so a tap opens the link as usual and no video downloads on mobile data.',
  reducedMotion: 'Off: the image stays as it is and no video loads.',
  presence: 'The copy fades with the page while it plays; at rest the image is the DOM.',
  quality: {},
  cost: {
    gpu: 'One texture read of the video per pixel of the thumbnail while it shows.',
    memory:
      'One video frame on the GPU while the preview shows, freed when it fades out. Keep previews short and small: 5 to 10 seconds at 640 px wide.',
  },
  examples: [
    {
      title: 'A course card',
      html: '<a href="/courses/ceramics"><img src="/courses/ceramics.webp" alt="Throwing a bowl on the wheel" data-dio="video-hover" data-dio-src="/courses/ceramics.webm /courses/ceramics.mp4"><span>Ceramics for beginners</span></a>',
    },
    {
      title: 'Stock footage, scrubbed by the pointer',
      html: '<a href="/clips/surf"><img src="/clips/surf.webp" alt="Surfers at dawn" data-dio="video-hover" data-dio-src="/clips/surf.mp4" data-dio-scrub="pointer"></a>',
    },
    {
      title: 'Played once from the tenth second',
      html: '<img src="/films/trailer.webp" alt="Trailer" data-dio="video-hover" data-dio-src="/films/trailer.mp4" data-dio-from="10" data-dio-loop="false">',
    },
  ],
}

export default doc
