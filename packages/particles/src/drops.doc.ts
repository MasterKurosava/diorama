import type { EffectDoc } from '@dioramajs/effects'
import type drops from './drops'

const doc: EffectDoc<typeof drops> = {
  category: 'celebration',
  tags: ['background', 'transition'],
  summary:
    'Water drops on glass over a hero or the whole page: rain that beads and runs, or meltwater left by a thaw.',
  looks:
    'Drops sit on an invisible pane of glass over the page. Small ones rest as beads; heavy ones run down in fits and starts, wander a little, swallow the beads in their way and leave a wet trail with a few beads behind it, which dries over a few seconds. Each drop catches the light in a bright point near its top, glows faintly along its lower edge and darkens at its rim, like a small lens. In rain motion new drops land all the time. In thaw motion the drops appear behind a front that spreads outwards from a point, as if the glass were melting there, and then run down. Nothing behind the drops is read, so the page stays real and clicks go through.',
  target:
    'any element, such as a hero or a banner, or <body> for the whole viewport; it is never hidden',
  params: {
    motion: {
      description:
        'rain: drops land all over the area at rate a second; thaw: count drops appear behind a front that spreads from x, y over duration, like meltwater.',
    },
    trigger: {
      description:
        'view: the first time the element is on screen a thaw plays, or rain lands count drops at once and keeps falling while it is on screen; manual: each increase of fire plays a thaw, or a shower of count drops.',
    },
    fire: {
      description: 'With trigger manual, every increase plays once more.',
      range: [0, 100],
      step: 1,
    },
    rate: {
      description: 'Rain: new drops a second over the area; 0 lets the drops on the glass dry.',
      range: [0, 40],
    },
    count: {
      description:
        'Drops a thaw leaves behind its front, or rain lands at once when it starts and on each fire.',
      range: [0, 400],
      step: 1,
    },
    scale: { description: 'Size of the drops over their base size.', range: [0.4, 3] },
    speed: {
      description: 'How fast heavy drops run down; 0 keeps every drop where it landed.',
      range: [0, 3],
    },
    trail: {
      description: 'Strength of the wet trail a running drop leaves; 0 leaves none.',
      range: [0, 1],
    },
    dry: {
      description: 'Seconds a trail takes to dry; beads at rest last about half as long.',
      range: [0.5, 20],
      unit: 's',
    },
    lifetime: {
      description:
        'Seconds a drop lasts at most, running or at rest, fading out over the last third of them; 0 lets drops dry or run off on their own.',
      range: [0, 30],
      unit: 's',
    },
    merge: { description: 'Drops that touch run together into one bigger drop.' },
    x: {
      description: 'Thaw: where it starts, from the left edge of the area.',
      range: [0, 1],
    },
    y: { description: 'Thaw: where it starts, from the top edge of the area.', range: [0, 1] },
    duration: {
      description:
        'Thaw: seconds the front takes to cross the area. The same as frost’s duration, the drops follow its thaw.',
      range: [0.3, 10],
      unit: 's',
    },
    color: { description: 'Color of the light the drops catch along their lower edge.' },
    seed: { description: 'Where the drops land and how they run.', range: [1, 100], step: 1 },
  },
  frames:
    'Every frame while drops run or a thaw spreads, 15 a second while only beads and trails dry, none once the glass is dry. Rain draws as long as it falls.',
  touch: 'Nothing to touch: drops ignore the pointer, and scrolling works as usual.',
  reducedMotion: 'Off: neither the module nor the engine loads for it, and the page is unchanged.',
  presence: 'Fades with the page as it leaves.',
  quality: { low: 'At most 240 drops, 70 for a thaw, 2 a second of rain, 30 frames a second.' },
  cost: {
    gpu: 'Two instanced draws of small quads, drops and trail pieces; nothing full screen.',
    memory: 'Instance buffers for 480 drops and 1600 trail pieces, about 54 KB.',
  },
  examples: [
    {
      title: 'Rain on the window over a hero',
      html: '<header class="hero" data-dio="drops" data-dio-rate="6"><h1>Autumn in the city</h1></header>',
    },
    {
      title: 'Meltwater after a frozen page thaws from the button that was pressed',
      html: '<div class="window" data-dio="frost drops" data-dio-drops-motion="thaw" data-dio-drops-trigger="manual" style="position: fixed; inset: 0; pointer-events: none"></div>',
      ts: "const pane = document.querySelector('.window')\npane.dataset.dioFrostCover = '0'\npane.dataset.dioDropsFire = '1'",
    },
    {
      title: 'Condensation on a cold drink, beads only',
      html: '<figure class="drink" data-dio="drops" data-dio-rate="0" data-dio-count="160" data-dio-speed="0"><img src="/menu/lemonade.avif" alt="Iced lemonade in a tall glass"></figure>',
    },
  ],
}

export default doc
