import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, dither, ease, inView } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  atan,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  length,
  max,
  min,
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
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { atlas, backdrop } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'
import { type Relief, relief, reliefTexture } from './relief'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type Style = 'prism' | 'crystal' | 'diamond'
type Trigger = 'pointer' | 'scroll' | 'loop' | 'view'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  dispersion: number
  spread: number
  strength: number
  bevel: number
  light: number
  follow: number
  fps: number
}

/** Seconds the light takes to follow the pointer. */
const TRACK = 0.14
/** Seconds of one orbit of the light in a loop, and of the sweep on view. */
const ORBIT = 9
const SWEEP = 2.4
/** Share of the box in view (above the bottom tenth) before trigger view sweeps. */
const SHOWN = 0.5
const DEG = Math.PI / 180

/** How each style cuts the glass and splits the light. */
interface Cut {
  /** Facet planes around a letter: 0 keeps the round bevel. */
  readonly facets: number
  /** How much more the violet end bends than the red per dispersion. */
  readonly fan: number
  /** Width of the line each color lights across a bevel, in slope units, and its strength. */
  readonly soft: number
  readonly fire: number
  /** Strength of the sparkle of small facets. */
  readonly sparkle: number
}

const CUTS: Readonly<Record<Style, Cut>> = {
  prism: { facets: 0, fan: 0.9, soft: 0.09, fire: 1.5, sparkle: 0 },
  crystal: { facets: 8, fan: 1.1, soft: 0.05, fire: 0.8, sparkle: 0.7 },
  diamond: { facets: 14, fan: 1.5, soft: 0.045, fire: 1, sparkle: 1.4 },
}

/**
 * Linear RGB weights of `count` wavelength samples from red to violet: each channel sums to 1, so the
 * samples landing on one spot add up to white and pull apart into a rainbow.
 */
export function spectrum(count: number): [number, number, number][] {
  const bump = (t: number, at: number, w: number): number => Math.exp(-(((t - at) / w) ** 2))
  const raw = Array.from({ length: count }, (_, i) => {
    const t = count > 1 ? i / (count - 1) : 0.5
    return [
      bump(t, 0.04, 0.24) + 0.3 * bump(t, 1, 0.12),
      bump(t, 0.46, 0.2),
      bump(t, 0.84, 0.22),
    ] as [number, number, number]
  })
  const sum = [0, 1, 2].map((c) => raw.reduce((s, w) => s + w[c as 0], 0) || 1)
  return raw.map((w) => [
    w[0] / (sum[0] as number),
    w[1] / (sum[1] as number),
    w[2] / (sum[2] as number),
  ])
}

/** Saturated linear RGB hues from red to violet, `count` of them, for light split into bands. */
export function rainbow(count: number): [number, number, number][] {
  const stops: [number, number, number][] = [
    [1, 0.02, 0.01],
    [1, 0.3, 0],
    [0.95, 0.85, 0],
    [0.05, 0.85, 0.12],
    [0, 0.6, 1],
    [0.1, 0.12, 1],
    [0.55, 0.05, 1],
  ]
  return Array.from({ length: count }, (_, i) => {
    const x = (count > 1 ? i / (count - 1) : 0.5) * (stops.length - 1)
    const k = Math.min(stops.length - 2, Math.floor(x))
    const fraction = x - k
    const below = stops[k] as [number, number, number]
    const above = stops[k + 1] as [number, number, number]
    return [
      below[0] + (above[0] - below[0]) * fraction,
      below[1] + (above[1] - below[1]) * fraction,
      below[2] + (above[2] - below[2]) * fraction,
    ]
  })
}

/**
 * The light from the box center in px (y down) and its height: at `angle` (a CSS angle, 0 above,
 * 90 right) about the size of the box away, drifting with the box's place in the viewport.
 */
export function lamp(
  angle: number,
  width: number,
  height: number,
  middle: number,
  viewport: number,
): [number, number, number] {
  const big = Math.max(width, height, 240)
  const reach = big * 0.6
  const radians = angle * DEG
  const drift = Math.max(-reach, Math.min(reach, (viewport / 2 - middle) * 0.5))
  return [
    Math.sin(radians) * reach,
    -Math.cos(radians) * reach + drift,
    Math.min(640, Math.max(160, big * 0.4)),
  ]
}

