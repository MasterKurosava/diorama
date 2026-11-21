import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, entering, inView, rng } from '@dioramajs/effects/kit'
import {
  attribute,
  float,
  floor,
  max,
  min,
  mod,
  positionGeometry,
  select,
  sRGBTransferEOTF,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { fontAt, type Sheet, sampler, sheet } from './glyphs'
import { fonts, type Raster, raster, unsupported } from './raster'

type Trigger = 'view' | 'scroll' | 'hover'
type Motion = 'decode' | 'random' | 'glitch'
type Params = {
  motion: ChoiceParam<Motion>
  by: ChoiceParam<'letter' | 'word'>
  trigger: ChoiceParam<Trigger>
  chars: string
  duration: number
  stagger: number
  delay: number
  cycle: number
  threshold: number
  seed: number
}

/** Glyph sets by name; any other value of `chars` is the set itself. */
export const CHARSETS: Readonly<Record<string, string>> = {
  mixed: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=?@<>/[]{}',
  latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  hex: '0123456789ABCDEF',
  binary: '01',
  symbols: '!#$%&*+-/<=>?@[]^_{|}~',
}
/** Most glyphs of a custom set. */
const MAX_GLYPHS = 256
/** Letters further apart than this share of an em start a new word. */
const WORD_GAP = 0.12

// Instance attributes: the letter's box; its baseline, font size, turn and how much a random
// glyph is narrowed; the glyph it shows and that glyph's jitter in em.
const BOX = 'glyphBox'
const UNIT = 'glyphUnit'
const PICK = 'glyphPick'

/** Colour fringes of the glitch, linear. */
const RED = vec3(1, 0.03, 0.2)
const CYAN = vec3(0, 0.8, 1)

/** Milliseconds after a change of the text, its width or the fonts before it is laid out again. */
const RELAYOUT_DELAY = 150
/** Once the text is shown as DOM, the new layout waits for an idle moment, at most this long. */
const IDLE_TIMEOUT = 1000

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Letters arrive as random glyphs that cycle a few times and then settle into the real text, in
 * reading order, in a random order or with a glitch. At rest the element is plain DOM text.
 */
const scramble: Effect<Params> = defineEffect({
  name: 'scramble',
  params: {
    motion: oneOf('decode', 'random', 'glitch'),
    by: oneOf('letter', 'word'),
    trigger: oneOf('view', 'scroll', 'hover'),
    chars: 'mixed',
    duration: 0.6,
    stagger: 0.03,
    delay: 0,
    cycle: 0.06,
    threshold: 0.2,
    seed: 1,
  },
  rebuild: ['seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, app, signal } = ctx
    const { stage } = app
    const trigger = params.trigger
    const onScreen = (): boolean => {
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < stage.height.peek() &&
        rect.left < stage.width.peek()
      )
    }
    // As in text-reveal: text the visitor has seen as DOM stays; veiled text has not been seen.
    // A hovered label starts as DOM text.
    const veiled = (): boolean =>
      trigger === 'view' && element.getAttribute('data-dio-state') === 'entering'
    let seen = trigger === 'hover' || (onScreen() && !veiled())
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const ratio = ctx.quality === 'low' ? 1 : 2
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()
    const fallback = (why: string): void => {
      if (DEV) app.log.warn(`scramble: ${why}, the text stays as it is`, element)
      ctx.showDom(true)
    }
    if (layout?.by !== 'letter') {
      if (reason) fallback(`${reason} cannot be drawn`)
      else if (layout) fallback('more than 1500 letters')
      else ctx.showDom(true)
      return
    }

    const glyphs = charset(params.chars)
    const drawSheet = async (drawn: Raster): Promise<Sheet | undefined> => {
      const style = getComputedStyle(element)
      const em = Math.max(...drawn.quads.map((q) => q.em), 1)
      await document.fonts?.load?.(fontAt(style, em), glyphs.join('')).catch(() => [])
      return sheet(element, glyphs, em, ratio)
    }
    let glyphSheet = await drawSheet(layout)
    if (signal.aborted) return
    if (!glyphSheet) {
      ctx.showDom(true)
      return
    }

    const motion = params.motion
    const glitch = motion === 'glitch'
    const keysOf = (drawn: Raster): number[] => turns(drawn, params.by, motion, params.seed)
    let keys = keysOf(layout)
    const unitCount = (): number => Math.max(0, ...keys) + 1

    const { group, letterMesh, glyphMesh, letterMap, glyphMap, time, end, frame, cell, grid } =
      scrambleMeshes(ctx, layout, glyphSheet, keys)
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()

    // The glyph of each letter changes every `cycle` seconds, each on its own beat.
    let picked = Number.NaN
    const choose = (at: number): void => {
      if (at === picked) return
      picked = at
      const pick = letterMesh.geometry.getAttribute(PICK) as InstancedBufferAttribute
      const values = pick.array as Float32Array
      const count = glyphSheet?.count ?? 1
      const beat = Math.max(ctx.params.cycle, 0.01)
      const seed = params.seed | 0
      for (let i = 0; i < letterMesh.geometry.instanceCount; i++) {
        const offset = (mix(i, -1, seed) % 1000) / 1000
        const step = Math.floor(Math.max(0, at) / beat + offset)
        const hash = mix(i, step, seed)
        values[i * 3] = hash % count
        values[i * 3 + 1] = glitch ? (((hash >>> 8) & 255) / 255 - 0.5) * 0.12 : 0
        values[i * 3 + 2] = glitch ? (((hash >>> 16) & 255) / 255 - 0.5) * 0.06 : 0
      }
      pick.needsUpdate = true
    }

    const use = (next: Raster, nextSheet: Sheet): void => {
      keys = keysOf(next)
      const old = letterMesh.geometry
      const geometry = shape(next, keys, nextSheet)
      letterMesh.geometry = geometry
      glyphMesh.geometry = geometry
      old.dispose()
      letterMap.set(next.canvas)
      glyphMap.set(nextSheet.canvas)
      frame.value.set(...next.frame)
      cell.value.set(...nextSheet.cell)
      grid.value.set(nextSheet.cols, nextSheet.canvas.width, nextSheet.canvas.height)
      layout = next
      glyphSheet = nextSheet
      picked = Number.NaN
    }

    let dom = false
    const show = (value: boolean): void => {
      dom = value
      ctx.showDom(value)
    }
    const total = (): number => span(ctx.params, unitCount())
    time.value = seen ? total() : -1
    end.value = total()
    if (seen) show(true)

    // Raster again when the text, its fonts or its width change, like text-reveal.
    const relayout = async (): Promise<void> => {
      // Text that cannot be drawn like the DOM keeps the last raster for its next play.
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'letter', ratio)
      if (next?.by !== 'letter') return
      const nextSheet = await drawSheet(next)
      if (!nextSheet || signal.aborted) return
      use(next, nextSheet)
      end.value = total()
      ctx.invalidate()
    }
    let cancel: (() => void) | undefined
    const run = (): void => {
      cancel = undefined
      void relayout()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: IDLE_TIMEOUT })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(run, RELAYOUT_DELAY)
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

    // Seconds since the trigger, -1 before it (and between hovers).
    let elapsed = -1
    // The hover started this frame: it counts no time yet.
    let fresh = false
    let playing = false
    if (trigger === 'hover') {
      const play = (): void => {
        if (elapsed >= 0) return
        elapsed = 0
        fresh = true
        playing = true
        ctx.invalidate()
      }
      element.addEventListener(
        'pointerenter',
        (e) => (e as PointerEvent).pointerType !== 'touch' && play(),
        { signal },
      )
      element.addEventListener('focusin', play, { signal })
    }
    return (input): boolean => {
      const { y, height, progress, presence } = input
      const live = ctx.params
      const last = total()
      const viewport = stage.height.peek()
      let playhead: number
      if (trigger === 'scroll') {
        const through = entering(progress, height, viewport, live.threshold)
        if (seen && through < 1) playhead = last
        else {
          seen = false
          playhead = live.delay + through * (last - live.delay)
        }
      } else if (trigger === 'hover') {
        if (elapsed >= 0) {
          if (fresh) fresh = false
          else elapsed += input.delta
          if (elapsed >= last) {
            elapsed = -1
            playing = false
          }
        }
        playhead = elapsed >= 0 ? elapsed : last
      } else {
        if (!seen && elapsed < 0) {
          // Counted above the bottom tenth of the viewport, like `reveal`.
          if (inView(y, height, viewport, live.threshold)) {
            elapsed = 0
            playing = true
          }
        } else if (elapsed >= 0 && elapsed < last) elapsed += input.delta
        playhead = seen ? last : elapsed < 0 ? -1 : elapsed
        if (playhead >= last) playing = false
      }
      time.value = Math.min(playhead, last)
      end.value = last
      // The shader's clock: a page transition plays it through presence.
      choose(Math.min(time.value, presence * last))
      show(playhead >= last && presence >= 1)
      return playing
    }
  },
})
export default scramble

