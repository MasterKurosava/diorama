import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, inView, rng, roundedBox } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  cos,
  float,
  floor,
  max,
  min,
  mix,
  mod,
  positionGeometry,
  round,
  select,
  sin,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { fontAt, linear, type Sheet, sampler, sheet } from './glyphs'
import { fonts, type Raster, raster, unsupported } from './raster'

type Params = {
  style: ChoiceParam<'tiles' | 'plain'>
  motion: ChoiceParam<'drum' | 'random'>
  trigger: ChoiceParam<'view' | 'change'>
  chars: string
  duration: number
  flips: number
  stagger: number
  delay: number
  threshold: number
  tile: ColorParam
  gap: number
  shade: number
  seed: number
}

/** Drums by name, the blank first; any other value of `chars` is the drum itself. */
export const DRUMS: Readonly<Record<string, string>> = {
  board: ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:-/&',
  letters: ' ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: ' 0123456789',
  time: ' 0123456789:',
}

/** A character on the board: the faces it goes through and when it starts, clock seconds. */
interface Cell {
  seq: string[]
  start: number
}

// Instance attributes: the letter's slot; its baseline, font size and centre x; the glyph shown,
// its narrowing, the turn of the piece and which half it is.
const BOX = 'flapBox'
const UNIT = 'flapUnit'
const STATE = 'flapState'

/** Pieces per character: the top and bottom halves at rest, then the turning flap. */
const PIECES = 3
/** Glyph ids in the state attribute besides sheet indices. */
const BLANK = -1
const NOT_DRAWN = -2
/**
 * Milliseconds after a change of the text before the board flips: short, so a board that changes
 * every second (a clock, a countdown) flips at once.
 */
const CHANGE_DELAY = 30
/** Longest frame step, s: a stalled tab does not skip flaps. */
const MAX_STEP = 0.1

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The departure board: each character flips through the faces of a drum to its letter, when the
 * text comes into view and whenever the site changes it. The DOM text is the truth for screen
 * readers, search and copy; the flaps are drawn over it.
 */
