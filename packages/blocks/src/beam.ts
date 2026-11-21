import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp, radii, roundedBox } from '@dioramajs/effects/kit'
import {
  abs,
  atan,
  clamp,
  exp,
  fwidth,
  max,
  min,
  mix,
  mod,
  positionGeometry,
  pow,
  select,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
} from 'three/webgpu'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Params = {
  motion: ChoiceParam<'loop' | 'pulse' | 'hover'>
  color: ColorParam
  color2: ColorParam
  length: number
  speed: number
  thickness: number
  glow: number
  fps: number
}

/** Reach of the glow past the line at glow 1, px. */
const REACH = 12
/** Visibility bleed: the line at its widest plus the glow at its strongest. */
const BLEED = 48
/** The hover beam fades in and out over this time, s. */
const FADE = 0.25
/** Opacity of the still border under reduced motion. */
const FAINT = 0.4
/** Pulse: the shortest rest between two sweeps, s, and the rest as a share of a sweep. */
const REST = 0.8
const REST_SHARE = 0.6

const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Phases with their rate of time frames, read by the frame policy. */
const rates = new WeakMap<AbortSignal, () => number>()

/** Length in px of the border of a box `width` x `height` with corner radius `r`. */
export function perimeter(width: number, height: number, r: number): number {
  const corner = Math.max(0, Math.min(r, width / 2, height / 2))
  return 2 * (width - 2 * corner) + 2 * (height - 2 * corner) + 2 * Math.PI * corner
}

/** The largest corner radius of an element in px, at most half its shorter side. */
export function radiusOf(element: Element, width: number, height: number): number {
  return Math.max(...radii(element, width, height))
}

/**
 * Where the two pulse beams are `clock` s into the loop: the distance each has run from the top
 * middle, px, and their opacity. They run half the border, meet at the bottom and rest.
 */
export function pulseAt(
  clock: number,
  speed: number,
  around: number,
): { head: number; envelope: number } {
  if (speed <= 0 || around <= 0) return { head: 0, envelope: 0 }
  const sweep = around / 2 / speed
  const period = sweep + Math.max(REST, sweep * REST_SHARE)
  const time = clock % period
  if (time >= sweep) return { head: around / 2, envelope: 0 }
  const progress = time / sweep
  // In over the first 12 % of the sweep, out over the last 30 %.
  const rise = Math.min(1, progress / 0.12)
  const fall = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3
  const ease = (x: number) => x * x * (3 - 2 * x)
  return { head: time * speed, envelope: ease(rise) * ease(Math.max(0, fall)) }
}

/**
 * A picture frame of two rings of four corners: x, y at ±0.5 of the box, z +1 on the outer ring
 * and -1 on the inner one. The vertex shader pushes the rings out and in by px, so the inside of
 * a large card is never shaded.
 */
function frame(): BufferGeometry {
  const corners = [-0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5]
  const position = new Float32Array(24)
  for (let i = 0; i < 8; i++) {
    position[i * 3] = corners[(i % 4) * 2] as number
    position[i * 3 + 1] = corners[(i % 4) * 2 + 1] as number
    position[i * 3 + 2] = i < 4 ? 1 : -1
  }
  const index: number[] = []
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    // Counter-clockwise from the front: the ring runs clockwise.
    index.push(i, 4 + j, j, i, 4 + i, 4 + j)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  geometry.setIndex(index)
  return geometry
}

/**
 * Distance in px along the border from the top middle, clockwise on screen, to the point of the
 * border nearest `p` (y up): the top half edge, the corner arc, the side half edge, mirrored into
 * the other quadrants.
 */
