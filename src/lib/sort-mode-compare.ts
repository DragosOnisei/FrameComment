import type { AdminSortMode } from './use-admin-sort-mode'

/**
 * 7.17.3: ONE comparator for the admin's sort preference.
 *
 * The folder grid ordered its cards with an inline switch over the sort mode
 * (A→Z, Z→A, upload date newest / oldest) and the player's previous / next
 * arrows ordered the same videos plain alphabetically — so with the grid set
 * to "Oldest → Newest", opening the FIRST card showed a "previous" arrow and
 * "next" jumped to the alphabetical neighbour, not to the second card
 * (reported by Dragos on 2026-10-02 from the Samuel 9:16 folder). Both now
 * call this function, and nothing else may decide the order.
 *
 * Pure, so a node script checks it. Dates compare as milliseconds; a missing
 * or unparsable date sorts as 0 (the beginning of time). Equal dates fall
 * back to the name so two uploads from the same second have a stable order
 * everywhere, independent of how the caller's list happened to be built.
 */
export interface SortableByMode {
  name: string
  createdAt?: string | Date | null
}

function timeOf(x?: string | Date | null): number {
  if (!x) return 0
  const t = new Date(x).getTime()
  return Number.isFinite(t) ? t : 0
}

export function compareBySortMode(
  mode: AdminSortMode,
  a: SortableByMode,
  b: SortableByMode,
): number {
  switch (mode) {
    case 'alphabetical-reverse':
      return b.name.localeCompare(a.name)
    case 'date-newest':
      return timeOf(b.createdAt) - timeOf(a.createdAt) || a.name.localeCompare(b.name)
    case 'date-oldest':
      return timeOf(a.createdAt) - timeOf(b.createdAt) || a.name.localeCompare(b.name)
    case 'alphabetical':
    default:
      return a.name.localeCompare(b.name)
  }
}

/** A sorted copy of `items` in the given mode. */
export function sortByMode<T extends SortableByMode>(items: readonly T[], mode: AdminSortMode): T[] {
  return [...items].sort((a, b) => compareBySortMode(mode, a, b))
}
