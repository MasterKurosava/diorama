import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, entering, inView } from '@dioramajs/effects/kit'
import {
  attribute,
  cos,
  float,
  max,
  positionGeometry,
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
  CanvasTexture,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
  Vector4,
} from 'three/webgpu'
import { fonts, type Raster, raster, unsupported } from './raster'

type Trigger = 'view' | 'loop' | 'hover' | 'scroll'
type Axis = 'y' | 'rotate' | 'scale' | 'flip'
type Params = {
  trigger: ChoiceParam<Trigger>
  axis: ChoiceParam<Axis>
  amplitude: number
  wavelength: number
  speed: number
  duration: number
  stagger: number
  delay: number
  threshold: number
  fps: number
}

/** Frame rate of each loop while it moves, else 0; a pulse asks for its frames itself. */
const pacing = new WeakMap<AbortSignal, () => number>()

/** Seconds the loop takes to swell from flat text to its full amplitude. */
const SWELL = 0.8
/** Milliseconds after a change of the text, its width or the fonts before it is laid out again. */
const RELAYOUT_DELAY = 150
/** Longest frame step the loop takes, s: a stalled tab does not jump the wave. */
const MAX_STEP = 0.1

// Instance attributes: the letter's box, and its turn, baseline, font size and centre x.
const BOX = 'waveBox'
const UNIT = 'waveUnit'

/**
 * The letters of a heading ride a wave: one pulse passes through them when the text comes into
 * view, on hover or with the scroll, or they float on an endless wave. The DOM text stays as it
 * is; between pulses it is what shows.
 */