function alongBorder(p: Vec2, half: Vec2, r: Float): Float {
  // Half lengths of the straight parts of the top and side edges.
  const straightX = max(half.x.sub(r), 0)
  const straightY = max(half.y.sub(r), 0)
  const foldedX = abs(p.x)
  const foldedY = abs(p.y)
  // Relative to the centre of the corner arc.
  const cornerX = foldedX.sub(straightX)
  const cornerY = foldedY.sub(straightY)
  const arc = r.mul(Math.PI / 2)
  const onCorner = straightX.add(r.mul(atan(cornerX, cornerY)))
  const onTop = min(foldedX, straightX)
  const onSide = straightX.add(arc).add(clamp(cornerY.negate(), 0, straightY))
  const inQuarter = select(
    cornerX.greaterThan(0).and(cornerY.greaterThan(0)),
    onCorner,
    select(cornerY.greaterThan(cornerX), onTop, onSide),
  )
  const quarter = straightX.add(arc).add(straightY)
  return select(
    p.x.greaterThanEqual(0),
    select(p.y.greaterThanEqual(0), inQuarter, quarter.mul(2).sub(inQuarter)),
    select(p.y.lessThan(0), quarter.mul(2).add(inQuarter), quarter.mul(4).sub(inQuarter)),
  ) as unknown as Float
}

/**
 * A short bright beam with a soft trail runs around the element's rounded border, like the border
 * beam of SaaS feature cards and highlighted inputs: all the time, in pulses from the top, or
 * while hovered and focused. The element stays DOM; the light draws over its edge.
 */
