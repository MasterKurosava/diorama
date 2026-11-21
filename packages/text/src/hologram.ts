import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, dither, inView, roundedBox } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  atan,
  attribute,
  clamp,
  cos,
  exp,
  float,
  floor,
  fract,
  max,
  mix,
  normalView,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  NormalBlending,
  PlaneGeometry,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { wallTone } from './neon'
import { fonts, type Raster, raster, unsupported } from './raster'

type Style = 'projector' | 'card' | 'ghost'
type Trigger = 'view' | 'hover' | 'loop'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  color: string
  layers: number
  depth: number
  scan: number
  flicker: number
  sway: number
  tilt: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>
type V4 = Node<'vec4'>

const CYAN = '#3ee8ff'
const ICE = '#a9d8ff'
/** Share of the box in view (above the bottom tenth) before it materialises. */
const SHOWN = 0.35
/** Seconds the emitter takes to power up, then the scan from bottom to top. */
const POWER = 0.35
const SCAN = 1.1
/** Frames a second of the idle shimmer. */
const IDLE_FPS = 30
/** How fast the tilt follows the pointer, per second. */
const FOLLOW = 8
const DEG = Math.PI / 180
const LAYER = 'holoLayer'
/** Raster scale above the low quality tier. */
const HIGH_RATIO = 2
/** Delay before rastering again after a change, ms. */
const REDO_DELAY = 150

