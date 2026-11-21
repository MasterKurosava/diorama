// The `font` shorthand of a 2D canvas has keywords for nine widths and nothing for variation axes
// or OpenType features, so text set with `font-stretch: 118%`, `font-variation-settings`,
// `font-feature-settings` or a numeric or ligature variant draws at another width or with other
// glyphs. Such a style draws with an alias: FontFaces of the page's own font files whose
// descriptors pin that width, those axes and features.

/** Width keywords of the `font` shorthand by the percentage `font-stretch` computes to. */
const WIDTHS: Readonly<Record<string, string>> = {
  '50%': 'ultra-condensed',
  '62.5%': 'extra-condensed',
  '75%': 'condensed',
  '87.5%': 'semi-condensed',
  '100%': 'normal',
  '112.5%': 'semi-expanded',
  '125%': 'expanded',
  '150%': 'extra-expanded',
  '200%': 'ultra-expanded',
}

/** Properties the canvas cannot apply, besides a width without a keyword. */
const SETTINGS = [
  'font-variation-settings',
  'font-feature-settings',
  'font-variant-numeric',
  'font-variant-ligatures',
] as const

/** OpenType features of the numeric and ligature variants. */
const VARIANTS: Readonly<Record<string, string>> = {
  'lining-nums': '"lnum"',
  'oldstyle-nums': '"onum"',
  'proportional-nums': '"pnum"',
  'tabular-nums': '"tnum"',
  'diagonal-fractions': '"frac"',
  'stacked-fractions': '"afrc"',
  ordinal: '"ordn"',
  'slashed-zero': '"zero"',
  none: '"liga" 0, "clig" 0, "dlig" 0, "hlig" 0, "calt" 0',
  'common-ligatures': '"liga", "clig"',
  'no-common-ligatures': '"liga" 0, "clig" 0',
  'discretionary-ligatures': '"dlig"',
  'no-discretionary-ligatures': '"dlig" 0',
  'historical-ligatures': '"hlig"',
  'no-historical-ligatures': '"hlig" 0',
  contextual: '"calt"',
  'no-contextual': '"calt" 0',
}

/** FontFace descriptors copied from a face, by the @font-face property they come from. */
const COPIED: Readonly<Record<string, string>> = {
  style: 'font-style',
  weight: 'font-weight',
  unicodeRange: 'unicode-range',
  featureSettings: 'font-feature-settings',
  variationSettings: 'font-variation-settings',
  ascentOverride: 'ascent-override',
  descentOverride: 'descent-override',
  lineGapOverride: 'line-gap-override',
  sizeAdjust: 'size-adjust',
}

type Span = readonly [number, number]

interface Face {
  /** `src` with absolute URLs. */
  readonly src: string
  /** Descriptors as written, by FontFace name. */
  readonly declared: Readonly<Record<string, string>>
  readonly slant: string
  /** Undefined when `auto` or absent: the face takes any value. */
  readonly weight: Span | undefined
  readonly stretch: Span | undefined
}

interface Alias {
  readonly family: string
  readonly faces: readonly (readonly [FontFace, readonly Span[]])[]
}

/** Aliases by their faces and descriptors: styles that come to the same faces share one. */
const made = new Map<string, Alias>()
/** By style: the alias with the families after it, or why it has none. */
const resolved = new Map<string, Promise<{ alias: Alias; family: string } | string>>()
/** By style: the canvas `font-family` once the alias has loaded for some text. */
const ready = new Map<string, string>()
/** Rules of cross-origin stylesheets, fetched again in CORS mode, by URL. */
const fetched = new Map<string, Promise<CSSRuleList | undefined>>()

const weightOf = (value: string): number =>
  value === 'bold' ? 700 : value === 'normal' || !value ? 400 : Number.parseFloat(value)
const widthOf = (value: string): number =>
  Number.parseFloat(Object.keys(WIDTHS).find((p) => WIDTHS[p] === value) ?? (value || '100%'))
const slantOf = (style: string): string => /^(italic|oblique)/.exec(style)?.[1] ?? 'normal'
const clamp = (v: number, span: Span | undefined): number =>
  span ? Math.min(span[1], Math.max(span[0], v)) : v

