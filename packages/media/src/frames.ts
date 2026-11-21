// Frames of a picture series on the element's copy, shared by `sequence` and `spin`: URL
// templates, coarse to fine loading, a window of decoded frames around the shown one, atlas pages.
import type { EffectContext, Fit, ParamSpec } from '@dioramajs/effects'
import { clamp, mix, texture, uniform, vec4 } from 'three/tsl'
import {
  LinearFilter,
  type Node,
  SRGBColorSpace,
  Texture,
  type TextureNode,
  type UniformNode,
  Vector2,
  Vector4,
} from 'three/webgpu'
import { framing, frugal } from './slots'

/** Params every frames effect has, read by name. */
export interface FrameParams {
  readonly frames: string
  readonly atlas: string
  readonly grid: readonly [number, number]
  readonly count: number | 'auto'
  readonly blend: boolean
  readonly cache: number
  readonly density: number
  readonly resolution: number
}

/** Load priority of `@dioramajs/assets`. */
export type Priority = 'high' | 'normal' | 'low'

/** The part of `@dioramajs/assets` the frames use. */
interface Assets {
  load(
    url: string,
    options: { type: string; priority: Priority },
  ): { readonly ready: Promise<unknown>; release(): void }
  track(work: Promise<unknown>, options: { priority: Priority; weight?: number }): void
}

/** A frame of the `frames` mode: its compressed bytes, then its pixels while in the window. */
interface Frame {
  lease?: { readonly ready: Promise<unknown>; release(): void }
  priority?: Priority
  bytes?: ArrayBuffer
  failed?: boolean
  decoding?: boolean
  /** Ends the frame's share of the assets wave once it is shown, failed or no longer wanted. */
  done?: () => void
  /** Resolve once the bytes are in or failed. */
  waiting?: (() => void)[]
}

/** A picture in the box: its framing, its texture read and the atlas cell it reads. */
interface Slot {
  readonly fit: Fit
  readonly node: TextureNode
  /** Cell offset (xy) and scale (zw) in page UV. Identity for a whole picture. */
  readonly cell: UniformNode<'vec4'>
  /** Half a texel of the cell, so linear filtering never reads the neighbour cell. */
  readonly inset: UniformNode<'vec2'>
  /** The frame shown, the poster's index for the poster. */
  shown: number
  /** The slot's own upload target in the frames mode. */
  texture?: Texture
}

/** How a frames effect loads and keeps its frames. */
export interface FramesOptions {
  /** Strides of the coarse to fine passes after the first frame, the finest (1) last. */
  readonly passes: readonly number[]
  /** Passes with at least this stride load at normal priority and count into the loader's progress. */
  readonly counted: number
  /**
   * Frames per turn when the series goes round (`spin`): windows and nearest frames wrap. A
   * function gets the number of frames.
   */
  readonly period?: number | ((n: number) => number)
}

/** The frames on the element's copy. */
export interface Frames {
  /** Frames in the series. */
  readonly n: number
  /** The frame the `<img>` shows: at rest on it the copy is the DOM. 0 for an atlas. */
  readonly poster: number
  /**
   * Shows frame `from` and `to` mixed in by `amount` (with `blend` always, else only while
   * `amount` is above 0); until a frame is decoded, the nearest ready one. `direction` is the
   * direction of travel, 1 or -1: the window reaches ahead of it.
   */
  show(from: number, to: number, amount: number, direction: number): void
  /** Settles once the bytes of these frames are in or failed; at once for an atlas. */
  loaded(...frames: number[]): Promise<void>
}

/** More frames than this is a typo in a range, not a series. */
export const MAX = 2000
const FLIP: ImageBitmapOptions = { imageOrientation: 'flipY' }
/** Decodes running at once. */
const DECODES = 2

/** An `EFFECT_PARAM` error of the effect. */
export const paramError = (ctx: EffectContext<ParamSpec>, message: string): Error =>
  Object.assign(new Error(`EFFECT_PARAM: ${ctx.name}: ${message}`), {
    name: 'EffectError',
    code: 'EFFECT_PARAM',
    effect: ctx.name,
    element: ctx.element,
  })

