import type { EffectDoc } from '@dioramajs/effects'
import type label from './label'

const doc: EffectDoc<typeof label> = {
  category: '3d',
  tags: ['photo', 'scroll'],
  summary: 'A flat label wrapped around a can, a bottle or a jar that turns to show all of it.',
  looks:
    'The label image is wrapped around a 3D container standing in the box of the element: printed on an aluminium can, glued on a glass bottle with a foil cap, or around a glass jar with a lid. It keeps its proportions, so its width decides how far around the body it reaches. The container turns as the page scrolls past and under a drag, leans toward the pointer, and the light runs over the metal, the glass and the print.',
  target:
    'img: the flat label, its whole width as printed; the container stands in the box of the image, as tall as fits. Without WebGL the plain label shows',
  params: {
    style: {
      description:
        'Kind of container. can: a 330 ml drinks can, the label printed all around its body, for beer, soda and coffee; bottle: a 750 ml bottle of colored glass with a foil cap, the label on its body, for wine, spirits and oils; jar: a squat glass jar with a twist lid, for cosmetics, honey, coffee and sauces.',
    },
    color: {
      description:
        'Color of the body: the metal of a can, the glass of a bottle, what fills a jar. Empty takes the default of the style: aluminium, green glass, amber.',
    },
    cap: {
      description:
        'Color of the cap: the lid of a can, the foil of a bottle, the lid of a jar. Empty takes the default of the style.',
    },
    yaw: {
      description: 'Rest turn; 0 shows the middle of the label.',
      range: [-180, 180],
      unit: 'deg',
    },
    pitch: {
      description: 'Rest tilt; positive shows the top, as seen from a little above.',
      range: [-35, 35],
      unit: 'deg',
    },
    tilt: {
      description: 'How far it leans toward the pointer: 0 turns the lean off.',
      range: [0, 25],
      unit: 'deg',
    },
    turn: {
      description:
        'Turns while the page scrolls past: 360 is a whole turn from entering the viewport to leaving it, 180 shows the label from one end to the other. 0 turns it off.',
      range: [-720, 720],
      unit: 'deg',
    },
    spin: {
      description:
        'Idle turn while nobody touches it, pausing under the pointer and for 1.5 s after: 0 turns it off.',
      range: [-180, 180],
      unit: 'deg/s',
    },
    gloss: {
      description: 'Shine of the light on the print: 0 is matte paper.',
      range: [0, 1],
    },
    drag: {
      description:
        'Turns it under a drag and tips it a little, and with the arrow keys when it has a tabindex.',
    },
    shadow: { description: 'Density of the shadow on the page.', range: [0, 1] },
  },
  frames:
    'While the page scrolls with turn, and while it leans, coasts after a drag, eases a key step, or spin turns it; none at rest, and pointer moves elsewhere draw nothing.',
  touch:
    'Nothing leans; the scroll turns it. A finger turns it only when the element has `touch-action: pan-y` or `none`, and tips it only with `none`; otherwise the gesture scrolls the page.',
  reducedMotion:
    'It rests as posed: no lean, spin or scroll turn. Dragging and arrow keys still turn it, without coasting.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, and its shadow fades with it.',
  quality: {},
  cost: {
    gpu: 'One body of about two thousand triangles with a simple light, no environment map.',
    memory: 'The label image.',
  },
  examples: [
    {
      title: 'A can that turns as the page scrolls',
      html: '<img src="/beer/pale-ale-label.webp" alt="Harbor Pale Ale label: 5.2% ABV, brewed with Citra hops" width="1240" height="560" data-dio="label" style="width: 240px; height: 360px; object-fit: contain" />',
    },
    {
      title: 'A wine bottle turned by a drag',
      html: '<img src="/wines/2024-label.webp" alt="Hillside Riesling 2024 label" width="800" height="960" data-dio="label" data-dio-style="bottle" data-dio-turn="0" tabindex="0" style="width: 200px; height: 520px; object-fit: contain; touch-action: pan-y" />',
    },
    {
      title: 'A jar of honey with a gold lid',
      html: '<img src="/shop/honey-label.webp" alt="Wildflower honey, 250 g" width="1500" height="500" data-dio="label" data-dio-style="jar" data-dio-color="#c98a1b" data-dio-cap="#b8902f" style="width: 300px; height: 300px; object-fit: contain" />',
    },
  ],
}

export default doc
