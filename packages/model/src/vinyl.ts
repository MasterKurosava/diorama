// A record in its sleeve made from a cover image: the disc slides out and spins on hover, in view
// or while a player plays.
import type { ChoiceParam, ColorParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import {
  abs,
  atan,
  clamp,
  cos,
  float,
  fract,
  fwidth,
  length,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  normalLocal,
  pow,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  Group,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type Texture,
} from 'three/webgpu'
import { slab } from './shapes'
import { metal, printed } from './sheen'
import { dissolve, edgeColor, isUrl, Pointer, sharpen, shadow as softShadow } from './studio'

export type Style = 'black' | 'color' | 'picture' | 'cd'
export type Trigger = 'hover' | 'view' | 'play'
type Params = {
  style: ChoiceParam<Style>
  trigger: ChoiceParam<Trigger>
  for: string
  label: string
  color: ColorParam
  out: number
  rpm: number
  tilt: number
  shadow: number
}
type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>

const TAU = Math.PI * 2
const DEG = Math.PI / 180
/** Diameter of the disc in sleeve heights: a 12 in record in a 12⅜ in sleeve. */
export const DISC = 0.96
/** Thickness of the sleeve and the disc, in sleeve heights. */
const SLEEVE = 0.014
const THICK = 0.003
/** Radii as shares of the disc's radius: label, spindle hole; a CD's hole and clear hub. */
const LABEL = 0.335
const HOLE = 0.024
const CD_HOLE = 0.125
const CD_HUB = 0.36
/** Seconds the slide and the spin-up take. */
const SLIDE = 0.35
const SPIN_UP = 0.5
/** Where the record's sheen lies, radians from +x: from the upper left to the lower right. */
const SHEEN = 2.3

/** Frames a second each phase asks for: full rate while it slides, fewer while it only spins. */
const rates = new WeakMap<AbortSignal, number>()
/** Frame rate of a record that only spins. */
const STEADY = 30
/** Frame rate while anything else moves. */
const FULL = 60
/** Phase of the groove pattern from the centre to the rim, radians: about 380 grooves. */
const GROOVES = 2400
/** Radii of the smooth gaps between tracks, as shares of the disc's radius. */
const TRACK_GAPS = [0.48, 0.6, 0.71, 0.81, 0.9]
/** The longest step of one frame, s, so a frame after a stall does not jump. */
const MAX_STEP = 0.1
/** Half-life of the lean toward the pointer, s. */
const TILT_HALF_LIFE = 0.12
/** Below this a motion counts as settled. */
const EPSILON = 1e-4
/** The spin reaches its speed once within this many radians per second. */
const RATE_STOP = 0.02

/** An error the runtime reports with its code, like its own EffectError. */
function fault(code: 'EFFECT_TARGET' | 'EFFECT_PARAM', message: string, element: Element): Error {
  return Object.assign(new Error(`${code}: vinyl ${message}`), {
    name: 'EffectError',
    code,
    effect: 'vinyl',
    element,
  })
}

/** The player: `for`, else the closest audio or video before the element in its parent. */
export function player(element: Element, selector: string): HTMLMediaElement {
  let found: Element | null | undefined = null
  if (selector) {
    try {
      found = document.querySelector(selector)
    } catch {
      throw fault('EFFECT_PARAM', `data-dio-for "${selector}" is not a selector`, element)
    }
  } else {
    for (
      let sibling = element.previousElementSibling;
      sibling && !found;
      sibling = sibling.previousElementSibling
    )
      found = sibling.matches('audio, video')
        ? sibling
        : [...sibling.querySelectorAll('audio, video')].pop()
    found ??= element.parentElement?.querySelector('audio, video')
  }
  if (found?.localName !== 'audio' && found?.localName !== 'video') {
    const where = selector ? `"${selector}"` : 'next to it'
    throw fault(
      'EFFECT_TARGET',
      `trigger "play" found no <audio> or <video> ${where}: name the player with data-dio-for`,
      element,
    )
  }
  return found as HTMLMediaElement
}

/** Hue 0..1 to a saturated colour. */
const hue = (h: F): V3 =>
  clamp(
    abs(
      fract(vec3(h, h.add(2 / 3), h.add(1 / 3)))
        .mul(6)
        .sub(3),
    ).sub(1),
    0,
    1,
  ) as unknown as V3

/**
 * A record in its sleeve: the cover image is the sleeve, and on hover, in view or while a
 * player plays, the disc slides out of it and spins.
 */
const vinyl: Effect<Params> = defineEffect({
  name: 'vinyl',
  params: {
    style: oneOf('black', 'color', 'picture', 'cd'),
    trigger: oneOf('hover', 'view', 'play'),
    for: '',
    label: '',
    color: Object.freeze({ '~kind': 'color', value: '#c8323c' }) as ColorParam,
    out: 0.55,
    rpm: 33,
    tilt: 6.9,
    shadow: 0.5,
  },
  rebuild: ['for', 'label'],
  media: true,
  bleed: 240,
  presence: 'custom',
  animate: { fps: (ctx) => rates.get(ctx.signal) ?? 0 },
  quality: {},
  async setup(ctx: EffectContext<Params>) {
    const { u, signal, element, params } = ctx
    const el = element as HTMLElement
    const style = params.style
    const trigger = params.trigger
    const media = trigger === 'play' ? player(element, params.for) : undefined
    const mask = dissolve(u)
    sharpen(ctx.map, ctx.render.renderer)

    let labelMap: Texture | undefined
    if (params.label && isUrl(params.label)) {
      try {
        labelMap = await ctx.texture(params.label)
      } catch (error) {
        if (signal.aborted) throw error
        ctx.app.log.warn(`vinyl: ${params.label} did not load, the cover shows instead`, error)
      }
    }
    const css = params.label && !isUrl(params.label) ? cssColor(params.label, element) : undefined
    const labelColor = css ? new Color().setStyle(css) : undefined

    const flat = (colour: Node, cut?: Node<'bool'>): Material => {
      const material = new MeshBasicNodeMaterial()
      material.colorNode = colour as Node<'vec4'>
      material.maskNode = cut ? mask.and(cut) : mask
      return material
    }
    const world = (local: Node): V3 =>
      normalize(modelWorldMatrix.mul(vec4(local as V3, 0)).xyz) as unknown as V3

    // The sleeve: the cover in front, as the page shows it, and paper of its edge colour.
    const n = world(normalLocal)
    const cover = texture(ctx.map, clamp(ctx.coverUV(uv()), 0, 1))
    const paper = (edgeColor(ctx.map.image, 'right') ?? new Color(0x2b2b2e)).multiplyScalar(0.85)
    const front = flat(vec4(printed(cover.rgb as unknown as V3, n, 0.06), 1))
    const behind = flat(vec4(printed(vec3(paper.r, paper.g, paper.b) as unknown as V3, n), 1))

    // The disc, in its own UV: `centred` from its centre, `r` 0..1 to its rim.
    const spin = uniform(0)
    const centred = uv().sub(0.5).mul(2) as unknown as V2
    const r = length(centred) as unknown as F
    // The angle in the page, not on the disc: the sheen stays put while the record turns.
    const angle = atan(centred.y, centred.x).add(spin as unknown as F) as unknown as F
    /** Brightness of the sheen's band across the disc, narrower as `sharp` grows. */
    const wedge = (sharp: number): F => pow(abs(cos(angle.sub(SHEEN))), sharp) as unknown as F
    const cd = style === 'cd'
    // The label's picture; a picture disc prints it over the whole disc.
    const labelSample = ((): V3 => {
      const q = centred.div(style === 'picture' ? 2 : 2 * LABEL).add(0.5) as unknown as V2
      if (labelColor) return vec3(labelColor.r, labelColor.g, labelColor.b) as unknown as V3
      if (labelMap) return ctx.fit(labelMap, { fit: 'cover' }).sample(q).rgb as unknown as V3
      return texture(ctx.map, clamp(ctx.coverUV(q), 0, 1)).rgb as unknown as V3
    })()
    let surface: V3
    if (cd) {
      // Silver data side with the rainbow of its tracks along the sheen, a clear hub.
      const silver = metal(vec3(0.82, 0.83, 0.86) as unknown as V3, n, 0.15)
      const rainbow = hue(fract(r.mul(1.7).add(angle.div(Math.PI)))).mul(wedge(6).mul(0.7))
      const data = silver.add(rainbow.mul(smoothstep(CD_HUB, CD_HUB + 0.04, r)))
      const hub = vec3(0.78, 0.8, 0.83).mul(mix(float(0.85), float(1), wedge(2)))
      surface = mix(hub, data, smoothstep(CD_HUB - 0.01, CD_HUB, r)) as unknown as V3
    } else {
      // Grooves: a fine ring texture, smooth gaps between the tracks, a shine across them.
      // Faded to their average where a pixel spans a groove, so they never shimmer.
      const phase = r.mul(GROOVES)
      const fine = clamp(float(1).sub(fwidth(phase).div(Math.PI)), 0, 1)
      const grooves = sin(phase).mul(fine).mul(0.5).add(0.5)
      let gaps = float(0) as unknown as F
      for (const at of TRACK_GAPS)
        gaps = max(gaps, smoothstep(0.006, 0.0, abs(r.sub(at)))) as unknown as F
      const smooth = max(gaps, smoothstep(0.975, 0.985, r)) as unknown as F
      const shine = wedge(28)
        .mul(mix(grooves.mul(0.6).add(0.4), float(1), smooth))
        .mul(0.55)
        .add(wedge(3).mul(0.05))
      let base: V3
      if (style === 'color') base = (u.color as unknown as V3).mul(0.62) as unknown as V3
      else if (style === 'picture') base = printed(labelSample, n, 0) as unknown as V3
      else base = vec3(0.02, 0.02, 0.025) as unknown as V3
      const tint =
        style === 'black'
          ? vec3(1)
          : mix(vec3(1), u.color as unknown as V3, style === 'color' ? 0.5 : 0)
      const disc = base.add(tint.mul(shine.mul(style === 'picture' ? 0.4 : 1)))
      const label = printed(labelSample, n, 0.08)
      // A dark run-out ring around the label, the label itself on a picture disc too.
      const runout = smoothstep(LABEL, LABEL + 0.012, r)
      surface = (style === 'picture' ? disc : mix(label, disc, runout)) as unknown as V3
    }
    const hole = r.greaterThan(cd ? CD_HOLE : HOLE) as unknown as Node<'bool'>
    const record = flat(vec4(surface, 1), hole)
    const rim =
      style === 'color'
        ? (u.color as unknown as V3).mul(0.5)
        : cd
          ? vec3(0.7, 0.72, 0.75)
          : vec3(0.03, 0.03, 0.035)
    const edge = flat(vec4(printed(rim as unknown as V3, n, 0.3), 1))
    const materials = [front, behind, record, edge]
    ctx.onDispose(() => {
      for (const material of materials) material.dispose()
    })

    const root = new Group()
    const pivot = new Group()
    root.add(pivot)
    // The record sits in the sleeve, between its front and its back, and slides out to the right.
    const slider = new Group()
    slider.position.z = -SLEEVE / 2
    const disc = new Mesh(slab(DISC, DISC, THICK, DISC / 2, THICK / 3, 40, 2), [
      record,
      record,
      edge,
    ])
    slider.add(disc)
    pivot.add(slider)
    let sleeve: Mesh | undefined
    let aspect = 0
    const build = (sleeveAspect: number): void => {
      if (sleeve) {
        pivot.remove(sleeve)
        sleeve.geometry.dispose()
      }
      aspect = sleeveAspect
      sleeve = new Mesh(slab(sleeveAspect, 1, SLEEVE, 0.004, 0.002, 4, 2), [front, behind, behind])
      sleeve.position.z = -SLEEVE / 2
      pivot.add(sleeve)
    }
    const aspectOf = (): number => {
      const { width, height } = ctx.input
      if (width > 0 && height > 0) return width / height
      const img = element as HTMLImageElement
      return (img.naturalWidth || 1) / (img.naturalHeight || 1)
    }
    build(aspectOf())
    ctx.place(root, { fit: 'none', replace: true })
    const shade = softShadow(u)
    const under = softShadow(u)
    ctx.place(shade.mesh, { fit: 'none' })
    ctx.place(under.mesh, { fit: 'none' })
    await ctx.compile(root)
    if (signal.aborted) return

    // What brings the record out: the pointer or focus, a click held, the viewport, the player.
    const pointer = new Pointer(element, signal, () => ctx.invalidate(), true)
    const hoverable = matchMedia('(hover: hover)').matches
    let held = false
    let seen = false
    const listen = (target: EventTarget, type: string, fn: (e: Event) => void): void =>
      target.addEventListener(type, fn, { signal })
    const playing = (): boolean => !!media && !media.paused && !media.ended
    if (media)
      for (const type of ['play', 'playing', 'pause', 'ended', 'emptied'])
        listen(media, type, () => ctx.invalidate())
    const toggle = (): void => {
      if (media) {
        if (media.paused || media.ended) void media.play()?.catch?.(() => {})
        else media.pause()
      } else if (trigger === 'hover') held = !held
      ctx.invalidate()
    }
    listen(el, 'click', () => {
      if (!el.closest('a[href], button')) toggle()
    })
    listen(el, 'keydown', (e) => {
      const key = (e as KeyboardEvent).key
      if (!el.hasAttribute('tabindex') || (key !== 'Enter' && key !== ' ')) return
      if (trigger === 'view') return
      e.preventDefault()
      toggle()
    })

    // How far out, as a share of the diameter: `out` itself once it settles.
    let slide = 0
    let rate = 0
    let turned = 0
    let tiltX = 0
    let tiltY = 0
    return (now) => {
      const p = ctx.params
      const reduced = now.reducedMotion
      const dt = Math.min(now.delta, MAX_STEP)
      const boxAspect = now.width > 0 && now.height > 0 ? now.width / now.height : aspect
      if (Math.abs(boxAspect - aspect) > aspect * 0.01) build(boxAspect)
      // Hover brings the record out under reduced motion too, at once; only the lean is motion.
      const aim = hoverable ? pointer.aim(now) : undefined
      const near = aim !== undefined || pointer.focused
      const out = Math.max(0, Math.min(1, p.out))
      const sound = playing()
      if (trigger === 'view' && now.visible && now.progress > 0.15 && now.progress < 0.85)
        seen = true
      let goal = 0
      if (trigger === 'play') goal = sound ? out : near ? out * 0.3 : 0
      else if (trigger === 'view') goal = seen ? out : 0
      else goal = held || near ? out : 0
      const settle = (value: number, target: number, halfLife: number): number => {
        if (reduced) return target
        return damp(value, target, halfLife, dt, EPSILON)
      }
      if (slide !== goal) slide = settle(slide, goal, SLIDE / 3)
      // It turns while it is out, or while its player plays.
      const turning = !reduced && p.rpm > 0 && (trigger === 'play' ? sound : slide > 0.02)
      const want = turning ? (p.rpm / 60) * TAU : 0
      if (rate !== want) {
        rate = reduced ? want : damp(rate, want, SPIN_UP / 3, dt, RATE_STOP)
      }
      if (rate) turned = (turned - rate * dt) % TAU
      const lean = aim && !reduced && p.tilt > 0
      const aimX = lean ? aim[0] * p.tilt * DEG : 0
      const aimY = lean ? -aim[1] * p.tilt * DEG : 0
      if (tiltX !== aimX) tiltX = settle(tiltX, aimX, TILT_HALF_LIFE)
      if (tiltY !== aimY) tiltY = settle(tiltY, aimY, TILT_HALF_LIFE)

      slider.position.x = slide * DISC
      disc.rotation.z = turned
      spin.value = turned
      pivot.rotation.set(tiltY, tiltX, 0)
      const s = now.height || 1
      root.scale.setScalar(s * (0.96 + 0.04 * now.presence))
      // The shadows under the sleeve and, round, under the disc as it comes out.
      const density = Math.max(0, Math.min(1, p.shadow))
      shade.set(aspect * s * 0.94, s * 0.94, 0.01 * s, 0, -0.015 * s, 0.05 * s, density)
      const discSize = DISC * s * 0.94
      under.set(
        discSize,
        discSize,
        discSize / 2,
        slide * DISC * s,
        -0.015 * s,
        0.05 * s,
        slide > 0.02 ? density : 0,
      )
      const busy = slide !== goal || rate !== want || tiltX !== aimX || tiltY !== aimY
      rates.set(signal, busy ? FULL : rate ? STEADY : 0)
      if (slide > 0) ctx.pose(ctx.layer, { above: 1 }, Math.min(1, slide * 4))
    }
  },
})
export default vinyl
