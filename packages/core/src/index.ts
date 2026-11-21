import { createKernelApp } from './kernel/app'
import type {
  AnyPlugin,
  App,
  AppOptions,
  PluginEntry,
  PresetEntry,
  PresetPlugins,
  ServicesOf,
} from './kernel/types'
import { anchors } from './web/anchors'
import { pointer } from './web/pointer'
import { scroll } from './web/scroll'
import { stage } from './web/stage'
import { visibility } from './web/visibility'

export { manualDriver, offlineDriver, rafDriver, tickerDriver } from './kernel/drivers'
export { DioramaError, isDioramaError } from './kernel/errors'
export { cancel, isCancel } from './kernel/hooks'
export { definePlugin, definePreset } from './kernel/plugin'
export { satisfies } from './kernel/semver'
export { batch, computed, effect, signal, untracked } from './kernel/signals'
export * from './kernel/types'
export { VERSION } from './version'
export { type Anchor, type AnchorsApi, anchors, type TrackOptions } from './web/anchors'
export { type PointerApi, type PointerState, pointer } from './web/pointer'
export {
  type ScrollApi,
  type ScrollAxis,
  type ScrollSample,
  type ScrollSource,
  type ScrollState,
  scroll,
} from './web/scroll'
export { type StageApi, type StageOptions, stage } from './web/stage'
export { type VisibilityApi, type VisibilityOptions, visibility } from './web/visibility'

/** Built-in web layer, in start order. Disable one with `disable`, or all with `defaults: false`. */
const WEB_DEFAULTS = [
  visibility,
  stage,
  scroll,
  pointer,
  anchors,
] as unknown as readonly AnyPlugin[]

/**
 * Creates an app with the built-in web layer and the given presets and plugins. Call `start()` to
 * run it.
 */
export function createApp<
  const P extends readonly PresetEntry[] = [],
  const E extends readonly PluginEntry[] = [],
>(
  options?: AppOptions<P, E>,
): App<ServicesOf<PresetPlugins<P[number]> | Extract<E[number], AnyPlugin>>> {
  return createKernelApp(options as AppOptions | undefined, WEB_DEFAULTS) as App<
    ServicesOf<PresetPlugins<P[number]> | Extract<E[number], AnyPlugin>>
  >
}
