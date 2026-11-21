import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { palette, rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  clamp,
  cos,
  float,
  fwidth,
  instanceIndex,
  length,
  max,
  mix,
  mod,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  step,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  Vector2,
  Vector4,
} from 'three/webgpu'

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Style = 'snow' | 'petals' | 'leaves'
type Params = {
  style: ChoiceParam<Style>
  count: number
  scale: number
  speed: number
  wind: number
  color: string
  pile: number
  push: number
  fps: number
  seed: number
}

/** Flakes the instance buffer holds, after the one drift at index 0. */
export const POOL = 1500
/** Flakes start this far above the area and leave this far below it, px. */
const MARGIN = 40
/** Wind: px a second at wind 1, for the nearest flakes. */
const WIND = 60
/** Pointer: radius of the push in px, and how far a flake at its centre moves at push 1. */
const REACH = 110
const SHOVE = 38
/** Seconds the drift takes to build up from nothing; it starts at a third of its height. */
const BUILD = 30
/** The drift's quad is twice the drift's height plus this many px. */
const PILE_ROOM = 8

/** Per style: flake size px, fall px/s, sway px, sway rad/s, spin rad/s, default colours. */
const LOOK: Record<
  Style,
  {
    size: [number, number]
    fall: [number, number]
    sway: number
    rate: number
    spin: number
    colors: string
  }
> = {
  snow: { size: [5, 14], fall: [35, 95], sway: 14, rate: 1, spin: 0, colors: '#ffffff' },
  petals: {
    size: [14, 22],
    fall: [28, 62],
    sway: 34,
    rate: 0.8,
    spin: 1.6,
    colors: '#ffd3df #ffb8c9 #fff1f4 #f7a1b7',
  },
  leaves: {
    size: [15, 25],
    fall: [45, 95],
    sway: 46,
    rate: 0.7,
    spin: 1.2,
    colors: '#d9822b #b5521b #e8b04a #8c3b1a #c96a2a',
  },
}

/**
 * Snowflakes, petals or leaves drifting down over an element or over the whole page on `<body>`,
 * swaying in the wind, pushed aside by the pointer, with an optional drift of snow building up
 * at the bottom edge. One instanced draw over everything; the element is never hidden and clicks
 * go through. Under reduced motion nothing loads.
 */
