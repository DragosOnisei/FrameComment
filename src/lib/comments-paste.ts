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
  /**
   * 7.3.3: the ids of the THREADS that were created, in paste order.
   *
   * Threads only, not replies: a reply has no card of its own in the list, it
   * is drawn inside its parent's, so highlighting one would mean highlighting
   * something the reader cannot point at. The caller uses these to say "these
   * are the ones that just arrived", which on a cut with forty comments is the
   * difference between a paste you can see and a number that went up.
   *
   * Empty when the server did not return the header (older build, or a proxy
   * stripped it) — the paste still happened, it just cannot be pointed at.
   */
  createdIds: string[]
  /**
   * 7.3.5: how many posts the server refused.
   *
   * This used to be nothing at all: a refused POST was skipped with a bare
   * `continue` and the caller was handed a `created` count it never looked at.
   * So a paste that lost half its comments — or all of them — looked exactly
   * like a paste that worked, which is how a rate-limit collision turned into
   * "sometimes the button does nothing".
   */
  failed: number
  /**
   * True when at least one refusal was a 429. Worth separating from any other
   * failure because it is the one the user can do something about, and because
   * the honest message names a wait rather than an error.
   */
  rateLimited: boolean
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
  /**
   * 7.3.5: told when the batch has to sit out a rate-limit lockout, so the
   * button can say so instead of showing an unexplained "Pasting…" for a
   * minute. A silent one-minute spinner is indistinguishable from a hang, which
   * is precisely how this bug was experienced.
   */
  onProgress?: (state: { kind: 'waiting'; seconds: number }) => void
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
  onProgress,
}: PasteArgs): Promise<PasteResult> {
  let created = 0
  let filesExpected = 0
  let filesCopied = 0
  const createdIds: string[] = []
  let failed = 0
  let rateLimited = false
  /**
   * 7.3.5: the batch waits out a rate limit ONCE rather than dropping its
   * remaining comments on the floor.
   *
   * `POST /api/comments` allows 10 per 60 seconds and sets a 60-second lockout
   * on the eleventh — a cap written to stop a reviewer spamming, which a paste
   * trips simply by being one action that creates many comments (one request
   * per thread, plus one per reply). apiFetch's own 429 retry waits at most 5
   * seconds, so against a 60-second lockout it accomplishes nothing.
   *
   * Waiting is not elegant and a minute-long paste is not nice. It is however
   * the truth about what the server will accept, and finishing slowly beats
   * losing six notes silently. Once per batch, so a genuinely throttled account
   * cannot be walked into an unbounded wait.
   */
  let waitsUsed = 0
  /**
   * Once per lockout, not once per batch. The server's window allows another
   * ten after it resets, so a batch of 25 needs to sit out two or three of them
   * — waiting only the first time rescues exactly one comment and drops the
   * rest, which is barely better than dropping them all.
   *
   * Capped at three, which covers a batch of about thirty. Past that the wait
   * is longer than anyone will sit through and the honest answer is the count
   * of what did not make it, not a five-minute spinner. The cap is also what
   * stops a genuinely throttled account from being walked into an unbounded
   * wait by a big paste.
   */
  const MAX_WAITS = 3
  const waitForLimit = async (res: Response): Promise<boolean> => {
    if (res.status !== 429) return false
    rateLimited = true
    if (waitsUsed >= MAX_WAITS) return false
    waitsUsed += 1
    const header = Number(res.headers.get('Retry-After'))
    const seconds = Number.isFinite(header) && header > 0 ? Math.min(header, 65) : 61
    onProgress?.({ kind: 'waiting', seconds })
    await new Promise((r) => setTimeout(r, seconds * 1000))
    return true
  }

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

    let res = await post(body)
    if (!res.ok && (await waitForLimit(res))) {
      // The lockout has expired; the same post is worth exactly one more try.
      res = await post(body)
    }
    if (!res.ok) {
      failed += 1
      continue
    }
    created += 1
    filesCopied += Number(res.headers.get('X-Attachments-Copied') || 0)

    // The POST response body is the whole project's comments (every caller
    // relies on that), so the new row's id travels in a header instead. Without
    // it we would be guessing which of N rows we just made.
    //
    // 7.3.3: read for EVERY thread now, not only the ones that have replies to
    // attach. It used to sit below the early return further down, so a pasted
    // note without answers never had its id recorded — and those are most of
    // them.
    const parentId = res.headers.get('X-Comment-Id')
    if (parentId) createdIds.push(parentId)

    // 6.16.0: replies ride along with their parent.
    const replies = Array.isArray(item.replies) ? item.replies : []
    if (replies.length === 0) continue

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
      let replyRes = await post(replyBody)
      if (!replyRes.ok && (await waitForLimit(replyRes))) {
        replyRes = await post(replyBody)
      }
      if (replyRes.ok) {
        created += 1
        filesCopied += Number(replyRes.headers.get('X-Attachments-Copied') || 0)
      } else {
        failed += 1
      }
    }
  }

  return {
    created,
    filesCopied,
    filesMissing: Math.max(0, filesExpected - filesCopied),
    createdIds,
    failed,
    rateLimited,
  }
}
