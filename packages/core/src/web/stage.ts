import { DioramaError } from '../kernel/errors'
import { definePlugin } from '../kernel/plugin'
import { batch, signal } from '../kernel/signals'
import type { Plugin, ReadonlySignal } from '../kernel/types'
import { onBodySwap } from './body'
import { followScroll } from './follow'

export interface StageOptions {
  /** Canvas or selector to draw into. By default a fixed full-viewport canvas is created. */
  readonly canvas: HTMLCanvasElement | string | undefined
  /** z-index of the created canvas. It sits above content, which stays interactive. Default 1. */
  readonly zIndex: number
  /** Upper bound for the device pixel ratio. Default 2. */
  readonly maxPixelRatio: number
  /**
   * Keeps GL copies on their elements while the browser scrolls the page ahead of the next frame
   * (keyboard, scrollbar, native wheel, touch). The created canvas moves with the page on the
   * compositor until the frame lands, and GL content fixed to the viewport moves with it for that
   * time. Vertical page scroll only. Needs CSS scroll-driven animations. Default true.
   */
  readonly followScroll: boolean
}

export interface StageApi {
  /** The page-wide canvas, created on first access. `undefined` without a DOM. */
  readonly canvas: HTMLCanvasElement | undefined
  /** Viewport size in CSS px, excluding scrollbars. */
  readonly width: ReadonlySignal<number>
  readonly height: ReadonlySignal<number>
  readonly pixelRatio: ReadonlySignal<number>
  readonly reducedMotion: ReadonlySignal<boolean>
}

const defaults: StageOptions = {
  canvas: undefined,
  zIndex: 1,
  maxPixelRatio: 2,
  followScroll: true,
}

/** Canvases created by live apps. Any other `canvas[data-dio-canvas]` is a stale clone. */
const live = new WeakSet<Element>()

/** One canvas for the whole site. It outlives page transitions. */
export const stage: Plugin<'stage', StageOptions> = /*#__PURE__*/ definePlugin({
  name: 'stage',
  defaults,
  setup(app, options): StageApi {
    const width = signal(0)
    const height = signal(0)
    const pixelRatio = signal(1)
    const reducedMotion = signal(false)
    const api: StageApi = { canvas: undefined, width, height, pixelRatio, reducedMotion }
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

    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (motion) {
      const update = (): void => {
        reducedMotion.value = motion.matches
      }
      update()
      motion.addEventListener('change', update, listen)
    }

    const follow = followScroll(app)

    let canvas: HTMLCanvasElement | undefined
    const owned = (created: HTMLCanvasElement): void => {
      if (options.followScroll) follow(created)
      live.add(created)
      app.onDispose(() => {
        live.delete(created)
        created.remove()
      })
      // A replaced <body> takes the canvas with it, so move it into the new one.
      onBodySwap(app, (body) => {
        // Clones from a cached snapshot are dead full-screen canvases.
        for (const clone of body.querySelectorAll('canvas[data-dio-canvas]')) {
          if (!live.has(clone)) clone.remove()
        }
        if (!created.isConnected) body.append(created)
        app.invalidate()
      })
    }
    return {
      ...api,
      get canvas() {
        canvas ??= resolveCanvas(options, owned)
        return canvas
      },
    }
  },
})

function resolveCanvas(
  options: StageOptions,
  owned: (created: HTMLCanvasElement) => void,
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
  owned(created)
  return created
}
