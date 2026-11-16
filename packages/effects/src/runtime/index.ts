import type { EffectsView, Runtime, RuntimeHost } from '../instances'
import { World } from './world'

// Engine chunk. The light part reaches it only through import().
export { render } from '@diorama/render'
export { image } from './queries'

export function start(view: EffectsView, host: RuntimeHost): Runtime {
  return new World(view, host)
}
