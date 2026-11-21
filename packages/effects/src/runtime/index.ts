// Entry of the engine chunk, which brings three. The light part reaches it only through import().
import type { EffectsView, Runtime, RuntimeHost } from '../ports'
import { World } from './world'

export { render } from '@dioramajs/render'
export { image } from './queries'

/** Starts the runtime of one app. The light part calls it once the engine has loaded. */
export function start(view: EffectsView, host: RuntimeHost): Runtime {
  return new World(view, host)
}
