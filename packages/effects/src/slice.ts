// Splits the engine boot into tasks, so loading three, starting render and running each setup
// do not add up to one long task on the main thread.
interface Scheduler {
  yield(): Promise<void>
}

/** Main-thread time a task may spend on boot steps before the next step waits for a task, ms. */
const BUDGET = 10
/** When the current task started running boot steps. */
let taskStart = Number.NEGATIVE_INFINITY

/** Whether the browser can yield a task and keep its place: `scheduler.yield()`. */
export const canSlice = (): boolean =>
  typeof (globalThis as { scheduler?: Partial<Scheduler> }).scheduler?.yield === 'function'

/**
 * A point between boot steps (engine evaluation, render, runtime start, each setup). Resolves in
 * the same task while it is young, otherwise after `scheduler.yield()`, so steps chained on
 * promises do not add up to one long task. Without `scheduler.yield` (Safari, test DOMs) it
 * never waits.
 */
export function slice(): Promise<void> {
  if (!canSlice() || performance.now() - taskStart < BUDGET) return Promise.resolve()
  return (globalThis as unknown as { scheduler: Scheduler }).scheduler.yield().then(() => {
    taskStart = performance.now()
  })
}
