// Shared by the effects that show the pictures of other elements (gallery, hover-preview): two
// `ctx.fit` slots that crossfade, and a window of texture leases that lets pictures go once out
// of reach, so a long strip or list does not grow memory.
import type { EffectContext, Fit, FitOptions } from '@dioramajs/effects'
import { mix, vec4 } from 'three/tsl'
import type { Node, Texture } from 'three/webgpu'

type V2 = Node<'vec2'>

/** The part of `@dioramajs/assets` the window leases pictures from. */
interface Assets {
  load(
    url: string,
    options: { type: 'texture'; priority?: 'high' | 'normal'; crossOrigin?: string },
  ): { readonly ready: Promise<unknown>; release(): void }
}

/** A picture leased from `@dioramajs/assets`. */
export interface Lease {
  /** Set once the picture is in. */
  readonly texture?: Texture
  /** Set when it failed to load. */
  readonly failed?: boolean
  /** Settles when the picture is in or failed, never rejects. */
  readonly ready: Promise<void>
}

/** A lease as the window keeps it. */
interface Held {
  texture?: Texture
  failed?: boolean
  ready: Promise<void>
  release(): void
}

/** Leases by key, held while in the window and released when they leave it or the phase ends. */
export interface Leases<K> {
  /** The lease of `key`, started now if it is not held. */
  get(key: K, priority?: 'high' | 'normal'): Lease
  /** The lease of `key` if it is held. */
  peek(key: K): Lease | undefined
  /** Holds these, the first one at high priority, and releases every other. */
  keep(...wanted: K[]): void
}

/**
 * A window of texture leases. `source` gives the picture of a key: an `<img>` (its current
 * source, `use-credentials` if it asks for it) or a URL. Unlike `ctx.texture`, whose lease lives
 * as long as the phase, a picture is released as soon as it leaves the window.
 */
export function leases<K>(
  ctx: Pick<EffectContext, 'name' | 'app' | 'signal' | 'onDispose'>,
  source: (key: K) => HTMLImageElement | string,
): Leases<K> {
  const assets = (ctx.app as unknown as { assets?: Assets }).assets
  if (!assets) throw new Error(`${ctx.name} needs the assets plugin`)
  const held = new Map<K, Held>()
  const get = (key: K, priority: 'high' | 'normal' = 'normal'): Lease => {
    const known = held.get(key)
    if (known) return known
    const picture = source(key)
    const url = typeof picture === 'string' ? picture : picture.currentSrc || picture.src
    const credentials = typeof picture !== 'string' && picture.crossOrigin === 'use-credentials'
    const loading = assets.load(url, {
      type: 'texture',
      priority,
      ...(credentials ? { crossOrigin: 'use-credentials' } : {}),
    })
    const entry: Held = {
      release: loading.release,
      ready: loading.ready.then(
        (texture) => {
          entry.texture = texture as Texture
        },
        (error) => {
          entry.failed = true
          if (!ctx.signal.aborted && held.get(key) === entry) {
            ctx.app.log.warn(`${ctx.name}: ${url} did not load, it is skipped`, error)
          }
        },
      ),
    }
    held.set(key, entry)
    return entry
  }
  ctx.onDispose(() => {
    for (const entry of held.values()) entry.release()
    held.clear()
  })
  return {
    get,
    peek: (key) => held.get(key),
    keep(...wanted) {
      for (const [key, entry] of held) {
        if (wanted.includes(key)) continue
        entry.release()
        held.delete(key)
      }
      for (const [i, key] of wanted.entries()) get(key, i ? 'normal' : 'high')
    },
  }
}

const KEYWORDS: Readonly<Record<string, number>> = {
  left: 0,
  top: 0,
  center: 0.5,
  right: 1,
  bottom: 1,
}
/** One value of `object-position` as a share of the free space: a keyword or a percentage. */
const axis = (token = 'center'): number =>
  token in KEYWORDS
    ? (KEYWORDS[token] as number)
    : token.endsWith('%')
      ? parseFloat(token) / 100
      : 0.5

/** An element's own object-fit and object-position, so its picture is framed as it is styled. */
export function framing(el: Element): FitOptions {
  const style = getComputedStyle(el)
  const fit = style.objectFit
  const [x, y] = (style.objectPosition || '').split(/\s+/).filter(Boolean)
  return {
    fit:
      fit === 'cover' || fit === 'contain' || fit === 'none' || fit === 'scale-down' ? fit : 'fill',
    position: [axis(x), axis(y)],
  }
}

/** Save-Data or a 2G connection: fewer and smaller pictures. */
export const frugal = (): boolean => {
  const connection = (
    navigator as { connection?: { readonly saveData?: boolean; readonly effectiveType?: string } }
  ).connection
  return Boolean(connection?.saveData || connection?.effectiveType?.endsWith('2g'))
}

/** Two framed pictures: `a` is shown, `b` comes in. Swapping pictures never recompiles. */
export interface Slots {
  readonly a: Fit
  readonly b: Fit
  /** A slot's picture at box UV, transparent outside it (contain bands). */
  pick(slot: Fit, at: V2): Node<'vec4'>
  /** The crossfade from `a` to `b` at box UV by `t`. */
  fade(at: V2, t: Node<'float'>): Node<'vec4'>
  /** Shows one picture in both slots: the change is done. */
  show(texture: Texture, options?: FitOptions): void
  /** Puts the incoming picture in `b`. */
  next(texture: Texture, options?: FitOptions): void
}

/** Two `ctx.fit` slots, both on `texture` to begin with. */
export function slots(
  ctx: Pick<EffectContext, 'fit'>,
  texture: Texture,
  options?: FitOptions,
): Slots {
  const a = ctx.fit(texture, options)
  const b = ctx.fit(texture, options)
  const pick = (slot: Fit, at: V2): Node<'vec4'> => {
    const color = slot.sample(at)
    return vec4(color.rgb, color.a.mul(slot.mask(at)))
  }
  return {
    a,
    b,
    pick,
    fade: (at, t) => mix(pick(a, at), pick(b, at), t),
    show(texture, options) {
      a.set(texture, options)
      b.set(texture, options)
    },
    next: (texture, options) => b.set(texture, options),
  }
}
