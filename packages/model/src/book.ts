// A cover image made a 3D book with a spine, pages and a back, which turns and opens a little.
import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  cameraPosition,
  clamp,
  dot,
  float,
  floor,
  hash,
  max,
  mix,
  normalize,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  Group,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  SRGBColorSpace,
  type Texture,
  Vector2,
} from 'three/webgpu'
import { slab, strip } from './shapes'
import { dissolve, isUrl, Pointer, sharpen, shadow as softShadow } from './studio'

type Style = 'hardcover' | 'paperback'
type Params = {
  style: ChoiceParam<Style>
  pages: number
  spine: string
  back: string
  yaw: number
  swing: number
  open: number
  tilt: number
  drag: boolean
  shadow: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>

const TAU = Math.PI * 2
const DEG = Math.PI / 180
/** Thickness of one page in cover heights: 320 pages of a 6 × 9 in book are 16 mm. */
export const PAGE = 0.00022
/** One arrow key press. */
const STEP = Math.PI / 6
/** Light from the upper left in front, in world space. */
const LIGHT = new Vector2(-0.45, 0.55)
const LIGHT_Z = 0.7
const LIGHT_LENGTH = Math.hypot(LIGHT.x, LIGHT.y, LIGHT_Z)
/** Brightness of a face turned away from the light. */
const AMBIENT = 0.55
const PAPER = '#f2ede1'
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Half-lives, s: of the hover, the pointer tilt, an arrow key step and the coast. */
const HOVER_HALF_LIFE = 0.16
const TILT_HALF_LIFE = 0.12
const KEY_HALF_LIFE = 0.08
const COAST_HALF_LIFE = 0.35
/** A drag held still this long before letting go does not coast, ms. */
const COAST_HOLD = 80
/** Fastest coast after a drag, radians per second. */
const COAST_MAX = TAU * 2
/** Coasting stops below this speed, radians per second. */
const COAST_STOP = 0.02
/** Below this a motion counts as settled. */
const EPSILON = 1e-4
/** Height of the strip read for the spine colour, px. */
const EDGE_SAMPLES = 16

export { isUrl }

/** The average colour of the left edge of a picture, where the spine meets the cover. */
export function edgeColor(image: unknown): Color | undefined {
  try {
    const source = image as {
      width?: number
      height?: number
      naturalWidth?: number
      naturalHeight?: number
      videoWidth?: number
      videoHeight?: number
    }
    const w = source.naturalWidth || source.videoWidth || source.width || 0
    const h = source.naturalHeight || source.videoHeight || source.height || 0
    if (!w || !h) return undefined
    // The left 3% of the picture, scaled down to a column of 16 px.
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, EDGE_SAMPLES)
        : Object.assign(document.createElement('canvas'), { width: 1, height: EDGE_SAMPLES })
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!context) return undefined
    const stripWidth = Math.max(1, w * 0.03)
    context.drawImage(image as CanvasImageSource, 0, 0, stripWidth, h, 0, 0, 1, EDGE_SAMPLES)
    const data = context.getImageData(0, 0, 1, EDGE_SAMPLES)?.data
    if (!data || data.length < EDGE_SAMPLES * 4) return undefined
    let red = 0
    let green = 0
    let blue = 0
    for (let i = 0; i < EDGE_SAMPLES * 4; i += 4) {
      red += data[i] as number
      green += data[i + 1] as number
      blue += data[i + 2] as number
    }
    const total = EDGE_SAMPLES * 255
    return new Color().setRGB(red / total, green / total, blue / total, SRGBColorSpace)
  } catch {
    return undefined
  }
}

/**
 * Colour lit by a light from the upper left: a face toward the viewer keeps the picture's own
 * colour, faces turned away darken, and a glossy one catches a highlight as it turns.
 */
function shaded(base: V3, gloss = 0): Node {
  const n = normalize(normalWorld)
  const light = vec3(LIGHT.x / LIGHT_LENGTH, LIGHT.y / LIGHT_LENGTH, LIGHT_Z / LIGHT_LENGTH)
  // Diffuse light relative to a face toward the viewer, so that face gets exactly 1.
  const lambert = clamp(dot(n, light).div(LIGHT_Z / LIGHT_LENGTH), 0, 1.06)
  let lit = base.mul(mix(float(AMBIENT), float(1), lambert)) as unknown as V3
  if (gloss > 0) {
    const view = normalize(cameraPosition.sub(positionWorld))
    const half = normalize(light.add(view))
    lit = lit.add(pow(max(dot(n, half), 0), 60).mul(gloss)) as unknown as V3
  }
  return vec4(lit, 1)
}

