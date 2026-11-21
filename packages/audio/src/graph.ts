// The page's audio graph: one AudioContext, one source per media element for its whole life, and
// the check that keeps a connection from muting the site's sound.

let context: AudioContext | undefined
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
/** Network checks that passed, by URL: one request per source a page plays. */
const passed = new Map<string, Promise<boolean>>()

/** The URL the element plays: its current source, else `src`, else its first `<source>`. */
export function sourceOf(media: HTMLMediaElement): string {
  return (
    media.currentSrc ||
    media.src ||
    (media.querySelector('source[src]') as HTMLSourceElement | null)?.src ||
    ''
  )
}

/**
 * Whether Web Audio can read the element without muting it, as far as the page can tell without a
 * request: true, false, or undefined for a URL of the page's own origin, which a redirect may
 * take elsewhere, and for an element without a source yet.
 *
 * A request without CORS (no `crossorigin`) to another origin is opaque, and a media element
 * source of an opaque response outputs silence. With `crossorigin` the browser itself refuses a
 * source its server does not allow, so the graph changes nothing.
 */
export function local(media: HTMLMediaElement): boolean | undefined {
  if (media.srcObject) return true
  const url = sourceOf(media)
  if (!url) return undefined
  if (/^(blob|data):/i.test(url) || media.hasAttribute('crossorigin')) return true
  return new URL(url, document.baseURI).origin === location.origin ? undefined : false
}

/**
 * Whether the element's sound survives the graph. A URL of the page's origin is asked for once:
 * in `same-origin` mode any redirect to another origin fails, just as it taints the element's own
 * request. A server without HEAD gets a GET for the first byte.
 */
export function check(media: HTMLMediaElement): Promise<boolean> {
  const verdict = local(media)
  if (verdict !== undefined) return Promise.resolve(verdict)
  const url = sourceOf(media)
  if (!url) return Promise.resolve(false)
  const href = new URL(url, document.baseURI).href
  let result = passed.get(href)
  if (!result) {
    result = ask(href)
    passed.set(href, result)
    // A failure is asked again next time: it may have been the network.
    void result.then((ok) => ok || passed.delete(href))
  }
  return result
}

async function ask(url: string): Promise<boolean> {
  const request = (init: RequestInit): Promise<Response> =>
    fetch(url, { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', ...init })
  try {
    if ((await request({ method: 'HEAD' })).ok) return true
  } catch {}
  try {
    const response = await request({ headers: { Range: 'bytes=0-0' } })
    void response.body?.cancel().catch(() => {})
    return true
  } catch {
    return false
  }
}

/** The page's context, made on first use; undefined without Web Audio. */
export function audio(): AudioContext | undefined {
  if (!context) {
    const Context =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) return undefined
    context = new Context()
  }
  return context
}

/**
 * Resolves true once the context runs, false if the signal aborts first. A suspended context
 * would route a connected element to silence, so nothing connects before it runs.
 */
export function running(graph: AudioContext, signal: AbortSignal): Promise<boolean> {
  if (graph.state === 'running') return Promise.resolve(true)
  graph.resume().catch(() => {})
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      graph.removeEventListener('statechange', change)
      signal.removeEventListener('abort', abort)
      resolve(ok)
    }
    const change = (): void => {
      if (graph.state === 'running') done(true)
    }
    const abort = (): void => done(false)
    if (signal.aborted) return done(false)
    graph.addEventListener('statechange', change)
    signal.addEventListener('abort', abort)
  })
}

/** Asks a suspended context to run again, as a new play may allow. */
export function wake(): void {
  if (context && context.state === 'suspended') context.resume().catch(() => {})
}

/**
 * The element's source. The first call takes the element's sound into the graph for good (the
 * browser allows one source per element), so the source goes to the output at once and stays
 * connected; analysers come and go beside it.
 */
export function source(graph: AudioContext, media: HTMLMediaElement): MediaElementAudioSourceNode {
  let node = sources.get(media)
  if (!node) {
    node = graph.createMediaElementSource(media)
    node.connect(graph.destination)
    sources.set(media, node)
  }
  return node
}

/** The element's sound already goes through the graph. */
export const routed = (media: HTMLMediaElement): boolean => sources.has(media)
