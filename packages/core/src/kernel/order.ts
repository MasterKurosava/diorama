export interface Orderable {
  readonly labels: readonly string[]
  readonly before: readonly string[]
  readonly after: readonly string[]
  /** Owning plugin's ordinal. App code uses Infinity and runs after plugins. */
  readonly rank: number
  readonly seq: number
}

export const orderRefs = (ref: string | readonly string[] | undefined): readonly string[] =>
  ref === undefined ? [] : typeof ref === 'string' ? [ref] : ref

/**
 * Kahn's algorithm that always takes the `less`-smallest ready node, so the result is
 * deterministic. Returns the order, or the nodes left inside cycles.
 */
export function kahn(
  count: number,
  edges: readonly (readonly number[])[],
  less: (a: number, b: number) => boolean,
): number[] | { stuck: number[] } {
  const indegree = new Array<number>(count).fill(0)
  for (const targets of edges) for (const t of targets) indegree[t] = (indegree[t] ?? 0) + 1
  const done = new Array<boolean>(count).fill(false)
  const order: number[] = []
  for (;;) {
    let next = -1
    for (let i = 0; i < count; i++) {
      if (!done[i] && indegree[i] === 0 && (next < 0 || less(i, next))) next = i
    }
    if (next < 0) break
    done[next] = true
    order.push(next)
    for (const t of edges[next] ?? []) indegree[t] = (indegree[t] ?? 0) - 1
  }
  return order.length === count ? order : { stuck: [...done.keys()].filter((i) => !done[i]) }
}

/** One concrete cycle among `stuck` nodes, for error messages. */
export function findCycle(
  edges: readonly (readonly number[])[],
  stuck: readonly number[],
): number[] {
  const inStuck = new Set(stuck)
  const visiting = new Set<number>()
  const visited = new Set<number>()
  const path: number[] = []
  const visit = (node: number): number[] | undefined => {
    visiting.add(node)
    path.push(node)
    for (const next of edges[node] ?? []) {
      if (!inStuck.has(next) || visited.has(next)) continue
      if (visiting.has(next)) return [...path.slice(path.indexOf(next)), next]
      const found = visit(next)
      if (found) return found
    }
    path.pop()
    visiting.delete(node)
    visited.add(node)
    return undefined
  }
  for (const node of stuck) {
    const found = visited.has(node) ? undefined : visit(node)
    if (found) return found
  }
  return [...stuck]
}

/** Orders entries by before/after, then by (rank, seq). Returns the cycle if there is one. */
export function sortOrderables<T extends Orderable>(items: readonly T[]): T[] | { cycle: T[] } {
  const edges: number[][] = items.map(() => [])
  items.forEach((a, i) => {
    items.forEach((b, j) => {
      if (i === j) return
      if (a.before.some((l) => b.labels.includes(l))) edges[i]?.push(j)
      if (a.after.some((l) => b.labels.includes(l))) edges[j]?.push(i)
    })
  })
  const less = (a: number, b: number): boolean => {
    const x = items[a] as T
    const y = items[b] as T
    return x.rank !== y.rank ? x.rank < y.rank : x.seq < y.seq
  }
  const result = kahn(items.length, edges, less)
  if (Array.isArray(result)) return result.map((i) => items[i] as T)
  return { cycle: findCycle(edges, result.stuck).map((i) => items[i] as T) }
}