/** Sizes of a book in cover heights. */
export interface Measure {
  /** Board or cover thickness. */
  readonly board: number
  /** Page block thickness. */
  readonly block: number
  /** Overhang of the boards over the pages. */
  readonly square: number
  /** From the front of the cover to the back. */
  readonly total: number
}

/** Board, page block and overhang of a book of `pages` pages. */
export function measure(style: Style, pages: number): Measure {
  const board = style === 'hardcover' ? 0.011 : 0.0025
  const block = Math.max(0.006, Math.min(2000, Math.max(0, pages)) * PAGE)
  return { board, block, square: style === 'hardcover' ? 0.012 : 0.0015, total: block + 2 * board }
}

/** A cover image made a 3D book: it turns to show its spine and opens a little under the pointer. */
const book: Effect<Params> = defineEffect({
  name: 'book',
  params: {
    style: oneOf('hardcover', 'paperback'),
    pages: 320,
    spine: '',
    back: '',
    yaw: 0,
    swing: 36,
    open: 12,
    tilt: 5.7,
    drag: true,
    shadow: 0.5,
  },
  rebuild: ['spine', 'back'],
  media: true,
  bleed: 120,
  presence: 'custom',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, element, params } = ctx
    const el = element as HTMLElement
    const style = params.style
    const hard = style === 'hardcover'
    const mask = dissolve(u)
    sharpen(ctx.map, ctx.render.renderer)

    // The spine and the back: a colour, a picture, or the colour of the cover's left edge.
    const picture = async (value: string): Promise<Texture | undefined> => {
      if (!value || !isUrl(value)) return undefined
      try {
        return await ctx.texture(value)
      } catch (error) {
        if (signal.aborted) throw error
        ctx.app.log.warn(`book: ${value} did not load, a plain color shows instead`, error)
        return undefined
      }
    }
    const [spineMap, backMap] = await Promise.all([picture(params.spine), picture(params.back)])
    const edge = edgeColor(ctx.map.image) ?? new Color(0x2b2b2e)
    const colorOf = (value: string, fallback: Color): Color => {
      const css = value && !isUrl(value) ? cssColor(value, element) : undefined
      return css ? new Color().setStyle(css) : fallback
    }
    const spineColor = colorOf(params.spine, edge)
    const backColor = colorOf(params.back, spineColor)
    const paper = new Color().setStyle(PAPER)

    const make = (colour: Node): Material => {
      const material = new MeshBasicNodeMaterial()
      material.colorNode = colour as Node<'vec4'>
      material.maskNode = mask
      return material
    }
    const solid = (c: Color, gloss = 0): Material => make(shaded(vec3(c.r, c.g, c.b), gloss))
    const cover = make(
      shaded(texture(ctx.map, clamp(ctx.coverUV(uv()), 0, 1)).rgb as unknown as V3, 0.1),
    )
    const back = backMap
      ? make(shaded(ctx.fit(backMap, { fit: 'cover' }).sample(uv()).rgb as unknown as V3, 0.1))
      : solid(backColor, 0.06)
    const spine = spineMap
      ? make(shaded(ctx.fit(spineMap, { fit: 'fill' }).sample(uv()).rgb as unknown as V3, 0.1))
      : solid(spineColor, 0.06)
    const edges = hard ? solid(spineColor.clone().multiplyScalar(0.8)) : solid(paper)
    const endpaper = solid(paper.clone().multiplyScalar(0.96))
    // Page edges: faint lines a couple of px apart, darker toward the boards. The uniform holds
    // lines per unit and half the block's thickness.
    const lines = uniform(new Vector2(100, 0.05))
    const linesPerUnit = (lines as unknown as V2).x
    const halfBlock = (lines as unknown as V2).y
    const z = positionLocal.z
    // The offset keeps the hash input positive across the block.
    const stripes = hash(floor(z.mul(linesPerUnit).add(10000)))
      .mul(0.07)
      .oneMinus()
    const shadeIn = mix(
      float(0.8),
      float(1),
      smoothstep(0, 0.22, halfBlock.sub(abs(z)).div(halfBlock.mul(2))),
    ) as unknown as F
    const pageEdge = abs(normalLocal.z).lessThan(0.5)
    const sides = select(pageEdge, stripes.mul(shadeIn), float(1))
    const leaves = make(shaded(vec3(paper.r, paper.g, paper.b).mul(sides) as unknown as V3))
    const materials = [cover, back, spine, edges, endpaper, leaves]
    ctx.onDispose(() => {
      for (const material of materials) material.dispose()
    })

    const root = new Group()
    const pivot = new Group()
    root.add(pivot)
    ctx.place(root, { fit: 'none', replace: true })
    const shade = softShadow(u)
    ctx.place(shade.mesh, { fit: 'none' })

    // The book: the front at z = 0, the spine at the left edge, the front cover on a hinge.
    let built: { group: Group; hinge: Group; size: Measure; aspect: number; pages: number }
    const build = (aspect: number, pages: number): void => {
      const width = Math.max(0.1, aspect)
      const size = measure(style, pages)
      const { board, block, square, total } = size
      const group = new Group()
      const boardEdge = hard ? board * 0.25 : board * 0.4
      const boardCorner = hard ? 0.006 : 0.003
      // The front cover opens on a hinge a little in from the spine, at the joint.
      const hinge = new Group()
      const joint = hard ? 0.012 : 0.002
      hinge.position.set(-width / 2 + joint, 0, -board / 2)
      const front = new Mesh(slab(width, 1, board, boardCorner, boardEdge), [
        cover,
        endpaper,
        edges,
      ])
      front.position.x = width / 2 - joint
      hinge.add(front)
      const inset = hard ? 0.004 : 0.0005
      const blockWidth = width - square - inset
      const pageBlock = new Mesh(slab(blockWidth, 1 - 2 * square, block, 0.002, 0.0012), leaves)
      pageBlock.position.set(-width / 2 + inset + blockWidth / 2, 0, -board - block / 2)
      const rear = new Mesh(slab(width, 1, board, boardCorner, boardEdge), [endpaper, back, edges])
      rear.position.z = -board - block - board / 2
      const ridge = new Mesh(strip(1, total, hard ? total * 0.12 : 0), spine)
      ridge.position.x = -width / 2 - (hard ? 0 : 0.0004)
      group.add(hinge, pageBlock, rear, ridge)
      // Turns about the middle of its thickness.
      group.position.z = total / 2
      pivot.position.z = -total / 2
      pivot.add(group)
      built = { group, hinge, size, aspect: width, pages }
    }
    const aspectOf = (): number => {
      const { width, height } = ctx.input
      if (width > 0 && height > 0) return width / height
      const img = element as HTMLImageElement
      return (img.naturalWidth || 2) / (img.naturalHeight || 3)
    }
    build(aspectOf(), params.pages)
    await ctx.compile(root)
    if (signal.aborted) return

    // Drag turns it with a little inertia and leaves it there; arrow keys step it.
    let yaw = 0
    let velocity = 0
    let keyYaw = 0
    let grab: { id: number; x: number; t: number } | undefined
    const touchable = (): boolean => {
      const action = getComputedStyle(el).touchAction
      return action === 'none' || (action.includes('pan-y') && !action.includes('pan-x'))
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (event: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, fn, { signal })
    listen('pointerdown', (e) => {
      if (grab || !ctx.params.drag || e.button !== 0) return
      if (e.pointerType !== 'mouse' && !touchable()) return
      grab = { id: e.pointerId, x: e.clientX, t: e.timeStamp }
      velocity = 0
      try {
        el.setPointerCapture(e.pointerId)
      } catch {}
      if (e.pointerType === 'mouse') e.preventDefault()
    })
    listen('pointermove', (e) => {
      if (e.pointerId !== grab?.id) return
      const dx = ((e.clientX - grab.x) * Math.PI) / Math.max(1, ctx.input.width)
      const seconds = Math.max(1, e.timeStamp - grab.t) / 1000
      // The release speed is smoothed over the last few moves.
      velocity = velocity * 0.2 + (dx / seconds) * 0.8
      yaw += dx
      grab = { id: e.pointerId, x: e.clientX, t: e.timeStamp }
      ctx.invalidate()
    })
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== grab?.id) return
      // Held still before letting go, cancelled by a scroll, or no motion wanted: no coasting.
      if (e.type !== 'pointerup' || e.timeStamp - grab.t > COAST_HOLD || ctx.input.reducedMotion)
        velocity = 0
      velocity = Math.min(COAST_MAX, Math.max(-COAST_MAX, velocity))
      grab = undefined
      ctx.invalidate()
    }
    listen('pointerup', release)
    listen('pointercancel', release)
    listen('dragstart', (e) => e.preventDefault())
    listen('keydown', (e) => {
      if (!ctx.params.drag || !el.hasAttribute('tabindex')) return
      const x = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!x) return
      e.preventDefault()
      keyYaw += x * STEP
      ctx.invalidate()
    })
    const pointer = new Pointer(element, signal, () => ctx.invalidate(), true)
    const hoverable = matchMedia('(hover: hover)').matches

    let hover = 0
    let tiltX = 0
    let tiltY = 0
    return (now): boolean => {
      const p = ctx.params
      const reduced = now.reducedMotion
      const aspect = now.width > 0 && now.height > 0 ? now.width / now.height : built.aspect
      if (Math.abs(aspect - built.aspect) > built.aspect * 0.01 || p.pages !== built.pages) {
        pivot.remove(built.group)
        built.group.traverse((o) => (o as Mesh).geometry?.dispose())
        build(aspect, p.pages)
      }
      const aim = hoverable && !reduced ? pointer.aim(now) : undefined
      const hoverGoal = !reduced && (aim || pointer.focused) ? 1 : 0
      const aimX = aim && !grab ? aim[0] * p.tilt * DEG : 0
      const aimY = aim && !grab ? -aim[1] * p.tilt * DEG : 0
      const dt = Math.min(now.delta, MAX_STEP)
      const settle = (value: number, target: number, halfLife: number): number => {
        return damp(value, target, halfLife, dt, EPSILON)
      }
      if (hover !== hoverGoal) hover = settle(hover, hoverGoal, HOVER_HALF_LIFE)
      if (tiltX !== aimX) tiltX = settle(tiltX, aimX, TILT_HALF_LIFE)
      if (tiltY !== aimY) tiltY = settle(tiltY, aimY, TILT_HALF_LIFE)
      if (velocity && !grab) {
        yaw += velocity * dt
        velocity = Math.abs(velocity) < COAST_STOP ? 0 : damp(velocity, 0, COAST_HALF_LIFE, dt)
      }
      if (keyYaw) {
        const rest = reduced ? 0 : settle(keyYaw, 0, KEY_HALF_LIFE)
        yaw += keyYaw - rest
        keyYaw = rest
      }
      // Smoothstep of the hover: the swing starts and ends gently.
      const swing = hover * hover * (3 - 2 * hover)
      const turn = p.yaw * DEG + yaw + p.swing * DEG * swing + tiltX
      pivot.rotation.set(tiltY, turn, 0)
      // Picked up a little toward the viewer.
      pivot.position.z = -built.size.total / 2 + 0.04 * swing
      built.hinge.rotation.y = -Math.max(0, p.open) * DEG * swing
      const s = now.height || 1
      root.scale.setScalar(s * (0.96 + 0.04 * now.presence))
      ;(lines.value as Vector2).set(s / 2.2, built.size.block / 2)

      const { total } = built.size
      const wide = built.aspect * Math.abs(Math.cos(turn)) + total * Math.abs(Math.sin(turn))
      shade.set(
        wide * s * 0.92,
        s * 0.94,
        0.01 * s,
        0,
        -0.015 * s - swing * 0.01 * s,
        (0.045 + 0.04 * swing) * s,
        Math.max(0, Math.min(1, p.shadow)),
      )
      const busy =
        hover !== hoverGoal || tiltX !== aimX || tiltY !== aimY || velocity !== 0 || keyYaw !== 0
      if (swing > 0 && !reduced) ctx.pose(ctx.layer, { above: 1 }, swing)
      return busy
    }
  },
})
export default book
