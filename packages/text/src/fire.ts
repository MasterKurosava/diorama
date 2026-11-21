import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, inView, noise, palette } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  sRGBTransferEOTF,
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
  Color,
  DataTexture,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  type Node,
  RGBAFormat,
  type Texture,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { bake, catchTimes, type Fuel, type Grid, HeatMap, type Style } from './fire-field'
import { backdrop } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'

type Trigger = 'loop' | 'hover' | 'view' | 'scroll'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  strength: number
  height: number
  speed: number
  embers: number
  color: string
  char: number
  seed: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/** Frames a second while the fire burns. */
export const FPS = 30
/** Share of the box in view (above the bottom tenth) before the view trigger flares up. */
const SHOWN = 0.35
/** Most sparks in the air at the high tier. */
export const MAX_EMBERS = 400
/** Sparks a tier allows, as a share of the cap. */
const TIER = { low: 0.3, medium: 0.6, high: 1 } as const
/** Flame height of a style as a share of `height`. */
export const TALL: Readonly<Record<Style, number>> = { flame: 1, embers: 0.22, candle: 0.55 }
/** Sparks of a style as a share of `embers`: a candle sends up few. */
const SPARKS: Readonly<Record<Style, number>> = { flame: 1, embers: 1, candle: 0.3 }
/** Heat the embers style settles at after the view trigger's flare. */
const COALS = 0.7
/** Emission weights of natural fire: the red end burns first, then yellow, then white. */
const NATURAL: readonly [number, number, number] = [1, 0.42, 0.13]
const SOOT = [0.028, 0.02, 0.016] as const
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before baking again after a change, ms. */
const REDO_DELAY = 150
/** Hover: seconds a tap keeps the letters around it alight. */
const TAP_BURN = 1.4

// Attribute names become WGSL and GLSL identifiers: no keyword of either has a capital letter
// after the first.
const WICK = 'fireWick'
const HOME = 'fireHome'
const RAND = 'fireRand'
const MORE = 'fireMore'

/**
 * Heat of a unit `t` seconds after it catches with the view trigger, and whether it has settled:
 * flame flares up, burns and dies down; a candle lights, burns and goes out; coals flare and
 * settle at a steady glow.
 */
export function flare(style: Style, t: number): [number, boolean] {
  if (t <= 0) return [0, false]
  const ease = (k: number): number => k * k * (3 - 2 * k)
  if (style === 'embers') {
    if (t < 0.45) return [1.3 * (1 - (1 - t / 0.45) ** 2), false]
    if (t < 1.6) return [1.3 + (COALS - 1.3) * ease((t - 0.45) / 1.15), false]
    return [COALS, t >= 2.6]
  }
  if (style === 'candle') {
    if (t < 0.6) return [ease(t / 0.6), false]
    if (t < 3.2) return [1, false]
    if (t < 4.2) return [1 - ease((t - 3.2) / 1), false]
    return [0, true]
  }
  if (t < 0.35) return [1.45 * (1 - (1 - t / 0.35) ** 2), false]
  if (t < 1.25) return [1.45 - 0.45 * ease((t - 0.35) / 0.9), false]
  if (t < 2.4) return [1, false]
  if (t < 4) return [1 - ease((t - 2.4) / 1.6), false]
  return [0, true]
}

/** Heat of the scroll trigger: none while the box's middle is low in the viewport, full above 40%. */
export function scrolled(middle: number, viewport: number): number {
  const heat = (0.92 - middle / Math.max(1, viewport)) / 0.52
  return Math.min(1, Math.max(0, heat))
}

/**
 * Moves `value` toward `goal` with time constant `tau` s plus a slow steady pace, so it gets
 * there in finite time.
 */
export const toward = (value: number, goal: number, dt: number, tau: number): number => {
  const next = value + (goal - value) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)))
  const step = dt * 0.12
  return Math.abs(goal - next) <= step ? goal : next + Math.sign(goal - next) * step
}

/** The slow swell of the whole fire at time `t`, about ±0.2: incommensurate sines. */
export const swell = (t: number): number =>
  0.11 * Math.sin(t * 1.31) + 0.06 * Math.sin(t * 2.93 + 1) + 0.04 * Math.sin(t * 0.71 + 2)

/** sRGB channel 0..255 to linear. */
const linear = (v: number): number => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Lightness 0..1 of what the page paints behind the element; a picture counts as darkish. */
export function wallOf(element: Element): number {
  const back = backdrop(element)
  if (!back) return 1
  if (!back.color) return 0.3
  const packed = Number.parseInt(back.color.slice(1), 16)
  const [r, g, b] = [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255].map(linear) as [
    number,
    number,
    number,
  ]
  return Math.sqrt(0.2126 * r + 0.7152 * g + 0.0722 * b)
}

/** Emission weights from a CSS color, the brightest channel 1; natural fire without one. */
export function weights(hex: string | undefined): [number, number, number] {
  if (!hex) return [...NATURAL]
  const packed = Number.parseInt(hex.slice(1), 16)
  const channels = [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255].map(linear)
  const top = Math.max(1e-4, ...channels)
  return channels.map((v) => Math.max(0.03, v / top)) as [number, number, number]
}

/** Frames a second each phase asks for. */
const pacing = new WeakMap<AbortSignal, () => number>()

function halfTexture(grid: Grid): DataTexture {
  const map = new DataTexture(grid.data, grid.width, grid.height, RGBAFormat, HalfFloatType)
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.needsUpdate = true
  return map
}

function heatTexture(heat: HeatMap): DataTexture {
  const map = new DataTexture(heat.data, heat.width, heat.height)
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  map.colorSpace = NoColorSpace
  map.needsUpdate = true
  return map
}

function glyphTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  // Premultiplied, so mip levels and filtering do not darken edges.
  map.premultiplyAlpha = true
  return map
}

/** One quad, or one per instance with the given attributes. */
function quads(attributes: Readonly<Record<string, [Float32Array, number]>>, count: number) {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  for (const [name, [data, size]] of Object.entries(attributes))
    geometry.setAttribute(name, new InstancedBufferAttribute(data, size))
  geometry.instanceCount = count
  return geometry
}

