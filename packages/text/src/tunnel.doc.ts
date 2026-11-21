import type { EffectDoc } from '@dioramajs/effects'
import type tunnel from './tunnel'

const doc: EffectDoc<typeof tunnel> = {
  category: 'text',
  tags: ['scroll', '3d'],
  summary:
    'The phrases of a pinned section stand one behind another in real depth, and the scroll flies the camera through them.',
  looks:
    'The first phrase sits where the page has it, and the next ones wait further back in the dark, smaller and fainter. Scrolling moves the camera forward: the phrase in front grows in perspective, blurs and passes the viewer, and the next one comes out of the distance and slows down to be read. In a tunnel the phrases wait on the floor and ceiling of a corridor drawn with faint lines and swing to face the reader as they arrive, and while one holds in focus nothing behind it crosses it; zoom flies straight through them; in a spiral they wait along a turning helix. A fast scroll streaks the letters toward the edges. At the end of the section the last phrase stays as plain text.',
  target:
    'a block inside a pinned section, usually filling its sticky stage, whose children are the phrases, one element each, such as paragraphs. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'tunnel lines the floor and ceiling of a corridor; zoom flies straight on; spiral turns along a helix.',
    },
    depth: {
      description: 'Distance between two phrases, in heights of the element.',
      range: [0.3, 3],
      step: 0.05,
    },
    perspective: {
      description:
        'Strength of the perspective: higher puts the eye closer, so phrases grow faster.',
      range: [0.3, 3],
      step: 0.05,
    },
    fade: {
      description: 'Fog toward the distance; 0 shows every phrase behind at full strength.',
      range: [0, 2],
      step: 0.05,
    },
    blur: {
      description: 'Blur of a phrase as it passes the viewer, at its nearest; 0 keeps it sharp.',
      range: [0, 40],
      unit: 'px',
    },
    streak: {
      description: 'Motion streaks with the scroll speed, toward the edges; 0 turns them off.',
      range: [0, 3],
      step: 0.05,
    },
    twist: {
      description: 'Turn of the helix from one phrase to the next, with style spiral.',
      range: [-180, 180],
      unit: 'deg',
    },
    lines: {
      description: 'Draws the guide lines of the tunnel or the helix; zoom has none.',
    },
    color: {
      description: 'Color of the phrases and lines; currentColor keeps the text color.',
    },
  },
  children: [
    {
      element: ':scope > *',
      description:
        'Each child element with text is one phrase, in reading order; the last one stays as text at the end.',
    },
  ],
  frames:
    'Only while the page scrolls, and a few more while the scroll speed settles with streaks on; none at rest.',
  touch: 'The same as with a mouse: the scroll drives it.',
  reducedMotion:
    'The effect does not run: the phrases stay as the page lays them out, one under another.',
  presence: 'The phrases fade with the copy as the page leaves or enters.',
  quality: {
    low: 'The phrases are rastered at 1 device pixel per CSS pixel instead of 2, without blur or streaks.',
  },
  cost: {
    gpu: 'One instanced draw of up to seven phrase cards with a 12-tap blur, and one draw of a few hundred thin line quads.',
    memory: 'One atlas of every phrase at twice its CSS size, at most 4096 px a side.',
  },
  examples: [
    {
      title: 'A launch story told in five lines while the section is pinned',
      html: '<section style="height: 500vh"><div style="position: sticky; top: 0; height: 100vh"><div data-dio="tunnel" style="height: 100%"><p>Every launch starts in the dark.</p><p>A sketch on a napkin.</p><p>A thousand late nights.</p><p>Now it ships.</p></div></div></section>',
    },
    {
      title: 'A calm zoom through a wellness intro',
      html: '<div data-dio="tunnel" data-dio-style="zoom" data-dio-depth="1.4"><p>Slow down.</p><p>Breathe in.</p><p>Stay a while.</p></div>',
    },
    {
      title: 'Event details on a spiral',
      html: '<div data-dio="tunnel" data-dio-style="spiral" data-dio-twist="70"><p>Friday</p><p>23:00</p><p>Warehouse 9</p></div>',
    },
    {
      title: 'From code',
      html: '<div class="story"><p>Plan</p><p>Build</p><p>Launch</p></div>',
      ts: "app.attach('.story', 'tunnel', { style: 'zoom', blur: 16 })",
    },
  ],
}

export default doc
