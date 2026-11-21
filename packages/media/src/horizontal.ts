import type { ChoiceParam, Effect, EffectContext, ParamsOf } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { damp } from '@dioramajs/effects/kit'
import { PI, sin, uniform, vec3 } from 'three/tsl'
import { type Node, type UniformNode, Vector2 } from 'three/webgpu'

type Params = {
  style: ChoiceParam<'bend' | 'skew' | 'wave'>
  strength: number
  stretch: number
  parallax: number
  pace: number
  reverse: boolean
  ease: number
  items: string
}

/** 3000 px/s of sideways motion is speed 1, like `u.velocity`. */
const FULL_SPEED = 3000
/** After the visitor moves the row (swipe, focus, keys) the row leads for this long, ms. */
const LEAD = 200
/** Full-speed displacement of each style: card widths (bend), heights (skew, wave). */
const BEND = 0.12
const SKEW = 0.35
const WAVE = 0.08

/** What a row shares with the copies of its cards. */
interface Row {
  readonly style: 'bend' | 'skew' | 'wave'
  readonly params: Readonly<ParamsOf<Params>>
  /** Signed speed times strength: positive while the row moves left. */
  readonly bend: UniformNode<'float'>
  /** Extra width: speed times stretch. */
  readonly stretch: UniformNode<'float'>
}

const rows = new WeakMap<Element, Row>()

const unit = (value: number): number => Math.min(1, Math.max(0, value))

/** The closest sticky ancestor: the stage the row sits on. */
function stageOf(el: Element): HTMLElement | undefined {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).position === 'sticky') return node
  }
  return undefined
}

/** The speed a row hands its cards: signed bend and stretch, for tests. */
export const speedOf = (row: Element): { bend: number; stretch: number } | undefined => {
  const shared = rows.get(row)
  return shared && { bend: shared.bend.value as number, stretch: shared.stretch.value as number }
}

/**
 * Framing of a card's picture by where the card is: scale and sideways shift (box units). The
 * picture lags the card, shifted against the way it crosses the screen.
 */
export function drift(
  centre: number,
  width: number,
  viewport: number,
  depth: number,
): [number, number] {
  const amount = Math.max(0, depth)
  // -1 as the card enters on the left edge, 1 as it leaves on the right.
  const across = Math.max(
    -1,
    Math.min(1, (centre - viewport / 2) / (viewport / 2 + width / 2 || 1)),
  )
  return [1 + 2 * amount, -across * amount]
}

function rowOf(el: Element): Row | undefined {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const row = rows.get(node)
    if (row) return row
  }
  return undefined
}

/**
 * The copy of one card: bent, skewed or waved and stretched by the speed of its row, its picture
 * drifting inside the card with its place on screen. Attached by `horizontal`, never by markup.
 */
const card: Effect = defineEffect({
  name: 'horizontal-card',
  media: true,
  reducedMotion: 'off',
  bleed: 80,
  quality: {},
  setup(ctx: EffectContext) {
    const row = rowOf(ctx.element)
    if (!row) return
    const { surface, u, app } = ctx
    const { style, params } = row
    // (centre, width) of the card as fractions of the viewport width, for the wave.
    const place = uniform(new Vector2())
    const at = place as unknown as Node<'vec2'>
    if (style !== 'skew') surface.segments(24)
    surface.position((p, uv) => {
      const wide = vec3(p.x.mul(row.stretch.add(1)), p.y, p.z)
      if (style === 'bend') return wide.add(vec3(sin(uv.y.mul(PI)).mul(row.bend).mul(BEND), 0, 0))
      if (style === 'skew') {
        // The top leads and the bottom trails by the same angle on every card.
        const ratio = u.size.y.div(u.size.x.max(1))
        return wide.add(vec3(uv.y.oneMinus().sub(0.5).mul(row.bend).mul(ratio).mul(SKEW), 0, 0))
      }
      // One wave across the viewport that the cards ride through.
      const onScreen = at.x.add(uv.x.sub(0.5).mul(at.y))
      return wide.add(
        vec3(
          0,
          sin(onScreen.mul(Math.PI * 2))
            .mul(row.bend)
            .mul(WAVE),
          0,
        ),
      )
    })
    surface.zoom(1)
    return (input) => {
      const viewportWidth = app.stage.width.peek() || 1
      const centre = input.x + input.width / 2
      ;(place.value as Vector2).set(centre / viewportWidth, input.width / viewportWidth)
      const [scale, shift] = drift(centre, input.width, viewportWidth, params.parallax)
      surface.zoom(scale, shift, 0)
    }
  },
})

