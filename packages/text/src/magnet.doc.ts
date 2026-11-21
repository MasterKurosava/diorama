import type { EffectDoc } from '@dioramajs/effects'
import type magnet from './magnet'

const doc: EffectDoc<typeof magnet> = {
  category: 'text',
  tags: ['3d', 'block'],
  summary:
    'Letters become lit 3D slabs that react to the pointer: they push away, turn toward it, rise like a dock or tumble, and spring back.',
  looks:
    'As the pointer comes near a heading or a link, the letters around it lift off the page as thin glossy slabs. By default they are pushed away and turn their faces from the pointer, the rest of the line making room so no letter runs over its neighbor, and their sides and beveled edges catch the light and each casts its own soft shadow on the page. Other styles turn the letters to face the pointer, raise the ones under it toward the viewer while their neighbors make room, like the macOS dock seen in perspective, or toss them apart, each spinning its own way. Every letter rides a spring, so when the pointer moves on they wobble back into place and the element is the real text again.',
  target:
    'a heading, a link, a button label or a short line of text. Not img, video, canvas, svg or form fields',
  params: {
    style: {
      description:
        'repel pushes letters off and turns their faces away from the pointer; attract turns them to face it and draws them in; lift raises the letters under it toward the viewer while neighbors make room; scatter tosses them up and apart, each spinning its own way.',
    },
    radius: {
      description: 'Reach of the pointer in em of the text, so a link and a headline feel alike.',
      range: [0.5, 8],
      unit: 'em',
    },
    strength: {
      description: 'How far letters move, rise and turn; 0 leaves them in place.',
      range: [0, 3],
    },
    rotate: {
      description: 'Largest turn of a letter in 3D at the pointer; 0 keeps faces to the viewer.',
      range: [0, 80],
      unit: 'deg',
    },
    stiffness: {
      description: 'Pull of each letter toward where it goes; higher is snappier.',
      range: [20, 600],
    },
    damping: {
      description: 'Friction of the springs; lower wobbles longer, about 26 does not wobble.',
      range: [2, 60],
    },
  },
  frames: 'Only while letters move toward the pointer or spring back; none at rest.',
  touch:
    'A finger pressed on the text moves the letters around it until it lifts or the page starts to scroll.',
  reducedMotion: 'Off: the text stays as it is, and the engine does not load for it.',
  presence: 'Fades with the page.',
  quality: {
    low: 'The letters are rastered at 1 device pixel per CSS pixel instead of 2.',
  },
  cost: {
    gpu: 'Two instanced draws: five quads per letter for its face and sides, one for its shadow, two texture reads per pixel.',
    memory:
      'An atlas of the letters at twice their CSS size with room for the shadows, and a relief map of the same size, kept while the element lives.',
  },
  examples: [
    {
      title: 'A headline that pushes letters away',
      html: '<h1 data-dio="magnet">Make some noise</h1>',
    },
    {
      title: 'A word mark that magnifies like a dock',
      html: '<p class="mark" data-dio="magnet" data-dio-style="lift">studio</p>',
    },
    {
      title: 'Navigation links whose letters turn to the pointer',
      html: '<nav><a href="/menu" data-dio="magnet" data-dio-style="attract">Menu</a> <a href="/visit" data-dio="magnet" data-dio-style="attract">Visit</a></nav>',
    },
    {
      title: 'Loose, wobbly letters for a party poster',
      html: '<h2 data-dio="magnet" data-dio-style="scatter" data-dio-damping="6">Party starts at nine</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Hello there</h2>',
      ts: "app.attach('.title', 'magnet', { radius: 4, stiffness: 120 })",
    },
  ],
}

export default doc