const wave: Effect<Params> = defineEffect({
  name: 'wave',
  params: {
    trigger: oneOf('view', 'loop', 'hover', 'scroll'),
    axis: oneOf('y', 'rotate', 'scale', 'flip'),
    amplitude: 0.25,
    wavelength: 6,
    speed: 0.5,
    duration: 0.7,
    stagger: 0.04,
    delay: 0,
    threshold: 0.2,
    fps: 30,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  reducedMotion: 'off',
  quality: { low: { fps: 24 } },
  animate: { fps: (ctx) => pacing.get(ctx.signal)?.() ?? 0 },
  async setup(ctx: EffectContext<Params>) {
    const { element, params, app, signal } = ctx
    const { stage } = app
    const trigger = params.trigger
    const warn = (reason: string): void => {
      if (DEV) app.log.warn(`wave: ${reason} cannot be drawn, the text stays as it is`, element)
    }
    const ratio = ctx.quality === 'low' ? 1 : 2
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, 'letter', ratio)
    if (signal.aborted) return
    if (!layout) {
      if (reason) warn(reason)
      ctx.showDom(true)
      return
    }

    const { material, map, frame, time, phase, swell } = letterMaterial(ctx, layout)
    const mesh = new Mesh(shape(layout), material)
    mesh.frustumCulled = false
    ctx.onDispose(() => (map.value as Texture).dispose())
    ctx.place(mesh, { fit: 'none', replace: true })
    await ctx.compile(mesh)
    if (signal.aborted) return

    const use = (next: Raster): void => {
      const old = mesh.geometry
      mesh.geometry = shape(next)
      old.dispose()
      const previous = map.value as Texture
      map.value = atlas(next)
      previous.dispose()
      frame.value.set(...next.frame)
      layout = next
    }
    // Set while the text has changed to something the canvas cannot draw: it stays DOM until then.
    let stuck: string | undefined
    // Raster again a moment after the text, its width or the loaded fonts change.
    const relayout = async (): Promise<void> => {
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(why)
      stuck = why
      const next = why ? undefined : raster(element, 'letter', ratio)
      if (next) use(next)
      ctx.invalidate()
    }
    let cancel: (() => void) | undefined
    const schedule = (): void => {
      cancel?.()
      const id = setTimeout(() => {
        cancel = undefined
        void relayout()
      }, RELAYOUT_DELAY)
      cancel = () => clearTimeout(id)
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

    // Seconds since the pulse started, -1 when none runs.
    let elapsed = -1
    // The pulse started this frame: it counts no time yet.
    let fresh = false
    let pulsing = false
    let looping = false
    let played = false
    pacing.set(signal, () => (looping ? ctx.params.fps : 0))
    const play = (): void => {
      if (elapsed >= 0) return
      elapsed = 0
      fresh = true
      pulsing = true
      ctx.invalidate()
    }
    if (trigger === 'hover') {
      element.addEventListener(
        'pointerenter',
        (e) => (e as PointerEvent).pointerType !== 'touch' && play(),
        { signal },
      )
      element.addEventListener('focusin', play, { signal })
    }
    ctx.showDom(true)
    return (input) => {
      const live = ctx.params
      if (stuck || live.amplitude === 0) {
        pulsing = false
        looping = false
        elapsed = -1
        ctx.showDom(true)
        return
      }
      const end = span(live, layout?.units ?? 0)
      if (trigger === 'loop') {
        const dt = Math.min(input.delta, MAX_STEP)
        swell.value = Math.min(1, swell.value + dt / SWELL)
        phase.value = (phase.value + live.speed * dt) % 1
        looping = swell.value < 1 || live.speed !== 0
        ctx.showDom(false)
        return
      }
      if (trigger === 'scroll') {
        // From the threshold to the middle of the viewport, the pulse runs from start to end.
        const { height, progress } = input
        const through = entering(progress, height, stage.height.peek(), live.threshold)
        time.value = live.delay + through * (end - live.delay)
        ctx.showDom(through <= 0 || through >= 1)
        return
      }
      if (trigger === 'view' && !played && elapsed < 0) {
        const { y, height } = input
        // Counted above the bottom tenth of the viewport, like `reveal`.
        if (inView(y, height, stage.height.peek(), live.threshold)) {
          played = true
          play()
        }
      }
      if (elapsed >= 0) {
        if (fresh) fresh = false
        else elapsed += input.delta
        if (elapsed >= end) {
          elapsed = -1
          pulsing = false
        }
      }
      time.value = elapsed
      if (pulsing) ctx.invalidate()
      ctx.showDom(elapsed < 0)
    }
  },
})
export default wave

/**
 * The letters' material: each corner moved by the wave along `axis`, coloured from the raster.
 */
function letterMaterial(ctx: EffectContext<Params>, layout: Raster) {
  const { u, params } = ctx
  const trigger = params.trigger
  // Seconds since the pulse started (-1 before it); the loop's phase in waves and its swell.
  const time = uniform(-1)
  const phase = uniform(0)
  const swell = uniform(0)
  const box = attribute(BOX, 'vec4') as unknown as Node<'vec4'>
  const unit = attribute(UNIT, 'vec4') as unknown as Node<'vec4'>
  const order = unit.x
  const baseline = unit.y
  const em = unit.z
  const centreX = unit.w

  // How far this letter is lifted, 0..1 (-1..1 on the loop).
  let lift: Node<'float'>
  if (trigger === 'loop') {
    // The wave travels to the right: a letter `wavelength` em further on is a wave behind.
    const wavesBehind = centreX.div(em).div(max(u.wavelength, 0.1))
    lift = sin(phase.sub(wavesBehind).mul(Math.PI * 2)).mul(swell)
  } else {
    // One hump per letter, its turn `stagger` after the previous one.
    const progress = time
      .sub(u.delay)
      .sub(order.mul(u.stagger))
      .div(max(u.duration, 1e-3))
      .clamp(0, 1)
    const hump = sin(progress.mul(Math.PI))
    lift = hump.mul(hump)
  }
  const amount = lift.mul(u.amplitude)

  // The corner at rest in box px, y down; the mesh sits at the box centre, y up.
  const corner = positionGeometry.xy.add(0.5)
  const restX = box.x.add(corner.x.mul(box.z))
  const restY = box.y.add(corner.y.oneMinus().mul(box.w))
  // The middle of a capital, the pivot of the turns.
  const pivotY = baseline.sub(em.mul(0.35))
  let x: Node<'float'> = restX
  let y: Node<'float'> = restY
  let z: Node<'float'> = float(0)
  const axis = params.axis
  if (axis === 'y') y = restY.sub(amount.mul(em))
  else if (axis === 'rotate') {
    const angle = amount.mul(Math.PI / 2)
    const fromPivotX = restX.sub(centreX)
    const fromPivotY = restY.sub(pivotY)
    x = centreX.add(fromPivotX.mul(cos(angle))).sub(fromPivotY.mul(sin(angle)))
    y = pivotY.add(fromPivotX.mul(sin(angle))).add(fromPivotY.mul(cos(angle)))
  } else if (axis === 'scale') {
    const scale = amount.add(1)
    x = centreX.add(restX.sub(centreX).mul(scale))
    y = baseline.add(restY.sub(baseline).mul(scale))
  } else {
    // Tipped around a horizontal axis through the middle, the top towards the viewer.
    const angle = amount.mul(Math.PI / 2)
    y = pivotY.add(restY.sub(pivotY).mul(cos(angle)))
    z = pivotY.sub(restY).mul(sin(angle))
  }

  const half = u.size.mul(0.5)
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  material.positionNode = vec3(x.sub(half.x), half.y.sub(y), z)
  const frame = uniform(new Vector4(...layout.frame))
  const atlasUV = varying(
    vec2(restX.sub(frame.x).div(frame.z), restY.sub(frame.y).div(frame.w).oneMinus()),
  )
  // Masked where the letter stands in the DOM, so a raised letter is not cut by its own box.
  const boxUV = varying(vec2(restX.div(u.size.x), restY.div(u.size.y).oneMinus()))
  const map = texture(atlas(layout), atlasUV)
  const rgb = sRGBTransferEOTF(map.rgb.div(max(map.a, 1e-4))) as Node<'vec3'>
  material.colorNode = vec4(rgb, map.a.mul(ctx.mask(boxUV.clamp(0, 1))))
  return { material, map, frame, time, phase, swell }
}

/** Seconds from the trigger until the pulse has passed the last letter. */
function span(
  timing: { readonly duration: number; readonly stagger: number; readonly delay: number },
  units: number,
): number {
  return timing.delay + Math.max(0, units - 1) * timing.stagger + Math.max(timing.duration, 1e-3)
}

/** One instance per letter: its box, and its turn, baseline, font size and centre. */
function shape(layout: Raster): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  const count = Math.max(1, layout.quads.length)
  const box = new Float32Array(count * 4)
  const unit = new Float32Array(count * 4)
  layout.quads.forEach((q, i) => {
    box.set([q.x, q.y, q.width, q.height], i * 4)
    unit.set([q.order, q.base, q.em, q.x + q.width / 2], i * 4)
  })
  geometry.setAttribute(BOX, new InstancedBufferAttribute(box, 4))
  geometry.setAttribute(UNIT, new InstancedBufferAttribute(unit, 4))
  geometry.instanceCount = layout.quads.length
  return geometry
}

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
function atlas(layout: Raster): CanvasTexture {
  const map = new CanvasTexture(layout.canvas)
  map.premultiplyAlpha = true
  return map
}
