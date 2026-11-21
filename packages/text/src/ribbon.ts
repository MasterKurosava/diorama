import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, damp, fromOklab, palette, toOklab } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  attribute,
  clamp,
  cos,
  cross,
  dot,
  exp,
  frontFacing,
  fwidth,
  log2,
  max,
  min,
  mod,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
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
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { atlas, linear } from './paint'
import { fonts, type Raster, raster, unsupported } from './raster'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
export type Style = 'flag' | 'ribbon' | 'silk'
type Trigger = 'loop' | 'hover' | 'scroll'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  wind: number
  speed: number
  folds: number
  twist: number
  gloss: number
  back: string
  color: string
}

/** Steepest slope of the folds at `wind` 1: the amplitude is this over the wave number. */
const SLOPE: Readonly<Record<Style, number>> = { flag: 0.8, ribbon: 0.45, silk: 0.42 }
/** How fast the waves travel at `speed` 1, rad/s. */
const PACE: Readonly<Record<Style, number>> = { flag: 3.4, ribbon: 2.4, silk: 1.4 }
/** The ribbon's twist pulse moves this share of the strip's length per radian of the clock. */
const TRAVEL = 0.1
/** The turn of the whole ribbon besides the pulse, a share of `twist`. */
const GENTLE = 0.1
/** The wind picks up and settles over these, s. */
const RISE: Readonly<Record<Trigger, number>> = { loop: 0.5, hover: 0.3, scroll: 0.12 }
const FALL: Readonly<Record<Trigger, number>> = { loop: 0.5, hover: 0.7, scroll: 0.6 }
/** Below this share of the wind or the dent the cloth snaps flat: less than a pixel. */
const CALM = 0.01
/** Scroll velocity (3000 px/s is 1) times this is a full wind. */
const GUST = 3.5
/** How long a tap on a touch screen blows with `trigger: hover`, s. */
const TAP = 1.4
/** Time the pointer's dent takes to follow it, s. */
const FOLLOW = 0.1
/** Light from the top left, toward the light: world axes, y up, z to the viewer. */
const LIGHT = [-0.62, 0.5, 0.48] as const
const LIGHT_LENGTH = Math.hypot(...LIGHT)
/** Halfway between the light and the viewer. */
const HALF = [LIGHT[0], LIGHT[1], LIGHT[2] + LIGHT_LENGTH].map(
  (v, _, all) => v / Math.hypot(...(all as number[])),
) as [number, number, number]
/** Cloth points sit this many of their own heights above the page plus a share of the amplitude. */
const LIFT = 1.1
/** Darkest the cloth's shadow on the page gets. */
const SHADOW = 0.28
/** Empty margin round the raster copy, px: the blurred reads of the shadow stay in it. */
const MARGIN = 16
/** Most vertices of the cloth: past it the grid gets coarser. */
const MAX_VERTICES = 60_000
/** Grid step of the cloth by quality, px. */
const STEP = { low: 16, medium: 11, high: 8 } as const

/** A band of cloth in box px (y down): one for a flag or silk, one per line for a ribbon. */
export interface Strip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The cloth of a style. A tinted flag or silk is the element's box; a tinted ribbon spans the
 * box and splits its height between the lines. Without a tint the cloth is the ink with `pad` px
 * around it: the whole text for a flag or silk, each line on its own for a ribbon.
 */
export function strips(
  r: Pick<Raster, 'quads'>,
  style: Style,
  box: { readonly width: number; readonly height: number },
  tinted: boolean,
  pad: number,
): Strip[] {
  const quads = [...r.quads].sort((a, b) => a.y - b.y)
  if (!quads.length) return []
  if (style !== 'ribbon') {
    if (tinted) return [{ x: 0, y: 0, width: box.width, height: box.height }]
    const x0 = Math.min(...quads.map((q) => q.x)) - pad
    const y0 = Math.min(...quads.map((q) => q.y)) - pad
    const x1 = Math.max(...quads.map((q) => q.x + q.width)) + pad
    const y1 = Math.max(...quads.map((q) => q.y + q.height)) + pad
    return [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }]
  }
  if (!tinted)
    return quads.map((q) => ({
      x: q.x - pad,
      y: q.y - pad * 0.5,
      width: q.width + pad * 2,
      height: q.height + pad,
    }))
  // Neighbouring lines meet halfway between their bands, so at rest the strips tile the box.
  const cuts = [0]
  for (let i = 1; i < quads.length; i++) {
    const previous = quads[i - 1] as (typeof quads)[number]
    const current = quads[i] as (typeof quads)[number]
    cuts.push(Math.min(box.height, Math.max(0, (previous.y + previous.height + current.y) / 2)))
  }
  cuts.push(box.height)
  return quads.map((_, i) => {
    const top = cuts[i] as number
    return { x: 0, y: top, width: box.width, height: (cuts[i + 1] as number) - top }
  })
}

