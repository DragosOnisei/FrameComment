/**
 * Tiny localStorage-backed clipboard for "copy comments" / "paste
 * comments" between video versions inside the same project. Lives on
 * the client only — there is no server-side persistence — which is
 * exactly what the user wants here: their own browser, scoped per
 * project, surviving a page reload but not leaking across devices.
 *
 * Stored payload is an array of comment-shaped records, each carrying its
 * replies (6.16.0). We deliberately strip ids and ownership info so a paste
 * creates a fresh comment with a fresh editorSessionId / userId.
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
  /**
   * 6.16.0: the answers, carried with the question.
   *
   * Copy used to flatten the thread: replies were either dropped or landed as
   * separate top-level comments, so pasting into a new version produced a wall
   * of orphaned lines where "can we try it warmer?" and "already did, see 0:14"
   * no longer sat together. A review note without its discussion is often
   * misleading — the reply is frequently the part that says it is settled.
   *
   * One level deep, matching the thread UI. The schema allows more, the
   * product does not.
   */
  replies?: ClippedReply[]
  /**
   * 6.22.0: the drawing, carried with the note.
   *
   * A comment reading "this bit" means nothing without the arrow that says
   * which bit. Annotations are shapes in the video's own coordinate space, so
   * they transfer to another cut of the same edit unchanged — which is exactly
   * the case paste exists for.
   */
  annotations?: unknown | null
  /**
   * 6.22.0: the id of the comment this was copied FROM, so the server can bring
   * its attachments across.
   *
   * Everything else in this payload is content; this is a reference, and it is
   * here for one reason: the client must not be the one deciding which files it
   * may copy. It names a comment, the server checks that comment lives in the
   * same project as the paste target, and only then duplicates. Sending asset
   * ids instead would mean trusting the browser's list.
   */
  sourceCommentId?: string | null
  /**
   * 6.22.0: how many files the original had, recorded at copy time.
   *
   * Only used to tell the truth afterwards. The server reports how many it
   * actually copied, and if the source comment was deleted between the copy and
   * the paste the answer is fewer than this — which the user should hear about
   * rather than discover later.
   */
  attachmentCount?: number
}

export interface ClippedReply {
  content: string
  authorName?: string | null
  /** 6.22.0: replies can carry drawings and files of their own. */
  annotations?: unknown | null
  sourceCommentId?: string | null
  attachmentCount?: number
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

/**
 * 7.1.0: every change to the clipboard announces itself.
 *
 * Two independent menus offer Paste — the sidebar kebab (CommentsKebabMenu, fed
 * by CommentSection) and the title-bar kebab (PlayerTopMenu) — and each kept its
 * own copy of "is there anything to paste". Each refreshed that copy on mount,
 * on cross-tab `storage` events, and, in the title bar only, on the
 * copy/paste bridge event. A `storage` event never fires in the tab that wrote
 * the value, and the bridge event only fires when the copy was STARTED from the
 * title bar. So copying from the sidebar — the natural place to copy, since that
 * is where the comments are — left the title bar believing the clipboard was
 * still empty, and its Paste stayed greyed for the rest of the page's life.
 *
 * That reads as "you cannot paste a comment into a different video", which was
 * never true: the clipboard has been keyed per PROJECT since it was written, the
 * paste posts to whichever video is open, and the server checks attachments
 * against the project too. Nothing was scoped to a version stack; only the
 * button's enabled state was wrong.
 *
 * Announcing from the one place that performs the write means no future caller
 * has to remember to.
 */
export const CLIPBOARD_CHANGED_EVENT = 'commentClipboard:changed'

function announceChange(): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(CLIPBOARD_CHANGED_EVENT))
  } catch {
    // Nothing to recover from — a browser this old would have failed earlier.
  }
}

export function setClippedComments(projectId: string, comments: ClippedComment[]): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(keyFor(projectId), JSON.stringify(comments))
    announceChange()
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
    announceChange()
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

/**
 * 6.22.0 — only carry an annotation the server will actually accept.
 *
 * `annotationDataSchema` requires `version: 1` and at least one shape, and a
 * rejected field fails the WHOLE request. So a comment whose drawing was stored
 * by an older build, or whose shapes array ended up empty, would come back as a
 * 400 and be dropped from the paste entirely. Losing a drawing is a shame;
 * losing the note it belonged to is a bug, so the drawing is what gives way.
 */
function carryableAnnotations(raw: any) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.version !== 1) return null
  if (!Array.isArray(raw.shapes) || raw.shapes.length === 0) return null
  return raw
}

/**
 * Turn comment rows into clipboard records.
 *
 * 7.4.2: moved here from CommentSection, which was the only thing that could
 * copy comments. The folder's right-click menu can now copy them from a video
 * it is not showing, and two definitions of what a copied comment contains
 * would drift the first time one of them learned a new field.
 *
 * 6.16.0: replies come along. They used to be dropped, so pasting into a new
 * version produced a wall of orphaned questions — including ones already
 * answered with "fixed, see 0:14". Carrying the note without its answer does
 * not just lose detail, it actively misleads the next reviewer.
 *
 * 6.22.0: the drawing and the files come too. "The logo is wrong, see the
 * screenshot" is useless on the new cut if the screenshot stayed on the old
 * one, and a voice message is nothing BUT its attachment — pasting one used to
 * produce an empty bubble. Annotations travel as data; attachments travel as a
 * reference to the source comment, which the server resolves (the browser must
 * not pick which files it may copy).
 */
/**
 * 7.5.0: what a BULK copy carries — root comments that are not themselves
 * copies. A comment pasted from another version (isCopied) does not travel
 * again: copying v2 (10 pasted from v1 + 2 of its own) onto v3 must bring
 * exactly the 2 — the 10 already have a home and an origin, and re-copying
 * them would chain provenance ("from v2") onto notes that are really v1's.
 * Explicit single-comment copy deliberately does NOT go through this: a
 * user pointing at one specific copied note and saying "copy" wins.
 */
export function copyableComments(list: any[]): any[] {
  return (Array.isArray(list) ? list : []).filter(
    (c: any) => c && !c.parentId && !c.isCopied,
  )
}

export function toClipped(list: any[]): ClippedComment[] {
  return list.map((c: any) => ({
    content: c.content,
    timecode: c.timecode,
    timecodeEnd: c.timecodeEnd ?? null,
    timestampMs: typeof c.timestampMs === 'number' ? c.timestampMs : null,
    authorName: c.authorName ?? null,
    annotations: carryableAnnotations(c.annotations),
    sourceCommentId: c.id ?? null,
    attachmentCount: Array.isArray(c.assets) ? c.assets.length : 0,
    replies: Array.isArray(c.replies)
      ? c.replies.map((r: any) => ({
          content: r.content,
          authorName: r.authorName ?? null,
          annotations: carryableAnnotations(r.annotations),
          sourceCommentId: r.id ?? null,
          attachmentCount: Array.isArray(r.assets) ? r.assets.length : 0,
        }))
      : [],
  })) as ClippedComment[]
}
