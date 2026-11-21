import type { Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect } from '@dioramajs/effects/effect'
import { DEV, damp, dither, follow, fresnel } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  refract,
  select,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { alphaOf, backdrop } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type Params = {
  radius: number
  zoom: number
  dispersion: number
  thickness: number
  tilt: number
  ease: number
}

/** Seconds the lens takes to come down or lift away. */
const APPEAR = 0.18
/** Toward the key light from the page, world axes (z toward the viewer): up left and in front. */
const KEY = new Vector3(-0.42, 0.55, 1).normalize()
/** Crown glass for green, and the spread of red and blue at dispersion 1. */
const IOR = 1.52
const SPREAD = 0.008
/** The finger hides what is under it: on touch the lens sits this far above it, px past the radius. */
const LIFT_TOUCH = 28
/** Most raster pixels, and the longest raster side, at the low tier and above it. */
const PIXEL_BUDGET = { low: 2e6, high: 6e6 } as const
const MAX_RASTER = { low: 4096, high: 8192 } as const
/** Delay before rastering again after a change, ms. */
const REDO_DELAY = 150

/** The glass: a biconvex lens of aperture `a` with both faces of sag `sag`, edge `edge` thick. */
export interface Optics {
  readonly a: number
  readonly sag: number
  /** Half the thickness of the edge. */
  readonly edge: number
  /** Radius of both faces. */
  readonly r: number
  /** Height of the lens's middle over the page. */
  readonly height: number
  /** Magnification the lens gives at its centre. */
  readonly zoom: number
}

/** The faces of a lens of this `aperture` at a `thickness` 0..1 (how domed it is). */
function faces(aperture: number, thickness: number): { sag: number; edge: number; r: number } {
  const sag = aperture * (0.1 + 0.26 * Math.min(1, Math.max(0, thickness)))
  return { sag, edge: aperture * 0.015 + 0.5, r: (aperture * aperture + sag * sag) / (2 * sag) }
}

/**
 * Where a ray from a camera `distance` px above the page, aimed at page point `x0` from the lens
 * axis, meets the page through the lens (2D, in the plane of the axis). NaN when the glass sends it
 * elsewhere (the edge, or total internal reflection).
 */
export function trace(
  aperture: number,
  thickness: number,
  height: number,
  ior: number,
  distance: number,
  x0: number,
): number {
  const { sag, edge, r: faceRadius } = faces(aperture, thickness)
  // Lens middle at z 0, the page at -height, the camera above.
  let rayX = 0
  let rayZ = distance - height
  let dirX = x0
  let dirZ = -distance
  const norm = Math.hypot(dirX, dirZ)
  dirX /= norm
  dirZ /= norm
  const hit = (centreZ: number, far: boolean): number => {
    const fromX = rayX
    const fromZ = rayZ - centreZ
    const b = fromX * dirX + fromZ * dirZ
    const discriminant = b * b - (fromX * fromX + fromZ * fromZ - faceRadius * faceRadius)
    if (discriminant < 0) return Number.NaN
    return far ? -b + Math.sqrt(discriminant) : -b - Math.sqrt(discriminant)
  }
  const bend = (nx: number, nz: number, eta: number): boolean => {
    const cosIn = -(dirX * nx + dirZ * nz)
    const under = 1 - eta * eta * (1 - cosIn * cosIn)
    if (under < 0) return false
    const scale = eta * cosIn - Math.sqrt(under)
    dirX = eta * dirX + scale * nx
    dirZ = eta * dirZ + scale * nz
    return true
  }
  const top = edge + sag - faceRadius
  let travel = hit(top, false)
  if (!(travel >= 0)) return Number.NaN
  rayX += dirX * travel
  rayZ += dirZ * travel
  if (Math.abs(rayX) > aperture || !bend(rayX / faceRadius, (rayZ - top) / faceRadius, 1 / ior))
    return Number.NaN
  const bottom = -edge - sag + faceRadius
  travel = hit(bottom, true)
  if (!(travel >= 0)) return Number.NaN
  rayX += dirX * travel
  rayZ += dirZ * travel
  if (Math.abs(rayX) > aperture || !bend(-rayX / faceRadius, -(rayZ - bottom) / faceRadius, ior))
    return Number.NaN
  if (dirZ >= 0) return Number.NaN
  return rayX + (dirX * (-height - rayZ)) / dirZ
}

