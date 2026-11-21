import type { EffectDoc } from '@dioramajs/effects'
import type hotspots from './hotspots'

const doc: EffectDoc<typeof hotspots> = {
  category: '3d',
  summary: 'Feature callouts pinned to points of a model, real buttons that follow it as it turns.',
  looks:
    'Goes on a parent of a `model` element. Its children with `data-dio-at` are lifted out of the flow and follow their points on the model while it turns, is dragged or explodes; a label whose point turns to the back of the model fades out and comes back as the point turns round. Focusing a label, by Tab or a click, turns the model to face its point. The labels stay ordinary buttons or links styled by the page, so keyboard, screen readers and the page without WebGL see a plain list.',
  target:
    'a parent of the `data-dio="model"` element, holding the labels next to it: the drawn model element hides its own children. Labels get a z-index above a canvas over the page; a sticky stage around them needs one too, or the model covers them (a development note names it)',
  params: {
    model: {
      description:
        'Selector of the model element, looked up inside the element and then in the page; empty takes the first `data-dio="model"` inside.',
    },
    occlude: {
      description:
        'normal hides a point label whose point faces away from the viewer (from the center of the model, or along `data-dio-normal`), and a node label once its part is well behind the center, so exploded parts keep theirs; ray hides a label wherever the model covers its point, for rooms, hollow shapes and parts inside a shell, settling a moment after the model stops; none never hides.',
    },
    face: { description: 'Focusing a label turns the model to face its point.' },
  },
  frames:
    'None of its own: labels move in the frames the model draws, written once per frame as a transform and two custom properties. Card sizes are read once and on resize. Focusing a label draws the turn of the model.',
  touch:
    'A tap on a label is a click and turns the model to it; a press on a label never starts a drag of the model.',
  reducedMotion:
    'Labels follow the model as it stands; focusing a label turns the model at once, without easing.',
  presence: 'Labels fade with the model during a page transition.',
  quality: {},
  cost: {
    gpu: 'None: the labels are DOM.',
    memory:
      'One empty node per label. With `occlude="ray"`, a ray test against the model for two labels per frame and for all of them once it stops.',
  },
  children: [
    {
      attribute: 'data-dio-at',
      description:
        "A point in the model file's own coordinates as x y z (Alt+click on the model logs one in development), or the name of a node whose center the label follows, also while `explode` moves it.",
    },
    {
      attribute: 'data-dio-normal',
      description:
        'The direction the point faces as x y z, for the normal test; without it, the direction from the center of the model.',
    },
    {
      attribute: 'data-dio-side',
      description:
        "Set by the effect to `left` or `right`: the side of the model the label's point is on, where its card goes. With it come `--dio-reach`, px from the point to the near edge of the card, just past the model's edge and inside the element, and `--dio-shift`, px from the point to the middle of the card, so the cards on a side never overlap. The card is the label's last child element, or the label itself; place it with these in CSS.",
    },
    {
      attribute: 'data-dio-away',
      description:
        'Set by the effect on a label turned away, which also gets opacity 0; add `transition: opacity 0.2s` to fade it.',
    },
  ],
  examples: [
    {
      title: 'Feature callouts on a speaker',
      html: '<figure class="product" data-dio="hotspots"><div class="viewer" data-dio="model" data-dio-src="/models/speaker.glb" style="touch-action: pan-y"><img src="/models/speaker.avif" alt="Speaker" /></div><button type="button" class="spot" data-dio-at="Driver">50 mm driver</button><button type="button" class="spot" data-dio-at="Battery">12 h battery</button><button type="button" class="spot" data-dio-at="0 0.17 0">Volume</button></figure>',
    },
    {
      title: 'Room highlights with real occlusion',
      html: '<div class="plan" data-dio="hotspots" data-dio-occlude="ray"><div class="viewer" data-dio="model" data-dio-src="/models/flat.glb"><img src="/models/flat.avif" alt="Two-room flat" /></div><ul><li><a class="spot" href="#kitchen" data-dio-at="1.2 0.9 -0.4">Kitchen</a></li><li><a class="spot" href="#balcony" data-dio-at="-2 1 1.5">Balcony</a></li></ul></div>',
    },
    {
      title: 'Labels on an exploded view',
      html: '<div class="product" data-dio="hotspots"><div class="viewer" data-dio="model explode" data-dio-src="/models/speaker.glb" data-dio-mode="extras"><img src="/models/speaker.avif" alt="Speaker" /></div><button type="button" class="spot" data-dio-at="Board">Bluetooth 5.4</button></div>',
    },
  ],
}

export default doc
