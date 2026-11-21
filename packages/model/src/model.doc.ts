import type { EffectDoc } from '@dioramajs/effects'
import type model from './model'

const doc: EffectDoc<typeof model> = {
  category: '3d',
  summary: 'A glTF model fitted into the element, lit, turnable and recolored from markup.',
  looks:
    'The model from `src` sits centered in the box, lit by a soft studio environment and tone mapped like a product shot, facing the viewer or resting in a three-quarter view seen slightly from above. From that pose it can turn on its own, follow scroll, lean toward the pointer and spin under a drag with a little inertia, staying where the visitor leaves it. A part of it takes the color picked in a group of swatches, blending smoothly to the new one.',
  target:
    'any element; put a poster <img> inside, it shows without WebGL and until the model is ready',
  params: {
    src: { description: 'URL of the GLB or glTF file.' },
    part: {
      description:
        "Material or mesh names to recolor, comma separated; empty keeps the file's colors.",
    },
    color: { description: 'Color of the part, any CSS color.' },
    swatches: {
      description:
        'Selector of a radio group or <select> whose pick recolors the part, as `color` does.',
    },
    duration: {
      description: 'Time a color or rest pose change takes.',
      range: [0, 2],
      unit: 's',
    },
    scale: {
      description:
        'Size in the box: 1 fits the model as it is seen in its rest pose, its near side larger in perspective, centered on what is drawn.',
      range: [0.1, 1.5],
    },
    yaw: {
      description:
        'Rest pose turn around the vertical axis; positive turns it as a drag to the right does.',
      range: [-180, 180],
      unit: 'deg',
    },
    pitch: {
      description: 'Rest pose tilt toward the viewer; positive shows it from above, -20 to 20.',
      range: [-20, 20],
      unit: 'deg',
    },
    spin: {
      description: 'Turns on its own around the vertical; 0 stands still.',
      range: [-360, 360],
      unit: 'deg/s',
    },
    turn: {
      description: 'Turns as the element passes through the viewport.',
      range: [-720, 720],
      unit: 'deg',
    },
    tilt: { description: 'How far it leans toward the pointer.', range: [0, 35], unit: 'deg' },
    drag: { description: 'Turns it under a drag, and with the arrow keys when it has a tabindex.' },
    clip: {
      description:
        'Clip to loop by name, `*` for the first; step keys alone draw only at each key.',
    },
    exposure: { description: 'Exposure of the tone mapping.', range: [0.2, 3] },
  },
  frames:
    'Only while something moves: spin, a clip, drag inertia, the tilt settling, or a color or rest pose blending. A clip whose every track steps from key to key, like the hands of a ticking watch, draws one frame per key on a timer while visible, so a watch at rest costs a frame a second. None at rest without spin and clip.',
  touch:
    'No tilt, nothing hovers. A finger drags the model only when the element has `touch-action: pan-y` or `none`, otherwise the gesture scrolls the page.',
  reducedMotion:
    'The rest pose shows; spin, clips, scroll turn and tilt stop, and a new rest pose is taken at once. Dragging, arrow keys and color changes still work: the visitor starts them.',
  presence:
    'Leaves by dithering its pixels away while shrinking to 96%, so its opaque materials never switch to transparent mid-transition.',
  quality: {},
  cost: {
    gpu: 'The model as authored, lit by one prefiltered environment. One own material per material of the file.',
    memory:
      'Geometry and textures of the file, shared with every instance of the same URL, and the environment map.',
  },
  examples: [
    {
      title: 'Product with a poster',
      html: '<div class="viewer" data-dio="model" data-dio-src="/models/chair.glb"><img src="/models/chair.avif" alt="Lounge chair" /></div>',
    },
    {
      title: 'Colour from swatches',
      html: '<div class="viewer" data-dio="model" data-dio-src="/models/chair.glb" data-dio-part="Fabric" data-dio-swatches="#fabric" style="touch-action: pan-y"><img src="/models/chair.avif" alt="Lounge chair" /></div><fieldset id="fabric"><label><input type="radio" name="fabric" value="#b4532a" checked="" /> Terracotta</label><label><input type="radio" name="fabric" value="oklch(35% 0.05 260)" /> Ink</label></fieldset>',
    },
    {
      title: 'Three-quarter view from above',
      html: '<div class="viewer" data-dio="model" data-dio-src="/models/chair.glb" data-dio-yaw="35" data-dio-pitch="12"><img src="/models/chair.avif" alt="Lounge chair" /></div>',
    },
    {
      title: 'Hero that turns on its own',
      html: '<div data-dio="model" data-dio-src="/models/headphones.glb" data-dio-spin="18" data-dio-load="eager"><img src="/img/headphones.avif" alt="Headphones" /></div>',
    },
    {
      title: 'Watch with ticking hands',
      html: '<div class="viewer" data-dio="model" data-dio-src="/models/watch.glb" data-dio-clip="Tick"><img src="/models/watch.avif" alt="Pocket watch" /></div>',
    },
    {
      title: 'From code',
      html: '<div class="stage"></div>',
      ts: "app.attach('.stage', 'model', { src: '/models/robot.glb', clip: 'Walk', drag: false })",
    },
  ],
}

export default doc
