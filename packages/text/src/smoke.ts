import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, inView, mixOklab, palette } from '@dioramajs/effects/kit'
import {
  Break,
  clamp,
  dot,
  exp,
  Fn,
  float,
  If,
  Loop,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  screenCoordinate,
  smoothstep,
  sqrt,
  sRGBTransferEOTF,
  texture,
  texture3D,
  uint,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  type Data3DTexture,
  type DataTexture,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type Texture,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { atlas, backdrop } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'
import { build, type Field, fieldTexture, noiseTexture } from './smoke-field'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Style = 'smoke' | 'mist' | 'ink'
type Trigger = 'view' | 'scroll' | 'hover' | 'loop'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  density: number
  speed: number
  rise: number
  turbulence: number
  duration: number
  color: string
  seed: number
}

/** Share of the box in view (above the bottom tenth) before the view trigger condenses. */
const SHOWN = 0.3
/** Frames a second of the loop trigger. */
export const LOOP_FPS = 30
/** Steps through the volume per quality tier, half in front of the letters and half behind. */
export const STEPS = { low: 8, medium: 12, high: 16 } as const
/** Wisps the pointer can have curling off the letters at once with the hover trigger. */
const PUFFS = 8
/** Share of the viewport around its middle where a scrubbed heading stays condensed. */
const HOLD = 0.08
/** Most the hover trigger dissolves the letters under the pointer. */
const STIR = 0.42

/** How each style is lit and how dense it is. */
interface Look {
  /** Extinction per em at density 1. */
  readonly sigma: number
  /** Light from behind and above, and the room's light from all around. */
  readonly sun: number
  readonly ambient: number
  /** Share of forward scattering: 0 scatters evenly, 1 glows around the light. */
  readonly forward: number
  /** Swirl strength, noise scale and upward drift against the smoke style. */
  readonly swirl: number
  readonly scale: number
  readonly drift: number
  /** Warm light and a cool room, or the plain color. */
  readonly sunColor: readonly [number, number, number]
  readonly roomColor: readonly [number, number, number]
}

const LOOKS: Readonly<Record<Style, Look>> = {
  smoke: {
    sigma: 6,
    sun: 1.3,
    ambient: 0.22,
    forward: 0.7,
    swirl: 1,
    scale: 1,
    drift: 1,
    sunColor: [1, 0.95, 0.88],
    roomColor: [0.8, 0.85, 0.95],
  },
  mist: {
    sigma: 3.4,
    sun: 0.45,
    ambient: 0.85,
    forward: 0.35,
    swirl: 0.75,
    scale: 0.62,
    drift: 0.55,
    sunColor: [1, 1, 1],
    roomColor: [1, 1, 1],
  },
  ink: {
    sigma: 8,
    sun: 0.7,
    ambient: 0.45,
    forward: 0.25,
    swirl: 1.55,
    scale: 1.15,
    drift: 0.4,
    sunColor: [1, 1, 1],
    roomColor: [1, 1, 1],
  },
}

/** Smoke of the smoke style without a `color`: a grey white. */
const SMOKE = '#e4e7ec'
/** The light comes from behind the text, above and a little to the left, in box px (y down). */
const LIGHT = new Vector3(-0.22, -0.55, -0.8).normalize()

/**
 * A random 0..1 per screen pixel, from an integer hash: the start of each ray, so the steps
 * through the volume leave fine grain instead of bands. Without a history to average it, an
 * ordered pattern such as interleaved gradient noise would show as a lattice.
 */
function scatter(): F {
  const seed = uint(screenCoordinate.x).add(uint(screenCoordinate.y).mul(8192)).add(7919)
  const state = seed.mul(747796405).add(2891336453)
  const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737)
  return word
    .shiftRight(22)
    .bitXor(word)
    .toFloat()
    .mul(1 / 2 ** 32) as unknown as F
}

/** Frames a second each phase asks for. */
const pacing = new WeakMap<AbortSignal, () => number>()

/** The noise cube, shared per renderer with a count of its users. */
const cubes = new WeakMap<object, { map: Data3DTexture; refs: number }>()

/** How far a view-trigger condense is at `k` 0..1: the smoke gathers fast and the letters sharpen slowly. */
export const condense = (k: number): number => {
  const x = Math.min(1, Math.max(0, k))
  return (1 - x) ** 2.2 * (1 - x * x * 0.3)
}

