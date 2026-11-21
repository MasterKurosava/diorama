// The effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunk never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import globe from './globe'
import globeDoc from './globe.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [{ name: 'globe', effect: globe, doc: globeDoc }]
