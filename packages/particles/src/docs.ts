// Every effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunks never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import confetti from './confetti'
import confettiDoc from './confetti.doc'
import drops from './drops'
import dropsDoc from './drops.doc'
import emoji from './emoji'
import emojiDoc from './emoji.doc'
import snow from './snow'
import snowDoc from './snow.doc'
import sparkles from './sparkles'
import sparklesDoc from './sparkles.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'confetti', effect: confetti, doc: confettiDoc },
  { name: 'sparkles', effect: sparkles, doc: sparklesDoc },
  { name: 'snow', effect: snow, doc: snowDoc },
  { name: 'emoji', effect: emoji, doc: emojiDoc },
  { name: 'drops', effect: drops, doc: dropsDoc },
]
