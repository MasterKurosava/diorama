import { Color } from 'three/webgpu'

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FN = /^(rgba?|hsla?)\(([^)]*)\)$/i
const ANGLE: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** A number, a percentage of `full`, or 'none'. NaN when it is none of these. */
function part(token: string, full: number): number {
  if (token === 'none') return 0
  const value = Number.parseFloat(token)
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(token)) return Number.NaN
  return token.endsWith('%') ? (value / 100) * full : value
}

function hue(token: string): number {
  const [, value = '', unit = 'deg'] = /^([-+]?[\d.]+(?:e[-+]?\d+)?)([a-z]*)$/i.exec(token) ?? []
  const scale = ANGLE[unit.toLowerCase() || 'deg']
  return token === 'none' ? 0 : scale ? Number.parseFloat(value) * scale : Number.NaN
}

function fromFunction(name: string, body: string): string | undefined {
  const parts = body.trim().split(/\s*[,/]\s*|\s+/)
  if (parts.length < 3 || parts.length > 4) return undefined
  const [a = '', b = '', c = ''] = parts
  let rgb: number[]
  if (name.startsWith('rgb')) rgb = [part(a, 255), part(b, 255), part(c, 255)]
  else {
    const h = (((hue(a) % 360) + 360) % 360) / 30
    const s = Math.min(1, Math.max(0, part(b, 1) / (b.endsWith('%') ? 1 : 100)))
    const l = Math.min(1, Math.max(0, part(c, 1) / (c.endsWith('%') ? 1 : 100)))
    const k = s * Math.min(l, 1 - l)
    const f = (n: number): number => {
      const t = (n + h) % 12
      return (l - k * Math.max(-1, Math.min(t - 3, 9 - t, 1))) * 255
    }
    rgb = [f(0), f(8), f(4)]
  }
  return rgb.every(Number.isFinite)
    ? hex(rgb[0] as number, rgb[1] as number, rgb[2] as number)
    : undefined
}

type Context = {
  fillStyle: unknown
  fillRect(x: number, y: number, w: number, h: number): void
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> }
  globalCompositeOperation: string
}
let canvas: Context | null | undefined
const seen = new Map<string, string | undefined>()

/** The browser parses what three cannot (oklch, lab, color()): one 1x1 canvas read per string. */
function viaCanvas(value: string): string | undefined {
  if (seen.has(value)) return seen.get(value)
  if (canvas === undefined) {
    try {
      const element =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(1, 1)
          : typeof document === 'undefined'
            ? undefined
            : document.createElement('canvas')
      canvas = (element?.getContext('2d', { willReadFrequently: true }) as Context | null) ?? null
    } catch {
      canvas = null
    }
  }
  let result: string | undefined
  if (canvas) {
    // An invalid value leaves fillStyle as it was, so two different starts tell it apart.
    canvas.fillStyle = '#000'
    canvas.fillStyle = value
    const first = canvas.fillStyle
    canvas.fillStyle = '#fff'
    canvas.fillStyle = value
    if (first === canvas.fillStyle) {
      canvas.globalCompositeOperation = 'copy'
      canvas.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0] = Array.from(canvas.getImageData(0, 0, 1, 1).data)
      result = hex(r, g, b)
    }
  }
  seen.set(value, result)
  return result
}

/** Levels of `var()` followed, as in `--accent: var(--brand)`. */
const DEPTH = 8

/**
 * `text` with each `var(--name, fallback)` in it replaced by the custom property read from
 * `style`, or its fallback when unset, and each `currentColor` by the element's colour.
 */
function substitute(text: string, style: CSSStyleDeclaration, depth = 0): string {
  let out = ''
  let from = 0
  for (;;) {
    const start = text.toLowerCase().indexOf('var(', from)
    if (start < 0) break
    let end = start + 3
    for (let level = 0; end < text.length; end++) {
      if (text[end] === '(') level++
      else if (text[end] === ')' && --level === 0) break
    }
    if (end >= text.length) break
    const body = text.slice(start + 4, end)
    const comma = body.indexOf(',')
    const name = (comma < 0 ? body : body.slice(0, comma)).trim()
    const fallback = comma < 0 ? '' : body.slice(comma + 1)
    const own = style.getPropertyValue(name).trim() || fallback.trim()
    out += text.slice(from, start) + (depth < DEPTH ? substitute(own, style, depth + 1) : '')
    from = end + 1
  }
  return (out + text.slice(from)).replace(/\bcurrentcolor\b/gi, () => style.color)
}

/**
 * Any CSS colour as '#rrggbb', which three's `Color.setStyle` parses. Alpha is dropped. Hex,
 * rgb() and hsl() in both syntaxes and colour names are parsed here; other colour spaces go
 * through a canvas, so they need a browser. Undefined for what is not a colour.
 *
 * With `element`, `var(--brand)` (its fallback when unset, nested custom properties followed)
 * and `currentColor` are read from the element's computed style, anywhere in the value, as in
 * `color-mix(in oklab, var(--brand), white)`. The value is read at the call: call again to see a
 * changed variable.
 */
export function cssColor(value: string, element?: Element): string | undefined {
  let text = value.trim()
  if (element && /var\(|currentcolor/i.test(text)) {
    text = substitute(text, getComputedStyle(element)).trim()
  }
  const short = HEX.exec(text)?.[1]
  if (short) {
    const full = short.length < 6 ? [...short].map((c) => c + c).join('') : short
    return `#${full.slice(0, 6).toLowerCase()}`
  }
  const functional = FN.exec(text)
  if (functional)
    return fromFunction((functional[1] as string).toLowerCase(), functional[2] as string)
  const named = (Color.NAMES as Record<string, number>)[text.toLowerCase()]
  if (named !== undefined) return `#${named.toString(16).padStart(6, '0')}`
  return text ? viaCanvas(text) : undefined
}
