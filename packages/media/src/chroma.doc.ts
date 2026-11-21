import type { EffectDoc } from '@dioramajs/effects'
import type chroma from './chroma'

const doc: EffectDoc<typeof chroma> = {
  category: 'video',
  tags: ['3d'],
  summary:
    'A video shot on a green or blue screen, played over the page with the screen keyed out.',
  looks:
    'The product or presenter stands on your page as if the video had transparency, from one ordinary MP4 or WebM that plays in every browser, Safari included, where WebM alpha does not play and HEVC with alpha is hard to make. Pixels close to the screen color turn clear, with a soft ramp at the edge; green that the screen threw onto the subject is taken out, fully at the edge and by spill inside, and the edge itself is averaged over a few neighboring pixels so it does not crawl. Before the video plays its poster shows keyed the same way.',
  target:
    'video on a green or blue screen, muted for autoplay, with a poster of its first frame; your own play button and captions next to it',
  params: {
    by: {
      description:
        'color keys out the screen param; auto reads the screen color every frame from whichever top corner of the frame is greener, for unevenly lit footage.',
    },
    screen: { description: 'Color of the screen to remove, green by default; #0047bb for blue.' },
    similarity: {
      description: 'How far from the screen color a pixel may be and still turn clear.',
      range: [0, 1],
    },
    softness: {
      description: 'Width of the soft ramp from clear to opaque past similarity; 0 cuts hard.',
      range: [0, 0.5],
    },
    spill: {
      description:
        'Share of the screen’s hue taken out of the subject, all of it at the see-through edge; 0 keeps every color as shot.',
      range: [0, 1],
    },
    blur: {
      description: 'Distance in px of the neighbors each pixel’s key is averaged with; 0 is off.',
      range: [0, 4],
      unit: 'px',
    },
    crop: {
      description:
        'Share of the frame cut off at the top, right, bottom and left, for light stands and the screen’s end.',
      range: [0, 0.5],
      unit: 'fraction',
    },
  },
  frames:
    'One frame per video frame while it plays and is on screen, at the video’s own rate; none while it is paused, before it plays or off screen.',
  touch: 'The same as on desktop; tapping works as the site’s own buttons do.',
  reducedMotion:
    'Keyed as usual: keying is not motion. Whether the video plays is up to the site; under reduced motion, start it paused and let the visitor play it.',
  presence: 'Fades with the page transition.',
  quality: { low: 'No blur: one texture read per pixel instead of five.' },
  cost: {
    gpu: 'Five texture reads per pixel of the video’s box with blur, one without, and a small color transform.',
    memory:
      'One video frame on the GPU, and the poster until the video plays. The video itself is as large as the file: no second copy with alpha.',
  },
  examples: [
    {
      title: 'A product turning on the page',
      html: '<video src="/film/bottle.mp4" poster="/film/bottle.webp" autoplay="" muted="" loop="" playsinline="" data-dio="chroma" aria-label="The bottle, turning"></video>',
    },
    {
      title: 'A presenter on a blue screen, with your own controls',
      html: '<figure class="host"><video class="talk" src="/talk/intro.mp4" poster="/talk/intro.webp" playsinline="" data-dio="chroma" data-dio-screen="#0047bb" data-dio-crop="0 0.05 0 0.05"></video><button class="play" aria-pressed="false">Play</button><p class="caption" aria-live="polite"></p></figure>',
      ts: [
        "const talk = document.querySelector('.talk')",
        "const play = document.querySelector('.play')",
        "play.addEventListener('click', () => (talk.paused ? talk.play() : talk.pause()))",
        "talk.addEventListener('play', () => play.setAttribute('aria-pressed', 'true'))",
        "talk.addEventListener('pause', () => play.setAttribute('aria-pressed', 'false'))",
      ].join('\n'),
    },
    {
      title: 'Unevenly lit footage, keyed from the corners',
      html: '<video src="/film/studio.mp4" autoplay="" muted="" loop="" playsinline="" data-dio="chroma" data-dio-by="auto" data-dio-spill="0.8"></video>',
    },
    {
      title: 'Hidden without WebGL, so the green screen never shows',
      html: '<style>video[data-dio~="chroma"][data-dio-state="off"] { visibility: hidden }</style>',
    },
  ],
}

export default doc
