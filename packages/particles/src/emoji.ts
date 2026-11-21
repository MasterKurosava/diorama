import type { ChoiceParam, Effect, EffectContext, EffectInput } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { DEV, rng } from '@dioramajs/effects/kit'
import {
  attribute,
  clamp,
  cos,
  exp,
  float,
  floor,
  fract,
  max,
  mix,
  mod,
  positionGeometry,
  sin,
  smoothstep,
  sRGBTransferEOTF,
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
  CanvasTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  Vector2,
} from 'three/webgpu'

type Kind = 'float' | 'burst' | 'rain' | 'fountain'
type Params = {
  trigger: ChoiceParam<'click' | 'view' | 'event' | 'manual' | 'interval'>
  motion: ChoiceParam<Kind>
  emoji: string
  event: string
  fire: number
  once: boolean
  origin: ChoiceParam<'center' | 'pointer'>
  count: number
  scale: number
  speed: number
  spread: number
  sway: number
  spin: number
  duration: number
  interval: number
  seed: number
}
type Point = { x: number; y: number }
/** One emission: from a viewport point or the box, of one glyph or any, `count` at most. */
interface Shot {
  readonly at?: Point
  readonly emoji?: string
  readonly count?: number
}

/** Emoji in the ring every emission writes into: one instanced draw. */
export const POOL = 300
/** Glyphs and pictures in the atlas; the rest of the list is left out. */
export const MAX_GLYPHS = 16
/** Share of a cell the glyph fills: the rest keeps mip levels from bleeding into neighbours. */
const INNER = 0.8
/** Drag never goes below this, so the closed form stays exact in float32. */
const MIN_DRAG = 0.01
/** Floats per emoji in each of the three attributes. */
const ITEM = 4
/** An emission is born one 60 Hz frame back, so its first frame already shows it moving. */
const STEP = 1 / 60
const RAD = Math.PI / 180
/** Size of an emoji at scale 1, px. */
const SIZE = 32
/** Farthest an emoji gets from its box at speed 1, px. */
const REACH = 400
/** Pop-in time, s: a backOut scale from nothing. */
const POP = 0.22
/** Per kind: sway share, rocking in rad, scale at the end of life. */
const STYLE: Record<Kind, { sway: number; rock: number; end: number }> = {
  float: { sway: 1, rock: 0.22, end: 0.75 },
  rain: { sway: 1.4, rock: 0.3, end: 1 },
  burst: { sway: 0.25, rock: 0.08, end: 0.6 },
  fountain: { sway: 0.25, rock: 0.08, end: 0.85 },
}
/** The colour emoji fonts of the common systems, before the element's own font. */
const FONTS = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla"'
/** A grapheme that starts with an emoji or a flag letter. */
const PICTO = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u

/** Elements that emitted already, for `once`: it holds across rebuilds and park. */
const spent = new WeakSet<Element>()
/** Phases with emoji in the air, so the frame policy keeps drawing. */
const flying = new WeakSet<AbortSignal>()

/** A word of the list that names a picture rather than a glyph. */
export const isPicture = (word: string): boolean =>
  /\/|^data:|\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i.test(word)

/**
 * The items of a list: words split on white space, a run of emoji with no spaces split into its
 * emoji, repeats dropped. Pictures (URLs) stay whole, as do words of plain text such as `+1`.
 */
export function glyphs(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  const graphemes = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : undefined
  const out: string[] = []
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue
    const parts =
      graphemes && !isPicture(word) ? [...graphemes.segment(word)].map((s) => s.segment) : [word]
    if (parts.length > 1 && parts.every((p) => PICTO.test(p))) out.push(...parts)
    else out.push(word)
  }
  return [...new Set(out)]
}

