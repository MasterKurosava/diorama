import type { EffectDoc } from '@dioramajs/effects'
import type graph from './graph'

const doc: EffectDoc<typeof graph> = {
  category: 'data',
  tags: ['scroll'],
  summary:
    'A list or a table of links drawn as a network graph: partners, integrations, teams, knowledge maps.',
  looks:
    'Every item becomes a round node in its group color, bigger the more links it has (or the bigger its value), with thin links in the text color between them and the names beside the nodes. The layout is worked out once from a seed, so the picture is the same on every visit. When a third of the graph is in view the nodes come in from the first item outward. The pointer or keyboard focus on a node rings it, keeps its neighbors and their links and dims the rest, and a tooltip names it and what it links to.',
  target:
    'a `<ul>` or `<ol>` whose items are the nodes (nested lists link an item to the one it sits in, `data-dio-to` links any two), or a `<table>` whose rows link the names in their first two cells, sized with CSS',
  params: {
    mode: {
      description:
        'Layout: force spreads linked nodes as a network, for ecosystems and knowledge maps; radial puts the first item in the middle and the rest in rings around it, for partners around a product; tree hangs the list top down by its nesting, for team structure and sitemaps; circle sets the nodes on a ring grouped by color with links bowed through the middle, for who works with whom.',
    },
    motion: {
      description:
        'Entrance: grow pops the nodes up and draws each link from its start; spread flies the nodes out of the first item; fade fades everything in place.',
    },
    colors: {
      description:
        'Group colors in the order groups first appear, separated by spaces; empty uses a colorblind-safe set.',
    },
    seed: {
      description:
        'Seed of the force layout: another number gives another arrangement of the same graph.',
      range: [1, 1000],
      step: 1,
    },
    radius: {
      description:
        'Radius of an average node; nodes with more links or a bigger value grow to 1.6 times it.',
      range: [2, 24],
      step: 0.5,
      unit: 'px',
    },
    thickness: { description: 'Width of a link.', range: [0.5, 6], step: 0.25, unit: 'px' },
    labels: {
      description: 'Draws the names beside the nodes, leaving out the ones that would overlap.',
    },
    arrows: { description: 'Draws an arrowhead where a link ends, for a graph with direction.' },
    dim: {
      description:
        'How much a lit node dims the nodes it does not link to; 0 keeps them as they are.',
      range: [0, 1],
      step: 0.05,
    },
    duration: {
      description: 'Time one node takes to come in; 0 shows the graph at once.',
      range: [0, 3],
      step: 0.05,
      unit: 's',
    },
    stagger: {
      description:
        'Delay between one step away from the first item and the next; 0 brings every node in at once.',
      range: [0, 0.5],
      step: 0.01,
      unit: 's',
    },
  },
  frames:
    'Only while the nodes come in and for a few frames as a lit node fades in or out; none at rest.',
  touch:
    'A tap on a node lights it and shows its tooltip, a second tap follows its link, a tap elsewhere clears it.',
  reducedMotion:
    'The graph stands complete from the first frame; hover, focus and the tooltip still work.',
  presence: 'Fades with the page.',
  quality: {},
  cost: {
    gpu: 'Four draw calls: all links, all arrowheads, all nodes as one instanced call, and the labels texture.',
    memory:
      'One canvas texture the size of the box at up to 2x pixel ratio, plus about 100 bytes per node and link. The layout runs once on the CPU: about 30 ms for 200 nodes.',
  },
  examples: [
    {
      title: 'Integrations around a product, grouped by kind',
      html: '<ul class="graph" data-dio="graph" data-dio-mode="radial"><li>Acme Cloud<ul data-dio-group="Payments"><li><a href="/integrations/stripe">Stripe</a></li><li><a href="/integrations/paypal">PayPal</a></li></ul><ul data-dio-group="Chat"><li><a href="/integrations/slack">Slack</a></li><li><a href="/integrations/teams">Teams</a></li></ul></li></ul>',
    },
    {
      title: 'A team structure from the nested list it already is',
      html: '<ul class="org" data-dio="graph" data-dio-mode="tree" data-dio-motion="fade"><li>CEO<ul><li>CTO<ul><li>Platform</li><li>Product</li></ul></li><li>COO<ul><li>Sales</li><li>Support</li></ul></li></ul></li></ul>',
    },
    {
      title: 'A knowledge map: topics linked by id',
      html: '<ul class="map" data-dio="graph"><li id="light">Light</li><li id="optics" data-dio-to="light lens">Optics</li><li id="lens">Lenses</li><li data-dio-to="lens light">Cameras</li></ul>',
    },
    {
      title: 'A table of links with weights, as arrows',
      html: '<table class="flows" data-dio="graph" data-dio-arrows=""><thead><tr><th>From</th><th>To</th><th>Orders</th></tr></thead><tbody><tr><td>Warehouse</td><td>Berlin</td><td>420</td></tr><tr><td>Warehouse</td><td>Paris</td><td>310</td></tr><tr><td>Berlin</td><td>Prague</td><td>90</td></tr></tbody></table>',
    },
  ],
  children: [
    {
      attribute: 'data-dio-to',
      description: 'On a list item: ids or names of the items it links to, separated by spaces.',
    },
    {
      attribute: 'data-dio-group',
      description:
        'On a list item, a list or a table cell: the group that colors the node and the items inside.',
    },
    {
      attribute: 'data-dio-value',
      description: 'On a list item: a number that sizes the node instead of its count of links.',
    },
  ],
  parts: [
    {
      name: 'tooltip',
      description:
        'The tooltip with the node name, the rest of its item text and the names it links to.',
    },
  ],
}

export default doc
