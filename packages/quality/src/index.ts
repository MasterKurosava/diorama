// The quality plugin: picks a tier from the GPU, lowers it when the browser misses
// frames while the site draws, bounds the pixel ratio and lets effects cap their params.
import { definePlugin, type Plugin, type ReadonlySignal, signal } from '@dioramajs/core'
import type { QualityTier } from '@dioramajs/effects'
import type {} from '@dioramajs/render'
import { Adapter } from './adapt'
import { device, type GpuInfo, gpuInfo, initialTier } from './detect'

export type { QualityTier } from '@dioramajs/effects'
export type { GpuClass, GpuInfo } from './detect'

/** Options of the `quality` plugin. */
export interface QualityOptions {
  /** 'auto' (default) detects and adapts. A tier pins it. */
  readonly tier: 'auto' | QualityTier
  /** Lower the tier when the browser misses frames while the site draws. Default true. */
  readonly adapt: boolean
  /** Keep the settled tier for the rest of the session (sessionStorage, keyed by GPU). Default true. */
  readonly remember: boolean
  /** Pixel ratio bound per tier. Default `{ low: 1, medium: 1.5, high: Infinity }`. */
  readonly pixelRatio: Readonly<Record<QualityTier, number>>
}

/** Why the tier is what it is. */
export type QualityReason = 'detected' | 'pinned' | 'slow' | 'remembered'

/** The `quality` service. */
export interface QualityApi {
  /** The tier now. Effects read it as `ctx.quality` and through their caps. */
  readonly tier: ReadonlySignal<QualityTier>
  /** Why the tier is what it is. */
  readonly reason: ReadonlySignal<QualityReason>
  /** The GPU the tier was detected for. */
  readonly gpu: GpuInfo
  /** Pins a tier, or 'auto' to detect and adapt again. */
  set(tier: QualityTier | 'auto'): void
  /** Counters for tests and devtools. */
  stats(): {
    /** Screen refresh rate in Hz, 0 until measured. */
    readonly refresh: number
    /** Share of slow intervals in the current window. */
    readonly slowShare: number
    /** Steps down taken on this page load. */
    readonly steps: number
  }
}

declare module '@dioramajs/core' {
  interface Services {
    /** The quality tier, see `QualityApi`. */
    quality: QualityApi
  }
  interface Events {
    /** The quality tier changed. */
    'quality:tier': { readonly tier: QualityTier; readonly reason: QualityReason }
  }
}

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high']
const RATIOS: Readonly<Record<QualityTier, number>> = {
  low: 1,
  medium: 1.5,
  high: Number.POSITIVE_INFINITY,
}
const defaults: QualityOptions = { tier: 'auto', adapt: true, remember: true, pixelRatio: RATIOS }

/** Rendered in the last this many ms: the probe runs. */
const ACTIVE = 100
/** Quiet span after a compile, a resize, a page change or a wake, ms. */
const SETTLE = 500
/** Quiet span after a tier change, ms. */
const CHANGED = 1000
/** No decision for this long after a step, ms. */
const COOLDOWN = 3000
/** Steps down per page load. */
const MAX_STEPS = 2
const KEY = 'dio:quality'

const now = (): number => performance.now()

/** sessionStorage throws in some sandboxes and private modes. */
function stored(gpu: string): QualityTier | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
      gpu?: unknown
      tier?: QualityTier
    } | null
    return saved?.gpu === gpu && saved.tier && TIERS.includes(saved.tier) ? saved.tier : undefined
  } catch {
    return undefined
  }
}
function store(gpu: string, tier: QualityTier): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ gpu, tier }))
  } catch {
    // Not kept: the next page detects again.
  }
}

/**
 * Quality tiers for the effects runtime. Install it through effects `extend`, so it starts after
 * `render` and before the runtime:
 *
 *     effects({ extend: [() => import('@dioramajs/quality').then((m) => m.quality())] })
 *
 * `start()` does this unless `quality: false`.
 */