/** Where the row travels while its stage is stuck, from the last measure. */
interface Measure {
  /** Sideways distance the row scrolls, px. */
  readonly travel: number
  /** Scroll the stage stays stuck for, px. */
  readonly length: number
  /** The stage's sticky `top` and its unstuck offset in the section, px. */
  readonly top: number
  readonly offset: number
  readonly pace: number
}

/**
 * The horizontal-scroll section: while the page scrolls down through a tall section, the row of
 * cards on its sticky stage slides sideways. The row is a native horizontal scroller the effect
 * drives, so links, focus, keys and swipes keep working; the copies of its pictures bend, skew or
 * ride a wave and stretch with its speed, and settle when it stops.
 */
const horizontal: Effect<Params> = defineEffect({
  name: 'horizontal',
  params: {
    style: oneOf('bend', 'skew', 'wave'),
    strength: 1,
    stretch: 0.15,
    parallax: 0.06,
    pace: 1,
    reverse: false,
    ease: 0.3,
    items: 'img, video',
  },
  reducedMotion: 'off',
  quality: {},
  setup(ctx: EffectContext<Params>) {
    const { params, app, signal } = ctx
    const row = ctx.element as HTMLElement
    const stage = stageOf(row)
    const section = stage?.parentElement ?? undefined
    if (!stage) {
      app.log.warn(
        'horizontal: no sticky stage around the row, it stays a plain scroller (see the docs for the markup)',
        row,
      )
    }
    const shared: Row = {
      style: params.style,
      params,
      bend: uniform(0),
      stretch: uniform(0),
    }
    rows.set(row, shared)
    ctx.onDispose(() => {
      if (rows.get(row) === shared) rows.delete(row)
    })
    ctx.attach(params.items, card)

    // While it runs the effect scrolls the row: no snapping, smooth scrolling or scrollbar in
    // the way. The section takes the height the travel needs. Both come back on dispose.
    const style = row.style
    const { scrollSnapType, scrollBehavior, scrollbarWidth } = style
    style.scrollSnapType = 'none'
    style.scrollBehavior = 'auto'
    style.scrollbarWidth = 'none'
    const height = section?.style.height ?? ''
    ctx.onDispose(() => {
      Object.assign(style, { scrollSnapType, scrollBehavior, scrollbarWidth })
      if (section) section.style.height = height
    })

    let stale = true
    let measured: Measure | undefined
    const restale = (): void => {
      stale = true
      ctx.invalidate()
    }
    if (section && stage && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(restale)
      for (const el of [section, stage, row, ...row.children]) observer.observe(el)
      ctx.onDispose(() => observer.disconnect())
    }
    addEventListener('resize', restale, { signal })

    const measure = (): Measure | undefined => {
      if (!section || !stage) return undefined
      section.style.height = height
      const travel = Math.max(0, row.scrollWidth - row.clientWidth)
      const pace = Math.max(0, params.pace)
      if (pace > 0 && travel > 0) {
        const natural = section.getBoundingClientRect().height
        section.style.height = `${natural + travel * pace}px`
      }
      // The stage's place in the section when it is not stuck.
      const kept = stage.style.position
      stage.style.position = 'relative'
      const offset = stage.getBoundingClientRect().top - section.getBoundingClientRect().top
      stage.style.position = kept
      const box = section.getBoundingClientRect()
      const stageStyle = getComputedStyle(stage)
      const pad = Number.parseFloat(getComputedStyle(section).paddingBottom) || 0
      const length = box.height - offset - stage.getBoundingClientRect().height - pad
      return { travel, length, top: Number.parseFloat(stageStyle.top) || 0, offset, pace }
    }

    // What the effect last wrote, and when the visitor last moved the row by hand.
    let written = Number.NaN
    let led = Number.NEGATIVE_INFINITY
    // Runs before anchors: the copies of the cards are measured where the row is this frame.
    app.system(
      'layout',
      () => {
        if (measured && measured.pace !== Math.max(0, params.pace)) stale = true
        if (stale) {
          stale = false
          measured = measure()
        }
        if (!measured || !section || performance.now() - led < LEAD) return
        const top = section.getBoundingClientRect().top + measured.offset
        const progress =
          measured.length > 0
            ? unit((measured.top - top) / measured.length)
            : top <= measured.top
              ? 1
              : 0
        const goal = (params.reverse ? 1 - progress : progress) * measured.travel
        if (Math.abs(row.scrollLeft - goal) < 0.5) return
        row.scrollLeft = goal
        written = row.scrollLeft
      },
      { name: 'horizontal', before: 'anchors' },
    )

    // A card that takes focus comes fully into view, past the row's padding; the page follows.
    row.addEventListener(
      'focusin',
      (event) => {
        const focused = (event.target as Element).getBoundingClientRect()
        const box = row.getBoundingClientRect()
        const rowStyle = getComputedStyle(row)
        const left = box.left + (Number.parseFloat(rowStyle.paddingLeft) || 0)
        const right = box.right - (Number.parseFloat(rowStyle.paddingRight) || 0)
        if (focused.left < left) row.scrollLeft += focused.left - left
        else if (focused.right > right) {
          row.scrollLeft += Math.min(focused.right - right, focused.left - left)
        }
      },
      { signal },
    )

    // Moved by the visitor: the page scrolls to where the effect would have put the row.
    row.addEventListener(
      'scroll',
      () => {
        ctx.invalidate()
        if (
          !measured ||
          !section ||
          measured.travel <= 0 ||
          Math.abs(row.scrollLeft - written) <= 1.5
        )
          return
        led = performance.now()
        written = row.scrollLeft
        const scrolled = unit(row.scrollLeft / measured.travel)
        const progress = params.reverse ? 1 - scrolled : scrolled
        const top = section.getBoundingClientRect().top + measured.offset
        // From where the stage sticks, also when it has not stuck yet or has let go.
        const by = top - measured.top + progress * measured.length
        if (measured.length > 0 && Math.abs(by) >= 1)
          scrollTo({ top: scrollY + by, behavior: 'instant' })
      },
      { passive: true, signal },
    )

    let last = Number.NaN
    let lag = 0
    return (input): boolean => {
      // Holds the canvas still while the stage is pinned.
      ctx.section()
      const scrollLeft = row.scrollLeft
      const dt = input.delta
      let speed = 0
      // A jump (resize, a new measure) is no motion.
      if (dt > 0 && Math.abs(scrollLeft - last) < row.clientWidth) {
        speed = (scrollLeft - last) / dt / FULL_SPEED
      }
      last = scrollLeft
      speed = Math.max(-2, Math.min(2, speed))
      lag = params.ease > 0 ? damp(lag, speed, params.ease, dt) : speed
      const settling = speed !== 0 || Math.abs(lag) >= 1e-3
      if (!settling) lag = 0
      const amount = Math.max(-1, Math.min(1, lag))
      shared.bend.value = amount * params.strength
      shared.stretch.value = Math.abs(amount) * Math.max(0, params.stretch)
      return settling
    }
  },
})
export default horizontal
