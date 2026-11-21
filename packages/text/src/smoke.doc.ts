import type { EffectDoc } from '@dioramajs/effects'
import type smoke from './smoke'

const doc: EffectDoc<typeof smoke> = {
  category: 'text',
  tags: ['3d', 'scroll'],
  summary:
    'A heading condenses out of drifting volumetric smoke as it comes into view, or dissolves into it as it leaves.',
  looks:
    'Smoke drifts in from below, swirls and thickens into the shapes of the letters, and the letters sharpen out of it until the plain text takes over. Dissolving, the letters soften and break up while plumes curl off their tops and rise away. The smoke is a real volume with depth: it is lit from behind and above, so thin wisps glow at their edges and the thick parts fall into their own shadow, and its layers shift against each other as the page scrolls. Styles give grey-white smoke for dark pages, a soft pale fog for light ones, or ink blooming in water in the color of the text.',
  target:
    'a large heading or a short line of display text. Not img, video, canvas, svg or form fields. Text with text-shadow, a text stroke, background-clip: text or vertical writing stays as it is',
  params: {
    style: {
      description:
        'smoke is grey-white smoke lit from behind, for dark pages; mist is a soft pale fog for light pages; ink blooms in the color of the text, like ink in water.',
    },
    trigger: {
      description:
        'view condenses the heading when it comes into view, a first-screen heading included; scroll condenses it toward the middle of the viewport and dissolves it as it leaves; hover lets wisps curl off the letters under the pointer; loop keeps smoke rising off the letters.',
    },
    density: {
      description: 'Thickness of the smoke; 0 leaves only the letters softening and fading.',
      range: [0, 3],
    },
    speed: {
      description: 'Pace of the swirling and drifting; 0 freezes the smoke in place.',
      range: [0, 3],
    },
    rise: {
      description: 'How far the smoke drifts upward as it leaves the letters; 0 keeps it in place.',
      range: [0, 3],
    },
    turbulence: {
      description: 'Strength of the swirls; 0 lets the smoke drift without curling.',
      range: [0, 3],
    },
    duration: {
      description: 'Time the view trigger takes to condense, and a hover wisp takes to settle.',
      range: [0.5, 8],
      unit: 's',
    },
    color: {
      description:
        'Any CSS color for the smoke; empty uses grey-white for smoke, a pale fog for mist or the text color for ink.',
    },
    seed: {
      description: 'Picks the pattern of the swirls; the same seed drifts the same way.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'While the view trigger condenses, while scrolling with the scroll trigger and while hover wisps settle; none at rest. The loop trigger draws 30 frames a second while it is on screen.',
  touch: 'The same as with a mouse; with the hover trigger a tap breathes a wisp off the letters.',
  reducedMotion: 'Off: the text shows as it is, without smoke.',
  presence:
    'Leaving a page, the heading dissolves up into smoke; entering, it condenses out of it.',
  quality: {
    low: '8 steps through the volume without a light step, and the text rastered at 1 device pixel per CSS pixel.',
    medium: '12 steps with one step toward the light.',
  },
  cost: {
    gpu: 'One quad over the text and the room its smoke needs, marching 16 steps through the volume per pixel at the high tier, each with up to eight texture reads; empty air costs three.',
    memory:
      'A canvas of the text at twice its CSS size, a coarse half-float field of the glyphs and a 32 by 32 by 32 noise cube shared by every heading: about 3 MB for a large heading.',
  },
  examples: [
    {
      title: 'A hero heading that condenses out of smoke',
      html: '<h1 data-dio="smoke">Out of the smoke</h1>',
    },
    {
      title: 'Fog on a light page, scrubbed by the scroll',
      html: '<h2 data-dio="smoke" data-dio-style="mist" data-dio-trigger="scroll">Morning on the lake</h2>',
    },
    {
      title: 'Ink blooming in water',
      html: '<h2 data-dio="smoke" data-dio-style="ink" data-dio-turbulence="1.6">Written in water</h2>',
    },
    {
      title: 'A label that smokes under the pointer',
      html: '<a href="/menu" data-dio="smoke" data-dio-trigger="hover">See the menu</a>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Slow burn</h2>',
      ts: "app.attach('.title', 'smoke', { trigger: 'loop', rise: 1.4 })",
    },
  ],
}

export default doc