export const quality: Plugin<'quality', QualityOptions, QualityApi> = /*#__PURE__*/ definePlugin({
  name: 'quality',
  dependencies: ['render', 'stage'],
  defaults,
  setup(app, options): QualityApi {
    const { render } = app
    const ratios = { ...RATIOS, ...options.pixelRatio }
    const gpu = gpuInfo(render)
    const detected = initialTier(gpu, device())
    const remembered = options.remember ? stored(gpu.name) : undefined
    const pinned = options.tier !== 'auto'
    const tier = signal<QualityTier>(
      pinned ? (options.tier as QualityTier) : (remembered ?? detected),
    )
    const reason = signal<QualityReason>(pinned ? 'pinned' : remembered ? 'remembered' : 'detected')
    const adapter = new Adapter()
    let auto = !pinned
    let steps = 0
    let drawn = Number.NEGATIVE_INFINITY
    let raf = 0

    const before = render.maxPixelRatio.peek()
    render.maxPixelRatio.value = ratios[tier.peek()]
    app.onDispose(() => {
      if (raf) cancelAnimationFrame(raf)
      render.maxPixelRatio.value = before
    })

    const apply = (next: QualityTier, why: QualityReason): void => {
      reason.value = why
      if (auto && options.remember) store(gpu.name, next)
      if (next === tier.peek()) return
      tier.value = next
      render.maxPixelRatio.value = ratios[next]
      adapter.quiet(now() + CHANGED)
      app.emit('quality:tier', { tier: next, reason: why })
    }
    const adapting = (): boolean =>
      auto && options.adapt && steps < MAX_STEPS && tier.peek() !== 'low'
    const settle = (): void => adapter.quiet(now() + SETTLE)

    // Effects loading: setups, decodes, uploads and compiles stall frames once, they measure
    // nothing about the device. Their frames and the 0.5 s after the last are not counted.
    const loading = new Map<Element, Set<string>>()
    app.on('effects:status', ({ element, effect, status }) => {
      const names = loading.get(element)
      if (status === 'loading') loading.set(element, new Set(names).add(effect))
      else if (names?.delete(effect) && !names.size) loading.delete(element)
    })
    const probe = (at: number): void => {
      raf = 0
      if (loading.size) adapter.quiet(at + SETTLE)
      if (adapting() && adapter.frame(at)) {
        steps++
        apply(TIERS[TIERS.indexOf(tier.peek()) - 1] as QualityTier, 'slow')
        adapter.clear()
        adapter.quiet(at + COOLDOWN)
      }
      if (adapting() && now() - drawn <= ACTIVE) raf = requestAnimationFrame(probe)
      else adapter.stop()
    }
    app.system(
      'afterRender',
      (t) => {
        drawn = now()
        if (t.resumed) settle()
        if (!raf && adapting()) raf = requestAnimationFrame(probe)
      },
      { name: 'quality' },
    )
    app.on('effects:status', ({ status }) => {
      if (status === 'running') settle()
    })
    // Page transitions are optional, so their events are not typed here.
    for (const event of ['page:leave', 'page:enter']) app.on(event as never, settle)
    let sized = false
    app.effect(() => {
      app.stage.width.value
      app.stage.height.value
      if (sized) settle()
      sized = true
    })

    return {
      tier,
      reason,
      gpu,
      set(next) {
        if (next !== 'auto' && !TIERS.includes(next as QualityTier)) {
          app.log.warn(`quality.set: "${String(next)}" is not a tier`)
          return
        }
        steps = 0
        adapter.clear()
        auto = next === 'auto'
        if (next === 'auto') apply(initialTier(gpu, device()), 'detected')
        else apply(next, 'pinned')
      },
      stats: () => ({
        refresh: adapter.period ? 1000 / adapter.period : 0,
        slowShare: adapter.share,
        steps,
      }),
    }
  },
})