/** Decodes a picture of the list; undefined when it does not load. */
function picture(url: string): Promise<HTMLImageElement | undefined> {
  const img = new Image()
  img.decoding = 'async'
  try {
    // A picture from another origin taints the atlas unless the server allows it.
    if (new URL(url, location.href).origin !== location.origin) img.crossOrigin = 'anonymous'
  } catch {}
  img.src = url
  return img.decode().then(
    () => img,
    () => undefined,
  )
}

/** The glyph sheet: square cells in a grid, row 0 at the top. */
interface Sheet {
  readonly canvas: HTMLCanvasElement
  readonly grid: number
  /** The items drawn, in cell order. */
  readonly items: readonly string[]
}

/** Draws every item once into a canvas of `cell` px squares, emoji in the system emoji font. */
function drawSheet(
  element: Element,
  items: readonly string[],
  images: readonly (HTMLImageElement | undefined)[],
  cell: number,
): Sheet | undefined {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return undefined
  const grid = Math.max(1, Math.ceil(Math.sqrt(items.length)))
  canvas.width = canvas.height = grid * cell
  const style = getComputedStyle(element)
  const inner = cell * INNER
  const font = `${Math.round(inner * 0.86)}px ${FONTS}, ${style.fontFamily || 'sans-serif'}`
  items.forEach((item, i) => {
    const centerX = ((i % grid) + 0.5) * cell
    const centerY = (Math.floor(i / grid) + 0.5) * cell
    const image = images[i]
    if (image) {
      const width = image.naturalWidth || 1
      const height = image.naturalHeight || width
      const fit = inner / Math.max(width, height)
      context.drawImage(
        image,
        centerX - (width * fit) / 2,
        centerY - (height * fit) / 2,
        width * fit,
        height * fit,
      )
      return
    }
    context.font = font
    context.fillStyle = style.color || '#000'
    context.textAlign = 'left'
    context.textBaseline = 'alphabetic'
    const metrics = context.measureText(item)
    const left = metrics.actualBoundingBoxLeft || 0
    const right = metrics.actualBoundingBoxRight || metrics.width
    const up = metrics.actualBoundingBoxAscent || inner * 0.7
    const down = metrics.actualBoundingBoxDescent || 0
    // Ink centred in the cell and shrunk to fit it: a long word of text or a wide emoji.
    const fit = Math.min(1, inner / Math.max(left + right, up + down, 1))
    context.save()
    context.translate(centerX, centerY)
    context.scale(fit, fit)
    context.fillText(item, (left - right) / 2, (up - down) / 2)
    context.restore()
  })
  return { canvas, grid, items }
}

/**
 * Emoji, symbols or the site's own small pictures that float up from a reaction button, burst out
 * of a success state, shoot up as a fountain or rain over a section. The list is drawn once into
 * an atlas and every emoji is an instance of one draw. The element keeps its click, the drawing
 * is canvas only, and under reduced motion nothing loads.
 */
