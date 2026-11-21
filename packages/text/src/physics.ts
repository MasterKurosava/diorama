import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, ease, inView, rng } from '@dioramajs/effects/kit'
import {
  abs,
  attribute,
  Break,
  cameraPosition,
  cross,
  dot,
  Fn,
  float,
  fwidth,
  If,
  int,
  Loop,
  log2,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  select,
  smoothstep,
  sRGBTransferEOTF,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
} from 'three/webgpu'
import { type Atlas, flat, follow, margin, type Piece, prepare, relief } from './letters'
import { atlas as inkTexture } from './paint'
import { Box, World } from './rigid'

type Style = 'drop' | 'scatter' | 'stack'
type Trigger = 'view' | 'click' | 'scroll' | 'hover'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  gravity: number
  bounce: number
  friction: number
  depth: number
  throw: number
  container: string
}
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

/** Gravity at 1, px/s², and the fixed step of the world, s. */
export const GRAVITY = 2600
const STEP = 1 / 120
const MAX_STEPS = 4
/** Thinnest tile the world knows, em: depth 0 draws flat letters that still collide. */
const THIN = 0.04
/** Light from the upper left, toward the viewer, and the light of a face turned from it. */
const LIGHT = [-0.42, 0.6, 0.68] as const
const AMBIENT = 0.42
/** Darkness of the shadows on the page. */
const SHADE = 0.3
/** Width of the bevel round each letter, em. */
const BEVEL = 0.03
/** Steps of the march through a tile, per tier. */
const MARCH = { low: 8, medium: 14, high: 24 } as const
/** Seconds between letters as the heading collapses, stacks in, or stands back up. */
const COLLAPSE = 0.035
const STACK = 0.09
const RISE = 0.03
/** Seconds a letter flies back to its place. */
const FLY = 0.8
/** The view trigger: share of the heading in view, and the beat before it falls, s. */
const VIEW = { share: 0.5, delay: 0.45 } as const
/** The scroll trigger: it falls once its top rises past this share of the viewport. */
const LINE = 0.3
/** The hover trigger: seconds after the pointer left and the pile stilled before it stands up. */
const AWAY = 1
/** Everything sleeps this long after the last push, s: a pile never jitters forever. */
const QUIET = 9

// Attribute names become WGSL and GLSL identifiers: camelCase never meets a keyword of either.
/** Centre of the tile in the box frame (x right, y up, z to the viewer) and how far from home. */
const PLACE = 'tilePlace'
/** The tile's turn as a quaternion. */
const TURN = 'tileTurn'
/** Half width and half height of its cell, its drawn thickness and the font size. */
const DIMS = 'tileDims'
/** Atlas px of the cell's middle, and box px (y down) of its home, for the mask. */
const SPOT = 'tileSpot'

type Mode = 'home' | 'loose' | 'fly' | 'hop' | 'wait'
/** x, y, z and a quaternion. */
type Pose = [number, number, number, number, number, number, number]

interface Letter {
  readonly piece: Piece
  readonly box: Box
  /** Home in the box frame; z depends on the depth. */
  readonly hx: number
  readonly hy: number
  /** Reading order. */
  readonly order: number
  mode: Mode
  /** Seconds left before it lets go, stacks in or flies home. */
  wait: number
  /** Pose of the last step, for frames between steps. */
  readonly last: Float64Array
  /** Where a flight home starts: x, y, z, quaternion; and its clock. */
  readonly from: Float64Array
  clock: number
  /** A hop of stack: height over home, its speed, and tilts with their rates. */
  lift: number
  rise: number
  readonly tilt: Float64Array
  /** What its next release does: 0 drop, 1 scatter. */
  kick: number
}

/**
 * Letters become thick lit 3D tiles that fall, bounce, tumble and pile up at the bottom of their
 * container, can be thrown about with the pointer, and stand back up into the heading.
 */