/**
 * Two meshes on one geometry: the real letters from the raster, shown before their turn
 * (hover) and once settled, and the random glyphs from the sheet while they cycle.
 */
function scrambleMeshes(
  ctx: EffectContext<Params>,
  layout: Raster,
  glyphSheet: Sheet,
  keys: readonly number[],
) {
  const { u, params } = ctx
  const motion = params.motion
  const glitch = motion === 'glitch'
  const trigger = params.trigger
  // Time since the trigger in seconds, the end, and 1 when letters show before their turn.
  const time = uniform(-1)
  const end = uniform(1)
  const before = uniform(trigger === 'hover' ? 1 : 0)
  const frame = uniform(new Vector4(...layout.frame))
  const cell = uniform(new Vector4(...glyphSheet.cell))
  // Columns of the sheet, and its size in px.
  const grid = uniform(
    new Vector3(glyphSheet.cols, glyphSheet.canvas.width, glyphSheet.canvas.height),
  )
  const box = attribute(BOX, 'vec4') as unknown as Node<'vec4'>
  const unit = attribute(UNIT, 'vec4') as unknown as Node<'vec4'>
  const pick = attribute(PICK, 'vec3') as unknown as Node<'vec3'>
  const baseline = unit.x
  const em = unit.y
  const key = unit.z
  const narrow = unit.w
  // Leaving runs time back from the end: settled letters scramble again and go.
  const now = min(time, u.presence.mul(end))
  const start = motion === 'random' ? (u.delay as Node<'float'>) : u.delay.add(key.mul(u.stagger))
  const settle =
    motion === 'random'
      ? u.delay.add(max(u.duration, 1e-3)).add(key.mul(u.stagger))
      : start.add(max(u.duration, 1e-3))
  const settled = select(now.greaterThanEqual(settle), 1, 0) as unknown as Node<'float'>
  const started = select(now.greaterThan(start), 1, 0) as unknown as Node<'float'>
  const real = max(settled, before.mul(started.oneMinus()))
  const cycling = started.mul(settled.oneMinus())
  const corner = positionGeometry.xy.add(0.5)
  const half = u.size.mul(0.5)
  const mask = (x: Node<'float'>, y: Node<'float'>): Node<'float'> =>
    ctx.mask(varying(vec2(x.div(u.size.x), y.div(u.size.y).oneMinus())).clamp(0, 1))
  const material = (): MeshBasicNodeMaterial =>
    new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })

  // The real letters, from the raster of the text.
  const letterMap = sampler(layout.canvas)
  const letterX = box.x.add(corner.x.mul(box.z))
  const letterY = box.y.add(corner.y.oneMinus().mul(box.w))
  const letters = material()
  letters.positionNode = vec3(letterX.sub(half.x), half.y.sub(letterY), 0)
  const letterUV = varying(
    vec2(letterX.sub(frame.x).div(frame.z), letterY.sub(frame.y).div(frame.w).oneMinus()),
  )
  // A settled letter keeps the split for a fifth of a second, fading.
  const afterglow = varying(
    glitch
      ? max(float(0.2).sub(now.sub(settle)), 0)
          .mul(5)
          .mul(settled)
      : float(0),
  )
  const letter = ink(
    letterMap.read,
    letterUV,
    glitch ? (afterglow.mul(em).mul(0.08).div(frame.z) as Node<'float'>) : undefined,
  )
  letters.colorNode = vec4(letter.rgb, letter.a.mul(varying(real)).mul(mask(letterX, letterY)))

  // The random glyphs, from the glyph sheet, centred on the letter's box at its baseline.
  const glyphMap = sampler(glyphSheet.canvas)
  // Box px per sheet px at this letter's size.
  const toBox = em.div(cell.w)
  const slotWidth = cell.x.mul(toBox).mul(narrow)
  const slotHeight = cell.y.mul(toBox)
  const glyphX = box.x
    .add(box.z.mul(0.5))
    .sub(slotWidth.mul(0.5))
    .add(corner.x.mul(slotWidth))
    .add(pick.y.mul(em))
  const glyphY = baseline
    .sub(cell.z.mul(toBox))
    .add(corner.y.oneMinus().mul(slotHeight))
    .add(pick.z.mul(em))
  const column = mod(pick.x, grid.x)
  const row = floor(pick.x.div(grid.x))
  const glyphUV = varying(
    vec2(
      column.add(corner.x).mul(cell.x).div(grid.y),
      row.add(corner.y.oneMinus()).mul(cell.y).div(grid.z).oneMinus(),
    ),
  )
  const randoms = material()
  randoms.positionNode = vec3(glyphX.sub(half.x), half.y.sub(glyphY), 0)
  const glyph = ink(
    glyphMap.read,
    glyphUV,
    glitch ? (cell.w.mul(0.07).div(grid.y) as Node<'float'>) : undefined,
  )
  randoms.colorNode = vec4(glyph.rgb, glyph.a.mul(varying(cycling)).mul(mask(glyphX, glyphY)))

  const group = new Group()
  const geometry = shape(layout, keys, glyphSheet)
  const letterMesh = new Mesh(geometry, letters)
  const glyphMesh = new Mesh(geometry, randoms)
  for (const mesh of [letterMesh, glyphMesh]) {
    mesh.frustumCulled = false
    group.add(mesh)
  }
  glyphMesh.renderOrder = 1
  ctx.onDispose(() => {
    letterMap.dispose()
    glyphMap.dispose()
  })
  return { group, letterMesh, glyphMesh, letterMap, glyphMap, time, end, frame, cell, grid }
}

