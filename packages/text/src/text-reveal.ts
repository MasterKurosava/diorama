import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, entering, inView } from '@dioramajs/effects/kit'
import {
  attribute,
  cos,
  exp2,
  float,
  fwidth,
  max,
  min,
  positionGeometry,
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

type Motion = 'rise' | 'mask' | 'fade' | 'pop' | 'type'
type Params = {
  by: ChoiceParam<'letter' | 'word' | 'line'>
  trigger: ChoiceParam<'view' | 'scroll'>
  motion: ChoiceParam<Motion>
  duration: number
  stagger: number
  delay: number
  rise: number
  tilt: number
  blur: number
  threshold: number
}

// Attribute names become WGSL and GLSL identifiers: `meta` is a reserved word in WGSL, and no
// keyword of either has a capital letter after the first.
/** Instance attribute: the piece's box in box px, x, y, width, height. */
const BOX = 'unitBox'
/** Instance attribute: the unit's order, the baseline y and the font size. */
const UNIT = 'unitInfo'

/** Milliseconds after a change of the text, its width or the fonts before it is laid out again. */
const RELAYOUT_DELAY = 150
/** Once the text is shown as DOM, the new layout waits for an idle moment, at most this long. */
const IDLE_TIMEOUT = 1000

/**
 * Letters, words or lines come in one after another: rising from below their baseline, sliding
 * up out of their line, fading, popping or typed. Once the last one lands the element is plain
 * DOM text again.
 */
const textReveal: Effect<Params> = defineEffect({
  name: 'text-reveal',
  params: {
    by: oneOf('letter', 'word', 'line'),
    trigger: oneOf('view', 'scroll'),
    motion: oneOf('rise', 'mask', 'fade', 'pop', 'type'),
    duration: 0.9,
    stagger: 0.03,
    delay: 0,
    rise: 0.6,
    tilt: 35,
    blur: 0.5,
    threshold: 0.2,
  },
  on: ':not(img, video, canvas, svg, input, textarea)',
  presence: 'custom',
  reducedMotion: 'off',
  quality: { low: { blur: 0 } },
  async setup(ctx: EffectContext<Params>) {
    const { element, params, app, signal } = ctx
    const { stage } = app
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
    // Text the visitor has seen as DOM stays as it is instead of vanishing to play an intro; until
    // the instance runs that includes text scrolled into view while the engine compiles. Veiled
    // text (the entry's `intro`, an entering page) has not been seen.
    // A scrubbed reveal cannot play before a scroll, so it never counts a veil.
    const veiled = (): boolean =>
      params.trigger !== 'scroll' && element.getAttribute('data-dio-state') === 'entering'
    let seen = onScreen() && !veiled()
    const watch = (): void => {
      if (element.hasAttribute('data-dio-state')) removeEventListener('scroll', watch)
      else seen ||= onScreen()
    }
    if (!seen) addEventListener('scroll', watch, { passive: true, signal })

    const warn = (reason: string): void => {
      if (DEV)
        app.log.warn(`text-reveal: ${reason} cannot be drawn, the text stays as it is`, element)
    }
    // The device px per CSS px of the raster: a tier change rebuilds with the new one.
    const ratio = ctx.quality === 'low' ? 1 : 2
    const reason = unsupported(element) ?? (await fonts(element))
    let layout = reason ? undefined : raster(element, params.by, ratio)
    if (signal.aborted) return
    // The veil gave up waiting while the fonts loaded: the DOM text is on screen by now.
    seen ||= onScreen() && !veiled()
    if (!layout) {
      if (reason) warn(reason)
      ctx.showDom(true)
      return
    }
    const noteCoarser = (drawn: Raster): void => {
      if (DEV && drawn.by !== params.by)
        app.log.warn(`text-reveal: more than 1500 units, animating by ${drawn.by}`, element)
    }
    noteCoarser(layout)

    const { material, map, frame, time, end } = revealMaterial(ctx, layout)
    const mesh = new Mesh(shape(layout), material)
    // The vertices move away from the unit plane the bounds are computed from.
    mesh.frustumCulled = false
    ctx.onDispose(() => (map.value as Texture).dispose())
    // Placed before any showDom, which hides the replace object.
    ctx.place(mesh, { fit: 'none', replace: true })
    // Compiled here, not in its first frame: a heading on the first screen would build there,
    // in one long task.
    await ctx.compile(mesh)
    if (signal.aborted) return
    seen ||= onScreen() && !veiled()

    const use = (next: Raster): void => {
      const old = mesh.geometry
      mesh.geometry = shape(next)
      old.dispose()
      const previous = map.value as Texture
      map.value = atlas(next)
      previous.dispose()
      frame.value.set(...next.frame)
      layout = next
      noteCoarser(next)
    }

    // The DOM shows the text whenever no unit moves: at rest it is real, selectable text.
    let dom = false
    const show = (value: boolean): void => {
      dom = value
      ctx.showDom(value)
    }
    const total = (): number => span(ctx.params, layout?.units ?? 0)
    time.value = seen ? total() : 0
    end.value = total()
    if (seen) show(true)

    // Set while the text has changed to something the canvas cannot draw: it stays DOM until then.
    let stuck: string | undefined
    let playing = false
    // Raster again when the text, its fonts or its width change: before the reveal at once, after
    // it when the page is idle, so a page transition leaves with the current layout.
    const relayout = async (): Promise<void> => {
      const why = await fonts(element)
      if (signal.aborted) return
      if (why && why !== stuck) warn(why)
      stuck = why
      if (why) {
        playing = false
        ctx.invalidate()
        return
      }
      const next = raster(element, params.by, ratio)
      if (!next) return
      use(next)
      end.value = total()
      ctx.invalidate()
    }
    let cancel: (() => void) | undefined
    const run = (): void => {
      cancel = undefined
      void relayout()
    }
    const schedule = (): void => {
      cancel?.()
      if (dom && typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: IDLE_TIMEOUT })
        cancel = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(run, RELAYOUT_DELAY)
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

    // Seconds since the trigger in `view`, -1 before it.
    let elapsed = -1
    return (input): boolean => {
      if (stuck) {
        show(true)
        return playing
      }
      const { y, height, progress, presence } = input
      const live = ctx.params
      const last = total()
      const viewport = stage.height.peek()
      let playhead: number
      if (params.trigger === 'scroll') {
        // From `threshold` of the box in view to the box centred in the viewport, scrubbed.
        const through = entering(progress, height, viewport, live.threshold)
        // Text seen on the first screen stays until scrolling would have shown it anyway.
        if (seen && through < 1) playhead = last
        else {
          seen = false
          playhead = live.delay + through * (last - live.delay)
        }
      } else {
        if (!seen && elapsed < 0) {
          // Counted above the bottom tenth of the viewport, like `reveal`.
          if (inView(y, height, viewport, live.threshold)) {
            elapsed = 0
            playing = true
          }
        } else if (elapsed >= 0 && elapsed < last) elapsed += input.delta
        playhead = seen ? last : Math.max(elapsed, 0)
        if (playhead >= last) playing = false
      }
      time.value = Math.min(playhead, last)
      end.value = last
      show(playhead >= last && presence >= 1)
      return playing
    }
  },
})
export default textReveal

/**
 * The pieces' material: each one moved, faded or clipped by `motion` as its turn comes,
 * coloured from the raster.
 */
function revealMaterial(ctx: EffectContext<Params>, layout: Raster) {
  const { u, params } = ctx
  // Time of the reveal in seconds, and when it is over: the shader eases each unit itself.
  const time = uniform(0)
  const end = uniform(1)
  // The canvas in box px.
  const frame = uniform(new Vector4(...layout.frame))
  const box = attribute(BOX, 'vec4') as unknown as Node<'vec4'>
  const unit = attribute(UNIT, 'vec3') as unknown as Node<'vec3'>
  const order = unit.x
  const baseline = unit.y
  const em = unit.z
  // Leaving runs time back from the end, so the last unit goes first; entering plays it again.
  const now = min(time, u.presence.mul(end))
  const since = now.sub(u.delay).sub(order.mul(u.stagger))
  const progress = since.div(max(u.duration, 1e-3)).clamp(0, 1)
  // expoOut, scaled to land on exactly 1.
  const eased = exp2(progress.mul(-10))
    .oneMinus()
    .div(1 - 2 ** -10)
  const remaining = eased.oneMinus()
  // The corner of the piece at rest in box px, y down; the group sits at the box centre, y up.
  const corner = positionGeometry.xy.add(0.5)
  const restX = box.x.add(corner.x.mul(box.z))
  const restY = box.y.add(corner.y.oneMinus().mul(box.w))
  const half = u.size.mul(0.5)
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const motion = params.motion
  let x = restX.sub(half.x)
  let y = half.y.sub(restY)
  let z: Node<'float'> = float(0)
  let shown: Node<'float'> = eased
  let clip: Node<'float'> = float(1)
  if (motion === 'rise') {
    // Tilted back around the baseline (top away from the viewer) and lowered by `rise` em.
    const above = baseline.sub(restY)
    const angle = u.tilt.mul(remaining).mul(Math.PI / 180)
    y = half.y
      .sub(baseline)
      .add(above.mul(cos(angle)))
      .sub(u.rise.mul(em).mul(remaining))
    z = above.mul(sin(angle)).negate()
  } else if (motion === 'mask') {
    // Slides up out of its own line band, cut at the band's bottom edge.
    const drop = remaining.mul(box.w)
    y = y.sub(drop)
    shown = float(1)
    // 0 at the top of the band and 1 at its bottom, for the moved point.
    const band = varying(restY.add(drop).sub(box.y).div(max(box.w, 1e-3)))
    clip = band
      .oneMinus()
      .div(max(fwidth(band), 1e-4))
      .clamp(0, 1)
  } else if (motion === 'pop') {
    // Grows from the middle of its piece with a slight overshoot (backOut).
    const back = progress.sub(1)
    const scale = back.mul(back).mul(back.mul(2.70158).add(1.70158)).add(1)
    const centreX = box.x.add(box.z.mul(0.5))
    const centreY = box.y.add(box.w.mul(0.5))
    x = centreX.add(restX.sub(centreX).mul(scale)).sub(half.x)
    y = half.y.sub(centreY.add(restY.sub(centreY).mul(scale)))
    shown = progress.mul(3).clamp(0, 1)
  } else if (motion === 'type') {
    shown = select(since.greaterThan(0), 1, 0) as unknown as Node<'float'>
  }
  material.positionNode = vec3(x, y, z)
  const atlasUV = varying(
    vec2(restX.sub(frame.x).div(frame.z), restY.sub(frame.y).div(frame.w).oneMinus()),
  )
  const boxUV = varying(vec2(restX.div(u.size.x), restY.div(u.size.y).oneMinus()))
  const opacity = varying(shown)
  const map = texture(atlas(layout), atlasUV)
  // Blur adds to the automatic level, so a 2x raster does not alias on a 1x screen.
  const blurred = motion === 'rise' || motion === 'fade'
  const texel = blurred ? map.bias(u.blur.mul(opacity.oneMinus()).mul(4)) : map
  const rgb = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as Node<'vec3'>
  // Masked at the clamped point: ink past the box (descenders under a tight line-height,
  // overhangs) is not cut, the clip of an ancestor and the opacity still apply.
  material.colorNode = vec4(
    rgb,
    texel.a
      .mul(opacity)
      .mul(clip)
      .mul(ctx.mask(boxUV.clamp(0, 1))),
  )
  return { material, map, frame, time, end }
}

/** Seconds from the trigger until the last unit has landed; a typed unit lands at once. */
function span(
  timing: {
    readonly duration: number
    readonly stagger: number
    readonly delay: number
    readonly motion: Motion
  },
  units: number,
): number {
  return (
    timing.delay +
    Math.max(0, units - 1) * timing.stagger +
    (timing.motion === 'type' ? 1e-3 : Math.max(timing.duration, 1e-3))
  )
}

/** One instance per piece: its box, and its order, baseline and font size. */
function shape(layout: Raster): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  const corners = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3))
  const count = layout.quads.length
  const box = new Float32Array(Math.max(1, count) * 4)
  const unit = new Float32Array(Math.max(1, count) * 3)
  layout.quads.forEach((q, i) => {
    box.set([q.x, q.y, q.width, q.height], i * 4)
    unit.set([q.order, q.base, q.em], i * 3)
  })
  geometry.setAttribute(BOX, new InstancedBufferAttribute(box, 4))
  geometry.setAttribute(UNIT, new InstancedBufferAttribute(unit, 3))
  geometry.instanceCount = count
  return geometry
}

/** The raster as a texture: premultiplied, so mip levels and filtering do not darken edges. */
function atlas(layout: Raster): CanvasTexture {
  const map = new CanvasTexture(layout.canvas)
  map.premultiplyAlpha = true
  return map
}
