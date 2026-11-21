import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, dither } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  cameraPosition,
  clamp,
  dot,
  float,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  screenCoordinate,
  smoothstep,
  sqrt,
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
  CanvasTexture,
  Color,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { FINISHES, type Material, type Press, press, type Style, TILE, tile } from './emboss-maps'
import { alphaOf } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type Params = {
  style: ChoiceParam<Style>
  material: ChoiceParam<Material>
  depth: number
  bevel: number
  light: number
  follow: number
  grain: number
  color: string
}

/** Lines set smaller than this, px, are printed in their color by emboss and deboss. */
export const SMALL = 22
/** Seconds the light takes to follow the pointer. */
const TRACK = 0.12
const DEG = Math.PI / 180
/** Ambient and direct share of the light on the surface. */
const AMBIENT = 0.42
const DIRECT = 0.75
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before building again after a change, ms. */
const REDO_DELAY = 150

/** A CSS color as `#rrggbb`: var() and currentColor are read from the element. */
function colorOf(value: string, element: Element): string | undefined {
  const style = getComputedStyle(element)
  let word = value.trim()
  for (let depth = 0; depth < 8; depth++) {
    const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/is.exec(word)
    if (!varMatch) break
    word = style.getPropertyValue(varMatch[1] as string).trim() || (varMatch[2] ?? '').trim()
  }
  if (!word || word.toLowerCase() === 'currentcolor') {
    const fill = style.getPropertyValue('-webkit-text-fill-color')
    word = fill && !/^(transparent|rgba\(.*,\s*0\))$/.test(fill) ? fill : style.color
  }
  return cssColor(word)
}

/**
 * The material's base color: the element's own background color when it has one at least half
 * opaque (the surface then covers the box), else undefined.
 */
export function backgroundOf(element: Element): string | undefined {
  const bg = getComputedStyle(element).backgroundColor ?? ''
  return alphaOf(bg) >= 0.5 ? cssColor(bg) : undefined
}

/** The color behind the element: the first ancestor background at least half opaque, or white. */
function wallOf(element: Element): string {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const bg = backgroundOf(at)
    if (bg) return bg
  }
  return '#ffffff'
}

/**
 * The light at rest, from the box center in px (y down) and its height: `angle` as a CSS angle
 * (0 above, 90 right) at about the size of the box away and above it, moved up and down with the
 * box's place in the viewport, as a lamp fixed in the room would be.
 */
export function rest(
  angle: number,
  width: number,
  height: number,
  middle: number,
  viewport: number,
): [number, number, number] {
  const big = Math.max(width, height, 240)
  const reach = big * 0.55
  const radians = angle * DEG
  const drift = Math.max(-reach, Math.min(reach, (viewport / 2 - middle) * 0.45))
  return [
    Math.sin(radians) * reach,
    -Math.cos(radians) * reach + drift,
    Math.min(700, Math.max(140, big * 0.45)),
  ]
}

/** The pointer's offset from the box center, eased so a far pointer stays a lamp nearby. */
export function reachOf(dx: number, dy: number, width: number, height: number): [number, number] {
  const limit = Math.max(width, height, 240) * 0.9 + 160
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-6) return [0, 0]
  const eased = (limit * Math.tanh(dist / limit)) / dist
  return [dx * eased, dy * eased]
}

/** The raster as a texture: premultiplied ink in its own colors, one texel per raster pixel. */
function inkTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const map = new CanvasTexture(canvas)
  map.premultiplyAlpha = true
  map.colorSpace = SRGBColorSpace
  map.generateMipmaps = false
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  return map
}

function dataTexture(
  data: Uint16Array,
  width: number,
  height: number,
  repeat: boolean,
): DataTexture {
  const map = new DataTexture(data, width, height, RGBAFormat, HalfFloatType)
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  if (repeat) {
    map.wrapS = RepeatWrapping
    map.wrapT = RepeatWrapping
  }
  map.needsUpdate = true
  return map
}

/**
 * The text drawn as ink: every line for letterpress and stamp or with a color given, otherwise only
 * the lines too small to read as a blind relief.
 */
