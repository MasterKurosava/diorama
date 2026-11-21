/**
 * A semver subset: `^`, `~`, x-ranges, comparators and `||` groups. Unparsable input never
 * satisfies a range.
 * @module
 */

type Triple = [major: number, minor: number, patch: number]

interface Version {
  readonly triple: Triple
  /** Prerelease identifiers: `1.0.0-beta.2` has `['beta', '2']`. */
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

/** Whether `version` is within a semver `range` such as `^1.2.0 || >=2`. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false
  return range.split('||').some((group) => satisfiesGroup(parsed, group))
}

/** Whether `version` passes every comparator of one `||` group. */
function satisfiesGroup(version: Version, group: string): boolean {
  const tokens = group
    .trim()
    .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
    .split(/\s+/)
    .filter(Boolean)
  const comparators: Comparator[] = []
  for (const token of tokens) {
    const expanded = parseComparator(token)
    if (!expanded) return false
    comparators.push(...expanded)
  }
  if (!comparators.every((comparator) => matches(version, comparator))) return false
  if (!version.pre.length) return true
  // A prerelease matches only a comparator with a prerelease on the same major.minor.patch.
  const plain = makeVersion(...version.triple)
  return comparators.some(
    (comparator) =>
      comparator.version.pre.length > 0 &&
      compare(makeVersion(...comparator.version.triple), plain) === 0,
  )
}

function parseVersion(text: string): Version | undefined {
  const match = VERSION_RE.exec(text.trim())
  if (!match) return undefined
  const triple: Triple = [Number(match[1]), Number(match[2]), Number(match[3])]
  return { triple, pre: match[4] ? match[4].split('.') : [] }
}

/** Expands one comparator (`^1.2`, `~1`, `>=2.0.0`) into plain comparisons. */
function parseComparator(token: string): Comparator[] | undefined {
  const match = COMPARATOR_RE.exec(token)
  if (!match) return undefined
  const op = match[1] ?? ''
  const [majorPart, minorPart, patchPart] = [match[2], match[3], match[4]]
  const pre = match[5] ? match[5].split('.') : []
  if (isWild(majorPart)) {
    return op === '' || op === '=' || op === '>=' || op === '<=' ? [] : undefined
  }
  const major = Number(majorPart)
  const minor = isWild(minorPart) ? undefined : Number(minorPart)
  const patch = isWild(patchPart) ? undefined : Number(patchPart)

  if (op === '^') {
    const low = makeVersion(major, minor ?? 0, patch ?? 0, pre)
    return between(low, caretLimit(major, minor, patch))
  }
  const partial = minor === undefined || patch === undefined
  if (op === '~' || ((op === '' || op === '=') && partial)) {
    const low = makeVersion(major, minor ?? 0, patch ?? 0, pre)
    const high =
      minor === undefined ? makeVersion(major + 1, 0, 0) : makeVersion(major, minor + 1, 0)
    return between(low, high)
  }
  if (partial) {
    const next =
      minor === undefined ? makeVersion(major + 1, 0, 0) : makeVersion(major, minor + 1, 0)
    const base = makeVersion(major, minor ?? 0, 0)
    if (op === '>') return [{ op: '>=', version: next }]
    if (op === '<=') return [{ op: '<', version: next }]
    return [{ op: op as '<' | '>=', version: base }]
  }
  return [
    {
      op: op === '' ? '=' : (op as Comparator['op']),
      version: makeVersion(major, minor, patch, pre),
    },
  ]
}

/** Exclusive upper bound of `^major.minor.patch`: the next bump of the leftmost non-zero part. */
function caretLimit(major: number, minor?: number, patch?: number): Version {
  if (major > 0 || minor === undefined) return makeVersion(major + 1, 0, 0)
  if (minor > 0 || patch === undefined) return makeVersion(0, minor + 1, 0)
  return makeVersion(0, 0, patch + 1)
}

const between = (low: Version, high: Version): Comparator[] => [
  { op: '>=', version: low },
  { op: '<', version: high },
]

function matches(version: Version, comparator: Comparator): boolean {
  const order = compare(version, comparator.version)
  switch (comparator.op) {
    case '<':
      return order < 0
    case '<=':
      return order <= 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    default:
      return order === 0
  }
}

/** Semver precedence: negative when `a` comes first. A release follows its prereleases. */
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a.triple[i] ?? 0) - (b.triple[i] ?? 0)
    if (difference !== 0) return difference
  }
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i]
    const right = b.pre[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const difference = compareIdentifiers(left, right)
    if (difference !== 0) return difference
  }
  return 0
}

/** Numeric identifiers compare as numbers and sort before alphanumeric ones. */
function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric) return -1
  if (bNumeric) return 1
  if (a < b) return -1
  return a > b ? 1 : 0
}

const makeVersion = (
  major: number,
  minor: number,
  patch: number,
  pre: readonly string[] = [],
): Version => ({ triple: [major, minor, patch], pre })

const isWild = (part: string | undefined): boolean =>
  part === undefined || part === '*' || part === 'x' || part === 'X'
