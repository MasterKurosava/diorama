// The no-build entry for sites without a bundler (plain HTML, Webflow, Tilda):
//   <script type="module" src="https://cdn.jsdelivr.net/npm/diorama/dist/cdn/auto.js"></script>
// It starts at once with the media effects and transitions. Options go in `window.diorama`
// before the tag. Your own effects import `effect` from the same URL to share one instance.
import { type StartOptions, start } from './index'

export * from './index'

interface Globals {
  diorama?: StartOptions & { readonly manual?: boolean }
  gsap?: StartOptions['gsap']
  ScrollTrigger?: StartOptions['ScrollTrigger']
}

if (typeof window !== 'undefined') {
  const g = window as unknown as Globals
  const { manual, ...options } = g.diorama ?? {}
  // A page that loaded GSAP from a CDN gets the shared ticker without a line of JS.
  if (!manual) start({ gsap: g.gsap, ScrollTrigger: g.ScrollTrigger, ...options })
}
