import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, inView, rng } from '@dioramajs/effects/kit'
import {
  attribute,
  cos,
  floor,
  fract,
  hash,
  max,
  mix,
  positionGeometry,
  sin,
  sRGBTransferEOTF,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  CanvasTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { fonts, type Raster, raster, unsupported } from './raster'

type Style = 'rgb' | 'slice' | 'vhs'
type Trigger = 'hover' | 'interval' | 'scroll' | 'load'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  strength: number
  split: number
  slices: number
  interval: number
  duration: number
  seed: number
}

/** How a style breaks the text. Distances are in em, so a heading and a label break alike. */
export interface Look {
  /** Share of the slabs struck at full strength. */
  readonly density: number
  /** Slabs per `slices`: big blocks for slice, many thin lines for vhs. */
  readonly rows: number
  /** Largest sideways jump of a struck slab, em. */
  readonly shift: number
  /** Largest jump towards or away from the viewer, em. */
  readonly depth: number
  /** Largest turn of a struck slab around its horizontal and vertical axes, radians. */
  readonly turn: readonly [number, number]
  /** Turn of the whole line around its vertical axis, radians: the color layers part. */
  readonly tilt: number
  /** Lean of the whole line around its horizontal axis, radians: vhs leans back. */
  readonly lean: number
  /** Thickness of the block a struck slab becomes, em; 0 keeps it flat. */
  readonly extrude: number
  /** Scanline copies trailing behind the text, the hologram of vhs. */
  readonly trail: number
  /** Scale of the color split. */
  readonly split: number
  /** Static mixed into struck slabs. */
  readonly noise: number
  /** Tape warp: the line bends in depth and sideways, em. */
  readonly warp: number
}

export const LOOKS: Readonly<Record<Style, Look>> = {
  rgb: {
    density: 0.42,
    rows: 1.2,
    shift: 0.2,
    depth: 0.42,
    turn: [0.12, 0.26],
    tilt: 0.2,
    lean: 0.06,
    extrude: 0,
    trail: 0,
    split: 1,
    noise: 0.3,
    warp: 0,
  },
  slice: {
    density: 0.6,
    rows: 0.8,
    shift: 0.32,
    depth: 1.4,
    turn: [0.5, 0.35],
    tilt: 0.08,
    lean: 0.05,
    extrude: 0.5,
    trail: 0,
    split: 0.4,
    noise: 0.3,
    warp: 0,
  },
  vhs: {
    density: 0.32,
    rows: 2.4,
    shift: 0.14,
    depth: 0.8,
    turn: [0.15, 0.1],
    tilt: 0.08,
    lean: 0.42,
    extrude: 0,
    trail: 7,
    split: 0.6,
    noise: 0.45,
    warp: 0.04,
  },
}

/** Fringes of the split and the hologram light, sRGB. */
const RED = [1, 0.16, 0.42] as const
const CYAN = [0.1, 0.92, 1] as const
const HOLO = [0.45, 0.95, 1] as const

/** The pattern jumps this often during a burst, s. */
const STEP = 1 / 20
/** Scroll velocity below this never glitches; at FULL the glitch is at its peak. */
const QUIET = 0.03
const FULL = 0.3
/** Share of the box in view (above the bottom tenth) before trigger load plays. */
const SHOWN = 0.5
/** Most slabs; more slices make them thicker. */
const MAX_SLABS = 96
/** Most layers of one slab: the text, two color layers, the block or the hologram. */
const LAYERS = 18
/** Layers of an extruded block. */
const SIDES = 14

/** A uniform random number in [0, 1) for the seed and two counters: the same on every load. */
export function chance(seed: number, a: number, b: number): number {
  const base = Math.round(seed) * 73856093
  return rng((base ^ Math.imul(a + 1, 19349663) ^ Math.imul(b + 1, 83492791)) >>> 0)()
}

/** Steps of a burst where the signal drops out between its two hits; none in a short burst. */
export function gap(steps: number): readonly [number, number] {
  if (steps < 8) return [steps, steps]
  const from = Math.round(steps * 0.45)
  return [from, from + Math.max(2, Math.round(steps * 0.12))]
}

