import type { EffectDoc } from '@dioramajs/effects'
import type voxel from './voxel'

const doc: EffectDoc<typeof voxel> = {
  category: 'text',
  tags: ['3d', 'celebration'],
  summary:
    'A heading built from small lit 3D cubes that tumble in, bounce into place and settle into the text.',
  looks:
    'When the heading scrolls into view, small cubes in the colors of its letters fall in from above and behind the page, each turning on its own axis, and land in a wave from left to right with a hop and a squash, lower rows first, so the letters stack up like toy blocks. Each cube is lit from the upper left with a beveled edge, and the grooves between neighbors are darker. Once a column has landed the cubes flatten into the face of the text and the real text fades in over them, so the heading ends as selectable DOM text. Toy bricks with studs or flat retro voxels can stand in for the cubes; the voxels stay as they are, and cubes under the pointer pop out toward the viewer, lean out of the bump and spring back.',
  target:
    'a large heading or a short line of display text. Not img, video, canvas, svg or form fields. Text with text-shadow, a text stroke, background-clip: text or vertical writing stays as it is',
  params: {
    style: {
      description:
        'cubes are beveled blocks that settle into the text, for most headings; bricks are toy bricks two cells wide with mortar lines and studs; pixels are flat-faced voxels with crisp edges that stay as voxels, for a retro or game look.',
    },
    trigger: {
      description:
        'view builds when the heading enters; scroll builds it toward the middle of the viewport and drops the cubes again as it leaves; hover shows voxels at once for the pointer to poke.',
    },
    cell: {
      description: 'Size of one cube on the grid over the letters; larger reads chunkier.',
      range: [3, 32],
      step: 1,
      unit: 'px',
    },
    depth: {
      description: 'Depth of a cube as a share of its width; 2 makes long blocks, 0 flat tiles.',
      range: [0, 4],
    },
    drop: {
      description: 'How far above the text the cubes start; 0 lets them pop up in place.',
      range: [0, 800],
      unit: 'px',
    },
    duration: {
      description: 'Time one cube takes to fall, land and settle.',
      range: [0.3, 3],
      unit: 's',
    },
    stagger: {
      description: 'Delay of the wave per em of text, left to right; 0 drops every column at once.',
      range: [0, 0.5],
      unit: 's',
    },
    bounce: {
      description: 'Height of the hop and the squash when a cube lands; 0 lands it dead.',
      range: [0, 2],
    },
    radius: {
      description: 'Reach of the pointer for voxels that stay; 0 turns the pop-out off.',
      range: [0, 400],
      unit: 'px',
    },
    delay: { description: 'Wait after the trigger, for a cascade.', range: [0, 2], unit: 's' },
    threshold: {
      description: 'Share of the element height in view, above the bottom tenth, before it plays.',
      range: [0, 1],
      unit: 'fraction',
    },
    studs: { description: 'Round studs on top of each brick in the bricks style.' },
    seed: {
      description: 'Picks the starts and turns of the cubes; the same seed builds the same way.',
      range: [1, 100],
      step: 1,
    },
  },
  frames:
    'Only while cubes fall and settle, while scrolling with the scroll trigger and while popped voxels spring back; none at rest.',
  touch:
    'The same as with a mouse; voxels that stay pop out under a finger while it presses on the heading.',
  reducedMotion:
    'Static: cubes and bricks show the text as it is; pixels show still voxels without the build or the pop-out.',
  presence:
    'Leaving a page, the heading turns back into cubes that bounce up and fly off behind the page; entering, they build it again.',
  quality: {
    low: 'At most 2,250 cubes (the grid widens past that), and the text rastered at 1 device pixel per CSS pixel instead of 2.',
    medium: 'At most about 5,000 cubes.',
  },
  cost: {
    gpu: 'One instanced draw of up to 9,000 lit boxes, one quad per letter for the crisp text, and for voxels that stay one quad per cube for the shadows.',
    memory:
      'A canvas of the text at twice its CSS size, and about 100 bytes per cube: under 1 MB at the high tier.',
  },
  examples: [
    { title: 'A hero heading', html: '<h1 data-dio="voxel">Build it bold</h1>' },
    {
      title: 'Toy bricks',
      html: '<h2 data-dio="voxel" data-dio-style="bricks" data-dio-cell="12">Toy box</h2>',
    },
    {
      title: 'Retro voxels that stay',
      html: '<h2 data-dio="voxel" data-dio-style="pixels" data-dio-depth="2">Level 8-bit</h2>',
    },
    {
      title: 'Blocks the pointer pokes',
      html: '<h2 data-dio="voxel" data-dio-trigger="hover" data-dio-radius="160">Poke the blocks</h2>',
    },
    {
      title: 'Tied to scroll',
      html: '<h2 data-dio="voxel" data-dio-trigger="scroll" data-dio-drop="400">Scroll to build</h2>',
    },
    {
      title: 'From code',
      html: '<h2 class="title">Grand opening</h2>',
      ts: "app.attach('.title', 'voxel', { style: 'bricks', cell: 14, bounce: 1.5 })",
    },
  ],
}

export default doc
