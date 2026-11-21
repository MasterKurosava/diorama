import { DioramaError } from '../kernel/errors'
import { definePlugin } from '../kernel/plugin'
import { batch, signal } from '../kernel/signals'
import type { Off, Plugin, ReadonlySignal } from '../kernel/types'
import { noop } from '../kernel/util'
import { onBodySwap } from './body'
import { followScroll } from './follow'

/** Options of the `stage` plugin. */
export interface StageOptions {
  /**
   * Canvas or selector to draw into. By default a fixed full-viewport canvas is created. A
   * selector that matches no canvas fails the plugin with `PLUGIN_OPTIONS`.
   */
  readonly canvas: HTMLCanvasElement | string | undefined
  /** z-index of the created canvas. It sits above content, which stays interactive. Default 1. */
  readonly zIndex: number
  /** Upper bound for the device pixel ratio. Default 2. */
  readonly maxPixelRatio: number
  /**
   * Keeps GL copies on their elements while the browser scrolls the page ahead of the next frame
   * (keyboard, scrollbar, native wheel, touch). The created canvas moves with the page on the
   * compositor until the frame lands, and GL content fixed to the viewport moves with it for that
   * time. While a `stage.hold` predicate is true (effects: a pinned sticky stage of a scroll
   * section) the canvas stays fixed to the viewport instead. Vertical page scroll only. Needs CSS
   * scroll-driven animations. Default true.
   */
  readonly followScroll: boolean
}

/** The `stage` service: the canvas and the viewport. */
export interface StageApi {
  /** The page-wide canvas, created on first access. `undefined` without a DOM. */
  readonly canvas: HTMLCanvasElement | undefined
  /** Viewport size in CSS px, excluding scrollbars. */
  readonly width: ReadonlySignal<number>
  /** Viewport height in CSS px, excluding scrollbars. */
  readonly height: ReadonlySignal<number>
  /** Device pixel ratio, capped by `maxPixelRatio`. */
  readonly pixelRatio: ReadonlySignal<number>
  /** Whether the user prefers reduced motion. */
  readonly reducedMotion: ReadonlySignal<boolean>
  /**
   * Keeps the created canvas from following scroll (`followScroll`) while `held()` is true:
   * for content that stands still on screen as the page scrolls, such as a pinned sticky stage.
   * Read once per frame after the frame is drawn; the switch lands with that frame. Returns a
   * function that removes the predicate. Without following it does nothing.
   */
  hold(held: () => boolean): Off
}

const defaults: StageOptions = {
  canvas: undefined,
  zIndex: 1,
  maxPixelRatio: 2,
  followScroll: true,
}

/** Canvases created by live apps. Any other `canvas[data-dio-canvas]` is a stale clone. */
const liveCanvases = new WeakSet<Element>()

/** One canvas for the whole site. It outlives page transitions. */
export const stage: Plugin<'stage', StageOptions> = /*#__PURE__*/ definePlugin({
  name: 'stage',
  defaults,
  setup(app, options): StageApi {
    const width = signal(0)
    const height = signal(0)
    const pixelRatio = signal(1)
    const reducedMotion = signal(false)
    const api: StageApi = {
      canvas: undefined,
      width,
      height,
      pixelRatio,
      reducedMotion,
      hold: () => noop,
    }
    if (typeof document === 'undefined') return api

    const root = document.documentElement
    const measure = (): void => {
      batch(() => {
        width.value = root.clientWidth
        height.value = root.clientHeight
        pixelRatio.value = Math.min(window.devicePixelRatio || 1, options.maxPixelRatio)
      })
      app.invalidate()
    }
    measure()
    const listen = { signal: app.abortSignal }
    window.addEventListener('resize', measure, listen)

    const reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (reduceQuery) {
      const update = (): void => {
        reducedMotion.value = reduceQuery.matches
      }
      update()
      reduceQuery.addEventListener('change', update, listen)
    }

    const follow = followScroll(app)

    let canvas: HTMLCanvasElement | undefined
    // Runs once for a canvas the plugin created: it follows scroll and lives as long as the app.
    const adopt = (created: HTMLCanvasElement): void => {
      if (options.followScroll) follow(created)
      liveCanvases.add(created)
      app.onDispose(() => {
        liveCanvases.delete(created)
        created.remove()
      })
      // A replaced <body> takes the canvas with it, so move it into the new one.
      onBodySwap(app, (body) => {
        // Clones from a cached snapshot are dead full-screen canvases.
        for (const clone of body.querySelectorAll('canvas[data-dio-canvas]')) {
          if (!liveCanvases.has(clone)) clone.remove()
        }
        if (!created.isConnected) body.append(created)
        app.invalidate()
      })
    }
    return {
      ...api,
      hold: follow.hold,
      get canvas() {
        canvas ??= resolveCanvas(options, adopt)
        return canvas
      },
    }
  },
})

/** The canvas of `options.canvas`, or a new full-viewport one passed to `adopt`. */
function resolveCanvas(
  options: StageOptions,
  adopt: (created: HTMLCanvasElement) => void,
): HTMLCanvasElement {
  const { canvas } = options
  if (canvas instanceof HTMLCanvasElement) return canvas
  if (typeof canvas === 'string') {
    const found = document.querySelector(canvas)
    if (found instanceof HTMLCanvasElement) return found
    throw new DioramaError('PLUGIN_OPTIONS', `no canvas matches "${canvas}"`, { plugin: 'stage' })
  }
  const created = document.createElement('canvas')
  created.setAttribute('aria-hidden', 'true')
  // Turbo drops temporary elements from its snapshots. The marker finds clones made otherwise.
  created.setAttribute('data-dio-canvas', '')
  created.setAttribute('data-turbo-temporary', '')
  Object.assign(created.style, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: String(options.zIndex),
  })
  document.body.append(created)
  adopt(created)
  return created
}