/**
 * Strength of step `n` of burst `burst` that lasts `steps`, 0..1. It hits twice: each hit starts
 * in full, then stutters (some steps drop out) and fades; between them the signal drops out.
 */
export function strike(seed: number, burst: number, n: number, steps: number): number {
  const [off, on] = gap(steps)
  if (n === 0 || n === on) return 1
  if (n >= off && n < on) return 0
  if (chance(seed, burst, n) < 0.15) return 0
  const fade = n < off ? n / off : (n - on) / Math.max(1, steps - on)
  return (0.5 + 0.5 * chance(seed, burst, n + 4096)) * (1 - 0.35 * fade)
}

/**
 * Opacity of the whole text at step `n` of a burst of `steps`: it dims while the signal drops out
 * between the hits, and late in the second hit it may flicker once.
 */
export function flicker(seed: number, burst: number, n: number, steps: number): number {
  const [off, on] = gap(steps)
  if (n >= off && n < on) return 0.45
  if (n !== on + 4) return 1
  return chance(seed, burst, n + 8192) < 0.5 ? 0.7 : 1
}

/** Most dips in opacity that may start in any second: 3, the WCAG 2.3.1 flash threshold. */
const FLASHES = 3

/**
 * Keeps the text from flashing: the returned function passes the opacity of each drawn frame at
 * `now` seconds and holds it at 1 for a dip that would be the fourth to start within a second.
 */
export function flashes(): (alpha: number, now: number) => number {
  const starts: number[] = []
  let last = 1
  let kept = true
  return (alpha, now) => {
    if (alpha < 1 && last >= 1) {
      while (starts.length && now - (starts[0] as number) >= 1) starts.shift()
      kept = starts.length < FLASHES
      if (kept) starts.push(now)
    }
    last = alpha
    return alpha < 1 && !kept ? 1 : alpha
  }
}

/** Instance attributes, one row per layer of a slab, in draw order. */
export interface Slabs {
  /** Top and bottom of the slab in box px, the layer's sideways offset in px, its static. */
  readonly band: Float32Array
  /** Move of the slab in px, x, y (down) and towards the viewer; the layer's depth behind it. */
  readonly move: Float32Array
  /** Turn of the slab around x, y and z in radians. */
  readonly turn: Float32Array
  /** Share of the text's own color, opacity, shade, scanlines. */
  readonly look: Float32Array
  /** Color of a color layer or of the hologram, sRGB. */
  readonly tint: Float32Array
  /** Layers written. */
  count: number
}

export function slabs(capacity: number): Slabs {
  return {
    band: new Float32Array(capacity * 4),
    move: new Float32Array(capacity * 4),
    turn: new Float32Array(capacity * 3),
    look: new Float32Array(capacity * 4),
    tint: new Float32Array(capacity * 3),
    count: 0,
  }
}

/** What one step of the pattern needs to know. */
export interface Step {
  readonly look: Look
  readonly seed: number
  /** Pattern id: the same id draws the same slabs. */
  readonly id: number
  /** Strength of the burst now, 0..1. */
  readonly level: number
  readonly strength: number
  readonly split: number
  readonly slices: number
  /** Lines of text, the text's frame in box px and its largest font size. */
  readonly lines: number
  readonly frame: readonly [number, number, number, number]
  readonly em: number
  /** Opacity of the step, a flicker. */
  readonly alpha: number
  /** Static flashes on this step. */
  readonly grainy: boolean
  /** 1 at rest; leaving a page the slabs fly at the viewer and drop out. */
  readonly presence: number
}

/** Slabs overlap this much, px, so no hairline shows between two that did not move. */
const SEAM = 0.75

/**
 * Cuts the text into horizontal slabs for one step of the pattern and writes their layers back
 * to front: the hologram, the red and cyan layers, the sides of an extruded block, then the text
 * itself on top. Slabs left in place merge, and at level 0 it is the flat text in one layer.
 */
