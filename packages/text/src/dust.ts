import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { approach, DEV } from '@dioramajs/effects/kit'
import { floor, max, mix, step, texture, uniform, vec2 } from 'three/tsl'
import {
  DataTexture,
  Group,
  type InstancedBufferAttribute,
  Mesh,
  NearestFilter,
  NoColorSpace,
  type Node,
  Vector2,
  Vector4,
} from 'three/webgpu'
import {
  type Field,
  type Flight,
  field,
  grains,
  HOME,
  INK,
  letters,
  type Motion,
  pieces,
  RANDOM,
  shadows,
  sheet,
} from './dust-field'
import { emOf, instanced, pixels, TIER, valueNoise } from './points'
import { fonts, type Raster, raster, unsupported } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type Trigger = 'scroll' | 'click' | 'view'
type Params = {
  motion: ChoiceParam<Motion>
  trigger: ChoiceParam<Trigger>
  density: number
  dot: number
  duration: number
  angle: number
  turbulence: number
  depth: number
  shadow: number
  seed: number
}

/** Cell side of a grain at density 1, per px of font size, and its bounds in px. */
const STEP = { per: 0.02, min: 1.4, max: 2.2 } as const
/** Explode breaks the text into larger shards, rise into slightly larger flakes. */
const SHARD: Readonly<Record<Motion, number>> = { wind: 1, rise: 1.15, explode: 2.8 }

/** Cell side of a grain for text of this size, px: finer sand for smaller text. */
export const cellSide = (motion: Motion, em: number, density: number): number =>
  (Math.min(STEP.max, Math.max(STEP.min, em * STEP.per)) * SHARD[motion]) /
  Math.sqrt(Math.max(density, 0.05))
/** Most grains at the high tier. */
export const MAX_GRAINS = 20000
/** Share of the sweep one grain flies for, after it comes loose. */
const FLIGHT: Readonly<Record<Motion, number>> = { wind: 0.6, rise: 0.65, explode: 0.7 }
/** The latest a grain comes loose: an explosion lets every shard go nearly at once. */
const LAST: Readonly<Record<Motion, number>> = { wind: 1, rise: 1, explode: 0.3 }
/** Seconds of the fade that stands in for the dust under reduced motion. */
export const CALM = 0.4
/** The view trigger plays back this much faster when the heading returns. */
const BACK = 1.6
/** The scroll and view triggers start once the heading's top passes this share of the viewport. */
const LINE = 0.3
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before rastering again after a change, ms; while the DOM shows, up to this idle timeout. */
const REDO_DELAY = 150
const REDO_IDLE_TIMEOUT = 1000
/** When a cell comes loose is stored in 16 bits. */
const LOOSE_MAX = 65535

/** Elements a click turned to dust: they stay gone across rebuilds. */
const gone = new WeakSet<Element>()

/**
 * When each point of the text comes loose, 0..1: against `angle` from the side the wind blows
 * to, with a smooth noise so the edge is ragged, or out from the middle for `explode`.
 */
export function sweep(
  bounds: readonly [number, number, number, number],
  motion: Motion,
  angle: number,
  em: number,
  seed: number,
): (x: number, y: number) => number {
  const noise = valueNoise(seed + 13)
  const [x0, y0, x1, y1] = bounds
  const midX = (x0 + x1) / 2
  const midY = (y0 + y1) / 2
  const scale = 1 / Math.max(em * 0.7, 4)
  const rough = (x: number, y: number): number =>
    Math.min(1, Math.max(0, (noise(x * scale, y * scale) - 0.5) * 2.2 + 0.5))
  if (motion === 'explode') {
    const far = Math.hypot(x1 - midX, y1 - midY) || 1
    return (x, y) =>
      Math.min(LAST.explode, (Math.hypot(x - midX, y - midY) / far) * 0.24 + rough(x, y) * 0.06)
  }
  const radians = (angle * Math.PI) / 180
  const windX = Math.cos(radians)
  const windY = -Math.sin(radians)
  const cornersAlong = [
    x0 * windX + y0 * windY,
    x1 * windX + y0 * windY,
    x0 * windX + y1 * windY,
    x1 * windX + y1 * windY,
  ]
  const low = Math.min(...cornersAlong)
  const range = Math.max(...cornersAlong) - low || 1
  // Downwind first: the grains fly off over the empty page, never across the text that is left.
  return (x, y) =>
    Math.min(
      1,
      Math.max(0, ((low + range - x * windX - y * windY) / range) * 0.72 + rough(x, y) * 0.28),
    )
}

