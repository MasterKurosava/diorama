// The site entry. One call starts effects with the whole catalogue, quality tiers, transitions
// and assets.
// Effects from the folder come through `@dioramajs/diorama/generated`, which the build plugin fills in.
import { assets } from '@dioramajs/assets'
import { type App, createApp, type LogCode, type PluginEntry, stage } from '@dioramajs/core'
import { DEV, withDocs } from '@dioramajs/core/dev'
import { effects as found } from '@dioramajs/diorama/generated'
import {
  type Effect,
  type EffectEntries,
  type EffectSource,
  type EffectsOptions,
  effects,
  type When,
} from '@dioramajs/effects'
import { type GsapLike, gsapPlugin, type ScrollTriggerStatic } from '@dioramajs/gsap'
import { type LenisLike, lenisPlugin } from '@dioramajs/lenis'
import type { QualityOptions, QualityTier } from '@dioramajs/quality'
import type { RenderOptions } from '@dioramajs/render'
import { type TransitionsOptions, transitions } from '@dioramajs/transitions'
import type { CoverName, CoverOptions } from '@dioramajs/transitions/cover'
import { adopt, deferAttach, guard } from './attach'
import { catalog } from './catalog'

export { assets } from '@dioramajs/assets'
// The built-in effects add their names to EffectTypes. catalog loads them lazily, which leaves
// no trace in the declarations, so these keep the names checked in attach() for npm installs.
export type {} from '@dioramajs/audio'
export type {} from '@dioramajs/backgrounds'
export type {} from '@dioramajs/blocks'
export type { App } from '@dioramajs/core'
export { createApp, stage } from '@dioramajs/core'
export type {} from '@dioramajs/data'
export type {
  ChoiceParam,
  ColorParam,
  Effect,
  EffectContext,
  EffectEntries,
  EffectHandle,
  EffectName,
  EffectOptions,
  EffectSetup,
  EffectTypes,
  SiteEffects,
} from '@dioramajs/effects'
export { color, effects, oneOf, redefine, text } from '@dioramajs/effects'
export { defineEffect, effect } from '@dioramajs/effects/effect'
export type {} from '@dioramajs/globe'
export type {} from '@dioramajs/media'
export type {} from '@dioramajs/model'
export type {} from '@dioramajs/particles'
export type {} from '@dioramajs/text'
export { transition, transitions } from '@dioramajs/transitions'
export { ready } from './attach'

/**
 * A known effect changed without its code: `{ ripple: { when: 'all' } }`. Both fields beat the
 * definition's, and the light part reads them before the module loads.
 */
export interface EntryPatch {
  /** A media query, 'hover' for '(hover: hover)', or 'all' to run on touch devices too. */
  readonly when?: When
  /** 'off' turns the effect off under reduced motion, 'static' draws it without motion. */
  readonly reducedMotion?: 'static' | 'off'
  /** Marks the entry that replaces a built-in as intended, e.g. a shader from the effects folder. */
  readonly override?: boolean
  /** A patch keeps the effect's loader; an object with `load` is a new entry. */
  readonly load?: never
}

/** Options of `start()`. Every field is optional. */
export interface StartOptions {
  /** 'over' (default) draws above the page, 'behind' draws under a transparent page. */
  readonly canvas?: 'over' | 'behind'
  /** Clear colour: a number or any CSS colour, e.g. `'#08080b'`. Transparent by default. */
  readonly background?: number | string
  /**
   * Effects besides the folder's and the catalogue's: a new entry replaces the one of its name,
   * a patch (`{ ripple: { when: 'all' } }`) changes `when` or `reducedMotion` of a known one.
   * Replacing a built-in warns `EFFECT_OVERRIDE` in development unless the entry has
   * `override: true`.
   */
  readonly effects?: { readonly [name: string]: EffectSource | EntryPatch }
  /**
   * Page transitions by `data-dio-key`. On by default, `false` turns them off. `cover` adds a GL
   * cover the pages change behind: `{ cover: 'ink' }` or `{ cover: { name: 'curtain', color } }`.
   */
  readonly transitions?:
    | boolean
    | (Partial<TransitionsOptions> & { readonly cover?: CoverName | CoverOptions })
  /** The site's GSAP. Its tweens and the frame share one ticker, and `gsap.to(handle.params)` works. */
  readonly gsap?: GsapLike
  /** The site's ScrollTrigger. Pins and scrubbed timelines drive `pin` and `progress`. */
  readonly ScrollTrigger?: ScrollTriggerStatic
  /** The site's Lenis instance, so smooth scroll lands in the same frame as the canvas. */
  readonly lenis?: LenisLike
  /** Extra plugins, your own or official ones with more options. */
  readonly plugins?: readonly PluginEntry[]
  /**
   * Renderer options beyond `background`. `start()` defaults to `antialias: 'auto'` and
   * `environment: 'room'`.
   */
  readonly render?: Partial<RenderOptions>
  /** When the engine boots: 'near' (default), 'eager' or 'manual'. */
  readonly load?: EffectsOptions['load']
  /** IntersectionObserver rootMargin that starts loading. Default '100% 0px'. */
  readonly margin?: string
  /** Download the engine in idle time after window load. Default true. */
  readonly prefetch?: boolean
  /**
   * 'auto' (default) is off under Save-Data and unavailable without WebGPU or WebGL 2. `true`
   * ignores Save-Data but not a missing GPU: the page stays plain, as with 'auto'. `false` is off.
   */
  readonly enabled?: boolean | 'auto'
  /**
   * Quality tiers for weaker GPUs: 'auto' (default) detects and adapts, a tier pins it, `false`
   * leaves the plugin out. Loads with the engine, never in the main chunk.
   */
  readonly quality?: 'auto' | QualityTier | false | Partial<QualityOptions>
}