/** The sparks: a spawn point and random numbers each, half in front of the text, half behind. */
function sparkAttributes(fuel: Fuel, seed: number): Record<string, [Float32Array, number]> {
  const home = new Float32Array(MAX_EMBERS * 4)
  const rand = new Float32Array(MAX_EMBERS * 4)
  const more = new Float32Array(MAX_EMBERS * 4)
  let state = (Math.round(seed) * 2654435761) >>> 0
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const spots = Math.max(1, Math.floor(fuel.spawns.length / 2))
  const candles = fuel.wicks.length / 4
  for (let i = 0; i < MAX_EMBERS; i++) {
    let x: number
    let y: number
    if (candles && (fuel.wicks[2] as number) >= 0) {
      const index = Math.floor(random() * candles) * 4
      x = fuel.wicks[index] as number
      y = fuel.wicks[index + 1] as number
    } else {
      const index = Math.floor(random() * spots) * 2
      x = fuel.spawns[index] as number
      y = fuel.spawns[index + 1] as number
    }
    // Every other spark behind the text: z in ems, the sign its side.
    const side = i % 2 ? 1 : -1
    home.set([x, y, side * (0.05 + random() * 0.9), side], i * 4)
    rand.set([random(), random(), random(), random()], i * 4)
    more.set([random(), random(), random(), random()], i * 4)
  }
  return { [HOME]: [home, 4], [RAND]: [rand, 4], [MORE]: [more, 4] }
}

/**
 * The letters burn: flames driven by the distance field of the glyphs rise from their tops, hot
 * white-yellow at the strokes, orange and red higher up, broken into tongues by noise carried
 * up through them; sparks drift up in front of and behind the text in depth; the fire lights
 * the page around the text and the tops of the strokes, and can char the letters where it burned.
 * The text stays in the DOM.
 */