/**
 * The stage of a scrubbed heading, 0 condensed to 1 gone, and where its smoke goes: 1 up and away
 * as it leaves the top, -1 drifting in from below as it comes up. `start` is the middle of the box
 * on the page's first screen, so a heading there starts condensed.
 */
export function scrub(
  middle: number,
  height: number,
  viewport: number,
  start: number,
): [number, number] {
  const mid = viewport / 2
  const top = Math.max(0, Math.min(mid - viewport * HOLD, start - 1))
  // A heading on the first screen below the band starts condensed where it is.
  const bottom =
    start < viewport ? Math.max(mid + viewport * HOLD, start + 1) : mid + viewport * HOLD
  const smooth = (t: number): number => {
    const x = Math.min(1, Math.max(0, t))
    return x * x * (3 - 2 * x)
  }
  if (middle < top) return [smooth((top - middle) / (top + height / 2 || 1)), 1]
  if (middle > bottom)
    return [smooth((middle - bottom) / (viewport + height / 2 - bottom || 1)), -1]
  return [0, 1]
}

/** The smoke color of a style: `color` if it is one, else grey white, a pale fog or the ink. */
export function smokeColor(style: Style, value: string, element: Element): string {
  const own = value.trim() ? palette(value, element)[0] : undefined
  if (own) return own
  const text = palette('currentColor', element)[0] ?? '#202020'
  if (style === 'ink') return text
  if (style === 'smoke') return SMOKE
  // A fog a third of the way from the page to the text: pale, but it reads on the page.
  const page = backdrop(element)?.color ?? '#ffffff'
  return `#${mixOklab(new Color(page), new Color(text), 0.3).getHexString()}`
}

/**
 * A heading condenses out of drifting smoke as it comes into view, or dissolves into it: a short
 * march through a volume of smoke shaped by the glyphs, swirled by 3D noise and rising over time,
 * lit from behind so thin wisps glow at their edges. The volume has depth, so its layers shift
 * against each other as the page scrolls. The text stays in the DOM.
 */