const splitFlap: Effect<Params> = defineEffect({
  name: 'split-flap',
  params: {
    style: oneOf('tiles', 'plain'),
    motion: oneOf('drum', 'random'),
    trigger: oneOf('view', 'change'),
    chars: 'board',
    duration: 0.07,
    flips: 10,
    stagger: 0.03,
    delay: 0,
    threshold: 0.2,
    tile: Object.freeze({ '~kind': 'color', value: '#1c1c1f' }) as ColorParam,
    gap: 0.08,
    shade: 0.5,
    seed: 1,
  },
  rebuild: ['seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  reducedMotion: 'static',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, app, signal } = ctx
    const { stage } = app
    const kind = params.trigger
    const tiles = params.style === 'tiles'
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
    // As in scramble: text the visitor has seen as DOM stays; veiled text has not been seen.
    const veiled = (): boolean =>
      kind === 'view' && element.getAttribute('data-dio-state') === 'entering'
    let seen = kind === 'change' || (onScreen() && !veiled())
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const ratio = ctx.quality === 'low' ? 1 : 2
    const spacing = (): number => Number.parseFloat(getComputedStyle(element).letterSpacing) || 0
    const warn = (why: string): void => {
      if (DEV) app.log.warn(`split-flap: ${why}, the text stays as it is`, element)
    }
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()
    if (layout?.by !== 'letter') {
      if (reason) warn(`${reason} cannot be drawn`)
      else if (layout) warn('more than 1500 letters')
      ctx.showDom(true)
      return
    }

    // The glyph sheet holds the drum and every letter the text has shown.
    const faces = drum(params.chars)
    const glyphs: string[] = []
    const index = new Map<string, number>()
    /** Adds the glyphs not on the sheet yet; true if there were any. */
    const add = (list: Iterable<string>): boolean => {
      const before = glyphs.length
      for (const glyph of list)
        if (glyph.trim() && !index.has(glyph)) {
          index.set(glyph, glyphs.length)
          glyphs.push(glyph)
        }
      return glyphs.length > before
    }
    add(faces)
    add(layout.quads.map((q) => q.text))
    const drawSheet = async (drawn: Raster): Promise<Sheet | undefined> => {
      const em = Math.max(...drawn.quads.map((q) => q.em), 1)
      await document.fonts
        ?.load?.(fontAt(getComputedStyle(element), em), glyphs.join(''))
        .catch(() => [])
      return sheet(element, glyphs, em, ratio)
    }
    let glyphSheet = await drawSheet(layout)
    if (signal.aborted) return
    if (!glyphSheet) {
      ctx.showDom(true)
      return
    }

    const { material, glyphMap, cell, grid } = flapMaterial(ctx, glyphSheet, tiles)
    const mesh = new Mesh(shape(layout, spacing()), material)
    mesh.frustumCulled = false
    ctx.onDispose(() => glyphMap.dispose())
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()

    const random = rng(params.seed)
    // Seconds of flipping so far: flaps start and land on this clock.
    let clock = 0
    // A flip started this frame: the clock does not move yet.
    let fresh = false
    let triggered = seen
    // A flap is in motion, so the update asks for frames.
    let playing = false
    const targets = (drawn: Raster): string[] => drawn.quads.map((q) => q.text)
    let cells: Cell[] = targets(layout).map((text) => ({
      seq: [triggered ? text : ' '],
      start: 0,
    }))

    /** Faces of a cell now: the one shown, the next and the turn 0..1 (0 at rest). */
    const facesOf = (cell: Cell): [string, string, number] => {
      const last = cell.seq.length - 1
      const live = ctx.params
      const rest = cell.seq[last] as string
      if (last <= 0 || !(live.duration > 0)) return [rest, rest, 0]
      const steps = Math.max(0, (clock - cell.start) / live.duration)
      const step = Math.floor(steps)
      if (step >= last) return [rest, rest, 0]
      return [cell.seq[step] as string, cell.seq[step + 1] as string, steps - step]
    }
    /** Starts the flaps from what each cell shows to `next`; changed cells take turns. */
    const flipTo = (next: readonly string[], wait: number): void => {
      const live = ctx.params
      let turn = 0
      cells = next.map((to, i) => {
        const previous = cells[i]
        const from = previous ? (facesOf(previous)[0] as string) : ' '
        const seq = path(faces, from, to, live.flips, params.motion, random)
        const start = clock + wait + (seq.length > 1 ? turn++ : 0) * live.stagger
        return { seq, start }
      })
      fresh = true
      playing = true
      ctx.invalidate()
    }
    const trigger = (): void => {
      triggered = true
      flipTo(targets(layout as Raster), ctx.params.delay)
    }

    /** How much a glyph is narrowed to fit the tile of letter `i`. */
    const narrowOf = (glyph: string, drawn: Raster, i: number): number => {
      const quad = drawn.quads[i]
      const current = glyphSheet as Sheet
      const glyphIndex = index.get(glyph)
      if (!quad || glyphIndex === undefined) return 1
      const glyphWidth = ((current.widths[glyphIndex] ?? current.mean) * quad.em) / current.cell[3]
      const room = Math.max(quad.width - ctx.params.gap * quad.em, 1)
      return Math.min(1, Math.max(0.4, (room * 1.05) / Math.max(glyphWidth, 1e-3)))
    }
    /** Writes the state of every piece for the clock; true while a flap moves. */
    const write = (): boolean => {
      const drawn = layout as Raster
      const count = drawn.quads.length
      const stateAttribute = mesh.geometry.getAttribute(STATE) as InstancedBufferAttribute
      const values = stateAttribute.array as Float32Array
      let moving = false
      const set = (slot: number, glyph: string | undefined, angle: number, lower: number): void => {
        const id =
          glyph === undefined ? NOT_DRAWN : glyph.trim() ? (index.get(glyph) ?? BLANK) : BLANK
        const narrow = glyph === undefined ? 1 : narrowOf(glyph, drawn, slot % count)
        values.set([id, narrow, angle, lower], slot * 4)
      }
      for (let i = 0; i < count; i++) {
        const cell = cells[i] ?? { seq: [' '], start: 0 }
        const [shown, next, fraction] = facesOf(cell)
        // A landed cell keeps its face: a later flip must not wind it back into the drum.
        if (cell.seq.length > 1 && clock < cell.start + (cell.seq.length - 1) * ctx.params.duration)
          moving = true
        else cell.seq = [cell.seq[cell.seq.length - 1] as string]
        // Falls under its own weight: slow off the top, fast at the bottom.
        const turn = Math.PI * fraction * fraction
        const pastHalf = turn >= Math.PI / 2
        // Without tiles nothing hides what a flap passes over: a half shows only once uncovered.
        const turning = fraction > 0
        set(i, turning ? (tiles || pastHalf ? next : undefined) : shown, 0, 0)
        set(count + i, turning && !tiles && pastHalf ? undefined : shown, 0, 1)
        const flap = 2 * count + i
        if (!turning) set(flap, undefined, 0, 0)
        else if (!pastHalf) set(flap, shown, turn, 0)
        else set(flap, next, Math.PI - turn, 1)
      }
      stateAttribute.needsUpdate = true
      return moving
    }

    const use = async (next: Raster): Promise<void> => {
      if (add(next.quads.map((q) => q.text))) {
        const nextSheet = await drawSheet(next)
        if (!nextSheet || signal.aborted) return
        glyphSheet = nextSheet
        glyphMap.set(nextSheet.canvas)
        cell.value.set(...nextSheet.cell)
        grid.value.set(nextSheet.cols, nextSheet.canvas.width, nextSheet.canvas.height)
      }
      const old = mesh.geometry
      mesh.geometry = shape(next, spacing())
      old.dispose()
      layout = next
      if (triggered) flipTo(targets(next), 0)
      else cells = targets(next).map(() => ({ seq: [' '], start: 0 }))
      ctx.invalidate()
    }
    write()

    // Set while the text has changed to something the canvas cannot draw: it stays DOM until then.
    let stuck: string | undefined
    // Raster again shortly after the text, its width or the loaded fonts change.
    const relayout = async (): Promise<void> => {
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(`${why} cannot be drawn`)
      stuck = why
      const next = why ? undefined : raster(element, 'letter', ratio)
      if (next?.by === 'letter') await use(next)
      ctx.invalidate()
    }
    let cancel: (() => void) | undefined
    const schedule = (): void => {
      cancel?.()
      const id = setTimeout(() => {
        cancel = undefined
        void relayout()
      }, CHANGE_DELAY)
      cancel = () => clearTimeout(id)
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

    return (input): boolean => {
      if (stuck) {
        playing = false
        ctx.showDom(true)
        return false
      }
      const live = ctx.params
      if (!triggered && seen) {
        triggered = true
        cells = targets(layout as Raster).map((text) => ({ seq: [text], start: 0 }))
      } else if (!triggered) {
        // Counted above the bottom tenth of the viewport, like `reveal`.
        const { y, height } = input
        if (inView(y, height, stage.height.peek(), live.threshold)) trigger()
      }
      if (fresh) fresh = false
      else clock += Math.min(input.delta, MAX_STEP)
      // Reduced motion: every flap lands at once.
      if (input.reducedMotion)
        for (const cell of cells) cell.seq = [cell.seq[cell.seq.length - 1] as string]
      const moving = write()
      if (!moving) playing = false
      // Plain letters hand back to the DOM at rest; tiles stay drawn.
      ctx.showDom(!tiles && triggered && !moving && input.presence >= 1)
      return playing
    }
  },
})
export default splitFlap

/**
 * Every piece is a half tile or the turning flap, swung around the hinge, with its glyph
 * centred on the letter at its baseline and narrowed to fit.
 */
function flapMaterial(ctx: EffectContext<Params>, glyphSheet: Sheet, tiles: boolean) {
  const { u } = ctx
  const cell = uniform(new Vector4(...glyphSheet.cell))
  // Columns of the sheet, and its size in px.
  const grid = uniform(
    new Vector3(glyphSheet.cols, glyphSheet.canvas.width, glyphSheet.canvas.height),
  )
  const box = attribute(BOX, 'vec4') as unknown as Node<'vec4'>
  const unit = attribute(UNIT, 'vec4') as unknown as Node<'vec4'>
  // The glyph (-1 blank, -2 not drawn), its narrowing, the turn of the piece and its half.
  const state = attribute(STATE, 'vec4') as unknown as Node<'vec4'>
  const baseline = unit.x
  const em = unit.y
  const centreX = unit.z
  // The tile: one em and a fifth high around the middle of a capital, `gap` em between tiles.
  const inset = u.gap.mul(em).mul(0.5)
  const left = box.x.add(inset)
  const width = max(box.z.sub(inset.mul(2)), 1)
  const top = baseline.sub(em.mul(0.95))
  const height = em.mul(1.2)
  const hinge = top.add(height.mul(0.5))
  const corner = positionGeometry.xy.add(0.5)
  const lower = state.w
  const x = left.add(corner.x.mul(width))
  const y = top.add(lower.add(corner.y.oneMinus()).mul(height.mul(0.5)))
  const angle = state.z
  // Turned around the hinge, towards the viewer.
  const fromHinge = y.sub(hinge)
  const half = u.size.mul(0.5)
  const drawn = state.x.greaterThan(-1.5)
  const position = select(
    drawn,
    vec3(
      x.sub(half.x),
      half.y.sub(hinge.add(fromHinge.mul(cos(angle)))),
      abs(fromHinge).mul(sin(angle)),
    ),
    vec3(0, 0, 0),
  )
  const local = varying(vec2(x, y))
  // Masked down the middle of the letter: a slot reaches past the box by half the spacing,
  // where the mask's own edge would dim it.
  const boxUV = varying(vec2(centreX.div(u.size.x), y.div(u.size.y).oneMinus()))

  // The glyph, centred on the letter at its baseline, narrowed to fit the tile.
  const glyphMap = sampler(glyphSheet.canvas)
  const glyphId = varying(state.x)
  // Box px per sheet px at this letter's size.
  const toBox = em.div(cell.w)
  const glyphWidth = varying(cell.x.mul(toBox).mul(state.y))
  const glyphHeight = varying(cell.y.mul(toBox))
  const glyphLeft = varying(centreX.sub(cell.x.mul(toBox).mul(state.y).mul(0.5)))
  const glyphTop = varying(baseline.sub(cell.z.mul(toBox)))
  const glyphU = local.x.sub(glyphLeft).div(glyphWidth)
  const glyphV = local.y.sub(glyphTop).div(glyphHeight)
  // An interpolated 30 can arrive as 29.99997: floor would pick the cell before it.
  const id = round(max(glyphId, 0))
  const column = mod(id, grid.x)
  const row = floor(id.div(grid.x))
  const ink = linear(
    glyphMap.read(
      vec2(
        column.add(glyphU.clamp(0, 1)).mul(cell.x).div(grid.y),
        row.add(glyphV.clamp(0, 1)).mul(cell.y).div(grid.z).oneMinus(),
      ),
    ),
  )
  const inside = select(
    glyphId
      .greaterThan(-0.5)
      .and(glyphU.greaterThanEqual(0))
      .and(glyphU.lessThanEqual(1))
      .and(glyphV.greaterThanEqual(0))
      .and(glyphV.lessThanEqual(1)),
    1,
    0,
  ) as unknown as Node<'float'>
  const inkAlpha = ink.a.mul(inside)
  // A turning flap faces away from the light.
  const lit = sin(varying(angle)).mul(u.shade).mul(-0.55).add(1)
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  material.positionNode = position
  if (tiles) {
    // A rounded rectangle by its signed distance, px.
    const centre = varying(vec2(left.add(width.mul(0.5)), hinge))
    const halfSize = varying(vec2(width, height).mul(0.5))
    const radius = varying(min(em.mul(0.08), width.mul(0.3)))
    const distance = roundedBox(local.sub(centre), halfSize, radius)
    const tileAlpha = distance.negate().add(0.5).clamp(0, 1)
    // The slit at the hinge and a lighter upper half.
    const slit = abs(local.y.sub(varying(hinge)))
      .div(max(varying(em).mul(0.03), 0.75))
      .clamp(0, 1)
    const upper = select(local.y.lessThan(varying(hinge)), 1.06, 0.94)
    const face = u.tile.rgb
      .mul(mix(float(1), upper, u.shade))
      .mul(mix(float(1), slit.mul(0.7).add(0.3), u.shade))
    const rgb = mix(face, ink.rgb, inkAlpha).mul(lit)
    material.colorNode = vec4(rgb, tileAlpha.mul(ctx.mask(boxUV.clamp(0, 1))))
  } else {
    material.colorNode = vec4(ink.rgb.mul(lit), inkAlpha.mul(ctx.mask(boxUV.clamp(0, 1))))
  }
  return { material, glyphMap, cell, grid }
}

/** The characters a flap walks through in order, the blank first. */
export function drum(chars: string): string[] {
  const named = DRUMS[chars.trim()]
  const out = new Set<string>([' '])
  for (const { segment } of graphemes.segment(named ?? chars))
    if (!/^\s+$/.test(segment)) out.add(segment)
  return out.size > 1 ? [...out] : [...(DRUMS.board as string)]
}

/**
 * The faces a character shows on its way from `from` to `to`, both included: along the drum, the
 * last `flips` steps before the target, or `flips` random faces. One step when they are equal.
 */
export function path(
  drumFaces: readonly string[],
  from: string,
  to: string,
  flips: number,
  motion: 'drum' | 'random',
  random: () => number,
): string[] {
  if (from === to) return [to]
  const flipCount = Math.max(0, Math.round(flips))
  const size = drumFaces.length
  if (flipCount <= 1 || size < 2) return [from, to]
  const face = (i: number): string => drumFaces[((i % size) + size) % size] as string
  if (motion === 'random') {
    const between = Array.from({ length: flipCount - 1 }, () =>
      face(1 + Math.floor(random() * (size - 1))),
    )
    return [from, ...between, to]
  }
  const indexOf = (char: string): number => {
    const i = drumFaces.indexOf(char)
    return i >= 0 ? i : drumFaces.indexOf(char.toLocaleUpperCase())
  }
  const fromIndex = indexOf(from)
  const toIndex = indexOf(to)
  // Off the drum the flap walks on from where it is and drops the target in at the end.
  if (toIndex < 0) {
    const walk = Array.from({ length: flipCount - 1 }, (_, s) =>
      face(Math.max(fromIndex, 0) + 1 + s),
    )
    return [from, ...walk, to]
  }
  const ahead = fromIndex < 0 ? flipCount : (toIndex - fromIndex + size) % size || size
  const steps = Math.min(ahead, flipCount)
  return [from, ...Array.from({ length: steps - 1 }, (_, s) => face(toIndex - steps + 1 + s)), to]
}

/**
 * Three instances per letter (top half, bottom half, flap), the flaps after every half so they
 * draw over them: the letter's slot, and its baseline, size and centre. A glyph box ends with the
 * letter-spacing; the slot keeps the pitch but centres on the glyph.
 */
function shape(layout: Raster, spacing: number): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  const count = layout.quads.length
  const total = Math.max(1, count * PIECES)
  const box = new Float32Array(total * 4)
  const unit = new Float32Array(total * 4)
  for (let piece = 0; piece < PIECES; piece++)
    layout.quads.forEach((q, i) => {
      const at = (piece * count + i) * 4
      box.set([q.x - spacing / 2, q.y, q.width, q.height], at)
      unit.set([q.base, q.em, q.x + (q.width - spacing) / 2, 0], at)
    })
  geometry.setAttribute(BOX, new InstancedBufferAttribute(box, 4))
  geometry.setAttribute(UNIT, new InstancedBufferAttribute(unit, 4))
  geometry.setAttribute(STATE, new InstancedBufferAttribute(new Float32Array(total * 4), 4))
  geometry.instanceCount = count * PIECES
  return geometry
}
