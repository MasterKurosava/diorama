import type { EffectDoc } from '@dioramajs/effects'
import type chart from './chart'

const doc: EffectDoc<typeof chart> = {
  category: 'data',
  tags: ['scroll'],
  summary:
    'A plain HTML table or definition list drawn as an animated chart that grows in on scroll.',
  looks:
    'The numbers of the table become bars, columns, a line or an area in the table box, with quiet gridlines, category labels and value ticks in the text color of the table. When a third of the chart is in view the marks grow from the baseline one after another. The pointer over a category dims the others and shows a tooltip with the values as written in the cells.',
  target:
    'a `<table>` (first column labels, a header row naming each value column) or a `<dl>` of `<dt>` labels and `<dd>` values, sized with CSS',
  params: {
    style: {
      description:
        'Kind of chart: bar draws horizontal bars, for long labels and rankings; column draws vertical bars, for a few periods; line draws a line per column, for trends over time; area fills under each line, for volumes over time.',
    },
    colors: {
      description:
        'Series colors in column order, separated by spaces; empty uses a colorblind-safe set.',
    },
    duration: {
      description: 'Time one mark takes to grow in.',
      range: [0, 3],
      step: 0.05,
      unit: 's',
    },
    stagger: {
      description: 'Delay between neighboring marks as they grow in; 0 grows them all at once.',
      range: [0, 0.3],
      step: 0.01,
      unit: 's',
    },
    grid: { description: 'Draws faint gridlines at the value ticks behind the marks.' },
    labels: {
      description: 'Draws category labels, value ticks and bar values; off leaves bare marks.',
    },
    max: {
      description:
        'Top of the value axis, for charts compared on one scale; auto picks a round value above the largest one.',
      range: [1, 1000000],
      step: 1,
    },
  },
  frames:
    'Only while the marks grow in and for a few frames as a hovered category fades in or out; none at rest.',
  touch: 'A tap on a category shows its tooltip, a tap elsewhere hides it. Nothing else changes.',
  reducedMotion:
    'The chart stands complete from the first frame; hover and the tooltip still work.',
  presence: 'Fades with the page.',
  quality: {},
  cost: {
    gpu: 'Two to four draw calls: the labels texture, all bars as one instanced call, or the lines, areas and hover dots.',
    memory:
      'One canvas texture the size of the box at up to 2x pixel ratio, plus a few bytes per value.',
  },
  examples: [
    {
      title: 'Revenue by quarter as columns',
      html: '<table class="chart" data-dio="chart" data-dio-style="column"><caption>Revenue, 2026</caption><thead><tr><th>Quarter</th><th>Revenue</th></tr></thead><tbody><tr><th>Q1</th><td>$1.2M</td></tr><tr><th>Q2</th><td>$1.6M</td></tr><tr><th>Q3</th><td>$2.1M</td></tr><tr><th>Q4</th><td>$2.4M</td></tr></tbody></table>',
    },
    {
      title: 'A ranking from a definition list',
      html: '<dl class="chart" data-dio="chart"><dt>Programs</dt><dd>78%</dd><dt>Fundraising</dt><dd>14%</dd><dt>Administration</dt><dd>8%</dd></dl>',
    },
    {
      title: 'Two series as lines with custom colors',
      html: '<table class="chart" data-dio="chart" data-dio-style="line" data-dio-colors="#2563eb #f59e0b"><thead><tr><th>Month</th><th>Signups</th><th>Churn</th></tr></thead><tbody><tr><th>Jan</th><td>1,240</td><td>310</td></tr><tr><th>Feb</th><td>1,580</td><td>290</td></tr><tr><th>Mar</th><td>2,030</td><td>275</td></tr></tbody></table>',
    },
  ],
  children: [
    {
      attribute: 'data-dio-value',
      description: 'Exact value of a cell whose text is not a plain number, such as "about half".',
    },
  ],
  parts: [
    {
      name: 'tooltip',
      description: 'The tooltip with the hovered category and its values as written in the cells.',
    },
  ],
}

export default doc
