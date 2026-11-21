import { definePlugin } from '../kernel/plugin'
import { signal } from '../kernel/signals'
import type { Off, Plugin, ReadonlySignal } from '../kernel/types'

/** The `visibility` service. */
export interface VisibilityApi {
  /** Whether the tab is visible. */
  readonly visible: ReadonlySignal<boolean>
}

/** Options of the `visibility` plugin. */
export interface VisibilityOptions {
  /** Pause the frame loop while the tab is hidden. Default true. */
  readonly pause: boolean
}

const defaults: VisibilityOptions = { pause: true }

/** Tracks tab visibility and pauses frames while the tab is hidden. Built in. */
export const visibility: Plugin<'visibility', VisibilityOptions> = /*#__PURE__*/ definePlugin({
  name: 'visibility',
  defaults,
  setup(app, options): VisibilityApi {
    const visible = signal(true)
    if (typeof document === 'undefined') return { visible }
    // Releases the pause taken while the tab is hidden.
    let resume: Off | undefined
    const update = (): void => {
      visible.value = document.visibilityState !== 'hidden'
      if (!visible.peek() && options.pause) resume ??= app.pause('hidden')
      else if (resume) {
        resume()
        resume = undefined
      }
    }
    update()
    document.addEventListener('visibilitychange', update, { signal: app.abortSignal })
    return { visible }
  },
})
