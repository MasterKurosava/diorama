import type { WebGPURenderer } from 'three/webgpu'

// three's private frame loop, `renderer._animation` (r187 src/renderers/common/Animation.js).
// render() and compute() call start(). Each tick resets `renderer.info`, moves `nodeFrame` (frame
// id, `time`, `deltaTime`) and the inspector, then asks its context for the next animation frame,
// for ever until stop(). This adapter keeps the tick and drops the asking. A three upgrade that
// changes this shape fails the loop tests instead of quietly waking the page again.
interface Animation {
  getContext(): AnimationContext | null
  setContext(context: AnimationContext): void
  getAnimationLoop(): unknown
  stop(): void
}

interface AnimationContext {
  requestAnimationFrame(callback: FrameRequestCallback): number
  cancelAnimationFrame(handle: number): void
}

/** three's per-frame tick, run by the app loop instead of the browser. */
export interface HeldLoop {
  /** Runs three's tick for a frame about to be drawn. */
  tick(now: number): void
}

/** Handle returned for a tick that is kept rather than requested from the browser. */
const HELD = -1

/**
 * Gives three's animation loop a context that keeps the next tick until `tick` runs it, so three
 * never asks the browser for a frame of its own. A loop set with `renderer.setAnimationLoop`
 * gets real frames again from the next app frame on; XR swaps its session in and back itself.
 * Undefined when three's internals no longer look like r187.
 */
export function holdLoop(renderer: WebGPURenderer): HeldLoop | undefined {
  const animation = (renderer as unknown as { _animation?: Partial<Animation> })._animation
  const real = animation?.getContext?.()
  if (
    !real ||
    typeof animation?.setContext !== 'function' ||
    typeof animation.getAnimationLoop !== 'function' ||
    typeof animation.stop !== 'function'
  )
    return undefined
  const loop = animation as Animation
  let next: FrameRequestCallback | undefined
  // A render before this point has asked for a real frame already.
  loop.stop()
  loop.setContext({
    requestAnimationFrame(callback) {
      if (loop.getAnimationLoop() !== null) return real.requestAnimationFrame(callback)
      next = callback
      return HELD
    },
    cancelAnimationFrame(handle) {
      next = undefined
      if (handle !== HELD) real.cancelAnimationFrame(handle)
    },
  })
  return {
    tick(now) {
      const run = next
      next = undefined
      run?.(now)
    },
  }
}