/** The glyphs of `chars`: a named set, or the distinct visible graphemes of the string. */
export function charset(chars: string): string[] {
  const named = CHARSETS[chars.trim()]
  if (named) return [...named]
  const out = new Set<string>()
  for (const { segment } of graphemes.segment(chars)) {
    if (!/^\s+$/.test(segment)) out.add(segment)
    if (out.size >= MAX_GLYPHS) break
  }
  return out.size ? [...out] : [...(CHARSETS.mixed as string)]
}

/** A 32-bit integer hash of three numbers, the same on every load. */
function mix(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ c
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return h >>> 0
}

/** Units of the letters in reading order: letters with no gap between them form a word. */
function words(layout: Raster): number[] {
  const out: number[] = []
  let word = -1
  let previous: Raster['quads'][number] | undefined
  for (const q of layout.quads) {
    const gap = previous
      ? Math.max(q.x - (previous.x + previous.width), previous.x - (q.x + q.width))
      : Number.POSITIVE_INFINITY
    if (!previous || Math.abs(q.y - previous.y) > 0.5 || gap > q.em * WORD_GAP) word++
    out.push(word)
    previous = q
  }
  return out
}

/** The turn of each letter: its unit in reading order, or the unit's shuffled rank for random. */
function turns(layout: Raster, by: 'letter' | 'word', motion: Motion, seed: number): number[] {
  const units = by === 'word' ? words(layout) : layout.quads.map((_, i) => i)
  if (motion !== 'random') return units
  const count = (units.at(-1) ?? -1) + 1
  const rank = Array.from({ length: count }, (_, i) => i)
  const random = rng(seed)
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[rank[i], rank[j]] = [rank[j] as number, rank[i] as number]
  }
  return units.map((unit) => rank[unit] as number)
}