/** The `font` shorthand keyword for a computed `font-stretch`; '' for normal or none. */
export function widthKeyword(stretch: string): string {
  const word = WIDTHS[stretch] ?? stretch
  return word !== 'normal' && Object.values(WIDTHS).includes(word) ? word : ''
}

/** A property of the style, '' when normal or unset; plain objects with font fields pass too. */
const propertyOf = (style: CSSStyleDeclaration, name: string): string => {
  const value = style.getPropertyValue?.(name) ?? ''
  return value === 'normal' ? '' : value
}

/** The first of `SETTINGS` the style sets, as `property: value`. */
function setting(style: CSSStyleDeclaration): string | undefined {
  const name = SETTINGS.find((n) => propertyOf(style, n))
  return name && `${name}: ${propertyOf(style, name)}`
}

/** What of the style the canvas font cannot express, as `property: value`; undefined if nothing. */
export function needs(style: CSSStyleDeclaration): string | undefined {
  const stretch = style.fontStretch
  return stretch && widthOf(stretch) !== 100 && !widthKeyword(stretch)
    ? `font-stretch: ${stretch}`
    : setting(style)
}

const signature = (style: CSSStyleDeclaration): string =>
  [
    style.fontFamily,
    style.fontStyle,
    style.fontWeight,
    style.fontStretch,
    ...SETTINGS.map((n) => propertyOf(style, n)),
  ].join('|')

/** The canvas `font-family` for a style that needs an alias, once `alias` has loaded one. */
export const aliasOf = (style: CSSStyleDeclaration): string | undefined =>
  needs(style) && ready.get(signature(style))

/** The families of a computed `font-family`, as written. */
const familiesOf = (list: string): string[] =>
  (list.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+/g) ?? [])
    .map((f) => f.trim())
    .filter(Boolean)
const unquote = (name: string): string =>
  name
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .replace(/\\(.)/g, '$1')

/** A descriptor range as numbers; undefined for `auto` or none. */
function spanOf(text: string | undefined, value: (word: string) => number): Span | undefined {
  if (!text || text === 'auto') return undefined
  const [low = Number.NaN, high = low] = text.split(/\s+/).map(value)
  return Number.isNaN(low + high) ? undefined : [Math.min(low, high), Math.max(low, high)]
}

/** Code point ranges of a `unicode-range`; all of Unicode without one. */
function rangesOf(text: string | undefined): Span[] {
  if (!text) return [[0, 0x10ffff]]
  return text.split(',').map((part) => {
    const [start = '', end] = part.trim().replace(/^u\+/i, '').split('-')
    const hex = (digits: string): number => Number.parseInt(digits, 16)
    return end
      ? [hex(start), hex(end)]
      : [hex(start.replace(/\?/g, '0')), hex(start.replace(/\?/g, 'f'))]
  })
}

const covers = (ranges: readonly Span[], chars: string): boolean => {
  for (const char of chars) {
    const code = char.codePointAt(0) ?? 0
    if (ranges.some(([from, to]) => code >= from && code <= to)) return true
  }
  return false
}

