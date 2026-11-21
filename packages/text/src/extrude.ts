import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, ease, fromOklab, palette, toOklab } from '@dioramajs/effects/kit'
import {
  Break,
  clamp,
  dot,
  Fn,
  float,
  fwidth,
  If,
  int,
  Loop,
  length,
  log2,
  max,
  min,
  mix,
  mod,
  normalize,
  positionGeometry,
  pow,
  select,
  sRGBTransferEOTF,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  type CanvasTexture,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  NoColorSpace,
  type Node,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { type Field, field } from './field'
import { atlas, backdrop, direction, linear } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Style = 'solid' | 'layers' | 'shadow'
type By = 'pointer' | 'scroll' | 'none'
type Params = {
  style: ChoiceParam<Style>
  by: ChoiceParam<By>
  depth: number
  layers: number
  tilt: number
  light: number
  color: string
  colors: string
}

/** The depth grows in over this long the first time the text is on screen, s. */
const GROW = 0.9
/** How deep the block is in 3D, in multiples of `depth`: the parallax of its back as it turns. */
const GAIN = 1.8
/** The light turns this far from `light`, °, so walls facing two ways shade apart. */
const KEY = 24
/** Height of the light above the page, °. */
const ELEVATION = 42
/** The long shadow runs this many times `depth`. */
const LONG = 5
/** Most steps of the march through the depth. */
const MAX_STEPS = 128
/** Most paper layers. */
export const MAX_LAYERS = 12
/** Side color of a derived wall, linear, times the text color. */
const SIDE = 0.45
/** Darkest the soft shadow on the page gets. */
const GROUND = 0.3
/** Time the tilt takes to follow the pointer, s. */
const FOLLOW = 0.16
/** Most colors of the layer list. */
const PALETTE = 16
/** Width of the bevel round the face, em. */
const BEVEL = 0.035
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Longest side of the baked long shadow, canvas px. */
const MAX_BAKE_SIDE = 4096
/** Delays, ms: rastering again after a change, the distance field when idle, baking the long shadow again. */
const REDO_DELAY = 150
const FIELD_DELAY = 50
const FIELD_IDLE_TIMEOUT = 500
const REBAKE_DELAY = 120

/** Distance of the eye for the depth, px: a gentle perspective for a box of this size. */
export const perspectiveOf = (width: number, height: number): number =>
  Math.max(1600, 3 * Math.max(width, height))

/**
 * How a box of `width` x `height` px sees its depth when its face is turned up by `ax` and right
 * by `ay` (radians): the point the depth vanishes toward, in box px (y down), and the share of the
 * way there a point at full depth goes. At rest the back trails `depth` px away from the light at
 * the box centre; turning the face toward a point moves the back away from it.
 */
export function view(
  light: number,
  depth: number,
  ax: number,
  ay: number,
  width: number,
  height: number,
  out: Vector3 = new Vector3(),
): Vector3 {
  const perspective = perspectiveOf(width, height)
  const depthZ = Math.max(0, depth) * GAIN
  const [awayX, awayY] = direction(light + 180)
  // The eye that sees the centre's back `depth` px away: R from the centre over the page.
  const eyeReach = perspective / GAIN + Math.max(0, depth)
  return out.set(
    width / 2 + awayX * eyeReach - perspective * Math.tan(ay),
    height / 2 + awayY * eyeReach + perspective * Math.tan(ax),
    depthZ / perspective,
  )
}

/** The light in the frame of a face turned up by `ax` and right by `ay`: y down, z to the viewer. */
export function lamp(light: number, ax: number, ay: number, out: Vector3 = new Vector3()): Vector3 {
  const [lightX, lightY] = direction(light + KEY)
  const elevation = (ELEVATION * Math.PI) / 180
  const x = lightX * Math.cos(elevation)
  const y = -lightY * Math.cos(elevation)
  const z = Math.sin(elevation)
  const y1 = y * Math.cos(ax) - z * Math.sin(ax)
  const z1 = y * Math.sin(ax) + z * Math.cos(ax)
  return out.set(x * Math.cos(ay) - z1 * Math.sin(ay), -y1, x * Math.sin(ay) + z1 * Math.cos(ay))
}

/** Empty margin round the raster in the GPU copy, px: the blurred reads of the shadow stay in it. */
const MARGIN = 16

/** The raster in a canvas with an empty margin, so its coarse mip levels end in empty texels. */
export function padded(layout: Raster): { canvas: HTMLCanvasElement; frame: Raster['frame'] } {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const scale = layout.canvas.width / (frameWidth || 1)
  const pad = Math.ceil(MARGIN * scale)
  const canvas = document.createElement('canvas')
  canvas.width = layout.canvas.width + 2 * pad
  canvas.height = layout.canvas.height + 2 * pad
  canvas.getContext('2d')?.drawImage(layout.canvas, pad, pad)
  const padBox = pad / scale
  return {
    canvas,
    frame: [frameX - padBox, frameY - padBox, frameWidth + 2 * padBox, frameHeight + 2 * padBox],
  }
}

/** A field that says "deep inside" everywhere, while the real one is not there. */
function flat(): DataTexture {
  const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 4, 1, RedFormat)
  map.type = UnsignedByteType
  map.colorSpace = NoColorSpace
  map.magFilter = map.minFilter = LinearFilter
  map.generateMipmaps = false
  map.unpackAlignment = 1
  map.needsUpdate = true
  return map
}