const beam: Effect<Params> = defineEffect({
  name: 'beam',
  params: {
    motion: oneOf('loop', 'pulse', 'hover'),
    color: color('#ffaa40'),
    color2: color('#9c40ff'),
    length: 240,
    speed: 200,
    thickness: 2,
    glow: 0.8,
    fps: 60,
  },
  bleed: BLEED,
  quality: { low: { fps: 30 }, medium: { fps: 45 } },
  animate: { fps: (ctx) => rates.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, u, element } = ctx
    const motion = params.motion

    const radius = uniform(0)
    const head = uniform(0)
    const around = uniform(1)
    const level = uniform(motion === 'hover' ? 0 : 1)
    const size = u.size as unknown as Vec2
    const half = size.mul(0.5)
    const lineWidth = max(u.thickness, 0.5) as unknown as Float
    const reach = max(u.glow, 0).mul(REACH).add(1)
    // Outer ring past the line and its glow, inner ring past the corner arcs.
    const pad = lineWidth.add(reach.mul(1.5)).add(2)
    const inset = min(radius.add(lineWidth).add(reach.mul(1.5)).add(2), min(half.x, half.y))
    const ring = positionGeometry.xy as unknown as Vec2
    const push = select(positionGeometry.z.greaterThan(0), pad, inset.negate())
    const vertex = ring.mul(size).add(ring.mul(2).mul(push))
    // Px from the box centre, y up.
    const local = varying(vertex) as unknown as Vec2

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(vertex.div(max(size, 1)), 0)

    const corner = min(radius, min(half.x, half.y)) as unknown as Float
    const distance = roundedBox(local, half, corner)
    // The line lies just inside the edge, where a CSS border would be.
    const fromLine = abs(distance.add(lineWidth.mul(0.5))).sub(lineWidth.mul(0.5))
    const pixel = max(fwidth(distance), 1e-4)
    const line = clamp(fromLine.negate().div(pixel).add(0.5), 0, 1)
    // The glow falls inside the card at half strength: it reads as light on the edge, not a shade.
    const inner = select(distance.lessThan(lineWidth.negate()), 0.45, 1)
    const halo = exp(max(fromLine, 0).negate().mul(3).div(reach)).mul(min(u.glow, 2), 0.7, inner)
    const position = alongBorder(local, half, corner)
    const total = max(around, 1)
    const trailLength = max(u.length, 1)
    // The head fades in over its glow, so the glow never ends in a hard edge.
    const lead = lineWidth.mul(2).add(4).add(reach.mul(0.6))
    /** Brightness and gradient position of a beam whose trail runs `back` px behind it. */
    const trail = (back: Float, ran?: Float): [Float, Float] => {
      // A slow falloff: the tail in the second color still reads on a dark card.
      let brightness = pow(clamp(back.div(trailLength).oneMinus(), 0, 1), 0.65)
      const front = smoothstep(lead, 0, total.sub(back))
      // A pulse beam has no trail behind where it set off.
      if (ran) brightness = brightness.mul(clamp(ran.sub(back).div(reach.add(6)), 0, 1))
      // The glint ahead of the head keeps the head's color.
      const shade = select(total.sub(back).lessThan(lead), 0, clamp(back.div(trailLength), 0, 1))
      return [max(brightness, front) as unknown as Float, shade as unknown as Float]
    }
    let bright: Float
    let shade: Float
    if (motion === 'pulse') {
      // Two beams from the top middle, one each way round.
      const [rightBright, rightShade] = trail(
        mod(head.sub(position), total) as unknown as Float,
        head,
      )
      const [leftBright, leftShade] = trail(
        mod(position.add(head), total) as unknown as Float,
        head,
      )
      bright = max(rightBright, leftBright) as unknown as Float
      shade = select(
        rightBright.greaterThanEqual(leftBright),
        rightShade,
        leftShade,
      ) as unknown as Float
    } else {
      ;[bright, shade] = trail(mod(head.sub(position), total) as unknown as Float)
    }
    const tint = mix(u.color, u.color2, shade)
    // A whiter core right at the head.
    const core = pow(bright, 6).mul(0.45)
    const lit = mix(tint, vec3(1), core)
    const moving = line.add(halo.mul(line.oneMinus())).mul(bright)
    // Under reduced motion: the whole border, faint, in the gradient around it.
    const still = line.mul(FAINT)
    // The still gradient runs from the top to the bottom on both sides: no seam at the top.
    const fromTop = abs(position.div(total).mul(2).sub(1)).oneMinus()
    const rgb = mix(mix(u.color, u.color2, fromTop), lit, u.motion)
    const alpha = mix(still, moving, u.motion)
    material.colorNode = vec4(rgb, clamp(alpha, 0, 1).mul(level, u.opacity))

    const mesh = new Mesh(frame(), material)
    mesh.frustumCulled = false
    mesh.visible = motion !== 'hover'
    ctx.place(mesh)

    let travel = 0
    let clock = 0
    let shown = motion === 'hover' ? 0 : 1
    let over = false
    let focused = false
    const wanted = (): boolean => motion !== 'hover' || over || focused
    rates.set(signal, () => (wanted() || shown > 0 ? params.fps : 0))
    if (motion === 'hover') {
      const on = (type: string, fn: (e: Event) => void): void =>
        element.addEventListener(type, fn, { signal, passive: true })
      on('pointerenter', () => {
        over = true
        ctx.invalidate()
      })
      on('pointerleave', () => {
        over = false
        ctx.invalidate()
      })
      // A field typed into keeps its beam while focused, whatever the pointer does.
      on('focusin', () => {
        focused = true
        ctx.invalidate()
      })
      on('focusout', (e) => {
        const next = (e as FocusEvent).relatedTarget as Element | null
        focused = !!next && element.contains(next)
        ctx.invalidate()
      })
    }

    let measured = ''
    return (input) => {
      const { width, height, delta } = input
      const still = input.reducedMotion
      const key = `${width}|${height}`
      if (key !== measured) {
        measured = key
        radius.value = radiusOf(element, width, height)
      }
      const total = perimeter(width, height, radius.value as number)
      around.value = total
      const goal = wanted() ? 1 : 0
      shown = still ? goal : damp(shown, goal, FADE, delta, 0.002)
      mesh.visible = shown > 0
      level.value = shown
      if (!mesh.visible) return
      if (!still && params.fps > 0) {
        clock += delta
        travel = (travel + delta * Math.max(0, params.speed)) % Math.max(total, 1)
      }
      if (motion === 'pulse') {
        const at = pulseAt(clock, params.speed, total)
        head.value = at.head
        level.value = still ? 1 : at.envelope
      } else head.value = travel
    }
  },
})
export default beam
