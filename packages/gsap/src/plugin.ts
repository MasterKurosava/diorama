import {
  definePlugin,
  type FrameDriver,
  type Off,
  type Plugin,
  type ScrollApi,
  type ScrollSource,
} from '@diorama/core'
import { gsapDriver } from './driver'
import type {
  GsapApi,
  GsapLike,
  GsapPluginOptions,
  PinOptions,
  PinProgress,
  ScrollTriggerLike,
  ScrollTriggerStatic,
} from './types'

declare const process: { env: Record<string, string | undefined> } | undefined
const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

/** The part of `app.effects` the plugin uses, so @diorama/effects stays an optional peer. */
interface EffectsLike {
  instances(): readonly { readonly element: Element }[]
  pin(element: Element, source: () => number): Off
}

/** Frames without a ScrollTrigger before the hint to pass it explicitly. */
const LOOKUP_FRAMES = 60
const noop = (): void => {}

const defaults: Omit<GsapPluginOptions, 'gsap'> = {
  scrollTrigger: undefined,
  ticker: 'auto',
  liveScroll: true,
  pins: true,
}

const globalsOf = (gsap: GsapLike): Record<string, unknown> | undefined =>
  (gsap.core as { globals?: () => Record<string, unknown> } | undefined)?.globals?.()

/** Matches by shape, not by name, because a minified build renames the ScrollTrigger class. */
function findScrollTrigger(gsap: GsapLike): ScrollTriggerStatic | undefined {
  const globals = globalsOf(gsap)
  if (!globals) return undefined
  for (const value of Object.values(globals)) {
    if (typeof value !== 'function') continue
    const st = value as unknown as Partial<Record<keyof ScrollTriggerStatic, unknown>>
    if (
      typeof st.getAll === 'function' &&
      typeof st.update === 'function' &&
      typeof st.refresh === 'function' &&
      typeof st.create === 'function' &&
      typeof st.addEventListener === 'function'
    ) {
      return st as unknown as ScrollTriggerStatic
    }
  }
  return undefined
}

const deterministic = (driver: FrameDriver): boolean => {
  const d = driver as { step?: unknown; tick?: unknown }
  return typeof d.step === 'function' || typeof d.tick === 'function'
}

const windowSource: ScrollSource = {
  name: 'gsap',
  read(out) {
    out.x = window.scrollX
    out.y = window.scrollY
    out.travel = out.y
  },
}

function targets(target: PinOptions['target'], root: Element | null | undefined, fx: EffectsLike) {
  if (typeof target === 'string') return [...document.querySelectorAll(target)]
  if (target instanceof Element) return [target]
  if (target) return [...target]
  if (!root) return []
  const found = new Set<Element>()
  if (root.matches('[data-dio]')) found.add(root)
  for (const el of root.querySelectorAll('[data-dio]')) found.add(el)
  for (const { element } of fx.instances()) if (root.contains(element)) found.add(element)
  return [...found]
}

const inert: GsapApi = {
  driver: undefined,
  scrollTrigger: undefined,
  pin: () => noop,
  refresh: noop,
}

