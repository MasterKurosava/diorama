/**
 * Calls `swap` after the document's <body> element is replaced (Astro ClientRouter, Turbo).
 * Observes only the childList of <html>, which gives one record per swap and none for page
 * content changes.
 */
export function onBodySwap(
  app: { onDispose(cleanup: () => void): unknown },
  swap: (body: HTMLElement, previous: HTMLElement) => void,
): void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  let current = document.body
  const observer = new MutationObserver(() => {
    const body = document.body
    if (!body || body === current) return
    const previous = current
    current = body
    swap(body, previous)
  })
  observer.observe(document.documentElement, { childList: true })
  app.onDispose(() => observer.disconnect())
}
