import type { EffectDoc } from '@dioramajs/effects'
import type scrub from './scrub'

const doc: EffectDoc<typeof scrub> = {
  category: 'video',
  tags: ['scroll', '3d'],
  summary:
    'A video scrubbed by scroll: its time follows the sticky section it plays in, forward and back.',
  looks:
    'While the section pins its stage, scrolling down plays the video forward and scrolling up plays it back, the way product pages turn a device or take it apart. Every frame the browser decodes crossfades from the one before for as long as the frames take to come, at most blend, so the picture moves smoothly even when seeks lag behind the scroll and stays sharp when they keep up. Frames are framed by the object-fit and object-position of the video. Encoding decides how smooth it is: give the file a keyframe every few frames (ffmpeg -g 5, or -g 1 for every frame) and enough frames for the scroll, 24 to 30 a second, since a few frames stretched over a long scroll step however they blend; keep it short and at most 1080p, with no sound; a file from a phone or an editor has a keyframe every few seconds, and every seek backwards then decodes up to that many frames.',
  target: 'video, muted, with preload="auto" and a poster of its first frame',
  params: {
    by: {
      description:
        'What drives the time: pin of the sticky section, viewport progress, or position alone.',
    },
    start: {
      description: 'Progress at which the scrubbed span begins.',
      range: [0, 1],
      unit: 'fraction',
    },
    end: {
      description: 'Progress at which the scrubbed span ends.',
      range: [0, 1],
      unit: 'fraction',
    },
    position: {
      description: 'Place in the span shown when by is manual, for a tween or a slider.',
      range: [0, 1],
      unit: 'fraction',
    },
    from: { description: 'Time in the video the span starts at.', range: [0, 60], unit: 's' },
    to: {
      description: 'Time in the video the span ends at, in seconds; auto is the end of the video.',
      range: [0, 60],
      unit: 's',
    },
    ease: {
      description:
        'Smoothing of the time behind scroll; 0 follows scroll at once (Lenis already smooths it).',
      range: [0, 1],
      unit: 's',
    },
    blend: {
      description:
        'Longest crossfade from one decoded frame to the next; frames that come quicker fade quicker. 0 cuts.',
      range: [0, 0.5],
      unit: 's',
    },
    resolution: {
      description: 'Longest side in px a frame is copied at; larger videos shrink on the GPU.',
      range: [320, 3840],
      unit: 'px',
    },
  },
  frames:
    'Scroll draws its own frames; a decoded frame asks for one, and ease and blend keep drawing until the time and the crossfade settle. None at rest, and no seeks while the video is off screen.',
  touch: 'Works as on desktop: scroll drives it.',
  reducedMotion:
    'Off: the video shows its poster and is never seeked. People with reduced motion and without WebGL see the poster, so choose it on purpose.',
  presence: 'Fades with the page transition.',
  quality: {
    medium: 'Frames copied at up to 1440 px.',
    low: 'Frames copied at up to 960 px.',
  },
  cost: {
    gpu: 'Two texture reads per pixel of the box, one frame copy and upload per decoded frame.',
    memory:
      'The video as the browser buffers it, and two copied frames on the GPU. A 4 second 1080p clip with a keyframe every 5 frames is about 2 to 4 MB as H.264 or VP9.',
  },
  examples: [
    {
      title: 'Scrubbed in a sticky section',
      html: '<section class="turn" style="height: 400vh"><div class="stage" style="position: sticky; top: 0; height: 100vh"><video src="/film/turn.mp4" poster="/film/turn.webp" muted="" playsinline="" preload="auto" data-dio="scrub"></video></div></section>',
    },
    {
      title: 'Encoding for scrubbing',
      html: '<!-- ffmpeg -i turn.mov -an -c:v libx264 -g 5 -crf 20 -pix_fmt yuv420p -movflags +faststart turn.mp4 -->\n<video src="/film/turn.mp4" poster="/film/turn.webp" muted="" playsinline="" preload="auto" data-dio="scrub" data-dio-blend="0.2"></video>',
    },
    {
      title: 'Seconds 2 to 6 of a longer film, driven by a slider',
      html: '<video class="film" src="/film/assembly.mp4" muted="" playsinline="" preload="auto" data-dio="scrub" data-dio-by="manual" data-dio-from="2" data-dio-to="6"></video><input class="at" type="range" min="0" max="1" step="0.001" value="0" aria-label="Assembly step">',
      ts: [
        "const film = app.effects.get(document.querySelector('.film'), 'scrub')",
        "document.querySelector('.at').addEventListener('input', (e) => {",
        '  film?.set({ position: Number(e.target.value) })',
        '})',
      ].join('\n'),
    },
  ],
}

export default doc