function inkOf(layout: Raster, all: boolean): HTMLCanvasElement {
  if (all) return layout.canvas
  const canvas = document.createElement('canvas')
  canvas.width = layout.canvas.width
  canvas.height = layout.canvas.height
  const context = canvas.getContext('2d')
  if (!context) return canvas
  const scale = layout.canvas.width / Math.max(1e-6, layout.frame[2])
  for (const line of layout.quads) {
    if (line.em >= SMALL) continue
    const y = Math.max(0, Math.floor((line.y - layout.frame[1]) * scale))
    const rows = Math.min(canvas.height - y, Math.ceil(line.height * scale) + 1)
    if (rows > 0)
      context.drawImage(layout.canvas, 0, y, canvas.width, rows, 0, y, canvas.width, rows)
  }
  return canvas
}

/** One quad, corners at ±0.5. */
function quad(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  return geometry
}

/** Pacing of each instance, frames a second for the policy. */
const pacing = new WeakMap<AbortSignal, () => number>()

/**
 * Letters pressed into or raised out of a material: paper, leather, brushed metal, stone or
 * plaster drawn over the element's box in its background color, with the relief built from the
 * shape of the glyphs. A lamp follows the pointer and drifts with the scroll; the letters, their
 * walls and the fine grain of the surface catch it and cast real shadows. The text stays in the
 * DOM, hidden behind the copy.
 */