/** URLs of a `{0001..0096}` range (zeros as wide as its first number) or of a comma list. */
export function list(ctx: EffectContext<ParamSpec>, source: string, limit: number): string[] {
  const range = /\{(\d+)\.\.(\d+)\}/.exec(source)
  let count: number
  let urlAt: (i: number) => string
  if (range) {
    const [whole, from = '', to = ''] = range
    const first = Number(from)
    const step = Number(to) < first ? -1 : 1
    const head = source.slice(0, range.index).trim()
    const tail = source.slice(range.index + whole.length).trim()
    count = Math.abs(Number(to) - first) + 1
    urlAt = (i) => head + String(first + i * step).padStart(from.length, '0') + tail
  } else {
    const items = source
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    count = items.length
    urlAt = (i) => items[i] as string
  }
  if (limit > 0) count = Math.min(count, limit)
  if (count > MAX) throw paramError(ctx, `${count} frames, at most ${MAX}`)
  return Array.from({ length: count }, (_, i) => urlAt(i))
}

const absolute = (url: string): string => new URL(url, document.baseURI).href
const sizeOf = (picture: Texture): [number, number] => {
  const { width, height } = picture.image as { width: number; height: number }
  return [width, height]
}

/**
 * Builds the frames of `ctx.params` on the element's surface: atlas pages all loaded, or frame
 * files coarse to fine with a decoded window. `undefined` without frames: the poster stays.
 * Needs `media: true` and the assets plugin.
 */
