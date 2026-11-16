// A semver subset: ^, ~, x-ranges, comparators and `||` groups. Unparsable input is `false`.
type Triple = [number, number, number]
interface Version {
  readonly triple: Triple
  readonly pre: readonly string[]
}
interface Comparator {
  readonly op: '<' | '<=' | '>' | '>=' | '='
  readonly version: Version
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PART = '(\\*|x|X|\\d+)'
const COMPARATOR_RE = new RegExp(
  `^(\\^|~|>=|<=|>|<|=)?v?${PART}(?:\\.${PART})?(?:\\.${PART})?(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$`,
)

function parseVersion(text: string): Version | undefined {
  const m = VERSION_RE.exec(text.trim())
  if (!m) return undefined
  return { triple: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

function compareIds(a: string, b: string): number {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  if (na) return -1
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a.triple[i] ?? 0) - (b.triple[i] ?? 0)
    if (d !== 0) return d
  }
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const d = compareIds(x, y)
    if (d !== 0) return d
  }
  return 0
}

const v = (major: number, minor: number, patch: number, pre: readonly string[] = []): Version => ({
  triple: [major, minor, patch],
  pre,
})

const isWild = (part: string | undefined): boolean =>
  part === undefined || part === '*' || part === 'x' || part === 'X'

/** Expands one comparator (`^1.2`, `~1`, `>=2.0.0`) into plain comparisons. */
function parseComparator(token: string): Comparator[] | undefined {
  const m = COMPARATOR_RE.exec(token)
  if (!m) return undefined
  const op = m[1] ?? ''
  const [M, m2, p] = [m[2], m[3], m[4]]
  const pre = m[5] ? m[5].split('.') : []
  if (isWild(M)) return op === '' || op === '=' || op === '>=' || op === '<=' ? [] : undefined
  const major = Number(M)
  const minor = isWild(m2) ? undefined : Number(m2)
  const patch = isWild(p) ? undefined : Number(p)

  if (op === '^') {
    const low = v(major, minor ?? 0, patch ?? 0, pre)
    const high =
      major > 0 || minor === undefined
        ? v(major + 1, 0, 0)
        : minor > 0 || patch === undefined
          ? v(0, minor + 1, 0)
          : v(0, 0, (patch ?? 0) + 1)
    return [
      { op: '>=', version: low },
      { op: '<', version: high },
    ]
  }
  if (op === '~' || ((op === '' || op === '=') && (minor === undefined || patch === undefined))) {
    const low = v(major, minor ?? 0, patch ?? 0, pre)
    const high = minor === undefined ? v(major + 1, 0, 0) : v(major, minor + 1, 0)
    return [
      { op: '>=', version: low },
      { op: '<', version: high },
    ]
  }
  if (minor === undefined || patch === undefined) {
    const next = minor === undefined ? v(major + 1, 0, 0) : v(major, minor + 1, 0)
    const base = v(major, minor ?? 0, 0)
    if (op === '>') return [{ op: '>=', version: next }]
    if (op === '<=') return [{ op: '<', version: next }]
    return [{ op: op as '<' | '>=', version: base }]
  }
  return [{ op: op === '' ? '=' : (op as Comparator['op']), version: v(major, minor, patch, pre) }]
}

function test(version: Version, c: Comparator): boolean {
  const d = compare(version, c.version)
  switch (c.op) {
    case '<':
      return d < 0
    case '<=':
      return d <= 0
    case '>':
      return d > 0
    case '>=':
      return d >= 0
    default:
      return d === 0
  }
}

export function satisfies(version: string, range: string): boolean {
  const ver = parseVersion(version)
  if (!ver) return false
  return range.split('||').some((group) => {
    const tokens = group
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean)
    const comparators: Comparator[] = []
    for (const token of tokens) {
      const parsed = parseComparator(token)
      if (!parsed) return false
      comparators.push(...parsed)
    }
    if (!comparators.every((c) => test(ver, c))) return false
    if (!ver.pre.length) return true
    return comparators.some(
      (c) => c.version.pre.length > 0 && compare(v(...c.version.triple), v(...ver.triple)) === 0,
    )
  })
}
