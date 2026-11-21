// Every effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunks never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import beat from './beat'
import beatDoc from './beat.doc'
import visualizer from './visualizer'
import visualizerDoc from './visualizer.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'beat', effect: beat, doc: beatDoc },
  { name: 'visualizer', effect: visualizer, doc: visualizerDoc },
]