/** Typical travel of a grain for ink of this size, px. */
export function reachOf(motion: Motion, width: number, height: number, em: number): number {
  if (motion === 'rise') return Math.min(520, Math.max(90, height * 1.6, em * 2.6))
  if (motion === 'explode') return Math.min(640, Math.max(100, width * 0.35, em * 3.5))
  return Math.min(720, Math.max(100, width * 0.45, em * 3))
}

/**
 * The text turns to fine sand that the wind lifts off the page and carries away in depth, that
 * rises like ash or that bursts into shards: scrubbed as the heading leaves the top of the
 * viewport, once when it scrolls out, or on a click, for a message the visitor dismisses.
 */
const dust: Effect<Params> = defineEffect({
  name: 'dust',
  params: {
    motion: oneOf('wind', 'rise', 'explode'),
    trigger: oneOf('scroll', 'click', 'view'),
    density: 1,
    dot: 1.6,
    duration: 2.2,
    angle: 15,
    turbulence: 1,
    depth: 1,
    shadow: 0.5,
    seed: 1,
  },
  rebuild: ['density', 'seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  // The grains drift far past the box.
  bleed: 600,
  quality: { low: { density: 0.6, shadow: 0 } },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const { trigger, motion } = params
    const warn = (reason: string): void => {
      if (DEV) app.log.warn(`dust: ${reason}, the text stays as it is`, element)
    }
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    const cap = Math.round(MAX_GRAINS * TIER[ctx.quality])
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    const pick = (source: Raster): Field =>
      field(source, pixels(source), {
        cell: cellSide(motion, emOf(source), params.density),
        max: cap,
        seed: params.seed,
      })
    let grid = layout ? pick(layout) : undefined
    if (!layout || !grid?.count) {
      if (reason) warn(`${reason} cannot be drawn`)
      ctx.showDom(true)
      return
    }

    const span = FLIGHT[motion]
    // How far the sweep has gone, 0..1; a page that leaves sweeps it too.
    const amount = uniform(0)
    // 1 under reduced motion: the glyphs fade and no grain moves.
    const calm = uniform(0)
    const way = uniform(new Vector2(1, 0))
    const middle = uniform(new Vector2())
    const reach = uniform(200)
    const em = uniform(16)
    const cell = uniform(grid.cell)
    // Columns and rows of the grid, for the texture of when each cell comes loose.
    const dims = uniform(new Vector2(1, 1))
    const frame = uniform(new Vector4(...layout.frame))
    const half = u.size.mul(0.5) as unknown as V2
    const mask = (uv: V2): F => ctx.mask(uv)
    const swept = max(amount, u.presence.oneMinus())
    const front = swept.mul(LAST[motion] + span) as F

    // When each cell comes loose, 16 bits in red and green, read by the glyphs.
    let map = new DataTexture(new Uint8Array(4), 1, 1)
    const reads: { value: unknown }[] = []
    const bake = (source: Raster, cells: Field, angle: number): void => {
      const size = emOf(source)
      const looseAt = sweep(cells.bounds, motion, angle, size, params.seed)
      const data = new Uint8Array(cells.cols * cells.rows * 4)
      for (let i = 0; i < cells.count; i++) {
        const x = cells.home[i * 4] as number
        const y = cells.home[i * 4 + 1] as number
        // A grainy edge: each cell a little before or after its neighbours.
        const jitter = ((cells.ink[i * 4 + 3] as number) - 0.5) * 0.04
        const quantised = Math.round(Math.min(1, Math.max(0, looseAt(x, y) + jitter)) * LOOSE_MAX)
        cells.home[i * 4 + 2] = quantised / LOOSE_MAX
        const texel = (cells.index[i] as number) * 4
        data[texel] = quantised >> 8
        data[texel + 1] = quantised & 255
        data[texel + 3] = 255
      }
      const next = new DataTexture(data, cells.cols, cells.rows)
      next.magFilter = next.minFilter = NearestFilter
      next.generateMipmaps = false
      next.colorSpace = NoColorSpace
      next.needsUpdate = true
      const old = map
      map = next
      for (const read of reads) read.value = next
      old.dispose()
      const [x0, y0, x1, y1] = cells.bounds
      middle.value.set((x0 + x1) / 2, (y0 + y1) / 2)
      cell.value = cells.cell
      dims.value.set(cells.cols, cells.rows)
      em.value = size
      reach.value = reachOf(motion, x1 - x0, y1 - y0, size)
    }
    let angle = params.angle
    bake(layout, grid, angle)
    ctx.onDispose(() => map.dispose())

    const glyphMap = sheet(layout.canvas)
    ctx.onDispose(() => glyphMap.dispose())
    const glyphLayer = letters(
      layout,
      glyphMap.read,
      half,
      frame as unknown as Node<'vec4'>,
      (point) => {
        const col = floor(point.x.sub(frame.x).div(cell))
        const row = floor(point.y.sub(frame.y).div(cell))
        const looseRead = texture(map, vec2(col.add(0.5).div(dims.x), row.add(0.5).div(dims.y)))
        reads.push(looseRead as unknown as { value: unknown })
        const texel = looseRead as unknown as Node<'vec4'>
        const looseAt = texel.x
          .mul(255 * 256)
          .add(texel.y.mul(255))
          .div(LOOSE_MAX)
        // Each cell leaves the glyphs as its grain comes loose.
        return mix(step(front, looseAt), swept.oneMinus(), calm) as F
      },
      mask,
    )

    const flight: Flight = {
      motion,
      front,
      span,
      way: way as unknown as V2,
      middle: middle as unknown as V2,
      reach: reach as unknown as F,
      em: em as unknown as F,
      cell: cell as unknown as F,
      dot: u.dot as unknown as F,
      turbulence: u.turbulence as unknown as F,
      depth: u.depth as unknown as F,
      shadow: u.shadow as unknown as F,
      calm: calm as unknown as F,
      half,
      frame: frame as unknown as Node<'vec4'>,
      seed: params.seed,
    }
    const build = (cells: Field): ReturnType<typeof instanced> =>
      instanced(cells.count, {
        [HOME]: [cells.home, 4],
        [INK]: [cells.ink, 4],
        [RANDOM]: [cells.random, 4],
      })
    let shape = build(grid)
    const dots = new Mesh(shape, grains(flight, glyphMap.read, mask))
    const shade = new Mesh(shape, shadows(flight, mask))
    for (const mesh of [shade, dots]) mesh.frustumCulled = false
    // Shadows fall on the page under the text that is left, never over it.
    glyphLayer.renderOrder = 1
    dots.renderOrder = 2
    const group = new Group()
    group.add(glyphLayer, shade, dots)
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    const use = (next: Raster, cells: Field): void => {
      layout = next
      grid = cells
      bake(next, cells, angle)
      const old = shape
      shape = build(cells)
      dots.geometry = shade.geometry = shape
      old.dispose()
      const glyphShape = glyphLayer.geometry
      glyphLayer.geometry = pieces(next)
      glyphShape.dispose()
      glyphMap.set(next.canvas)
      frame.value.set(...next.frame)
    }

    let dom = true
    const show = (value: boolean): void => {
      dom = value
      ctx.showDom(value)
    }
    let done = gone.has(element)
    // Gone for good: the copy stays drawn and empty, so the text stays hidden.
    const empty = (value: boolean): void => {
      group.visible = !value
    }
    empty(done)
    show(!done)

    let cancel: (() => void) | undefined
    let stuck: string | undefined
    const redo = async (): Promise<void> => {
      cancel = undefined
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(`${why} cannot be drawn`)
      stuck = why
      if (why) {
        ctx.invalidate()
        return
      }
      const next = raster(element, 'line', ratio)
      const cells = next && pick(next)
      if (!next || !cells?.count) return
      use(next, cells)
      ctx.invalidate()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(() => void redo(), { timeout: REDO_IDLE_TIMEOUT })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(() => void redo(), REDO_DELAY)
        cancel = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => cancel?.())
    const text = new MutationObserver(schedule)
    text.observe(element, { characterData: true, childList: true, subtree: true })
    ctx.onDispose(() => text.disconnect())
    const resize = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width
      if (Math.abs(width - (layout?.width ?? width)) > 0.5) schedule()
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // The time-driven sweep of the click and view triggers: where it is and where it goes.
    let progress = done ? 1 : 0
    let target = progress
    // The sweep plays in time, so the update asks for frames.
    let playing = false
    const start = (): void => {
      if (done || target === 1) return
      target = 1
      element.setAttribute('data-dio-dust', 'playing')
      playing = true
      ctx.invalidate()
    }
    if (trigger === 'click') {
      element.addEventListener('click', start, { signal })
      element.addEventListener(
        'keydown',
        (e) => {
          const key = (e as KeyboardEvent).key
          // Buttons and links click on Enter themselves.
          if (key === 'Enter' && e.target === element && !element.matches('button, a[href]'))
            start()
        },
        { signal },
      )
    }

    return (input): boolean => {
      const p = ctx.params
      const reduced = input.reducedMotion
      calm.value = reduced ? 1 : 0
      // No shadow pass at all when shadows are off.
      shade.visible = p.shadow > 0
      if (stuck || (reduced && trigger !== 'click')) {
        show(true)
        return playing
      }
      if (p.angle !== angle && grid && layout) {
        angle = p.angle
        bake(layout, grid, angle)
        ;(shape.getAttribute(HOME) as InstancedBufferAttribute).needsUpdate = true
      }
      const radians = (angle * Math.PI) / 180
      way.value.set(Math.cos(radians), Math.sin(radians))
      const vh = stage.height.peek()
      // The scroll position of the sweep: from the heading's top at LINE of the viewport (or
      // where it sits on the first screen) until its middle reaches the top.
      const top = input.y + (typeof scrollY === 'number' ? scrollY : 0)
      const line = Math.max(0, Math.min(vh * LINE, top - 1))
      const scrolled = Math.min(1, Math.max(0, (line - input.y) / (line + input.height * 0.5 || 1)))
      if (trigger === 'view') {
        if (scrolled > 0.2) target = 1
        else if (scrolled <= 0) target = 0
        if (target !== progress) playing = true
      }
      if (trigger === 'scroll') progress = scrolled
      else if (progress !== target) {
        const seconds = reduced ? CALM : Math.max(p.duration, 1e-3) / (target < progress ? BACK : 1)
        progress = approach(progress, target, input.delta / seconds)
      } else playing = false
      amount.value = progress
      if (trigger === 'click' && progress >= 1 && !done) {
        done = true
        gone.add(element)
        playing = false
        element.setAttribute('data-dio-dust', 'done')
        element.dispatchEvent(new CustomEvent('dio:dust', { bubbles: true }))
      }
      empty(done)
      show(!done && progress <= 0 && input.presence >= 1)
      return playing
    }
  },
})
export default dust
