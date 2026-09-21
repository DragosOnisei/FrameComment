/**
 * 7.13.1: a carried-over note that has been dealt with leaves the version.
 *
 * Comments pasted in from an earlier cut (`isCopied`) exist so the editor
 * sees, on the new version, what was said about the old one. Once such a
 * note is marked Done there, it has served its purpose: it was never written
 * about this cut, and leaving it in the list greyed out — next to the fresh
 * feedback — is the clutter Dragos asked to be rid of ("dau done la acel
 * comentariu, sa dispara de la acea versiune"). So the default "All comments"
 * view and the timeline pins drop it. Nothing is deleted: the row stays,
 * the "Completed comments" filter still lists it, and un-doing Done brings
 * it straight back. A comment written ON this version behaves as before —
 * Done greys it, it does not vanish.
 *
 * One predicate for the list and the pins, so the two can never disagree.
 */

export interface CarryOverLike {
  isCopied?: boolean | null
  isResolved?: boolean | null
}

/** Copied from another version AND marked done: hidden from the default views. */
export function isRetiredCarryOver(comment: CarryOverLike | null | undefined): boolean {
  return !!comment && !!comment.isCopied && !!comment.isResolved
}

export function withoutRetiredCarryOvers<T extends CarryOverLike>(list: readonly T[]): T[] {
  return list.filter((c) => !isRetiredCarryOver(c))
}