/** The magnification at the lens's centre at `height` over the page. */
export function magnification(
  aperture: number,
  thickness: number,
  height: number,
  ior: number,
  distance: number,
): number {
  const x0 = aperture * 0.05
  const x = trace(aperture, thickness, height, ior, distance, x0)
  return Number.isFinite(x) && x > 0 ? x0 / x : Number.NaN
}

/**
 * The lens for a radius on screen, a magnification and a thickness: the height over the page
 * that gives `zoom` at the centre, and the glass sized so its rim looks `radius` px from there.
 */
export function optics(radius: number, zoom: number, thickness: number, distance: number): Optics {
  const want = Math.max(1, zoom)
  let aperture = radius
  let height = 0
  let got = 1
  for (let pass = 0; pass < 4; pass++) {
    if (pass) aperture = Math.max(radius * 0.6, (radius * (distance - height)) / distance)
    const { sag, edge } = faces(aperture, thickness)
    const low = sag + edge + 0.5
    const step = aperture * 0.04
    let lo = low
    let hi = low
    let found = false
    for (let h = low; h < Math.min(low + aperture * 12, distance * 0.4); h += step) {
      const zoomAt = magnification(aperture, thickness, h, IOR, distance)
      if (!Number.isFinite(zoomAt)) break
      if (zoomAt >= want) {
        hi = h
        found = true
        break
      }
      lo = h
    }
    if (found) {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        const zoomAt = magnification(aperture, thickness, mid, IOR, distance)
        if (Number.isFinite(zoomAt) && zoomAt < want) lo = mid
        else hi = mid
      }
      height = (lo + hi) / 2
    } else height = lo
    got = magnification(aperture, thickness, height, IOR, distance)
  }
  const { sag, edge, r } = faces(aperture, thickness)
  return { a: aperture, sag, edge, r, height, zoom: Number.isFinite(got) ? got : 1 }
}

/** A CSS color as `#rrggbb`, undefined for none or a transparent one. */
const solid = (value: string | undefined): string | undefined =>
  value && alphaOf(value) >= 0.5 ? cssColor(value) : undefined

/** The page color under the element's text, and behind the element. */
export function grounds(element: Element): { own: string; behind: string; dark: boolean } {
  const text = cssColor(getComputedStyle(element).color) ?? '#000000'
  const ink = new Color(text)
  const light = 0.2126 * ink.r + 0.7152 * ink.g + 0.0722 * ink.b > 0.35
  const parent = element.parentElement
  const found = parent ? backdrop(parent) : undefined
  const fallback = found?.color ?? (light ? '#111111' : '#ffffff')
  const behind = found?.color ?? solid(getComputedStyle(found?.element ?? element).backgroundColor)
  const own = solid(getComputedStyle(element).backgroundColor)
  return { own: own ?? behind ?? fallback, behind: behind ?? fallback, dark: light }
}

/** The raster as a texture: premultiplied sRGB with mip levels for the rim, where it shrinks. */
function inkTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  map.colorSpace = SRGBColorSpace
  map.minFilter = LinearMipmapLinearFilter
  map.magFilter = LinearFilter
  map.anisotropy = 4
  return map
}

function quad(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  return geometry
}

/** One line of text for the keyboard, box px. */
interface Row {
  readonly x0: number
  readonly x1: number
  readonly y: number
}
export function rows(layout: Raster): Row[] {
  return [...layout.quads]
    .sort((p, q) => p.y - q.y)
    .map((q) => ({ x0: q.x, x1: q.x + q.width, y: q.y + q.height / 2 }))
}

/**
 * A reading glass over the text: a thick biconvex lens in a thin metal ring follows the pointer,
 * traced per pixel through both curved faces. The text under it comes up magnified in the middle,
 * bends and splits into colors toward the rim; the glass reflects a studio, and on the page beside
 * it lies its shadow with the light it focuses and the shadow of its handle. It leans into its
 * motion and settles. The DOM text stays as it is around the lens.
 */