const PASSED = ['load', 'margin', 'prefetch', 'enabled'] as const

let current: App | undefined

const isPatch = (source: EffectSource | EntryPatch): source is EntryPatch =>
  typeof source === 'object' && !('load' in source) && !('group' in source)

/** Later sources win. A patch keeps the loader and metadata of the entry it changes. */
function entries(base: EffectEntries, extra: StartOptions['effects'] = {}): EffectEntries {
  const out: Record<string, EffectSource> = { ...base }
  for (const [name, source] of Object.entries(extra)) {
    if (!isPatch(source)) out[name] = source
    else {
      const known = out[name]
      if (!known) console.warn(`[diorama] start({ effects }): no effect "${name}" to patch`)
      else if (typeof known === 'object') out[name] = { ...known, ...source }
      else {
        const effect = known as Effect
        out[name] =
          '~definition' in known
            ? { load: async () => effect, params: effect['~definition'].params, ...source }
            : { load: known, ...source }
      }
    }
  }
  return out
}

/**
 * A site effect under a built-in's name replaces it silently: say so in development, unless the
 * winning entry has `override: true`. Patches only change the built-in.
 */
function overrides(app: App, list: EffectEntries, extra: StartOptions['effects'] = {}): void {
  for (const name of Object.keys(catalog)) {
    const own = extra[name]
    const by =
      own && !isPatch(own) ? 'start({ effects })' : name in found ? 'the effects folder' : ''
    const entry = list[name]
    if (!by || (typeof entry === 'object' && entry.override)) continue
    const code: LogCode = 'EFFECT_OVERRIDE'
    const message = `${by} replaces the built-in effect "${name}"; rename yours or mark it override: true`
    app.log.warn(withDocs(`${code}: ${message}`, code))
  }
}

/**
 * Starts Diorama on the page and returns the app at once. It finishes starting in the
 * background. A second call returns the same app, so a re-run module doesn't make another.
 *
 *     import { start } from '@dioramajs/diorama'
 *     export const app = start()
 */
export function start(options: StartOptions = {}): App {
  const state = current?.state.value
  if (current && state !== 'destroyed' && state !== 'failed') return current
  const motion = options.transitions ?? true
  const { cover: look, ...flights } = typeof motion === 'object' ? motion : {}
  const tiers = options.quality ?? 'auto'
  const list = entries({ ...catalog, ...found }, options.effects)
  const app = createApp({
    plugins: [
      stage({ zIndex: options.canvas === 'behind' ? -1 : 1 }),
      assets(),
      ...(options.gsap
        ? [gsapPlugin({ gsap: options.gsap, scrollTrigger: options.ScrollTrigger })]
        : []),
      ...(options.lenis ? [lenisPlugin({ lenis: options.lenis })] : []),
      ...(options.plugins ?? []),
    ],
    presets: [
      effects({
        ...Object.fromEntries(
          PASSED.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
        ),
        effects: list,
        extend:
          tiers === false
            ? []
            : [
                () =>
                  import('@dioramajs/quality').then((m) =>
                    m.quality(typeof tiers === 'string' ? { tier: tiers } : tiers),
                  ),
              ],
        render: {
          antialias: 'auto',
          environment: 'room',
          ...options.render,
          ...(options.background === undefined ? {} : { background: options.background }),
        },
      }),
      ...(motion === false ? [] : [transitions(flights)]),
    ],
  })
  current = app
  if (DEV) overrides(app, list, options.effects)
  // Lets `app.attach` work on the next line, before the async start installs the real service.
  deferAttach(app)
  guard(app)
  adopt(app)
  const started = app.start()
  started.catch((error: unknown) => console.error('[diorama] start failed', error))
  // The cover and its looks load after the start, in chunks of their own.
  if (look && motion !== false)
    started
      .then(
        () => import('@dioramajs/transitions/cover').then((m) => app.use(m.cover(look))),
        () => {},
      )
      .catch((error: unknown) => console.error('[diorama] cover failed', error))
  return app
}