const STRIP = 'clothStrip'
const SEED = 'clothSeed'

/**
 * A grid over each strip, `step` px apart (coarser past MAX_VERTICES): positions in box px, the
 * strip's start x, length, centre y and half height, and its index for the phases.
 */
export function cloth(list: readonly Strip[], step: number): BufferGeometry {
  const area = list.reduce((n, s) => n + Math.max(1, s.width) * Math.max(1, s.height), 0)
  const at = Math.max(step, Math.sqrt(area / MAX_VERTICES))
  const position: number[] = []
  const strip: number[] = []
  const seed: number[] = []
  const index: number[] = []
  list.forEach((s, n) => {
    const cols = Math.min(400, Math.max(4, Math.ceil(s.width / at)))
    const rows = Math.min(120, Math.max(2, Math.ceil(s.height / at)))
    const first = position.length / 3
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        position.push(s.x + (s.width * i) / cols, s.y + (s.height * j) / rows, 0)
        strip.push(s.x, s.width, s.y + s.height / 2, s.height / 2)
        seed.push(n)
      }
    }
    // Counter-clockwise seen from the viewer (world y up): the printed side is the front.
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const vertex = first + j * (cols + 1) + i
        const below = vertex + cols + 1
        index.push(vertex, below, vertex + 1, vertex + 1, below, below + 1)
      }
    }
  })
  const geometry = new BufferGeometry()
  geometry.setIndex(index)
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3))
  geometry.setAttribute(STRIP, new BufferAttribute(new Float32Array(strip), 4))
  geometry.setAttribute(SEED, new BufferAttribute(new Float32Array(seed), 1))
  return geometry
}

/**
 * Amplitude (px) and wave number (rad/px) for cloth `length` px long: `folds` waves along it, as
 * steep as the style allows at `wind` 1.
 */
export function waves(style: Style, length: number, wind: number, folds: number): [number, number] {
  const k = (2 * Math.PI * Math.max(0.25, folds)) / Math.max(1, length)
  return [(SLOPE[style] * Math.max(0, wind)) / k, k]
}

/** The raster in a canvas with an empty margin, so its coarse mip levels end in empty texels. */
function padded(layout: Raster): {
  canvas: HTMLCanvasElement
  frame: [number, number, number, number]
} {
  const [frameX, frameY, frameWidth, frameHeight] = layout.frame
  const scale = layout.canvas.width / (frameWidth || 1)
  const margin = Math.ceil(MARGIN * scale)
  const canvas = document.createElement('canvas')
  canvas.width = layout.canvas.width + 2 * margin
  canvas.height = layout.canvas.height + 2 * margin
  canvas.getContext('2d')?.drawImage(layout.canvas, margin, margin)
  const marginPx = margin / scale
  return {
    canvas,
    frame: [
      frameX - marginPx,
      frameY - marginPx,
      frameWidth + 2 * marginPx,
      frameHeight + 2 * marginPx,
    ],
  }
}

/** The alpha of a computed CSS color, 1 when it has none: `rgb(0 0 0 / 0.5)`, `rgba(0, 0, 0, 0.5)`. */
export function alphaOf(value: string): number {
  const word = value.trim()
  if (word === 'transparent') return 0
  const inner = /^[a-z-]+\((.*)\)$/i.exec(word)?.[1]
  if (!inner) return 1
  const commas = inner.split(',')
  const last = inner.includes('/') ? inner.slice(inner.lastIndexOf('/') + 1) : commas[3]
  const amount = Number.parseFloat(last ?? '')
  if (!Number.isFinite(amount)) return 1
  return Math.min(1, Math.max(0, last?.trim().endsWith('%') ? amount / 100 : amount))
}

