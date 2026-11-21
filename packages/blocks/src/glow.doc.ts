import type { EffectDoc } from '@dioramajs/effects'
import type glow from './glow'

const doc: EffectDoc<typeof glow> = {
  category: 'block',
  summary:
    'A spotlight that follows the pointer over a grid of cards and lights up their borders, as on SaaS and developer tool sites.',
  looks:
    'A soft round light of radius follows the pointer with ease. Where it is near a card, the card’s border lights up in color along its rounded shape with a faint halo, and in the fill and both modes its surface glows too. The light crosses the gaps, so the neighboring cards catch its edge. It fades in as the pointer comes over the grid and out as it leaves. The cards stay as they are, the light draws over them.',
  target:
    'a grid of cards with data-dio-cards naming the cards, or a single card; the cards can hold anything',
  params: {
    mode: {
      description:
        'border lights the outlines only, for cards with a hairline border; fill lights the surfaces only, for borderless tiles; both does both, the classic spotlight card.',
    },
    cards: {
      description: 'Selector of the cards inside, like .card; empty makes the element the card.',
    },
    color: { description: 'Color of the light, any CSS color.' },
    radius: {
      description: 'Radius of the light around the pointer.',
      range: [40, 1000],
      unit: 'px',
    },
    border: {
      description: 'Width of the lit border ring; 0 turns the ring off.',
      range: [0, 6],
      step: 0.5,
      unit: 'px',
    },
    fill: {
      description: 'Strength of the surface glow in the fill and both modes; 0 turns it off.',
      range: [0, 0.6],
      step: 0.01,
    },
    ease: {
      description: 'Time the light takes to catch up with the pointer; 0 sticks to it.',
      range: [0, 1],
      step: 0.01,
      unit: 's',
    },
  },
  frames: 'Only while the pointer moves near the cards and while the light fades; none at rest.',
  touch: 'Off: phones and tablets have no pointer to follow, and the cards stay as they are.',
  reducedMotion:
    'Static: the light still sits under the pointer, but jumps with it and appears and goes at once, without trailing or fading.',
  presence: 'The light fades with the page as it leaves.',
  quality: {},
  cost: {
    gpu: 'One instanced draw for up to 64 cards, only while the light is on.',
    memory: 'Two vec4 attributes per card, under 3 KB.',
  },
  examples: [
    {
      title: 'A feature grid: the light lights up the borders of the cards near it',
      html: '<div class="features" data-dio="glow" data-dio-cards=".card"><article class="card"><h3>Edge functions</h3><p>Run code next to your users.</p></article><article class="card"><h3>Preview deploys</h3><p>Every branch gets its own URL.</p></article><article class="card"><h3>Analytics</h3><p>Real traffic, no cookies.</p></article></div>',
    },
    {
      title: 'Borderless tiles that glow under the pointer',
      html: '<ul class="integrations" data-dio="glow" data-dio-cards="li" data-dio-mode="fill" data-dio-fill="0.18"><li>GitHub</li><li>Slack</li><li>Linear</li><li>Figma</li></ul>',
    },
    {
      title: 'One pricing card in the brand color, border and surface',
      html: '<section class="plan" data-dio="glow" data-dio-mode="both" data-dio-color="#7c5cff" data-dio-radius="240"><h3>Pro</h3><p>$24 per month</p></section>',
    },
  ],
}
export default doc