/** gsap and ScrollTrigger in Diorama's frame. One ticker, live scroll, pins from triggers. */
export const gsapPlugin: Plugin<'gsap', GsapPluginOptions, GsapApi, 'gsap'> =
  /*#__PURE__*/ definePlugin<
    'gsap',
    GsapPluginOptions,
    typeof defaults,
    GsapApi,
    [],
    ['scroll', 'anchors', 'effects']
  >({
    name: 'gsap',
    optionalDependencies: ['scroll', 'anchors', 'effects'],
    defaults,
    setup(app, options): GsapApi {
      if (typeof window === 'undefined') return inert
      const { gsap } = options
      const scroll = app.scroll as ScrollApi | undefined
      const fx = app.effects as EffectsLike | undefined

      let driver: FrameDriver | undefined
      const current = app.loop.driver
      if (options.ticker === true || (options.ticker === 'auto' && !deterministic(current))) {
        driver = gsapDriver(gsap)
        app.setDriver(driver)
      } else if (options.ticker === 'auto') {
        app.log.info(
          `gsap: the deterministic driver "${current.name}" stays; gsap tweens run on their own ticker`,
        )
      }

      if (options.liveScroll && scroll) app.onDispose(scroll.source(windowSource))

      let scrollTrigger: ScrollTriggerStatic | undefined
      // Automatic pins by element. Elements with explicit pins are skipped.
      const bound = new Map<Element, { st: ScrollTriggerLike; source: () => number; off: Off }>()
      const explicit = new WeakMap<Element, number>()
      let dirty = true
      let seen: readonly ScrollTriggerLike[] = []
      const repin = (): void => {
        dirty = true
        app.invalidate()
      }

      const pinSource = (st: ScrollTriggerLike, mode: PinProgress): (() => number) => {
        let last = Number.NaN
        return () => {
          if (st.enabled === false) {
            // Usually caught in `input` already. This covers a kill between input and layout.
            repin()
            return Number.NaN // effects falls back to the anchor formula, without a warning
          }
          const scrubbed = mode === 'animation' || (mode === 'auto' && st.vars?.scrub)
          const animation = scrubbed ? st.animation : null
          const value = Math.min(1, Math.max(0, animation ? animation.progress() : st.progress))
          // Read once per frame in `layout`, so a change asks for exactly one more frame.
          if (value !== last) {
            last = value
            app.invalidate()
          }
          return value
        }
      }

      const unbind = (el: Element): void => {
        bound.get(el)?.off()
        bound.delete(el)
      }

      const rebind = (fx: EffectsLike): void => {
        // gsap filters into a new array per call, one small allocation a frame. Compare by
        // identity, since a matchMedia revert keeps the length.
        const all = scrollTrigger?.getAll() ?? []
        if (all.length !== seen.length || all.some((st, i) => st !== seen[i])) {
          seen = [...all]
          dirty = true
        }
        if (!dirty) for (const { st } of bound.values()) if (st.enabled === false) dirty = true
        if (!dirty) return
        dirty = false
        const pinned = all.filter((st) => st.enabled !== false && st.pin)
        const live = new Set<Element>()
        for (const { element: el } of fx.instances()) {
          if (live.has(el)) continue
          live.add(el)
          if (explicit.has(el)) continue
          // The deepest trigger wins. Its pin element lies inside the other candidates'.
          let best: ScrollTriggerLike | undefined
          for (const st of pinned) {
            const pin = st.pin as Element
            if (pin !== el && !pin.contains(el)) continue
            if (!best || (best.pin !== pin && (best.pin as Element).contains(pin))) best = st
          }
          const previous = bound.get(el)
          // Same trigger. Write the source again anyway, a direct effects.pin may have replaced it.
          const source =
            previous && previous.st === best ? previous.source : best && pinSource(best, 'auto')
          unbind(el)
          if (best && source) bound.set(el, { st: best, source, off: fx.pin(el, source) })
        }
        for (const el of bound.keys()) if (!live.has(el)) unbind(el)
      }

      const onRefresh = (): void => {
        app.anchors?.refresh()
        scroll?.measure()
        repin()
      }
      const resolve = (): void => {
        scrollTrigger = options.scrollTrigger ?? findScrollTrigger(gsap)
        if (!scrollTrigger) return
        const st = scrollTrigger
        st.addEventListener('refresh', onRefresh)
        app.onDispose(() => st.removeEventListener('refresh', onRefresh))
        dirty = true
      }
      resolve()

      let lookups = 0
      app.system(
        'input',
        () => {
          if (!scrollTrigger) {
            resolve()
            if (
              !scrollTrigger &&
              DEV &&
              options.pins &&
              fx &&
              ++lookups === LOOKUP_FRAMES &&
              Object.keys(globalsOf(gsap) ?? {}).length > 0
            ) {
              app.log.warn(
                'GSAP_SCROLLTRIGGER: ScrollTrigger is not found in gsap.core.globals(): pass `scrollTrigger: ScrollTrigger` to gsapPlugin',
              )
            }
          }
          if (options.pins && fx) rebind(fx)
        },
        { name: 'gsap', before: 'scroll' },
      )

      if (fx) app.on('effects:status' as never, repin)
      app.onDispose(() => {
        for (const el of [...bound.keys()]) unbind(el)
      })

      return {
        driver,
        get scrollTrigger() {
          return scrollTrigger
        },
        pin(st, pinOptions = {}) {
          if (!fx) throw new Error('gsap.pin needs @diorama/effects')
          // A destroyed app binds nothing, since no pin would ever be undone.
          if (app.abortSignal.aborted) return noop
          const els = targets(pinOptions.target, st.pin ?? st.trigger, fx)
          const source = pinSource(st, pinOptions.progress ?? 'auto')
          const offs = els.map((el) => {
            unbind(el)
            explicit.set(el, (explicit.get(el) ?? 0) + 1)
            return fx.pin(el, source)
          })
          let done = false
          let unregister = noop
          const off = (): void => {
            if (done) return
            done = true
            unregister()
            for (const o of offs) o()
            for (const el of els) {
              const count = (explicit.get(el) ?? 1) - 1
              if (count > 0) explicit.set(el, count)
              else explicit.delete(el)
            }
            repin()
          }
          unregister = app.onDispose(off)
          return off
        },
        refresh: repin,
      }
    },
  })
