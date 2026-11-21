import type { EffectDoc } from '@dioramajs/effects'
import type spin from './spin'

const doc: EffectDoc<typeof spin> = {
  category: '3d',
  tags: ['photo'],
  summary: 'A product turns by drag through a series of photos taken around it.',
  looks:
    'A horizontal drag picks the frame from a series shot in a circle, and with rows a vertical drag picks the viewing angle. The frame follows the pointer and stops where it is let go; with inertia a flick coasts on and eases out onto a whole frame, neighbor frames cross-fading on the way so it slows without stepping. Every step shows one whole photo, so the product stays sharp at any angle; with blend neighbor frames cross-fade by the fraction instead, for sparse sets. spin turns it until the first touch, and a hint turns it a little back and forth when it first shows.',
  target: 'img (the poster)',
  params: {
    frames: { description: 'Frame URLs as a {01..72} range or a comma list, in turning order.' },
    atlas: { description: 'Atlas page URLs as a range or a list, read cell by cell.' },
    grid: { description: 'Columns and rows of cells on an atlas page.', range: [1, 16], step: 1 },
    count: { description: 'Number of frames; auto takes all.', range: [1, 360], step: 1 },
    density: {
      description: 'Share of the frames to load; 0.5 takes every second.',
      range: [0.1, 1],
    },
    resolution: {
      description: 'Cap on the long side of a frame when decoding.',
      range: [256, 4096],
      unit: 'px',
    },
    rows: {
      description: 'Rows of viewing angles; frames run row after row.',
      range: [1, 8],
      step: 1,
    },
    frame: {
      description:
        'Current frame in its row, fractional with blend; the effect writes it as the visitor turns it.',
      range: [0, 72],
    },
    row: { description: 'Current row of viewing angles.', range: [0, 8], step: 1 },
    by: {
      description:
        'drag turns it while pressed; hover turns it as the mouse moves over it, without a press (touch still drags); manual leaves the pointer to the page: keys, frame and spin turn it, for a product that turns by itself.',
    },
    sensitivity: {
      description:
        'How far a drag across the full width of the box turns it, as a factor: 1 is one whole turn.',
      range: [0.1, 4],
    },
    spin: {
      description: 'Turning by itself until the first touch, in degrees a second; 0 for none.',
      range: [0, 360],
      unit: 'deg/s',
    },
    inertia: {
      description:
        'Coast after a flick: it goes as far as the flick carries it in this time and eases out onto a whole frame over three times as long at most. 0, the default, stops on the frame where the pointer lets go.',
      range: [0, 2],
      unit: 's',
    },
    loop: { description: 'Turns full circle; off stops at the end frames.' },
    reverse: { description: 'Reverses the order of the frames.' },
    blend: {
      description:
        'Cross-fades neighbor frames by the fraction of the turn. Off by default: 36 or more frames turn smoothly as whole photos, and a mix of two reads as ghosting. Turn it on for sparse sets, about 24 frames or fewer, where whole frames step visibly.',
    },
    hint: { description: 'Turns a twelfth back and forth when it first shows.' },
    cache: { description: 'Decoded frames kept around the current one.', range: [1, 32], step: 1 },
    fps: { description: 'Frame cap while turning by itself.', range: [1, 60], step: 1 },
  },
  frames:
    'None at rest; full rate while dragging or coasting, at most fps while turning by itself or hinting.',
  touch: 'Dragging needs touch-action: pan-y; rows need touch-action: none.',
  reducedMotion: 'No spin, inertia or hint; dragging and keys still work.',
  presence: 'Fades with the page transition; a flight shows the current frame.',
  quality: {
    low: 'Half the frames, four decoded at a time, at most 960 px.',
    medium: 'Six decoded frames at a time, at most 1280 px.',
  },
  cost: {
    gpu: 'One or two texture reads per pixel.',
    memory:
      'Compressed bytes of every frame and a window of decoded ones; an atlas keeps none decoded.',
  },
  examples: [
    {
      title: 'Frames as files',
      html: '<img src="/spin/camera/01.webp" alt="Rangefinder camera, 360° view. Drag or use the arrow keys to turn it." data-dio="spin" data-dio-frames="/spin/camera/{01..72}.webp" data-dio-load="eager" tabindex="0" style="touch-action: pan-y" />',
    },
    {
      title: 'A flick coasts on and eases out onto a frame',
      html: '<img src="/spin/camera/01.webp" alt="Rangefinder camera, 360° view. Drag or use the arrow keys to turn it." data-dio="spin" data-dio-frames="/spin/camera/{01..72}.webp" data-dio-inertia="0.35" tabindex="0" style="touch-action: pan-y" />',
    },
    {
      title: 'Turns as the mouse moves over it',
      html: '<img src="/spin/shoe/01.webp" alt="Trail shoe, 360° view" data-dio="spin" data-dio-frames="/spin/shoe/{01..36}.webp" data-dio-by="hover" tabindex="0" style="touch-action: pan-y" />',
    },
    {
      title: 'An atlas: 72 frames in two KTX2 pages of 6 × 6',
      html: '<img src="/spin/camera/01.webp" alt="Rangefinder camera, 360° view" data-dio="spin" data-dio-atlas="/spin/camera-{0..1}.ktx2" data-dio-grid="6 6" tabindex="0" style="touch-action: pan-y" />',
    },
    {
      title: 'A sparse set: 18 frames blended between steps',
      html: '<img src="/spin/vase/01.webp" alt="Glazed vase, 360° view" data-dio="spin" data-dio-frames="/spin/vase/{01..18}.webp" data-dio-blend="true" tabindex="0" style="touch-action: pan-y" />',
    },
  ],
}

export default doc