/** Seconds from the trigger until the last unit has settled. */
function span(
  timing: { readonly duration: number; readonly stagger: number; readonly delay: number },
  units: number,
): number {
  return timing.delay + Math.max(0, units - 1) * timing.stagger + Math.max(timing.duration, 1e-3)
}

/**
 * Premultiplied sample, un-premultiplied to linear. With `split`, two more samples beside it give
 * red and cyan fringes.
 */
function ink(
  sample: (uv: Node<'vec2'>) => Node<'vec4'>,
  at: Node<'vec2'>,
  split?: Node<'float'>,
): { rgb: Node<'vec3'>; a: Node<'float'> } {
  const texel = sample(at)
  const rgb = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as Node<'vec3'>
  if (!split) return { rgb, a: texel.a }
  const leftAlpha = sample(at.sub(vec2(split, 0))).a
  const rightAlpha = sample(at.add(vec2(split, 0))).a
  const alpha = max(texel.a, max(leftAlpha, rightAlpha))
  const fringed = rgb
    .mul(texel.a)
    .add(RED.mul(max(leftAlpha.sub(texel.a), 0)))
    .add(CYAN.mul(max(rightAlpha.sub(texel.a), 0)))
    .div(max(alpha, 1e-4))
  return { rgb: fringed as Node<'vec3'>, a: alpha }
}

/**
 * One instance per letter: its box, its baseline, size, turn and how much a random glyph is
 * narrowed to its slot, and the glyph it shows.
 */
function shape(
  layout: Raster,
  keys: readonly number[],
  glyphSheet: Sheet,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  const count = Math.max(1, layout.quads.length)
  const box = new Float32Array(count * 4)
  const unit = new Float32Array(count * 4)
  layout.quads.forEach((q, i) => {
    box.set([q.x, q.y, q.width, q.height], i * 4)
    // A glyph of average width fits a slot a little wider than the letter, at most half as narrow.
    const mean = (glyphSheet.mean * q.em) / glyphSheet.cell[3]
    const narrow = Math.min(1, Math.max(0.5, (q.width * 1.2) / Math.max(mean, 1e-3)))
    unit.set([q.base, q.em, keys[i] ?? 0, narrow], i * 4)
  })
  geometry.setAttribute(BOX, new InstancedBufferAttribute(box, 4))
  geometry.setAttribute(UNIT, new InstancedBufferAttribute(unit, 4))
  geometry.setAttribute(PICK, new InstancedBufferAttribute(new Float32Array(count * 3), 3))
  geometry.instanceCount = layout.quads.length
  return geometry
}