/** The long shadow of a raster: distance along `dir` from the ink, as gray, and where it lies. */
interface Baked {
  readonly canvas: HTMLCanvasElement
  /** Box px: x, y, width, height. */
  readonly frame: readonly [number, number, number, number]
}

/**
 * Bakes the distance from the ink along `dir` (box px, y down) up to `reach` px: 0 at the ink,
 * 255 at `reach` or with no ink behind. Doubling: each pass takes the smaller of a pixel and the
 * pixel `s` back plus `s`, for s = 1, 2, 4…, so log2 of the reach in canvas draws.
 */
export function bake(
  layout: Raster,
  dir: readonly [number, number],
  reach: number,
): Baked | undefined {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const reachX = dir[0] * reach
  const reachY = dir[1] * reach
  const frame = [
    frameX + Math.min(0, reachX),
    frameY + Math.min(0, reachY),
    frameWidth + Math.abs(reachX),
    frameHeight + Math.abs(reachY),
  ] as const
  const scale = Math.min(
    layout.canvas.width / (frameWidth || 1),
    MAX_BAKE_SIDE / Math.max(frame[2], frame[3], 1),
  )
  const canvas = document.createElement('canvas')
  const scratch = document.createElement('canvas')
  const ink = document.createElement('canvas')
  canvas.width = scratch.width = Math.max(1, Math.ceil(frame[2] * scale))
  canvas.height = scratch.height = Math.max(1, Math.ceil(frame[3] * scale))
  ink.width = layout.canvas.width
  ink.height = layout.canvas.height
  const ctx = canvas.getContext('2d', { alpha: false })
  const scratchContext = scratch.getContext('2d', { alpha: false })
  const inkContext = ink.getContext('2d')
  if (!ctx || !scratchContext || !inkContext) return undefined
  // Black ink on white.
  inkContext.drawImage(layout.canvas, 0, 0)
  inkContext.globalCompositeOperation = 'source-in'
  inkContext.fillStyle = '#000'
  inkContext.fillRect(0, 0, ink.width, ink.height)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(
    ink,
    (frameX - frame[0]) * scale,
    (frameY - frame[1]) * scale,
    frameWidth * scale,
    frameHeight * scale,
  )
  const total = reach * scale
  for (let shift = 1; shift < total; shift *= 2) {
    scratchContext.globalCompositeOperation = 'source-over'
    scratchContext.drawImage(canvas, 0, 0)
    const gray = Math.min(255, Math.round((255 * shift) / total))
    scratchContext.globalCompositeOperation = 'lighter'
    scratchContext.fillStyle = `rgb(${gray}, ${gray}, ${gray})`
    scratchContext.fillRect(0, 0, scratch.width, scratch.height)
    ctx.globalCompositeOperation = 'darken'
    ctx.drawImage(scratch, dir[0] * shift, dir[1] * shift)
  }
  ctx.globalCompositeOperation = 'source-over'
  return { canvas, frame }
}

