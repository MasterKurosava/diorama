import type { EffectDoc } from '@dioramajs/effects'
import type clouds from './clouds'

const doc: EffectDoc<typeof clouds> = {
  category: 'background',
  tags: ['scroll'],
  summary:
    'A sky of soft layered clouds for the time of day, daylight, a sunset or a moonlit night, drifting in the wind and parting on scroll.',
  looks:
    'A sky gradient from the horizon up with up to three layers of clouds over it. Clouds shrink and thin out toward the horizon, so the sky has depth; each one is lit from the sun, bright on its sunny side, darker where it is thick and underneath, with a glowing edge where it is thin. The wind moves the layers sideways, nearer ones faster, and the scroll and the pointer shift them apart. The day style has a blue sky with white clouds and a pale sun high up, sunset an orange to violet sky with peach clouds and the sun low, night a dark blue sky with stars and clouds lit by the moon.',
  target:
    'an empty decorative element behind the content, such as an aria-hidden div filling a hero; its CSS background is the look without WebGL',
  params: {
    style: {
      description:
        'day, a blue sky with white clouds, for travel, airline and kids’ sites; sunset, an orange and violet sky with peach clouds, for hotels, resorts and evening events; night, a dark sky with stars and moonlit clouds, for sleep, night events and dark themes.',
    },
    cover: {
      description: 'How much of the sky the clouds cover; 0 a clear sky, 1 overcast.',
      range: [0, 1],
    },
    speed: { description: 'Wind speed; 0 holds the clouds in place.', range: [0, 1] },
    scale: { description: 'Size of the clouds.', range: [0.3, 3] },
    sun: {
      description:
        'Brightness of the sun or the moon, its glow and the light on cloud edges; 0 hides it.',
      range: [0, 1],
    },
    depth: {
      description: 'How far the layers shift apart with the pointer; 0 ignores the pointer.',
      range: [0, 1],
    },
    scroll: {
      description:
        'How far the layers move while the element crosses the viewport, nearer ones more; 0 keeps them.',
      range: [0, 1],
    },
    layers: { description: 'Layers of clouds, 1 to 3.', range: [1, 3], step: 1 },
    fps: {
      description: 'Most frames a second the wind draws; 0 holds it still.',
      range: [0, 60],
      step: 1,
    },
    seed: { description: 'Shapes of the clouds.', range: [1, 100], step: 1 },
  },
  frames:
    'Up to fps frames a second while on screen, none off screen or at fps 0; pointer and scroll draw at full rate.',
  touch: 'The layers shift with a finger while it is on the screen; scrolling works as usual.',
  reducedMotion: 'A still sky: no wind, and neither the pointer nor scroll moves the clouds.',
  presence: 'Fades with the page transition.',
  quality: {
    low: 'At most 15 frames a second and one layer of clouds.',
    medium: 'At most 24 frames a second and two layers.',
  },
  cost: {
    gpu: 'One pass over the element: four reads of a noise tile per layer and pixel.',
    memory: 'A 256 × 256 noise tile, 256 KB, shared by every clouds of the same seed.',
  },
  examples: [
    {
      title: 'A travel hero',
      html: '<header class="hero"><div class="hero-sky" aria-hidden="true" data-dio="clouds" data-dio-cover="0.4"></div><h1>Fly to Lisbon from 49 €</h1></header>',
      ts: "start({ canvas: 'behind' })",
    },
    {
      title: 'A sunset for a resort',
      html: '<section class="stay"><div class="stay-sky" aria-hidden="true" data-dio="clouds" data-dio-style="sunset" data-dio-cover="0.55"></div><h2>Evenings on the terrace</h2></section>',
    },
    {
      title: 'A night sky for a sleep app',
      html: '<div class="night-bg" aria-hidden="true" data-dio="clouds" data-dio-style="night" data-dio-cover="0.3" data-dio-speed="0.1"></div>',
    },
    {
      title: 'From code',
      html: '<div class="sky" aria-hidden="true"></div>',
      ts: "app.attach('.sky', 'clouds', { cover: 0.7, scale: 1.4, depth: 0 })",
    },
  ],
}

export default doc
