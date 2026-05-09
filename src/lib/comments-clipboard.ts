/**
 * Tiny localStorage-backed clipboard for "copy comments" / "paste
 * comments" between video versions inside the same project. Lives on
 * the client only — there is no server-side persistence — which is
 * exactly what the user wants here: their own browser, scoped per
 * project, surviving a page reload but not leaking across devices.
 *
 * Stored payload is a flat array of comment-shaped records. We
 * deliberately strip ids and ownership info so a paste creates a
 * fresh comment with a fresh editorSessionId / userId.
 */

export interface ClippedComment {
  content: string
  /** SMPTE-style timecode of the in point, e.g. "00:00:32:15" */
  timecode: string
  /** Optional out-point timecode for ranged comments */
  timecodeEnd?: string | null
  /** Optional millisecond-precise capture moment (1.0.3+) */
  timestampMs?: number | null
  /** Author display name. Pass-through; the server may overwrite for
   *  guest viewers anyway. */
  authorName?: string | null
}

const KEY_PREFIX = 'framecomment:clipboard:comments'

function keyFor(projectId: string): string {
  return `${KEY_PREFIX}:${projectId}`
}

/** Returns true if the current browser env supports localStorage. */
function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function setClippedComments(projectId: string, comments: ClippedComment[]): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(keyFor(projectId), JSON.stringify(comments))
  } catch {
    // Quota exceeded or storage disabled — silently drop.
  }
}

export function getClippedComments(projectId: string): ClippedComment[] | null {
  if (!hasStorage()) return null
  try {
    const raw = window.localStorage.getItem(keyFor(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed as ClippedComment[]
  } catch {
    return null
  }
}

export function clearClippedComments(projectId: string): void {
  if (!hasStorage()) return
  try {
    window.localStorage.removeItem(keyFor(projectId))
  } catch {
    // Ignore
  }
}

/** Cheap "is there anything to paste?" check that doesn't fully parse
 *  the payload. Used by the kebab menu to decide whether the Paste
 *  item is enabled. */
export function hasClippedComments(projectId: string): boolean {
  if (!hasStorage()) return false
  try {
    const raw = window.localStorage.getItem(keyFor(projectId))
    return !!raw && raw.length > 2
  } catch {
    return false
  }
}