/** Up to 16 colors as sRGB texels, for the paper layers. */
function swatches(colors: readonly string[]): DataTexture {
  const data = new Uint8Array(PALETTE * 4)
  colors.slice(0, PALETTE).forEach((hex, i) => {
    const color = new Color(hex)
    color.convertLinearToSRGB()
    data.set([color.r * 255, color.g * 255, color.b * 255, 255], i * 4)
  })
  const map = new DataTexture(data, PALETTE, 1, RGBAFormat, UnsignedByteType)
  map.colorSpace = NoColorSpace
  map.magFilter = map.minFilter = NearestFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/**
 * The long shadow's color: `color`, the solid page color behind darkened, or black at a low alpha
 * over a picture. It lies on the element that paints the page behind and is cut at its box.
 */
function shade(
  element: Element,
  color: string,
): { color: Color; alpha: number; on: Element | undefined } {
  const own = color.trim() ? palette(color, element)[0] : undefined
  const behind = backdrop(element)
  const on = behind?.element
  if (own) return { color: linear(own), alpha: 1, on }
  if (!behind?.color) return { color: new Color(0, 0, 0), alpha: 0.24, on }
  const [L, a, b] = toOklab(linear(behind.color))
  return { color: fromOklab([L * 0.8, a * 1.05, b * 1.05]), alpha: 1, on }
}

/** The box of `on` relative to the element's, px: left, top, right, bottom. */
function boxOf(element: Element, on: Element | undefined, out: Vector4): Vector4 {
  if (!on || on === document.documentElement || on === document.body)
    return out.set(-1e5, -1e5, 1e5, 1e5)
  const elementBox = element.getBoundingClientRect()
  const onBox = on.getBoundingClientRect()
  return out.set(
    onBox.left - elementBox.left,
    onBox.top - elementBox.top,
    onBox.right - elementBox.left,
    onBox.bottom - elementBox.top,
  )
}

/**
 * A 3D headline: the letters get real depth, a lit block extruded from the glyphs with beveled
 * faces and walls that darken toward the back, a stack of paper layers or a flat long shadow,
 * seen in perspective and casting a soft shadow on the page. The block turns toward the pointer
 * or with the scroll. The DOM text stays for screen readers, search and selection.
 */
const extrude: Effect<Params> = defineEffect({
  name: 'extrude',
  params: {
    style: oneOf('solid', 'layers', 'shadow'),
    by: oneOf('pointer', 'scroll', 'none'),
    depth: 24,
    layers: 4,
    tilt: 12,
    light: 315,
    color: '',
    colors: '',
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  bleed: 200,
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, signal, app, u, render } = ctx
    const { stage } = app
    const style = params.style
    ctx.showDom(true)
    const reason = unsupported(element) ?? (await fonts(element))
    if (signal.aborted) return
    if (reason) {
      if (DEV) app.log.warn(`extrude: ${reason} cannot be drawn, the text stays as it is`, element)
      return
    }
    // The device px per CSS px of the raster: a tier change rebuilds with the new one.
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    let layout = raster(element, 'line', ratio)
    if (!layout) return

    // The text's own color for the walls, or `color`; `colors` paints the paper layers.
    const tintCss = params.color.trim() ? palette(params.color, element)[0] : undefined
    const list = params.colors.trim() ? palette(params.colors, element) : []
    const long = style === 'shadow' ? shade(element, params.color) : undefined
    /** The bevel's width, px: a share of the largest font size. */
    const bevelOf = (source: Raster): number =>
      Math.min(10, Math.max(1, BEVEL * Math.max(1, ...source.quads.map((line) => line.em))))
    const fieldOf = (source: Raster): Field | undefined =>
      style === 'solid' ? field(source, bevelOf(source) + 2) : undefined

    let copy = padded(layout)
    const frame = uniform(new Vector4(...copy.frame))
    // The quad: the raster frame grown by the reach of the depth, box px.
    const area = uniform(new Vector4(...layout.frame))
    // cos and sin of the turn up and the turn right.
    const turn = uniform(new Vector4(1, 0, 1, 0))
    // Box centre in world px, perspective of the face, camera distance.
    const camera = uniform(new Vector4(0, 0, 1000, render.camera.position.z || 1000))
    // Where the depth vanishes toward (box px) and the share of the way at full depth.
    const sight = uniform(new Vector3())
    const light = uniform(lamp(params.light, 0, 0))
    const steps = uniform(1)
    const count = uniform(1)
    const grown = uniform(0)
    const away = uniform(new Vector2(...direction(params.light + KEY + 180)))
    const drop = uniform(0)
    const texel = uniform(layout.canvas.width / (layout.frame[2] || 1))
    const tint = uniform(tintCss ? linear(tintCss) : new Color(1, 1, 1))
    const tinted = uniform(tintCss ? 1 : 0)
    const swatchCount = uniform(Math.min(PALETTE, list.length))
    const fieldFrame = uniform(new Vector4(...layout.frame))
    const band = uniform(1)
    const bevel = uniform(bevelOf(layout))

    const frameU = frame as unknown as V4
    const areaU = area as unknown as V4
    const turnU = turn as unknown as V4
    const cameraU = camera as unknown as V4
    const eye = (sight as unknown as V3).xy
    const depthShare = (sight as unknown as V3).z
    const lightDir = light as unknown as V3
    const half = u.size.mul(0.5)
    const corner = positionGeometry.xy.add(0.5)
    const px = areaU.x.add(corner.x.mul(areaU.z))
    const py = areaU.y.add(corner.y.oneMinus().mul(areaU.w))
    // rotateY(ay) then the face up by ax, about the box centre, seen with its own perspective.
    const centredX = px.sub(half.x)
    const centredY = half.y.sub(py)
    const turnedX = centredX.mul(turnU.z)
    const turnedZ = centredX.mul(turnU.w).negate()
    const liftedY = centredY.mul(turnU.x).add(turnedZ.mul(turnU.y))
    const liftedZ = centredY.mul(turnU.y).negate().add(turnedZ.mul(turnU.x))
    const depthZ = liftedZ.mul(cameraU.w).div(cameraU.z)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(
      turnedX.sub(cameraU.x.mul(depthZ).div(cameraU.w)),
      liftedY.sub(cameraU.y.mul(depthZ).div(cameraU.w)),
      depthZ,
    )
    const point = varying(vec2(px, py)) as unknown as V2
    // Ink past the box is masked at the box edge a pixel in, where the mask is whole.
    const boxUV = vec2(
      clamp(point.x, 1, u.size.x.sub(1)).div(u.size.x),
      clamp(point.y, 1, u.size.y.sub(1)).div(u.size.y).oneMinus(),
    )
    const mask = ctx.mask(boxUV as unknown as V2)

    const ink = texture(atlas(copy.canvas))
    // Every read follows the swaps of `ink.value` (fit.ts: a merged sampler keeps the first).
    ink.mergeable = false
    const uvOf = (spot: V2, from: V4 = frameU): V2 =>
      vec2(
        spot.x.sub(from.x).div(from.z),
        spot.y.sub(from.y).div(from.w).oneMinus(),
      ) as unknown as V2
    const read = (spot: V2, level: F): V4 => texture(ink, uvOf(spot), level) as unknown as V4
    // Blurred reads: the margin keeps the coarse levels' edge texels empty.
    const soft = (spot: V2, level: F): F => texture(ink, uvOf(spot), level).a as unknown as F
    // Flat until the field is made, after the first frame: it reads the raster back.
    const distance = texture(flat())
    distance.mergeable = false
    /** Distance inside the ink at `spot`, px. */
    const depthAt = (spot: V2): F =>
      texture(distance, uvOf(spot, fieldFrame as unknown as V4), 0)
        .r.mul(band.add(1))
        .sub(1) as unknown as F
    /** The gradient of the distance at `spot`: it points into the ink. */
    const slope = (spot: V2, offset: number): V2 =>
      vec2(
        depthAt(spot.add(vec2(offset, 0))).sub(depthAt(spot.sub(vec2(offset, 0)))),
        depthAt(spot.add(vec2(0, offset))).sub(depthAt(spot.sub(vec2(0, offset)))),
      ).div(2 * offset) as unknown as V2
    const toLinear = (color: V4): V3 =>
      sRGBTransferEOTF(color.rgb.div(max(color.a, 1e-4)) as never) as unknown as V3
    const luma = vec3(0.2126, 0.7152, 0.0722)
    /** The wall color of a text color: darker, or lighter for black text. */
    const sideOf = (color: V3, layer: F): V3 =>
      select(
        dot(color, luma).greaterThan(0.035),
        color.mul(pow(float(SIDE), layer)),
        mix(color, vec3(1), min(layer.mul(0.28), 0.8)),
      ) as unknown as V3
    /** The point of the face whose copy at depth share `t` shows at `p`. */
    const back = (p: V2, t: F | number): V2 =>
      p.add(p.sub(eye).mul(depthShare.mul(t))) as unknown as V2

    const bakeFrame = uniform(new Vector4(...layout.frame))
    const clip = uniform(boxOf(element, long?.on, new Vector4()))
    const swatch = list.length ? swatches(list) : undefined
    ctx.onDispose(() => swatch?.dispose())
    /** Bakes the long shadow of a raster again, with the current params. */
    let rebake: ((next: Raster) => void) | undefined

    let colorNode: V4
    if (style === 'shadow') {
      const baked = (source: Raster): CanvasTexture | undefined => {
        const made = bake(source, direction(ctx.params.light + 180), ctx.params.depth * LONG)
        if (!made) return undefined
        bakeFrame.value.set(...made.frame)
        const map = atlas(made.canvas)
        map.premultiplyAlpha = false
        map.generateMipmaps = false
        return map
      }
      const trail = texture(baked(layout) ?? (ink.value as Texture))
      trail.mergeable = false
      const shadowColor = uniform(long?.color ?? new Color())
      const strength = uniform(long?.alpha ?? 0)
      const front = texture(ink, uvOf(point)) as unknown as V4
      const trailDistance = texture(trail, uvOf(point, bakeFrame as unknown as V4)).r
      // Cut at the box of what the shadow lies on, anti-aliased by a pixel.
      const clipBox = clip as unknown as V4
      const pixel = fwidth(point.x).max(1e-3)
      const onBox = clamp(
        min(
          min(point.x.sub(clipBox.x), clipBox.z.sub(point.x)),
          min(point.y.sub(clipBox.y), clipBox.w.sub(point.y)),
        ).div(pixel),
        0,
        1,
      )
      const cast = pow(clamp(trailDistance.div(max(grown, 1e-3)).oneMinus(), 0, 1), 1.3).mul(
        strength,
        onBox,
      )
      const frontAlpha = front.a
      const behind = cast.mul(frontAlpha.oneMinus())
      const alpha = frontAlpha.add(behind)
      const rgb = toLinear(front)
        .mul(frontAlpha)
        .add((shadowColor as unknown as V3).mul(behind))
        .div(max(alpha, 1e-4))
      colorNode = vec4(rgb, alpha.mul(mask)) as unknown as V4
      ctx.onDispose(() => (trail.value as Texture).dispose())
      rebake = (next: Raster) => {
        const map = baked(next)
        if (!map) return
        const old = trail.value as Texture
        trail.value = map
        if (old !== ink.value) old.dispose()
      }
    } else {
      colorNode = Fn(() => {
        // The mip level of the raster on screen, before the loop: derivatives need uniform flow.
        const lod = max(
          log2(max(max(fwidth(point.x), fwidth(point.y)).mul(texel), 1e-4)),
          0,
        ).toVar()
        const front = read(point, lod).toVar()
        const coverage = front.a.toVar()
        const behind = vec3(0).toVar()
        const behindA = float(0).toVar()
        const face = toLinear(front).toVar()
        if (style === 'solid') {
          const wall = vec3(0).toVar()
          const deep = float(0).toVar()
          Loop({ start: int(1), end: int(steps), type: 'int', condition: '<=' }, ({ i }) => {
            If(coverage.greaterThan(0.996), () => {
              Break()
            })
            const t = float(i).div(steps)
            const deeper = read(back(point, t), lod)
            const weight = coverage.oneMinus().mul(deeper.a)
            // deeper.rgb is premultiplied: times (1 - coverage) it is `weight` times the color.
            wall.addAssign(deeper.rgb.mul(coverage.oneMinus()))
            behindA.addAssign(weight)
            deep.addAssign(weight.mul(t))
            coverage.addAssign(weight)
          })
          const wallAlpha = max(behindA, 1e-4)
          const mean = deep.div(wallAlpha)
          const own = sRGBTransferEOTF(wall.div(wallAlpha) as never) as unknown as V3
          const side = mix(sideOf(own, float(1)), tint as unknown as V3, tinted)
          // The wall faces out of the ink where it shows: the distance field's gradient there.
          const gradient = slope(back(point, mean), 2)
          const toward = normalize(eye.sub(point).add(vec2(1e-4, 1e-4)))
          const outward = select(
            length(gradient).greaterThan(0.05),
            normalize(gradient).negate(),
            toward,
          )
          const lit = dot(outward, normalize(lightDir.xy.add(vec2(1e-5, 0))))
            .mul(0.5)
            .add(0.5)
          const wallShade = lit.mul(0.72).add(0.28).mul(mean.mul(-0.45).add(1))
          behind.assign(side.mul(wallShade).mul(behindA))
          // The face's bevel: a rounded chamfer as wide as `bevel`, lit by the same light.
          const insideDepth = depthAt(point)
          const faceSlope = slope(point, 1.5)
          const rise = clamp(insideDepth.div(bevel).oneMinus(), 0, 1).mul(1.2)
          const normal = normalize(vec3(faceSlope.mul(rise).negate(), 1))
          const flatLit = max(lightDir.z, 0.2)
          const diffuse = max(dot(normal, lightDir), 0).div(flatLit)
          const halfway = normalize(lightDir.add(vec3(0, 0, 1)))
          const shine = max(pow(max(dot(normal, halfway), 0), 28).sub(pow(halfway.z, 28)), 0)
          face.assign(
            face.mul(clamp(diffuse.sub(1).mul(1.1).add(1), 0.3, 1.5)).add(shine.mul(0.85)),
          )
        } else {
          Loop({ start: int(1), end: int(count), type: 'int', condition: '<=' }, ({ i }) => {
            If(coverage.greaterThan(0.996), () => {
              Break()
            })
            const layerIndex = float(i)
            const t = layerIndex.div(count)
            const deeper = read(back(point, t), lod)
            const weight = coverage.oneMinus().mul(deeper.a)
            const own = mix(toLinear(deeper), tint as unknown as V3, tinted)
            let paper = sideOf(own, layerIndex.mul(0.4))
            if (swatch) {
              const swatchUV = vec2(mod(layerIndex.sub(1), swatchCount).add(0.5).div(PALETTE), 0.5)
              paper = sRGBTransferEOTF(texture(swatch, swatchUV, 0).rgb as never) as unknown as V3
            }
            // The layer in front casts a soft shadow on this one, away from the light.
            const cast = soft(back(point, t.sub(float(0.45).div(count))), lod.add(2.2))
            behind.addAssign(paper.mul(cast.mul(-0.45).add(1)).mul(weight))
            behindA.addAssign(weight)
            coverage.addAssign(weight)
          })
        }
        const frontAlpha = front.a
        const alpha = frontAlpha.add(behindA)
        const premult = face.mul(frontAlpha).add(behind)
        // The block's soft shadow on the page, past its back and away from the light.
        const fall = (away as unknown as V2).mul(drop)
        const base = back(point.sub(fall), 1)
        const spread = vec2(drop.mul(0.35).add(2), drop.mul(0.35).add(2))
        const groundLod = lod.add(3.4)
        const ground = soft(base.add(spread), groundLod)
          .add(soft(base.sub(spread), groundLod))
          .add(soft(base.add(vec2(spread.x, spread.y.negate())), groundLod))
          .add(soft(base.sub(vec2(spread.x, spread.y.negate())), groundLod))
          .mul(0.25 * GROUND)
          .mul(grown)
          .mul(alpha.oneMinus())
        const total = alpha.add(ground)
        return vec4(premult.div(max(total, 1e-4)), total.mul(mask))
      })() as unknown as V4
    }
    material.colorNode = colorNode
    const mesh = new Mesh(new PlaneGeometry(1, 1), material)
    // The vertices are placed by the shader, away from the unit plane the bounds are made of.
    mesh.frustumCulled = false
    ctx.onDispose(() => {
      ;(ink.value as Texture).dispose()
      ;(distance.value as Texture).dispose()
    })
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    // The distance field when the page is idle: tens of ms for a large heading.
    let idle: (() => void) | undefined
    const measure = (source: Raster): void => {
      idle?.()
      if (style !== 'solid') return
      const run = (): void => {
        idle = undefined
        if (signal.aborted || source !== layout) return
        const made = fieldOf(source)
        if (!made) return
        const was = distance.value as Texture
        distance.value = made.map
        was.dispose()
        fieldFrame.value.set(...made.frame)
        band.value = made.band
        ctx.invalidate()
      }
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: FIELD_IDLE_TIMEOUT })
        idle = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(run, FIELD_DELAY)
        idle = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => idle?.())
    measure(layout)

    const use = (next: Raster): void => {
      const old = ink.value as Texture
      copy = padded(next)
      ink.value = atlas(copy.canvas)
      old.dispose()
      frame.value.set(...copy.frame)
      texel.value = next.canvas.width / (next.frame[2] || 1)
      boxOf(element, long?.on, clip.value)
      bevel.value = bevelOf(next)
      layout = next
      measure(next)
      rebake?.(next)
    }
    // Raster again when the text, its fonts or its width change.
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (!next) return
      use(next)
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

    // What the face turns toward: the pointer, or on touch screens and with `by: scroll` the
    // viewport centre, so the block turns as the page scrolls.
    const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches
    const by: By =
      style === 'shadow' ? 'none' : params.by === 'pointer' && coarse ? 'scroll' : params.by
    let pointer: { x: number; y: number } | undefined
    if (by === 'pointer') {
      const wake = (): void => ctx.invalidate()
      addEventListener(
        'pointermove',
        (e) => {
          if (e.pointerType === 'touch') return
          pointer = { x: e.clientX, y: e.clientY }
          wake()
        },
        { signal, passive: true },
      )
      const gone = (): void => {
        pointer = undefined
        wake()
      }
      document.documentElement.addEventListener('pointerleave', gone, { signal })
      addEventListener('blur', gone, { signal })
    }

    let baked = { depth: params.depth, light: params.light }
    let bakeTimer: ReturnType<typeof setTimeout> | undefined
    ctx.onDispose(() => clearTimeout(bakeTimer))

    let grow = 0
    let turnUp = 0
    let turnRight = 0
    let dom = true
    return (input): boolean => {
      const p = ctx.params
      const dt = input.delta
      const still = input.reducedMotion
      if (dom) {
        dom = false
        ctx.showDom(false)
      }
      if (grow < 1 && input.visible) grow = still ? 1 : Math.min(1, grow + dt / GROW)
      const shown = ease('expoOut', grow)
      const vw = stage.width.peek()
      const vh = stage.height.peek()
      let towardX = 0
      let towardY = 0
      const toward =
        by === 'scroll' ? { x: vw / 2, y: vh / 2 } : by === 'pointer' ? pointer : undefined
      if (toward && !still && element.isConnected) {
        const limit = (n: number): number => Math.max(-1, Math.min(1, n))
        towardX = limit((toward.x - (input.x + input.width / 2)) / (vw / 2 || 1))
        towardY = limit((input.y + input.height / 2 - toward.y) / (vh / 2 || 1))
      }
      const angle = (Math.min(45, Math.max(0, p.tilt)) * Math.PI) / 180
      const targetY = towardX * angle
      const targetX = towardY * angle
      if (by === 'scroll' || still) {
        turnRight = targetY
        turnUp = targetX
      } else {
        turnRight = damp(turnRight, targetY, FOLLOW, dt, 1e-4)
        turnUp = damp(turnUp, targetX, FOLLOW, dt, 1e-4)
      }
      const moving = grow < 1 || turnRight !== targetY || turnUp !== targetX

      const depth = Math.max(0, p.depth)
      const { width: boxWidth, height: boxHeight } = input
      grown.value = shown
      turn.value.set(Math.cos(turnUp), Math.sin(turnUp), Math.cos(turnRight), Math.sin(turnRight))
      camera.value.set(
        input.x + boxWidth / 2 - vw / 2,
        vh / 2 - input.y - boxHeight / 2,
        Math.max(800, 1.4 * Math.max(boxWidth, boxHeight)),
        render.camera.position.z || camera.value.w,
      )
      const vanish = view(
        p.light,
        depth * shown,
        turnUp,
        turnRight,
        boxWidth,
        boxHeight,
        sight.value,
      )
      lamp(p.light, turnUp, turnRight, light.value)
      ;(away.value as Vector2).set(...direction(p.light + KEY + 180))
      drop.value = depth * 0.45 * shown
      count.value = Math.max(1, Math.min(MAX_LAYERS, Math.round(p.layers)))
      const [frameX, frameY, frameWidth, frameHeight] = layout?.frame ?? [0, 0, 0, 0]
      // The longest trail, from the frame corner farthest from where the depth vanishes.
      const farX = Math.max(Math.abs(frameX - vanish.x), Math.abs(frameX + frameWidth - vanish.x))
      const farY = Math.max(Math.abs(frameY - vanish.y), Math.abs(frameY + frameHeight - vanish.y))
      const reach = Math.hypot(farX, farY) * vanish.z
      const dpr =
        (render.renderer as { getPixelRatio?: () => number }).getPixelRatio?.() ??
        globalThis.devicePixelRatio ??
        1
      steps.value = Math.max(1, Math.min(MAX_STEPS, Math.ceil(reach * dpr)))
      if (style === 'shadow') {
        area.value.copy(bakeFrame.value)
        if (p.depth !== baked.depth || p.light !== baked.light) {
          baked = { depth: p.depth, light: p.light }
          clearTimeout(bakeTimer)
          bakeTimer = setTimeout(() => {
            if (layout) rebake?.(layout)
            ctx.invalidate()
          }, REBAKE_DELAY)
        }
      } else {
        // The quad reaches as far as the back and the soft shadow can go.
        const margin = reach * 1.15 + depth * 0.9 + 8
        area.value.set(
          frameX - margin,
          frameY - margin,
          frameWidth + margin * 2,
          frameHeight + margin * 2,
        )
      }
      return moving
    }
  },
})
export default extrude