/** Rules of a stylesheet; a cross-origin one is fetched again in CORS mode, once a page. */
function rulesOf(sheet: CSSStyleSheet): CSSRuleList | Promise<CSSRuleList | undefined> | undefined {
  try {
    return sheet.cssRules
  } catch {
    const href = sheet.href
    if (!href) return undefined
    let rules = fetched.get(href)
    if (!rules) {
      rules = fetch(href, { mode: 'cors', credentials: 'omit' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((css) => {
          const copy = new CSSStyleSheet()
          // A constructed sheet takes no @import.
          copy.replaceSync(css.replace(/@import[^;]*;/g, ''))
          return copy.cssRules
        })
        .catch(() => undefined)
      fetched.set(href, rules)
    }
    return rules
  }
}

const applies = (media: string | undefined): boolean =>
  !media || media === 'all' || matchMedia(media).matches

const URLS = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g

/** The @font-face rules of a family in the page's stylesheets, in order. */
async function facesOf(family: string): Promise<Face[]> {
  const found: Face[] = []
  const name = family.toLowerCase()
  const visit = async (rules: CSSRuleList | undefined, base: string): Promise<void> => {
    for (const rule of Array.from(rules ?? [])) {
      if (rule instanceof CSSFontFaceRule) {
        const declaration = rule.style
        if (unquote(declaration.getPropertyValue('font-family')).toLowerCase() !== name) continue
        const declared: Record<string, string> = {}
        for (const [key, property] of Object.entries(COPIED)) {
          const value = declaration.getPropertyValue(property)
          if (value) declared[key] = value
        }
        const src = declaration
          .getPropertyValue('src')
          .replace(
            URLS,
            (_, double, single, bare) => `url("${new URL(double ?? single ?? bare, base).href}")`,
          )
        found.push({
          src,
          declared,
          slant: slantOf(declared.style ?? ''),
          weight: spanOf(declared.weight, weightOf),
          stretch: spanOf(declaration.getPropertyValue('font-stretch'), widthOf),
        })
      } else if ('styleSheet' in rule) {
        const { styleSheet: sheet, media } = rule as CSSImportRule
        if (sheet && applies(media.mediaText)) await visit(await rulesOf(sheet), sheet.href ?? base)
      } else if ('cssRules' in rule && !('selectorText' in rule)) {
        // @media, @supports, @layer.
        const condition = (rule as CSSConditionRule).conditionText
        const holds =
          condition === undefined ||
          ('media' in rule ? applies(condition) : CSS.supports(condition))
        if (holds) await visit((rule as CSSGroupingRule).cssRules, base)
      }
    }
  }
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) {
    if (!sheet.disabled && applies(sheet.media.mediaText))
      await visit(await rulesOf(sheet), sheet.href ?? document.baseURI)
  }
  return found
}

/** The faces with the lowest score. */
function narrow(faces: readonly Face[], score: (f: Face) => number): Face[] {
  const best = Math.min(...faces.map(score))
  return faces.filter((f) => score(f) === best)
}

/** Preference of a value `offset` away from the wanted one: those on the `first` side come first. */
const away = (offset: number, first: boolean): number =>
  offset === 0 ? 0 : first === offset < 0 ? Math.abs(offset) : 1e4 + Math.abs(offset)

/**
 * The faces the browser draws the style with (CSS Fonts 4, 5.2: width, then slant, then weight):
 * one, or several that split the characters by `unicode-range`.
 */
function pick(faces: readonly Face[], style: CSSStyleDeclaration): Face[] {
  const stretch = widthOf(style.fontStretch)
  const weight = weightOf(style.fontWeight)
  const slant = slantOf(style.fontStyle)
  const order =
    slant === 'italic'
      ? ['italic', 'oblique', 'normal']
      : slant === 'oblique'
        ? ['oblique', 'italic', 'normal']
        : ['normal', 'oblique', 'italic']
  // At or below 100% a narrower width first, above it a wider one.
  let out = narrow(faces, (f) => away(clamp(stretch, f.stretch) - stretch, stretch <= 100))
  out = narrow(out, (f) => order.indexOf(f.slant))
  out = narrow(out, (f) => {
    const offset = clamp(weight, f.weight) - weight
    // 400 to 500: heavier up to 500, then lighter, then heavier still.
    if (weight >= 400 && weight <= 500)
      return offset === 0
        ? 0
        : offset > 0 && weight + offset <= 500
          ? offset
          : offset < 0
            ? 1e4 - offset
            : 2e4 + offset
    return away(offset, weight < 400)
  })
  // Of two faces for the same characters the later one wins.
  return [...new Map(out.map((f) => [f.declared.unicodeRange ?? '', f])).values()]
}

/** The alias face's descriptors: the face's own, the width pinned, axes and features added. */
function descriptors(face: Face, style: CSSStyleDeclaration): Record<string, string> {
  const join = (...parts: (string | undefined)[]): string =>
    parts.filter((p) => p && p !== 'normal').join(', ') || 'normal'
  const variants = ['font-variant-numeric', 'font-variant-ligatures'].flatMap((name) =>
    propertyOf(style, name)
      .split(/\s+/)
      .map((word) => VARIANTS[word]),
  )
  return {
    ...face.declared,
    // Absent descriptors of a rule take the font's own range; FontFace defaults to normal.
    style: face.declared.style ?? 'auto',
    weight: face.declared.weight ?? 'auto',
    stretch: `${clamp(widthOf(style.fontStretch), face.stretch)}%`,
    featureSettings: join(
      face.declared.featureSettings,
      ...variants,
      propertyOf(style, 'font-feature-settings'),
    ),
    variationSettings: join(
      face.declared.variationSettings,
      propertyOf(style, 'font-variation-settings'),
    ),
  }
}

/**
 * The alias face. WebKit takes no `auto` style or weight: the face fails at once and its load
 * rejects. It reads a rule without them as `normal`, so the alias leaves them out there too.
 */
function fontFace(family: string, src: string, declared: Record<string, string>): FontFace {
  const face = new FontFace(family, src, declared)
  if (face.status !== 'error') return face
  const plain = Object.entries(declared).filter(([, value]) => value !== 'auto')
  return new FontFace(family, src, Object.fromEntries(plain))
}

let probe: HTMLCanvasElement | undefined

/**
 * Whether a family without a readable @font-face draws the text as wide at `font-stretch` as at
 * normal width: a system font with no width axis or faces.
 */
function flat(style: CSSStyleDeclaration, chars: string): boolean {
  probe ??= document.createElement('canvas')
  const ctx = probe.getContext('2d')
  if (!ctx) return false
  const stretch = widthOf(style.fontStretch)
  const width = (keyword: string): number => {
    ctx.font = `${slantOf(style.fontStyle)} ${keyword} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    return ctx.measureText(chars).width
  }
  return width('normal') === width(stretch < 100 ? 'ultra-condensed' : 'ultra-expanded')
}

async function resolve(
  style: CSSStyleDeclaration,
  property: string,
): Promise<{ alias: Alias; family: string } | string> {
  const [first = '', ...rest] = familiesOf(style.fontFamily)
  const name = unquote(first)
  try {
    const faces =
      typeof FontFace === 'function' && document.fonts ? pick(await facesOf(name), style) : []
    if (faces.length) {
      const list = faces.map((f) => [f.src, descriptors(f, style)] as const)
      const id = JSON.stringify(list)
      let alias = made.get(id)
      if (!alias) {
        const family = `dio-text-${made.size}`
        alias = {
          family,
          // Added to document.fonts once loaded: the page sees no loading events for them.
          faces: list.map(([src, declared]) => [
            fontFace(family, src, declared),
            rangesOf(declared.unicodeRange),
          ]),
        }
        made.set(id, alias)
      }
      return { alias, family: [`"${alias.family}"`, ...rest].join(', ') }
    }
  } catch {
    // A URL or descriptor the browser rejects: no alias.
  }
  return `${property} on ${name} without a readable @font-face`
}

/**
 * Makes and loads the alias of a style the canvas font cannot express, for the characters given.
 * Resolves to what cannot be drawn when the page has no readable @font-face for the family or
 * its files do not load; undefined when the style needs no alias or its alias is ready.
 */
export async function alias(
  style: CSSStyleDeclaration,
  chars: string,
): Promise<string | undefined> {
  const property = needs(style)
  if (!property) return undefined
  const key = signature(style)
  const entry = resolved.get(key) ?? resolve(style, property)
  resolved.set(key, entry)
  const found = await entry
  if (typeof found === 'string') {
    // Only the width differs and the font has none to change: the canvas draws it as it is.
    return !setting(style) && flat(style, chars) ? undefined : found
  }
  const set = document.fonts
  const loads = found.alias.faces
    .filter(([, ranges]) => covers(ranges, chars))
    .map(([face]) => face.load().then(() => set.add(face)))
  try {
    await Promise.all(loads)
  } catch {
    const name = unquote(familiesOf(style.fontFamily)[0] ?? '')
    return `${property} on ${name} with a font file that failed to load`
  }
  ready.set(key, found.family)
  return undefined
}
