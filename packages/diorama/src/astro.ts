// diorama/astro, used as `integrations: [diorama()]` in astro.config. Astro builds with Vite, so
// this adds the Vite plugin. Call `start()` in a <script> of the layout. With `lenis` it also
// puts one Lenis on every page (diorama/astro/client) for that app to drive, with
// `restoreScroll` the scroll policy for links.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScrollRestore } from './astro-client'
import { type DioramaPluginOptions, diorama as vite } from './vite'

/**
 * Lenis options that can be written into the page. Functions (`easing`, `prevent`,
 * `virtualScroll`) cannot: pass those to `smoothScroll` from diorama/astro/client in a script.
 */
export interface AstroLenisOptions {
  /** Smoothing per frame, 0 to 1. Lenis' default 0.1. */
  readonly lerp?: number
  /** Duration of a smooth scroll, s, used instead of `lerp`. */
  readonly duration?: number
  /** Smooth the wheel. Default true. */
  readonly smoothWheel?: boolean
  /** Smooth touch too, with inertia. Default false. */
  readonly syncTouch?: boolean
  /** `lerp` while `syncTouch` follows a finger. Default 0.075. */
  readonly syncTouchLerp?: number
  /** Strength of the `syncTouch` inertia. Default 1.7. */
  readonly touchInertiaExponent?: number
  /** Multiplier of wheel steps. Default 1. */
  readonly wheelMultiplier?: number
  /** Multiplier of touch moves. Default 1. */
  readonly touchMultiplier?: number
  /** The scroll axis. Default 'vertical'. */
  readonly orientation?: 'vertical' | 'horizontal'
  /** The gestures that scroll. Default the `orientation`, 'both' for horizontal. */
  readonly gestureOrientation?: 'vertical' | 'horizontal' | 'both'
  /** Endless scroll. Default false. */
  readonly infinite?: boolean
  /** Let a nested Lenis hand the scroll over at its end. Default true. */
  readonly overscroll?: boolean
  /** Measure the page again when it resizes. Default true. */
  readonly autoResize?: boolean
  /** Smooth scroll to `#hash` links of the same page, with scroll options if an object. */
  readonly anchors?:
    | boolean
    | {
        /** Offset from the target, px. */
        readonly offset?: number
        /** Duration, s. */
        readonly duration?: number
        /** Smoothing per frame, 0 to 1. */
        readonly lerp?: number
        /** Jump instead of a smooth scroll. */
        readonly immediate?: boolean
        /** Ignore input until it arrives. */
        readonly lock?: boolean
      }
  /** Stop while <html> has `overflow: hidden` or `clip`, start when it scrolls again. */
  readonly autoToggle?: boolean
  /** Let nested scroll areas scroll natively. Default false. */
  readonly allowNestedScroll?: boolean
  /** Measure with scrollHeight on every read. Default false. */
  readonly naiveDimensions?: boolean
  /** Stop the inertia when a link to another page is clicked. Default false. */
  readonly stopInertiaOnNavigate?: boolean
  /** Under reduced motion follow the input 1:1. Default true. */
  readonly respectReducedMotion?: boolean
}

/** Options of the Astro integration. */
export interface DioramaAstroOptions extends DioramaPluginOptions {
  /**
   * Smooth scroll with Lenis on every page: `true` or Lenis options. The site installs `lenis`.
   * The app of `start()` drives it, and it keeps the scroll ClientRouter sets on a page change.
   */
  readonly lenis?: boolean | AstroLenisOptions
  /**
   * Which ClientRouter links land where the reader left the page instead of at the top.
   * 'history' (default), as browsers do: only Back and Forward. 'parents': also links up the
   * address, to `/` from anywhere or to `/work` from `/work/aurora`, so a list opens where it was
   * left while a project opened from it starts at the top. 'visited': links to any page seen
   * earlier in the tab. A link with a #hash still goes to its anchor.
   */
  readonly restoreScroll?: 'history' | ScrollRestore
}

/** What `astro:config:setup` gives the integration. */
export interface AstroSetupParams {
  /** The site's config; `root` is where `lenis` is looked up. */
  readonly config: { readonly root: URL }
  /** Adds the Vite plugin. */
  updateConfig(config: { vite: { plugins: unknown[] } }): unknown
  /** Puts the page script (Lenis, scroll restoring) and lenis.css on every page. */
  injectScript(stage: 'page' | 'page-ssr', content: string): void
}

/** The part of an Astro integration the plugin returns. */
export interface AstroIntegrationLike {
  /** Integration name, 'diorama'. */
  readonly name: string
  /** Adds the Vite plugin in `astro:config:setup`, and the page script with `lenis` or `restoreScroll`. */
  readonly hooks: {
    readonly 'astro:config:setup': (params: AstroSetupParams) => void
  }
}

const fail = (message: string, option = 'lenis'): never => {
  throw new Error(`[diorama] diorama({ ${option} }) in astro.config: ${message}`)
}

/** Options go into the page as JSON, which would drop functions and elements without a word. */
function plain(value: unknown, path: string): void {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) plain(item, `${path}.${key}`)
    return
  }
  fail(
    `${path} cannot be written into the page. Pass functions to smoothScroll() from diorama/astro/client in a layout script instead`,
  )
}

/**
 * The script with Lenis is bundled into the site, so the site must have it. Looked up the way
 * Vite does, in node_modules up from the root: `require` would also take NODE_PATH, which pnpm
 * bin shims point at packages the site never installed.
 */
function requireLenis(root: URL): void {
  for (let dir = fileURLToPath(root), up = ''; dir !== up; up = dir, dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules/lenis/package.json'))) return
  }
  fail('the lenis package is not installed. Run `npm install lenis`')
}

/** The Astro integration: the Vite plugin for the effects folder, Lenis and scroll on request. */
export function diorama(options: DioramaAstroOptions = {}): AstroIntegrationLike {
  const { lenis, restoreScroll = 'history', ...plugin } = options
  const lenisOptions = lenis === true ? {} : lenis || undefined
  if (lenisOptions) plain(lenisOptions, 'lenis')
  if (!['history', 'parents', 'visited'].includes(restoreScroll)) {
    const value = JSON.stringify(restoreScroll)
    fail(`use 'history', 'parents' or 'visited', not ${value}`, 'restoreScroll')
  }
  const restore = restoreScroll !== 'history'
  return {
    name: 'diorama',
    hooks: {
      'astro:config:setup': ({ config, updateConfig, injectScript }) => {
        updateConfig({ vite: { plugins: [vite(plugin)] } })
        if (lenisOptions) {
          requireLenis(config.root)
          injectScript('page-ssr', "import 'lenis/dist/lenis.css'")
        }
        if (!lenisOptions && !restore) return
        const names = [restore && 'restoreScroll', lenisOptions && 'smoothScroll']
        injectScript(
          'page',
          [
            lenisOptions && "import Lenis from 'lenis'",
            `import { ${names.filter(Boolean).join(', ')} } from '@dioramajs/diorama/astro/client'`,
            restore && `restoreScroll('${restoreScroll}')`,
            lenisOptions && `smoothScroll(Lenis, ${JSON.stringify(lenisOptions)})`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
      },
    },
  }
}

export default diorama
