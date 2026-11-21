import type { EffectDoc } from '@dioramajs/effects'
import type beat from './beat'

const doc: EffectDoc<typeof beat> = {
  category: 'audio',
  tags: ['block'],
  summary:
    'A cover, logo, card or play button that pulses with the music of a page player: it scales, shakes and glows, or sends out rings, on the beat.',
  looks:
    'While the <audio> or <video> plays, the element swells by zoom on every beat of the kick drum and settles back over duration, with a soft halo in color around its rounded shape, or a ring that travels outward from its edge for each beat. by bass follows the bass line instead of single beats, by level the loudness of any sound, such as a voice. The element itself stays live DOM: links and buttons work, text stays sharp. Paused, nothing moves and nothing draws.',
  target:
    'any element near an <audio> or <video>: a cover image, a logo, a card or the play button; the player is the nearest one around it, or the one data-dio-for names',
  params: {
    for: {
      description:
        'Selector of the audio or video; empty takes the first one in the closest container that holds one.',
    },
    by: {
      description:
        'What drives the pulse: beat jumps on each kick drum, for music with a beat; bass follows the bass line smoothly, for slow or ambient music; level follows the loudness, for podcasts and talks.',
    },
    style: {
      description:
        'glow lights a soft halo around the element that breathes with the pulse; ring sends a thin ring out from its edge on each beat, for round play buttons and avatars.',
    },
    color: { description: 'Color of the halo and the rings, any CSS color.' },
    zoom: {
      description:
        'Scale of the element at the top of a pulse, 1.06 grows it by 6 %; 1 or 0 keeps its size.',
      range: [1, 1.3],
      step: 0.01,
    },
    shake: {
      description:
        'How far the element jolts on a beat, in a new direction each time; 0 keeps it still.',
      range: [0, 12],
      step: 0.5,
      unit: 'px',
    },
    glow: {
      description:
        'Strength of the halo and the rings; 0 draws nothing and leaves only zoom and shake.',
      range: [0, 1],
      step: 0.05,
    },
    spread: {
      description: 'How far the halo reaches and the rings travel past the edge.',
      range: [0, 96],
      step: 1,
      unit: 'px',
    },
    sensitivity: {
      description: 'How readily a rise in the bass counts as a beat; higher catches softer beats.',
      range: [0, 1],
      step: 0.05,
    },
    duration: {
      description: 'Time a pulse takes to settle back.',
      range: [0.05, 1.5],
      step: 0.01,
      unit: 's',
    },
    fps: { description: 'Frame cap while the music plays.', range: [1, 60], step: 1 },
  },
  frames:
    'None while the player is paused; at most fps while it plays, then until the last pulse and ring fade.',
  touch: 'The same as with a mouse: the pulse follows the sound, not the pointer.',
  reducedMotion:
    'No zoom, shake or rings: while the music plays the halo holds a steady soft light, and the sound is never analyzed.',
  presence: 'The halo fades with the page; the element itself leaves with the DOM.',
  quality: { low: 'At most 30 fps.', medium: 'At most 45 fps.' },
  cost: {
    gpu: 'One quad around the element drawn by a fragment shader, only while a pulse or a ring shows.',
    memory: 'A few kilobytes of analyzer data.',
  },
  examples: [
    {
      title: 'An album cover that swells on the kick drum',
      html: '<audio id="track" src="/audio/single.mp3" controls="" preload="metadata"></audio><img class="cover" src="/img/cover.jpg" alt="Night Drive, the single" data-dio="beat" data-dio-for="#track">',
    },
    {
      title: 'A round play button that sends out rings',
      html: '<div class="player"><button class="play" data-dio="beat" data-dio-style="ring" data-dio-zoom="1.03" data-dio-color="#7fd3ff">Play</button><audio src="/audio/live-set.mp3" preload="none"></audio></div>',
    },
    {
      title: 'A podcast cover that breathes with the voice',
      html: '<figure class="episode"><img src="/img/ep42.jpg" alt="Episode 42" data-dio="beat" data-dio-by="level" data-dio-zoom="1.02" data-dio-glow="0.5"><audio src="/audio/ep42.mp3" controls="" preload="none"></audio></figure>',
    },
  ],
}

export default doc