export async function frames<P extends ParamSpec>(
  context: EffectContext<P>,
  options: FramesOptions,
): Promise<Frames | undefined> {
  const ctx = context as unknown as EffectContext<ParamSpec>
  const params = ctx.params as unknown as FrameParams
  const { app, signal, name } = ctx
  const assets = (app as unknown as { assets?: Assets }).assets
  if (!assets) throw new Error(`${name} needs the assets plugin`)
  const el = ctx.element as HTMLImageElement
  const atlas = params.atlas.trim()
  // 0 here: all of the range, or every cell.
  const limit = params.count === 'auto' ? 0 : Math.max(1, Math.round(params.count))
  const urls = list(ctx, atlas || params.frames.trim(), atlas ? 0 : limit)
  if (!urls.length) {
    app.log.warn(`${name}: no frames or atlas, the poster stays`)
    return undefined
  }
  const thin = frugal()
  const density = Math.min(params.density, thin ? 0.25 : 1)
  const resolution = Math.min(params.resolution, thin ? 960 : Number.POSITIVE_INFINITY)
  const map = ctx.map
  const objectFit = framing(el)

  // Atlas pages, all in before the first frame: pages of different sizes are a mistake.
  let pages: Texture[] = []
  let cols = 1
  let rows = 1
  let total = urls.length
  // Frames the cell's size, never sampled: the page is read through the slot's own node.
  let cellSize: Texture | undefined
  if (atlas) {
    pages = (await Promise.all(
      urls.map((url) => {
        const type = /\.ktx2([?#]|$)/i.test(url) ? 'ktx2' : 'texture'
        const lease = assets.load(url, { type, priority: 'normal' })
        ctx.onDispose(() => lease.release())
        return lease.ready
      }),
    )) as Texture[]
    const sizes = new Set(pages.map((page) => `${sizeOf(page)}`))
    if (sizes.size > 1) {
      throw paramError(ctx, `atlas pages differ in size: ${[...sizes].join(', ')}`)
    }
    ;[cols, rows] = params.grid.map((v) => Math.max(1, Math.round(v))) as [number, number]
    total = cols * rows * pages.length
    if (limit) total = Math.min(total, limit)
    const [width, height] = sizeOf(pages[0] as Texture)
    cellSize = new Texture({ width: width / cols, height: height / rows } as never)
  }

  const period = Math.max(
    0,
    Math.round(
      typeof options.period === 'function' ? options.period(total) : (options.period ?? 0),
    ),
  )

  // The poster stands in for its own frame (its URL, else the first): at rest the copy is the
  // DOM, and that frame is never fetched.
  const posterInList = atlas ? -1 : urls.map(absolute).indexOf(absolute(el.currentSrc || el.src))
  const poster = Math.max(0, posterInList)

  // Two slots: `lower` shows frame `from`, `upper` frame `to` mixed over it by `mixAmount`.
  const mixAmount = uniform(0)
  const createSlot = (): Slot => {
    const node = texture(map)
    node.mergeable = false
    return {
      fit: ctx.fit(map, objectFit),
      node,
      cell: uniform(new Vector4(0, 0, 1, 1)) as never,
      inset: uniform(new Vector2()) as never,
      shown: poster,
    }
  }
  const lower = createSlot()
  const upper = createSlot()
  ctx.surface.color((_, { uv, radius }) => {
    const pick = (slot: Slot): Node<'vec4'> => {
      const cell = slot.cell as unknown as Node<'vec4'>
      const inset = slot.inset as unknown as Node<'vec2'>
      const local = clamp(slot.fit.uv(uv), inset, inset.oneMinus()) as Node<'vec2'>
      const color = slot.node.sample(local.mul(cell.zw).add(cell.xy)) as unknown as Node<'vec4'>
      return vec4(color.rgb, color.a.mul(slot.fit.mask(uv)))
    }
    const color = mix(pick(lower), pick(upper), mixAmount)
    return vec4(color.rgb, color.a.mul(radius))
  })

  // The frames mode: compressed bytes of every frame it loads, pixels of a few.
  const files: Frame[] = []
  const decoded = new Map<number, ImageBitmap>()
  const textures: Texture[] = []
  /** The window: frames to keep decoded, in the order they decode. */
  let wanted: number[] = []
  let direction = 1
  let from = poster
  let to = poster
  /** `to` shows too: always with blend, else while a mix is asked for (a spin coasting). */
  let pair = params.blend
  let decodes = 0
  let warned = false
  let firstSize: [number, number] | undefined
  let naturalSize: [number, number] | undefined
  /** Frame `frame` of the turn `near` is in, when the series goes round; else `frame` itself. */
  const wrap = (frame: number, near: number): number => {
    if (!period) return frame
    const base = near - (near % period)
    return base + ((((frame - base) % period) + period) % period)
  }
  const note = (message: string, error?: unknown): void => {
    if (warned || signal.aborted) return
    warned = true
    app.log.warn(`EFFECT_MEDIA: ${name}: ${message}`, error)
  }
  const arrived = (file: Frame): void => {
    for (const resolve of file.waiting ?? []) resolve()
    file.waiting = undefined
  }
  const settle = (file: Frame | undefined): void => {
    file?.done?.()
    if (file) file.done = undefined
  }
  /** Closes pixels nothing holds: not in the window, not on a slot's texture. */
  const drop = (bitmap: ImageBitmap | undefined): void => {
    if (!bitmap || [...decoded.values()].includes(bitmap)) return
    if (lower.texture?.image === bitmap || upper.texture?.image === bitmap) return
    bitmap.close()
  }
  ctx.onDispose(() => {
    for (const file of files) {
      file?.lease?.release()
      settle(file)
    }
    for (const bitmap of decoded.values()) bitmap.close()
    decoded.clear()
    for (const upload of textures) {
      ;(upload.image as ImageBitmap).close()
      upload.dispose()
    }
  })

  const request = (i: number, priority: Priority): void => {
    const file = files[i] as Frame
    const lease = assets.load(urls[i] as string, { type: 'buffer', priority })
    // The new lease first: releasing the last one would abort the load.
    file.lease?.release()
    file.lease = lease
    file.priority = priority
    lease.ready.then(
      (bytes) => {
        if (file.lease !== lease || signal.aborted) return
        file.bytes = bytes as ArrayBuffer
        arrived(file)
        pump()
      },
      (error) => {
        if (file.lease !== lease || signal.aborted) return
        file.failed = true
        settle(file)
        arrived(file)
        note(`${urls[i]} did not load, the nearest frame shows instead`, error)
      },
    )
  }
  // Coarse to fine: the first frame, then the counted passes (they count into the loader's
  // progress), then the rest at low priority, so early movement sees a coarse animation.
  const stride = Math.max(1, Math.round(1 / Math.max(density, 0.01)))
  if (!atlas) {
    for (const step of [total, ...options.passes]) {
      for (let i = 0; i < total; i += step) {
        if (files[i] || i === poster || (i % stride && i !== total - 1)) continue
        files[i] = {}
        request(i, step === total ? 'high' : step >= options.counted ? 'normal' : 'low')
      }
    }
  }

  const decode = async (bytes: ArrayBuffer): Promise<ImageBitmap> => {
    const blob = new Blob([bytes])
    // The first decode learns the frames' size, so the others shrink as they decode.
    if (!naturalSize) {
      const raw = await createImageBitmap(blob, FLIP)
      naturalSize ??= [raw.width, raw.height]
      if (Math.max(raw.width, raw.height) <= resolution) return raw
      raw.close()
    }
    const [width, height] = naturalSize
    const scale = resolution / Math.max(width, height)
    if (scale >= 1) return createImageBitmap(blob, FLIP)
    // One side only, so a frame of another shape keeps it.
    const side =
      width >= height
        ? { resizeWidth: Math.round(width * scale) }
        : { resizeHeight: Math.round(height * scale) }
    return createImageBitmap(blob, { ...FLIP, ...side, resizeQuality: 'high' })
  }
  /** Decodes the window in its order, `DECODES` at a time. */
  const pump = (): void => {
    for (const i of wanted) {
      if (decodes >= DECODES) return
      const file = files[i] as Frame
      // A frame that failed to decode keeps its bytes: never retry it, or a broken file
      // would decode again on every completion, forever.
      if (!file.bytes || file.failed || file.decoding || decoded.has(i)) continue
      decodes++
      file.decoding = true
      decode(file.bytes).then(
        (bitmap) => {
          decodes--
          file.decoding = false
          // A decode outlived by fast scrolling still beats the frame showing in its place.
          if (signal.aborted || !(wanted.includes(i) || closer(i))) bitmap.close()
          else {
            decoded.set(i, bitmap)
            firstSize ??= [bitmap.width, bitmap.height]
            if (bitmap.width !== firstSize[0] || bitmap.height !== firstSize[1]) {
              note('frames differ in size, each is framed on its own')
            }
            settle(file)
            if (nearest(from) !== lower.shown || (pair && nearest(to) !== upper.shown)) {
              ctx.invalidate()
            }
          }
          pump()
        },
        (error) => {
          decodes--
          file.decoding = false
          file.failed = true
          settle(file)
          note(`${urls[i]} did not decode, the nearest frame shows instead`, error)
          pump()
        },
      )
    }
  }

  const ready = (i: number): boolean => Boolean(atlas) || i === poster || decoded.has(i)
  /** The closest frame that can show now, the one just passed first. */
  const nearest = (frame: number): number => {
    for (let distance = 0; distance < total; distance++) {
      const behind = wrap(frame - distance * direction, frame)
      if (behind >= 0 && behind < total && ready(behind)) return behind
      const ahead = wrap(frame + distance * direction, frame)
      if (ahead >= 0 && ahead < total && ready(ahead)) return ahead
    }
    return poster
  }
  /** Frames from `i` to `frame`, if `nearest(frame)` could pick `i`. */
  const gap = (i: number, frame: number): number => {
    if (!period) return Math.abs(i - frame)
    if (wrap(i, frame) !== i) return Number.POSITIVE_INFINITY
    const distance = Math.abs(i - frame)
    return Math.min(distance, period - distance)
  }
  /** Frame `i` is nearer to a shown frame than what shows there now. */
  const closer = (i: number): boolean =>
    gap(i, from) < gap(nearest(from), from) || (pair && gap(i, to) < gap(nearest(to), to))
  /** The window of pixels around `from`: the shown frames, two ahead, then one behind per two ahead. */
  const plan = (): void => {
    // What shows until the window decodes stays, or the copy would fall back to the poster.
    const keep = [nearest(from), nearest(to)]
    wanted = []
    const add = (i: number): void => {
      const file = files[i]
      if (file && !file.failed && !wanted.includes(i)) wanted.push(i)
    }
    add(from)
    add(to)
    const cache = Math.max(1, Math.round(params.cache))
    for (let distance = 1; wanted.length < cache && distance < total; distance++) {
      add(wrap(from + distance * direction, from))
      if (!(distance % 2) && wanted.length < cache) {
        add(wrap(from - (distance / 2) * direction, from))
      }
    }
    for (const [i, bitmap] of decoded) {
      if (wanted.includes(i) || keep.includes(i)) continue
      decoded.delete(i)
      drop(bitmap)
    }
    for (const [i, file] of files.entries()) {
      if (!file) continue
      if (!wanted.includes(i)) settle(file)
      else if (!file.bytes && file.priority !== 'high') request(i, 'high')
    }
    // `ready()` waits for the frames about to show. Without weight: a scrub that outruns the
    // decoder starts no loader wave on every frame.
    for (const i of [from, to]) {
      const file = files[i]
      if (!file || file.failed || file.done || decoded.has(i)) continue
      const work = new Promise<void>((resolve) => (file.done = resolve))
      assets.track(work, { priority: 'high', weight: 0 })
    }
    pump()
  }

  const place = (
    slot: Slot,
    picture: Texture,
    cell: readonly number[],
    inset: readonly number[],
  ): void => {
    slot.fit.set(picture === map || !cellSize ? picture : cellSize, objectFit)
    slot.node.value = picture
    ;(slot.cell.value as Vector4).fromArray(cell)
    ;(slot.inset.value as Vector2).fromArray(inset)
  }
  const showAtlasCell = (slot: Slot, i: number): void => {
    const perPage = cols * rows
    const page = pages[Math.floor(i / perPage)] as Texture
    const col = (i % perPage) % cols
    const row = Math.floor((i % perPage) / cols)
    const [width, height] = sizeOf(page)
    // KTX2 pages keep the top-left origin of the file, the others are flipped like bitmaps.
    const [offsetV, scaleV] = (page as { isCompressedTexture?: boolean }).isCompressedTexture
      ? [(row + 1) / rows, -1 / rows]
      : [1 - (row + 1) / rows, 1 / rows]
    const cell = [col / cols, offsetV, 1 / cols, scaleV]
    place(slot, page, cell, [(0.5 * cols) / width, (0.5 * rows) / height])
  }
  const showDecoded = (slot: Slot, i: number): void => {
    const bitmap = decoded.get(i) as ImageBitmap
    const other = slot === lower ? upper : lower
    if (other.texture && other.texture.image === bitmap) {
      // The other slot has it already (blend moved on by one): trade textures, no upload.
      ;[slot.texture, other.texture] = [other.texture, slot.texture]
      other.shown = Number.NaN
    } else if (slot.texture) {
      const old = slot.texture.image as ImageBitmap
      // r187 copies into the old GPU texture without a size check: a new size needs a new one.
      if (old.width !== bitmap.width || old.height !== bitmap.height) slot.texture.dispose()
      slot.texture.image = bitmap
      slot.texture.needsUpdate = true
      drop(old)
    } else {
      const upload = new Texture(bitmap)
      upload.colorSpace = SRGBColorSpace
      upload.flipY = false
      upload.generateMipmaps = false
      upload.minFilter = LinearFilter
      upload.needsUpdate = true
      textures.push(upload)
      slot.texture = upload
    }
    place(slot, slot.texture as Texture, [0, 0, 1, 1], [0, 0])
  }
  const show = (slot: Slot, i: number): void => {
    if (slot.shown === i) return
    slot.shown = i
    if (i === poster) place(slot, map, [0, 0, 1, 1], [0, 0])
    else if (atlas) showAtlasCell(slot, i)
    else showDecoded(slot, i)
  }

  // Pixels around the poster before the first movement.
  if (!atlas) plan()
  return {
    n: total,
    poster,
    show(fromFrame, toFrame, amount, towards) {
      direction = towards
      from = fromFrame
      to = toFrame
      pair = params.blend || amount > 0
      if (!atlas) plan()
      show(lower, nearest(from))
      if (pair) show(upper, nearest(to))
      mixAmount.value = amount
    },
    loaded(...indices) {
      const pending = indices.flatMap((i) => {
        const file = files[i]
        if (atlas || !file || file.bytes || file.failed) return []
        file.waiting ??= []
        const waiting = file.waiting
        return [new Promise<void>((resolve) => waiting.push(resolve))]
      })
      return Promise.all(pending).then(() => {})
    },
  }
}