const snow: Effect<Params> = defineEffect({
  name: 'snow',
  params: {
    style: oneOf('snow', 'petals', 'leaves'),
    count: 160,
    scale: 1,
    speed: 1,
    wind: 0.2,
    color: '',
    pile: 0,
    push: 0.5,
    fps: 30,
    seed: 1,
  },
  rebuild: ['seed'],
  reducedMotion: 'off',
  animate: { fps: (ctx) => ctx.params.fps },
  quality: { low: { count: 70, fps: 24 }, medium: { count: 110 } },
  async setup(ctx: EffectContext<Params>) {
    const { params, u, element, app, signal } = ctx
    const style = params.style
    const look = LOOK[style]
    const random = rng(params.seed)
    const page = element === document.body || element === document.documentElement
    const listed = palette(params.color, element)
    const colors = (listed.length ? listed : palette(look.colors, element)).map(
      (hex) => new Color(hex),
    )

    // Per instance, three vec4 attributes; index 0 is the drift, not a flake.
    // flake: x, y in the area (0..1), depth 0 far .. 1 near, phase.
    // turn: size px, fall px/s, spin rad/s, sway rad/s.
    // tint: linear rgb, shape variant 0..1.
    const total = 1 + POOL
    const flake = new Float32Array(total * 4)
    const turn = new Float32Array(total * 4)
    const tint = new Float32Array(total * 4)
    for (let i = 1; i < total; i++) {
      const at = i * 4
      const depth = random() ** 1.2
      flake[at] = random()
      flake[at + 1] = random()
      flake[at + 2] = depth
      flake[at + 3] = random() * Math.PI * 2
      const nearness = 0.55 + 0.75 * depth
      turn[at] = (look.size[0] + (look.size[1] - look.size[0]) * random() ** 2) * nearness
      turn[at + 1] = (look.fall[0] + (look.fall[1] - look.fall[0]) * random()) * (0.6 + 0.4 * depth)
      turn[at + 2] = (random() < 0.5 ? -1 : 1) * look.spin * (0.4 + 0.6 * random())
      turn[at + 3] = look.rate * (0.6 + 0.8 * random())
      const picked = colors[Math.floor(random() * colors.length)] as Color
      tint[at] = picked.r
      tint[at + 1] = picked.g
      tint[at + 2] = picked.b
      tint[at + 3] = random()
    }
    const quad = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))
    geometry.setAttribute('uv', quad.getAttribute('uv'))
    geometry.setAttribute('flake', new InstancedBufferAttribute(flake, 4))
    geometry.setAttribute('turn', new InstancedBufferAttribute(turn, 4))
    geometry.setAttribute('tint', new InstancedBufferAttribute(tint, 4))
    quad.dispose()
    const instances = (): number => 1 + Math.min(POOL, Math.max(0, Math.round(params.count)))
    geometry.instanceCount = instances()

    const clock = uniform(0)
    const fall = uniform(0)
    const blow = uniform(0)
    // Left and top edge of the area in world px (y up), its width and height in px.
    const area = uniform(new Vector4())
    const pointer = uniform(new Vector2())
    const shove = uniform(0)
    const drift = uniform(0)

    // Each flake: falling and blown along, wrapped around the area with a margin.
    const flakeData = attribute('flake', 'vec4')
    const turnData = attribute('turn', 'vec4')
    const tintData = attribute('tint', 'vec4')
    const depth = flakeData.z
    const wrapWidth = area.z.add(MARGIN * 2)
    const wrapHeight = area.w.add(MARGIN * 2)
    const sway = sin(clock.mul(turnData.w).add(flakeData.w))
      .mul(look.sway)
      .mul(mix(0.5, 1, depth))
    const x = mod(
      flakeData.x.mul(wrapWidth).add(blow.mul(WIND).mul(mix(0.45, 1, depth))),
      wrapWidth,
    )
      .sub(MARGIN)
      .add(sway)
    const y = mod(flakeData.y.mul(wrapHeight).add(fall.mul(turnData.y)), wrapHeight).sub(MARGIN)
    let center = vec2(area.x.add(x), area.y.sub(y)) as unknown as Vec2
    // The pointer pushes nearby flakes aside, more the closer they are.
    const fromPointer = center.sub(pointer)
    const pushed = smoothstep(REACH, 0, length(fromPointer)).mul(shove).mul(SHOVE)
    center = center.add(normalize(fromPointer.add(vec2(1e-3, 0))).mul(pushed)) as unknown as Vec2
    // Petals and leaves spin and tumble: the quad narrows as it turns edge-on.
    const angle = flakeData.w.add(clock.mul(turnData.z))
    const flip = max(abs(cos(clock.mul(turnData.w.mul(1.7)).add(flakeData.w.mul(2)))), 0.2)
    const corner = positionGeometry.xy.mul(turnData.x)
    const tumble = style === 'snow' ? float(1) : flip
    const tumbledX = corner.x.mul(tumble)
    const rotated = vec2(
      tumbledX.mul(cos(angle)).sub(corner.y.mul(sin(angle))),
      tumbledX.mul(sin(angle)).add(corner.y.mul(cos(angle))),
    )
    const flakePosition = center.add(style === 'snow' ? corner : rotated)

    // The drift: one quad along the bottom edge of the area, index 0.
    const pileHeight = drift.mul(2).add(PILE_ROOM)
    const pilePosition = vec2(
      area.x.add(positionGeometry.x.add(0.5).mul(area.z)),
      area.y.sub(area.w).add(positionGeometry.y.add(0.5).mul(pileHeight)),
    )
    const isPile = select(instanceIndex.equal(uint(0)), 1, 0)
    const position = mix(flakePosition, pilePosition, isPile)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
    material.forceSinglePass = true
    material.positionNode = vec3(position, 0)
    // Px from the area's top left, for the clip and for the flakes that land on the drift.
    const local = varying(vec2(position.x.sub(area.x), area.y.sub(position.y)))
    const vPile = varying(isPile)
    const vDepth = varying(depth)
    const vTint = varying(tintData)
    const vPileHeight = varying(pileHeight)
    const vDrift = varying(drift)

    const point = uv().sub(0.5)
    /** Antialiased coverage of a signed distance, positive inside. */
    const coverage = (distance: Float): Float =>
      clamp(distance.div(max(fwidth(distance), 1e-4)).add(0.5), 0, 1) as unknown as Float
    let shape: Float
    let shade: Float
    if (style === 'snow') {
      // Soft round flakes; near ones larger and softer, like out of focus.
      const radius = length(point).mul(2)
      shape = float(1).sub(smoothstep(mix(0.55, 0.05, vDepth), 1, radius)) as unknown as Float
      shade = float(1) as unknown as Float
    } else if (style === 'petals') {
      // An oval with a notch at its tip, lighter at the heart.
      const oval = length(point.mul(vec2(1.9, 1.15)))
      const notch = length(point.sub(vec2(0, 0.5))).sub(0.13)
      shape = coverage(float(0.5).sub(oval)).mul(coverage(notch)) as unknown as Float
      shade = mix(1.12, 0.86, oval.mul(2)) as unknown as Float
    } else {
      // A pointed leaf with a darker midrib and a short stem.
      const along = point.y.mul(2)
      const halfWidth = float(0.36).mul(float(1).sub(along.mul(along)).max(0).pow(0.8))
      const blade = coverage(halfWidth.sub(abs(point.x)))
      const stem = coverage(float(0.025).sub(abs(point.x))).mul(step(point.y, -0.42))
      shape = max(blade, stem) as unknown as Float
      shade = mix(0.72, 1, smoothstep(0.012, 0.05, abs(point.x))).mul(
        mix(1.08, 0.9, point.y.add(0.5)),
      ) as unknown as Float
    }
    const depthAlpha = style === 'snow' ? mix(0.45, 0.95, vDepth) : mix(0.75, 1, vDepth)
    // Flakes that reach the drift settle into it, a little below its average top.
    const ground = vPileHeight.sub(PILE_ROOM).mul(0.5).mul(0.7)
    const landed = float(1).sub(
      smoothstep(area.w.sub(ground).sub(2), area.w.sub(ground).add(4), local.y),
    )
    const flakeAlpha = shape.mul(depthAlpha).mul(select(vDrift.greaterThan(0), landed, 1))
    const flakeRgb = vTint.xyz.mul(shade)

    // The drift's top: two slow waves, never quite flat.
    const pileTop = vDrift.mul(
      sin(local.x.mul(0.011).add(1.3))
        .mul(0.15)
        .add(sin(local.x.mul(0.029).add(0.4)).mul(0.1))
        .add(0.75),
    )
    const aboveBottom = area.w.sub(local.y)
    const pileAlpha = coverage(pileTop.sub(aboveBottom)).mul(step(0.5, vDrift))
    // Shaded blue at the bottom, white at the top.
    const pileRgb = mix(
      vec3(0.8, 0.86, 0.95),
      vec3(1),
      smoothstep(0, max(pileTop, 1), aboveBottom).mul(0.6).add(0.4),
    )

    const inside = step(0, local.x)
      .mul(step(local.x, area.z))
      .mul(step(0, local.y))
      .mul(step(local.y, area.w))
    const rgb = mix(flakeRgb, pileRgb, vPile)
    const alpha = mix(flakeAlpha, pileAlpha, vPile).mul(inside).mul(u.presence)
    material.colorNode = vec4(rgb, alpha)

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    ctx.overlay.add(mesh)
    await ctx.compile(mesh)
    if (signal.aborted) return

    let elapsed = 0
    return (input: EffectInput) => {
      geometry.instanceCount = instances()
      const viewWidth = app.stage.width.peek()
      const viewHeight = app.stage.height.peek()
      const [left, top, width, height] = page
        ? [0, 0, viewWidth, viewHeight]
        : [input.x, input.y, input.width, input.height]
      ;(area.value as Vector4).set(left - viewWidth / 2, viewHeight / 2 - top, width, height)
      const dt = params.fps > 0 ? input.delta : 0
      clock.value = (clock.value as number) + dt
      fall.value = (fall.value as number) + dt * params.speed
      blow.value = (blow.value as number) + dt * params.wind
      elapsed += dt
      drift.value =
        style === 'snow' ? Math.max(0, params.pile) * Math.min(1, 0.35 + elapsed / BUILD) : 0
      // The pointer is read only when it pushes: a read draws a frame per move.
      const hover = params.push > 0 ? input.hover : 0
      shove.value = hover * params.push
      if (hover > 0) (pointer.value as Vector2).set(input.pointerWorld.x, input.pointerWorld.y)
    }
  },
})
export default snow