/** The pointer's offset from the box center, eased so a far pointer stays a light nearby. */
export function reach(dx: number, dy: number, width: number, height: number): [number, number] {
  const limit = Math.max(width, height, 240) * 0.8 + 120
  const distance = Math.hypot(dx, dy)
  if (distance < 1e-6) return [0, 0]
  const scale = (limit * Math.tanh(distance / limit)) / distance
  return [dx * scale, dy * scale]
}

/** A CSS color as `#rrggbb`: currentColor and an empty value read the text color. */
function inkOf(element: Element): string {
  const style = getComputedStyle(element)
  const fill = style.getPropertyValue('-webkit-text-fill-color')
  const word = fill && !/^(transparent|rgba\(.*,\s*0\))$/.test(fill) ? fill : style.color
  return cssColor(word) ?? '#202020'
}

const luma = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
const emOf = (r: Raster): number => Math.max(1, ...r.quads.map((q) => q.em))

/** One quad, corners at ±0.5. */
function quad(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  return geometry
}

/** Phases with the light moving: frames a second for the policy. */
const pacing = new WeakMap<AbortSignal, () => number>()

/**
 * Letters become cut crystal standing off the page: clear bevelled glass with bright inner
 * edges, that splits the light of a lamp into rainbows cast on the page behind and beside it. The
 * lamp follows the pointer, sweeps with the scroll, orbits on a loop or passes once in view. The
 * text stays in the DOM, hidden behind the copy.
 */