const emboss: Effect<Params> = defineEffect({
  name: 'emboss',
  params: {
    style: oneOf('emboss', 'deboss', 'letterpress', 'stamp'),
    material: oneOf('paper', 'leather', 'metal', 'stone', 'plaster'),
    depth: 0.05,
    bevel: 0.03,
    light: 315,
    follow: 1,
    grain: 1,
    color: '',
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // Shadows and the stamp's pad can reach past a box without a background.
  bleed: 60,
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    const steps = ctx.quality === 'low' ? 8 : 16
    // The surface draws its own light and shadow: a text-shadow (a CSS fallback) is fine.
    const css = unsupported(element)
    const reason = (css === 'text-shadow' ? undefined : css) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`emboss: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    const style = params.style
    const finish = FINISHES[params.material]
    const given = params.color.trim()
    const tint = given ? colorOf(given, element) : undefined
    if (given && !tint && DEV) app.log.warn(`emboss: "${given}" is not a color, left out`, element)
    const picture = getComputedStyle(element).backgroundImage
    if (DEV && picture && picture !== 'none')
      app.log.warn('emboss: a background image is not drawn, only the background color', element)
    const allInk = style === 'letterpress' || style === 'stamp' || !!tint

    const surface = press(layout, style, ctx.params.bevel, ratio)
    let built = ctx.params.bevel
    const solidOf = (): string | undefined => backgroundOf(element)
    const own = solidOf()

    const frame = uniform(new Vector4(...layout.frame))
    const field = uniform(new Vector4(...surface.frame))
    // The lamp from the box's middle, px y down, and its height.
    const offset = uniform(new Vector3(0, -400, 400))
    const solid = uniform(own ? 1 : 0)
    const base = uniform(new Color(own ?? wallOf(element)))
    const ink = uniform(new Color(tint ?? colorOf('', element) ?? '#222222'))
    const tinted = uniform(tint ? 1 : 0)
    const emU = uniform(surface.em)
    const topU = uniform(surface.top)
    const norm = uniform(1)

    const half = u.size.mul(0.5)
    const lamp = vec3(half.x.add(offset.x), half.y.add(offset.y), offset.z)
    // The quad: the box, and without a background also the relief's field past it. Sized from
    // the live box size, so a layout change at rest never leaves it short.
    const left = mix(min(field.x, 0), float(0), solid)
    const top = mix(min(field.y, 0), float(0), solid)
    const right = mix(max(field.x.add(field.z), u.size.x), u.size.x, solid)
    const bottom = mix(max(field.y.add(field.w), u.size.y), u.size.y, solid)
    const corner = positionGeometry.xy.add(0.5)
    const quadX = left.add(corner.x.mul(right.sub(left)))
    const quadY = top.add(corner.y.oneMinus().mul(bottom.sub(top)))
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(quadX.sub(half.x), half.y.sub(quadY), 0)
    const point = varying(vec2(quadX, quadY)) as unknown as V2

    const reliefMap = dataTexture(surface.data, surface.width, surface.height, false)
    const tileMap = dataTexture(tile(params.material), TILE, TILE, true)
    const inkMap = inkTexture(inkOf(layout, allInk))
    const reliefNodes: { value: Texture }[] = []
    const relief = (at: V2): Node<'vec4'> => {
      const node = texture(
        reliefMap,
        vec2(at.x.sub(field.x).div(field.z), at.y.sub(field.y).div(field.w)),
      )
      reliefNodes.push(node as unknown as { value: Texture })
      return node as unknown as Node<'vec4'>
    }
    const reliefAt = relief(point)
    const depth = max(u.depth, 0)
    const height = reliefAt.z.mul(depth)
    const fine = texture(tileMap, point.div(TILE))
    const broad = texture(tileMap, point.div(TILE * 4.7).add(vec2(0.37, 0.61)))
    const inkNode = texture(
      inkMap,
      vec2(point.x.sub(frame.x).div(frame.z), point.y.sub(frame.y).div(frame.w).oneMinus()),
    )

    // Where the surface is pressed in, raised, or under the stamp's wax.
    const reliefEm = reliefAt.z.div(emU)
    const pressed = smoothstep(0.08, 0.5, reliefEm.negate())
    const pad = style === 'stamp' ? smoothstep(0.1, 0.26, reliefEm) : float(0)
    const wall = clamp(length(vec2(reliefAt.x, reliefAt.y)).mul(depth), 0, 2)
    // Without a background the page is its own surface: grain shows only on the relief and ink.
    const present = mix(clamp(inkNode.a.mul(0.6).add(pad.mul(0.3)), 0, 1), float(1), solid)
    let amount: F = clamp(u.grain, 0, 3).mul(pressed.mul(0.45).oneMinus(), present) as F
    if (style === 'letterpress') amount = amount.mul(wall.mul(0.8).add(1)) as F
    if (style === 'stamp') amount = amount.mul(mix(1, 0.12, pad)) as F

    // The normal: the letters' relief and the material's own fine relief.
    const slopeX = reliefAt.x.mul(depth).add(fine.x.mul(amount))
    const slopeY = reliefAt.y.mul(depth).add(fine.y.mul(amount))
    const normal = normalize(vec3(slopeX.negate(), slopeY, 1))
    const toLamp = vec3(lamp.x.sub(point.x), point.y.sub(lamp.y), lamp.z.sub(height))
    const lightDir = normalize(toLamp)
    const wrap = finish.wrap
    const diffuse = clamp(
      dot(normal, lightDir)
        .add(wrap)
        .div(1 + wrap),
      0,
      1,
    )
    const flatLightDir = normalize(vec3(lamp.x.sub(point.x), point.y.sub(lamp.y), lamp.z))
    const diffuseFlat = clamp(flatLightDir.z.add(wrap).div(1 + wrap), 0, 1)

    // Shadows: a march over the relief toward the lamp, soft with distance, steps jittered per
    // pixel so the penumbra has no bands.
    const across = vec2(lamp.x.sub(point.x), lamp.y.sub(point.y))
    const dist = max(length(across), 1e-3)
    const toward = across.div(dist)
    const rise = lamp.z.sub(height).div(dist)
    // Past the highest point of the relief nothing can shade the ray: steps end there.
    const reach = min(
      min(dist, emU.mul(0.7)),
      max(topU.mul(depth).sub(height), 0).div(max(rise, 1e-3)).add(0.5),
    )
    const jitter = fract(
      fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))).mul(
        52.9829189,
      ),
    )
    let occluded: F = float(0)
    for (let i = 0; i < steps; i++) {
      const marched = reach.mul(
        pow(
          float(i + 1)
            .sub(jitter)
            .div(steps),
          1.5,
        ),
      )
      const above = relief(point.add(toward.mul(marched)))
        .z.mul(depth)
        .sub(height.add(rise.mul(marched)))
      occluded = max(occluded, smoothstep(0, marched.mul(0.16).add(0.35), above)) as F
    }
    const lit = occluded.mul(0.88).oneMinus()
    // Ambient occlusion: how far the spot sits below what is around it.
    const ao = clamp(reliefAt.w.mul(depth).div(emU.mul(0.03)), 0, 1)
      .mul(0.4)
      .oneMinus()

    // Highlights.
    const view = normalize(cameraPosition.sub(positionWorld))
    const halfway = normalize(lightDir.add(view))
    const nDotH = max(dot(normal, halfway), 0)
    const facing = smoothstep(0, 0.15, dot(normal, lightDir))
    let spec: F
    if (finish.metal) {
      // Brushed along x: the highlight is a streak across the brushing (Kajiya-Kay).
      const along = normalize(vec3(1, 0, 0).sub(normal.mul(normal.x)))
      const tDotH = dot(along, halfway)
      spec = pow(sqrt(max(tDotH.mul(tDotH).oneMinus(), 0)), finish.shine)
        .mul(finish.spec)
        .add(pow(nDotH, 20).mul(0.08)) as F
    } else spec = pow(nDotH, finish.shine).mul(finish.spec) as F
    if (style === 'stamp')
      spec = mix(spec, pow(nDotH, 70).mul(0.6).add(pow(nDotH, 9).mul(0.07)), pad) as F
    spec = spec.mul(lit, facing) as F
    const hFlat = normalize(flatLightDir.add(view))
    const specFlat = finish.metal ? float(0) : pow(max(hFlat.z, 0), finish.shine).mul(finish.spec)

    // Colors: the material with its mottle, then ink or wax over it.
    const albedo = fine.z
      .sub(1)
      .add(broad.z.sub(1).mul(0.6))
      .mul(clamp(u.grain, 0, 3))
      .add(1)
    // Pressed in, the surface packs denser: darker, and richer where it has color.
    const packed = mix(base, pow(base, vec3(1.3)), finish.tint)
    const ground = mix(base, packed.mul(finish.pressed), pressed).mul(albedo)
    const coverage = inkNode.a
    const printed = inkNode.rgb.div(max(coverage, 1e-3))
    const inkColor = mix(printed, ink, tinted)
    // Letterpress ink soaks into the fibres and squeezes a little darker toward the walls.
    const density =
      style === 'letterpress'
        ? clamp(fine.z.sub(1).mul(1.5).add(0.97).add(wall.mul(0.05)), 0, 1)
        : float(1)
    const inkAlpha = style === 'stamp' ? pad : coverage.mul(density)
    const inkRGB =
      style === 'stamp' ? ink.mul(mix(0.9, 1.06, broad.z)) : inkColor.mul(mix(1, fine.z, 0.4))
    const albedoAll = mix(ground, inkRGB, inkAlpha)

    const light = float(AMBIENT)
      .mul(ao)
      .add(diffuse.mul(DIRECT, lit, mix(1, ao, 0.5)))
      .mul(norm, finish.metal ? 0.85 : 1)
    const flat = float(AMBIENT).add(diffuseFlat.mul(DIRECT)).mul(norm)
    const tone = mix(vec3(1), base.div(max(base.x, max(base.y, base.z)).max(0.05)), finish.tint)
    const solidRGB = albedoAll.mul(light).add(tone.mul(spec))

    // Without a background: shading as a multiply and a screen over the page beneath, so the
    // relief sits on any color, gradient or picture and the flat page stays untouched.
    const lightRatio = light.div(max(flat, 1e-3))
    const shade = min(lightRatio, 1)
    const glint = clamp(lightRatio.sub(1).mul(1.2), 0, 0.7)
      .add(max(spec.sub(specFlat), 0))
      .clamp(0, 1)
    const keep = shade.mul(glint.oneMinus())
    const overAlpha = float(1).sub(inkAlpha.oneMinus().mul(keep))
    const overRGB = inkRGB.mul(inkAlpha, keep).add(glint).div(max(overAlpha, 1e-4))

    const boxUV = vec2(point.x.div(u.size.x), point.y.div(u.size.y).oneMinus())
    const inset = vec2(0.5, 0.5).div(max(u.size, vec2(1, 1)))
    const mask = ctx.mask(clamp(boxUV, inset, inset.oneMinus()))
    material.colorNode = vec4(
      mix(overRGB, solidRGB, solid).add(dither()),
      mix(overAlpha, float(1), solid).clamp(0, 1).mul(mask),
    )

    const mesh = new Mesh(quad(), material)
    mesh.frustumCulled = false
    ctx.onDispose(() => {
      ;(reliefNodes[0]?.value as Texture | undefined)?.dispose()
      tileMap.dispose()
      ;(inkNode.value as Texture).dispose()
    })
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const use = (next: Raster, made: Press): void => {
      const old = reliefNodes[0]?.value
      const fresh = dataTexture(made.data, made.width, made.height, false)
      for (const node of reliefNodes) node.value = fresh
      old?.dispose()
      const oldInk = inkNode.value as Texture
      inkNode.value = inkTexture(inkOf(next, allInk))
      oldInk.dispose()
      frame.value.set(...next.frame)
      field.value.set(...made.frame)
      emU.value = made.em
      topU.value = made.top
      const bg = solidOf()
      solid.value = bg ? 1 : 0
      base.value.set(bg ?? wallOf(element))
      if (!tint) ink.value.set(colorOf('', element) ?? '#222222')
      layout = next
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
      use(next, press(next, style, built, ratio))
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

    // A mouse or pen anywhere on the page is the lamp; it leaves with the pointer.
    let mouse: { x: number; y: number } | undefined
    const track = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      mouse = { x: e.clientX, y: e.clientY }
      if (ctx.params.follow > 0 && !stage.reducedMotion.peek()) ctx.invalidate()
    }
    const gone = (): void => {
      if (!mouse) return
      mouse = undefined
      ctx.invalidate()
    }
    addEventListener('pointermove', track, { passive: true, signal })
    document.documentElement.addEventListener('pointerleave', gone, { signal })
    addEventListener('blur', gone, { signal })

    let rate = 0
    pacing.set(signal, () => rate)
    let lampX = 0
    let lampY = 0
    let started = false

    return (input) => {
      const p = ctx.params
      if (Math.abs(p.bevel - built) > 1e-3 && !timer) {
        built = p.bevel
        schedule()
      }
      const reduced = input.reducedMotion
      const dt = Math.min(input.delta, 0.1)
      const boxWidth = input.width
      const boxHeight = input.height
      const vh = stage.height.peek() || boxHeight
      const middle = input.y + boxHeight / 2
      const [restX, restY, lampZ] = rest(
        p.light,
        boxWidth,
        boxHeight,
        reduced ? vh / 2 : middle,
        vh,
      )
      let targetX = restX
      let targetY = restY
      const follow = reduced ? 0 : Math.min(1, Math.max(0, p.follow))
      if (follow > 0 && mouse) {
        const [pointerX, pointerY] = reachOf(
          mouse.x - (input.x + boxWidth / 2),
          mouse.y - middle,
          boxWidth,
          boxHeight,
        )
        targetX += (pointerX - restX) * follow
        targetY += (pointerY - restY) * follow
      }
      if (!started || reduced) {
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
      offset.value.set(lampX, lampY, lampZ)
      // The card's middle under the resting lamp shows its own color.
      const [middleX, middleY] = rest(p.light, boxWidth, boxHeight, vh / 2, vh)
      const facing = lampZ / Math.hypot(middleX, middleY, lampZ)
      norm.value = 1 / (AMBIENT + DIRECT * Math.min(1, (facing + finish.wrap) / (1 + finish.wrap)))
      rate = settling ? 60 : 0
    }
  },
})
export default emboss
