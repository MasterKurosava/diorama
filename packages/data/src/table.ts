// What the data effects share: numbers as people write them, the categorical palette and the
// tooltip outside the hidden markup.

/** Okabe and Ito's palette: told apart with every common color vision deficiency. */
export const PALETTE: readonly string[] = [
  '#0072b2',
  '#e69f00',
  '#009e73',
  '#d55e00',
  '#cc79a7',
  '#56b4e9',
]

/** Multipliers of the k/M/B/T suffixes. */
const SCALE: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  mn: 1e6,
  b: 1e9,
  bn: 1e9,
  t: 1e12,
  tn: 1e12,
}
/** The first run of digits in a text, with its sign and separators. */
export const NUMBER: RegExp = /[-+]?\d[\d.,]*/

/** The separators of a run of digits as written in English, German, French or Swiss text. */
function plain(run: string): string {
  const dot = run.lastIndexOf('.')
  const comma = run.lastIndexOf(',')
  if (dot >= 0 && comma >= 0) {
    const decimal = dot > comma ? '.' : ','
    return run
      .split(decimal === '.' ? ',' : '.')
      .join('')
      .replace(decimal, '.')
  }
  const commas = run.split(',').length - 1
  if (commas > 1) return run.replace(/,/g, '')
  if (commas === 1)
    return /^[-+]?[1-9]\d{0,2},\d{3}$/.test(run) ? run.replace(',', '') : run.replace(',', '.')
  if (run.split('.').length > 2) return run.replace(/\./g, '')
  return run
}

/**
 * A number from a cell: thousand separators, a decimal comma, currency, `%`, a minus sign,
 * accounting parentheses and k/M/B suffixes. NaN without digits.
 */
export function parseNumber(text: string): number {
  let cleaned = text
    .trim()
    .replace(/(\d)[\s   '](?=\d)/g, '$1')
    .replace(/[−‒–]/g, '-')
  let sign = 1
  if (/^\(.*\)$/.test(cleaned)) {
    sign = -1
    cleaned = cleaned.slice(1, -1)
  }
  const match = NUMBER.exec(cleaned)
  if (!match) return Number.NaN
  // A minus before a currency sign: -$5.
  if (/-[^\d]*$/.test(cleaned.slice(0, match.index))) sign = -sign
  const unit = /^\s*(bn|mn|tn|[kmbt])(?![a-z])/i.exec(cleaned.slice(match.index + match[0].length))
  const value =
    Number(plain(match[0])) * (unit ? (SCALE[(unit[1] as string).toLowerCase()] ?? 1) : 1)
  return Number.isFinite(value) ? sign * value : Number.NaN
}

/** The value of a cell: `data-dio-value` when given, else its text; and the text as written. */
export const cellValue = (cell: Element): [number, string] => {
  const text = (cell.textContent ?? '').trim()
  const given = cell.getAttribute('data-dio-value')
  return [given?.trim() ? Number(given) : parseNumber(text), text]
}

/** The rows of a table without its header row and footer, and the header row if there is one. */
export function rowsOf(table: HTMLTableElement): {
  head: HTMLTableRowElement | undefined
  body: HTMLTableRowElement[]
} {
  const rows = [...table.rows].filter((r) => r.parentElement?.tagName !== 'TFOOT')
  const first = rows[0]
  const head =
    first &&
    (first.parentElement?.tagName === 'THEAD' || [...first.cells].every((c) => c.tagName === 'TH'))
      ? first
      : undefined
  return {
    head,
    body: rows.filter((r) => r !== head && r.parentElement?.tagName !== 'THEAD'),
  }
}

/** Styles of the tooltip's shadow root. */
export const TIP =
  ':host{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none}[part=tooltip]{position:absolute;min-width:max-content;padding:6px 10px;border-radius:6px;background:rgb(18 20 26/.92);color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 4px 16px rgb(0 0 0/.18);transition:opacity .12s;white-space:nowrap}[hidden]{display:none}b{display:block;font-weight:600}i{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:2px}span{float:right;margin-left:16px;font-variant-numeric:tabular-nums}small{display:block;max-width:280px;white-space:normal;opacity:.75}'

export const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )

/** A tooltip in a shadow root on the body, hidden from screen readers: the markup says it all. */
export function tooltip(onDispose: (fn: () => void) => void): {
  show(html: string, x: number, y: number): void
  hide(): void
  readonly element: HTMLElement
} {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `<style>${TIP}</style><div part="tooltip" hidden></div>`
  const tip = shadow.querySelector('[part=tooltip]') as HTMLElement
  document.body.append(host)
  onDispose(() => host.remove())
  return {
    element: tip,
    show(html, x, y) {
      tip.innerHTML = html
      tip.hidden = false
      const box = tip.getBoundingClientRect()
      const left = Math.min(window.innerWidth - box.width - 8, Math.max(8, x + 14))
      const top = y - box.height - 12 < 8 ? y + 18 : y - box.height - 12
      tip.style.transform = `translate(${left}px, ${top}px)`
    },
    hide() {
      tip.hidden = true
    },
  }
}

/** Share of the box in view, above the bottom tenth of the viewport, that starts the entrance. */
export const SHOWN = 0.3
