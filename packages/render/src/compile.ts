import type { WebGPURenderer } from 'three/webgpu'

/**
 * Runs the renderer's `compileAsync` calls one after another, whoever makes them: the effects
 * runtime, an effect compiling its own object, site code, three's own helpers through the
 * `compile` alias. three r187 keeps a single precompilation state on the renderer
 * (`_precompilationState`), set and cleared around the awaits of every compile, so a second
 * compile in flight clears the state of the first and one of them throws. Each call still settles
 * with its own result or error, and a rejected one does not hold up the next.
 */
export function serialCompile(renderer: WebGPURenderer): void {
  const compile = renderer.compileAsync
  if (typeof compile !== 'function') return
  let queue: Promise<unknown> = Promise.resolve()
  renderer.compileAsync = (...args) => {
    const run = queue.then(() => compile.apply(renderer, args))
    queue = run.catch(() => {})
    return run
  }
}
