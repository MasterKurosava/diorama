// The site entry. One call starts effects, the media effects, page transitions and assets.
// Effects from the folder come through `diorama/generated`, which the build plugin fills in.
import { assets } from '@diorama/assets'
import { type App, createApp, type Plugin, stage } from '@diorama/core'
import { type EffectEntries, effects } from '@diorama/effects'
import { type GsapLike, gsapPlugin, type ScrollTriggerStatic } from '@diorama/gsap'
import { type LenisLike, lenisPlugin } from '@diorama/lenis'
import { media } from '@diorama/media'
import type { RenderOptions } from '@diorama/render'
import { type TransitionsOptions, transitions } from '@diorama/transitions'
import { effects as found } from 'diorama/generated'
import { deferAttach } from './attach'

export { assets } from '@diorama/assets'
export type { App } from '@diorama/core'
export { createApp, stage } from '@diorama/core'
export type {
  Effect,
  EffectContext,
  EffectEntries,
  EffectHandle,
  EffectName,
  EffectOptions,
  EffectSetup,
  EffectTypes,
  SiteEffects,
} from '@diorama/effects'
export { color, defineEffect, effect, effects, oneOf, redefine, text } from '@diorama/effects'
export { media } from '@diorama/media'
export { transition, transitions } from '@diorama/transitions'
export { ready } from './attach'

export interface StartOptions {
  /** 'over' (default) draws above the page, 'behind' draws under a transparent page. */
  readonly canvas?: 'over' | 'behind'
  /** Clear colour, e.g. `0x08080b`. Transparent by default. */
  readonly background?: number
  /** Effects besides the folder's and the media ones. A matching name replaces theirs. */
  readonly effects?: EffectEntries
  /** Page transitions by `data-dio-key`. On by default, `false` turns them off. */
  readonly transitions?: boolean | Partial<TransitionsOptions>
  /** The site's GSAP. Its tweens and the frame share one ticker, and `gsap.to(handle.params)` works. */
  readonly gsap?: GsapLike
  /** The site's ScrollTrigger. Pins and scrubbed timelines drive `pin` and `progress`. */
  readonly ScrollTrigger?: ScrollTriggerStatic
  /** The site's Lenis instance, so smooth scroll lands in the same frame as the canvas. */
  readonly lenis?: LenisLike
  /** Extra plugins, your own or official ones with more options. */
  readonly plugins?: readonly Plugin[]
  /** Renderer options beyond `background`. */
  readonly render?: Partial<RenderOptions>
}

let current: App | undefined

/**
 * Starts Diorama on the page and returns the app at once. It finishes starting in the
 * background. A second call returns the same app, so a re-run module doesn't make another.
 *
 *     import { start } from 'diorama'
 *     export const app = start()
 */
export function start(options: StartOptions = {}): App {
  const state = current?.state.value
  if (current && state !== 'destroyed' && state !== 'failed') return current
  const motion = options.transitions ?? true
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
        effects: { ...media, ...found, ...options.effects },
        render: {
          ...options.render,
          ...(options.background === undefined ? {} : { background: options.background }),
        },
      }),
      ...(motion === false ? [] : [transitions(motion === true ? {} : motion)]),
    ],
  })
  current = app
  // Lets `app.attach` work on the next line, before the async start installs the real service.
  deferAttach(app)
  app.start().catch((error: unknown) => console.error('[diorama] start failed', error))
  return app
}
