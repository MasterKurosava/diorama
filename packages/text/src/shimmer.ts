import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, dither, ease, fresnel, inView, mixOklab } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  floor,
  fract,
  hash,
  max,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
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
  DataUtils,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  RepeatWrapping,
  RGBAFormat,
  type Texture,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { fonts, type Raster, raster, unsupported } from './raster'
import { type Relief, relief, reliefTexture } from './relief'

type F = Node<'float'>
type V3 = Node<'vec3'>
type Style = 'chrome' | 'gold' | 'holo' | 'glass'
type Trigger = 'hover' | 'loop' | 'view' | 'pointer'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  colors: string
  bevel: number
  angle: number
  width: number
  speed: number
  strength: number
  follow: number
  shadow: number
}

/** Seconds a sweep of the light takes at speed 1, and the rest between two in a loop. */
const SWEEP = 1.4
const PAUSE = 2.8
/** Share of the box in view (above the bottom tenth) before trigger view sweeps. */
const SHOWN = 0.5
/** Seconds the reflections take to follow the pointer, and the pointer light to move. */
const FOLLOW = 0.18
const TRACK = 0.12

// Attribute names become WGSL and GLSL identifiers: no keyword of either has a capital letter
// after the first.
/** Instance attribute: the row's quad in box px, x, y, width, height. */
const ROW = 'shimmerRow'
/** Instance attribute: the middle of the row's line (box px, y down) and its font size. */
const LINE = 'shimmerLine'

/** The studio a style reflects, in linear RGB, and how round each line of letters is. */
interface Look {
  /** Sky straight up, sky at the horizon, floor at the horizon, floor far below. */
  readonly zenith: readonly [number, number, number]
  readonly sky: readonly [number, number, number]
  readonly ground: readonly [number, number, number]
  readonly floor: readonly [number, number, number]
  /** Blur of the horizon: 0 is a mirror. */
  readonly soft: number
  /** Brightness of the softbox overhead, the strips at the sides and the band over the horizon. */
  readonly strip: number
  readonly side: number
  readonly glow: number
  /** Brightness of a soft card low in front, lighting the bottom of the letters. */
  readonly bounce: number
  /** How far each line bends back top and bottom, like lettering on a cylinder. */
  readonly curve: number
}

const LOOKS: Readonly<Record<Style, Look>> = {
  chrome: {
    zenith: [0.13, 0.19, 0.33],
    sky: [0.96, 0.98, 1],
    ground: [0.01, 0.011, 0.014],
    floor: [0.2, 0.19, 0.18],
    soft: 0.012,
    strip: 1.5,
    side: 0.85,
    glow: 0.55,
    bounce: 0.5,
    curve: 0.55,
  },
  gold: {
    zenith: [0.32, 0.3, 0.27],
    sky: [1, 0.97, 0.9],
    ground: [0.03, 0.02, 0.012],
    floor: [0.3, 0.25, 0.2],
    soft: 0.06,
    strip: 1.2,
    side: 0.75,
    glow: 0.35,
    bounce: 0.4,
    curve: 0.5,
  },
  holo: {
    zenith: [0.5, 0.52, 0.58],
    sky: [0.95, 0.95, 0.97],
    ground: [0.2, 0.2, 0.23],
    floor: [0.4, 0.4, 0.43],
    soft: 0.16,
    strip: 0.6,
    side: 0.4,
    glow: 0.2,
    bounce: 0.2,
    curve: 0.4,
  },
  glass: {
    zenith: [0.22, 0.27, 0.36],
    sky: [1, 1, 1],
    ground: [0.02, 0.02, 0.025],
    floor: [0.14, 0.14, 0.15],
    soft: 0.03,
    strip: 1.3,
    side: 1,
    glow: 0.3,
    bounce: 0.3,
    curve: 0.3,
  },
}

/** Reflectance of gold head-on, linear. */
const GOLD: readonly [number, number, number] = [1, 0.74, 0.31]
/** The key light of the studio, toward it from the letters: up, left and in front. */
const KEY = new Vector2(-0.45, 0.8)

/** Phases with the light moving or the reflections settling: frames a second for the policy. */
const pacing = new WeakMap<AbortSignal, () => number>()

