// Every effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunks never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import blobs from './blobs'
import blobsDoc from './blobs.doc'
import clouds from './clouds'
import cloudsDoc from './clouds.doc'
import dots from './dots'
import dotsDoc from './dots.doc'
import gradient from './gradient'
import gradientDoc from './gradient.doc'
import grid from './grid'
import gridDoc from './grid.doc'
import stars from './stars'
import starsDoc from './stars.doc'
import waves from './waves'
import wavesDoc from './waves.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'gradient', effect: gradient, doc: gradientDoc },
  { name: 'dots', effect: dots, doc: dotsDoc },
  { name: 'waves', effect: waves, doc: wavesDoc },
  { name: 'stars', effect: stars, doc: starsDoc },
  { name: 'blobs', effect: blobs, doc: blobsDoc },
  { name: 'clouds', effect: clouds, doc: cloudsDoc },
  { name: 'grid', effect: grid, doc: gridDoc },
]