const smoke: Effect<Params> = defineEffect({
  name: 'smoke',
  params: {
    style: oneOf('smoke', 'mist', 'ink'),
    trigger: oneOf('view', 'scroll', 'hover', 'loop'),
    density: 1,
    speed: 1,
    rise: 1,
    turbulence: 1,
    duration: 2.4,
    color: '',
    seed: 1,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The smoke rises far above the box.
  bleed: 400,
  presence: 'custom',
  reducedMotion: 'off',
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const { trigger } = params
    const look = LOOKS[params.style]
    const el = element as HTMLElement
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
    // Once: text the visitor has already seen as DOM stays; veiled text has not been seen.
    const veiled = (): boolean => element.getAttribute('data-dio-state') === 'entering'
    let seen = trigger === 'view' && onScreen() && !veiled()
    const warn = (reason: string): void => {
      if (DEV) app.log.warn(`smoke: ${reason} cannot be drawn, the text stays as it is`, element)
    }
    const ratio = ctx.quality === 'low' ? 1 : 2
    const steps = STEPS[ctx.quality]
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason) warn(reason)
      ctx.showDom(true)
      return
    }
    let field = await build(layout)
    if (signal.aborted) return
    seen &&= onScreen() && !veiled()

    const tint = uniform(new Color(smokeColor(params.style, params.color, element)))
    // 0 crisp letters, 1 nothing left; and where the smoke goes, 1 up and away, -1 in from below.
    const amount = uniform(trigger === 'view' && !seen ? 1 : 0)
    const way = uniform(-1)
    // 1 with the loop trigger: smoke keeps rising off whole letters.
    const steady = uniform(trigger === 'loop' ? 1 : 0)
    // Seconds of the smoke's own motion.
    const clock = uniform(0)
    // The eye in box px (y down) and its distance from the page.
    const eye = uniform(new Vector3(0, 0, 1000))
    const em = uniform(field.em)
    const fieldFrame = uniform(new Vector4(...field.frame))
    const rasterFrame = uniform(new Vector4(...layout.frame))
    // The drawn quad in box px: left, top, right, bottom; and half the depth marched.
    const area = uniform(new Vector4(...field.frame))
    const reach = uniform(field.em)
    const top = uniform(field.bounds[1])
    const offset = uniform(new Vector3())
    const puffs = Array.from({ length: PUFFS }, () => uniform(new Vector4()))

    const half = u.size.mul(0.5)
    const corner = positionGeometry.xy.add(0.5)
    const areaX = mix(area.x, area.z, corner.x)
    const areaY = mix(area.w, area.y, corner.y)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(areaX.sub(half.x), half.y.sub(areaY), 0)
    const point = varying(vec2(areaX, areaY)) as unknown as V2

    const reads: { value: Texture }[] = []
    let fieldMap: DataTexture = fieldTexture(field)
    const fieldAt = (at: V2): V4 => {
      const uv = vec2(
        at.x.sub(fieldFrame.x).div(fieldFrame.z),
        at.y.sub(fieldFrame.y).div(fieldFrame.w).oneMinus(),
      )
      const node = texture(fieldMap, uv, float(0))
      reads.push(node as unknown as { value: Texture })
      return node as unknown as V4
    }
    const owner = ctx.render.renderer
    let cube = cubes.get(owner)
    if (!cube) {
      cube = { map: noiseTexture(1), refs: 0 }
      cubes.set(owner, cube)
    }
    const held = cube
    held.refs++
    ctx.onDispose(() => {
      if (--held.refs > 0) return
      cubes.delete(owner)
      held.map.dispose()
    })
    const noise = (at: V3): V4 => texture3D(held.map, at, float(0)) as unknown as V4
    const rasterMap = atlas(layout.canvas)
    ctx.onDispose(() => {
      rasterMap.dispose()
      fieldMap.dispose()
    })
    const rasterNode = texture(
      rasterMap,
      vec2(
        point.x.sub(rasterFrame.x).div(rasterFrame.z),
        point.y.sub(rasterFrame.y).div(rasterFrame.w).oneMinus(),
      ),
    )

    const square = (x: F): F => x.mul(x)
    const sun = vec3(...look.sunColor).mul(look.sun)
    const room = vec3(...look.roomColor).mul(look.ambient)
    const toLight = vec3(LIGHT.x, LIGHT.y, LIGHT.z)
    const rise = max(u.rise as unknown as F, 0)
    const swirl = max(u.turbulence as unknown as F, 0).mul(look.swirl)
    const thick = max(u.density as unknown as F, 0).mul(look.sigma)

    material.colorNode = Fn(() => {
      // Per px toward the viewer, the ray moves this far across the page: the volume's parallax.
      const ray = eye.xy.sub(point).div(eye.z).toVar()
      let local: F = amount as unknown as F
      if (trigger === 'hover') {
        // Each wisp dissolves the letters around where it started and rises from there.
        let stir: F = float(0)
        for (const puff of puffs) {
          const radius = em.mul(puff.z.mul(0.5).add(0.6))
          const centreY = puff.y.sub(rise.mul(em).mul(puff.z).mul(0.9))
          const dx = point.x.sub(puff.x).div(radius)
          const above = point.y.lessThan(centreY)
          const dy = point.y.sub(centreY).div(radius.mul(above.select(float(1.8), float(1))))
          stir = max(stir, puff.w.mul(exp(square(dx).add(square(dy)).negate())))
        }
        local = max(local, min(stir, STIR))
      }
      const height = clamp(local, 0, 1).toVar()
      // How much body smoke, how much rising plume, how soft and thick the volume is.
      // Under the pointer the letters only shed wisps: less body smoke.
      const bodyAmt = smoothstep(0, 0.2, height)
        .mul(smoothstep(0.5, 1, height).oneMinus())
        .mul(trigger === 'hover' ? 0.5 : 1)
        .toVar()
      const plumeAmt = max(
        smoothstep(0.04, 0.32, height)
          .mul(smoothstep(0.55, 0.95, height).oneMinus())
          .mul(max(way, 0)),
        steady.mul(0.75),
      ).toVar()
      const edge = height.mul(0.12).add(0.03).toVar()
      const softK = smoothstep(0.05, 0.45, height).toVar()
      const hazeK = smoothstep(0.3, 0.9, height).mul(0.35).toVar()
      const depthWidth = height.mul(0.55).add(0.06).toVar()
      const lift = way
        .mul(rise)
        .mul(em)
        .mul(pow(height, 1.5))
        .mul(1.4 * look.drift)
        .toVar()
      const warpAmt = swirl.mul(em).mul(pow(height, 1.2).mul(1.1).add(0.03)).toVar()
      const drift = max(rise, 0.15).mul(0.45 * look.drift)
      const flow = vec3(0, clock.mul(drift), clock.mul(0.05)).toVar()
      const scale = look.scale
      // How sparse the plumes are: a few at a time off steady letters, most off dissolving ones.
      const gating = mix(float(0.35), float(0.9), steady)

      /** Body smoke and plume at a box point and depth (em), for the field `f`. */
      const shape = (f: V4, zEm: F, wz: F): [F, F] => {
        const core = smoothstep(edge, edge.negate(), f.x.sub(height.mul(0.05)))
        const body = mix(core, f.y, softK).add(f.z.mul(hazeK))
        const billow = exp(square(zEm.sub(wz.mul(height).mul(0.3)).div(depthWidth)).negate())
        const plumeDepth = exp(square(zEm.sub(wz.mul(0.2)).div(height.mul(0.3).add(0.2))).negate())
        const plume = f.w.mul(core.mul(0.92).oneMinus()).mul(plumeDepth)
        return [body.mul(billow).mul(bodyAmt), plume.mul(plumeAmt)]
      }
      /** The same without depth, for the light that reaches a point from above. */
      const shade = (f: V4): F =>
        mix(f.y, f.z, softK).mul(bodyAmt).add(f.w.mul(plumeAmt).mul(0.5)) as F

      const view = normalize(vec3(ray, 1))
      const cosine = dot(view, toLight.negate())
      const anisotropy = 0.55
      const henyeyGreenstein = (c: F): F =>
        float(1 - anisotropy * anisotropy).div(
          pow(float(1 + anisotropy * anisotropy).sub(c.mul(2 * anisotropy)), 1.5),
        )
      // 1 for a heading in the middle of the viewport, brighter where the eye looks into the light.
      const phase = mix(
        float(1),
        henyeyGreenstein(cosine).div(henyeyGreenstein(float(-LIGHT.z))),
        look.forward,
      )
      // Toward the light across the page, up and a little left, in px per em.
      const across = vec2(LIGHT.x, LIGHT.y).normalize()
      const stepLength = em.mul(0.22)
      const transmittance = float(1).toVar()
      const light = vec3(0).toVar()
      const jitter = scatter()
      const half2 = Math.max(1, steps >> 1)
      const dz = reach.div(half2)
      // Distance along the ray per px of depth.
      const stretch = sqrt(dot(ray, ray).add(1))

      const march = (z: F): void => {
        const sample = point.add(ray.mul(z))
        const zEm = z.div(em)
        // Noise coordinates in em; smoother along the ray than across it, so a few steps hold it.
        const noisePoint = vec3(sample.x.div(em), sample.y.div(em), zEm.mul(0.45))
        let w: V3 = noise(
          noisePoint
            .mul(0.22 * scale)
            .add(flow.mul(0.22 * scale))
            .add(offset),
        )
          .xyz.sub(0.5)
          .mul(2)
        if (ctx.quality !== 'low')
          w = w.add(
            noise(
              noisePoint
                .mul(0.6 * scale)
                .add(w.mul(0.25))
                .add(flow.mul(0.6 * scale))
                .add(offset.zxy),
            )
              .xyz.sub(0.5)
              .mul(1.2),
          )
        // Height above the ink, em: the plume sways more the higher it climbs.
        const above = clamp(top.sub(sample.y).div(em), 0, 3)
        // Some parts rise faster than others, so the smoke streaks upward.
        const fq = sample
          .add(w.xy.mul(warpAmt.add(swirl.mul(em).mul(above).mul(0.22))))
          .add(vec2(0, lift.mul(w.z.mul(0.45).add(0.75))))
        const fieldSample = fieldAt(fq)
        const [body, rising] = shape(fieldSample, zEm, w.z)
        // Not every letter smokes at once: gaps between plumes drift up with the smoke.
        const gate = noise(
          vec3(fq.x.div(em).mul(0.17), noisePoint.y.mul(0.1), 0.37)
            .add(flow.mul(vec3(0, 0.1, 0.25)))
            .add(offset),
        ).x
        const plume = rising.mul(mix(float(1), smoothstep(0.4, 0.68, gate), gating))
        // Empty air costs three fetches; only smoke reads its detail and its light.
        If(body.add(plume).greaterThan(1e-3), () => {
          // Billows, a little taller than wide; the plume in thin streaks drawn upward.
          const stretched = vec3(noisePoint.x, noisePoint.y.mul(0.55), noisePoint.z.mul(1.2))
          let billow: F = noise(
            stretched
              .mul(0.42 * scale)
              .add(w.mul(0.3))
              .add(flow.mul(0.42 * scale))
              .add(offset.yzx),
          ).w
          if (ctx.quality === 'high')
            billow = billow.mul(0.72).add(
              noise(
                stretched
                  .mul(1.1 * scale)
                  .add(w.mul(0.18))
                  .add(flow.mul(1.1 * scale))
                  .add(offset.zxy),
              ).w.mul(0.28),
            )
          const streak = noise(
            vec3(fq.x.div(em).mul(1.3), noisePoint.y.mul(0.2), zEm.mul(0.7))
              .add(flow.mul(vec3(0, 0.2, 1)))
              .add(offset.zyx),
          ).w
          const thickness = height.mul(0.42).add(0.16)
          const taper = above.mul(0.08).add(0.38)
          const rho = body
            .mul(smoothstep(thickness, thickness.add(0.3), billow))
            .add(
              plume.mul(smoothstep(taper, taper.add(0.3), streak.mul(0.65).add(billow.mul(0.35)))),
            )
          // Light reaching this point through the smoke above it, toward the light.
          let lit: F
          if (ctx.quality === 'low')
            lit = exp(fieldSample.y.mul(bodyAmt).add(fieldSample.w.mul(plumeAmt)).mul(-1.4))
          else {
            let tau: F = shade(fieldAt(fq.add(across.mul(stepLength))))
              .mul(thick)
              .mul(0.22)
            if (ctx.quality === 'high')
              tau = tau.add(
                shade(fieldAt(fq.add(across.mul(stepLength.mul(2.6)))))
                  .mul(thick)
                  .mul(0.3),
              )
            lit = exp(tau.negate())
          }
          // Smoke settling into the letters takes their light: no shadowed seams across them.
          lit = mix(float(1), lit, smoothstep(0.04, 0.35, height))
          const glow = sun.mul(phase).mul(lit).add(room) as unknown as V3
          const absorbed = exp(rho.mul(thick).mul(dz).mul(stretch).div(em).negate()).oneMinus()
          light.addAssign((tint as unknown as V3).mul(glow).mul(absorbed).mul(transmittance))
          transmittance.mulAssign(absorbed.oneMinus())
        })
      }

      // The letters at z 0: crisp at rest, blurring and breaking up in patches as they go.
      const grain = noise(
        vec3(point.x.div(em), point.y.div(em).mul(0.55), 0).mul(0.7).add(flow.mul(0.7)).add(offset),
      ).w
      const shown = clamp(
        height
          .div(0.45)
          .oneMinus()
          .mul(1.4)
          .add(
            grain
              .sub(0.5)
              .mul(smoothstep(0, 0.12, height))
              .mul(1.2),
          ),
        0,
        1,
      )
      const ink = (rasterNode as unknown as { bias(b: F): V4 }).bias(min(height.mul(7), 4.5))
      // Blurred levels of the raster reach its edge, and clamping would smear them past it.
      const inX = min(point.x.sub(rasterFrame.x), rasterFrame.x.add(rasterFrame.z).sub(point.x))
      const inY = min(point.y.sub(rasterFrame.y), rasterFrame.y.add(rasterFrame.w).sub(point.y))
      const inside = smoothstep(0, 2, min(inX, inY))
      const letterA = ink.w.mul(shown).mul(inside)
      const letter = sRGBTransferEOTF(ink.xyz.div(max(ink.w, 1e-4)) as never) as unknown as V3

      Loop(half2, ({ i }) => {
        If(transmittance.lessThan(0.01), () => {
          Break()
        })
        march(reach.sub(float(i).add(jitter).mul(dz)))
      })
      light.addAssign(letter.mul(letterA).mul(transmittance))
      transmittance.mulAssign(letterA.oneMinus())
      Loop(half2, ({ i }) => {
        If(transmittance.lessThan(0.01), () => {
          Break()
        })
        march(float(i).add(jitter).mul(dz).negate())
      })
      const alpha = transmittance.oneMinus()
      // Masked at the clamped point, half a px inside the box, where the mask is whole.
      const boxUV = vec2(
        clamp(point.x, 0.5, u.size.x.sub(0.5)).div(u.size.x),
        clamp(point.y, 0.5, u.size.y.sub(0.5)).div(u.size.y).oneMinus(),
      )
      return vec4(light.div(max(alpha, 1e-4)), alpha.add(dither()).clamp(0, 1).mul(ctx.mask(boxUV)))
    })() as unknown as V4

    const geometry = new PlaneGeometry(1, 1)
    const mesh = new Mesh(geometry, material)
    // The vertices are placed in the shader.
    mesh.frustumCulled = false
    ctx.onDispose(() => geometry.dispose())
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return
    if (trigger === 'view') seen &&= onScreen() && !veiled()

    const use = (next: Raster, made: Field): void => {
      const old = fieldMap
      fieldMap = fieldTexture(made)
      for (const read of reads) read.value = fieldMap
      old.dispose()
      rasterMap.image = next.canvas
      rasterMap.needsUpdate = true
      fieldFrame.value.set(...made.frame)
      rasterFrame.value.set(...next.frame)
      em.value = made.em
      top.value = made.bounds[1]
      layout = next
      field = made
      ctx.invalidate()
    }

    // The DOM shows the text whenever no smoke moves: at rest it is real, selectable text.
    let dom = false
    const show = (value: boolean): void => {
      dom = value
      ctx.showDom(value)
    }

    // Raster and build again when the text, its fonts or its width change.
    let cancel: (() => void) | undefined
    let stuck: string | undefined
    const redo = async (): Promise<void> => {
      cancel = undefined
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(why)
      stuck = why
      if (why) {
        ctx.invalidate()
        return
      }
      const next = raster(element, 'line', ratio)
      if (!next?.quads.length) return
      const made = await build(next)
      if (!signal.aborted) use(next, made)
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(() => void redo(), { timeout: 1000 })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(() => void redo(), 150)
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

    // Hover: the pointer over the element or the link it sits in stirs the letters; a tap on touch.
    let pointer: { x: number; y: number } | undefined
    let tapped = false
    if (trigger === 'hover') {
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      const move = (e: PointerEvent): void => {
        if (e.pointerType === 'touch') return
        pointer = { x: e.clientX, y: e.clientY }
        ctx.invalidate()
      }
      target.addEventListener('pointermove', move, { signal })
      target.addEventListener('pointerenter', move, { signal })
      target.addEventListener('pointerleave', () => (pointer = undefined), { signal })
      target.addEventListener(
        'pointerdown',
        (e) => {
          if (e.pointerType !== 'touch') return
          pointer = { x: e.clientX, y: e.clientY }
          tapped = true
          ctx.invalidate()
        },
        { signal },
      )
      // Keyboard focus breathes a wisp off the middle of the text.
      target.addEventListener(
        'focusin',
        () => {
          const rect = element.getBoundingClientRect()
          pointer = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          tapped = true
          ctx.invalidate()
        },
        { signal },
      )
    }
    const wisps: { x: number; y: number; age: number; peak: number }[] = []
    let count = 0

    // Once: seconds since the condense started, -1 before.
    let since = seen ? Number.POSITIVE_INFINITY : -1
    let rate = 0
    pacing.set(signal, () => rate)
    let time = 0
    let before: number | undefined
    let leaving = false

    return (input) => {
      const live = ctx.params
      if (stuck) {
        show(true)
        rate = 0
        return
      }
      const dt = Math.min(input.delta, 0.1)
      const speed = Math.max(0, live.speed)
      const duration = Math.max(live.duration, 0.05)
      const viewportWidth = stage.width.peek()
      const viewport = stage.height.peek()
      let s = 0
      let w = -1
      let busy = false
      let rest = false

      if (trigger === 'view') {
        if (since < 0) {
          // Counted above the bottom tenth of the viewport, like text-reveal.
          if (inView(input.y, input.height, viewport, SHOWN)) since = 0
        } else if (since < duration) since += dt
        s = since < 0 ? 1 : condense(since / duration)
        busy = since >= 0 && since < duration
        rest = since >= duration
      } else if (trigger === 'scroll') {
        const scrolled = typeof scrollY === 'number' ? scrollY : 0
        const start = input.y + scrolled + input.height / 2
        ;[s, w] = scrub(input.y + input.height / 2, input.height, viewport, start)
        rest = s <= 0
      } else if (trigger === 'hover') {
        w = 1
        const life = duration
        for (const wisp of wisps) wisp.age += dt
        while (wisps.length && (wisps[0]?.age ?? 0) >= life) wisps.shift()
        if (pointer) {
          const x = pointer.x - input.x
          const y = pointer.y - input.y
          const [left, top, right, bottom] = field.bounds
          const pad = field.em * 0.3
          const over = x > left - pad && x < right + pad && y > top - pad && y < bottom + pad
          const last = wisps[wisps.length - 1]
          const far = !last || Math.hypot(last.x - x, last.y - y) > field.em * 0.35
          if (over && (far || tapped || (last && last.age > 0.3))) {
            const peak = 0.75 + 0.25 * Math.sin(count++ * 2.4)
            wisps.push({ x, y, age: 0, peak })
            if (wisps.length > PUFFS) wisps.shift()
          }
          tapped = false
        }
        puffs.forEach((u4, i) => {
          const wisp = wisps[i]
          if (!wisp) {
            u4.value.set(0, 0, 0, 0)
            return
          }
          const k = wisp.age / life
          const amp = wisp.peak * Math.min(1, wisp.age / 0.15) * (1 - k) ** 2
          u4.value.set(wisp.x, wisp.y, wisp.age * Math.max(speed, 0.2), amp)
        })
        busy = wisps.length > 0
        rest = !busy
      } else {
        w = 1
        busy = speed > 0
      }

      // Pages: a leaving copy dissolves up and away, an entering one condenses.
      const presence = input.presence
      if (before !== undefined && presence < before - 1e-4) leaving = true
      else if (before !== undefined && presence > before + 1e-4) leaving = false
      else if (before === undefined && presence < 1) leaving = false
      before = presence
      if (presence < 1 && 1 - presence >= s) {
        s = 1 - presence
        w = leaving ? 1 : -1
        rest = false
      }

      if (trigger === 'scroll') time = 3 * (w < 0 ? 1 - s : 1 + s) * speed
      else if (busy || presence < 1 || trigger === 'loop') time += dt * speed
      clock.value = time
      amount.value = s
      way.value = w
      const seed = Math.round(live.seed)
      offset.value.set((seed * 0.6180339) % 1, (seed * 0.4142135) % 1, (seed * 0.7320508) % 1)

      // The quad: the ink with room for the smoke at this stage, seen in perspective.
      const most = trigger === 'hover' ? Math.max(s, STIR) : s
      const plume = trigger === 'loop' ? 1 : w > 0 ? Math.min(1, most * 3) : 0
      const size = field.em
      const turb = Math.max(0, live.turbulence) * look.swirl
      const up = Math.max(0, live.rise) * look.drift
      const side = size * (0.3 + turb * (0.15 + 1.2 * most + 0.8 * plume))
      const above = size * (0.3 + 2.6 * plume + up * 1.5 * most + 0.4 * most)
      const below = size * (0.3 + most * (0.5 + turb * 1.1) + (w < 0 ? up * 1.6 * most : 0))
      const [inkLeft, inkTop, inkRight, inkBottom] = field.bounds
      const [frameX, frameY, frameWidth, frameHeight] = field.frame
      const left = Math.max(frameX, inkLeft - side)
      const top = Math.max(frameY, inkTop - above)
      const right = Math.min(frameX + frameWidth, inkRight + side)
      const bottom = Math.min(frameY + frameHeight, inkBottom + below)
      // Deep enough for the body and the plume around the page plane, em.
      const depth = size * Math.max(0.12 + 1.52 * most, plume > 0 ? 0.68 + 0.6 * most : 0)
      reach.value = depth
      const cam = ctx.render.camera?.position.z ?? 1000
      const eyeX = viewportWidth / 2 - input.x
      const eyeY = viewport / 2 - input.y
      eye.value.set(eyeX, eyeY, cam)
      const near = cam / Math.max(cam - depth, 1)
      const far = cam / (cam + depth)
      const project = (v: number, e: number): [number, number] => {
        const a = e + (v - e) * near
        const b = e + (v - e) * far
        return [Math.min(a, b), Math.max(a, b)]
      }
      const [ax0] = project(left, eyeX)
      const [, ax1] = project(right, eyeX)
      const [ay0] = project(top, eyeY)
      const [, ay1] = project(bottom, eyeY)
      area.value.set(ax0, ay0, ax1, ay1)

      show(rest && presence >= 1)
      mesh.visible = !dom && s < 0.999
      rate = busy && !dom ? (trigger === 'loop' ? LOOP_FPS : 60) : 0
    }
  },
})
export default smoke
