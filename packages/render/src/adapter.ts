interface Gpu {
  requestAdapter(options?: { featureLevel?: string }): Promise<unknown>
}

/** Longest wait for an answer, ms. A first request takes 100 to 300 ms in Chromium. */
const WAIT = 1000

/** One request per page: its `navigator.gpu`. */
const asked = new WeakMap<Gpu, Promise<boolean>>()

/**
 * Whether the browser gives a WebGPU adapter, asked once per page. Without one three's
 * WebGPURenderer tries WebGPU, warns on the console and falls back to WebGL 2; knowing it first
 * lets `render` take WebGL 2 at once. No answer within a second counts as no adapter, so a hung
 * request never holds up the start.
 */
export function hasAdapter(): Promise<boolean> {
  const gpu = typeof navigator === 'undefined' ? undefined : (navigator as { gpu?: Gpu }).gpu
  if (!gpu) return Promise.resolve(false)
  let answer = asked.get(gpu)
  if (!answer) {
    // Asked as three asks (WebGPUBackend.init), so a compatibility-only adapter counts.
    answer = Promise.resolve()
      .then(() => gpu.requestAdapter({ featureLevel: 'compatibility' }))
      .then(
        (adapter) => adapter != null,
        () => false,
      )
    asked.set(gpu, answer)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, WAIT, false)
  })
  return Promise.race([answer, late]).finally(() => clearTimeout(timer))
}
