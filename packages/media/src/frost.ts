import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { approach, ease, follow, noise, spiralBlur, toBox } from '@dioramajs/effects/kit'
import {
  abs,
  floor,
  fract,
  hash,
  length,
  max,
  min,
  mix,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  NoColorSpace,
  type Node,
  RGBAFormat,
  type Texture,
  UnsignedByteType,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { featherTexture } from './feathers'
import { KEEP, Pane } from './pane'
import { EDGE, Freeze, frozen, reach, Wipe } from './wipe'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Params = {
  style: ChoiceParam<'frost' | 'steam'>
  by: ChoiceParam<'pointer' | 'hover' | 'view' | 'scroll'>
  blur: number
  strength: number
  grain: number
  radius: number
  refog: number
  refill: number
  duration: number
  start: number
  end: number
  cover: number
  x: number
  y: number
  middle: number
  keep: string
  color: ColorParam
  resolution: number
}

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Taps of the blur, on a golden-angle spiral turned per pixel by the frost noise. */
const TAPS = 16
/** Pointer points kept between two frames. */
const QUEUE = 64
/** view: the clearing starts once this share of the box is in the viewport. */
const SEEN = 0.35
/** Steam droplets sit on a grid of this many px. */
const CELL = 18
/** On a screen without hover nobody wipes with a pointer, so the middle stays at least this thin. */
const TOUCH_MIDDLE = 0.6
/** Margin of the ice kept thin around the elements of `keep`, px. */
const PAD = 12
/** A finger clears this much more than the pointer's radius, since it cannot aim a stroke. */
const FINGER = 1.4

export { reach, Wipe } from './wipe'

interface Kept {
  wipe: Wipe
  grown: number
  seen: boolean
  readonly freeze: Freeze
}

/** What the visitor cleared and how frozen the glass is, kept per element across rebuilds. */
const kept = new WeakMap<Element, Kept>()

const isMedia = (el: Element): boolean => el.localName === 'img' || el.localName === 'video'
const isPage = (el: Element): boolean =>
  el === el.ownerDocument.body || el === el.ownerDocument.documentElement

/**
 * Frosted glass over a photo, or a pane of ice over the page on `<body>` (over its box on any
 * other element). The pointer wipes it clear and it fogs back by itself, or it clears from the
 * pointer on hover, as it comes into view or as the page scrolls. `cover` freezes the glass from
 * the edges and thaws it from a point. `steam` is a fogged mirror with droplets instead of ice.
 */
const frost: Effect<Params> = defineEffect({
  name: 'frost',
  params: {
    style: oneOf('frost', 'steam'),
    by: oneOf('pointer', 'hover', 'view', 'scroll'),
    blur: 22,
    strength: 0.45,
    grain: 0.5,
    radius: 70,
    refog: 4,
    refill: 1,
    duration: 1.2,
    start: 0.15,
    end: 0.5,
    cover: 1,
    x: 0.5,
    y: 0.5,
    middle: 0,
    keep: '',
    color: color('#eef3f7'),
    resolution: 64,
  },
  rebuild: ['resolution'],
  media: 'optional',
  // The pane belongs to the page: it goes with its element, never flies on as a burst.
  burst: false,
  quality: { low: { blur: 6, resolution: 32 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal } = ctx
    const el = ctx.element as HTMLElement
    const photo = isMedia(el)
    const page = isPage(el)
    const steam = params.style === 'steam'
    const by = params.by
    const cells = Math.max(8, Math.min(256, Math.round(params.resolution)))
    const before = kept.get(el)
    const state: Kept = {
      wipe: before ? before.wipe.resized(cells) : new Wipe(cells),
      grown: before?.grown ?? 0,
      seen: before?.seen ?? false,
      freeze: before?.freeze ?? new Freeze(params.cover),
    }
    kept.set(el, state)
    const { wipe, freeze } = state
    const data = new Uint8Array(cells * cells * 4)
    const map = new DataTexture(data, cells, cells, RGBAFormat, UnsignedByteType)
    map.wrapS = map.wrapT = ClampToEdgeWrapping
    map.magFilter = map.minFilter = LinearFilter
    map.colorSpace = NoColorSpace
    map.generateMipmaps = false
    map.needsUpdate = true
    ctx.onDispose(() => map.dispose())
    const tile = noise(ctx, { size: 128, seed: 11, channels: 4 })

    // (clearing origin px with y up, its radius px, unused).
    const look = new Vector4()
    const ice = new Vector4()
    // Pane only: the pointer for the glints, the thin middle and reduced motion.
    const light = new Vector3()
    const calm = new Vector3()
    const touch = typeof matchMedia === 'function' && !matchMedia('(hover: hover)').matches
    const boxes = Array.from({ length: KEEP }, () => new Vector4())
    const keep = photo ? [] : keeping(params.keep, ctx)
    let pane: Pane | undefined
    if (photo) glass(ctx, map, tile, look, ice, steam)
    else {
      const feathers = await featherTexture()
      ctx.onDispose(() => feathers.dispose())
      if (signal.aborted) return
      pane = new Pane(ctx, {
        map,
        tile,
        feathers,
        look,
        freeze: ice,
        light,
        calm,
        keep: boxes,
        strength: ctx.u.strength as unknown as F,
        grain: ctx.u.grain as unknown as F,
        color: ctx.u.color as unknown as V3,
        presence: ctx.u.presence as unknown as F,
        steam,
        low: ctx.quality === 'low',
      })
      ctx.overlay.add(pane.mesh)
      // A pane fixed to the viewport would ride a native scroll with the canvas until the frame
      // lands: while there is ice to see, the canvas holds still instead.
      if (page || getComputedStyle(el).position === 'fixed') {
        ctx.onDispose(ctx.app.stage.hold(() => freeze.cover > 0))
      }
      await ctx.compile(pane.mesh)
      if (signal.aborted) return
    }

    // Pointer points in client px since the last frame; null breaks the stroke.
    const queue: ({ x: number; y: number; r?: number } | null)[] = []
    let over = false
    let origin: { x: number; y: number } | undefined
    // A photo takes the events of its own box; a pane is drawn over the page, so it listens to
    // the whole window and lets every event through to the page.
    const target: EventTarget = photo ? el : window
    const listen = <K extends keyof WindowEventMap>(
      type: K,
      handler: (e: WindowEventMap[K]) => void,
      passive = false,
    ): void => target.addEventListener(type, handler as EventListener, { signal, passive })
    const push = (point: { x: number; y: number; r?: number } | null): void => {
      // Bare glass has nothing to wipe: a pane without ice ignores the pointer and draws nothing.
      if (pane && freeze.grow === 0) return
      if (queue.length >= QUEUE) queue.splice(0, queue.length - QUEUE + 1)
      queue.push(point)
      ctx.invalidate()
    }
    const point = (e: PointerEvent): void => push({ x: e.clientX, y: e.clientY })
    if (!photo) {
      // Wiping with a finger would fight the scroll: every touch clears around it instead, also
      // while it scrolls the page, and the listeners are passive.
      const touched = (e: TouchEvent): void => {
        if (by === 'hover') return
        push(null)
        for (const touch of e.touches) push({ x: touch.clientX, y: touch.clientY, r: FINGER })
        push(null)
      }
      listen('touchstart', touched, true)
      listen('touchmove', touched, true)
    }
    if (by === 'hover') {
      // The glass clears from where the pointer came in and fogs back once it leaves; a tap
      // clears it for good.
      const enter = (e: PointerEvent): void => {
        if (!over) origin = { x: e.clientX, y: e.clientY }
        over = true
        ctx.invalidate()
      }
      listen(photo ? 'pointerenter' : 'pointerover', (e) => {
        if (e.pointerType !== 'touch') enter(e)
      })
      listen('pointerdown', (e) => {
        if (e.pointerType === 'touch' && e.isPrimary) enter(e)
      })
      listen(photo ? 'pointerleave' : 'pointerout', (e) => {
        if (e.pointerType === 'touch' || (!photo && e.relatedTarget)) return
        over = false
        ctx.invalidate()
      })
    } else if (photo) {
      // Touch wipes while the finger is pressed; a scroll takes the gesture with pointercancel.
      follow(ctx, {
        enter(e) {
          push(null)
          point(e)
        },
        move: point,
        leave: () => push(null),
      })
    } else {
      listen('pointermove', (e) => {
        if (e.pointerType !== 'touch') point(e)
      })
      // Leaving the window breaks the stroke.
      listen('pointerout', (e) => {
        if (e.pointerType !== 'touch' && !e.relatedTarget) {
          push(null)
          light.z = 0
        }
      })
    }

    let last: { x: number; y: number } | undefined
    let dirty = wipe.peak > 0
    // The clearing from a point, 0..1 of the way to the farthest corner.
    let grown = state.grown
    let seen = state.seen
    return (input): boolean => {
      const viewportWidth = ctx.app.stage.width.peek()
      const viewportHeight = ctx.app.stage.height.peek() || input.height
      const [left, top, width, height] = page
        ? [0, 0, viewportWidth, viewportHeight]
        : [input.x, input.y, input.width, input.height]
      const area = { x: left, y: top, height }
      const dt = Math.max(0, input.delta)
      const still = input.reducedMotion
      // A page transition takes the copy as it is: no new wipes while it plays. A pane under
      // reduced motion is only a tint, so nothing wipes it.
      const live = input.presence >= 1 && (photo || !still)
      for (const queued of queue) {
        if (!queued) {
          last = undefined
          continue
        }
        const next = toBox(queued, area)
        if (live) {
          const from = last ?? next
          const radius = params.radius * (queued.r ?? 1)
          wipe.stroke(from.x, from.y, next.x, next.y, radius, width, height)
          dirty = true
          if (!photo && queued.r === undefined) light.set(next.x, next.y, 1)
        }
        last = next
      }
      queue.length = 0
      if (wipe.active && params.refog > 0) {
        wipe.step(dt, params.refog, 1 - Math.min(1, Math.max(0, params.refill)))
        dirty = true
      }
      if (dirty) {
        wipe.write(data)
        map.needsUpdate = true
        dirty = false
      }

      // Where the clearing grows from, box px with y up.
      let originX = width / 2
      let originY = height / 2
      let goal = grown
      let span = Math.max(params.duration, 1e-3)
      if (by === 'view') {
        const shown = Math.min(top + height, viewportHeight) - Math.max(top, 0)
        if (shown >= SEEN * Math.min(height, viewportHeight)) seen = true
        goal = seen ? 1 : 0
      } else if (by === 'scroll') {
        const range = Math.max(params.end - params.start, 1e-3)
        goal = still ? 1 : Math.min(1, Math.max(0, (input.progress - params.start) / range))
        grown = goal
      } else if (by === 'hover') {
        if (origin) {
          const from = toBox(origin, area)
          originX = from.x
          originY = from.y
        }
        goal = over && live ? 1 : 0
        // Fogging back takes `refog`; 0 keeps the glass clear once it cleared.
        if (goal < grown) {
          if (params.refog > 0) span = params.refog
          else goal = grown
        }
      }
      grown = still ? goal : approach(grown, goal, dt / span)
      const far = reach(originX, originY, width, height) + EDGE
      look.set(originX, originY, ease('cubicInOut', grown) * (far + EDGE), 0)
      const freezing = freeze.step(params.cover, dt, params.duration, still)
      ice.set(...freeze.look(params.x * width, (1 - params.y) * height, width, height))
      if (pane) {
        pane.place(left, top, width, height, viewportWidth, viewportHeight)
        calm.set(Math.max(params.middle, touch ? TOUCH_MIDDLE : 0), still ? 1 : 0, 0)
        keep.forEach((element, i) => {
          const rect = element.getBoundingClientRect()
          const box = boxes[i] as Vector4
          if (!element.isConnected || !rect.width || !rect.height) box.set(0, 0, 0, 0)
          else {
            const x = rect.left - left + rect.width / 2
            const y = height - (rect.top - top + rect.height / 2)
            box.set(x, y, rect.width / 2 + PAD, rect.height / 2 + PAD)
          }
        })
      }
      // A thaw that left bare glass takes its wipes with it, or they would fog back over nothing.
      if (pane && freeze.grow === 0 && wipe.peak > 0) {
        wipe.reset()
        wipe.write(data)
        map.needsUpdate = true
      }
      state.grown = grown
      state.seen = seen
      return (wipe.active && params.refog > 0) || grown !== goal || freezing
    }
  },
})
export default frost

/** The elements of the selector `keep`, at most {@link KEEP}; none for a bad selector. */
function keeping(selector: string, ctx: EffectContext<Params>): Element[] {
  if (!selector.trim()) return []
  try {
    return [...document.querySelectorAll(selector)].slice(0, KEEP)
  } catch {
    ctx.app.log.warn(`EFFECT_PARAM: frost keep="${selector}" is not a selector`, ctx.element)
    return []
  }
}

/** The photo behind the glass: blurred where fogged, veiled in ice or steam. */
function glass(
  ctx: EffectContext<Params>,
  map: DataTexture,
  tile: Texture,
  look: Vector4,
  ice: Vector4,
  steam: boolean,
): void {
  const { u, surface } = ctx
  const taps = ctx.quality === 'low' ? TAPS / 2 : TAPS
  const lookNode = uniform(look) as unknown as V4
  const freeze = uniform(ice) as unknown as V4
  const size = u.size as unknown as V2

  surface.color((color, { uv, box, sample }) => {
    const point = box.mul(size)
    // Two scales of the noise tile: `coarse` for patches and ragged edges, `fine` for detail.
    const coarse = texture(tile, point.div(420)) as unknown as V4
    const fine = texture(tile, point.div(128)) as unknown as V4
    // The wiped mask and the clearing from a point, both with a ragged edge.
    const ragged = coarse.r.sub(0.5).mul(0.5)
    const wiped = smoothstep(0.3, 0.7, (texture(map, box).r as unknown as F).add(ragged))
    const fromOrigin = length(point.sub(lookNode.xy)).add(coarse.g.sub(0.5).mul(EDGE))
    const grown = smoothstep(lookNode.z, lookNode.z.sub(EDGE), fromOrigin).mul(
      step(0.5, lookNode.z),
    )
    const { ice: frozenAt } = frozen(point, size, freeze, coarse.a, fine.r)
    const clear = max(max(wiped, grown), frozenAt.oneMinus()) as unknown as F
    const fog = clear.oneMinus()

    // Blur under the glass: only the difference from the picture is added.
    // Turned per pixel, so the taps read as grain instead of ghost copies.
    const turn = hash(floor(point.x).add(floor(point.y).mul(4099))).mul(Math.PI * 2)
    const spread = max(u.blur, 0).div(size) as unknown as V2
    const read = (at: V2): V4 => sample(at.clamp(0, 1) as unknown as V2)
    const blurred = spiralBlur(read, uv, spread, taps, turn as unknown as F)
    const here = sample(uv)
    let rgb = color.rgb.add(blurred.rgb.sub(here.rgb).mul(fog)) as unknown as V3
    const tint = u.color as unknown as V3
    if (steam) {
      // Droplets on the fogged glass, each a small lens that flips the picture behind it.
      const inCells = point.div(CELL)
      const id = floor(inCells)
      // Integer seeds: the hash truncates to uint.
      const seed = id.x.add(id.y.mul(1013)).mul(4)
      const random = hash(seed)
      const centre = vec2(hash(seed.add(1)), hash(seed.add(2)))
        .mul(0.5)
        .add(0.25)
      const radius = random.mul(0.22).add(0.08)
      const distance = length(fract(inCells).sub(centre))
      const drop = smoothstep(radius, radius.mul(0.75), distance).mul(
        step(0.45, random),
        u.grain.clamp(0, 1),
      )
      const lens = sample(
        uv
          .sub(
            fract(inCells)
              .sub(centre)
              .mul(CELL * 2.5)
              .div(size),
          )
          .clamp(0, 1),
      ).rgb
      // A dark rim where the drop bends light away, and a highlight on its upper side.
      const rim = smoothstep(radius.mul(0.5), radius.mul(0.95), distance).mul(0.4).oneMinus()
      const glint = smoothstep(
        radius.mul(0.32),
        0,
        length(fract(inCells).sub(centre).sub(radius.mul(-0.4))),
      )
      const fogged = mix(rgb, tint, u.strength.clamp(0, 1))
      const droplet = lens.mul(rim).add(glint.mul(0.55))
      rgb = mix(rgb, mix(fogged, droplet, drop), fog) as unknown as V3
    } else {
      // Ice: a milky layer that grows thick towards the frame, fine veins and glittering specks.
      // Thin in the middle, so the blurred picture still reads through it.
      const veins = abs(coarse.b.mul(2).sub(1)).oneMinus().pow(28)
      const fern = abs(fine.b.mul(2).sub(1)).oneMinus().pow(20)
      const specks = smoothstep(0.74, 0.8, fine.g)
      const side = min(min(point.x, size.x.sub(point.x)), min(point.y, size.y.sub(point.y)))
      const edge = smoothstep(EDGE, 0, side)
      const short = min(size.x, size.y)
      const torn = side.add(coarse.a.sub(0.5).mul(short).mul(0.3))
      const frame = smoothstep(short.mul(0.3), 0, torn).pow(1.5)
      const crystals = veins
        .mul(0.1)
        .add(fern.mul(0.05))
        .add(specks.mul(0.22))
        .add(edge.mul(0.25))
        .mul(frame.add(0.6))
      const milk = u.strength.mul(frame.mul(0.8).add(0.4))
      const white = milk.add(crystals.mul(u.grain)).clamp(0, 1)
      rgb = mix(rgb, tint, white.mul(fog)) as unknown as V3
    }
    // A thin wet rim where the glass turns clear.
    const rim = clear.mul(fog).mul(4).mul(u.strength.clamp(0, 1))
    rgb = rgb.mul(rim.mul(-0.12).add(1)) as unknown as V3
    return vec4(rgb, color.a)
  })
}