const fire: Effect<Params> = defineEffect({
  name: 'fire',
  params: {
    style: oneOf('flame', 'embers', 'candle'),
    trigger: oneOf('loop', 'hover', 'view', 'scroll'),
    strength: 1,
    height: 0.9,
    speed: 1,
    embers: 30,
    color: '',
    char: 0.4,
    seed: 1,
  },
  rebuild: ['seed'],
  on: ':not(img, video, canvas, svg, input, textarea)',
  // Flames and sparks rise far above the box.
  bleed: 400,
  presence: 'custom',
  quality: { low: { embers: 10 }, medium: { embers: 20 } },
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const { style, trigger } = params
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    // The fire draws its own light: a text-shadow (a CSS fallback) is fine.
    const css = unsupported(element)
    const reason = (css === 'text-shadow' ? undefined : css) ?? (await fonts(element))
    const first = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    if (!first?.quads.length) {
      if (reason && DEV)
        app.log.warn(`fire: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    let layout: Raster = first
    let fuel = await bake(layout, style, ratio, params.seed)
    if (signal.aborted) return

    const hex = palette(params.color, element)[0]
    if (!hex && params.color.trim() && DEV)
      app.log.warn(`fire: "${params.color}" is not a color, the fire keeps its own`, element)
    const emission = weights(hex)
    const coolWeights = uniform(new Vector3(...emission.map((v) => v ** 3)))
    const hotWeights = uniform(new Vector3(...emission.map((v) => v ** 1.6)))
    // The color of the fire's light, its brightest channel 1.
    const glowMix = emission.map((v) => 1 - Math.exp(-1.65 * (v ** 1.8 + v ** 0.75)))
    const glowTop = Math.max(...glowMix)
    // The light on the page: deeper, as firelight on a wall reads.
    const ruddy = emission.map((v) => 1 - Math.exp(-2.2 * v ** 1.6))
    const ruddyTop = Math.max(...ruddy)
    const firelight = uniform(
      new Color(...(ruddy.map((v) => v / ruddyTop) as [number, number, number])),
    )
    const lamp = uniform(
      new Color(...(glowMix.map((v) => v / glowTop) as [number, number, number])),
    )

    const fontEm = uniform(fuel.em)
    const flameHeight = uniform(params.height * TALL[style] * fuel.em)
    const now = uniform(0)
    const pulse = uniform(0)
    const stroke = uniform(fuel.stroke)
    const tone = uniform(wallOf(element))
    // 0 hides the moving flames and the sparks: reduced motion, and coals that settled.
    const flames = uniform(1)
    const sparks = uniform(1)
    const fieldFrame = uniform(new Vector4(...fuel.field.frame))
    const plumeFrame = uniform(new Vector4(...fuel.plume.frame))
    const lightFrame = uniform(new Vector4(...fuel.light.frame))
    const rasterFrame = uniform(new Vector4(...layout.frame))
    let heat = new HeatMap(fuel.light.frame, fuel.em)
    const heatFrame = uniform(new Vector4(...heat.frame))

    const fieldMap = texture(halfTexture(fuel.field))
    const plumeMap = texture(halfTexture(fuel.plume))
    const lightMap = texture(halfTexture(fuel.light))
    const heatMap = texture(heatTexture(heat))
    const glyphMap = texture(glyphTexture(layout.canvas))
    const tile = noise(ctx, { size: 256, seed: params.seed, channels: 4 })
    const noiseMap = texture(tile)
    ctx.onDispose(() => {
      for (const node of [fieldMap, plumeMap, lightMap, heatMap, glyphMap])
        (node.value as Texture).dispose()
    })

    const half = u.size.mul(0.5) as unknown as V2
    const intensity = max(u.strength, 0) as unknown as F
    const low = ctx.quality === 'low'
    // Leaving a page the fire dies and the letters fade with it.
    const fade = clamp(u.presence.div(0.6), 0, 1) as unknown as F
    // Fragments that would add nothing are discarded: no blend, no write.
    const material = (): MeshBasicNodeMaterial =>
      new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        alphaTest: 1 / 510,
      })
    /** UV of a box point in a frame whose texture rows go bottom up. */
    const uvIn = (frame: V4, p: V2): V2 =>
      vec2(p.x.sub(frame.x).div(frame.z), p.y.sub(frame.y).div(frame.w).oneMinus()) as V2
    /** How far a box point lies outside a frame, px. */
    const past = (frame: V4, p: V2): F =>
      length(max(max(frame.xy.sub(p), p.sub(frame.xy.add(frame.zw))), vec2(0, 0))) as F
    /** The mask at the box edge half a pixel in, where it is whole, for points past the box. */
    const boxMask = (p: V2): F =>
      ctx.mask(
        vec2(
          clamp(p.x, 0.5, u.size.x.sub(0.5)).div(u.size.x),
          clamp(p.y, 0.5, u.size.y.sub(0.5)).div(u.size.y).oneMinus(),
        ),
      )
    const fieldBox = fieldFrame as unknown as V4
    const plumeBox = plumeFrame as unknown as V4
    const lightBox = lightFrame as unknown as V4
    const rasterBox = rasterFrame as unknown as V4
    const noiseAt = (uv: V2): V4 => noiseMap.sample(uv) as unknown as V4
    const field = (p: V2): V4 => fieldMap.sample(uvIn(fieldBox, p)) as unknown as V4
    /** Signed distance to the ink, px, also past the field, where it only grows. */
    const distanceAt = (p: V2): F => field(p).x.add(past(fieldBox, p)) as F
    const plumeAt = (p: V2): V4 => plumeMap.sample(uvIn(plumeBox, p)) as unknown as V4
    const heatAt = (p: V2): V4 =>
      heatMap.sample(uvIn(heatFrame as unknown as V4, p)) as unknown as V4
    const hot = (p: V2): F => heatAt(p).r.mul(1.5).mul(u.presence) as F
    /**
     * How the fire breathes along the text, about 0.5..1.4: the flames over a letter swell and
     * drop slowly, and the firelight and the glow of the strokes keep the same beat.
     */
    const breathAt = (x: F): F => {
      // Sines along the text (the noise tile is too fine for a line drawn across it) over the
      // slow swell of the whole fire, `pulse`.
      const along = x.div(fontEm)
      const wave1 = sin(along.mul(1.9).add(now.mul(2.3))).mul(0.2)
      const wave2 = sin(along.mul(0.83).sub(now.mul(1.7)).add(2)).mul(0.13)
      const wave3 = sin(along.mul(3.1).add(now.mul(4.1)).add(1)).mul(0.12)
      return clamp(pulse.add(0.95).add(wave1).add(wave2).add(wave3), 0.5, 1.4) as F
    }
    /** Fire of temperature `t`: the red end first, then yellow, white at the hottest. */
    const fireRGB = (t: F, gain: number): V3 => {
      const weightsAt = mix(coolWeights, hotWeights, smoothstep(0.15, 1, t))
      return vec3(1).sub(exp(weightsAt.mul(t.mul(gain)).negate())) as V3
    }
    const peakOf = (c: V3): F => max(c.x, max(c.y, c.z)) as F
    /**
     * Fire over the page as emitted light on a dark wall (alpha its brightness) and as saturated
     * paint with smoke on a light one, where light would not show.
     */
    const burn = (t: F, smoke: F): V4 => {
      const glow = fireRGB(t, 3)
      const peak = peakOf(glow)
      const darkA = clamp(peak.mul(1.1), 0, 1)
      const darkRGB = glow.div(max(peak, 1e-4))
      const paint = vec3(1).sub(
        exp(
          mix(coolWeights, hotWeights, smoothstep(0.5, 1.4, t))
            .mul(t.mul(2.4))
            .negate(),
        ),
      ) as V3
      const paintA = smoothstep(0.03, 0.32, t)
      const smokeA = smoke.mul(0.34)
      const lightA = paintA.add(smokeA.mul(paintA.oneMinus()))
      const lightRGB = mix(vec3(...SOOT).mul(4), paint, paintA.div(max(lightA, 1e-4)))
      return vec4(mix(darkRGB, lightRGB, tone), mix(darkA, lightA, tone)) as V4
    }

    // The page around the text, lit by the fire over the letters.
    const wall = material()
    {
      const corner = positionGeometry.xy.add(0.5) as unknown as V2
      // The light comes from the flames; without them, from the letters.
      const raise =
        style === 'embers' ? fontEm.mul(0.05) : flameHeight.mul(flames.mul(0.45).add(0.05))
      const px = mix(lightBox.x, lightBox.x.add(lightBox.z), corner.x)
      const py = mix(lightBox.y.add(lightBox.w), lightBox.y.sub(raise), corner.y)
      wall.positionNode = vec3(px.sub(half.x), half.y.sub(py), 0)
      const point = varying(vec2(px, py)) as unknown as V2
      const source = vec2(point.x, point.y.add(raise)) as V2
      const lit = lightMap.sample(uvIn(lightBox, source)) as unknown as V4
      // The heat of the nearest burning text: the light reaches past where its flames are.
      const heatHere = hot(
        vec2(
          clamp(source.x, fieldBox.x, fieldBox.x.add(fieldBox.z)),
          clamp(source.y, fieldBox.y, fieldBox.y.add(fieldBox.w)),
        ) as V2,
      )
      // Fades out before the edges of the light's frame, where its widest blur is cut.
      const inset = min(
        min(source.x.sub(lightBox.x), lightBox.x.add(lightBox.z).sub(source.x)),
        min(source.y.sub(lightBox.y), lightBox.y.add(lightBox.w).sub(point.y)),
      )
      const amount = lit.x
        .mul(0.35)
        .add(lit.y.mul(lit.y).mul(0.4))
        .add(lit.z.mul(lit.z).mul(0.35))
        .mul(
          min(heatHere, 1.3),
          intensity,
          breathAt(point.x),
          smoothstep(0, fontEm.mul(0.5), inset),
        )
      const glowA = clamp(amount, 0, 0.85).mul(mix(1, 0.4, tone))
      wall.colorNode = vec4(firelight, glowA.add(dither()).clamp(0, 1).mul(fade, boxMask(point)))
    }

    /** A quad over a frame of the box, with the box point of each fragment. */
    const over = (quadMaterial: MeshBasicNodeMaterial, frame: V4): V2 => {
      const corner = positionGeometry.xy.add(0.5) as unknown as V2
      const px = frame.x.add(corner.x.mul(frame.z))
      const py = frame.y.add(corner.y.oneMinus().mul(frame.w))
      quadMaterial.positionNode = vec3(px.sub(half.x), half.y.sub(py), 0)
      return varying(vec2(px, py)) as unknown as V2
    }

    // The letters, lit by the fire, glowing along the tops the flames leave, charred where it
    // burned; or coals with light in their cracks. They stand a hair off the page with the fire
    // above them: their soft shadow falls just below.
    const letters = material()
    {
      const point = over(
        letters,
        vec4(rasterBox.x, rasterBox.y, rasterBox.z, rasterBox.w.add(fontEm.mul(0.12))) as V4,
      )
      const inEm = point.div(fontEm)
      const glyph = glyphMap.sample(uvIn(rasterBox, point)) as unknown as V4
      const ink = glyph.w.mul(smoothstep(0, 0.5, past(rasterBox, point)).oneMinus())
      const base = sRGBTransferEOTF(glyph.xyz.div(max(glyph.w, 1e-4))) as V3
      const sdf = field(point)
      const edgeDistance = sdf.x
      const fuelHeight = sdf.w
      const heatSample = heatAt(point)
      const heatHere = heatSample.x.mul(1.5).mul(u.presence)
      const breath = breathAt(point.x)
      // A rounded bevel from the distance field, lit from the flames above.
      const bevel = max(min(stroke.mul(0.8), fontEm.mul(0.06)), 0.75)
      const across = clamp(edgeDistance.div(bevel).add(1), 0, 1)
      const normal = normalize(
        vec3(
          sdf.y.mul(across),
          sdf.z.negate().mul(across),
          sqrt(max(across.mul(across).oneMinus(), 0)).add(1e-3),
        ),
      )
      const swing = sin(point.x.div(fontEm.mul(1.7)).add(now.mul(0.9))).mul(0.25)
      const toFire = normalize(vec3(swing.mul(0.9), 1, 0.45))
      const facing = max(dot(normal, toFire), 0)
      const crown = exp(min(fuelHeight, 0).div(fontEm.mul(0.4)))
      const amount = heatHere.mul(intensity, breath)
      const rim = pow(facing, 2.5).mul(across, crown)
      const light = lamp.mul(amount.mul(rim.mul(1.8).add(crown.mul(0.25)).add(0.08)))
      // The tops the flames leave glow like embers: where the plume just above is strong.
      const open = clamp(
        plumeAt(vec2(point.x, point.y.sub(fontEm.mul(0.07))) as V2).x.mul(1.4),
        0,
        1,
      )
      const edge = exp(min(edgeDistance, 0).div(fontEm.mul(0.03)))
        .mul(smoothstep(fontEm.mul(0.02), 0, edgeDistance))
        .mul(open)
      let rgb: V3
      if (style === 'embers') {
        // Coal: a dark crust of the text color under grey ash, light through its cracks and
        // along its edges, pulsing slowly.
        const ash = noiseAt(inEm.mul(3.3).add(vec2(0.47, 0.13))).w
        const crust = mix(
          mix(base.mul(0.25), vec3(...SOOT), mix(0.7, 0.97, clamp(u.char, 0, 1))),
          vec3(0.1, 0.09, 0.085),
          smoothstep(0.55, 0.75, ash).mul(0.6),
        )
        const wide = noiseAt(inEm.mul(2.2).add(vec2(0.11, 0.53))).x
        const fine = noiseAt(inEm.mul(4.7).add(vec2(0.71, 0.29))).y
        const crack = max(
          smoothstep(0.006, 0.028, abs(wide.sub(0.5))).oneMinus(),
          smoothstep(0.004, 0.018, abs(fine.sub(0.5)))
            .oneMinus()
            .mul(0.55),
        )
        const deep = clamp(edgeDistance.negate().div(max(stroke, 1)), 0, 1)
        const outer = pow(across, 2.2)
        const glow = noiseAt(inEm.mul(0.35).add(vec2(now.mul(0.05), now.mul(0.13)))).z
        const pulse = clamp(glow.sub(0.5).mul(2.4).add(1), 0.35, 1.6)
        const temp = heatHere.mul(pulse, intensity, 0.6).mul(
          crack
            .mul(mix(0.55, 1.2, deep))
            .add(outer.mul(0.25))
            .add(pow(deep, 2).mul(0.04))
            .add(crown.mul(0.04))
            .add(edge.mul(0.5)),
        )
        rgb = crust.mul(float(1).add(light.mul(0.4))).add(fireRGB(temp as F, 3)) as V3
      } else {
        // Lit by the fire: light multiplies the letter's own color, so light text stays light.
        const lit = base
          .mul(float(1).sub(clamp(heatHere, 0, 1).mul(0.12)))
          .mul(vec3(1).add(light.mul(1.3)))
          .add(light.mul(0.06))
        // The heated face: the top of each stroke takes the fire's color.
        const warm = exp(min(fuelHeight, 0).div(fontEm.mul(0.16))).mul(
          clamp(heatHere, 0, 1),
          0.6,
          min(intensity, 1),
        )
        const heated = mix(lit, lit.mul(firelight).mul(1.15).add(firelight.mul(0.06)), warm)
        // Char: soot darkens the tops of the strokes, fading down into the letter.
        const depth = max(fuelHeight.negate(), 0)
        const grain = noiseAt(inEm.mul(0.6).add(vec2(0.31, 0.77))).w
        const charred = heatSample.y.mul(clamp(u.char, 0, 1)).mul(style === 'flame' ? 1 : 0)
        const scorch = charred.mul(fontEm.mul(0.35)).mul(grain.mul(0.8).add(0.6))
        const soot = smoothstep(scorch.add(fontEm.mul(0.02)), scorch.mul(0.3), depth).mul(
          smoothstep(0, 0.05, charred),
        )
        // The tops the flames leave glow like embers, also on light text.
        const ember = edge.mul(clamp(heatHere, 0, 1.2), intensity, breath).mul(1.3)
        const emberRGB = fireRGB(ember.add(0.25) as F, 3)
        rgb = mix(
          mix(heated, vec3(...SOOT), soot.mul(0.55)),
          emberRGB.div(max(peakOf(emberRGB), 1e-3)),
          smoothstep(0.05, 0.6, ember),
        ) as V3
      }
      const above = distanceAt(vec2(point.x, point.y.sub(fontEm.mul(0.06))) as V2)
      const shadow = smoothstep(fontEm.mul(-0.04), fontEm.mul(0.06), above)
        .oneMinus()
        .mul(clamp(heatHere, 0, 1), mix(0.4, 0.22, tone))
      const alpha = ink.add(shadow.mul(ink.oneMinus()))
      letters.colorNode = vec4(rgb.mul(ink).div(max(alpha, 1e-4)), alpha.mul(fade, boxMask(point)))
    }

    // The flames rise from the tops of the strokes through the plume, swayed and torn by noise
    // carried up with them, over the letters and the air above.
    const flame = material()
    if (style !== 'candle') {
      const reach = min(flameHeight.mul(2.1).add(fontEm.mul(0.35)), fieldBox.y.sub(plumeBox.y))
      const top = fieldBox.y.sub(reach)
      const point = over(
        flame,
        vec4(plumeBox.x, top, plumeBox.z, fieldBox.y.add(fieldBox.w).sub(top)) as V4,
      )
      const inEm = point.div(fontEm)
      // Ink coverage and the distance to it, coarse: enough for the flames.
      const coarse = plumeAt(point)
      const ink = coarse.z
      const time = now
      // The warp is anchored at the letters and grows with the distance from them: the base
      // hugs the strokes, the tongues sway and break higher up. Continuous past the plume, so
      // no tongue is cut where the plume ends.
      const lift = clamp(coarse.w.div(0.55), 0, 1)
      const sway1 = noiseAt(inEm.mul(vec2(0.13, 0.08)).add(vec2(time.mul(0.01), time.mul(0.075))))
      let warpX = sway1.x.sub(0.5).mul(1.6)
      let warpY = sway1.y.sub(0.5).mul(0.3)
      if (!low) {
        const sway2 = noiseAt(
          inEm.mul(vec2(0.3, 0.18)).add(vec2(time.mul(-0.006).add(0.5), time.mul(0.18))),
        )
        warpX = warpX.add(sway2.y.sub(0.5).mul(0.9))
        warpY = warpY.add(sway2.z.sub(0.5).mul(0.5))
      }
      const warped = point.add(vec2(warpX, warpY).mul(fontEm, lift)) as V2
      const plumeHere = plumeAt(warped)
      const strength = clamp(plumeHere.x, 0, 1)
      const lifted = plumeHere.y.div(max(plumeHere.x, 1e-3))
      const heatHere = hot(warped)
      // Each flame's length breathes with its place along the text and the heat of its letter.
      const flameReach = flameHeight
        .div(fontEm)
        .mul(breathAt(warped.x))
        .mul(mix(0.35, 1, clamp(heatHere, 0, 1)))
        .mul(max(heatHere.sub(1), 0).mul(0.6).add(1))
      const climb = lifted.div(max(flameReach, 1e-3))
      // Detail carried up faster than the sway: tongues that tear off at the tips.
      const warpedEm = warped.div(fontEm)
      let tear = noiseAt(warpedEm.mul(vec2(0.75, 0.21)).add(vec2(0.21, time.mul(0.25)))).w
      // Finer detail, and brighter and darker streaks drawn up through the body.
      let streaks: F = float(1)
      if (!low) {
        const fine = noiseAt(warpedEm.mul(vec2(1.45, 0.5)).add(vec2(0.63, time.mul(0.7))))
        tear = tear.mul(0.65).add(fine.x.mul(0.35))
        streaks = fine.y.mul(0.4).add(0.8) as F
      }
      const torn = clamp(tear.sub(0.5).mul(3).add(0.5), 0, 1)
      // Inside the flame above 0: thinner where the plume is weak, eaten from the tips.
      const inner = sqrt(strength)
        .mul(float(1).sub(climb.mul(pow(torn.oneMinus(), 2).mul(3.4).add(0.6))))
        .mul(smoothstep(2.2, 1.6, climb), smoothstep(0.02, 0.1, strength))
        // Dark gaps open between the tongues a little above the base.
        .mul(mix(1, smoothstep(0.15, 0.5, torn), smoothstep(0.06, 0.4, climb)))
      // A defined outline; white at the base, yellow, orange and red as it rises and cools.
      const temp = smoothstep(0, 0.16, inner)
        .mul(
          clamp(inner, 0, 1)
            .mul(0.45)
            .add(exp(climb.mul(-4)).mul(sqrt(strength), 1.3))
            .add(0.1),
        )
        .mul(torn.mul(0.5).add(0.75), streaks, mix(1, 0.5, smoothstep(0.5, 1.5, climb)))
        .mul(smoothstep(0.02, 0.25, heatHere), mix(0.85, 1.35, clamp(heatHere.sub(0.6), 0, 1)))
        .mul(intensity, flames)
        // Gone before the top of the pass.
        .mul(smoothstep(top, top.add(fontEm.mul(0.35)), point.y))
      // Smoke over the tips, shown on a light wall only.
      const smoke = pow(strength, 0.5)
        .mul(smoothstep(0.7, 1.3, climb), smoothstep(1.4, 2.4, climb).oneMinus(), torn)
        .mul(clamp(heatHere, 0, 1), flames, min(intensity, 1))
      const colour = burn(temp as F, smoke as F)
      // Over a stroke the flames thin out: the letter reads through them.
      flame.colorNode = vec4(colour.xyz, colour.w.mul(mix(1, 0.3, ink), fade, boxMask(point)))
    }

    // Candles: one flame on the top of each letter, swaying, with its glow.
    const candle = material()
    if (style === 'candle') {
      const wick = attribute(WICK, 'vec4') as unknown as V4
      const corner = positionGeometry.xy as unknown as V2
      const real = select(wick.z.greaterThanEqual(0), float(1), float(0))
      const quadWidth = flameHeight.mul(1.1)
      const quadHeight = flameHeight.mul(1.75)
      const px = wick.x.add(corner.x.mul(quadWidth).mul(real))
      const py = wick.y.sub(flameHeight.mul(0.62)).sub(corner.y.mul(quadHeight).mul(real))
      candle.positionNode = vec3(px.sub(half.x), half.y.sub(py), 0)
      const point = varying(vec2(px, py)) as unknown as V2
      const wickAt = varying(vec2(wick.x, wick.y)) as unknown as V2
      const random = varying(wick.w) as unknown as F
      const localX = point.x.sub(wickAt.x).div(flameHeight)
      const localY = wickAt.y.sub(point.y).div(flameHeight)
      const heatHere = hot(vec2(wickAt.x, wickAt.y.sub(fontEm.mul(0.05))) as V2)
      const sway = noiseAt(
        vec2(random.mul(5.3).add(now.mul(0.11)), random.mul(2.1).add(now.mul(0.07))),
      )
        .x.sub(0.5)
        .mul(2.6)
      const flick = noiseAt(vec2(random.mul(3.7).add(now.mul(0.03)), now.mul(0.9).add(random)))
        .y.sub(0.5)
        .mul(2)
      const size = smoothstep(0, 0.35, heatHere)
        .mul(min(heatHere, 1.4).mul(0.1).add(0.9))
        .mul(flick.mul(0.08).add(1))
      const flameY = localY.div(max(size, 1e-3))
      const flameX = localX.sub(sway.mul(0.09).mul(flameY, flameY)).div(max(size, 1e-3))
      const clampedY = clamp(flameY, 0, 1)
      const profile = pow(sin(pow(clampedY, 0.6).mul(Math.PI)), 0.85).mul(0.2)
      const radial = abs(flameX).div(max(profile, 1e-3))
      const body = smoothstep(0.5, 1, radial)
        .oneMinus()
        .mul(smoothstep(-0.02, 0.07, flameY))
        .mul(smoothstep(0.88, 1, flameY).oneMinus())
        .mul(smoothstep(0.01, 0.1, size))
      // The dark cone over the wick, the blue at the base, the bright body, the cooler tip.
      const inner = smoothstep(0.08, 0.42, flameY)
        .oneMinus()
        .mul(smoothstep(0, 0.6, radial).oneMinus())
      const blue = smoothstep(0.02, 0.24, flameY)
        .oneMinus()
        .mul(smoothstep(0.25, 0.9, radial))
        .mul(body)
      const temp = body
        .mul(float(1.3).sub(inner.mul(0.7)))
        .mul(float(1).sub(smoothstep(0.55, 1, flameY).mul(0.45)))
        .mul(intensity)
      const fireColour = burn(temp as F, float(0) as unknown as F)
      const glowDistance = length(vec2(localX.mul(1.5), localY.sub(size.mul(0.42))))
      const halo = exp(glowDistance.mul(glowDistance).mul(-9)).mul(
        0.32,
        size,
        intensity,
        mix(1, 0.4, tone),
      )
      const blueA = blue.mul(0.55).mul(tone.mul(0.5).oneMinus())
      const alpha = fireColour.w.add(halo.mul(fireColour.w.oneMinus()))
      const rgb = mix(lamp, fireColour.xyz, fireColour.w.div(max(alpha, 1e-4)))
        .mul(blueA.oneMinus())
        .add(vec3(0.18, 0.32, 1).mul(blueA))
      // The wick: a short dark stroke with a glowing tip, under the flame.
      const stem = smoothstep(0.01, 0.022, abs(localX))
        .oneMinus()
        .mul(smoothstep(-0.07, -0.05, localY))
        .mul(smoothstep(0.04, 0.06, localY).oneMinus())
      const tip = smoothstep(-0.01, 0.04, localY).mul(size)
      const stemRGB = mix(vec3(0.03, 0.025, 0.02), vec3(1, 0.35, 0.05), tip)
      const total = alpha.add(stem.mul(0.85).mul(alpha.oneMinus()))
      candle.colorNode = vec4(
        mix(stemRGB, rgb, alpha.div(max(total, 1e-4))),
        clamp(total, 0, 1).mul(fade, boxMask(wickAt)),
      )
    }

    // Sparks: glowing streaks that rise, drift and cool, in front of and behind the text.
    const spark = (side: number): MeshBasicNodeMaterial => {
      const sparkMaterial = material()
      const home = attribute(HOME, 'vec4') as unknown as V4
      const rand = attribute(RAND, 'vec4') as unknown as V4
      const more = attribute(MORE, 'vec4') as unknown as V4
      const slow = style === 'candle' ? 1.6 : 1
      const life = mix(1.1, 2.7, rand.x).mul(slow)
      const run = now.div(life).add(rand.y)
      const age = fract(run)
      const cycle = floor(run)
      const cycleRandom1 = hash(cycle.mul(7.13).add(more.w.mul(997)))
      const cycleRandom2 = hash(cycle.mul(3.71).add(more.z.mul(613)).add(17))
      const seconds = age.mul(life)
      const rise = fontEm
        .mul(mix(0.8, 2, rand.z))
        .div(slow)
        .mul(style === 'embers' ? 1.25 : 1)
      const up = rise.mul(seconds).mul(age.mul(-0.22).add(1))
      const drift = cycleRandom1.sub(0.5).mul(0.9).add(more.x.sub(0.5).mul(0.4)).mul(fontEm)
      const freq = mix(2, 5, more.y)
      const wob = sin(seconds.mul(freq).add(more.z.mul(6.283)))
        .mul(fontEm.mul(0.1))
        .mul(sqrt(age))
      const centreX = home.x
        .add(cycleRandom2.sub(0.5).mul(fontEm.mul(0.3)))
        .add(drift.mul(age))
        .add(wob)
      const centreY = home.y.sub(up)
      const z = home.z.add(cycleRandom2.sub(0.5).mul(0.4).mul(age)).mul(fontEm)
      const vx = drift
        .div(life)
        .add(
          sin(seconds.mul(freq).add(more.z.mul(6.283)).add(1.5708)).mul(
            freq,
            fontEm.mul(0.1),
            sqrt(age),
          ),
        )
      const vy = rise.mul(age.mul(-0.44).add(1))
      const speed = length(vec2(vx, vy))
      const heading = vec2(vx, vy).div(max(speed, 1e-3))
      const core = max(fontEm.mul(mix(0.009, 0.02, rand.w)), 1.1)
      // Out of focus away from the text: larger, softer, fainter.
      const blurPx = max(abs(z).sub(fontEm.mul(0.5)), 0).mul(0.04)
      const width = core.add(blurPx)
      const streakLength = width.add(speed.div(40))
      const pad = width.mul(1.4)
      const corner = positionGeometry.xy as unknown as V2
      const along = corner.x.mul(streakLength.add(pad.mul(2)))
      const across = corner.y.mul(width.add(pad.mul(2)))
      const mine = select(home.w.mul(side).greaterThan(0), float(1), float(0))
      const offsetX = heading.x.mul(along).sub(heading.y.mul(across)).mul(mine)
      const offsetY = heading.y.mul(along).add(heading.x.mul(across)).mul(mine)
      sparkMaterial.positionNode = vec3(
        centreX.sub(half.x).add(offsetX),
        half.y.sub(centreY).add(offsetY),
        z,
      )
      const local = varying(vec2(along, across)) as unknown as V2
      const vLength = varying(streakLength) as unknown as F
      const vWidth = varying(width) as unknown as F
      const streakDistance = length(
        vec2(max(abs(local.x).sub(vLength.sub(vWidth).mul(0.5)), 0), local.y),
      )
      const dotShape = exp(streakDistance.div(vWidth.mul(0.5)).pow(2).mul(-1.4))
      // The halo's tail ends inside the quad, so no square shows over the firelight.
      const rim = abs(varying(corner.mul(2)) as unknown as V2)
      const halo = exp(streakDistance.div(vWidth.mul(0.9)).negate()).mul(
        0.3,
        smoothstep(1, 0.6, max(rim.x, rim.y)),
      )
      const twinkle = sin(seconds.mul(23).add(more.w.mul(40)))
        .mul(0.25)
        .add(0.85)
      const fadeIn = smoothstep(0, 0.06, age)
      const temp = varying(
        pow(age.oneMinus(), 1.3).mul(twinkle, fadeIn, 1.6).mul(core.div(width).pow(2)),
      ) as unknown as F
      // The heat at the spark's home, read once per spark in the vertex stage.
      const heatHere = varying(hot(vec2(home.x, home.y) as V2)) as unknown as F
      const visible = smoothstep(more.w.mul(0.7), more.w.mul(0.7).add(0.25), heatHere).mul(
        sparks,
        intensity.min(1.5),
      )
      const colour = burn(temp.mul(dotShape.add(halo)) as F, float(0) as unknown as F)
      sparkMaterial.colorNode = vec4(
        colour.xyz,
        colour.w.mul(visible, fade, boxMask(varying(vec2(centreX, centreY)) as unknown as V2)),
      )
      return sparkMaterial
    }

    const one = (): InstancedBufferGeometry => quads({}, 1)
    const wallMesh = new Mesh(one(), wall)
    const letterMesh = new Mesh(one(), letters)
    const flameMesh = new Mesh(one(), flame)
    let sparkShape = quads(sparkAttributes(fuel, params.seed), 0)
    const sparksBack = new Mesh(sparkShape, spark(-1))
    const sparksFront = new Mesh(sparkShape, spark(1))
    const candleShape = (f: Fuel): InstancedBufferGeometry =>
      quads({ [WICK]: [f.wicks, 4] }, f.wicks.length / 4)
    const candles = new Mesh(candleShape(fuel), candle)
    const meshes = [wallMesh, sparksBack, letterMesh, flameMesh, candles, sparksFront]
    meshes.forEach((mesh, i) => {
      mesh.frustumCulled = false
      mesh.renderOrder = i
    })
    candles.visible = style === 'candle'
    flameMesh.visible = style !== 'candle'
    const group = new Group()
    group.add(...meshes)
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    // State of the burn, per unit: heat now, its goal and char.
    let units = Math.max(1, layout.units)
    let heatNow: Float32Array = new Float32Array(units)
    let goal: Float32Array = new Float32Array(units)
    let charNow: Float32Array = new Float32Array(units)
    let catches = catchTimes(layout.quads, units, params.seed, fuel.em)
    let painted = Number.NaN

    const use = (next: Raster, made: Fuel): void => {
      const swap = (node: { value: Texture }, value: Texture): void => {
        const old = node.value
        node.value = value
        old.dispose()
      }
      swap(fieldMap as unknown as { value: Texture }, halfTexture(made.field))
      swap(plumeMap as unknown as { value: Texture }, halfTexture(made.plume))
      swap(lightMap as unknown as { value: Texture }, halfTexture(made.light))
      swap(glyphMap as unknown as { value: Texture }, glyphTexture(next.canvas))
      heat = new HeatMap(made.light.frame, made.em)
      swap(heatMap as unknown as { value: Texture }, heatTexture(heat))
      heatFrame.value.set(...heat.frame)
      fieldFrame.value.set(...made.field.frame)
      plumeFrame.value.set(...made.plume.frame)
      lightFrame.value.set(...made.light.frame)
      rasterFrame.value.set(...next.frame)
      fontEm.value = made.em
      stroke.value = made.stroke
      tone.value = wallOf(element)
      const oldSparks = sparkShape
      sparkShape = quads(sparkAttributes(made, params.seed), oldSparks.instanceCount)
      sparksBack.geometry = sparksFront.geometry = sparkShape
      oldSparks.dispose()
      const oldCandles = candles.geometry
      candles.geometry = candleShape(made)
      oldCandles.dispose()
      if (next.units !== units) {
        units = Math.max(1, next.units)
        const grow = (a: Float32Array): Float32Array => {
          const b = new Float32Array(units)
          b.set(a.subarray(0, units))
          return b
        }
        heatNow = grow(heatNow)
        goal = grow(goal)
        charNow = grow(charNow)
      }
      catches = catchTimes(next.quads, units, params.seed, made.em)
      painted = Number.NaN
      layout = next
      fuel = made
      ctx.invalidate()
    }
    // Bake again when the text, its fonts or its width change.
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      if ((await fonts(element)) || signal.aborted) return
      const next = raster(element, 'letter', ratio)
      if (!next?.quads.length) return
      const made = await bake(next, style, ratio, params.seed)
      if (!signal.aborted) use(next, made)
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void redo(), REDO_DELAY)
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

    // Hover: the letters near a mouse catch fire; a tap lights those around it for a moment;
    // focus on the element or the link it sits in lights them all.
    let mouse: { x: number; y: number } | undefined
    let tap: { x: number; y: number; at: number } | undefined
    let focused = false
    if (trigger === 'hover') {
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      const opts = { signal }
      addEventListener(
        'pointermove',
        (e) => {
          if (e.pointerType === 'touch') return
          mouse = { x: e.clientX, y: e.clientY }
          ctx.invalidate()
        },
        { passive: true, signal },
      )
      const gone = (): void => {
        if (!mouse) return
        mouse = undefined
        ctx.invalidate()
      }
      document.documentElement.addEventListener('pointerleave', gone, opts)
      addEventListener('blur', gone, opts)
      target.addEventListener(
        'pointerdown',
        (e) => {
          if (e.pointerType !== 'touch') return
          tap = { x: e.clientX, y: e.clientY, at: performance.now() / 1000 }
          ctx.invalidate()
        },
        opts,
      )
      target.addEventListener(
        'focusin',
        () => {
          focused = true
          ctx.invalidate()
        },
        opts,
      )
      target.addEventListener(
        'focusout',
        (e) => {
          if (target.contains(e.relatedTarget as Element | null)) return
          focused = false
          ctx.invalidate()
        },
        opts,
      )
    }

    // Seconds since the burn started (loop: since first drawn; view: since it came into view).
    let since = -1
    let clock = 0
    let settled = false
    let rate = 0
    let dom = trigger !== 'loop'
    ctx.showDom(dom)
    pacing.set(signal, () => rate)

    /** Heat each unit wants from a point in box px within `radius`. */
    const near = (x: number, y: number, radius: number, out: Float32Array): void => {
      for (const quad of layout.quads) {
        const dx = Math.max(quad.x - x, 0, x - (quad.x + quad.width))
        const dy = Math.max(quad.y - y, 0, y - (quad.y + quad.height))
        const closeness = 1 - Math.min(1, Math.hypot(dx, dy) / radius)
        const want = closeness * closeness * (3 - 2 * closeness)
        if (want > (out[quad.order] as number)) out[quad.order] = want
      }
    }

    return (input) => {
      const p = ctx.params
      const reduced = input.reducedMotion
      const dt = Math.min(input.delta, 0.1)
      const em = fuel.em
      goal.fill(0)
      let release = 0.3
      let changing = false
      if (trigger === 'loop') {
        if (since < 0) since = 0
        else since += dt
        for (let i = 0; i < units; i++) goal[i] = reduced || since >= (catches[i] as number) ? 1 : 0
      } else if (trigger === 'hover') {
        release = 0.9
        if (mouse) near(mouse.x - input.x, mouse.y - input.y, em * 0.75, goal)
        if (tap) {
          const age = performance.now() / 1000 - tap.at
          if (age < TAP_BURN) {
            near(tap.x - input.x, tap.y - input.y, em * 1.3, goal)
            changing = true
          } else tap = undefined
        }
        if (focused) goal.fill(1)
      } else if (trigger === 'view') {
        release = 0.08
        if (since < 0) {
          if (inView(input.y, input.height, stage.height.peek(), SHOWN)) since = 0
        } else since += dt
        let done = since >= 0
        for (let i = 0; i < units; i++) {
          if (since < 0) break
          if (reduced) {
            goal[i] = style === 'embers' ? COALS : 1
            continue
          }
          const [v, still] = flare(style, since - (catches[i] as number))
          goal[i] = v
          done &&= still
        }
        if (style === 'embers' && since >= 0 && !reduced) {
          const last = Math.max(0, ...catches)
          flames.value = 1 - Math.min(1, Math.max(0, (since - last - 1.6) / 1))
          sparks.value = flames.value
          settled = done
        }
      } else {
        release = 0.3
        const level = scrolled(input.y + input.height / 2, stage.height.peek())
        goal.fill(level)
      }

      // Heat follows its goal: fast up, slower down; char follows heat slowly and recovers.
      let burning = false
      let any = false
      for (let i = 0; i < units; i++) {
        const target = goal[i] as number
        const was = heatNow[i] as number
        const next = reduced ? target : toward(was, target, dt, target > was ? 0.16 : release)
        heatNow[i] = next
        const charWas = charNow[i] as number
        const want = p.char > 0 && !reduced ? Math.min(1, next) : 0
        const nextChar = toward(charWas, want, dt, want > charWas ? 0.8 : 1.6)
        charNow[i] = nextChar
        if (next !== was || nextChar !== charWas || next !== target) changing = true
        if (next > 0.002) burning = true
        if (next > 0 || nextChar > 0) any = true
      }

      const tall = Math.max(0, p.height) * TALL[style] * em
      flameHeight.value = Math.max(1, tall)
      if (changing || tall !== painted) {
        painted = tall
        heat.paint(layout.quads, heatNow, charNow, tall * 2.7 + em * 0.6, em)
        ;(heatMap.value as Texture).needsUpdate = true
      }

      const moving = !reduced && !settled && p.speed > 0 && burning
      if (moving) clock += dt * p.speed
      now.value = clock + (p.seed % 97) * 3.1
      pulse.value = swell(now.value)
      if (reduced) {
        flames.value = style === 'candle' ? 1 : 0
        sparks.value = 0
      } else if (!(trigger === 'view' && style === 'embers')) {
        flames.value = 1
        sparks.value = 1
      }
      const count = Math.round(
        Math.min(MAX_EMBERS, Math.max(0, p.embers) * SPARKS[style] * TIER[ctx.quality]),
      )
      sparkShape.instanceCount = sparks.value > 0 ? count : 0

      const show = trigger !== 'loop' && !any && !settled
      if (show !== dom) {
        dom = show
        ctx.showDom(show)
      }
      rate = !show && (moving || (changing && !reduced)) ? FPS : 0
    }
  },
})
export default fire