/** The back of the cloth: the surface (or the text) color darker, or lighter when it is dark. */
export function backOf(color: Color): Color {
  const [L, a, b] = toOklab(color)
  return L > 0.42
    ? fromOklab([L * 0.62, a * 1.1, b * 1.1])
    : fromOklab([Math.min(1, L + 0.24), a, b])
}

/** Phases whose cloth still moves, so the frame policy keeps drawing. */
const pacing = new WeakMap<AbortSignal, () => number>()

/**
 * The heading printed on a waving 3D cloth: a flag pinned at its left edge, a ribbon that twists
 * along its length and shows its tinted back, or silk with slow ripples and a sweeping sheen. The
 * folds are lit by their normals and the cloth casts a soft shadow on the page. The DOM text
 * stays for screen readers, search and selection, and shows again whenever the cloth rests flat.
 */
const ribbon: Effect<Params> = defineEffect({
  name: 'ribbon',
  params: {
    style: oneOf('flag', 'ribbon', 'silk'),
    trigger: oneOf('loop', 'hover', 'scroll'),
    wind: 1,
    speed: 1,
    folds: 2.5,
    twist: 180,
    gloss: 0.6,
    back: '',
    color: '',
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // Folds, perspective and the shadow reach past the box.
  bleed: 160,
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal, render } = ctx
    const el = element as HTMLElement
    const style = params.style
    const trigger = params.trigger
    const ratio = ctx.quality === 'low' ? 1 : 2
    const own = getComputedStyle(element)
    const css = unsupported(element)
    const image =
      own.backgroundImage && own.backgroundImage !== 'none' ? 'a background image' : undefined
    const reason = css ?? image ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`ribbon: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }

    // The surface: `color`, else the element's own solid background, else none. Without `color`
    // the DOM looks the same as the flat cloth, so it shows at rest.
    const given = params.color.trim() ? palette(params.color, element)[0] : undefined
    const background = own.backgroundColor
    const bgAlpha = background ? alphaOf(background) : 0
    const surfaceCss = given ?? (bgAlpha > 0 ? cssColor(background) : undefined)
    const surface = surfaceCss ? linear(surfaceCss) : new Color(0, 0, 0)
    const tinted = !!surfaceCss
    const restDom = !given
    const backCss = params.back.trim() ? palette(params.back, element)[0] : undefined
    const backColor = backCss ? linear(backCss) : backOf(tinted ? surface : linear(own.color))

    const emOf = (r: Raster): number => Math.max(1, ...r.quads.map((q) => q.em))
    const boxOf = (): { width: number; height: number } => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }
    const step = STEP[ctx.quality] ?? STEP.high
    let box = boxOf()
    const build = (layout: Raster): { list: Strip[]; geometry: BufferGeometry } => {
      const pad = Math.min(48, emOf(layout) * 0.3)
      const list = strips(layout, style, box, tinted, pad)
      return { list, geometry: cloth(list, step) }
    }
    let made = build(layout)
    let copy = padded(layout)

    // clock (rad), energy 0..1, amplitude px, wave number rad/px.
    const wave = uniform(new Vector4(0, 0, 0, 0.01))
    const twist = uniform(0)
    // Dent: box px x, y, depth px, radius px.
    const dent = uniform(new Vector4(0, 0, 0, 40))
    // Box centre in world px, perspective, camera distance.
    const view = uniform(new Vector4(0, 0, 1200, render.camera.position.z || 1000))
    const frame = uniform(new Vector4(...copy.frame))
    const texel = uniform(copy.canvas.width / (copy.frame[2] || 1))
    // Silk's sheen band: centre and half width along its slant, px; energy.
    const sweep = uniform(new Vector4(-1e4, 100, 0, 0))
    // Away from the light per px of height, x and y; shadow strength; lift px.
    const shadow = uniform(new Vector4(0, 0, 0, 0))
    const tint = uniform(surface)
    const tintAlpha = uniform(tinted ? (given ? 1 : Math.min(1, bgAlpha)) : 0)
    const backTint = uniform(backColor)

    const waveNode = wave as unknown as V4
    const dentNode = dent as unknown as V4
    const viewNode = view as unknown as V4
    const shadowNode = shadow as unknown as V4
    const strip = attribute(STRIP, 'vec4') as unknown as V4
    const index = attribute(SEED, 'float') as unknown as F
    const half = u.size.mul(0.5) as unknown as V2
    const gridX = positionGeometry.x as unknown as F
    const gridY = positionGeometry.y as unknown as F

    /** The cloth point of box px (x, y) in world px from the box centre, y up, before perspective. */
    const place = (x: F, y: F): V3 => {
      const along = x.sub(strip.x)
      const across = y.sub(strip.z)
      const phase = waveNode.x
      const waveNumber = waveNode.w
      const amplitude = waveNode.z.mul(waveNode.y)
      const seed = index.mul(1.7)
      let worldX: F = x.sub(half.x) as F
      let worldY: F = half.y.sub(y) as F
      let worldZ: F
      if (style === 'flag') {
        // Pinned at the left edge: the swing grows along the cloth.
        const share = clamp(along.div(strip.y), 0, 1)
        const amp = amplitude.mul(share.mul(share.mul(-0.6).add(1.6)))
        const p1 = along.mul(waveNumber).sub(phase).add(across.mul(waveNumber).mul(0.22))
        const p2 = along
          .mul(waveNumber)
          .mul(2.1)
          .sub(phase.mul(1.55))
          .sub(across.mul(waveNumber).mul(0.45))
          .add(1.7)
        const p3 = along.mul(waveNumber).mul(0.5).sub(phase.mul(0.62)).add(0.9)
        worldZ = amp.mul(sin(p1).mul(0.6).add(sin(p2).mul(0.2)).add(sin(p3).mul(0.35))) as F
        // It sags a little and sways up and down, and folds pull it toward the pole.
        worldY = worldY.sub(
          amp.mul(
            sin(p3.add(1.2))
              .mul(0.2)
              .add(sin(p1.add(0.4)).mul(0.08))
              .add(0.1),
          ),
        ) as F
        worldX = worldX.sub(amp.mul(cos(p1).add(1).mul(0.12))) as F
      } else if (style === 'ribbon') {
        // The centre line waves; the strip turns about it. A twist runs along it as a pulse that
        // leaves at the far end and comes back, over a gentle turn everywhere.
        const p1 = along.mul(waveNumber).sub(phase).add(seed)
        const p2 = along.mul(waveNumber).mul(1.8).sub(phase.mul(1.4)).add(seed.mul(2.3)).add(1.1)
        const centreZ = amplitude.mul(sin(p1).mul(0.7).add(sin(p2).mul(0.3)))
        const centreY = amplitude
          .mul(0.3)
          .mul(sin(along.mul(waveNumber).mul(0.6).sub(phase.mul(0.7)).add(seed.mul(1.7))))
        const sigma = max(strip.w.mul(2), strip.y.mul(0.06))
        const period = strip.y.add(sigma.mul(6))
        const centre = mod(
          phase.mul(strip.y).mul(TRAVEL).add(seed.mul(strip.y).mul(0.37)),
          period,
        ).sub(sigma.mul(3))
        const pulse = along.sub(centre).div(sigma)
        const twistAngle = twist.mul(
          exp(pulse.mul(pulse).negate()).add(
            sin(along.mul(waveNumber).mul(0.5).sub(phase.mul(0.5)).add(seed.mul(1.3))).mul(GENTLE),
          ),
        )
        const offset = across.negate()
        worldY = half.y
          .sub(strip.z)
          .add(centreY)
          .add(offset.mul(cos(twistAngle))) as F
        worldZ = centreZ.add(offset.mul(sin(twistAngle))) as F
      } else {
        // Ripples from three directions, slow and shallow.
        const q1 = along.mul(0.8).add(across.mul(0.6)).mul(waveNumber).sub(phase)
        const q2 = along
          .mul(-0.35)
          .add(across.mul(0.94))
          .mul(waveNumber.mul(1.35))
          .sub(phase.mul(0.8))
          .add(1.1)
        const q3 = along.mul(waveNumber.mul(0.45)).sub(phase.mul(0.6)).add(2.3)
        worldZ = amplitude.mul(sin(q1).mul(0.5).add(sin(q2).mul(0.32)).add(sin(q3).mul(0.4))) as F
        worldY = worldY.add(amplitude.mul(0.06).mul(sin(q3.add(0.5)))) as F
      }
      // The pointer pushes the cloth back where it is.
      const fromDent = vec2(x, y).sub(dentNode.xy)
      worldZ = worldZ.sub(
        dentNode.z.mul(exp(dot(fromDent, fromDent).div(dentNode.w.mul(dentNode.w)).negate())),
      ) as F
      return vec3(worldX, worldY, worldZ) as unknown as V3
    }

    const clothPoint = place(gridX, gridY)
    // The normal from two neighbours a pixel away: the surface's own tangents.
    const tangentX = place(gridX.add(1) as F, gridY).sub(clothPoint)
    const tangentY = place(gridX, gridY.add(1) as F).sub(clothPoint)
    const normal = varying(cross(tangentY, tangentX)) as unknown as V3
    // Seen with the box's own perspective, vanishing at its centre (like media's offaxis).
    const depth = clothPoint.z.mul(viewNode.w).div(viewNode.z)
    const drawn = vec3(
      clothPoint.x.sub(viewNode.x.mul(depth).div(viewNode.w)),
      clothPoint.y.sub(viewNode.y.mul(depth).div(viewNode.w)),
      depth,
    )

    const at = varying(vec2(gridX, gridY)) as unknown as V2
    // Distance to the strip's edge in px: the edge is smoothed over a screen pixel.
    // Each distance is linear across a triangle; their minimum is taken per fragment.
    const edges = varying(
      vec4(
        gridX.sub(strip.x),
        strip.x.add(strip.y).sub(gridX),
        gridY.sub(strip.z.sub(strip.w)),
        strip.z.add(strip.w).sub(gridY),
      ),
    ) as unknown as V4
    const edge = min(min(edges.x, edges.y), min(edges.z, edges.w)) as unknown as F
    const frameNode = frame as unknown as V4
    const inkUV = vec2(
      at.x.sub(frameNode.x).div(frameNode.z),
      at.y.sub(frameNode.y).div(frameNode.w).oneMinus(),
    )
    // Ink past the box is masked at the box edge a pixel in, where the mask is whole.
    const boxUV = vec2(
      clamp(at.x, 1, u.size.x.sub(1)).div(u.size.x),
      clamp(at.y, 1, u.size.y.sub(1)).div(u.size.y).oneMinus(),
    )
    const mask = ctx.mask(boxUV as unknown as V2)
    const ink = texture(atlas(copy.canvas))
    // Every read follows the swaps of `ink.value`.
    ink.mergeable = false

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    // One pass: a transparent double-sided material would otherwise draw its sides apart.
    material.forceSinglePass = true
    material.positionNode = drawn
    {
      const texel = texture(ink, inkUV) as unknown as V4
      const inkAlpha = texel.a
      const text = sRGBTransferEOTF(texel.rgb.div(max(inkAlpha, 1e-4)) as never) as unknown as V3
      const tintCover = tintAlpha as unknown as F
      const tintColor = tint as unknown as V3
      // Printed side: the text over the surface. Back: the cloth's shape in the back color, the
      // print showing through a little.
      const frontCover = inkAlpha.add(tintCover.mul(inkAlpha.oneMinus()))
      const frontRGB = text.mul(inkAlpha).add(tintColor.mul(tintCover).mul(inkAlpha.oneMinus()))
      const backCover = max(inkAlpha, tintCover)
      const backRGB = (backTint as unknown as V3)
        .mul(backCover)
        .mul(inkAlpha.mul(tintCover).mul(0.16).oneMinus())
      const cover = select(frontFacing, frontCover, backCover)
      const base = select(frontFacing, frontRGB, backRGB)
      // Lit by the normal against the flat cloth: flat is the text as it is.
      const unitNormal = normalize(normal)
      const frontNormal = select(unitNormal.z.greaterThanEqual(0), unitNormal, unitNormal.negate())
      const light = vec3(...LIGHT.map((v) => v / LIGHT_LENGTH))
      const lit = clamp(dot(frontNormal, light).div(LIGHT[2] / LIGHT_LENGTH), 0, 1.5)
      const shade = clamp(lit, 0.12, 1.3)
      const halfway = vec3(...HALF)
      const shininess = style === 'silk' ? 10 : 26
      const crest = max(
        pow(max(dot(frontNormal, halfway), 0), shininess).sub(HALF[2] ** shininess),
        0,
      )
      let gloss: F = crest.mul(u.gloss).mul(style === 'silk' ? 0.8 : 1.1) as F
      if (style === 'silk') {
        // A broad sheen sweeps over at a slant, brighter on the ripples that face it.
        const sweepNode = sweep as unknown as V4
        const along = at.x.add(at.y.mul(0.45)).sub(sweepNode.x).div(sweepNode.y)
        const band = exp(along.mul(along).negate())
        const face = pow(max(dot(frontNormal, halfway), 0), 4)
        gloss = gloss.add(band.mul(face.mul(0.75).add(0.25)).mul(u.gloss, sweepNode.z, 0.8)) as F
      }
      const rgb = base.mul(shade).add(vec3(gloss).mul(cover))
      const smooth = clamp(edge.div(max(fwidth(edge), 1e-3)), 0, 1)
      const alpha = cover.mul(smooth)
      material.colorNode = vec4(rgb.div(max(cover, 1e-4)), alpha.mul(mask))
    }

    // The shadow on the page: the cloth seen from the light, flattened, softer the higher it is.
    const shadowMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    shadowMaterial.forceSinglePass = true
    {
      const height = max(clothPoint.z.add(shadowNode.w), 0)
      shadowMaterial.positionNode = vec3(clothPoint.xy.add(shadowNode.xy.mul(height)), 0)
      const blur = varying(height.mul(0.3).add(1.5)) as unknown as F
      const lod = log2(max(blur.mul(texel), 1))
      const inkAlpha = texture(ink, inkUV, lod).a
      const sheet = (tintAlpha as unknown as F).mul(clamp(edge.div(blur.mul(2)), 0, 1))
      shadowMaterial.colorNode = vec4(vec3(0), max(inkAlpha, sheet).mul(shadowNode.z).mul(mask))
    }

    const clothMesh = new Mesh(made.geometry, material)
    const shadowMesh = new Mesh(made.geometry, shadowMaterial)
    const group = new Group()
    for (const mesh of [shadowMesh, clothMesh]) {
      // The vertices are placed by the shader.
      mesh.frustumCulled = false
      group.add(mesh)
    }
    clothMesh.renderOrder = 1
    ctx.onDispose(() => {
      ;(ink.value as Texture).dispose()
      made.geometry.dispose()
    })
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    const use = (next: Raster): void => {
      const old = ink.value as Texture
      const oldGeometry = made.geometry
      layout = next
      box = boxOf()
      copy = padded(next)
      ink.value = atlas(copy.canvas)
      old.dispose()
      frame.value.set(...copy.frame)
      texel.value = copy.canvas.width / (copy.frame[2] || 1)
      made = build(next)
      clothMesh.geometry = made.geometry
      shadowMesh.geometry = made.geometry
      oldGeometry.dispose()
    }
    // Build again when the text, its fonts or its box change.
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      if (await fonts(element)) return
      if (signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (!next?.quads.length) return
      use(next)
      ctx.invalidate()
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
      const now = boxOf()
      if (Math.abs(now.width - box.width) > 0.5 || Math.abs(now.height - box.height) > 0.5)
        schedule()
    })
    resize.observe(element)
    ctx.onDispose(() => resize.disconnect())
    document.fonts?.addEventListener('loadingdone', schedule, { signal })

    // A mouse dents the cloth and, with `trigger: hover`, raises the wind; a tap blows a gust.
    let mouse = false
    let tapped = -1
    const wake = (): void => ctx.invalidate()
    addEventListener(
      'pointermove',
      (e) => {
        mouse = e.pointerType !== 'touch'
      },
      { signal, passive: true },
    )
    el.addEventListener(
      'pointerdown',
      (e) => {
        mouse = e.pointerType !== 'touch'
        if (!mouse && trigger === 'hover') {
          tapped = 0
          wake()
        }
      },
      { signal, passive: true },
    )
    let focused = false
    if (trigger === 'hover') {
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      target.addEventListener(
        'focusin',
        () => {
          focused = true
          wake()
        },
        { signal },
      )
      target.addEventListener(
        'focusout',
        () => {
          focused = false
          wake()
        },
        { signal },
      )
    }

    let energy = 0
    let clock = 0
    let pressed = 0
    let dentX = 0
    let dentY = 0
    let placed = false
    let rate = 0
    let shownDom: boolean | undefined
    const show = (value: boolean): void => {
      if (shownDom === value) return
      shownDom = value
      ctx.showDom(value)
    }
    pacing.set(signal, () => rate)
    const world = { x: 0, y: 0 }

    return (input) => {
      const live = ctx.params
      const dt = Math.min(Math.max(input.delta, 0), 0.1)
      const reduced = input.reducedMotion
      const { width: boxWidth, height: boxHeight } = input

      // The wind: on all the time, under the pointer, or from the scroll speed.
      let target = 0
      if (!reduced) {
        if (trigger === 'loop') target = 1
        else if (trigger === 'hover') {
          if (tapped >= 0) {
            tapped += dt
            if (tapped > TAP) tapped = -1
          }
          target = (input.over && mouse) || focused || tapped >= 0 ? 1 : 0
        } else target = Math.min(1, Math.abs(input.velocity) * GUST)
      }
      energy = reduced
        ? 0
        : damp(energy, target, target > energy ? RISE[trigger] : FALL[trigger], dt, CALM)

      // The dent follows the pointer while a mouse is over the cloth.
      const over = !reduced && mouse && input.over
      const pointerX = input.pointer.x * boxWidth
      const pointerY = (1 - input.pointer.y) * boxHeight
      if (over) {
        if (!placed) {
          dentX = pointerX
          dentY = pointerY
          placed = true
        }
        dentX = damp(dentX, pointerX, FOLLOW, dt)
        dentY = damp(dentY, pointerY, FOLLOW, dt)
      }
      const pushTo = over ? 1 : 0
      pressed = reduced ? 0 : damp(pressed, pushTo, over ? 0.18 : 0.45, dt, CALM)
      if (!pressed) placed = false
      const following =
        over && (Math.abs(dentX - pointerX) > 0.3 || Math.abs(dentY - pointerY) > 0.3)

      const speed = Math.max(0, live.speed)
      const blowing = energy > 0
      // Waves travel with the wind; with hover and scroll they slow as it settles.
      if (blowing && !reduced)
        clock += dt * speed * PACE[style] * (trigger === 'loop' ? 1 : 0.35 + 0.65 * energy)

      const length = Math.max(1, ...made.list.map((s) => s.width))
      const [amp, k] = waves(style, length, live.wind, live.folds)
      // Never deeper than the cloth is tall, so a long single line does not fold over itself.
      const tall = Math.max(1, ...made.list.map((s) => s.height))
      ;(wave.value as Vector4).set(clock, energy, Math.min(amp, tall * 0.6), k)
      twist.value = style === 'ribbon' ? ((Math.max(0, live.twist) * Math.PI) / 180) * energy : 0
      const em = layout ? emOf(layout) : 40
      const radius = Math.min(160, Math.max(24, em * 0.9))
      ;(dent.value as Vector4).set(dentX, dentY, radius * 0.45 * pressed, radius)
      const lift = amp * energy * LIFT
      const away = Math.hypot(LIGHT[0], LIGHT[1])
      ;(shadow.value as Vector4).set(
        (-LIGHT[0] / away) * 0.55,
        (-LIGHT[1] / away) * 0.55,
        SHADOW * Math.max(energy, pressed * 0.6) * (reduced ? 0 : 1),
        lift,
      )
      if (style === 'silk') {
        // The sheen crosses from before the first corner to past the last, then comes round again.
        const span = boxWidth + boxHeight * 0.45
        const pass = ((clock * 0.09) % 1.5) / 1.5
        ;(sweep.value as Vector4).set(
          -span * 0.3 + pass * span * 1.6,
          Math.max(60, span * 0.16),
          energy,
          0,
        )
      }
      const c = render.toWorld(input.x + boxWidth / 2, input.y + boxHeight / 2, world)
      ;(view.value as Vector4).set(
        c.x,
        c.y,
        Math.max(700, 1.1 * Math.max(boxWidth, boxHeight)),
        render.camera.position.z || 1000,
      )

      const resting = !blowing && !pressed
      // Flat and still: the DOM shows, unless `color` paints a surface the DOM does not have.
      show(restDom && resting && input.presence >= 1)
      const moving = !resting && (speed > 0 || energy !== target || following || pressed !== pushTo)
      rate = moving && !reduced ? (ctx.quality === 'low' ? 30 : 60) : 0
      if (trigger === 'hover' && tapped >= 0) rate = rate || 30
    }
  },
})
export default ribbon