/** A CSS color as `#rrggbb`: var() and currentColor are read from the element. */
function colorOf(value: string, element: Element): string | undefined {
  const style = getComputedStyle(element)
  let word = value.trim()
  for (let depth = 0; depth < 8; depth++) {
    const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/is.exec(word)
    if (!variable) break
    word = style.getPropertyValue(variable[1] as string).trim() || (variable[2] ?? '').trim()
  }
  if (!word || word.toLowerCase() === 'currentcolor') {
    const fill = style.getPropertyValue('-webkit-text-fill-color')
    word = fill && !/^(transparent|rgba\(.*,\s*0\))$/.test(fill) ? fill : style.color
  }
  return cssColor(word)
}

/** The words of a color list: spaces or commas apart, outside parentheses. */
export const split = (text: string): string[] =>
  text
    .trim()
    .split(/[\s,]+(?![^(]*\))/)
    .filter(Boolean)

/** The colors as a ramp that comes back to the first one, mixed in OKLab: wraps without a seam. */
export function ramp(colors: readonly Color[], size = 256): DataTexture {
  const count = Math.max(1, colors.length)
  const data = new Uint16Array(size * 4)
  const mixed = new Color()
  for (let i = 0; i < size; i++) {
    const position = (i / size) * count
    const k = Math.floor(position)
    const below = colors[k % count] as Color
    const above = colors[(k + 1) % count] as Color
    const { r, g, b } = mixOklab(below, above, position - k, mixed)
    data[i * 4] = DataUtils.toHalfFloat(r)
    data[i * 4 + 1] = DataUtils.toHalfFloat(g)
    data[i * 4 + 2] = DataUtils.toHalfFloat(b)
    data[i * 4 + 3] = DataUtils.toHalfFloat(1)
  }
  const map = new DataTexture(data, size, 1, RGBAFormat, HalfFloatType)
  map.wrapS = RepeatWrapping
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
function atlas(layout: Raster): CanvasTexture {
  const map = new CanvasTexture(layout.canvas)
  map.premultiplyAlpha = true
  return map
}

const emOf = (r: Raster): number => Math.max(1, ...r.quads.map((q) => q.em))

/**
 * One instanced row per line of text across the whole relief, cut halfway between lines, so every
 * pixel of the text, its light and its shadow is drawn once with the line it belongs to.
 */
export function rows(
  r: Raster,
  field: readonly [number, number, number, number],
): InstancedBufferGeometry {
  const [frameX, frameY, frameWidth, frameHeight] = field
  const lines = [...r.quads].sort((a, b) => a.y - b.y)
  const count = Math.max(1, lines.length)
  const quad = new Float32Array(count * 4)
  const info = new Float32Array(count * 2)
  if (!lines.length) {
    quad.set([frameX, frameY, frameWidth, frameHeight])
    info.set([frameY + frameHeight / 2, emOf(r)])
  }
  lines.forEach((q, i) => {
    const prev = lines[i - 1]
    const next = lines[i + 1]
    const top = prev ? (prev.y + prev.height + q.y) / 2 : frameY
    const bottom = next ? (q.y + q.height + next.y) / 2 : frameY + frameHeight
    quad.set([frameX, top, frameWidth, Math.max(0, bottom - top)], i * 4)
    // The middle of the capitals and the lowercase, where the line is roundest.
    info.set([q.base - q.em * 0.34, q.em], i * 2)
  })
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  geometry.setAttribute(ROW, new InstancedBufferAttribute(quad, 4))
  geometry.setAttribute(LINE, new InstancedBufferAttribute(info, 2))
  geometry.instanceCount = count
  return geometry
}

/** Relative luminance of a linear color. */
const luma = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

/**
 * Letters become a material lit in a studio: polished chrome, gold, holographic foil or clear
 * glass, with a rounded bevel along every edge built from the shape of the glyphs. The reflections
 * slide as the pointer moves and the page scrolls, and a light sweeps across on hover, as the text
 * comes into view or on a loop. The text stays in the DOM, hidden behind the copy.
 */
const shimmer: Effect<Params> = defineEffect({
  name: 'shimmer',
  params: {
    style: oneOf('chrome', 'gold', 'holo', 'glass'),
    trigger: oneOf('hover', 'loop', 'view', 'pointer'),
    colors: '',
    bevel: 0.08,
    angle: 110,
    width: 1,
    speed: 1,
    strength: 1,
    follow: 1,
    shadow: 0.5,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // Shadow and light fall beside the letters.
  bleed: 80,
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const ratio = ctx.quality === 'low' ? 1 : 2
    // The copy draws its own light and shadow: a text-shadow on the element (a CSS fallback) is fine.
    const css = unsupported(element)
    const reason = (css === 'text-shadow' ? undefined : css) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`shimmer: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    const style = params.style
    const trigger = params.trigger
    const look = LOOKS[style]

    // Colors: the list, then the text color for what the list leaves out.
    const list: Color[] = []
    for (const word of split(params.colors)) {
      const hex = colorOf(word, element)
      if (hex) list.push(new Color(hex))
      else if (DEV) app.log.warn(`shimmer: "${word}" is not a color, left out`, element)
    }
    const ink = new Color(colorOf('', element) ?? '#ffffff')
    // Light text sits on a dark page: glass and foil lean bright there and deep on a light page.
    const onDark = luma(ink) > 0.3 ? 1 : 0

    const margin = (r: Raster): number => Math.ceil(emOf(r) * 0.45) + 4
    const build = (r: Raster): Relief =>
      relief(r, Math.max(0, ctx.params.bevel) * emOf(r), margin(r), ratio)
    let surface = build(layout)
    let built = ctx.params.bevel

    const frame = uniform(new Vector4(...layout.frame))
    const field = uniform(new Vector4(...surface.frame))
    // cos and sin of the yaw and the pitch the studio is turned by.
    const tilt = uniform(new Vector4(1, 0, 1, 0))
    // The moving light: its place (along the sweep, or x and y of the pointer) and its strength.
    const light = uniform(new Vector4(0, 0, 0, 0))
    // Box px the shadow falls by, y down; the film shift of the foil.
    const offset = uniform(new Vector2(0, 0))
    const shift = uniform(0)

    const corner = positionGeometry.xy.add(0.5)
    const row = attribute(ROW, 'vec4') as unknown as Node<'vec4'>
    const pointX = row.x.add(corner.x.mul(row.z))
    const pointY = row.y.add(corner.y.oneMinus().mul(row.w))
    const half = u.size.mul(0.5)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(pointX.sub(half.x), half.y.sub(pointY), 0)
    const point = varying(vec2(pointX, pointY))
    const line = varying(attribute(LINE, 'vec2') as unknown as Node<'vec2'>)
    const em = line.y

    const glyphs = texture(
      atlas(layout),
      vec2(point.x.sub(frame.x).div(frame.z), point.y.sub(frame.y).div(frame.w).oneMinus()),
    )
    const fieldUV = (at: Node<'vec2'>): Node<'vec2'> =>
      vec2(at.x.sub(field.x).div(field.z), at.y.sub(field.y).div(field.w))
    const map = texture(reliefTexture(surface), fieldUV(point))
    const shadowMap = texture(map.value as Texture, fieldUV(point.sub(offset)))
    const coverage = glyphs.a

    // The normal: the bevel's slope, and each line bent back top and bottom.
    const bend = clamp(point.y.sub(line.x).div(em.mul(0.36)), -1.6, 1.6).mul(look.curve)
    const normal = normalize(vec3(map.x.negate(), map.y.sub(bend), 1))
    const view = normalize(cameraPosition.sub(positionWorld))
    const facingView = clamp(dot(normal, view), 0, 1)
    /** A direction turned with the studio. */
    const turn = (r: V3): V3 => {
      const x = r.x.mul(tilt.x).add(r.z.mul(tilt.y))
      const z = r.z.mul(tilt.x).sub(r.x.mul(tilt.y))
      return vec3(x, r.y.mul(tilt.z).add(z.mul(tilt.w)), z.mul(tilt.z).sub(r.y.mul(tilt.w)))
    }
    const reflected = turn(reflect(view.negate(), normal) as V3)

    // The studio: sky over a sharp horizon, a dark floor, a softbox overhead and tall strips at
    // the sides, all softened by `soft` for the rougher materials.
    const tint = list[0]
    const second = list[1]
    const rgb = (c: readonly [number, number, number]): Color => new Color(c[0], c[1], c[2])
    const node = (c: Color): V3 => vec3(c.r, c.g, c.b)
    const zenith = rgb(look.zenith)
    const sky = rgb(look.sky)
    const ground = rgb(look.ground)
    const floorColor = rgb(look.floor)
    if (style === 'chrome' && tint) {
      zenith.copy(tint).multiplyScalar(0.55)
      sky.lerp(tint, 0.3)
    }
    if (style === 'chrome' && second) floorColor.copy(second).multiplyScalar(0.6)
    const studio = (direction: V3, soft: number): V3 => {
      const e = direction.y
      const halfSoft = soft * 0.5
      const up = mix(node(sky), node(zenith), smoothstep(0.02, 0.8, e))
      const below = e.negate()
      const down = mix(node(ground), node(floorColor), smoothstep(0.1, 0.85, below)).add(
        exp(below.sub(0.5).div(0.09).pow(2).mul(-0.5)).mul(look.bounce),
      )
      const base = mix(down, up, smoothstep(-soft - 0.004, soft + 0.004, e))
      const ax = abs(direction.x)
      const overhead = smoothstep(0.4 - halfSoft, 0.44 + halfSoft, e)
        .mul(smoothstep(0.64 + halfSoft, 0.6 - halfSoft, e))
        .mul(smoothstep(0.85, 0.5, ax))
      const strips = smoothstep(0.52 - halfSoft, 0.57 + halfSoft, ax)
        .mul(smoothstep(0.74 + halfSoft, 0.69 - halfSoft, ax))
        .mul(smoothstep(-0.3, 0.05, e))
        .mul(mix(0.55, 1, smoothstep(-0.1, 0.1, direction.x)))
      const band = exp(
        e
          .sub(0.035)
          .div(0.025 + soft)
          .pow(2)
          .mul(-0.5),
      )
      return base.add(
        overhead.mul(look.strip).add(strips.mul(look.side)).add(band.mul(look.glow)),
      ) as V3
    }

    // The moving light: a long tube passing over the text along `angle`, or a lamp at the pointer,
    // one em above the letters.
    const radians = u.angle.mul(Math.PI / 180)
    const dir = vec2(sin(radians), cos(radians).negate())
    let halfway: V3
    let facingHalfway: F
    if (trigger === 'pointer') {
      halfway = normalize(normalize(vec3(light.x.sub(point.x), point.y.sub(light.y), em)).add(view))
      facingHalfway = max(dot(normal, halfway), 0)
    } else {
      // A tube lights every point whose reflection meets it somewhere along its length: the
      // highlight is worked out across the tube, with the part along it taken out.
      const along = light.x.sub(dot(point, dir))
      const axis = vec3(dir.y, dir.x, 0)
      const across = (v: V3): V3 => normalize(v.sub(axis.mul(dot(v, axis))))
      halfway = normalize(
        normalize(vec3(dir.x.mul(along), dir.y.negate().mul(along), em)).add(view),
      )
      facingHalfway = max(dot(across(normal), normalize(across(halfway))), 0)
    }
    const shine = max(u.width, 0.15).pow(2).reciprocal().mul(110)
    const spec = pow(facingHalfway, shine)
      .mul(2)
      .add(pow(facingHalfway, shine.mul(0.08)).mul(0.25))
      .mul(light.w, max(u.strength, 0))

    // The key light in the studio, for the glitter of the foil and the light through glass.
    const key = normalize(vec3(-0.3, 0.35, 0.89))
    let color: V3
    let alpha: F = coverage
    // Light the letters add rather than cover with: reflections and focused light on glass.
    let glow: V3 = vec3(0)
    let castColor: V3 = vec3(0)
    const reach = em.mul(0.16)
    const outside = shadowMap.w.negate()
    let castAlpha: F = smoothstep(reach, reach.mul(-0.4), outside).mul(max(u.shadow, 0), 0.45) as F

    if (style === 'chrome') {
      color = studio(reflected, look.soft).mul(0.88).add(spec) as V3
    } else if (style === 'gold') {
      const baseReflectance = node(tint ?? rgb(GOLD))
      const reflectance = mix(baseReflectance, vec3(1), pow(facingView.oneMinus(), 5))
      color = studio(reflected, look.soft)
        .mul(reflectance)
        .add(spec.mul(baseReflectance).mul(1.4)) as V3
    } else if (style === 'holo') {
      // Thin film: the color of a layer whose thickness wanders over the foil, by view angle.
      const along = dot(point, dir).div(em)
      const wander = sin(
        along.mul(1.6).add(sin(point.y.div(em).mul(2.2).add(along.mul(0.7))).mul(0.8)),
      )
      const path = wander.mul(0.16).add(facingView.oneMinus().mul(0.7)).add(shift).add(0.55)
      const palette = list.length ? ramp(list) : undefined
      if (palette) ctx.onDispose(() => palette.dispose())
      const film: V3 = palette
        ? (texture(palette, vec2(fract(path.mul(1.4)), 0.5)).rgb as unknown as V3)
        : (vec3(
            cos(path.mul((2 * Math.PI) / 0.65)),
            cos(path.mul((2 * Math.PI) / 0.53)),
            cos(path.mul((2 * Math.PI) / 0.45)),
          )
            .mul(0.5)
            .add(0.5) as V3)
      const silver = studio(reflected, look.soft)
      // Light page: a deeper, more saturated foil keeps the letters readable.
      const foil = mix(
        mix(film, vec3(1), 0.08).mul(silver).mul(0.9),
        mix(film, vec3(1), 0.18).mul(silver).mul(1.15),
        onDark,
      ) as V3
      // Glitter: tiny facets tilted at random, each flashing when it catches the key light or
      // the sweep.
      const cell = floor(point.div(2)).add(4096)
      const id = cell.x.add(cell.y.mul(8192)).mul(3)
      const facet = normalize(normal.add(vec3(hash(id).sub(0.5), hash(id.add(1)).sub(0.5), 0)))
      const caught = max(dot(turn(reflect(view.negate(), facet) as V3), key), 0)
      const facing = max(dot(facet, halfway), 0)
      const glitter = pow(caught, 90)
        .add(pow(facing, 90).mul(light.w).mul(2))
        .mul(smoothstep(0.45, 0.5, hash(id.add(2))), 1.6)
        // A round point of light in its cell.
        .mul(smoothstep(0.55, 0.15, fract(point.div(2)).sub(0.5).length()))
        .mul(max(u.strength, 0))
      color = foil
        .add(spec.mul(mix(film, vec3(1), 0.5)))
        .add(mix(film, vec3(1), 0.6).mul(glitter)) as V3
    } else {
      // Glass: clear in the middle and dense at the rounded rim, where light crosses more of it
      // and bends: the rim catches light on a dark page and darkens against a light one. Only the
      // bright parts of the studio show in it, and light gathers inside the edge away from the
      // key light.
      const glass = node(tint ?? ink)
      // 0 at the edge to 1 where the bevel meets the flat top.
      const inward = clamp(map.w.div(max(u.bevel, 0.01).mul(em)), 0, 1)
      // On a dark page only the outer edge catches light.
      const rim = mix(smoothstep(1, 0.1, inward), smoothstep(0.75, 0.05, inward).pow(2), onDark)
      const reflectance = fresnel(facingView, 0.04)
      const deep = pow(max(glass, vec3(0.02)), vec3(2.4)).mul(0.45)
      const lit = glass.mul(0.7).add(0.1)
      color = mix(pow(max(glass, vec3(0.02)), vec3(0.6)), mix(deep, lit, onDark), rim) as V3
      alpha = coverage.mul(mix(mix(0.2, 0.07, onDark), mix(0.95, 0.6, onDark), rim)) as F
      const slope = vec2(map.x, map.y.negate())
      const away = max(dot(normalize(slope.add(1e-5)), vec2(KEY.x, KEY.y).negate()), 0)
      const focus = away
        .mul(smoothstep(0.05, 0.3, inward))
        .mul(smoothstep(1, 0.55, inward))
        .mul(max(u.strength, 0))
      glow = max(studio(reflected, look.soft).sub(0.4), vec3(0))
        .mul(reflectance.mul(1.8).add(0.25))
        .add(glass.mul(focus).mul(1.1))
        .add(focus.mul(0.35))
        .add(spec)
        .mul(coverage) as V3
      // Its shadow is tinted, with the light it focuses bright inside it.
      const through = vec2(shadowMap.x, shadowMap.y.negate())
      const caustic = smoothstep(0, 0.3, shadowMap.w.div(em))
        .oneMinus()
        .mul(smoothstep(-0.02, 0.02, shadowMap.w.div(em)))
        .mul(max(dot(normalize(through.add(1e-5)), vec2(KEY.x, KEY.y)), 0))
        .mul(max(u.strength, 0), max(u.shadow, 0))
      castColor = mix(glass.mul(0.35), glass.mul(1.5).add(0.35), clamp(caustic, 0, 1)) as V3
      castAlpha = castAlpha.mul(0.55).add(caustic.mul(0.45)) as F
    }

    // The letters over their shadow, one pass, premultiplied until the end.
    const lit = max(max(glow.x, glow.y), glow.z).clamp(0, 1)
    const top = alpha.add(alpha.oneMinus().mul(lit))
    const under = castAlpha.mul(top.oneMinus())
    const total = top.add(under)
    const out = color
      .mul(alpha)
      .add(glow)
      .add(castColor.mul(under))
      .div(max(total, 1e-4))
      .add(dither())
    // Masked at the nearest point half a pixel inside the box: ink and shadow past it (descenders
    // under a tight line-height) keep the clip of an ancestor without the box edge's anti-aliasing.
    const boxUV = vec2(point.x.div(u.size.x), point.y.div(u.size.y).oneMinus())
    const inset = vec2(0.5, 0.5).div(max(u.size, vec2(1, 1)))
    material.colorNode = vec4(
      out,
      clamp(total, 0, 1).mul(ctx.mask(clamp(boxUV, inset, inset.oneMinus()))),
    )

    const mesh = new Mesh(rows(layout, surface.frame), material)
    mesh.frustumCulled = false
    ctx.onDispose(() => {
      ;(glyphs.value as Texture).dispose()
      ;(map.value as Texture).dispose()
    })
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const use = (next: Raster, made: Relief): void => {
      const old = mesh.geometry
      mesh.geometry = rows(next, made.frame)
      old.dispose()
      const oldGlyphs = glyphs.value as Texture
      glyphs.value = atlas(next)
      oldGlyphs.dispose()
      const oldMap = map.value as Texture
      const fresh = reliefTexture(made)
      map.value = fresh
      shadowMap.value = fresh
      oldMap.dispose()
      frame.value.set(...next.frame)
      field.value.set(...made.frame)
      layout = next
      surface = made
      ctx.invalidate()
    }
    // Build again when the text, its fonts, its width or the bevel change.
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (!next?.quads.length) return
      built = ctx.params.bevel
      use(next, build(next))
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

    // Hover: the element or the link it sits in sweeps the light; a tap does on touch.
    let pending = false
    if (trigger === 'hover') {
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      const go = (): void => {
        pending = true
        ctx.invalidate()
      }
      target.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && go(), { signal })
      target.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && go(), { signal })
      target.addEventListener('focusin', go, { signal })
    }

    // Seconds into the sweep, -1 when none plays; the loop's clock starts on its first frame.
    let since = -1
    let shown = false
    let origin = -1
    let rate = 0
    let wake: ReturnType<typeof setTimeout> | undefined
    ctx.onDispose(() => clearTimeout(wake))
    pacing.set(signal, () => rate)
    // Pointer-driven yaw and pitch, damped; the pointer lamp's place and strength.
    let yaw = 0
    let pitch = 0
    const lamp2 = { x: 0, y: 0, on: 0 }

    return (input, time) => {
      const live = ctx.params
      if (Math.abs(live.bevel - built) > 1e-3 && !timer) {
        built = live.bevel
        schedule()
      }
      const reduced = input.reducedMotion
      const now = time.now / 1000
      const dt = Math.min(input.delta, 0.1)
      const follow = reduced ? 0 : Math.max(0, live.follow)
      const speed = Math.max(0, live.speed)
      const length = speed > 0 ? SWEEP / speed : Number.POSITIVE_INFINITY
      const em = emOf(layout as Raster)
      clearTimeout(wake)
      wake = undefined

      // The reflections lean toward the pointer, measured across the viewport from the box's middle.
      let yawTo = 0
      let pitchTo = 0
      if (follow > 0) {
        const at = input.pointer
        const stageWidth = stage.width.peek() || 1
        const stageHeight = stage.height.peek() || 1
        const dx = ((at.x - 0.5) * input.width * 2) / stageWidth
        const dy = ((at.y - 0.5) * input.height * 2) / stageHeight
        yawTo = follow * 0.32 * Math.tanh(dx)
        pitchTo = follow * 0.22 * Math.tanh(dy)
      }
      yaw = damp(yaw, yawTo, FOLLOW, dt)
      pitch = damp(pitch, pitchTo, FOLLOW, dt)
      let settling = Math.abs(yaw - yawTo) > 2e-3 || Math.abs(pitch - pitchTo) > 2e-3
      if (!settling) {
        yaw = yawTo
        pitch = pitchTo
      }

      // The sweep.
      if (!reduced && speed > 0) {
        if (trigger === 'view' && !shown) {
          if (inView(input.y, input.height, stage.height.peek(), SHOWN)) {
            shown = true
            pending = true
          }
        }
        if (trigger === 'loop') {
          if (origin < 0) origin = now - length - PAUSE / speed + 0.4
          const period = length + PAUSE / speed
          const phase = (now - origin) % period
          since = phase < length ? phase : -1
          if (since < 0) wake = setTimeout(() => ctx.invalidate(), (period - phase) * 1000)
        } else if (pending && since < 0) {
          pending = false
          since = 0
        } else if (since >= 0) {
          since += dt
          if (since >= length) since = -1
        }
      } else {
        since = -1
        pending = false
      }
      const k = since >= 0 ? Math.min(1, since / length) : 0
      const passing = since >= 0 ? Math.sin(Math.PI * k) : 0

      const lightValue = light.value as Vector4
      if (trigger === 'pointer') {
        const at = reduced ? undefined : input.pointer
        const over = !reduced && input.over
        if (at) {
          const x = at.x * input.width
          const y = (1 - at.y) * input.height
          // A dark lamp jumps to the pointer: nothing to see moves.
          const dark = lamp2.on === 0 && !over
          lamp2.x = dark ? x : damp(lamp2.x, x, TRACK, dt)
          lamp2.y = dark ? y : damp(lamp2.y, y, TRACK, dt)
          settling ||= Math.abs(lamp2.x - x) > 0.3 || Math.abs(lamp2.y - y) > 0.3
        }
        const target = over ? 1 : 0
        lamp2.on = damp(lamp2.on, target, TRACK, dt, 2e-3)
        if (lamp2.on !== target) settling = true
        lightValue.set(lamp2.x, lamp2.y, 0, lamp2.on)
      } else {
        // From before the first corner to past the last one along the sweep.
        const [frameX, frameY, frameWidth, frameHeight] = (layout as Raster).frame
        const radians = (live.angle * Math.PI) / 180
        const dirX = Math.sin(radians)
        const dirY = -Math.cos(radians)
        const s = [
          frameX * dirX + frameY * dirY,
          (frameX + frameWidth) * dirX + frameY * dirY,
          frameX * dirX + (frameY + frameHeight) * dirY,
          (frameX + frameWidth) * dirX + (frameY + frameHeight) * dirY,
        ]
        const from = Math.min(...s) - em * 1.5
        const to = Math.max(...s) + em * 1.5
        lightValue.set(
          from + (to - from) * ease('cubicInOut', k),
          0,
          0,
          since >= 0 ? Math.min(1, passing * 3) : 0,
        )
      }

      // The studio turns with the pointer, the scroll and, a little, with the passing light.
      const scroll = follow * 0.45 * (input.progress - 0.5)
      const turnYaw = yaw + passing * 0.28
      const turnPitch = pitch + scroll
      ;(tilt.value as Vector4).set(
        Math.cos(turnYaw),
        Math.sin(turnYaw),
        Math.cos(turnPitch),
        Math.sin(turnPitch),
      )
      shift.value = passing * 0.3 + (yaw * 0.9 + turnPitch * 0.6)
      // The shadow falls away from the key light, which leans with the studio.
      const depth = em * 0.07
      ;(offset.value as Vector2).set(
        -(KEY.x + Math.sin(turnYaw) * 0.9) * depth,
        (KEY.y + Math.sin(turnPitch) * 0.9) * depth,
      )
      rate = since >= 0 || settling ? 60 : 0
    }
  },
})
export default shimmer