export function pattern(step: Step, out: Slabs): void {
  const { look, seed, id, frame, em } = step
  const [, frameY, , frameHeight] = frame
  const amount = Math.max(step.level, 1 - step.presence)
  const level = amount * Math.max(0, step.strength)
  const wanted =
    step.lines * Math.max(1, step.slices) * look.rows * (0.6 + 0.8 * chance(seed, id, 1))
  const rows = Math.max(1, Math.min(MAX_SLABS, Math.round(wanted)))
  // Slabs of uneven height: random weights along the text's height.
  const edges = [0]
  for (let k = 0; k < rows; k++) edges.push((edges[k] as number) + 0.35 + chance(seed, id, 100 + k))
  const total = edges[rows] as number
  const edgeY = (k: number): number => frameY + (frameHeight * (edges[k] as number)) / total
  const density = Math.min(0.95, level * look.density)
  // The whole line turns a little around its centre during a burst; vhs leans back.
  const side = chance(seed, id, 2) < 0.5 ? -1 : 1
  const tilt = side * (0.5 + 0.5 * chance(seed, id, 3)) * look.tilt * amount
  const lean = (look.lean > 0.2 || chance(seed, id, 4) < 0.5 ? 1 : -1) * look.lean * amount
  const mid = frameY + frameHeight / 2
  // A flicker step drops the signal to a faint flat text: no color layers, block or hologram.
  const full = step.alpha >= 1
  const sep = full ? Math.max(0, step.split) * look.split * amount : 0
  const warp = look.warp > 0 && amount > 0
  let written = 0
  const put = (
    band: readonly [number, number],
    move: readonly [number, number, number],
    turn: readonly [number, number, number],
    z: number,
    own: readonly [number, number, number, number],
    tint: readonly [number, number, number],
    offsetX = 0,
    grain = 0,
  ): void => {
    if (written * 4 >= out.band.length) return
    out.band.set([band[0], band[1], offsetX, grain], written * 4)
    out.move.set([move[0], move[1], move[2], z], written * 4)
    out.turn.set(turn, written * 3)
    out.look.set(own, written * 4)
    out.tint.set(tint, written * 3)
    written++
  }
  /** Writes the layers of one slab from y0 to y1 (box px). */
  const slab = (k: number, y0: number, y1: number, struck: boolean): void => {
    const random = (j: number): number => chance(seed, id * 131 + k, j)
    // Leaving a page, slabs fly at the viewer one by one and drop out.
    if (step.presence < 1 && random(9) > step.presence) return
    const sign = (j: number): number => (random(j) < 0.5 ? -1 : 1)
    // The lean turns the line around its centre: a slab above it goes back, one below comes out.
    const fromMid = mid - (y0 + y1) / 2
    let dx = 0
    const dy = fromMid - fromMid * Math.cos(lean)
    let dz =
      fromMid * Math.sin(lean) + (step.presence < 1 ? (1 - step.presence) * em * 4 * random(10) : 0)
    let turn: [number, number, number] = [lean, tilt, 0]
    if (struck) {
      // A struck slab moves at least a third of the way, so it reads as broken.
      dx = sign(1) * (0.3 + 0.7 * random(2)) * look.shift * em * level
      dz += sign(3) * (0.3 + 0.7 * random(4)) * look.depth * em * level
      turn = [
        lean + sign(5) * (0.3 + 0.7 * random(6)) * look.turn[0] * level,
        tilt + sign(7) * random(8) * look.turn[1] * level,
        (random(11) - 0.5) * 0.06 * level,
      ]
    }
    if (warp) {
      // Worn tape: the line bends in depth and sideways, rolling with the steps.
      const phase = ((y0 + y1) / 2 - frameY) / Math.max(frameHeight, 1)
      dx += Math.sin(phase * 9 + id * 1.3) * look.warp * em * amount
      dz += Math.cos(phase * 7 + id * 0.9) * look.warp * em * 4 * amount
    }
    const band = [Math.max(frameY, y0 - SEAM), Math.min(frameY + frameHeight, y1 + SEAM)] as const
    const move = [dx, dy, dz] as const
    const alpha = step.alpha
    for (let t = full ? look.trail : 0; t >= 1 && amount > 0; t--) {
      // A hologram: scanline copies receding behind the text, fading with depth.
      const fade = alpha * amount * 0.6 * (1 - t / (look.trail + 1))
      put(band, move, turn, -t * em * 0.16, [0.05, fade, 1.2, 1], HOLO)
    }
    if (sep > 0) {
      // Red behind and cyan in front, drawn under the text: where the layers line up the text
      // covers them, where tilt and perspective part them they show at its edges.
      const z = sep * (struck ? 5 + 4 * random(12) : 2.5)
      const offsetX = sep * (struck ? 0.5 + random(13) : 0.35)
      put(band, move, turn, -z, [0, alpha, 1, 0], RED, -offsetX)
      put(band, move, turn, z, [0, alpha * 0.9, 1, 0], CYAN, offsetX)
    }
    if (struck && full && look.extrude) {
      // The slab becomes a block: its sides are copies stepping back, darker with depth.
      const thick = look.extrude * em * (0.5 + 0.5 * random(14)) * level
      for (let j = SIDES; j >= 1; j--)
        put(band, move, turn, -(thick * j) / SIDES, [1, alpha, 0.6 - (0.38 * j) / SIDES, 0], CYAN)
    }
    put(band, move, turn, 0, [1, alpha, 1, 0], CYAN, 0, struck && step.grainy ? look.noise : 0)
  }
  // Slabs that did not move merge with their neighbours, unless the tape warps every one.
  let from = -1
  for (let k = 0; k < rows; k++) {
    const struck = level > 0 && chance(seed, id * 131 + k, 0) < density
    if (!struck && !warp) {
      if (from < 0) from = k
      continue
    }
    if (from >= 0) slab(from, edgeY(from), edgeY(k), false)
    from = -1
    slab(k, edgeY(k), edgeY(k + 1), struck)
  }
  if (from >= 0) slab(from, edgeY(from), edgeY(rows), false)
  out.count = written
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  return map
}

