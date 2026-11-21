// Every effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunks never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import beam from './beam'
import beamDoc from './beam.doc'
import glow from './glow'
import glowDoc from './glow.doc'
import shine from './shine'
import shineDoc from './shine.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'beam', effect: beam, doc: beamDoc },
  { name: 'glow', effect: glow, doc: glowDoc },
  { name: 'shine', effect: shine, doc: shineDoc },
]
