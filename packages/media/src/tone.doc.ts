import type { EffectDoc } from '@dioramajs/effects'
import type tone from './tone'

const doc: EffectDoc<typeof tone> = {
  category: 'photo',
  summary: 'Photos in brand colors: a duotone or a halftone, with color back on hover.',
  looks:
    'In duotone the lightness of each pixel picks a color on the line from the darker to the lighter of color and background in OKLab; the defaults give monochrome. In halftone dots of color sit on background in a grid of cell px at angle, sized so each cell keeps the light of the photo: a color lighter than background gives light dots on a dark ground that grow in the highlights. With reveal the photo fades back to color on hover, or shows color in a spot at the pointer.',
  target: 'img, video',
  params: {
    style: {
      description: 'duotone maps lightness to two colors; halftone draws dots sized by tone.',
    },
    color: {
      description:
        'Ink: the halftone dots. Lighter than background gives light dots on a dark ground.',
    },
    background: {
      description:
        'Paper behind the dots. In duotone the darker of color and background takes the shadows.',
    },
    strength: { description: '0 shows the original photo, 1 the full tone.', range: [0, 1] },
    contrast: { description: 'Contrast of lightness before toning.', range: [0, 2] },
    cell: { description: 'Step of the halftone grid in CSS px.', range: [2, 32], unit: 'px' },
    angle: { description: 'Angle of the halftone grid.', range: [0, 90], unit: 'deg' },
    reveal: {
      description:
        'none keeps the tone; fade brings color back on hover; spot shows color in a circle at the pointer; view brings it back while the image is in the middle half of the viewport, which works on touch screens too.',
    },
    radius: { description: 'Radius of the spot.', range: [20, 400], unit: 'px' },
    duration: { description: 'Length of the fade to color and back.', range: [0, 2], unit: 's' },
  },
  frames:
    'Only while the color fades or the spot moves; none at rest. view decides in the frames the scroll draws anyway.',
  touch: 'The tone stays: fade and spot need a hovering pointer. view works on touch.',
  reducedMotion: 'fade takes 0.15 s, and spot acts as fade.',
  presence: 'Fades with the page transition; a flight carries the toned copy.',
  quality: {},
  cost: {
    gpu: 'One texture read and OKLab conversions per pixel.',
    memory: 'The image only.',
  },
  examples: [
    {
      title: 'A team portrait in brand colors',
      html: '<img src="/team/ana.avif" alt="Ana Ruiz, head of housekeeping" data-dio="tone" data-dio-color="#1d2a3a" data-dio-background="#f4e3c3" data-dio-reveal="fade" />',
    },
    {
      title: 'Light dots on a dark site',
      html: '<img src="/stages/night.avif" alt="The main stage at night" data-dio="tone" data-dio-style="halftone" data-dio-color="#7fd3ff" data-dio-background="#081634" />',
    },
    {
      title: 'A team grid whose photos turn to color as they scroll through the middle',
      html: '<img src="/team/leo.avif" alt="Leo Marsh, chef" data-dio="tone" data-dio-reveal="view" />',
    },
    {
      title: 'A CSS fallback for pages without WebGL',
      html: '<style>img[data-dio~="tone"] { filter: grayscale(1) }</style>',
    },
  ],
}

export default doc