const physics: Effect<Params> = defineEffect({
  name: 'physics',
  params: {
    style: oneOf('drop', 'scatter', 'stack'),
    trigger: oneOf('view', 'click', 'scroll', 'hover'),
    gravity: 1,
    bounce: 0.35,
    friction: 0.5,
    depth: 0.25,
    throw: 1,
    container: '',
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  // The letters lie at the bottom of a container that may be far below the heading.
  bleed: 1200,
  reducedMotion: 'off',
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { element, params, signal, u, render, app } = ctx
    const { stage } = app
    const { style, trigger } = params
    const veiled = (): boolean => element.getAttribute('data-dio-state') === 'entering'
    const onScreen = (): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.bottom > 0 && rect.top < stage.height.peek()
    }
    const seen = onScreen() && !veiled()
    const ratio = ctx.quality === 'low' ? 1 : 2
    const steps = MARCH[ctx.quality]
    let atlas = await prepare(ctx, ratio)
    if (!atlas || signal.aborted) return

    let holder: Element = element
    const selector = params.container.trim()
    if (selector) {
      let found: Element | null = null
      try {
        found = element.closest(selector)
      } catch {}
      if (found) holder = found
      else if (DEV)
        app.log.warn(`physics: no ancestor matches "${selector}", the heading is its own box`)
    }

    // Shared by the draws.
    const size = uniform(atlas.size[0])
    const tall = uniform(atlas.size[1])
    const density = uniform(atlas.scale)
    const wallZ = uniform(0)
    const floorY = uniform(0)
    const above = uniform(1)
    const ink = texture(inkTexture(atlas.canvas))
    ink.mergeable = false
    const bumps = texture(new CanvasTexture(flat()))
    bumps.mergeable = false
    ctx.onDispose(() => {
      ;(ink.value as Texture).dispose()
      ;(bumps.value as Texture).dispose()
    })
    const place = attribute(PLACE, 'vec4') as unknown as V4
    const turn = attribute(TURN, 'vec4') as unknown as V4
    const dims = attribute(DIMS, 'vec4') as unknown as V4
    const spot = attribute(SPOT, 'vec4') as unknown as V4
    const rotate = (q: V4, v: V3): V3 =>
      v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2)) as V3
    const unrotate = (q: V4, v: V3): V3 => rotate(vec4(q.xyz.negate(), q.w) as V4, v)
    const L0 = (() => {
      const l = Math.hypot(...LIGHT)
      return [LIGHT[0] / l, LIGHT[1] / l, LIGHT[2] / l] as const
    })()
    const light = vec3(...L0)
    const uvOf = (s: V4, q: V2): V2 =>
      vec2(s.x.add(q.x).div(size), s.y.sub(q.y).div(tall).oneMinus()) as V2
    const half = vec2(0.5).div(u.size)
    const maskOf = (s: V4): F =>
      ctx.mask(
        vec2(s.z.div(u.size.x), s.w.div(u.size.y).oneMinus()).clamp(half, vec2(1).sub(half)) as V2,
      )

    // The tiles: a box per letter, marched to the first ink, so the walls are the letters' own.
    const corner = positionGeometry as unknown as V3
    const local = vec3(
      corner.x.mul(dims.x.mul(2)),
      corner.y.mul(dims.y.mul(2)),
      corner.z.mul(dims.z),
    ) as V3
    const placed = place.xyz.add(rotate(turn, local)) as V3
    const world = modelWorldMatrix.mul(vec4(placed, 1)).xyz
    const vLocal = varying(local) as V3
    const vRay = varying(unrotate(turn, world.sub(cameraPosition) as V3)) as V3
    const vFace = varying(normalGeometry) as V3
    const vDims = varying(dims) as V4
    const vSpot = varying(spot) as V4
    const vLit = varying(place.w) as F
    const vLight = varying(unrotate(turn, light as V3)) as V3
    const read = (q: V2, level: F): V4 => texture(ink, uvOf(vSpot, q), level) as unknown as V4
    const inkA = (q: V2, level: F): F => read(q, level).a as unknown as F
    const norm = AMBIENT + (1 - AMBIENT) * L0[2]
    const tileColor = Fn(() => {
      const point = vLocal
      const ray = normalize(vRay).toVar()
      const toLight = normalize(vLight)
      const halfWidth = vDims.x
      const halfHeight = vDims.y
      const halfThick = vDims.z.mul(0.5)
      // The mip level before any loop: derivatives need uniform flow.
      const lod = max(
        log2(max(max(fwidth(point.x), fwidth(point.y)).mul(density), 1e-4)).sub(0.5),
        0,
      ).toVar()
      const safe = (c: F): F => select(abs(c).lessThan(1e-5), float(1e-5), c) as F
      const dx = safe(ray.x)
      const dy = safe(ray.y)
      const dz = safe(ray.z)
      const exitX = select(dx.greaterThan(0), halfWidth, halfWidth.negate()).sub(point.x).div(dx)
      const exitY = select(dy.greaterThan(0), halfHeight, halfHeight.negate()).sub(point.y).div(dy)
      const exitZ = select(dz.greaterThan(0), halfThick, halfThick.negate()).sub(point.z).div(dz)
      const exit = max(min(min(exitX, exitY), exitZ), 0).toVar()
      const hit = float(-1).toVar()
      const peak = float(0).toVar()
      const lastA = float(0).toVar()
      const lastT = float(0).toVar()
      Loop({ start: int(0), end: int(steps), type: 'int', condition: '<' }, ({ i }) => {
        const t = exit.mul(float(i).div(steps - 1))
        const a = inkA(point.xy.add(ray.xy.mul(t)) as V2, lod)
        peak.assign(max(peak, a))
        If(a.greaterThanEqual(0.5), () => {
          const k = float(0.5)
            .sub(lastA)
            .div(max(a.sub(lastA), 1e-4))
            .clamp(0, 1)
          hit.assign(select(i.greaterThan(int(0)), mix(lastT, t, k), float(0)))
          Break()
        })
        lastA.assign(a)
        lastT.assign(t)
      })
      const deep = hit.greaterThan(1e-3)
      const hitPoint = point.add(ray.mul(max(hit, 0)))
      const texel = read(hitPoint.xy as V2, lod)
      const base = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4)) as never) as V3
      // Faces: front or back, with the bevel from the relief map.
      const bump = (texture(bumps, uvOf(vSpot, point.xy as V2)) as unknown as V4).xy
        .mul(2)
        .sub(1)
        .mul(vLit)
      const faceN = normalize(vec3(bump, select(vFace.z.lessThan(-0.5), -1, 1)))
      // Walls: out of the ink, rounded toward the faces near their edges.
      const soft = lod.add(1)
      const g = vec2(
        inkA(hitPoint.xy.add(vec2(1.5, 0)) as V2, soft).sub(
          inkA(hitPoint.xy.sub(vec2(1.5, 0)) as V2, soft),
        ),
        inkA(hitPoint.xy.add(vec2(0, 1.5)) as V2, soft).sub(
          inkA(hitPoint.xy.sub(vec2(0, 1.5)) as V2, soft),
        ),
      )
      const edge = smoothstep(halfThick.sub(vDims.w.mul(0.04)), halfThick, abs(hitPoint.z)).mul(0.6)
      const wallN = normalize(
        mix(
          vec3(g.negate().add(vec2(1e-5, 0)), 0),
          vec3(0, 0, select(hitPoint.z.greaterThan(0), 1, -1)),
          edge,
        ),
      )
      const normal = select(deep, wallN, faceN) as V3
      const halfway = normalize(toLight.add(ray.negate()))
      const diffuse = max(dot(normal, toLight), 0)
        .mul(1 - AMBIENT)
        .add(AMBIENT)
        .div(norm)
      const shine = pow(max(dot(normal, halfway), 0), 64)
        .mul(0.32)
        .add(max(dot(normal, toLight).sub(L0[2]), 0).mul(0.12))
        .mul(vLit)
      const luma = dot(base, vec3(0.2126, 0.7152, 0.0722))
      const tone = select(deep, base.mul(0.66).add(luma.oneMinus().mul(0.05)), base)
      const rgb = min(tone.mul(diffuse).add(shine), vec3(1))
      return vec4(rgb, select(deep, float(1), peak).mul(maskOf(vSpot)))
    })() as unknown as V4
    const tiles = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    tiles.forceSinglePass = true
    tiles.positionNode = placed
    tiles.colorNode = tileColor

    // The shadows: each face projected along the light onto the page or the floor, whichever
    // the light meets first, softer the farther it falls.
    const shadow = (floor: boolean): MeshBasicNodeMaterial => {
      const q = positionGeometry as unknown as V3
      const face = vec3(q.x.mul(dims.x.mul(2)), q.y.mul(dims.y.mul(2)), dims.z.mul(0.5)) as V3
      const worldPoint = place.xyz.add(rotate(turn, face)) as V3
      const height = floor
        ? max(worldPoint.y.sub(floorY).div(L0[1]), 0)
        : max(worldPoint.z.sub(wallZ).div(L0[2]), 0)
      const at = worldPoint.sub(light.mul(height)) as V3
      const m = new MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      })
      m.positionNode = floor ? vec3(at.x, floorY, at.z) : vec3(at.x, at.y, wallZ)
      const other = varying(floor ? at.z : at.y) as F
      const far = varying(height) as F
      const vUV = varying(uvOf(spot, face.xy as V2)) as V2
      const em = varying(dims.w) as F
      const keep = floor
        ? smoothstep(wallZ.sub(1), wallZ.add(1), other).mul(above)
        : smoothstep(floorY.sub(1), floorY.add(1), other)
      const alpha = (texture(ink, vUV, log2(max(far.mul(0.12).mul(density), 1))) as unknown as V4).a
      m.colorNode = vec4(
        0.02,
        0.02,
        0.035,
        alpha
          .mul(keep)
          .mul(float(1).sub(smoothstep(0, em.mul(5), far)))
          .mul(varying(place.w))
          .mul(SHADE)
          .mul(maskOf(varying(spot) as V4)),
      )
      return m
    }

    const cube = new BoxGeometry(1, 1, 1)
    const quad = {
      position: new BufferAttribute(
        new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]),
        3,
      ),
      index: new BufferAttribute(new Uint16Array([0, 2, 1, 2, 3, 1]), 1),
    }
    ctx.onDispose(() => cube.dispose())
    interface Shape {
      readonly place: InstancedBufferAttribute
      readonly turn: InstancedBufferAttribute
      readonly dims: InstancedBufferAttribute
      readonly spot: InstancedBufferAttribute
      readonly tiles: InstancedBufferGeometry
      readonly shadows: InstancedBufferGeometry
    }
    const shapeOf = (count: number): Shape => {
      const make = (): InstancedBufferAttribute => {
        const buffer = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4)
        buffer.setUsage(DynamicDrawUsage)
        return buffer
      }
      const parts = { place: make(), turn: make(), dims: make(), spot: make() }
      const geometry = (box: boolean): InstancedBufferGeometry => {
        const geometry = new InstancedBufferGeometry()
        if (box) {
          geometry.setIndex(cube.index)
          geometry.setAttribute('position', cube.getAttribute('position'))
          geometry.setAttribute('normal', cube.getAttribute('normal'))
        } else {
          geometry.setIndex(quad.index)
          geometry.setAttribute('position', quad.position)
        }
        geometry.setAttribute(PLACE, parts.place)
        geometry.setAttribute(TURN, parts.turn)
        geometry.setAttribute(DIMS, parts.dims)
        geometry.setAttribute(SPOT, parts.spot)
        geometry.instanceCount = count
        return geometry
      }
      return { ...parts, tiles: geometry(true), shadows: geometry(false) }
    }
    let shape = shapeOf(atlas.pieces.length)
    const tileMesh = new Mesh(shape.tiles, tiles)
    const wallMesh = new Mesh(shape.shadows, shadow(false))
    const floorMesh = new Mesh(shape.shadows, shadow(true))
    for (const m of [tileMesh, wallMesh, floorMesh]) m.frustumCulled = false
    wallMesh.renderOrder = 0
    floorMesh.renderOrder = 0
    tileMesh.renderOrder = 1
    const group = new Group()
    group.add(wallMesh, floorMesh, tileMesh)
    ctx.onDispose(() => {
      shape.tiles.dispose()
      shape.shadows.dispose()
    })
    ctx.place(group, { fit: 'none', replace: true })
    await ctx.compile(group)
    if (signal.aborted) return

    // The bevels are carved when the page is idle, like magnet's.
    let carving: (() => void) | undefined
    const carve = (carved: Atlas): void => {
      carving?.()
      const run = (): void => {
        carving = undefined
        if (signal.aborted || atlas !== carved) return
        const em = carved.pieces.reduce((m, p) => Math.max(m, p.em), 1)
        const old = bumps.value as Texture
        bumps.value = new CanvasTexture(relief(carved, BEVEL * em))
        old.dispose()
        ctx.invalidate()
      }
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 1000 })
        carving = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(run, 50)
        carving = () => clearTimeout(id)
      }
    }
    ctx.onDispose(() => carving?.())
    carve(atlas)

    // The world.
    const random = rng(7)
    const physicsWorld = new World()
    let letters: Letter[] = []
    let boxWidth = 0
    let boxHeight = 0
    const thickness = (p: Piece): number => Math.max(ctx.params.depth, THIN) * p.em
    const build = (built: Atlas): void => {
      const rect = element.getBoundingClientRect()
      boxWidth = rect.width
      boxHeight = rect.height
      const sorted = built.pieces
        .map((p, i) => ({ p, i }))
        .sort((x, y) => x.p.line - y.p.line || x.p.cx - y.p.cx)
      const order = new Map(sorted.map((s, k) => [s.i, k]))
      letters = built.pieces.map((piece, i) => {
        const m = margin(piece.em)
        const box = new Box(
          Math.max(1, (piece.width / 2 - m) * 0.94),
          Math.max(1, piece.height / 2 - m),
          thickness(piece) / 2,
        )
        const letter: Letter = {
          piece,
          box,
          hx: piece.x + piece.width / 2 - boxWidth / 2,
          hy: boxHeight / 2 - piece.y - piece.height / 2,
          order: order.get(i) ?? i,
          mode: 'home',
          wait: 0,
          last: new Float64Array(7),
          from: new Float64Array(7),
          clock: 0,
          lift: 0,
          rise: 0,
          tilt: new Float64Array(6),
          kick: 0,
        }
        home(letter)
        return letter
      })
      physicsWorld.boxes.length = 0
      physicsWorld.boxes.push(...letters.map((l) => l.box))
      physicsWorld.hold = undefined
      measure()
    }
    const home = (letter: Letter): void => {
      const box = letter.box
      box.x = letter.hx
      box.y = letter.hy
      box.z = -box.hz
      box.qx = box.qy = box.qz = 0
      box.qw = 1
      box.halt()
      box.pinned = true
      box.ghost = false
      box.asleep = false
      letter.mode = 'home'
      remember(letter)
    }
    const remember = (letter: Letter): void => {
      const box = letter.box
      letter.last.set([box.x, box.y, box.z, box.qx, box.qy, box.qz, box.qw])
    }
    /**
     * The container's walls in the box frame, never smaller than the heading's letters. Seen in
     * perspective, a tile at the front of the room shows further out than the wall it lies against,
     * so the floor and the sides move in until the room's front edge meets the container on screen.
     */
    const measure = (): void => {
      const e = element.getBoundingClientRect()
      const holderRect = holder.getBoundingClientRect()
      const room = physicsWorld.room
      let deep = 0
      let tallest = 0
      for (const l of letters) {
        deep = Math.max(deep, l.box.hz * 2)
        tallest = Math.max(tallest, l.box.hy * 2)
      }
      room.z0 = -deep - 0.5
      room.z1 = Math.max(tallest * 0.75, deep * 2)
      const cam = render.camera.position
      const eyeZ = cam.z || 1000
      const eyeX = cam.x - (e.left + boxWidth / 2 - stage.width.peek() / 2)
      const eyeY = cam.y - (stage.height.peek() / 2 - e.top - boxHeight / 2)
      const k = Math.max(0, 1 - room.z1 / eyeZ)
      const x0 = holderRect.left - e.left - boxWidth / 2
      const x1 = holderRect.right - e.left - boxWidth / 2
      const y0 = boxHeight / 2 - (holderRect.bottom - e.top)
      room.x0 = Math.max(x0, eyeX + (x0 - eyeX) * k)
      room.x1 = Math.min(x1, eyeX + (x1 - eyeX) * k)
      room.y0 = Math.max(y0, eyeY + (y0 - eyeY) * k)
      room.y1 = boxHeight / 2 - (holderRect.top - e.top)
      for (const l of letters) {
        const box = l.box
        room.x0 = Math.min(room.x0, l.hx - box.hx - 1)
        room.x1 = Math.max(room.x1, l.hx + box.hx + 1)
        room.y0 = Math.min(room.y0, l.hy - box.hy - 1)
        room.y1 = Math.max(room.y1, l.hy + box.hy + 1)
      }
      wallZ.value = room.z0
      floorY.value = room.y0
    }
    build(atlas)

    let dom: boolean | undefined
    let stuck = false
    let quiet = 0
    let acc = 0
    let shown: string | undefined
    const show = (value: boolean): void => {
      if (value === dom) return
      dom = value
      ctx.showDom(value)
    }

    follow(
      ctx,
      ratio,
      () => atlas?.width ?? 0,
      () => dom === true,
      (next) => {
        stuck = !next
        if (!next) return
        const old = shape
        shape = shapeOf(next.pieces.length)
        tileMesh.geometry = shape.tiles
        wallMesh.geometry = floorMesh.geometry = shape.shadows
        old.tiles.dispose()
        old.shadows.dispose()
        const map = inkTexture(next.canvas)
        ;(ink.value as Texture).dispose()
        ink.value = map
        size.value = next.size[0]
        tall.value = next.size[1]
        density.value = next.scale
        atlas = next
        carve(next)
        build(next)
        settled()
      },
    )

    const wake = (): void => {
      quiet = 0
      for (const l of letters) if (l.mode === 'loose') l.box.wake()
      ctx.invalidate()
    }
    /** Lets every letter go, one after another: drop, scatter or stack in. */
    const play = (from?: readonly [number, number]): void => {
      if (stuck) return
      measure()
      const gravity = GRAVITY * Math.max(ctx.params.gravity, 0.25)
      for (const l of letters) {
        if (style === 'stack') {
          if (l.mode !== 'home' && l.mode !== 'wait') continue
          const entering = l.mode === 'wait'
          l.mode = 'wait'
          l.wait = l.order * STACK
          l.box.ghost = true
          const em = l.piece.em
          if (entering) {
            // From above the top of the viewport, or a few letters up.
            const top = (input?.y ?? 0) + boxHeight / 2 - l.hy
            l.lift = Math.min(900, Math.max(em * 3, top + em * 1.5))
            l.rise = 0
          } else {
            l.lift = 0
            l.rise = Math.sqrt(2 * gravity * em * 1.4)
          }
          for (let k = 0; k < 3; k++) {
            l.tilt[k] = (random() - 0.5) * (entering ? 0.9 : 0.4)
            l.tilt[k + 3] = (random() - 0.5) * 3
          }
          continue
        }
        if (l.mode !== 'home') continue
        l.mode = 'wait'
        l.wait = l.order * COLLAPSE + random() * 0.05
        l.kick = style === 'scatter' ? 1 : 0
      }
      origin = from
      wake()
    }
    let origin: readonly [number, number] | undefined
    /** A letter lets go with its push. */
    const release = (letter: Letter): void => {
      const box = letter.box
      box.pinned = false
      box.ghost = false
      box.wake()
      letter.mode = 'loose'
      const scale = Math.min(2, Math.max(0.5, letter.piece.em / 80))
      if (letter.kick === 1) {
        const count = Math.max(1, letters.length)
        const [ox, oy] = origin ?? [
          letters.reduce((m, q) => m + q.hx, 0) / count,
          letters.reduce((m, q) => m + q.hy, 0) / count - letter.piece.em * 0.5,
        ]
        const dx = box.x - ox
        const dy = box.y - oy
        const distance = Math.hypot(dx, dy) || 1
        const speed = (380 + random() * 420) * scale
        const up = (520 + random() * 460) * Math.sqrt(Math.max(ctx.params.gravity, 0.2)) * scale
        box.vx = (dx / distance) * speed
        box.vy = up + (dy / distance) * speed * 0.3
        box.vz = (random() - 0.3) * 520 * scale
        box.wx = (random() - 0.5) * 18
        box.wy = (random() - 0.5) * 12
        box.wz = (random() - 0.5) * 14
      } else {
        box.vx = (random() - 0.5) * 70 * scale
        box.vy = random() * 60 * scale
        box.vz = (40 + random() * 140) * scale
        box.wx = 1.5 + random() * 3.5
        box.wy = (random() - 0.5) * 2
        box.wz = (random() - 0.5) * 3
      }
    }
    /** Every letter off its place flies back to it. */
    const rise = (): void => {
      physicsWorld.hold = undefined
      grab = undefined
      let k = 0
      const off = letters.filter((l) => l.mode !== 'home').sort((a, b) => a.order - b.order)
      for (const l of off) {
        if (l.mode === 'wait' && style !== 'stack') {
          home(l)
          continue
        }
        const placed = pose(l, 1)
        l.from.set(placed)
        l.mode = 'fly'
        l.clock = -k++ * RISE
        l.box.ghost = true
      }
      wake()
    }

    // Triggers.
    let played = false
    let armed = -1
    let away = -1
    let input: { x: number; y: number; width: number; height: number } | undefined
    if (style === 'stack' && (trigger === 'view' || trigger === 'scroll') && !seen) {
      for (const l of letters) {
        l.mode = 'wait'
        l.wait = Number.POSITIVE_INFINITY
        l.box.ghost = true
      }
    }
    const check = (): void => {
      if (stuck || (trigger !== 'view' && trigger !== 'scroll')) return
      const rect = element.getBoundingClientRect()
      const viewport = stage.height.peek()
      if (trigger === 'view') {
        if (played) return
        if (inView(rect.top, rect.height, viewport, VIEW.share)) {
          played = true
          if (style === 'stack') {
            if (letters.some((l) => l.mode === 'wait')) play()
          } else armed = 0
          wake()
        }
        return
      }
      const top = rect.top + (typeof scrollY === 'number' ? scrollY : 0)
      const line = Math.min(viewport * LINE, top - 24)
      const up = letters.every((l) => l.mode === 'home')
      if (style === 'stack') {
        const hidden = letters.some((l) => l.mode === 'wait' && l.wait === Number.POSITIVE_INFINITY)
        if (hidden && rect.top < viewport * 0.8 && rect.bottom > 0) play()
        else if (up && rect.top > viewport) {
          for (const l of letters) {
            l.mode = 'wait'
            l.wait = Number.POSITIVE_INFINITY
            l.box.ghost = true
          }
          ctx.invalidate()
        }
        return
      }
      if (up && rect.top < line) play()
      else if (!up && rect.top > line + viewport * 0.08 && !letters.some((l) => l.mode === 'fly'))
        rise()
    }
    addEventListener('scroll', check, { passive: true, signal })
    addEventListener('resize', check, { passive: true, signal })

    // Clicks: the heading falls, a click on it once fallen stands it up; buttons and events too.
    let swallow = 0
    const toggle = (from?: readonly [number, number]): void => {
      if (letters.every((l) => l.mode === 'home')) play(from)
      else rise()
    }
    if (trigger === 'click') {
      element.addEventListener(
        'click',
        (e) => {
          if (performance.now() - swallow < 400) return
          const mouse = e as MouseEvent
          if (mouse.detail === 0) toggle()
          else {
            const rect = element.getBoundingClientRect()
            toggle([
              mouse.clientX - rect.left - rect.width / 2,
              rect.top + rect.height / 2 - mouse.clientY,
            ])
          }
        },
        { signal },
      )
      element.addEventListener(
        'keydown',
        (e) => {
          const key = (e as KeyboardEvent).key
          if (
            key === 'Enter' &&
            e.target === element &&
            !element.matches('button, (a[href] as number)')
          )
            toggle()
        },
        { signal },
      )
    }
    element.addEventListener('dio:reset', () => rise(), { signal })
    document.addEventListener(
      'click',
      (e) => {
        const button = (e.target as Element | null)?.closest?.('[data-dio-reset]')
        if (!button) return
        const want = button.getAttribute('data-dio-reset')?.trim()
        let mine = !want
        try {
          mine ||= !!want && element.matches(want)
        } catch {}
        if (mine) rise()
      },
      { signal },
    )

    // The pointer: grab a loose letter and throw it; in the hover trigger, knock letters off.
    let rect: DOMRect | undefined
    const rectOf = (): DOMRect => {
      rect ??= element.getBoundingClientRect()
      return rect
    }
    const forget = (): void => {
      rect = undefined
    }
    addEventListener('scroll', forget, { passive: true, signal })
    addEventListener('resize', forget, { passive: true, signal })
    const ray = (clientX: number, clientY: number): [number[], number[]] => {
      const rect = rectOf()
      const viewportWidth = stage.width.peek()
      const viewport = stage.height.peek()
      const cam = render.camera.position
      const middleX = rect.left + rect.width / 2
      const middleY = rect.top + rect.height / 2
      const origin = [
        cam.x - (middleX - viewportWidth / 2),
        cam.y - (viewport / 2 - middleY),
        cam.z || 1000,
      ]
      return [
        origin,
        [
          clientX - middleX - (origin[0] as number),
          middleY - clientY - (origin[1] as number),
          -(origin[2] as number),
        ],
      ]
    }
    /** The letter the ray meets first, among those `which` accepts, and the point in its frame. */
    const pick = (
      o: number[],
      d: number[],
      which: (l: Letter) => boolean,
    ): { letter: Letter; local: number[]; t: number } | undefined => {
      let best: { letter: Letter; local: number[]; t: number } | undefined
      for (const l of letters) {
        if (!which(l)) continue
        const box = l.box
        box.orient()
        const matrix = box.m
        const relX = (o[0] as number) - box.x
        const relY = (o[1] as number) - box.y
        const relZ = (o[2] as number) - box.z
        const localOrigin = [0, 1, 2].map(
          (k) =>
            (matrix[k] as number) * relX +
            (matrix[3 + k] as number) * relY +
            (matrix[6 + k] as number) * relZ,
        )
        const localDir = [0, 1, 2].map(
          (k) =>
            (matrix[k] as number) * (d[0] as number) +
            (matrix[3 + k] as number) * (d[1] as number) +
            (matrix[6 + k] as number) * (d[2] as number),
        )
        const halfSize = [box.hx + 3, box.hy + 3, box.hz + 3]
        let near = 0
        let far = Number.POSITIVE_INFINITY
        for (let k = 0; k < 3; k++) {
          const vk = localDir[k] as number
          const pk = localOrigin[k] as number
          const hk = halfSize[k] as number
          if (Math.abs(vk) < 1e-9) {
            if (Math.abs(pk) > hk) far = -1
            continue
          }
          const enter = (-hk - pk) / vk
          const exit = (hk - pk) / vk
          near = Math.max(near, Math.min(enter, exit))
          far = Math.min(far, Math.max(enter, exit))
        }
        if (far < near || (best && near >= best.t)) continue
        best = {
          letter: l,
          t: near,
          local: localOrigin.map((pk, k) => pk + (localDir[k] as number) * near),
        }
      }
      return best
    }
    let grab: { id: number; z: number; trail: number[][] } | undefined
    let trail: number[][] = []
    const note = (e: PointerEvent): void => {
      trail.push([e.timeStamp, e.clientX, e.clientY])
      while (trail.length > 2 && e.timeStamp - (trail[0]?.[0] as number) > 90) trail.shift()
    }
    /** Pointer velocity over the last moves, px/s, y up. */
    const velocity = (): [number, number] => {
      const first = trail[0]
      const last = trail.at(-1)
      if (!first || !last || last === first) return [0, 0]
      const dt = Math.max(((last[0] as number) - (first[0] as number)) / 1000, 1 / 120)
      return [
        ((last[1] as number) - (first[1] as number)) / dt,
        -((last[2] as number) - (first[2] as number)) / dt,
      ]
    }
    const knock = (letter: Letter): void => {
      if (style === 'stack') {
        letter.mode = 'hop'
        letter.box.ghost = true
        letter.lift = 0
        letter.rise = Math.sqrt(
          2 * GRAVITY * Math.max(ctx.params.gravity, 0.25) * letter.piece.em * 0.8,
        )
        for (let k = 3; k < 6; k++) letter.tilt[k] = (random() - 0.5) * 4
      } else {
        measure()
        const [vx, vy] = velocity()
        letter.kick = style === 'scatter' ? 1 : 0
        origin = undefined
        release(letter)
        const k = Math.max(0, ctx.params.throw) * 0.35
        letter.box.vx += Math.max(-1500, Math.min(1500, vx * k))
        letter.box.vy += Math.max(-600, Math.min(1500, vy * k))
      }
      away = -1
      wake()
    }
    const cursor = holder instanceof HTMLElement ? holder.style.cursor : ''
    const point = (value: string): void => {
      if (holder instanceof HTMLElement && holder.style.cursor !== value)
        holder.style.cursor = value
    }
    ctx.onDispose(() => point(cursor))
    let inside = false
    addEventListener(
      'pointerdown',
      (e) => {
        if (stuck || ctx.params.throw <= 0 || (e.pointerType === 'mouse' && e.button !== 0)) return
        trail = []
        note(e)
        const [origin, direction] = ray(e.clientX, e.clientY)
        if (trigger === 'hover' && e.pointerType === 'touch') {
          const hit = pick(origin, direction, (l) => l.mode === 'home')
          if (hit) knock(hit.letter)
        }
        const hit = pick(origin, direction, (l) => l.mode === 'loose')
        if (!hit) return
        e.preventDefault()
        const letter = hit.letter
        const box = letter.box
        const [localX, localY, localZ] = hit.local as [number, number, number]
        box.orient()
        const matrix = box.m
        const z =
          box.z +
          (matrix[6] as number) * localX +
          (matrix[7] as number) * localY +
          (matrix[8] as number) * localZ
        const targetX =
          box.x +
          (matrix[0] as number) * localX +
          (matrix[1] as number) * localY +
          (matrix[2] as number) * localZ
        const targetY =
          box.y +
          (matrix[3] as number) * localX +
          (matrix[4] as number) * localY +
          (matrix[5] as number) * localZ
        physicsWorld.hold = {
          box,
          lx: localX,
          ly: localY,
          lz: localZ,
          tx: targetX,
          ty: targetY,
          tz: z,
        }
        grab = { id: e.pointerId, z, trail }
        point('grabbing')
        swallow = performance.now()
        wake()
      },
      { passive: false, signal },
    )
    addEventListener(
      'pointermove',
      (e) => {
        note(e)
        const [origin, direction] = ray(e.clientX, e.clientY)
        const hold = physicsWorld.hold
        if (grab && hold && e.pointerId === grab.id) {
          const along = (grab.z - (origin[2] as number)) / ((direction[2] as number) || -1)
          const room = physicsWorld.room
          hold.tx = Math.max(
            room.x0,
            Math.min(room.x1, (origin[0] as number) + (direction[0] as number) * along),
          )
          hold.ty = Math.max(
            room.y0,
            Math.min(room.y1 + 200, (origin[1] as number) + (direction[1] as number) * along),
          )
          wake()
          return
        }
        if (e.pointerType === 'touch') return
        const holderRect = holder.getBoundingClientRect()
        const was = inside
        inside =
          e.clientX >= holderRect.left &&
          e.clientX <= holderRect.right &&
          e.clientY >= holderRect.top &&
          e.clientY <= holderRect.bottom
        if (trigger === 'hover') {
          const hit = pick(origin, direction, (l) => l.mode === 'home')
          if (hit) knock(hit.letter)
          if (was && !inside && letters.some((l) => l.mode !== 'home')) {
            away = 0
            wake()
          }
        }
        if (ctx.params.throw > 0 && letters.some((l) => l.mode === 'loose'))
          point(pick(origin, direction, (l) => l.mode === 'loose') ? 'grab' : cursor)
      },
      { passive: true, signal },
    )
    const drop = (e: PointerEvent): void => {
      if (!grab || e.pointerId !== grab.id) return
      const hold = physicsWorld.hold
      grab = undefined
      physicsWorld.hold = undefined
      point(cursor)
      swallow = performance.now()
      if (hold && e.type === 'pointerup') {
        const [vx, vy] = velocity()
        const k = Math.max(0, ctx.params.throw)
        hold.box.vx = Math.max(-3000, Math.min(3000, vx * k))
        hold.box.vy = Math.max(-3000, Math.min(3000, vy * k))
      }
      wake()
    }
    addEventListener('pointerup', drop, { passive: true, signal })
    addEventListener('pointercancel', drop, { passive: true, signal })
    addEventListener(
      'touchmove',
      (e) => {
        if (grab) e.preventDefault()
      },
      { passive: false, signal },
    )
    document.addEventListener('selectstart', (e) => grab && e.preventDefault(), { signal })
    addEventListener(
      'click',
      (e) => {
        if (
          performance.now() - swallow < 400 &&
          !(e.target as Element | null)?.closest?.('[data-dio-reset]')
        ) {
          e.stopPropagation()
          e.preventDefault()
        }
      },
      { capture: true, signal },
    )
    // The container changes size: new walls, and the letters find their way.
    const resize = new ResizeObserver(() => {
      if (letters.some((l) => l.mode === 'loose')) {
        measure()
        wake()
      }
    })
    resize.observe(holder)
    ctx.onDispose(() => resize.disconnect())

    /** The pose drawn: between the last two steps for loose letters, on its path otherwise. */
    const pose = (letter: Letter, alpha: number): Pose => {
      const box = letter.box
      if (letter.mode === 'loose') {
        const last = letter.last
        const k = alpha
        let qx = box.qx
        let qy = box.qy
        let qz = box.qz
        let qw = box.qw
        const sign =
          (last[3] as number) * qx +
            (last[4] as number) * qy +
            (last[5] as number) * qz +
            (last[6] as number) * qw <
          0
            ? -1
            : 1
        qx = (last[3] as number) * sign + (qx - (last[3] as number) * sign) * k
        qy = (last[4] as number) * sign + (qy - (last[4] as number) * sign) * k
        qz = (last[5] as number) * sign + (qz - (last[5] as number) * sign) * k
        qw = (last[6] as number) * sign + (qw - (last[6] as number) * sign) * k
        const length = Math.hypot(qx, qy, qz, qw) || 1
        return [
          (last[0] as number) + (box.x - (last[0] as number)) * k,
          (last[1] as number) + (box.y - (last[1] as number)) * k,
          (last[2] as number) + (box.z - (last[2] as number)) * k,
          qx / length,
          qy / length,
          qz / length,
          qw / length,
        ]
      }
      const hz = -box.hz
      if (letter.mode === 'fly') {
        const flight = Math.min(1, Math.max(0, letter.clock / FLY))
        const e = ease('cubicInOut', flight)
        const from = letter.from
        const arc = Math.sin(Math.PI * e)
        const em = letter.piece.em
        // Slerp to no turn.
        const w = Math.abs(from[6] as number)
        const sign = (from[6] as number) < 0 ? -1 : 1
        const theta = Math.acos(Math.min(1, w))
        const sinTheta = Math.sin(theta)
        const weightA = sinTheta > 1e-5 ? Math.sin((1 - e) * theta) / sinTheta : 1 - e
        const weightB = sinTheta > 1e-5 ? Math.sin(e * theta) / sinTheta : e
        return [
          (from[0] as number) + (letter.hx - (from[0] as number)) * e,
          (from[1] as number) + (letter.hy - (from[1] as number)) * e + arc * em * 0.5,
          (from[2] as number) + (hz - (from[2] as number)) * e + arc * em * 0.6,
          (from[3] as number) * sign * weightA,
          (from[4] as number) * sign * weightA,
          (from[5] as number) * sign * weightA,
          w * weightA + weightB,
        ]
      }
      if (letter.mode === 'hop' || letter.mode === 'wait') {
        const [ax, ay, az] = letter.tilt as unknown as [number, number, number]
        const cosX = Math.cos(ax / 2)
        const sinX = Math.sin(ax / 2)
        const cosY = Math.cos(ay / 2)
        const sinY = Math.sin(ay / 2)
        const cosZ = Math.cos(az / 2)
        const sinZ = Math.sin(az / 2)
        return [
          letter.hx,
          letter.hy + letter.lift,
          hz + letter.lift * 0.08,
          sinX * cosY * cosZ - cosX * sinY * sinZ,
          cosX * sinY * cosZ + sinX * cosY * sinZ,
          cosX * cosY * sinZ - sinX * sinY * cosZ,
          cosX * cosY * cosZ + sinX * sinY * sinZ,
        ]
      }
      return [letter.hx, letter.hy, hz, 0, 0, 0, 1]
    }

    /** Writes the instances, farthest tile from the camera first. */
    const write = (box: { x: number; y: number; width: number; height: number }): void => {
      const cam = render.camera.position
      const viewportWidth = stage.width.peek()
      const viewport = stage.height.peek()
      const eyeX = cam.x - (box.x + box.width / 2 - viewportWidth / 2)
      const eyeY = cam.y - (viewport / 2 - box.y - box.height / 2)
      const eyeZ = cam.z || 1000
      above.value = eyeY > physicsWorld.room.y0 ? 1 : 0
      const alpha = Math.min(1, acc / STEP)
      const drawn = letters.map((l) => {
        const placed = pose(l, alpha)
        const distanceSquared =
          (placed[0] - eyeX) ** 2 + (placed[1] - eyeY) ** 2 + (placed[2] - eyeZ) ** 2
        return { l, p: placed, d: distanceSquared }
      })
      drawn.sort((a, b) => b.d - a.d)
      const places = shape.place.array as Float32Array
      const turns = shape.turn.array as Float32Array
      const all = shape.dims.array as Float32Array
      const spots = shape.spot.array as Float32Array
      drawn.forEach(({ l, p }, slot) => {
        const q = l.piece
        const em = q.em
        const thick = thickness(q)
        const off = Math.max(
          Math.hypot(p[0] - l.hx, p[1] - l.hy, p[2] + thick / 2) / (em * 0.12),
          (2 * Math.acos(Math.min(1, Math.abs(p[6])))) / 0.15,
        )
        const k = Math.min(1, off)
        const lit = l.mode === 'loose' ? 1 : k * k * (3 - 2 * k)
        const hidden = l.mode === 'wait' && style === 'stack'
        places.set([p[0], p[1], p[2], lit], slot * 4)
        turns.set([p[3], p[4], p[5], p[6]], slot * 4)
        all.set(
          hidden ? [0, 0, 0, em] : [q.width / 2, q.height / 2, ctx.params.depth * em * lit, em],
          slot * 4,
        )
        spots.set([q.u + q.width / 2, q.v + q.height / 2, q.cx, q.base - em * 0.35], slot * 4)
      })
      for (const a of [shape.place, shape.turn, shape.dims, shape.spot]) a.needsUpdate = true
    }

    /** Events and the state attribute: moving, piled, or none once upright. */
    const report = (busy: boolean): void => {
      const up = letters.every(
        (l) => l.mode === 'home' || (l.mode === 'wait' && l.wait === Number.POSITIVE_INFINITY),
      )
      const next = up ? undefined : busy ? 'moving' : 'piled'
      if (next === shown) return
      shown = next
      if (next) element.setAttribute('data-dio-physics', next)
      else element.removeAttribute('data-dio-physics')
      element.dispatchEvent(
        new CustomEvent('dio:physics', { detail: { state: next ?? 'upright' }, bubbles: true }),
      )
    }
    ctx.onDispose(() => element.removeAttribute('data-dio-physics'))
    function settled(): void {
      for (const l of letters) l.mode === 'home' || home(l)
      ctx.invalidate()
    }
    show(!letters.some((l) => l.mode === 'wait'))
    check()

    return (frame): boolean => {
      input = frame
      if (stuck) {
        show(true)
        return false
      }
      const live = ctx.params
      const dt = Math.min(Math.max(frame.delta, 0), 0.1)
      const gravity = GRAVITY * Math.max(live.gravity, 0)
      // Thickness follows the depth.
      for (const l of letters) {
        const halfDepth = thickness(l.piece) / 2
        if (Math.abs(l.box.hz - halfDepth) > 1e-6) {
          l.box.resize(l.box.hx, l.box.hy, halfDepth)
          if (l.mode === 'home') home(l)
          else l.box.wake()
        }
      }
      if (armed >= 0) {
        armed += dt
        if (armed >= VIEW.delay) {
          armed = -1
          play()
        }
      }
      let busy = armed >= 0
      // Releases and flights on the frame clock.
      for (const l of letters) {
        if (l.mode === 'wait' && l.wait !== Number.POSITIVE_INFINITY) {
          l.wait -= dt
          busy = true
          if (l.wait <= 0) {
            if (style === 'stack') l.mode = 'hop'
            else release(l)
          }
        }
        if (l.mode === 'fly') {
          l.clock += dt
          busy = true
          if (l.clock >= FLY) home(l)
        } else if (l.mode === 'hop') {
          busy = true
          const gravity = GRAVITY * Math.max(live.gravity, 0.25)
          l.rise -= gravity * dt
          l.lift += l.rise * dt
          if (l.lift <= 0 && l.rise < 0) {
            l.lift = 0
            const impact = -l.rise
            l.rise = impact * Math.min(Math.max(live.bounce, 0), 0.85)
            const kickk = (impact / Math.max(l.piece.em, 1)) * 0.012
            for (let k = 3; k < 6; k++) l.tilt[k] = (l.tilt[k] as number) + (random() - 0.5) * kickk
            if (l.rise < Math.sqrt(2 * gravity * 0.8)) l.rise = 0
          }
          // The tilts spring back to none.
          let calm = l.lift <= 0 && l.rise === 0
          for (let k = 0; k < 3; k++) {
            let angle = l.tilt[k] as number
            let rate = l.tilt[k + 3] as number
            rate += (-90 * angle - 11 * rate) * dt
            angle += rate * dt
            l.tilt[k] = angle
            l.tilt[k + 3] = rate
            calm &&= Math.abs(angle) < 0.004 && Math.abs(rate) < 0.05
          }
          if (calm) {
            l.tilt.fill(0)
            home(l)
          }
        }
      }
      // The world on its fixed step.
      const loose = letters.some((l) => l.mode === 'loose')
      if (loose) {
        acc += dt
        let steps = Math.floor(acc / STEP)
        if (steps > MAX_STEPS) {
          steps = MAX_STEPS
          acc = steps * STEP
        }
        acc -= steps * STEP
        const matter = {
          gravity: gravity,
          bounce: Math.max(live.bounce, 0),
          friction: Math.max(live.friction, 0),
        }
        let awake = false
        for (let i = 0; i < steps; i++) {
          for (const l of letters) if (l.mode === 'loose') remember(l)
          awake = physicsWorld.step(STEP, matter)
        }
        if (steps === 0) awake = letters.some((l) => l.mode === 'loose' && !l.box.asleep)
        quiet += dt
        if (quiet > QUIET && !grab) {
          for (const l of letters) {
            if (l.mode !== 'loose') continue
            l.box.asleep = true
            l.box.halt()
          }
          awake = false
        }
        if (awake || grab) busy = true
        else {
          acc = 0
          for (const l of letters) if (l.mode === 'loose') remember(l)
        }
      } else acc = 0
      // Hover: back up once the pointer has left and the pile is still.
      if (trigger === 'hover' && !inside && letters.some((l) => l.mode !== 'home')) {
        if (!busy || away >= 0) {
          away = Math.max(away, 0) + dt
          busy = true
          if (away >= AWAY) {
            away = -1
            rise()
          }
        }
      }
      const up = letters.every((l) => l.mode === 'home')
      report(busy)
      write(frame)
      show(up && frame.presence >= 1)
      return busy
    }
  },
})
export default physics
