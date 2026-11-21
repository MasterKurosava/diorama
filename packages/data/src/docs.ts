// Every effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunks never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import chart from './chart'
import chartDoc from './chart.doc'
import graph from './graph'
import graphDoc from './graph.doc'
import heatmap from './heatmap'
import heatmapDoc from './heatmap.doc'
import map from './map'
import mapDoc from './map.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'chart', effect: chart, doc: chartDoc },
  { name: 'graph', effect: graph, doc: graphDoc },
  { name: 'heatmap', effect: heatmap, doc: heatmapDoc },
  { name: 'map', effect: map, doc: mapDoc },
]
