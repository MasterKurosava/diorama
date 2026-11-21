// The effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunk never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import book from './book'
import bookDoc from './book.doc'
import box from './box'
import boxDoc from './box.doc'
import coin from './coin'
import coinDoc from './coin.doc'
import device from './device'
import deviceDoc from './device.doc'
import explode from './explode'
import explodeDoc from './explode.doc'
import hotspots from './hotspots'
import hotspotsDoc from './hotspots.doc'
import label from './label'
import labelDoc from './label.doc'
import model from './model'
import modelDoc from './model.doc'
import vinyl from './vinyl'
import vinylDoc from './vinyl.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'model', effect: model, doc: modelDoc },
  { name: 'device', effect: device, doc: deviceDoc },
  { name: 'book', effect: book, doc: bookDoc },
  { name: 'box', effect: box, doc: boxDoc },
  { name: 'explode', effect: explode, doc: explodeDoc },
  { name: 'hotspots', effect: hotspots, doc: hotspotsDoc },
  { name: 'coin', effect: coin, doc: coinDoc },
  { name: 'vinyl', effect: vinyl, doc: vinylDoc },
  { name: 'label', effect: label, doc: labelDoc },
]
