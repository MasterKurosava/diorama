import { definePlugin, type Off, type Plugin } from '@diorama/core'
import { acquire, DEV, type PumpOwner, pumpOf, release, wrap } from './pump'
import { lenisSource } from './source'
import type { LenisApi, LenisLike, LenisPluginOptions } from './types'

const defaults: Omit<Required<LenisPluginOptions>, 'lenis'> = { takeover: true, handoff: true }
const noop = (): void => {}

/** What the plugin reads from `app.gsap`, so @diorama/gsap stays optional. */
interface GsapLike {
  readonly scrollTrigger?: { update(): void } | undefined
}

/** Lenis in Diorama's frame. One Lenis step per pass, then the loops read what it wrote. */
export const lenisPlugin: Plugin<'lenis', LenisPluginOptions, LenisApi> =
  /*#__PURE__*/ definePlugin<
    'lenis',
    LenisPluginOptions,
    typeof defaults,
    LenisApi,
    ['scroll'],
    ['gsap']
  >({
    name: 'lenis',
    dependencies: ['scroll'],
    optionalDependencies: ['gsap'],
    defaults,
    setup(app, options): LenisApi {
      const mode = options.takeover ? 'diorama' : 'external'
      if (typeof window === 'undefined') return { lenis: undefined, mode, use: () => noop }
      const gsap = (): GsapLike | undefined => app.gsap as GsapLike | undefined
      let current: { readonly lenis: LenisLike; readonly off: Off } | undefined
      let unsynced = false

      const use = (lenis: LenisLike): Off => {
        // A destroyed app takes nothing, since no listener, source or pump would ever be undone.
        if (app.abortSignal.aborted) return noop
        if (current?.lenis === lenis) return current.off
        current?.off()
        // Undone newest first, so the driver goes before the pump is released.
        const offs: Off[] = []
        let done = false
        let unregister = noop
        const off = (): void => {
          if (done) return
          done = true
          unregister()
          if (current?.lenis === lenis) current = undefined
          for (let i = offs.length; i--; ) offs[i]?.()
          app.invalidate()
        }
        unregister = app.onDispose(off)
        current = { lenis, off }

        const wrapper = lenis.options.wrapper
        if (wrapper && wrapper !== window) {
          app.log.warn(
            'LENIS_WRAPPER: Lenis scrolls a wrapper element; anchors treat its offset as page scroll, elements outside it shift',
          )
        }
        offs.push(
          lenis.on('scroll', () => {
            app.invalidate()
            // Pins and scrub move before the frame reads the page.
            gsap()?.scrollTrigger?.update()
          }),
        )
        offs.push(app.scroll.source(lenisSource(lenis)))
        if (options.takeover) {
          const owner: PumpOwner = {
            warn: (code, message) => app.log.warn(`${code}: ${message}`),
            info: (code, message) => app.log.info(`${code}: ${message}`),
            report: (error, source) => app.report(error, source),
            destroyed: off,
          }
          const pump = acquire(lenis, app.loop.driver, owner)
          offs.push(() => release(lenis, owner, options.handoff))
          offs.push(app.setDriver(pump.driver))
          if (pump.captured && DEV) {
            app.log.info('LENIS_AUTORAF: autoRaf taken over, Diorama advances Lenis')
          }
          unsynced = false
        } else {
          // Without a pump only `destroy` is watched, so the source never outlives Lenis.
          offs.push(
            wrap(lenis, 'destroy', (original) => () => {
              original()
              off()
            }),
          )
        }
        app.invalidate()
        return off
      }

      app.system(
        'input',
        () => {
          const pump = current && pumpOf(current.lenis)
          if (!pump || unsynced || app.loop.driver === pump.driver) return
          unsynced = true
          app.log.warn(
            'LENIS_UNSYNCED: the driver was replaced over Lenis: Diorama frames no longer follow Lenis',
          )
        },
        { name: 'lenis', before: 'scroll' },
      )

      if (options.lenis) use(options.lenis)
      return {
        get lenis() {
          return current?.lenis
        },
        mode,
        use,
      }
    },
  })
