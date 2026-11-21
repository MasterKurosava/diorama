import type { Anchor } from '@dioramajs/core'
import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { approach, chase } from '@dioramajs/effects/kit'
import { abs, clamp, length, max, mix, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl'
import {
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { type Held, hold, source } from './inspect'
import { framing } from './slots'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V4 = Node<'vec4'>
type Params = {
  mode: ChoiceParam<'inner' | 'lens' | 'side'>
  trigger: ChoiceParam<'hover' | 'click'>
  zoom: number
  radius: number
  ease: number
  full: string
  into: string
  resolution: number
}

/** Time the view takes to appear or leave, s. */
const APPEAR = 0.2
/** Crossfade from the element's own picture to the large one, s. */
const CROSS = 0.2
/** The large picture is let go this long after the pointer left, ms. */
const LINGER = 10_000
/** Share of the lens radius its glass rim takes. */
const RIM = 0.12
/** Reach of the shadow around the lens, px. */
const SHADOW = 10
/** Width of the frame on the image in side mode, px. */
const FRAME = 1.5
/** Pointer travel that still counts as a tap, px. */
const TAP = 10

const unit = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * A sharp magnified view of an image under the pointer: inside its box, in a lens or in another
 * element. Pointer devices only; on touch screens the image stays as it is.
 */
const zoom: Effect<Params> = defineEffect({
  name: 'zoom',
  params: {
    mode: oneOf('inner', 'lens', 'side'),
    trigger: oneOf('hover', 'click'),
    zoom: 2.5,
    radius: 80,
    ease: 0.08,
    full: '',
    into: '',
    resolution: 4096,
  },
  rebuild: ['resolution'],
  media: true,
  when: '(hover: hover) and (pointer: fine)',
  quality: { low: { resolution: 2048 }, medium: { resolution: 3072 } },
  setup(ctx: EffectContext<Params>) {
    const { params, signal, app, u, render } = ctx
    const img = ctx.element as HTMLImageElement
    const mode = params.mode
    // click: a click turns the view on and off, leaving the image turns it off.
    const byClick = params.trigger === 'click'
    const pictures = hold(ctx, params.resolution)
    // The large picture swaps into this slot: the element's own until it comes, no recompile.
    const large = ctx.fit(ctx.map, framing(img))
    // (centre of the view in box UV, y up, kept inside the box for inner and side; active 0..1;
    // large picture shown 0..1).
    const look = uniform(new Vector4(0.5, 0.5, 0, 0))
    const lookNode = look as unknown as V4
    const viewCentre = lookNode.xy
    const active = lookNode.z
    const largeShown = lookNode.w
    const inverseZoom = max(u.zoom, 1).reciprocal()
    /** Box UV `at` of the view whose centre is `centre`, `scale` times the box. */
    const into = (at: V2, centre: V2, scale: V2 | F): V2 => centre.add(at.sub(0.5).mul(scale))
    /** The magnified picture at `at`: the element's own, crossfaded to the large one when in. */
    const view = (at: V2, sample: (uv: V2) => V4): V4 => {
      const own = sample(at)
      return vec4(mix(own.rgb, large.sample(at).rgb, largeShown), own.a)
    }

    let pane: Mesh | undefined
    let box: Anchor | undefined
    // Side mode: the region shown in the pane, as a share of the box per axis.
    const region = uniform(new Vector2(1, 1))
    const regionNode = region as unknown as V2
    if (mode === 'side') {
      const selector = params.into.trim()
      const target = selector ? document.querySelector(selector) : null
      if (!target) {
        app.log.warn(`zoom: side mode needs data-dio-into naming an element, got "${selector}"`)
      } else {
        box = app.anchors.track(target, { live: true })
        ctx.onDispose(() => box?.dispose())
        const own = ctx.fit(ctx.map, framing(img))
        const material = new MeshBasicNodeMaterial({
          transparent: true,
          depthTest: false,
          depthWrite: false,
        })
        const pick = (at: V2): V4 => {
          const color = own.sample(at)
          return vec4(color.rgb, color.a.mul(own.mask(at)))
        }
        const shown = view(into(uv(), viewCentre, regionNode), pick)
        material.colorNode = shown.rgb
        material.opacityNode = shown.a.mul(active, u.opacity)
        pane = new Mesh(new PlaneGeometry(1, 1), material)
        pane.frustumCulled = false
        pane.visible = false
        ctx.overlay.add(pane)
      }
    }

    ctx.surface.color((color, { uv: at, sample }) => {
      if (mode === 'lens') {
        const size = u.size as unknown as V2
        const radius = u.radius
        const distance = length(at.sub(viewCentre).mul(size)) as unknown as F
        // Barrel distortion at the rim: the glass bends the edge of the view outwards.
        const rim = smoothstep(1 - RIM, 1, distance.div(max(radius, 1)))
        const bend = rim.mul(rim).mul(max(u.zoom, 1).sub(1).mul(0.5)).add(1)
        const magnified = viewCentre.add(at.sub(viewCentre).mul(inverseZoom).mul(bend))
        const inside = clamp(radius.sub(distance).add(0.5), 0, 1)
        const shade = smoothstep(radius, radius.add(SHADOW), distance).oneMinus().mul(0.3)
        // A thin bright line just inside the rim.
        const glint = clamp(abs(distance.sub(radius).add(1.5)).oneMinus(), 0, 1).mul(0.35)
        const shown = view(magnified, sample)
        const glass = mix(shown.rgb, vec3(1), glint)
        const outside = color.rgb.mul(shade.mul(active).oneMinus())
        const rgb = mix(outside, glass, inside.mul(active))
        return vec4(rgb, mix(color.a, shown.a, inside.mul(active)))
      }
      if (mode === 'side') {
        // The frame of the region the pane shows, and the rest of the picture a little darker.
        if (!pane) return color
        const size = u.size as unknown as V2
        const corner = abs(at.sub(viewCentre).mul(size)).sub(regionNode.mul(size).mul(0.5))
        const edge = max(corner.x, corner.y) as unknown as F
        const line = clamp(
          abs(edge.add(FRAME / 2))
            .sub(FRAME / 2)
            .oneMinus(),
          0,
          1,
        )
        const dimmed = clamp(edge.add(0.5), 0, 1).mul(0.25)
        const rgb = mix(color.rgb.mul(dimmed.mul(active).oneMinus()), vec3(1), line.mul(active))
        return vec4(rgb, color.a)
      }
      return mix(color, view(into(at, viewCentre, inverseZoom), sample), active)
    })

    // The pointer in client px, its last place over the box and whether the view is wanted.
    let client: { x: number; y: number } | undefined
    let on = false
    const aim = { x: 0.5, y: 0.5 }
    const at = { x: 0.5, y: 0.5 }
    let snap = true
    // How far the view is in, 0..1, and how far the large picture is crossfaded in.
    let shown = 0
    let fade = 0
    let held: Held | undefined
    let waiting: Held | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const url = source(img, params.full)

    /** The large picture back to the element's own: before its texture is freed. */
    const letGo = (): void => {
      timer = undefined
      held = waiting = undefined
      large.set(ctx.map, framing(img))
      fade = 0
      ;(look.value as Vector4).w = 0
      pictures.keep()
      // Out of view the swap changes nothing on screen: no frame for it.
      if (shown > 0) ctx.invalidate()
    }
    const want = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (held || !url || !app.assets) return
      const lease = pictures.get(url, 'high')
      waiting = lease
      void lease.ready.then(() => {
        if (signal.aborted || waiting !== lease) return
        waiting = undefined
        if (!lease.texture) return
        held = lease
        large.set(lease.texture, framing(img))
        ctx.invalidate()
      })
    }
    const show = (x: number, y: number): void => {
      if (!on) snap = true
      on = true
      client = { x, y }
      want()
      ctx.invalidate()
    }
    const hide = (): void => {
      if (!on) return
      on = false
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(letGo, LINGER)
      ctx.invalidate()
    }
    signal.addEventListener('abort', () => clearTimeout(timer))
    // Touch, only with `when: 'all'` from the site: a tap shows or hides the view at its point, a
    // drag moves it where the site keeps pans from the page (touch-action none or pinch-zoom).
    let tap: { x: number; y: number; id: number; drag: boolean } | undefined
    const ownsPan = (): boolean => /none|pinch-zoom/.test(getComputedStyle(img).touchAction || '')
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
    ): void => img.addEventListener(type, handler, { signal })
    listen('pointerenter', (e) => {
      if (e.pointerType !== 'touch' && !byClick) show(e.clientX, e.clientY)
    })
    listen('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (!on || tap?.id !== e.pointerId || !ownsPan()) return
        tap.drag ||= Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= TAP
      } else if (!on) {
        if (!byClick) show(e.clientX, e.clientY)
        return
      }
      client = { x: e.clientX, y: e.clientY }
      ctx.invalidate()
    })
    listen('pointerleave', (e) => {
      if (e.pointerType !== 'touch') hide()
    })
    let press: { x: number; y: number } | undefined
    listen('pointerdown', (e) => {
      if (e.pointerType === 'touch' && e.isPrimary) {
        tap = { x: e.clientX, y: e.clientY, id: e.pointerId, drag: false }
      } else if (byClick && e.button === 0) press = { x: e.clientX, y: e.clientY }
    })
    if (byClick) {
      // A click of a mouse or pen; a touch tap toggles below. A press that moved is a drag.
      listen('pointerup', (e) => {
        const from = press
        press = undefined
        if (e.pointerType === 'touch' || !from || e.button !== 0) return
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) >= TAP) return
        if (on) hide()
        else show(e.clientX, e.clientY)
      })
    }
    listen('pointerup', (e) => {
      if (tap?.id !== e.pointerId) return
      const moved = tap.drag || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= TAP
      tap = undefined
      if (moved) return
      if (on) hide()
      else show(e.clientX, e.clientY)
    })
    listen('pointercancel', () => {
      tap = undefined
    })

    /** Eases the view's centre towards the pointer. Returns whether it is still on its way. */
    const follow = (input: EffectInput): boolean => {
      if (client && input.width && input.height) {
        aim.x = unit((client.x - input.x) / input.width)
        aim.y = 1 - unit((client.y - input.y) / input.height)
      }
      const jump = snap || input.reducedMotion || input.delta <= 0
      snap = false
      // Box UV: within a hundredth of a px of the pointer it lands.
      return chase(
        at,
        aim,
        jump ? 0 : params.ease,
        input.delta,
        0.01 / Math.max(input.width, input.height),
      )
    }

    return (input): boolean => {
      const delta = input.delta
      const reduced = input.reducedMotion
      // A page transition takes the copy as it is: the flight starts without magnification.
      const wanted = on && input.presence >= 1
      const following = follow(input)
      const goal = wanted ? 1 : 0
      shown = reduced || input.presence < 1 ? goal : approach(shown, goal, delta / APPEAR)
      const ready = held ? 1 : 0
      fade = reduced || !shown ? ready : Math.min(ready, fade + delta / CROSS)
      // The view's centre: inner and side keep the magnified region inside the box.
      const zoom = Math.max(1, params.zoom)
      let regionWidth = 1 / zoom
      let regionHeight = 1 / zoom
      if (pane && box) {
        regionWidth = Math.min(1, box.width / zoom / (input.width || 1))
        regionHeight = Math.min(1, box.height / zoom / (input.height || 1))
        ;(region.value as Vector2).set(regionWidth, regionHeight)
      }
      const inside = (centre: number, share: number): number =>
        Math.min(1 - share / 2, Math.max(share / 2, centre))
      const centreX = mode === 'lens' ? at.x : inside(at.x, regionWidth)
      const centreY = mode === 'lens' ? at.y : inside(at.y, regionHeight)
      ;(look.value as Vector4).set(centreX, centreY, shown, fade)
      if (pane && box) {
        const centre = render.toWorld(box.x + box.width / 2, box.y + box.height / 2)
        pane.position.set(centre.x, centre.y, 0)
        pane.scale.set(box.width || 1e-6, box.height || 1e-6, 1)
        pane.visible = shown > 0
      }
      return following || shown !== goal || fade !== ready
    }
  },
})
export default zoom
