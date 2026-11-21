import type { EffectDoc } from '@dioramajs/effects'
import type heatmap from './heatmap'

const doc: EffectDoc<typeof heatmap> = {
  category: 'data',
  tags: ['scroll'],
  summary:
    'A table drawn as a heatmap: a matrix of rows and columns, or a calendar of days like a contributions chart.',
  looks:
    'Each value becomes a rounded tile, or a dot sized by the value, colored on an even scale: one hue from light to dark for amounts, blue and red around a gray when values fall on both sides of zero. Empty cells and zeros stay faint. Row and column labels (weekdays and months in a calendar) and a small legend are drawn in the text color. When a third of it is in view the cells sweep in from the top left corner. The pointer over a cell rings it, dims the rest except its row and column, and shows its value as written.',
  target:
    'a `<table>`: for the grid, a header row naming the columns and the first cell of each row naming the row; for the calendar, rows of a date and a value (or a `<dl>` of dates and values), sized with CSS',
  params: {
    mode: {
      description:
        'grid draws the table as a matrix, for occupancy by weekday and hour, usage by feature and plan or availability; calendar lays dated values out a column per week and a row per weekday, for activity over a year.',
    },
    style: {
      description:
        'tile fills each cell with its color, for reading patterns; dot draws a circle whose area follows the value, for sparse data where the size of a few big values matters.',
    },
    motion: {
      description:
        'Entrance: sweep grows the cells in from the top left corner; fade fades them all in at once.',
    },
    colors: {
      description:
        'Colors of the scale from the lowest value to the highest, separated by spaces; empty uses a colorblind-safe blue, or blue and red around 0.',
    },
    steps: {
      description:
        'Number of color bins the scale snaps to, as the legend shows them; 0 colors each value exactly.',
      range: [0, 9],
      step: 1,
    },
    max: {
      description:
        'Value at the top of the scale, for heatmaps compared side by side; auto takes the largest value.',
      range: [1, 1000000],
      step: 1,
    },
    gap: {
      description: 'Gap between cells; 0 lets them touch.',
      range: [0, 12],
      step: 0.5,
      unit: 'px',
    },
    radius: { description: 'Corner radius of a tile.', range: [0, 12], step: 0.5, unit: 'px' },
    labels: { description: 'Draws the row and column labels, or weekdays and months.' },
    legend: {
      description: 'Draws the color scale with its lowest and highest values under the cells.',
    },
    dim: {
      description:
        'How much the hovered cell dims the others, less in its own row and column; 0 keeps them.',
      range: [0, 1],
      step: 0.05,
    },
    duration: {
      description: 'Time one cell takes to come in; 0 shows the heatmap at once.',
      range: [0, 3],
      step: 0.05,
      unit: 's',
    },
    stagger: {
      description:
        'Delay from one diagonal of cells to the next in the sweep; 0 brings them in together.',
      range: [0, 0.1],
      step: 0.005,
      unit: 's',
    },
  },
  frames:
    'Only while the cells come in and for a few frames as a hovered cell fades in or out; none at rest.',
  touch: 'A tap on a cell shows its value, a tap elsewhere hides it. Nothing else changes.',
  reducedMotion:
    'The heatmap stands complete from the first frame; hover and the tooltip still work.',
  presence: 'Fades with the page.',
  quality: {},
  cost: {
    gpu: 'Two draw calls: all cells as one instanced call and the labels texture.',
    memory:
      'One canvas texture the size of the box at up to 2x pixel ratio, plus about 60 bytes per cell.',
  },
  examples: [
    {
      title: 'Bookings by weekday and hour',
      html: '<table class="busy" data-dio="heatmap"><caption>Bookings per hour</caption><thead><tr><th></th><th>9</th><th>12</th><th>15</th><th>18</th></tr></thead><tbody><tr><th>Mon</th><td>4</td><td>12</td><td>7</td><td>3</td></tr><tr><th>Tue</th><td>5</td><td>14</td><td>9</td><td>2</td></tr><tr><th>Sat</th><td>18</td><td>26</td><td>21</td><td>9</td></tr></tbody></table>',
    },
    {
      title: 'A year of activity as a calendar',
      html: '<table class="activity" data-dio="heatmap" data-dio-mode="calendar"><caption>Commits in 2026</caption><tbody><tr><td><time datetime="2026-01-05">Jan 5</time></td><td>3</td></tr><tr><td><time datetime="2026-01-06">Jan 6</time></td><td>7</td></tr><tr><td><time datetime="2026-01-08">Jan 8</time></td><td>1</td></tr></tbody></table>',
    },
    {
      title: 'Change against last year, as dots with exact colors',
      html: '<table class="change" data-dio="heatmap" data-dio-style="dot" data-dio-steps="0"><thead><tr><th>Region</th><th>Q1</th><th>Q2</th></tr></thead><tbody><tr><th>North</th><td>+12%</td><td>-4%</td></tr><tr><th>South</th><td>-9%</td><td>+3%</td></tr></tbody></table>',
    },
  ],
  children: [
    {
      attribute: 'data-dio-value',
      description: 'Exact value of a cell whose text is not a plain number, such as "busy".',
    },
    {
      attribute: 'data-dio-date',
      description:
        'The date of a calendar row whose cell text is not a date and holds no `<time>`.',
    },
  ],
  parts: [
    {
      name: 'tooltip',
      description: 'The tooltip with the row and column, or the date, and the value as written.',
    },
  ],
}

export default doc
