import { type AppScope, isDioramaError, type Off } from '@diorama/core'
import { DEV } from '../define'
import type { LayerImpl } from './layer'

export interface PresentHost {
  readonly scope: AppScope
  layers(): Iterable<LayerImpl>
  /** Plugins started after `effects`. */
  plugins(): readonly string[]
  invalidate(): void
  warn(message: string): void
}

/**
 * `data-dio-state="drawn"` only after a frame that really drew. The kernel has no
 * "frame drawn" signal, so an outermost `render:frame` handler sets `ok` around the draw.
 */
export class Presenter {
  /** The draw ran to the end in this frame. */
  ok = false
  readonly #host: PresentHost
  #version = -1
  #off: Off | undefined
  #warned = false

  constructor(host: PresentHost) {
    this.#host = host
    this.#register()
  }

  /** Called in `effects:compose`. Re-registers if the hook chain changed and resets the flag. */
  sync(): void {
    if (this.#host.scope.hookVersion('render:frame') !== this.#version) this.#register()
    this.ok = false
  }

  #register(): void {
    const { scope } = this.#host
    this.#off?.()
    // Called every frame. Rebuild the wrapper only when the incoming draw changes.
    let inner: (() => void) | undefined
    let outer = (): void => {}
    const wrap = (draw: () => void) => {
      if (draw !== inner) {
        inner = draw
        outer = () => {
          this.ok = false
          draw()
          this.ok = true
        }
      }
      return outer
    }
    // Run outermost, after later plugins and app code. Otherwise a handler that drops the
    // incoming draw would drop this wrapper with it.
    const after = [...this.#host.plugins().filter((name) => name !== 'effects'), 'app']
    try {
      this.#off = scope.hook('render:frame', wrap, { after })
    } catch (error) {
      if (!isDioramaError(error, 'ORDER_CYCLE')) throw error
      this.#off = scope.hook('render:frame', wrap)
      if (DEV)
        this.#host.warn('a render:frame handler wants to run after effects: drawn may stay off')
    }
    this.#version = scope.hookVersion('render:frame')
  }

  /** Called in `effects:present`. Sets or drops `drawn` per layer from this frame's result. */
  frame(): void {
    let dropped = false
    for (const layer of this.#host.layers()) {
      const running = layer.running()
      const i = layer.input
      const sized = i.width > 0 && i.height > 0
      // A veiled copy is not drawn, whatever the frame.
      const veiled = !!layer.taken?.veil
      let state: 'live' | 'drawn' | undefined = running ? 'live' : undefined
      // Leaving the screen keeps drawn. A zero box or a failed frame drops it.
      if (
        running &&
        this.ok &&
        sized &&
        !veiled &&
        layer.copy() &&
        (layer.visible || layer.state === 'drawn')
      ) {
        state = 'drawn'
      }
      if (layer.state === 'drawn' && state !== 'drawn' && !veiled) dropped = true
      layer.present(state)
    }
    if (!dropped) return
    this.#host.invalidate()
    if (!this.ok && DEV && !this.#warned) {
      this.#warned = true
      this.#host.warn(
        'the frame was not drawn (a render:frame handler discards the incoming draw?)',
      )
    }
  }
}
