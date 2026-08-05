/**
 * 6.1.0 — the ONE grouping key for version stacks, safe on client and server.
 *
 * Before this, every list in the app grouped versions by `video.name`. That
 * made the name load-bearing: two assets that happened to share a filename
 * merged into one card, and a rename could split or fuse stacks. Now a stack
 * is `stackId` and the name is only what we print.
 *
 * The fallback keeps rows written by an older container (stackId still NULL)
 * grouped the way they were before, so nothing scatters mid-deploy. It mirrors
 * the SQL backfill: project + folder + name.
 */

export interface StackKeyable {
  stackId?: string | null
  projectId?: string | null
  folderId?: string | null
  name: string
}

export function stackKeyOf(v: StackKeyable): string {
  if (v.stackId) return v.stackId
  return `legacy:${v.projectId ?? '~'}|${v.folderId ?? '~root'}|${v.name}`
}

/**
 * Order a stack's rows newest-version-FIRST (what cards and dropdowns want).
 * Ties fall back to creation time so the order is stable even if two rows
 * briefly share a number.
 */
export function sortVersionsDesc<
  T extends { version: number; createdAt?: string | Date | null },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return bt - at
  })
}

/** Same order, oldest first — the left-to-right order of the version reel. */
export function sortVersionsAsc<
  T extends { version: number; createdAt?: string | Date | null },
>(rows: T[]): T[] {
  return sortVersionsDesc(rows).reverse()
}

/** Group rows into stacks, preserving the order stacks first appear in. */
export function groupByStack<T extends StackKeyable>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const key = stackKeyOf(row)
    const bucket = out.get(key)
    if (bucket) bucket.push(row)
    else out.set(key, [row])
  }
  return out
}