/** A uniform random number in [0, 1) for two counters: the same on every load. */
export function chance(a: number, b: number): number {
  let h = (Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Brightness factor of the projection at `t` seconds for a `flicker` 0..1: steady most of the
 * time, now and then a short stutter or a drop-out, decided per 30th of a second.
 */
export function flickerAt(t: number, flicker: number): number {
  if (flicker <= 0) return 1
  const frame = Math.floor(t * IDLE_FPS)
  const burst = Math.floor(t / 1.7)
  // About one stretch in four of 1.7 s holds a glitch, longer and more often with `flicker`.
  if (chance(burst, 1) > 0.25 + 0.35 * flicker) return 1
  const start = chance(burst, 2) * 1.2
  const local = t - burst * 1.7
  if (local < start || local > start + 0.12 + 0.25 * flicker) return 1
  const roll = chance(frame, 3)
  if (roll < 0.25 * flicker) return 0.08
  return 1 - flicker * 0.5 * chance(frame, 4)
}

/** The progress of the materialising scan at `t` seconds since it started: emitter, then scan. */
export function materialise(t: number): { power: number; scan: number; done: boolean } {
  const power = Math.min(1, Math.max(0, t / POWER))
  const progress = Math.min(1, Math.max(0, (t - POWER * 0.6) / SCAN))
  return {
    power: power * power * (3 - 2 * power),
    scan: progress,
    done: progress >= 1 && power >= 1,
  }
}

/** A CSS color as `#rrggbb`: var() and currentColor are read from the element. */
function colorOf(value: string, element: Element): string | undefined {
  const style = getComputedStyle(element)
  let word = value.trim()
  for (let depth = 0; depth < 8; depth++) {
    const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/is.exec(word)
    if (!varMatch) break
    word = style.getPropertyValue(varMatch[1] as string).trim() || (varMatch[2] ?? '').trim()
  }
  return word ? cssColor(word) : undefined
}

/** One instanced quad per depth slice, the back one first. */
function slices(count: number): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  const sliceCount = Math.max(1, count)
  const layer = new Float32Array(sliceCount)
  for (let i = 0; i < sliceCount; i++) layer[i] = sliceCount === 1 ? 1 : i / (sliceCount - 1)
  geometry.setAttribute(LAYER, new InstancedBufferAttribute(layer, 1))
  geometry.instanceCount = sliceCount
  return geometry
}

/** Hash of two floats to [0, 1). */
const hash = (a: F, b: F): F => fract(sin(a.mul(12.9898).add(b.mul(78.233))).mul(43758.5453))

const follow = (value: number, goal: number, k: number, snap: number): number =>
  Math.abs(goal - value) < snap ? goal : value + (goal - value) * k

/** Frames a second each instance asks for. */
const pacing = new WeakMap<AbortSignal, () => number>()

/**
 * A heading becomes a 3D hologram in front of the page: a glowing emitter below it throws a cone
 * of light up, and the letters float above as translucent slices stacked in depth, crossed by
 * scan lines, shimmering, split in color and dropping out now and then, swaying a few degrees so
 * the depth shows. The text stays in the DOM.
 */
const hologram: Effect<Params> = defineEffect({
  name: 'hologram',
  params: {
    style: oneOf('projector', 'card', 'ghost'),
    trigger: oneOf('view', 'hover', 'loop'),
    color: '',
    layers: 6,
    depth: 0.3,
    scan: 1,
    flicker: 0.4,
    sway: 6,
    tilt: 8,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The emitter and its light sit below the text.
  bleed: 220,
  presence: 'fade',
  quality: {},
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, u, params, app, signal } = ctx
    const { stage } = app
    const el = element as HTMLElement
    const ratio = ctx.quality === 'low' ? 1 : HIGH_RATIO
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'line', ratio)
    if (signal.aborted) return
    if (!layout?.quads.length) {
      if (reason && DEV)
        app.log.warn(`hologram: ${reason} cannot be drawn, the text stays as it is`, element)
      ctx.showDom(true)
      return
    }
    const style = params.style
    const trigger = params.trigger
    const ghost = style === 'ghost'
    const card = style === 'card'
    let hex = colorOf(params.color, element)
    if (!hex && params.color.trim() && DEV)
      app.log.warn(`hologram: "${params.color}" is not a color, using cyan`, element)
    hex ??= ghost ? ICE : CYAN
    const tone = wallTone(element)
    // On a dark page light adds up; on a light one it is drawn over the paper, darker.
    const dark = card || tone < 0.55
    const tint = uniform(new Color(hex).multiplyScalar(dark ? 1 : 0.8))
    const em = (source: Raster): number => Math.max(1, ...source.quads.map((line) => line.em))

    const frame = uniform(new Vector4(...layout.frame))
    const clock = uniform(0)
    const power = uniform(0)
    const reveal = uniform(0)
    const bright = uniform(1)
    const tear = uniform(new Vector4(0, 0, 0, 0))
    const scanK = uniform(1)
    const sweepOn = uniform(1)
    const pad = uniform(em(layout) * 0.3)
    const lift = uniform(em(layout) * 0.15)
    const volume = uniform(em(layout) * 0.3)
    const drift = uniform(0)
    const layerCount = (v: number): number => Math.max(1, Math.min(16, Math.round(v) || 1))
    const count = uniform(layerCount(params.layers))
    const fade = clamp(u.presence, 0, 1)
    const half = u.size.mul(0.5)

    const map = (source: Raster): Texture => {
      const made = new CanvasTexture(source.canvas)
      made.premultiplyAlpha = true
      return made
    }
    let glyphs = map(layout)
    const nodes: { value: Texture }[] = []
    const read = (at: V2, level?: number): V4 => {
      const node =
        level === undefined ? texture(glyphs, at) : texture(glyphs, at).level(float(level))
      nodes.push(node as unknown as { value: Texture })
      return node as unknown as V4
    }
    const material = (additive: boolean): MeshBasicNodeMaterial =>
      new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: additive && dark ? AdditiveBlending : NormalBlending,
      })
    // Light past the box is masked at the box edge half a px in, where the mask is whole.
    const boxMask = (x: F, y: F): F => {
      const at = varying(vec2(x, y)) as unknown as V2
      return ctx.mask(
        vec2(
          clamp(at.x, 0.5, u.size.x.sub(0.5)).div(u.size.x),
          clamp(at.y, 0.5, u.size.y.sub(0.5)).div(u.size.y).oneMinus(),
        ),
      )
    }

    // Box px of the text's centre and of the emitter below it.
    const centreX = frame.x.add(frame.z.mul(0.5))
    const centreY = frame.y.add(frame.w.mul(0.5))
    const emitterY = frame.y.add(frame.w).add(pad.mul(1.4))

    // The slices: quads over the text, the back one at the lift, the front one a volume ahead.
    const layer = attribute(LAYER, 'float') as unknown as F
    const corner = positionGeometry.xy.add(0.5)
    const sliceX = frame.x.sub(pad).add(corner.x.mul(frame.z.add(pad.mul(2))))
    const sliceY = frame.y.sub(pad).add(corner.y.oneMinus().mul(frame.w.add(pad.mul(2))))
    const slice = material(true)
    // Positions relative to the pivot (the text's centre, mid volume); the ghost's echoes trail
    // back and down.
    const back = layer.oneMinus()
    slice.positionNode = vec3(
      sliceX.sub(centreX).add(back.mul(drift).mul(0.35)),
      centreY.sub(sliceY).sub(back.mul(drift).mul(0.25)),
      layer.sub(0.5).mul(volume),
    )
    const fragX = varying(sliceX) as unknown as F
    const fragY = varying(sliceY) as unknown as F
    const vLayer = varying(layer) as unknown as F
    // 0 at the bottom of the text, 1 at its top.
    const heightShare = frame.y.add(frame.w).sub(fragY).div(frame.w)
    const row = floor(fragY.div(2))
    const tick = floor(clock.mul(24))
    // Interference: rows shift a little, a slow wave runs through them, and a torn band jumps.
    const inTear = smoothstep(tear.y, 0, abs(fragY.sub(tear.x))).mul(tear.w)
    const shift = hash(row, tick)
      .sub(0.5)
      .mul(scanK.mul(0.8))
      .add(sin(fragY.mul(0.09).add(clock.mul(2.3))).mul(0.6))
      .add(inTear.mul(tear.z))
    const at = vec2(
      fragX.add(shift).sub(frame.x).div(frame.z),
      fragY.sub(frame.y).div(frame.w).oneMinus(),
    )
    const split = vec2(float(1.6).add(back.mul(2)).add(inTear.mul(4)).div(frame.z), 0)
    const inkMid = read(at).a
    const inkRight = read(at.add(split)).a
    const inkLeft = read(at.sub(split)).a
    const halo = read(at, 3).a
    const soft = read(at, 1.5).a
    // The front slice is the solid one, the slices behind show the letters' edges, fainter.
    const front = pow(vLayer, 3)
    const rim = inkMid.mul(soft.oneMinus()).mul(2.2).clamp(0, 1)
    const body = mix(rim.mul(0.5).add(inkMid.mul(0.06)), inkMid.mul(0.8).add(rim.mul(0.7)), front)
    const lines = float(1).sub(
      scanK.mul(ghost ? 0.25 : 0.5).mul(
        sin(fragY.mul(Math.PI * 0.5))
          .mul(0.5)
          .add(0.5),
      ),
    )
    const sweepY = fract(clock.mul(0.32))
    const sweep = exp(pow(heightShare.sub(sweepY.mul(1.6).sub(0.3)).mul(7), 2).negate())
      .mul(scanK, sweepOn)
      .mul(0.9)
    const grain = hash(fragX.add(clock.mul(37)), fragY)
      .sub(0.5)
      .mul(0.18)
    // Materialising: lit up to a line rising from the bottom, which glows as it passes.
    const edge = reveal.mul(1.2).sub(0.1)
    const shown = ghost
      ? step(hash(floor(fragX.div(3)), floor(fragY.div(3))), reveal.mul(1.05))
      : smoothstep(edge.add(0.02), edge.sub(0.02), heightShare)
    const line = ghost
      ? float(0)
      : exp(abs(heightShare.sub(edge)).mul(-30)).mul(reveal.oneMinus().mul(8).clamp(0, 1))
    const weight = mix(float(0.7).div(max(count.mul(0.45), 1)), 1, front).mul(dark ? 1 : 1.3)
    const glow = body
      .mul(lines)
      .mul(sweep.add(1))
      .add(halo.mul(ghost ? 0.5 : 0.22).mul(front.add(0.3)))
      .add(grain.mul(inkMid))
      .mul(shown)
      .add(line.mul(soft.add(halo).mul(0.6)))
    const fringe = ghost ? 0 : 0.5
    const fringeR = max(inkRight.sub(inkMid), 0).mul(fringe)
    const fringeB = max(inkLeft.sub(inkMid), 0).mul(fringe)
    const rgb = tint
      .mul(glow)
      .add(vec3(1, 0.2, 0.65).mul(fringeR.mul(shown)))
      .add(vec3(0.25, 0.45, 1).mul(fringeB.mul(shown)))
      .add(vec3(1).mul(rim.mul(front).mul(0.25).add(line.mul(soft)).mul(shown.max(line))))
    const sliceA = glow
      .add(fringeR.add(fringeB).mul(shown))
      .mul(weight, bright, power, fade, boxMask(fragX, fragY))
    slice.colorNode = dark
      ? vec4(rgb.mul(sliceA), sliceA.clamp(0, 1))
      : vec4(rgb.div(max(glow.add(fringeR).add(fringeB), 1e-3)).mul(0.75), sliceA.clamp(0, 1))
    const sliceMesh = new Mesh(slices(count.value), slice)

    // The emitter: a disc lying below the text, tipped toward the eye, with a lit ring, a
    // turning ring of dashes and a bright core.
    const disc = material(false)
    const discUV = uv().mul(2).sub(1)
    const radius = discUV.length()
    const angle = atan(discUV.y, discUV.x).div(Math.PI * 2)
    const plate = smoothstep(1, 0.97, radius)
    const ring = exp(abs(radius.sub(0.9)).mul(-28))
    const dashes = step(0.55, fract(angle.mul(28).add(clock.mul(0.12))))
      .mul(smoothstep(0.62, 0.66, radius))
      .mul(smoothstep(0.78, 0.74, radius))
    const core = exp(radius.mul(radius).mul(-9))
    const lit = ring.add(dashes.mul(0.7)).add(core.mul(1.2)).mul(power, bright.mul(0.4).add(0.6))
    const metal = vec3(0.07, 0.08, 0.1).add(vec3(0.05).mul(radius))
    disc.colorNode = vec4(
      mix(metal, mix(tint, vec3(1), core.mul(0.5)), clamp(lit, 0, 1)),
      max(plate.mul(0.92), clamp(lit, 0, 1)).mul(fade),
    )
    const discMesh = new Mesh(new CircleGeometry(1, 64), disc)

    // The cone of light from the emitter up through the text, brighter at its silhouette.
    const beam = material(true)
    beam.side = DoubleSide
    const alongBeam = uv().y
    const silhouette = pow(float(1).sub(abs(normalView.z)), 1.5)
    const streaks = sin(
      uv()
        .x.mul(Math.PI * 2 * 18)
        .add(clock.mul(0.6)),
    )
      .mul(0.25)
      .add(0.75)
    const beamA = pow(alongBeam.oneMinus(), 0.8)
      .mul(mix(0.25, 1, silhouette), streaks)
      .mul(dark ? 0.32 : 0.18)
      .mul(power, bright, fade)
    beam.colorNode = dark ? vec4(tint.mul(beamA), beamA) : vec4(tint, beamA)
    const beamMesh = new Mesh(new CylinderGeometry(1, 0.25, 1, 64, 1, true), beam)

    // The light the emitter throws on the page around it, and up behind the text.
    const wall = material(true)
    const wallBox = vec4(
      frame.x.sub(pad.mul(4)),
      frame.y.sub(pad.mul(2)),
      frame.z.add(pad.mul(8)),
      0,
    )
    const wallX = wallBox.x.add(corner.x.mul(wallBox.z))
    const wallHeight = emitterY.add(pad.mul(3)).sub(wallBox.y)
    const wallY = wallBox.y.add(corner.y.oneMinus().mul(wallHeight))
    wall.positionNode = vec3(wallX.sub(half.x), half.y.sub(wallY), 0)
    const vx = varying(wallX) as unknown as F
    const vy = varying(wallY) as unknown as F
    const across = vx.sub(centreX).div(frame.z.mul(0.42).add(pad))
    const dyUp = emitterY.sub(vy).div(frame.w.add(pad.mul(4)))
    const dyDown = vy.sub(emitterY).div(pad.mul(1.4))
    const pool = exp(
      across
        .mul(across)
        .add(dyDown.max(0).mul(dyDown.max(0)))
        .negate()
        .mul(2.2),
    )
    const rise = exp(
      across
        .mul(across)
        .mul(1.6)
        .add(dyUp.max(0).mul(dyUp.max(0)).mul(1.2))
        .negate(),
    )
    const vCorner = varying(corner) as unknown as V2
    const windowed = smoothstep(0, 0.25, vCorner.x)
      .mul(smoothstep(1, 0.75, vCorner.x))
      .mul(smoothstep(0, 0.2, vCorner.y))
      .mul(smoothstep(1, 0.6, vCorner.y))
    const wallA = pool
      .mul(0.35)
      .add(rise.mul(0.12))
      .mul(dark ? 1 : 0.55)
      .mul(power, bright.mul(0.3).add(0.7), fade, windowed, boxMask(vx, vy))
      .add(dither())
      .clamp(0, 1)
    wall.colorNode = dark ? vec4(tint.mul(wallA), wallA) : vec4(tint, wallA)
    const wallMesh = new Mesh(new PlaneGeometry(1, 1), wall)

    // The card: a dark rounded panel behind the slices with a foil border, and a glossy foil
    // in front of them; both catch a rainbow sheen that sweeps across as the card tilts.
    const turn = uniform(new Vector4(0, 0, 0, 0))
    const cardSize = uniform(new Vector4(1, 1, 1, 0))
    const cardUV = uv()
    const cardExtent = vec2(cardSize.x, cardSize.y)
    const cardDistance = roundedBox(
      cardUV.sub(0.5).mul(cardExtent),
      cardExtent.mul(0.5),
      cardSize.z,
    )
    const inside = smoothstep(1, -1, cardDistance)
    const hue = fract(
      cardUV.x.mul(0.8).add(cardUV.y.mul(0.5)).add(turn.y.mul(3)).sub(turn.x.mul(2)),
    )
    const rainbow = vec3(0.5).add(cos(hue.mul(Math.PI * 2).add(vec3(0, 2.09, 4.19))).mul(0.5))
    const along = cardUV.x
      .mul(0.7)
      .add(cardUV.y.mul(0.3))
      .sub(0.5)
      .sub(turn.y.mul(2.5))
      .add(turn.x.mul(1.5))
    const band = exp(along.mul(along).mul(-40))
    const border = smoothstep(-7, -3, cardDistance)
    const fine = sin(cardUV.x.add(cardUV.y).mul(cardSize.x).mul(0.9)).mul(0.5).add(0.5)
    const panel = material(false)
    panel.colorNode = vec4(
      mix(vec3(0.025, 0.035, 0.07), rainbow.mul(0.75), border.mul(0.85).add(band.mul(0.12))),
      inside.mul(power.mul(0.7).add(0.3), fade),
    )
    const panelMesh = new Mesh(new PlaneGeometry(1, 1), panel)
    const foil = material(true)
    const foilA = band
      .mul(0.3)
      .add(fine.mul(band).mul(0.08))
      .add(rainbow.x.mul(0.02))
      .mul(inside, power, fade)
    foil.colorNode = vec4(rainbow.mul(foilA), foilA)
    const foilMesh = new Mesh(new PlaneGeometry(1, 1), foil)

    const group = new Group()
    const holo = new Group()
    const base = new Group()
    holo.add(panelMesh, beamMesh, sliceMesh, foilMesh)
    base.add(discMesh)
    group.add(wallMesh, base, holo)
    for (const mesh of [wallMesh, discMesh, beamMesh, sliceMesh, panelMesh, foilMesh])
      mesh.frustumCulled = false
    panelMesh.renderOrder = 2
    foilMesh.renderOrder = 4
    wallMesh.renderOrder = 0
    discMesh.renderOrder = 1
    beamMesh.renderOrder = 2
    sliceMesh.renderOrder = 3
    panelMesh.visible = card
    foilMesh.visible = card
    if (ghost || card) {
      discMesh.visible = false
      beamMesh.visible = false
      wallMesh.visible = false
    }
    ctx.onDispose(() => {
      for (const tex of new Set(nodes.map((x) => x.value))) tex.dispose()
      sliceMesh.geometry.dispose()
    })
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    /** Places the projector's parts for the current layout and box size. */
    const arrange = (width: number, height: number): void => {
      const [frameX, frameY, frameWidth, frameHeight] = (layout as Raster).frame
      const fontEm = em(layout as Raster)
      const padding = fontEm * 0.3
      pad.value = padding
      lift.value = fontEm * 0.15
      const depth = Math.max(0, ctx.params.depth) * fontEm * (ghost ? 1.6 : 1)
      volume.value = depth
      drift.value = ghost ? fontEm * 0.5 : 0
      const pivotX = frameX + frameWidth / 2 - width / 2
      const pivotY = height / 2 - (frameY + frameHeight / 2)
      const z = lift.value + depth / 2
      holo.position.set(pivotX, pivotY, z)
      const cardWidth = frameWidth + padding * 2.4
      const cardHeight = frameHeight + padding * 2.4
      cardSize.value.set(cardWidth, cardHeight, Math.min(cardWidth, cardHeight) * 0.12, 0)
      panelMesh.scale.set(cardWidth, cardHeight, 1)
      panelMesh.position.set(0, 0, -depth / 2 - fontEm * 0.12)
      foilMesh.scale.set(cardWidth, cardHeight, 1)
      foilMesh.position.set(0, 0, depth / 2 + fontEm * 0.04)
      const discRadius = Math.min(Math.max(frameWidth * 0.11, fontEm * 0.35), fontEm * 1.1)
      const emitterY = frameY + frameHeight + padding * 1.4 + discRadius * 0.12
      base.position.set(pivotX, height / 2 - emitterY, z)
      discMesh.scale.set(discRadius, discRadius, 1)
      discMesh.rotation.set(-Math.PI / 2 + 0.38, 0, 0)
      // The cone, in the holo group: from the emitter to the top of the text.
      const top = frameHeight / 2 + padding * 0.5
      const bottom = -(frameHeight / 2 + padding * 1.4)
      const coneH = top - bottom
      const topR = frameWidth * 0.55
      beamMesh.geometry.dispose()
      beamMesh.geometry = new CylinderGeometry(1, discRadius / topR, 1, 64, 1, true)
      beamMesh.scale.set(topR, coneH, Math.max(depth, fontEm * 0.4))
      beamMesh.position.set(0, (top + bottom) / 2, 0)
    }
    let size = { width: 0, height: 0 }

    const use = (next: Raster): void => {
      const replaced = glyphs
      glyphs = map(next)
      for (const node of nodes) node.value = glyphs
      replaced.dispose()
      frame.value.set(...next.frame)
      layout = next
      size = { width: 0, height: 0 }
      ctx.invalidate()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const redo = async (): Promise<void> => {
      timer = undefined
      if ((await fonts(element)) || signal.aborted) return
      const next = raster(element, 'line', ratio)
      if (next?.quads.length && !signal.aborted) use(next)
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

    // Hover: the element or the link it sits in powers it up; a tap toggles it on touch.
    let hovered = false
    if (trigger === 'hover') {
      const target = (el.closest('a, button') as HTMLElement | null) ?? el
      const set = (value: boolean): void => {
        if (value === hovered) return
        hovered = value
        ctx.invalidate()
      }
      const opts = { signal }
      target.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && set(true), opts)
      target.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && set(false), opts)
      target.addEventListener(
        'pointerdown',
        (e) => e.pointerType === 'touch' && set(!hovered),
        opts,
      )
      target.addEventListener('focusin', () => set(true), opts)
      target.addEventListener(
        'focusout',
        (e) => {
          if (!target.contains(e.relatedTarget as Element | null)) set(false)
        },
        opts,
      )
    }

    // The pointer near the hologram tips it toward itself.
    let mouse: { x: number; y: number } | undefined
    const point = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      mouse = { x: e.clientX, y: e.clientY }
      if (ctx.params.tilt > 0) ctx.invalidate()
    }
    addEventListener('pointermove', point, { passive: true, signal })
    document.documentElement.addEventListener(
      'pointerleave',
      () => {
        mouse = undefined
        ctx.invalidate()
      },
      { signal },
    )

    let since = -1
    let level = trigger === 'hover' ? 0.45 : 0
    let rate = 0
    let turnX = 0
    let turnY = 0
    // Where the pointer last tipped it: the card keeps its pose when the pointer leaves.
    let aimX = 0
    let aimY = 0
    pacing.set(signal, () => rate)

    return (input, time) => {
      const p = ctx.params
      const reduced = input.reducedMotion
      const now = time.now / 1000
      const dt = Math.min(input.delta, 0.1)
      if (size.width !== input.width || size.height !== input.height) {
        size = { width: input.width, height: input.height }
        arrange(input.width, input.height)
      }
      const layers = layerCount(p.layers)
      if (layers !== count.value) {
        count.value = layers
        sliceMesh.geometry.dispose()
        sliceMesh.geometry = slices(layers)
      }
      volume.value = Math.max(0, p.depth) * em(layout as Raster) * (ghost ? 1.6 : 1)
      let busy = false
      // How much of the motion shows: eases in and out so nothing snaps at rest.
      let swell = 1
      let live = false
      if (trigger === 'view' && since < 0) {
        if (inView(input.y, input.height, stage.height.peek(), SHOWN)) since = 0
      } else if (trigger === 'view') since += dt

      if (reduced) {
        power.value = trigger === 'hover' && !hovered ? 0.55 : 1
        reveal.value = 1
      } else if (trigger === 'view') {
        const phase = materialise(Math.max(0, since))
        power.value = since < 0 ? 0 : phase.power
        reveal.value = since < 0 ? 0 : phase.scan
        busy = since >= 0 && !phase.done
        live = busy
        swell = Math.sin(Math.PI * phase.scan)
      } else if (trigger === 'hover') {
        const goal = hovered ? 1 : 0.45
        level = follow(level, goal, 1 - Math.exp(-dt * (hovered ? 7 : 5)), 0.004)
        power.value = level
        reveal.value = 1
        busy = level !== goal
        live = hovered || busy
        swell = Math.min(1, Math.max(0, (level - 0.45) / 0.55))
      } else {
        power.value = 1
        reveal.value = 1
        live = input.visible
      }
      clock.value = live ? now : 0

      const scan = Math.max(0, p.scan)
      scanK.value = scan
      sweepOn.value = live && !ghost ? 1 : 0
      const flick = reduced || !live ? 0 : Math.min(1, Math.max(0, p.flicker))
      bright.value = flickerAt(now, flick)
      // A torn band now and then: a few px tall, shifted sideways for a frame or two.
      const frameIndex = Math.floor(now * IDLE_FPS)
      const torn = flick > 0 && chance(frameIndex, 7) < 0.04 * flick
      const frameHeight = (layout as Raster).frame[3]
      tear.value.set(
        (layout as Raster).frame[1] + chance(frameIndex, 8) * frameHeight,
        2 + chance(frameIndex, 9) * frameHeight * 0.12,
        (chance(frameIndex, 10) - 0.5) * 18,
        torn ? 1 : 0,
      )

      // Sway, and the tip toward the pointer.
      const swing = reduced || !live || card ? 0 : Math.max(0, p.sway) * DEG * swell
      if (!card || reduced || p.tilt <= 0) {
        aimX = 0
        aimY = 0
      }
      const most = Math.max(0, p.tilt) * DEG * (card ? 1.8 : 1)
      if (!reduced && mouse && p.tilt > 0) {
        const midX = input.x + input.width / 2
        const midY = input.y + input.height / 2
        const reach = Math.max(200, input.height * 1.5)
        const towardX = Math.max(-1, Math.min(1, (mouse.x - midX) / (input.width / 2 + reach)))
        const towardY = Math.max(-1, Math.min(1, (mouse.y - midY) / (input.height / 2 + reach)))
        if (Math.abs(towardX) < 1 && Math.abs(towardY) < 1) {
          aimY = towardX
          aimX = towardY * 0.6
        }
      }
      const goalX = aimX * most
      const goalY = aimY * most
      const blend = 1 - Math.exp(-dt * FOLLOW)
      turnX = follow(turnX, goalX, blend, 1e-4)
      turnY = follow(turnY, goalY, blend, 1e-4)
      busy ||= turnX !== goalX || turnY !== goalY
      const swayY = Math.sin(now * 0.55) * swing
      const swayX = Math.sin(now * 0.37 + 1) * swing * 0.25
      holo.rotation.set(turnX + swayX, turnY + swayY, 0)
      turn.value.set(turnX, turnY, 0, 0)
      if (ghost)
        holo.position.z =
          lift.value +
          volume.value / 2 +
          Math.sin(now * 0.6) * (live && !reduced ? swell : 0) * em(layout as Raster) * 0.12

      rate = reduced ? (busy ? 60 : 0) : busy ? 60 : live ? IDLE_FPS : 0
    }
  },
})
export default hologram
