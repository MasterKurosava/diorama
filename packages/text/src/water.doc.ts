import type { EffectDoc } from '@dioramajs/effects'
import type water from './water'

const doc: EffectDoc<typeof water> = {
  category: 'text',
  tags: ['3d'],
  summary:
    'A headline under water: the surface bends the letters, focuses dancing caustics on them and ripples under the pointer.',
  looks:
    'The text lies a few centimeters under a real water surface. On the page the water is a puddle around the words with a wandering, rounded shore, shallow and nearly clear at its edge and deeper toward the letters, where its surface curls down to the page in a thin bright line; on an element with its own background it fills that box like a pool with walls. A height field simulated on the GPU, plus a slow swell, gives every point of the surface a normal: the letters are seen bent through it, the light it focuses draws a net of caustics over the letters and the floor, and the surface reflects a sky with a window and the glints of the sun by Fresnel. The water tints what lies deeper, red first. Moving the pointer drags a wake, a click drops a stone that rings out, rain lands in rings on its own, and ice is clear with frost and cracks, thinner over the letters so their color reads, until the pointer melts a clear patch that freezes over again.',
  target:
    'a heading or short text in a large font, on a solid page color or with its own solid background, with padding of about a third of an em for the puddle. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'pool is clear water with a moving swell; rain rings out under falling drops; ice is clear, frosted and cracked.',
    },
    trigger: {
      description:
        'loop keeps the water moving; hover keeps it still until the pointer comes over it.',
    },
    depth: {
      description:
        'How strongly the surface bends the letters seen through it; 0 keeps them straight.',
      range: [0, 3],
    },
    caustics: {
      description:
        'Brightness of the light the waves focus on the letters and the floor; 0 turns it off.',
      range: [0, 2],
    },
    ripples: {
      description:
        'Strength of the wake and the drops the pointer makes; 0 leaves the water alone.',
      range: [0, 3],
    },
    rain: {
      description: 'Raindrops a second with the rain style; 0 stops the rain.',
      range: [0, 30],
      step: 1,
    },
    damping: {
      description: 'How fast ripples die out; 0 lets them run and bounce for a long time.',
      range: [0, 1],
    },
    tint: {
      description: 'Depth of the water color over the letters and the page; 0 is perfectly clear.',
      range: [0, 1.5],
    },
  },
  frames:
    'With trigger loop, 30 frames a second while on screen (ice: only while a melted patch refreezes or ripples run). With hover, 30 a second while the pointer is over and the ripples settle, none at rest: the still water stays drawn.',
  touch:
    'There is no wake without a mouse. A tap drops a ripple and, with hover, wakes the swell or the rain for a moment; on ice it melts a patch.',
  reducedMotion:
    'The water stays still: the swell holds its shape, there are no ripples, rain or melting, and the still water stays drawn.',
  presence: 'The water fades with the page.',
  quality: {
    low: 'The text is rastered at 1 device pixel per CSS pixel instead of 2 and the simulation grid is coarser.',
    medium: 'The simulation grid is a little coarser.',
  },
  cost: {
    gpu: 'Two small half-float render targets of a few hundred cells a side, stepped about 60 times a second with nine reads per cell while waves run. The surface reads the simulation nine times and the letters once per pixel, plus the ice map on ice.',
    memory:
      'A canvas of the text at twice its CSS size with mip levels, two small simulation targets, a small half-float map of the shore of the puddle built once on the CPU and, for ice, a map of frost and cracks at about the size of the box.',
  },
  examples: [
    {
      title: 'A swim school headline in a sunny pool',
      html: '<h1 class="hero" data-dio="water">Summer swim</h1>',
    },
    {
      title: 'Rain on a dark page',
      html: '<h2 data-dio="water" data-dio-style="rain" data-dio-rain="10">After the storm</h2>',
    },
    {
      title: 'An ice label that thaws under the pointer',
      html: '<h2 class="label" data-dio="water" data-dio-style="ice">Winter sale</h2>',
    },
    {
      title: 'Still until hovered',
      html: '<h2 class="title">Open water</h2>',
      ts: "app.attach('.title', 'water', { trigger: 'hover', ripples: 1.5 })",
    },
  ],
}

export default doc