const emoji: Effect<Params> = defineEffect({
  name: 'emoji',
  params: {
    trigger: oneOf('click', 'view', 'event', 'manual', 'interval'),
    motion: oneOf('float', 'burst', 'rain', 'fountain'),
    emoji: '❤️',
    event: '',
    fire: 0,
    once: false,
    origin: oneOf('center', 'pointer'),
    count: 8,
    scale: 1,
    speed: 1,
    spread: 40,
    sway: 12,
    spin: 1,
    duration: 2.4,
    interval: 1.5,
    seed: 1,
  },
  rebuild: ['seed'],
  reducedMotion: 'off',
  // The layer counts as visible while the element is anywhere near: emoji outlive a scroll.
  bleed: 100000,
  quality: { low: { count: 12 }, medium: { count: 24 } },
  animate: (ctx) => flying.has(ctx.signal),
  async setup(ctx: EffectContext<Params>) {
    const { params, signal, render, u, app, element } = ctx
    const { trigger, origin } = params
    const motion = params.motion as Kind
    const motionStyle = STYLE[motion]
    const random = rng(params.seed)

    // The atlas: drawn once, at the size the setup sees, in device pixels.
    let items = glyphs(params.emoji)
    if (items.length > MAX_GLYPHS) {
      if (DEV)
        app.log.warn(`emoji: ${items.length} items, the first ${MAX_GLYPHS} are drawn`, element)
      items = items.slice(0, MAX_GLYPHS)
    }
    const loaded = await Promise.all(
      items.map((item) => (isPicture(item) ? picture(item) : undefined)),
    )
    if (signal.aborted) return
    const missing = items.filter((item, i) => isPicture(item) && !loaded[i])
    if (missing.length && DEV) app.log.warn(`emoji: ${missing.join(', ')} did not load`, element)
    const kept = items.flatMap((item, i) => (isPicture(item) && !loaded[i] ? [] : [i]))
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1)
    // A power of two between 128 and 256 px, a little over the drawn size.
    const cell = Math.min(
      256,
      Math.max(128, 2 ** Math.ceil(Math.log2(SIZE * params.scale * ratio * 1.25))),
    )
    const sheet = kept.length
      ? drawSheet(
          element,
          kept.map((i) => items[i] as string),
          kept.map((i) => loaded[i]),
          cell,
        )
      : undefined
    const cells = sheet?.items.length ?? 0
    const grid = sheet?.grid ?? 1
    const atlas = new CanvasTexture(sheet?.canvas ?? document.createElement('canvas'))
    // Premultiplied, so mip levels and filtering do not darken the edges.
    atlas.premultiplyAlpha = true
    ctx.onDispose(() => atlas.dispose())

    // Per emoji, three vec4 attributes.
    // start: x0, y0 in world px, birth, life.
    // fly: vx, vy in px/s, drag, gravity.
    // form: atlas cell, scale, phase, spin.
    const start = new Float32Array(POOL * ITEM)
    const fly = new Float32Array(POOL * ITEM)
    const form = new Float32Array(POOL * ITEM)
    // Unborn slots: born far in the past, long dead.
    for (let i = 0; i < POOL; i++) start[i * ITEM + 2] = -1e6
    const quad = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))
    geometry.setAttribute('uv', quad.getAttribute('uv'))
    quad.dispose()
    // Names clear of WGSL keywords.
    const buffers = (
      [
        ['emojiStart', start],
        ['emojiFly', fly],
        ['emojiForm', form],
      ] as const
    ).map(([name, data]) => {
      const buffer = new InstancedBufferAttribute(data, ITEM).setUsage(DynamicDrawUsage)
      geometry.setAttribute(name, buffer)
      return buffer
    })
    geometry.instanceCount = 1

    // The vertex: a launch under gravity and linear drag in closed form (a negative gravity
    // floats), p = p0 + v0·f + g·(t − f)/k with f = (1 − e^(−kt))/k, a sideways sway, a rock or
    // a spin that slows with the flight, a pop-in and the page's movement since the emoji left.
    const time = uniform(0)
    const drift = uniform(new Vector2())
    const startData = attribute('emojiStart', 'vec4')
    const flyData = attribute('emojiFly', 'vec4')
    const formData = attribute('emojiForm', 'vec4')
    const age = time.sub(startData.z)
    const t = max(age, 0)
    const life = startData.w
    const dragRate = max(flyData.z, MIN_DRAG)
    const travel = exp(dragRate.mul(t).negate()).oneMinus().div(dragRate)
    const phase = formData.z
    const sway = sin(t.mul(1.9).add(phase)).mul(
      u.sway,
      fract(phase.mul(2.9)).mul(0.6).add(0.7),
      smoothstep(0, 0.6, t),
      motionStyle.sway,
    )
    const x = startData.x.add(flyData.x.mul(travel)).add(sway).add(drift.x)
    const y = startData.y
      .add(flyData.y.mul(travel))
      .sub(flyData.w.mul(t.sub(travel)).div(dragRate))
      .add(drift.y)
    const angle = u.spin.mul(
      formData.w
        .mul(travel)
        .add(sin(t.mul(2.1).add(phase.mul(1.7))).mul(motionStyle.rock))
        .add(fract(phase.mul(1.3)).sub(0.5).mul(0.35)),
    )
    // backOut easing: a little past full size, then back.
    const popLeft = clamp(t.div(POP), 0, 1).sub(1)
    const pop = popLeft.mul(popLeft).mul(popLeft.mul(2.70158).add(1.70158)).add(1)
    const ending = smoothstep(life.mul(0.7), life, age)
    const alive = step(0, age).mul(step(age, life))
    const size = u.scale
      .mul(SIZE / INNER)
      .mul(formData.y, pop, mix(float(1), motionStyle.end, ending), alive)
    const corner = positionGeometry.xy.mul(size)
    const cosine = cos(angle)
    const sine = sin(angle)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    material.positionNode = vec3(
      x.add(corner.x.mul(cosine)).sub(corner.y.mul(sine)),
      y.add(corner.x.mul(sine)).add(corner.y.mul(cosine)),
      0,
    )
    // Gone over the last 30 % of its life; a page leaving takes it along.
    const fade = varying(ending.oneMinus().mul(u.presence)) as unknown as Node<'float'>
    // The fragment: the item's cell of the atlas, un-premultiplied to linear.
    const index = formData.x as unknown as Node<'float'>
    const cellUv = uv()
      .add(vec2(mod(index, grid), float(grid - 1).sub(floor(index.div(grid)))))
      .div(grid)
    const texel = texture(atlas, cellUv)
    const rgb = sRGBTransferEOTF(texel.rgb.div(max(texel.a, 1e-4))) as Node<'vec3'>
    material.colorNode = vec4(rgb, texel.a.mul(fade))

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    ctx.overlay.add(mesh)
    // Compiled now, so the first emoji do not wait for the pipeline.
    await ctx.compile(mesh)
    mesh.visible = false
    if (signal.aborted) return

    let now = 0
    let cursor = 0
    let used = 0
    /** Latest death of an emoji written: frames run until then. */
    let last = Number.NEGATIVE_INFINITY
    let fired = params.fire
    /** The box's position at the first frame, for the page's movement since. */
    let anchor: Point | undefined
    const pending: Shot[] = []
    const worldPoint = { x: 0, y: 0 }

    /** Asks for an emission. */
    const fire = (shot: Shot = {}): void => {
      if (params.once && spent.has(element)) return
      spent.add(element)
      pending.push(shot)
      // Flying from now: a site that hides or swaps the element in the same click keeps them.
      flying.add(signal)
      ctx.invalidate()
    }
    /** Where the pointer is, when it is on the page and the origin follows it. */
    const pointer = (): Point | undefined => {
      const state = app.pointer.state
      return origin === 'pointer' && state.inside ? { x: state.x, y: state.y } : undefined
    }
    const on = (type: string, fn: (e: Event) => void): void =>
      element.addEventListener(type, fn, { signal, passive: true })

    // On screen, for `interval`: emission pauses while the element is away.
    let showing = typeof IntersectionObserver !== 'function'
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (wait: number): void => {
      clearTimeout(timer)
      timer = setTimeout(beat, wait * 1000)
    }
    const beat = (): void => {
      timer = undefined
      const every = params.interval
      if (signal.aborted || !showing || !element.isConnected || !(every > 0)) return
      // A hidden tab draws nothing: one emission waits, not a pile of them.
      if (!pending.length && document.visibilityState !== 'hidden') fire({ at: pointer() })
      schedule(every)
    }
    /** Starts the beat when it is due and stopped. */
    const resume = (): void => {
      if (trigger === 'interval' && showing && !timer && params.interval > 0 && element.isConnected)
        schedule(params.interval * 0.25)
    }
    ctx.onDispose(() => clearTimeout(timer))

    if (trigger === 'click') {
      // Passive and never cancelled: the like still counts, the form still submits.
      on('click', (e) => {
        const click = e as MouseEvent
        // A keyboard click has no position.
        const pointed = click.detail > 0 || click.clientX !== 0 || click.clientY !== 0
        fire({
          at: origin === 'pointer' && pointed ? { x: click.clientX, y: click.clientY } : undefined,
        })
      })
    } else if (trigger === 'event') {
      const name = params.event.trim()
      if (name)
        on(name, (e) => {
          const detail = (e as CustomEvent).detail as Shot | null | undefined
          const shot = detail && typeof detail === 'object' ? detail : {}
          fire({ emoji: shot.emoji, count: shot.count, at: pointer() })
        })
      else if (DEV)
        app.log.warn('EFFECT_PARAM: emoji with data-dio-trigger="event" needs data-dio-event')
    } else if (trigger === 'view' || trigger === 'interval') {
      // `view`: the first time half the box is in view, or it fills half the viewport's height.
      const seen = (entry: IntersectionObserverEntry): boolean => {
        const root = entry.rootBounds
        return (
          entry.isIntersecting &&
          (entry.intersectionRatio >= 0.5 ||
            (!!root && entry.intersectionRect.height >= 0.5 * root.height))
        )
      }
      if (typeof IntersectionObserver === 'function') {
        const observer = new IntersectionObserver(
          (entries) => {
            if (trigger === 'view') {
              if (!entries.some(seen)) return
              observer.disconnect()
              fire()
              return
            }
            showing = entries[entries.length - 1]?.isIntersecting ?? showing
            if (showing) resume()
            else {
              clearTimeout(timer)
              timer = undefined
            }
          },
          { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5] },
        )
        observer.observe(element)
        ctx.onDispose(() => observer.disconnect())
      } else if (trigger === 'view') fire()
      resume()
    }

    /** Writes one emission into the ring. */
    const emit = (shot: Shot, box: EffectInput): void => {
      const wanted = Math.max(0, Math.round(params.count))
      const n = Math.min(POOL, shot.count === undefined ? wanted : Math.min(wanted, shot.count))
      if (!cells || !(n > 0)) return
      const pick = shot.emoji === undefined ? -1 : (sheet?.items.indexOf(shot.emoji) ?? -1)
      const vw = app.stage.width.peek()
      const vh = app.stage.height.peek()
      const speed = Math.max(0, params.speed)
      const spread = Math.min(360, Math.max(0, params.spread))
      const span = Math.max(0.2, params.duration)
      const birth = now - STEP
      const gap = Math.max(4, SIZE * params.scale)
      // From the top middle of the box, or from the pointer.
      const top = (): Point =>
        shot.at
          ? { x: shot.at.x + (random() - 0.5) * 8, y: shot.at.y }
          : {
              x: box.x + box.width * (0.5 + (random() - 0.5) * 0.4),
              y: box.y + Math.min(box.height / 2, gap * 0.25),
            }
      // Rain falls through the box's part of the viewport, over its width.
      const left = Math.min(vw, Math.max(0, box.x))
      const right = Math.min(vw, Math.max(0, box.x + box.width))
      // Popping in at the top edge, half out of the box.
      const sky = Math.max(box.y, 0) - gap * 0.2
      const ground = Math.min(box.y + box.height, vh) + gap * 0.6
      const wide = right - left >= gap ? [left, right - left] : [0, vw]
      const deep = ground - sky >= gap * 2 ? ground : vh + gap
      const shower = trigger === 'interval' ? Math.max(0.1, params.interval) : span * 0.6
      let latest = Number.NEGATIVE_INFINITY
      for (let j = 0; j < n; j++) {
        const slot = cursor
        cursor = (cursor + 1) % POOL
        used = Math.max(used, slot + 1)
        const offset = slot * ITEM
        const life = span * (0.8 + 0.4 * random())
        let from: Point
        let aim: number
        let pace: number
        let drag: number
        let gravity: number
        let turn: number
        let scale: number
        let born = birth
        if (motion === 'float') {
          from = top()
          aim = 90 + (random() - 0.5) * spread
          pace = 170 * (0.75 + 0.5 * random())
          drag = 1.1
          gravity = -80
          turn = (random() - 0.5) * 0.6
          scale = 0.8 + 0.4 * random()
          born += j * Math.min(0.1, 0.8 / n)
        } else if (motion === 'burst') {
          from = shot.at
            ? { x: shot.at.x, y: shot.at.y }
            : {
                x: box.x + box.width * (0.5 + (random() - 0.5) / 3),
                y: box.y + box.height * (0.5 + (random() - 0.5) / 3),
              }
          aim = (j / n + random() * 0.25) * 360
          pace = 560 * (0.5 + 0.6 * random())
          drag = 3.4
          gravity = 260
          turn = (random() < 0.5 ? -1 : 1) * (2 + 3 * random())
          scale = 0.7 + 0.5 * random()
          born += random() * 0.03
        } else if (motion === 'fountain') {
          from = top()
          aim = 90 + ((random() + random()) / 2 - 0.5) * spread
          pace = 900 * (0.8 + 0.3 * random())
          drag = 0.4
          gravity = 1700
          turn = (random() < 0.5 ? -1 : 1) * (1 + 3 * random())
          scale = 0.75 + 0.45 * random()
          born += j * Math.min(0.04, 0.6 / n)
        } else {
          const y = sky - random() * gap * 0.4
          from = { x: (wide[0] as number) + random() * (wide[1] as number), y }
          aim = 270 + (random() - 0.5) * 12
          pace = (deep - y) / (life * 0.9)
          drag = MIN_DRAG
          gravity = 0
          turn = (random() - 0.5) * 1.2
          scale = 0.6 + 0.6 * random()
          born += random() * shower
        }
        // Stored relative to the page's movement so far: the drift uniform adds it back.
        const world = render.toWorld(from.x, from.y, worldPoint)
        start[offset] = world.x - drift.value.x
        start[offset + 1] = world.y - drift.value.y
        start[offset + 2] = born
        start[offset + 3] = life
        fly[offset] = Math.cos(aim * RAD) * pace * speed
        fly[offset + 1] = Math.sin(aim * RAD) * pace * speed
        fly[offset + 2] = drag
        fly[offset + 3] = gravity * speed
        form[offset] = pick >= 0 ? pick : Math.floor(random() * cells)
        form[offset + 1] = scale
        form[offset + 2] = random() * Math.PI * 2
        form[offset + 3] = turn
        latest = Math.max(latest, born + life)
      }
      last = Math.max(last, latest)
      for (const buffer of buffers) buffer.needsUpdate = true
      geometry.instanceCount = used
    }

    return (input) => {
      // `fire`: every increase is an emission; a decrease only moves the mark.
      if (trigger === 'manual' && params.fire !== fired) {
        if (params.fire > fired) fire({ at: pointer() })
        fired = params.fire
      }
      // Emoji ride with the page: the box's movement since setup, in world px (y up).
      anchor ??= { x: input.x, y: input.y }
      drift.value.set(input.x - anchor.x, anchor.y - input.y)
      if (now < last) now += input.delta
      for (const shot of pending.splice(0)) emit(shot, input)
      resume()
      // Scrolled far off screen: the emoji ride with the box, so none of them shows any more.
      const far = REACH * Math.max(1, params.speed) + SIZE * params.scale
      const vw = app.stage.width.peek()
      const vh = app.stage.height.peek()
      if (
        input.y > vh + far ||
        input.y + input.height < -far ||
        input.x > vw + far ||
        input.x + input.width < -far
      )
        last = Math.min(last, now)
      time.value = now
      const live = now < last
      mesh.visible = live
      if (live) flying.add(signal)
      else flying.delete(signal)
    }
  },
})
export default emoji