const prism: Effect<Params> = defineEffect({
  name: 'prism',
  params: {
    style: oneOf('prism', 'crystal', 'diamond'),
    trigger: oneOf('pointer', 'scroll', 'loop', 'view'),
    dispersion: 1,
    spread: 1,
    strength: 1,
    bevel: 0.07,
    light: 300,
    follow: 1,
    fps: 30,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The thrown spectrum lands just past the letters.
  bleed: 64,
  quality: { low: { fps: 24 } },
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const ratio = ctx.quality === 'low' ? 1 : 2
    const samples = ctx.quality === 'low' ? 5 : 7
    // The glass casts its own light: a text-shadow on the element (a CSS fallback) is fine.
    const css = unsupported(element)
    const reason = (css === 'text-shadow' ? undefined : css) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`prism: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    const style = params.style
    const trigger = params.trigger
    const cut = CUTS[style]

    const ink = new Color(inkOf(element))
    const wallHex = backdrop(element)?.color
    // Light text sits on a dark page; a known background decides first.
    const dark = wallHex ? luma(new Color(wallHex)) < 0.25 : luma(ink) > 0.3
    const margin = (layout: Raster): number => Math.min(96, Math.ceil(emOf(layout) * 0.3) + 12)
    const build = (layout: Raster): Relief =>
      relief(layout, Math.max(0, ctx.params.bevel) * emOf(layout), margin(layout), ratio)
    let surface = build(layout)
    let built = ctx.params.bevel

    const frame = uniform(new Vector4(...layout.frame))
    const field = uniform(new Vector4(...surface.frame))
    const emU = uniform(emOf(layout))
    // The lamp in box px (y down) and its height.
    const light = uniform(new Vector3(0, -300, 300))
    const onDark = uniform(dark ? 1 : 0)
    const glassInk = uniform(ink)
    // The page behind, for the part of a bevel that shows it: white or black when unknown.
    const wall = uniform(new Color(wallHex ?? (dark ? '#000000' : '#ffffff')))

    const corner = positionGeometry.xy.add(0.5)
    const fieldX = field.x.add(corner.x.mul(field.z))
    const fieldY = field.y.add(corner.y.oneMinus().mul(field.w))
    const half = u.size.mul(0.5)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(fieldX.sub(half.x), half.y.sub(fieldY), 0)
    const point = varying(vec2(fieldX, fieldY)) as unknown as V2
    const em = emU

    const maps: { value: Texture }[] = []
    const reliefMap = reliefTexture(surface)
    const at = (q: V2): Node<'vec4'> => {
      const node = texture(
        reliefMap,
        vec2(q.x.sub(field.x).div(field.z), q.y.sub(field.y).div(field.w)),
      )
      maps.push(node as unknown as { value: Texture })
      return node as unknown as Node<'vec4'>
    }
    const atlas0 = atlas(layout.canvas)
    const inks: { value: Texture }[] = []
    const glyphs = texture(
      atlas0,
      vec2(point.x.sub(frame.x).div(frame.z), point.y.sub(frame.y).div(frame.w).oneMinus()),
    )
    inks.push(glyphs as unknown as { value: Texture })
    // Clamped to the raster: past it the edge texels would smear out.
    const uvG = vec2(point.x.sub(frame.x).div(frame.z), point.y.sub(frame.y).div(frame.w))
    const coverage = glyphs.a.mul(
      uvG.x
        .greaterThanEqual(0)
        .and(uvG.x.lessThanEqual(1))
        .and(uvG.y.greaterThanEqual(0))
        .and(uvG.y.lessThanEqual(1))
        .select(1, 0),
    )
    const intensity = max(u.strength, 0)
    const dispersion = max(u.dispersion, 0)
    const bevelPx = max(u.bevel, 0.005).mul(em)

    const toLamp2 = vec2(light.x.sub(point.x), light.y.sub(point.y))
    // Toward the lamp in box px, y down.
    const ell = toLamp2.div(max(length(toLamp2), 1e-3))
    // The split light is strongest near the lamp: a pool of rainbows that moves with it.
    const pool = exp(length(toLamp2).div(em.mul(3.2)).pow(2).negate())
    const weights = spectrum(samples)
    const tOf = (i: number): number => (samples > 1 ? i / (samples - 1) : 0.5)
    /** The split light as linear RGB: white where the samples overlap, colors where they part. */
    const split = (band: (t: number) => F): V3 => {
      let sum: V3 = vec3(0)
      weights.forEach((w, i) => {
        sum = sum.add(vec3(w[0], w[1], w[2]).mul(band(tOf(i)))) as V3
      })
      return sum
    }
    const hues = rainbow(samples)
    /**
     * Light split into thin bands, one per color, as premultiplied light: each pixel takes the
     * mean hue of the bands over it and the strength of the strongest, so neighbors blend into a
     * smooth spectrum; with no dispersion the bands coincide and the light is white.
     */
    const bands = (band: (t: number) => F): V3 => {
      let sum: V3 = vec3(0)
      let total: F = float(0)
      let peak: F = float(0)
      hues.forEach((c, i) => {
        const weight = band(tOf(i))
        sum = sum.add(vec3(c[0], c[1], c[2]).mul(weight)) as V3
        total = total.add(weight) as F
        peak = max(peak, weight) as F
      })
      const hue = mix(vec3(1), sum.div(max(total, 1e-4)), smoothstep(0, 0.35, dispersion))
      return hue.mul(peak) as V3
    }

    // The glass at this pixel: the normal from the bevel, or cut planes for crystal and diamond.
    const sample = at(point)
    const fromEdge = sample.w
    let normal: V3
    let ridge: F = float(0)
    let slope: V2
    if (cut.facets > 0) {
      const dx = at(point.add(vec2(1, 0))).w.sub(fromEdge)
      const dy = at(point.add(vec2(0, 1))).w.sub(fromEdge)
      // Steepest climb of the distance, toward the middle of the stroke; cut into flat planes.
      const angle = atan(dy, dx)
      const step = (2 * Math.PI) / cut.facets
      const plane = floor(angle.div(step).add(0.5)).mul(step)
      const climb = vec2(cos(plane), sin(plane))
      const tilt = smoothstep(0, 0.3, length(vec2(dx, dy))).mul(0.85)
      normal = normalize(vec3(climb.x.mul(tilt).negate(), climb.y.mul(tilt), 1))
      slope = climb.mul(tilt) as V2
      // Where two planes meet the distance stops climbing: the ridge of the cut.
      ridge = smoothstep(0.75, 0.2, length(vec2(dx, dy))).mul(smoothstep(1, 3, fromEdge))
    } else {
      normal = normalize(vec3(sample.x.negate(), sample.y, 1))
      slope = vec2(sample.x, sample.y)
    }
    // The slope climbs toward the middle of the stroke: along the light on the bevels that face
    // away from the lamp, against it on those that face it.
    const along = dot(slope, ell)
    const blur = fwidth(along)
    // Light through the glass leaves a bevel where its slope bends it toward the eye. Each color
    // bends by its own amount, so each lights its own thin line across the bevel: a crisp
    // spectrum that runs along the contour and slides around it as the lamp moves.
    // Only the bevels square to the light throw it, so the fire gathers in arcs that slide
    // around the curves instead of outlining every letter.
    const facing = (g: V2, width: number): F => {
      const cosine = dot(g.div(max(length(g), 1e-4)), ell)
      return exp(cosine.sub(0.95).div(width).pow(2).negate()) as F
    }
    const aim = facing(slope, 0.3)
    const fire = bands((t) => {
      const k = float(1).add(dispersion.mul(cut.fan * (t - 0.5)))
      const width = max(float(cut.soft), blur.mul(k).mul(0.8))
      return exp(along.mul(k).sub(0.55).div(width).pow(2).negate()).mul(aim) as F
    })
    const view = normalize(cameraPosition.sub(positionWorld))
    const facingView = clamp(dot(normal, view), 0, 1)
    const toLamp = normalize(vec3(light.x.sub(point.x), point.y.sub(light.y), light.z))
    const halfway = normalize(toLamp.add(view))
    const facingHalfway = max(dot(normal, halfway), 0)
    const spec = pow(facingHalfway, 220)
      .mul(2.6)
      .add(pow(facingHalfway, 30).mul(0.18))
      .mul(intensity)
    const fresnel = pow(facingView.oneMinus(), 4).mul(0.9).add(0.04)
    // A studio overhead in the reflections: a bright softbox above and a strip at the side.
    const reflected = reflect(view.negate(), normal) as V3
    const env = smoothstep(0.2, 0.5, reflected.y)
      .mul(0.9)
      .add(smoothstep(0.4, 0.65, abs(reflected.x)).mul(0.3))
    // Light caught inside the edge: a thin line just inside the outline and one where the bevel
    // meets the face, brighter on the side away from the lamp, as total internal reflection.
    const away = max(dot(slope.div(max(length(slope), 1e-4)), ell), 0)
    const inner = exp(fromEdge.sub(1.1).div(0.7).pow(2).negate())
      .mul(0.5)
      .add(
        exp(fromEdge.sub(bevelPx).div(bevelPx.mul(0.12).add(0.5)).pow(2).negate()).mul(
          away.mul(0.6).add(0.15),
        ),
      )
      .add(ridge.mul(0.5))
    // Small facets flashing in spectral colors as the light moves.
    let sparkle: V3 = vec3(0)
    if (cut.sparkle > 0) {
      const cell = floor(point.div(3)).add(4096)
      const id = cell.x.add(cell.y.mul(8192)).mul(3)
      const facet = normalize(
        normal.add(vec3(hash(id).sub(0.5), hash(id.add(1)).sub(0.5), 0).mul(0.9)),
      )
      const caught = pow(max(dot(facet, halfway), 0), 260)
      const dot2 = smoothstep(0.55, 0.1, length(fract(point.div(3)).sub(0.5)))
      const tone = hash(id.add(2)).add(dot(toLamp.xy, vec2(0.7, 0.3)))
      const color = vec3(
        cos(tone.mul(6.283)),
        cos(tone.mul(6.283).sub(2.094)),
        cos(tone.mul(6.283).add(2.094)),
      )
        .mul(0.5)
        .add(0.6)
      sparkle = color.mul(caught.mul(dot2, cut.sparkle * 3, intensity)) as V3
    }

    // The letters seen through their own glass: crisp ink on the face; across a bevel the glass
    // bends the view outward, so its outer part shows the page, and each color bends by its own
    // amount: the edge of the ink splits into a clean spectrum, as through a prism.
    const steep = length(slope)
    const inkAt = (q: V2): F => {
      const uv = vec2(q.x.sub(frame.x).div(frame.z), q.y.sub(frame.y).div(frame.w))
      const node = texture(atlas0, vec2(uv.x, uv.y.oneMinus()))
      inks.push(node as unknown as { value: Texture })
      return node.a.mul(
        uv.x
          .greaterThanEqual(0)
          .and(uv.x.lessThanEqual(1))
          .and(uv.y.greaterThanEqual(0))
          .and(uv.y.lessThanEqual(1))
          .select(1, 0),
      ) as F
    }
    const bend = bevelPx.mul(0.8)
    const seen = split((t) =>
      inkAt(point.sub(slope.mul(bend.mul(float(1).add(dispersion.mul(cut.fan * (t - 0.5))))))),
    ).mul(coverage) as V3
    const solid = max(max(seen.x, seen.y), seen.z)
    // Bevels toward the lamp brighter, away from it darker; the outermost edge is a dark line on
    // a light page and a bright one on a dark page.
    const lit = clamp(along.negate().mul(0.45).add(1), 0.55, 1.5)
    const contour = smoothstep(0.85, 1.5, steep).max(ridge.mul(0.5))
    const tone = glassInk
      .mul(lit)
      .mul(mix(contour.mul(-0.55).add(1), contour.mul(0.8).add(1), onDark)) as V3
    const bodyRGB = tone
      .mul(seen)
      .add((wall as unknown as V3).mul(vec3(solid).sub(seen).max(0))) as V3
    const white = env
      .mul(fresnel)
      .mul(mix(0.8, 1.2, onDark))
      .add(inner.mul(mix(0.7, 1.1, onDark)))
      .add(spec)
    const reflections = vec3(white)
      .add(fire.mul(intensity.mul(cut.fire).mul(pool.mul(0.7).add(0.3))))
      .add(sparkle)
      .mul(coverage) as V3

    // Beside the letters, on the page: the light through the bevels lands a little past them
    // on the side away from the lamp, each color a little farther, in a thin spectrum along the
    // edge. Read back toward the lamp, so it follows the contour without seams between letters.
    const outside = smoothstep(0.5, -0.5, fromEdge)
    const reachPx = max(u.spread, 0).mul(em).mul(0.07)
    const fan = reachPx.mul(dispersion.min(2)).mul(0.65)
    const thick = max(fan.div(Math.max(1, samples - 1)).mul(1.8), em.mul(0.012).max(1.2))
    const thrown = bands((t) => {
      const sample = at(point.add(ell.mul(reachPx.add(fan.mul(t - 0.5)))))
      const edge = smoothstep(-0.5, 0.5, sample.w).mul(
        smoothstep(thick.mul(1.5), thick.mul(0.5), sample.w),
      )
      return edge.mul(facing(vec2(sample.x, sample.y), 0.22)) as F
    })
    const room = min(
      min(point.x.sub(field.x), field.x.add(field.z).sub(point.x)),
      min(point.y.sub(field.y), field.y.add(field.w).sub(point.y)),
    )
    const castL = thrown.mul(
      intensity
        .mul(outside)
        .mul(smoothstep(0, 4, room))
        .mul(exp(length(toLamp2).div(em.mul(2)).pow(2).negate()))
        // On a light page it reads as a ghost of the word if strong: only a hint there.
        .mul(mix(0.25, 1, onDark)),
    ) as V3
    // A faint shadow of the glass, as far out.
    const shade = smoothstep(-0.5, 1.5, at(point.add(ell.mul(reachPx.mul(0.7)))).w)
      .mul(outside)
      .mul(mix(0.06, 0.22, onDark))

    // Composed bottom up, premultiplied: shadow, thrown light, glass, the light on the glass.
    const lum = (c: V3): F => clamp(max(max(c.x, c.y), c.z), 0, 1) as F
    let rgb: V3 = vec3(0)
    let alpha: F = shade as F
    rgb = rgb.add(castL) as V3
    alpha = alpha.add(alpha.oneMinus().mul(lum(castL))) as F
    rgb = rgb.mul(solid.oneMinus()).add(bodyRGB) as V3
    alpha = alpha.mul(solid.oneMinus()).add(solid) as F
    rgb = rgb.add(reflections) as V3
    alpha = alpha.add(alpha.oneMinus().mul(lum(reflections))) as F
    const color = rgb.div(max(alpha, 1e-4)).add(dither())
    // Masked at the nearest point half a pixel inside the box: the mask is half on its edge.
    const boxUV = vec2(point.x.div(u.size.x), point.y.div(u.size.y).oneMinus())
    const inset = vec2(0.5, 0.5).div(max(u.size, vec2(1, 1)))
    material.colorNode = vec4(
      color,
      clamp(alpha, 0, 1).mul(ctx.mask(clamp(boxUV, inset, inset.oneMinus()))),
    )

    const mesh = new Mesh(quad(), material)
    mesh.frustumCulled = false
    ctx.onDispose(() => {
      ;(maps[0]?.value as Texture | undefined)?.dispose()
      ;(glyphs.value as Texture).dispose()
    })
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const use = (next: Raster, made: Relief): void => {
      const old = maps[0]?.value
      const fresh = reliefTexture(made)
      for (const node of maps) node.value = fresh
      old?.dispose()
      const oldGlyphs = glyphs.value as Texture
      const glyphMap = atlas(next.canvas)
      for (const node of inks) node.value = glyphMap
      oldGlyphs.dispose()
      frame.value.set(...next.frame)
      field.value.set(...made.frame)
      emU.value = emOf(next)
      glassInk.value.set(inkOf(element))
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

    // A mouse or pen anywhere on the page moves the lamp; it goes back when the pointer leaves.
    let mouse: { x: number; y: number } | undefined
    if (trigger === 'pointer') {
      const point = (e: PointerEvent): void => {
        if (e.pointerType === 'touch') return
        mouse = { x: e.clientX, y: e.clientY }
        if (ctx.params.follow > 0 && !stage.reducedMotion.peek()) ctx.invalidate()
      }
      const gone = (): void => {
        if (!mouse) return
        mouse = undefined
        ctx.invalidate()
      }
      addEventListener('pointermove', point, { passive: true, signal })
      document.documentElement.addEventListener('pointerleave', gone, { signal })
      addEventListener('blur', gone, { signal })
    }

    let rate = 0
    pacing.set(signal, () => rate)
    let lampX = 0
    let lampY = 0
    let started = false
    let shown = false
    let since = -1

    return (input, time) => {
      const live = ctx.params
      if (Math.abs(live.bevel - built) > 1e-3 && !timer) {
        built = live.bevel
        schedule()
      }
      const reduced = input.reducedMotion
      const dt = Math.min(input.delta, 0.1)
      const width = input.width
      const height = input.height
      const viewport = stage.height.peek() || height
      const middle = input.y + height / 2
      const follow = reduced ? 0 : Math.min(1, Math.max(0, live.follow))
      let angle = live.light
      let moving = false
      if (!reduced && trigger === 'loop') {
        angle += ((time.now / 1000) * 360) / ORBIT
        moving = input.visible && live.fps > 0
      }
      if (!reduced && trigger === 'view') {
        if (!shown) {
          if (inView(input.y, height, viewport, SHOWN)) {
            shown = true
            since = 0
          }
        } else if (since >= 0) since += dt
        if (since >= SWEEP) since = -1
        const k = since >= 0 ? ease('cubicInOut', Math.min(1, since / SWEEP)) : shown ? 1 : 0
        angle += (k - 0.5) * 150
        moving = since >= 0
      }
      const [restX, restY, restZ] = lamp(
        angle,
        width,
        height,
        reduced ? viewport / 2 : middle,
        viewport,
      )
      let targetX = restX
      let targetY = restY
      if (!reduced && trigger === 'scroll') {
        // Across the box as it scrolls through the viewport, from left to right.
        const sweep = Math.max(-1, Math.min(1, (input.progress - 0.5) * 2.4))
        targetX = restX * (1 - follow) + sweep * Math.max(width, 240) * 0.65 * follow
      }
      if (follow > 0 && mouse && trigger === 'pointer') {
        const [pointerX, pointerY] = reach(
          mouse.x - (input.x + width / 2),
          mouse.y - middle,
          width,
          height,
        )
        targetX += (pointerX - restX) * follow
        targetY += (pointerY - restY) * follow
      }
      if (!started || reduced || trigger === 'loop' || trigger === 'view') {
        lampX = targetX
        lampY = targetY
        started = true
      } else {
        lampX = damp(lampX, targetX, TRACK, dt)
        lampY = damp(lampY, targetY, TRACK, dt)
      }
      const settling = Math.abs(lampX - targetX) > 0.5 || Math.abs(lampY - targetY) > 0.5
      if (!settling) {
        lampX = targetX
        lampY = targetY
      }
      light.value.set(width / 2 + lampX, height / 2 + lampY, restZ)
      rate = moving ? (trigger === 'loop' ? Math.max(0, live.fps) : 60) : settling ? 60 : 0
    }
  },
})
export default prism