const lens: Effect<Params> = defineEffect({
  name: 'lens',
  params: {
    radius: 90,
    zoom: 2,
    dispersion: 1,
    thickness: 0.4,
    tilt: 12,
    ease: 0.12,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The lens and its shadow reach past the box.
  bleed: 240,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, app, signal, render } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const css = unsupported(element)
    const reason = (css === 'text-shadow' ? undefined : css) ?? (await fonts(element))
    if (signal.aborted) return
    const box = element.getBoundingClientRect()
    const dpr = stage.pixelRatio.peek() || 1
    const low = ctx.quality === 'low'
    const budget = low ? PIXEL_BUDGET.low : PIXEL_BUDGET.high
    const ratioOf = (): number =>
      Math.max(
        1,
        Math.min(
          low ? dpr : 4,
          dpr * Math.max(1, ctx.params.zoom),
          Math.sqrt(budget / Math.max(1, box.width * box.height)),
        ),
      )
    let ratio = ratioOf()
    let layout = reason
      ? undefined
      : raster(element, 'line', ratio, low ? MAX_RASTER.low : MAX_RASTER.high)
    if (!layout?.quads.length) {
      if (reason && DEV) app.log.warn(`lens: ${reason} cannot be drawn, no lens on it`, element)
      return
    }
    let lines = rows(layout)
    if (DEV && backdrop(element)?.color === undefined && backdrop(element))
      app.log.warn('lens: the lens shows a solid color in place of a background image', element)

    const frame = uniform(new Vector4(...layout.frame))
    // Box in world px: left, top, width, height.
    const boxW = uniform(new Vector4(0, 0, 1, 1))
    // The quad: min x, min y, max x, max y in world px.
    const area = uniform(new Vector4(0, 0, 0, 0))
    const centre = uniform(new Vector3())
    const toWorld = uniform(new Matrix3())
    const toLocal = uniform(new Matrix3())
    // Aperture, sag, half edge, face radius.
    const glass = uniform(new Vector4(80, 10, 1, 300))
    const iorU = uniform(new Vector3(IOR, IOR, IOR))
    const ring = uniform(4)
    // Shadow: centre xy, radius, softness; light spot radius per channel and its gain.
    const shade = uniform(new Vector4(0, 0, 80, 4))
    const spot = uniform(new Vector3(40, 40, 40))
    const gain = uniform(1)
    // The handle's shadow: from, to (world xy).
    const handle = uniform(new Vector4())
    const handleW = uniform(new Vector2(10, 4))
    const shown = uniform(0)
    // The page point under the lens's middle (world xy) and the magnification per channel.
    const aim = uniform(new Vector2())
    const mags = uniform(new Vector3(2, 2, 2))
    const ground = grounds(element)
    const own = uniform(new Color(ground.own))
    const behind = uniform(new Color(ground.behind))
    const darkPage = uniform(ground.dark ? 1 : 0)

    const corner = positionGeometry.xy.add(0.5)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(mix(area.x, area.z, corner.x), mix(area.y, area.w, corner.y), 0)
    const inkMap = inkTexture(layout.canvas)
    const inks: { value: Texture }[] = []

    const lightDir = vec3(KEY.x, KEY.y, KEY.z)
    const lightU = normalize(vec3(KEY.z, 0, -KEY.x))
    const lightV = normalize(
      vec3(
        lightDir.y.mul(lightU.z).sub(lightDir.z.mul(lightU.y)),
        lightDir.z.mul(lightU.x).sub(lightDir.x.mul(lightU.z)),
        lightDir.x.mul(lightU.y).sub(lightDir.y.mul(lightU.x)),
      ),
    )
    /** The studio over the page: a dim room, a softbox up left and a strip on the right. */
    const env = (ray: V3): V3 => {
      const up = ray.z
      const room = mix(vec3(0.03, 0.032, 0.036), vec3(0.32, 0.33, 0.35), smoothstep(-0.2, 0.9, up))
      const x = dot(ray, lightU)
      const y = dot(ray, lightV)
      const softbox = smoothstep(0.035, 0, max(abs(x).sub(0.26), abs(y).sub(0.16))).mul(
        smoothstep(0, 0.2, dot(ray, lightDir)),
      )
      const strip = smoothstep(0.5, 0.56, ray.x)
        .mul(smoothstep(0.74, 0.68, ray.x))
        .mul(smoothstep(-0.4, 0, ray.y))
        .mul(smoothstep(0.7, 0.3, ray.y))
      return room.add(softbox.mul(7)).add(strip.mul(1.6)) as V3
    }

    /** The light on the page at world xy `point`, per channel: 1 unshaded. */
    const lightAt = (point: V2): V3 => {
      const dist = length(point.sub(shade.xy))
      const soft = shade.w
      const blocked = smoothstep(shade.z.add(soft), shade.z.sub(soft), dist)
      const metal = smoothstep(shade.z.add(ring).add(soft), shade.z.add(ring).sub(soft), dist).sub(
        blocked,
      )
      const focus = (radius: F): F =>
        smoothstep(radius.add(soft.mul(0.7)), radius.sub(soft.mul(0.7)), dist)
      const focused = vec3(focus(spot.x), focus(spot.y), focus(spot.z)).mul(gain)
      // The handle: a capsule.
      const toPoint = point.sub(handle.xy)
      const handleSpan = handle.zw.sub(handle.xy)
      const share = clamp(
        dot(toPoint, handleSpan).div(max(dot(handleSpan, handleSpan), 1e-3)),
        0,
        1,
      )
      const stick = smoothstep(
        handleW.x.add(handleW.y),
        handleW.x.sub(handleW.y),
        length(toPoint.sub(handleSpan.mul(share))),
      )
      const direct = max(vec3(1).sub(blocked).sub(max(metal, stick)).add(focused), vec3(0))
      return mix(vec3(1), direct, 0.34) as V3
    }

    /** The page at world xy `point`: the element's text over its background, lit. */
    const pageAt = (point: V2): V3 => {
      const boxX = point.x.sub(boxW.x)
      const boxY = boxW.y.sub(point.y)
      const inside = smoothstep(-0.5, 0.5, boxX)
        .mul(smoothstep(boxW.z.add(0.5), boxW.z.sub(0.5), boxX))
        .mul(smoothstep(-0.5, 0.5, boxY))
        .mul(smoothstep(boxW.w.add(0.5), boxW.w.sub(0.5), boxY))
      const uv = vec2(boxX.sub(frame.x).div(frame.z), boxY.sub(frame.y).div(frame.w).oneMinus())
      const texel = texture(inkMap, uv)
      inks.push(texel as unknown as { value: Texture })
      const bg = mix(behind, own, inside)
      return bg.mul(texel.a.oneMinus()).add(texel.rgb).mul(lightAt(point)) as V3
    }

    // The ray of this pixel, in the lens's frame (z along its axis, origin in its middle).
    const fragWorld = positionWorld
    const dirW = normalize(fragWorld.sub(cameraPosition))
    const origin = toLocal.mul(cameraPosition.sub(centre)) as unknown as V3
    const dir = toLocal.mul(dirW) as unknown as V3
    const aperture = glass.x
    const sag = glass.y
    const edge = glass.z
    const faceRadius = glass.w
    // Through the middle plane: the ring and the silhouette.
    const toMiddle = origin.z.negate().div(dir.z)
    const onMiddle = origin.add(dir.mul(toMiddle))
    const fromAxis = length(onMiddle.xy)
    const pixel = max(fwidth(fromAxis), 1e-3)
    const cover = clamp(aperture.add(ring).sub(fromAxis).div(pixel).add(0.5), 0, 1)

    // The top face.
    const topCentre = vec3(0, 0, edge.add(sag).sub(faceRadius))
    const fromTop = origin.sub(topCentre)
    const along = dot(fromTop, dir)
    const discriminant = along.mul(along).sub(dot(fromTop, fromTop).sub(faceRadius.mul(faceRadius)))
    const entry = origin.add(dir.mul(along.negate().sub(sqrt(max(discriminant, 0)))))
    const entryNormal = normalize(entry.sub(topCentre))
    const cosI = clamp(dot(dir, entryNormal).negate(), 0, 1)
    const reflectance = fresnel(cosI, 0.04)
    const mirrored = toWorld.mul(reflect(dir, entryNormal)) as unknown as V3
    const bottomCentre = vec3(0, 0, edge.negate().sub(sag).add(faceRadius))
    // Seen through the glass, one channel at a time for the dispersion.
    const channel = (ior: F, index: 0 | 1 | 2): { value: F; bad: F; path: F } => {
      const refracted = refract(dir, entryNormal, float(1).div(ior)) as unknown as V3
      const fromBottom = entry.sub(bottomCentre)
      const along2 = dot(fromBottom, refracted)
      const discriminant2 = along2
        .mul(along2)
        .sub(dot(fromBottom, fromBottom).sub(faceRadius.mul(faceRadius)))
      const travel2 = along2.negate().add(sqrt(max(discriminant2, 0)))
      const exit = entry.add(refracted.mul(travel2))
      const exitNormal = normalize(exit.sub(bottomCentre))
      const outside = refract(refracted, exitNormal.negate(), ior) as unknown as V3
      const exitWorld = centre.add(toWorld.mul(exit) as unknown as V3)
      const outsideWorld = toWorld.mul(outside) as unknown as V3
      const toPage = exitWorld.z.negate().div(min(outsideWorld.z, -1e-3))
      // A paraxial lens in the middle, the traced glass with its aberrations toward the rim.
      const ideal = aim.add(
        fragWorld.xy.sub(aim).div(index === 0 ? mags.x : index === 1 ? mags.y : mags.z),
      )
      const landing = mix(
        ideal,
        exitWorld.xy.add(outsideWorld.xy.mul(toPage)),
        pow(smoothstep(0.5, 1, length(entry.xy).div(aperture)), 2).mul(0.6),
      )
      const page = pageAt(landing)
      const bad = max(
        smoothstep(0.3, 0.6, dot(outside, outside)).oneMinus(),
        smoothstep(aperture.sub(1), aperture.add(0.5), length(exit.xy)),
      ).max(smoothstep(-0.08, -0.02, outsideWorld.z))
      return { value: index === 0 ? page.x : index === 1 ? page.y : page.z, bad, path: travel2 }
    }
    const red = channel(iorU.x, 0)
    const green = channel(iorU.y, 1)
    const blue = channel(iorU.z, 2)
    const through = vec3(red.value, green.value, blue.value)
    const bad = max(red.bad, max(green.bad, blue.bad))
    // Crown glass is a little green through its thickness.
    const absorb = exp(vec3(0.0011, 0.0004, 0.0008).mul(green.path).negate())
    const reflected = env(mirrored)
    const edgeColor = mix(vec3(0.05, 0.06, 0.06), vec3(0.3, 0.33, 0.33), darkPage).add(
      reflected.mul(0.25),
    )
    const entryRadius = length(entry.xy)
    // A thin bright line where the face meets the edge on the lit side.
    const lit = max(dot(normalize(entry.xy.add(1e-4)), vec2(KEY.x, KEY.y).normalize()), 0)
    const rim = exp(aperture.sub(entryRadius).div(1.4).pow(2).negate()).mul(lit.mul(1.4).add(0.25))
    const glassRGB = mix(
      through.mul(absorb).mul(reflectance.oneMinus()).add(reflected.mul(reflectance)),
      edgeColor,
      bad,
    ).add(rim)
    // The ring: polished steel, round in section.
    const acrossRing = clamp(fromAxis.sub(aperture.add(ring.mul(0.5))).div(ring.mul(0.5)), -1, 1)
    const radial = normalize(onMiddle.xy.add(1e-4))
    const nRing = normalize(
      vec3(radial.mul(acrossRing), sqrt(max(acrossRing.mul(acrossRing).oneMinus(), 0.02))),
    )
    const steel = env(toWorld.mul(reflect(dir, nRing)) as unknown as V3)
      .mul(vec3(0.78, 0.79, 0.82))
      .add(0.04)
    const onRing = smoothstep(aperture.sub(0.6), aperture.add(0.4), fromAxis)
    const valid = smoothstep(0, 1, discriminant)
    const lensRGB = mix(mix(edgeColor, glassRGB, valid), steel, onRing)

    // Beside the lens: its shadow darkens the page, the light it focuses brightens it.
    const pageLight = lightAt(fragWorld.xy)
    const most = max(pageLight.x, max(pageLight.y, pageLight.z))
    const darken = clamp(float(1).sub(pageLight.x.add(pageLight.y).add(pageLight.z).div(3)), 0, 1)
    const lighten = clamp(most.sub(1).mul(0.55), 0, 0.6)
    const outA = select(most.greaterThan(1), lighten, darken) as unknown as F
    const outRGB = select(
      most.greaterThan(1),
      pageLight.div(max(most, 1e-3)).mul(vec3(1, 0.97, 0.9)),
      vec3(0),
    ) as unknown as V3
    const alpha = cover.add(outA.mul(cover.oneMinus()))
    const rgb = lensRGB.mul(cover).add(outRGB.mul(outA, cover.oneMinus())).div(max(alpha, 1e-4))
    // The lens floats over the page: the element's radius and clip do not cut it, its opacity does.
    material.colorNode = vec4(rgb.add(dither()), alpha.mul(shown).mul(ctx.u.opacity))

    const mesh = new Mesh(quad(), material)
    mesh.frustumCulled = false
    ctx.overlay.add(mesh)
    ctx.onDispose(() => (inks[0]?.value ?? inkMap).dispose())
    await ctx.compile(mesh)
    if (signal.aborted) return
    mesh.visible = false

    // Build again when the text, its fonts, its width or the zoom change.
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      if (await fonts(element)) return
      if (signal.aborted) return
      ratio = ratioOf()
      const next = raster(element, 'line', ratio, low ? MAX_RASTER.low : MAX_RASTER.high)
      if (!next?.quads.length) return
      const old = inks[0]?.value
      const fresh = inkTexture(next.canvas)
      for (const node of inks) node.value = fresh
      old?.dispose()
      frame.value.set(...next.frame)
      layout = next
      lines = rows(next)
      ctx.invalidate()
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

    // Where the lens is wanted: the pointer in client px, or a place in box px from the keys.
    let want = false
    let client: { x: number; y: number } | undefined
    let keys: { x: number; y: number } | undefined
    // A finger is down: the lens sits above it.
    let touch = false
    const recolor = (): void => {
      const now = grounds(element)
      own.value.set(now.own)
      behind.value.set(now.behind)
      darkPage.value = now.dark ? 1 : 0
    }
    const show = (): void => {
      if (!want) recolor()
      want = true
      ctx.invalidate()
    }
    const hide = (): void => {
      if (!want) return
      want = false
      ctx.invalidate()
    }
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, fn, { signal })
    const point = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') touch = true
      client = { x: e.clientX, y: e.clientY }
      keys = undefined
      show()
    }
    follow(ctx, {
      enter: point,
      move: point,
      leave(e) {
        if (e.pointerType === 'touch') {
          touch = false
          hide()
        } else if (!keys) hide()
      },
    })
    addEventListener('blur', hide, { signal })
    // Keys: with a tabindex the arrows walk the lens along the lines.
    const place = (row: number, x: number): void => {
      const line = lines[Math.max(0, Math.min(lines.length - 1, row))]
      if (!line) return
      keys = { x: Math.max(line.x0, Math.min(line.x1, x)), y: line.y }
      client = undefined
      show()
    }
    const rowOf = (y: number): number => {
      let best = 0
      lines.forEach((line, i) => {
        if (Math.abs(line.y - y) < Math.abs((lines[best]?.y ?? 0) - y)) best = i
      })
      return best
    }
    listen('focus', () => {
      if (!el.matches(':focus-visible')) return
      const first = lines[0]
      if (first) place(0, first.x0 + Math.min(ctx.params.radius, (first.x1 - first.x0) / 2))
    })
    listen('blur', () => {
      if (keys) {
        keys = undefined
        hide()
      }
    })
    listen('keydown', (e) => {
      const at = keys
      const step = Math.max(24, ctx.params.radius * 0.75)
      if (e.key === 'Escape') {
        if (want) hide()
        return
      }
      if (!at) {
        if (!e.key.startsWith('Arrow')) return
        const first = lines[0]
        if (!first) return
        place(0, first.x0 + Math.min(ctx.params.radius, (first.x1 - first.x0) / 2))
        e.preventDefault()
        return
      }
      const row = rowOf(at.y)
      const line = lines[row] as Row
      if (e.key === 'ArrowRight') {
        if (at.x >= line.x1 - 0.5 && row < lines.length - 1)
          place(row + 1, (lines[row + 1] as Row).x0)
        else place(row, at.x + step)
      } else if (e.key === 'ArrowLeft') {
        if (at.x <= line.x0 + 0.5 && row > 0) place(row - 1, (lines[row - 1] as Row).x1)
        else place(row, at.x - step)
      } else if (e.key === 'ArrowDown') place(row + 1, at.x)
      else if (e.key === 'ArrowUp') place(row - 1, at.x)
      else if (e.key === 'Home') place(row, line.x0)
      else if (e.key === 'End') place(row, line.x1)
      else return
      e.preventDefault()
    })

    // Motion: the lens's place in box px and its velocity, the lean and its spring, the fade.
    const pos = { x: 0, y: 0 }
    const vel = { x: 0, y: 0 }
    const lean = { x: 0, y: 0 }
    const spin = { x: 0, y: 0 }
    let vis = 0
    let fresh = true
    let built = { radius: 0, zoom: 0, thickness: -1, dispersion: -1, distance: 0 }
    let opt: Optics = optics(90, 2, 0.4, 1000)
    let spots: [number, number, number] = [1, 1, 1]
    const basis = new Matrix3()
    const world = { x: 0, y: 0 }
    const axis = new Vector3()
    const ux = new Vector3()
    const uy = new Vector3()
    const up = new Vector3(0, 1, 0)
    const pt = new Vector3()

    return (input): boolean => {
      const p = ctx.params
      const reduced = input.reducedMotion
      const dt = Math.min(input.delta, 0.1)
      const distance = render.camera.position.z || 1000
      if (
        p.radius !== built.radius ||
        p.zoom !== built.zoom ||
        p.thickness !== built.thickness ||
        p.dispersion !== built.dispersion ||
        distance !== built.distance
      ) {
        if (built.zoom && Math.abs(p.zoom - built.zoom) / built.zoom > 0.25 && !timer) schedule()
        built = { ...p, distance }
        const radius = Math.max(8, p.radius)
        opt = optics(radius, p.zoom, p.thickness, distance)
        const spread = SPREAD * Math.max(0, p.dispersion)
        iorU.value.set(IOR - spread, IOR, IOR + spread)
        glass.value.set(opt.a, opt.sag, opt.edge, opt.r)
        ring.value = Math.max(2.5, opt.a * 0.045)
        const zoomFor = (ior: number): number =>
          magnification(opt.a, p.thickness, opt.height, ior, distance) || opt.zoom
        spots = [opt.a / zoomFor(IOR - spread), opt.a / opt.zoom, opt.a / zoomFor(IOR + spread)]
        mags.value.set(opt.a / spots[0], opt.zoom, opt.a / spots[2])
        gain.value = Math.min(4, 1 + (opt.zoom * opt.zoom - 1) * 0.35)
      }
      // The target in box px.
      let targetX = pos.x
      let targetY = pos.y
      if (client) {
        targetX = client.x - input.x
        targetY = client.y - input.y - (touch ? p.radius + LIFT_TOUCH : 0)
        const out =
          !touch &&
          (client.x < input.x ||
            client.x > input.x + input.width ||
            client.y < input.y ||
            client.y > input.y + input.height)
        if (out) want = false
      } else if (keys) {
        targetX = keys.x
        targetY = keys.y
      }
      const goal = want && input.presence >= 1 ? 1 : 0
      if (fresh || vis === 0 || reduced || dt <= 0) {
        pos.x = targetX
        pos.y = targetY
        vel.x = vel.y = 0
        fresh = false
      } else if (dt > 0) {
        const nextX = damp(pos.x, targetX, Math.max(0.001, p.ease), dt)
        const nextY = damp(pos.y, targetY, Math.max(0.001, p.ease), dt)
        vel.x = damp(vel.x, (nextX - pos.x) / dt, 0.05, dt)
        vel.y = damp(vel.y, (nextY - pos.y) / dt, 0.05, dt)
        pos.x = nextX
        pos.y = nextY
      }
      if (Math.hypot(targetX - pos.x, targetY - pos.y) < 0.05) {
        pos.x = targetX
        pos.y = targetY
      }
      if (dt <= 0) vis = goal
      else if (goal > vis) vis = Math.min(1, vis + dt / APPEAR)
      else if (goal < vis) vis = Math.max(0, vis - dt / APPEAR)
      if (reduced && goal === 0) vis = 0
      // The lean: toward the motion, through an underdamped spring.
      const limit = reduced ? 0 : (Math.max(0, p.tilt) * Math.PI) / 180
      const speed = Math.hypot(vel.x, vel.y)
      const amount = speed > 1e-3 ? (limit * Math.tanh(speed / 1400)) / speed : 0
      // Box px are y down; the lean is in world axes, y up.
      const leanX = vel.x * amount
      const leanY = -vel.y * amount
      if (reduced) {
        lean.x = lean.y = spin.x = spin.y = 0
      } else {
        for (let left = dt; left > 1e-6; left -= 1 / 120) {
          const step = Math.min(left, 1 / 120)
          spin.x += (170 * (leanX - lean.x) - 11 * spin.x) * step
          spin.y += (170 * (leanY - lean.y) - 11 * spin.y) * step
          lean.x += spin.x * step
          lean.y += spin.y * step
        }
      }
      const leaning =
        Math.hypot(lean.x - leanX, lean.y - leanY) > 2e-4 || Math.hypot(spin.x, spin.y) > 2e-3
      const settling =
        vis !== goal ||
        pos.x !== targetX ||
        pos.y !== targetY ||
        (vis > 0 && (leaning || speed > 0.5))
      if (!settling) vel.x = vel.y = 0
      shown.value = vis * vis * (3 - 2 * vis)
      mesh.visible = vis > 0
      if (!mesh.visible) return settling

      const stageWidth = stage.width.peek()
      const stageHeight = stage.height.peek()
      boxW.value.set(input.x - stageWidth / 2, stageHeight / 2 - input.y, input.width, input.height)
      // The page point under the pointer, and the lens on the line from the camera through it.
      world.x = input.x + pos.x - stageWidth / 2
      world.y = stageHeight / 2 - (input.y + pos.y)
      aim.value.set(world.x, world.y)
      const height = opt.height + (1 - vis) * opt.a * 0.6
      const pull = 1 - height / distance
      centre.value.set(world.x * pull, world.y * pull, height)
      // Held square to the line of sight, leaning with the motion.
      axis.set(-world.x * pull, -world.y * pull, distance - height).normalize()
      axis.x += Math.tan(lean.x)
      axis.y += Math.tan(lean.y)
      axis.normalize()
      ux.crossVectors(up, axis).normalize()
      uy.crossVectors(axis, ux)
      basis.set(ux.x, uy.x, axis.x, ux.y, uy.y, axis.y, ux.z, uy.z, axis.z)
      toWorld.value.copy(basis)
      toLocal.value.copy(basis).transpose()
      // The shadow: the lens projected along the key light onto the page.
      const lensCentre = centre.value
      const shadowX = lensCentre.x - (KEY.x * lensCentre.z) / KEY.z
      const shadowY = lensCentre.y - (KEY.y * lensCentre.z) / KEY.z
      const soft = 1.5 + lensCentre.z * 0.05
      shade.value.set(shadowX, shadowY, opt.a, soft)
      spot.value.set(...spots)
      // The handle leaves the ring down and to the right and rises toward the hand.
      const ringW = ring.value as number
      const handleDir = [Math.cos(-0.87), Math.sin(-0.87)] as const
      const project = (along: number, rise: number, out: Vector2): Vector2 => {
        pt.set(handleDir[0] * along, handleDir[1] * along, rise)
          .applyMatrix3(basis)
          .add(lensCentre)
        return out.set(pt.x - (KEY.x * pt.z) / KEY.z, pt.y - (KEY.y * pt.z) / KEY.z)
      }
      const from = project(opt.a + ringW, 0, new Vector2())
      const to = project(opt.a + ringW + opt.a * 2.6, opt.a * 0.5, new Vector2())
      handle.value.set(from.x, from.y, to.x, to.y)
      handleW.value.set(opt.a * 0.11, soft * 1.4)
      // The quad holds the lens as seen and its shadow.
      const seen = (opt.a + ringW) * (distance / (distance - height)) + 4
      const reach = opt.a + ringW + soft * 2
      const minX = Math.min(world.x - seen, shadowX - reach, to.x - opt.a * 0.2)
      const maxX = Math.max(world.x + seen, shadowX + reach, to.x + opt.a * 0.2)
      const minY = Math.min(world.y - seen, shadowY - reach, to.y - opt.a * 0.2)
      const maxY = Math.max(world.y + seen, shadowY + reach, to.y + opt.a * 0.2)
      area.value.set(minX, minY, maxX, maxY)
      return settling
    }
  },
})
export default lens
