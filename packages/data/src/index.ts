// The light entry. No three at runtime, the effect comes through import().
import { color, type EffectEntries } from '@dioramajs/effects'

/** Map and data effects as lazy entries, to spread into `effects({ effects })`. */
export const data: EffectEntries = {
  // The live params, readable and tweenable before the module loads.
  chart: {
    load: () => import('./chart'),
    params: { duration: 1, stagger: 0.06, grid: true, labels: true },
  },
  graph: {
    load: () => import('./graph'),
    params: {
      radius: 6,
      thickness: 1.25,
      labels: true,
      arrows: false,
      dim: 0.75,
      duration: 0.6,
      stagger: 0.12,
    },
  },
  heatmap: {
    load: () => import('./heatmap'),
    params: {
      steps: 5,
      gap: 2,
      radius: 2,
      labels: true,
      legend: true,
      dim: 0.35,
      duration: 0.5,
      stagger: 0.02,
    },
  },
  map: {
    load: () => import('./map'),
    params: {
      center: 0,
      zoom: 1,
      color: color('#8792a8'),
      sea: 0,
      land: color('#8792a8'),
      marker: color('#ff5a36'),
      arc: color('#ff5a36'),
      markerSize: 8,
    },
  },
}

declare module '@dioramajs/effects' {
  interface EffectTypes {
    chart: typeof import('./chart').default
    graph: typeof import('./graph').default
    heatmap: typeof import('./heatmap').default
    map: typeof import('./map').default
  }
}
