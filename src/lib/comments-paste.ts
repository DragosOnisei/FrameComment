import type { ClippedComment } from './comments-clipboard'

/**
 * Writing clipped comment threads onto a video.
 *
 * 7.1.0: extracted from CommentSection so more than one place can paste.
 *
 * The sidebar was the only caller for a long time, and the logic could live
 * inside the component that owned the clipboard. It cannot any more: a folder
 * can hold several near-identical cuts of the same edit — the same grade with a
 * different subtitle colour — and a note that applies to one applies to all of
 * them. Retyping it per video, or opening each video to paste, is the work this
 * exists to remove.
 *
 * The alternative was a second paste implementation for the bulk case. That is
 * exactly the shape of the compare-mode bug fixed in 7.0.1: two code paths
 * choosing a video's file by different rules, agreeing right up until they
 * quietly did not. One implementation, two callers.
 */

/** How a comment reaches the server. The caller decides, because the admin app
 *  and the public share page authenticate differently — `apiFetch` with a
 *  session versus a plain fetch carrying a share token. */
export type CommentPoster = (body: Record<string, unknown>) => Promise<Response>

export interface PasteSource {
  videoId: string
  versionLabel: string
}

export interface PasteResult {
  /** Threads AND replies actually created. */
  created: number
  /** Attachments the server reported copying. */
  filesCopied: number
  /**
   * Attachments the clipboard expected minus the ones that arrived. Normally
   * zero; non-zero when a source comment was deleted between the copy and the
   * paste. A paste that quietly loses a screenshot is worse than one that
   * admits it.
   */
  filesMissing: number
}

export interface PasteArgs {
  projectId: string
  /** The video the threads are written onto. */
  videoId: string
  items: ClippedComment[]
  /** Marks the new rows internal — true when an admin is pasting. */
  isInternal: boolean
  post: CommentPoster
  /** Recorded on the new rows when the threads came from a known version. */
  source?: PasteSource
}

/**
 * Sequential on purpose, and this is not an oversight to optimise away.
 *
 * The backend rate-limits comment creation, so firing twenty in parallel gets
 * half of them rejected — and a reply cannot be posted until its parent exists
 * and has an id. A caller pasting onto several videos must await each one for
 * the same reason.
 */
export async function pasteClippedThreads({
  projectId,
  videoId,
  items,
  isInternal,
  post,
  source,
}: PasteArgs): Promise<PasteResult> {
  let created = 0
  let filesExpected = 0
  let filesCopied = 0

  for (const item of items) {
    const body: Record<string, unknown> = {
      projectId,
      videoId,
      timecode: item.timecode,
      content: item.content,
      isInternal,
      // 3.8.x: flag pasted comments so the thread shows a "Copied" tag.
      isCopied: true,
    }
    if (item.timecodeEnd) body.timecodeEnd = item.timecodeEnd
    if (typeof item.timestampMs === 'number') body.timestampMs = item.timestampMs
    if (item.authorName) body.authorName = item.authorName
    // 6.22.0: the drawing rides along as data; the files by reference.
    if (item.annotations) body.annotations = item.annotations
    if (item.sourceCommentId && (item.attachmentCount || 0) > 0) {
      body.copyAssetsFromCommentId = item.sourceCommentId
      filesExpected += item.attachmentCount || 0
    }
    // NOTE: `source` is deliberately NOT written onto the parent row. That is
    // how CommentSection has always behaved — only replies carried
    // sourceVideoId/sourceVersionLabel — and this extraction is a refactor, so
    // it reproduces the behaviour rather than improving it. It looks like an
    // oversight (a pasted thread showing no provenance while its answers do),
    // but changing what gets written to the database is a separate decision
    // with its own testing, not a side effect of moving code.

    const res = await post(body)
    if (!res.ok) continue
    created += 1
    filesCopied += Number(res.headers.get('X-Attachments-Copied') || 0)

    // 6.16.0: replies ride along with their parent.
    const replies = Array.isArray(item.replies) ? item.replies : []
    if (replies.length === 0) continue

    // The POST response body is the whole project's comments (every caller
    // relies on that), so the new row's id travels in a header instead. Without
    // it we would be guessing which of N rows we just made.
    const parentId = res.headers.get('X-Comment-Id')
    if (!parentId) {
      // Older server, or a proxy stripped the header. Stop rather than re-adding
      // the answers as orphaned top-level notes — that shape is the thing this
      // feature exists to fix.
      continue
    }

    for (const reply of replies) {
      const replyBody: Record<string, unknown> = {
        projectId,
        videoId,
        // A reply has no timeline position of its own; it inherits the parent's.
        // Sending the parent's timecode keeps the server's validation happy
        // without inventing a second marker.
        timecode: item.timecode,
        content: reply.content,
        isInternal,
        isCopied: true,
        parentId,
      }
      if (reply.authorName) replyBody.authorName = reply.authorName
      if (reply.annotations) replyBody.annotations = reply.annotations
      if (reply.sourceCommentId && (reply.attachmentCount || 0) > 0) {
        replyBody.copyAssetsFromCommentId = reply.sourceCommentId
        filesExpected += reply.attachmentCount || 0
      }
      if (source) {
        replyBody.sourceVideoId = source.videoId
        replyBody.sourceVersionLabel = source.versionLabel
      }
      const replyRes = await post(replyBody)
      if (replyRes.ok) {
        created += 1
        filesCopied += Number(replyRes.headers.get('X-Attachments-Copied') || 0)
      }
    }
  }

  return {
    created,
    filesCopied,
    filesMissing: Math.max(0, filesExpected - filesCopied),
  }
}
