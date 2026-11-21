import type { EffectDoc } from '@dioramajs/effects'
import type visualizer from './visualizer'

const doc: EffectDoc<typeof visualizer> = {
  category: 'audio',
  summary: 'The sound of a page player made visible: live bars, a wave, a ring or a waveform.',
  looks:
    'bars draws the spectrum on a log scale from 40 Hz to 16 kHz with a soft fall, wave the oscilloscope as a ribbon, ring the bars around a circle. peaks draws the waveform of the whole track from precomputed peaks, the played part in accent; a click or a drag seeks and hover shows the position. The <audio controls> stays the DOM: native controls, keyboard and media keys.',
  target: 'an empty decorative element next to an <audio> or <video>',
  params: {
    for: {
      description: 'Selector of the audio or video; empty takes the closest one before it.',
    },
    style: { description: 'bars, wave, ring, or peaks for a waveform of the whole track.' },
    peaks: { description: 'URL of the peaks JSON: audiowaveform v2 or an array of 0..1.' },
    bars: { description: 'Number of bars.', range: [8, 128], step: 1 },
    color: { description: 'Color of the bars, the wave and the unplayed part.' },
    accent: { description: 'Color of the played part and the position mark.' },
    gap: { description: 'Gap between bars as a share of a step.', range: [0, 0.9] },
    radius: { description: 'Corner radius of the bars.', range: [0, 16], unit: 'px' },
    range: { description: 'Analyzer range in decibels.', range: [-120, 0] },
    smooth: { description: 'Smoothing of the analyzer over time.', range: [0, 0.99] },
    mirror: { description: 'Bars grow both ways from the middle.' },
    seek: {
      description:
        'With peaks, a click, a tap or a drag seeks and hover shows the position; off, the waveform only shows progress, for a list where a click opens the episode.',
    },
    fps: { description: 'Frame cap while playing.', range: [1, 60], step: 1 },
  },
  frames: 'None while paused; at most fps while playing, then a 0.3 s fall.',
  touch: 'A tap on peaks seeks; dragging needs touch-action: pan-y.',
  reducedMotion: 'bars, wave and ring hold a calm still shape; peaks works fully.',
  presence: 'Fades with the page transition.',
  quality: { low: 'At most 20 fps and 24 bars.', medium: 'At most 30 fps.' },
  cost: {
    gpu: 'One quad drawn by a fragment shader and a 128 x 1 data texture updated per frame.',
    memory: 'A few kilobytes of analyzer data and peaks.',
  },
  examples: [
    {
      title: 'Live bars next to a player',
      html: '<audio id="live" src="/audio/live-set.mp3" controls="" preload="metadata"></audio><div class="bars" data-dio="visualizer" data-dio-for="#live" aria-hidden="true"></div>',
    },
    {
      title: 'A podcast episode; peaks from audiowaveform -i ep42.mp3 -o ep42.json -z 256 -b 8',
      html: '<li class="episode"><audio src="https://cdn.example.org/ep42.mp3" controls="" preload="none"></audio><div data-dio="visualizer" data-dio-style="peaks" data-dio-peaks="/peaks/ep42.json" aria-hidden="true" style="touch-action: pan-y"></div></li>',
    },
  ],
}

export default doc
