// The no-build entry for sites without a bundler (plain HTML, Webflow, Tilda):
//   <script type="module" src="https://cdn.jsdelivr.net/npm/dioramajs/dist/cdn/auto.js"></script>
// It starts at once with the media effects and transitions. Options go in `window.diorama`
// before the tag. Your own effects import `effect` from the same URL to share one instance.
// dist/esm/index.js is the same entry with three left to the page's import map, for effects
// that import `three/tsl` themselves.
import { type StartOptions, start } from './index'

export * from './index'

interface Globals {
  diorama?: StartOptions & { readonly manual?: boolean }
  gsap?: StartOptions['gsap']
  ScrollTrigger?: StartOptions['ScrollTrigger']
}

if (typeof window !== 'undefined') {
  const globals = window as unknown as Globals
  const { manual, ...options } = globals.diorama ?? {}
  // A page that loaded GSAP from a CDN gets the shared ticker without a line of JS.
  if (!manual) start({ gsap: globals.gsap, ScrollTrigger: globals.ScrollTrigger, ...options })
}
