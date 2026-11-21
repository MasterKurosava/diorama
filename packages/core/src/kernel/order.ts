/** An entry ordered by `before`/`after` labels: a hook handler or a system. */
export interface Orderable {
  /** Names that `before` and `after` of other entries can refer to. */
  readonly labels: readonly string[]
  readonly before: readonly string[]
  readonly after: readonly string[]
  /** Owning plugin's ordinal. App code uses Infinity and runs after plugins. */
  readonly rank: number
  /** Registration order, the last tie-breaker. */
  readonly seq: number
}

export const orderRefs = (ref: string | readonly string[] | undefined): readonly string[] => {
  if (ref === undefined) return []
  return typeof ref === 'string' ? [ref] : ref
}

/**
 * Topological sort (Kahn's algorithm) over nodes `0..count-1`, where `edges[a]` lists the nodes
 * that must come after `a`. Among the nodes ready at each step it takes the `less`-smallest, so
 * the result is deterministic. Returns the order, or the nodes left inside cycles.
 */
export function topologicalSort(
  count: number,
  edges: readonly (readonly number[])[],
  less: (a: number, b: number) => boolean,
): number[] | { stuck: number[] } {
  const indegree = new Array<number>(count).fill(0)
  for (const targets of edges) {
    for (const target of targets) indegree[target] = (indegree[target] ?? 0) + 1
  }
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
    for (const target of edges[next] ?? []) indegree[target] = (indegree[target] ?? 0) - 1
  }
  if (order.length === count) return order
  return { stuck: [...done.keys()].filter((i) => !done[i]) }
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
  // Depth-first search. Reaching a node still on the path closes a cycle.
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
      if (a.before.some((label) => b.labels.includes(label))) edges[i]?.push(j)
      if (a.after.some((label) => b.labels.includes(label))) edges[j]?.push(i)
    })
  })
  const less = (a: number, b: number): boolean => {
    const first = items[a] as T
    const second = items[b] as T
    return first.rank !== second.rank ? first.rank < second.rank : first.seq < second.seq
  }
  const result = topologicalSort(items.length, edges, less)
  if (Array.isArray(result)) return result.map((i) => items[i] as T)
  return { cycle: findCycle(edges, result.stuck).map((i) => items[i] as T) }
}