const emOf = (layout: Raster): number => Math.max(1, ...layout.quads.map((q) => q.em))

// Attribute names become WGSL and GLSL identifiers: no keyword of either has a capital letter
// after the first.
const BAND = 'slabBand'
const MOVE = 'slabMove'
const TURN = 'slabTurn'
const LOOK = 'slabLook'
const TINT = 'slabTint'

/**
 * A heading glitches like a broken signal, in depth: for a fraction of a second it breaks into
 * slabs that jump towards the viewer and turn in perspective, its red and cyan layers part at
 * different depths, blocks extrude out of the page or a hologram trails behind it. Then it snaps
 * back flat. At rest the element is plain DOM text.
 */
const textGlitch: Effect<Params> = defineEffect({
  name: 'text-glitch',
  params: {
    style: oneOf('rgb', 'slice', 'vhs'),
    trigger: oneOf('hover', 'interval', 'scroll', 'load'),
    strength: 1,
    split: 6,
    slices: 5,
    interval: 3,
    duration: 0.7,
    seed: 1,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const ratio = ctx.quality === 'low' ? 1 : 2
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout) {
      if (reason && DEV)
        app.log.warn(`text-glitch: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }

    const look = LOOKS[params.style]
    const trigger = params.trigger
    const frame = uniform(new Vector4(...layout.frame))

    // One instance per layer of a slab; the CPU writes them once per step of the pattern.
    const data = slabs(MAX_SLABS * LAYERS)
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex([0, 2, 1, 2, 3, 1])
    const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
    const columns = [
      [BAND, data.band, 4],
      [MOVE, data.move, 4],
      [TURN, data.turn, 3],
      [LOOK, data.look, 4],
      [TINT, data.tint, 3],
    ] as const
    const attrs = columns.map(([name, array, size]) => {
      const attr = new InstancedBufferAttribute(array, size)
      attr.setUsage(DynamicDrawUsage)
      geometry.setAttribute(name, attr)
      return attr
    })
    geometry.instanceCount = 0

    const band = attribute(BAND, 'vec4') as unknown as Node<'vec4'>
    const move = attribute(MOVE, 'vec4') as unknown as Node<'vec4'>
    const turn = attribute(TURN, 'vec3') as unknown as Node<'vec3'>
    const own = attribute(LOOK, 'vec4') as unknown as Node<'vec4'>
    const tint = attribute(TINT, 'vec3') as unknown as Node<'vec3'>
    // The corner of the slab in box px, y down, before it moves.
    const corner = positionGeometry.xy.add(0.5)
    const px = frame.x.add(corner.x.mul(frame.z))
    const py = band.x.add(corner.y.oneMinus().mul(band.y.sub(band.x)))
    // Around the slab's centre, y up: turned around x, then y, then z, then moved.
    const cx = frame.x.add(frame.z.mul(0.5))
    const cy = band.x.add(band.y).mul(0.5)
    const x0 = px.sub(cx).add(band.z)
    const y0 = cy.sub(py)
    const z0 = move.w
    const y1 = y0.mul(cos(turn.x)).sub(z0.mul(sin(turn.x)))
    const z1 = y0.mul(sin(turn.x)).add(z0.mul(cos(turn.x)))
    const x2 = x0.mul(cos(turn.y)).add(z1.mul(sin(turn.y)))
    const z2 = z1.mul(cos(turn.y)).sub(x0.mul(sin(turn.y)))
    const x3 = x2.mul(cos(turn.z)).sub(y1.mul(sin(turn.z)))
    const y3 = x2.mul(sin(turn.z)).add(y1.mul(cos(turn.z)))
    const half = u.size.mul(0.5)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(
      cx.sub(half.x).add(x3).add(move.x),
      half.y.sub(cy).add(y3).sub(move.y),
      z2.add(move.z),
    )
    const at = varying(vec2(px, py))
    const uv = vec2(at.x.sub(frame.x).div(frame.z), at.y.sub(frame.y).div(frame.w).oneMinus())
    const map = texture(canvasTexture(layout.canvas), uv)
    const ink = sRGBTransferEOTF(map.rgb.div(max(map.a, 1e-4))) as Node<'vec3'>
    const looks = varying(own)
    const tints = varying(tint)
    const grainy = varying(band.w)
    // The text's own color or the layer's, shaded for the sides of a block.
    const layer = sRGBTransferEOTF(tints) as Node<'vec3'>
    let rgb = mix(layer, ink, looks.x).mul(looks.z) as Node<'vec3'>
    // Static: 2 px cells that change with the step.
    const cell = floor(at.div(2))
    const noise = hash(
      cell.x
        .add(4096)
        .add(cell.y.add(4096).mul(8192))
        .add(floor(grainy.mul(1e4))),
    )
    rgb = mix(rgb, vec3(noise), grainy) as Node<'vec3'>
    // Scanlines of a hologram layer: one CSS px row in three.
    const scan = mix(1, step(0.66, fract(at.y.div(3))), looks.w)
    const boxUV = vec2(at.x.div(u.size.x), at.y.div(u.size.y).oneMinus())
    material.colorNode = vec4(
      rgb,
      map.a
        .mul(looks.y)
        .mul(scan)
        .mul(ctx.mask(boxUV.clamp(0, 1))),
    )
    const mesh = new Mesh(geometry, material)
    // The slabs move away from the plane the bounds are computed from.
    mesh.frustumCulled = false
    ctx.onDispose(() => (map.value as Texture).dispose())
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    // The DOM shows the text whenever nothing glitches.
    let dom = false
    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }
    show(true)

    // The pattern written last, so each step is computed once.
    let drawn = ''
    const draw = (
      id: number,
      level: number,
      alpha: number,
      grainy: boolean,
      presence: number,
    ): void => {
      const live = ctx.params
      const current = layout as Raster
      const key = [
        id,
        level,
        alpha,
        grainy,
        presence,
        live.strength,
        live.split,
        live.slices,
        live.seed,
        ...current.frame,
      ].join()
      if (key === drawn) return
      drawn = key
      pattern(
        {
          look,
          seed: live.seed,
          id,
          level,
          strength: live.strength,
          split: live.split,
          slices: live.slices,
          lines: Math.max(1, current.units),
          frame: current.frame,
          em: emOf(current),
          alpha,
          grainy,
          presence,
        },
        data,
      )
      geometry.instanceCount = data.count
      for (const attr of attrs) attr.needsUpdate = true
    }

    const use = (next: Raster): void => {
      const old = map.value as Texture
      map.value = canvasTexture(next.canvas)
      old.dispose()
      frame.value.set(...next.frame)
      layout = next
      drawn = ''
      ctx.invalidate()
    }
    // Raster again when the text, its fonts or its width change.
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      // Text that can no longer be drawn like the DOM keeps the last raster.
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (next) use(next)
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void redo(), 150)
    }
    ctx.onDispose(() => clearTimeout(timer))
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

    // A burst asked for and not drawn yet, e.g. a timer that went off while off screen.
    let pending = false
    // Trigger load waits until enough of the text is in view.
    let armed = trigger === 'load'
    // Seconds into the burst, -1 when none plays.
    let time = -1
    let bursting = false
    let bursts = 0
    // Seconds of scroll glitch or of a page transition, for the steps outside bursts.
    let clock = 0
    // Seconds since setup, for the flash limit.
    let age = 0
    const calm = flashes()
    let wait: ReturnType<typeof setTimeout> | undefined
    const wake = (): void => {
      pending = true
      ctx.invalidate()
    }
    const later = (first: boolean): void => {
      clearTimeout(wait)
      const random = chance(params.seed, bursts, 7)
      const span =
        Math.max(ctx.params.interval, 0.1) * (first ? 0.4 + 0.6 * random : 0.75 + 0.5 * random)
      wait = setTimeout(wake, span * 1000)
    }
    ctx.onDispose(() => clearTimeout(wait))
    if (trigger === 'interval') later(true)
    if (trigger === 'hover') {
      // The element or the link it sits in: a card title glitches when its card is hovered.
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      target.addEventListener(
        'pointerenter',
        (e) => {
          if (e.pointerType !== 'touch' && time < 0) wake()
        },
        { signal },
      )
      target.addEventListener('focusin', () => time < 0 && wake(), { signal })
      // Touch screens have no hover: a tap plays the burst.
      target.addEventListener(
        'pointerdown',
        (e) => {
          if (e.pointerType === 'touch' && time < 0) wake()
        },
        { signal },
      )
    }

    return (input): boolean => {
      const live = ctx.params
      let level = 0
      let id = 0
      let alpha = 1
      let grainy = false
      if (armed) {
        // Counted above the bottom tenth of the viewport, like `reveal`.
        if (inView(input.y, input.height, stage.height.peek(), SHOWN)) {
          armed = false
          pending = true
        }
      }
      if (pending && time < 0) {
        pending = false
        time = 0
        bursts++
        bursting = true
      } else if (time >= 0) time += input.delta
      if (time >= 0) {
        const length = Math.max(live.duration, 0.05)
        if (time >= length) {
          time = -1
          bursting = false
          if (trigger === 'interval') later(false)
        } else {
          const n = Math.floor(time / STEP)
          const steps = Math.ceil(length / STEP)
          level = strike(live.seed, bursts, n, steps)
          id = bursts * 1000 + n
          alpha = flicker(live.seed, bursts, n, steps)
          grainy = chance(live.seed, bursts, n + 12288) < 0.45
        }
      }
      let scrolling = false
      if (trigger === 'scroll') {
        const speed = Math.min(1, Math.max(0, (Math.abs(input.velocity) - QUIET) / (FULL - QUIET)))
        if (speed > 0) {
          scrolling = true
          clock += input.delta
          const n = Math.floor(clock / STEP)
          const peak = speed * (0.5 + 0.5 * chance(live.seed, 0, n))
          if (peak > level) {
            level = peak
            id = 1e8 + n
            // A flicker at most every 8 steps, 2.5 a second.
            alpha = n % 8 === 0 && chance(live.seed, 0, n + 8192) < 0.5 ? 0.7 : 1
            grainy = chance(live.seed, 0, n + 12288) < 0.45
          }
        }
      }
      if (input.presence < 1) {
        clock += input.delta
        id = 2e8 + Math.floor(clock / STEP)
      }
      const flat = time < 0 && !scrolling && input.presence >= 1
      age += input.delta
      alpha = calm(flat ? 1 : alpha, age)
      if (!flat) draw(id, level, alpha, grainy, Math.max(0, input.presence))
      show(flat)
      return bursting
    }
  },
})
export default textGlitch
