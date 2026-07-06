/**
 * Comment Sanitization Utility
 *
 * SECURITY-FIRST: Zero PII exposure policy
 * - Clients NEVER see real names or emails (even on public shares)
 * - Only admins in admin panel get full data for management
 * - All email/notification handling is server-side only
 *
 * Extracted from duplicate code in:
 * - src/app/api/comments/route.ts
 * - src/app/api/comments/[id]/route.ts
 * - src/app/api/share/[token]/comments/route.ts
 */
import { secondsToTimecode, parseTimecodeInput, isValidTimecode } from './timecode'

// Fallback for legacy comments that still have a numeric timestamp column
const normalizeTimecode = (comment: any): string => {
  if (comment.timecode && typeof comment.timecode === 'string') {
    const trimmed = comment.timecode.trim()

    if (isValidTimecode(trimmed)) {
      return trimmed
    }

    // Handle legacy seconds stored as a string (e.g., "36" or "36.5")
    if (!Number.isNaN(Number(trimmed)) && !trimmed.includes(':')) {
      return secondsToTimecode(parseFloat(trimmed), 24)
    }

    // Attempt to normalize other partial formats (MM:SS, HH:MM:SS)
    try {
      return parseTimecodeInput(trimmed, 24)
    } catch {
      // Fall through to default below
    }
  }

  if (typeof comment.timestamp === 'number') {
    return secondsToTimecode(comment.timestamp, 24)
  }

  return '00:00:00:00'
}

/**
 * Build a stable `Client N` index for the set of comments returned in
 * one listing (1.0.7+). Anonymous guests on a share link all show up
 * as "Client" by default — useless when multiple people from one
 * agency post feedback on the same link. We walk the comment tree
 * (including replies), sort by creation time, and assign each unique
 * guest `editorSessionId` a sequential index in first-seen order so
 * the labels stay consistent across viewers and across reloads.
 *
 * Authenticated / admin / internal comments don't get an index — they
 * keep whatever name they already had.
 */
export function buildGuestSessionIndex(
  topLevelComments: any[],
): Map<string, number> {
  const flat: any[] = []
  const walk = (list: any[] | undefined) => {
    if (!list) return
    for (const c of list) {
      flat.push(c)
      if (Array.isArray(c.replies) && c.replies.length) walk(c.replies)
    }
  }
  walk(topLevelComments)
  flat.sort((a, b) => {
    const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0
    return ta - tb
  })

  const index = new Map<string, number>()
  for (const c of flat) {
    if (c.userId) continue // authenticated user — they have a real name
    if (c.isInternal) continue // admin comment — labelled "Admin"
    const sid = c.editorSessionId
    if (!sid) continue
    if (index.has(sid)) continue
    index.set(sid, index.size + 1)
  }
  return index
}

export function sanitizeComment(
  comment: any,
  isAdmin: boolean,
  isAuthenticated: boolean,
  clientName?: string,
  guestIndex?: Map<string, number>,
  /**
   * 1.2.0+: caller's identity for the `mine` flag on each reaction so the
   * client can render its own reactions as toggled-on without re-deriving
   * the comparison. Pass the share-token session id OR `client:<browserId>`
   * for guests, or the admin user id for logged-in viewers.
   */
  viewerSessionId?: string | null,
) {
  const normalizedTimecode = normalizeTimecode(comment)

  const sanitized: any = {
    id: comment.id,
    projectId: comment.projectId,
    videoId: comment.videoId,
    videoVersion: comment.videoVersion,
    timecode: normalizedTimecode,
    timecodeEnd: comment.timecodeEnd || null,
    // Sub-second precision capture moment (1.0.3+). Used as the source of
    // truth for click-to-seek. Null on legacy comments — clients fall back
    // to deriving seconds from `timecode` when this is missing.
    timestampMs: typeof comment.timestampMs === 'number' ? comment.timestampMs : null,
    annotations: comment.annotations || null,
    content: comment.content,
    isInternal: comment.isInternal,
    // 3.8.x: true when this comment was pasted in from another version.
    // Drives the "Copied" tag in the thread. Coerced to boolean so a
    // stale row (pre-migration) surfaces as false instead of undefined.
    isCopied: !!comment.isCopied,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    parentId: comment.parentId,
    // Expose the editor session id so the share-page client can compare
    // against its own session and decide whether to show the Edit button.
    // The session id is not personal data; it's a per-tab identifier the
    // client already holds. Admin client gets it too for completeness.
    editorSessionId: comment.editorSessionId || null,
    // 1.2.0+: resolved bookkeeping (Frame.io-style "Mark as done").
    isResolved: !!comment.isResolved,
    resolvedAt: comment.resolvedAt || null,
    resolvedBy: comment.resolvedBy || null,
  }

  // Compute a "Client N" suffix once per call so each branch below
  // can fall back to it whenever a guest comment lacks a real name
  // (1.0.7+). Returns just "Client" when no index is supplied or the
  // session isn't in the map — keeping backward compatibility.
  const numberedClient = (() => {
    if (!guestIndex || !comment.editorSessionId) return 'Client'
    const n = guestIndex.get(comment.editorSessionId)
    return typeof n === 'number' && n > 0 ? `Client ${n}` : 'Client'
  })()
  const looksGeneric = (n?: string | null) =>
    !n || !n.trim() || n.trim().toLowerCase() === 'client'

  // NEVER expose real names or emails to non-admins
  // Use generic labels only
  if (isAdmin) {
    // Admins get real data for management purposes only — but when
    // the stored authorName is missing/generic, surface the
    // `Client N` index so they can still tell agency reviewers apart.
    sanitized.authorName = looksGeneric(comment.authorName)
      ? (comment.isInternal ? 'Admin' : numberedClient)
      : comment.authorName
    sanitized.authorEmail = comment.authorEmail
    sanitized.userId = comment.userId
    if (comment.user) {
      sanitized.user = {
        id: comment.user.id,
        name: comment.user.name,
        email: comment.user.email
      }
    }
  } else if (isAuthenticated) {
    // Authenticated share users see author names but never emails.
    // For non-internal comments, prefer the stored name; if that's
    // missing or generic, prefer the project's client name; if THAT
    // is also generic (literally "Client", because the project has
    // no companyName / primary recipient), surface the per-session
    // numbered label so two anonymous reviewers stay distinguishable.
    let label: string
    if (comment.isInternal) {
      label = comment.authorName || 'Admin'
    } else if (!looksGeneric(comment.authorName)) {
      label = comment.authorName
    } else if (!looksGeneric(clientName)) {
      label = clientName as string
    } else {
      label = numberedClient
    }
    sanitized.authorName = label
  } else {
    // Guests/public: generic labels only, no PII. Numbered when
    // possible so multiple anonymous reviewers don't collapse into
    // a single "Client".
    sanitized.authorName = comment.isInternal ? 'Admin' : numberedClient
  }

  // Pass through assets (safe subset already selected by Prisma query)
  if (comment.assets && Array.isArray(comment.assets)) {
    sanitized.assets = comment.assets.map((asset: any) => ({
      id: asset.id,
      fileName: asset.fileName,
      fileSize: typeof asset.fileSize === 'bigint' ? asset.fileSize.toString() : String(asset.fileSize),
      fileType: asset.fileType,
      category: asset.category,
      createdAt: asset.createdAt,
    }))
  }

  // 1.2.0+: surface reactions grouped by emoji so the UI gets a stable
  // counts-per-emoji shape with a `mine` flag for toggle highlighting.
  // The raw rows are also passed through (without sessionId) so the
  // client can render avatars / tooltips if it wants.
  if (Array.isArray(comment.reactions)) {
    type RawReaction = {
      id: string
      emoji: string
      authorName: string | null
      sessionId: string
      createdAt: Date | string
    }
    const groups = new Map<string, {
      emoji: string
      count: number
      mine: boolean
      firstAt: number
      reactors: { id: string; authorName: string | null; createdAt: Date | string }[]
    }>()
    for (const r of comment.reactions as RawReaction[]) {
      const key = r.emoji
      const t = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime()
      const existing = groups.get(key)
      const isMine = !!viewerSessionId && r.sessionId === viewerSessionId
      if (existing) {
        existing.count += 1
        if (isMine) existing.mine = true
        existing.firstAt = Math.min(existing.firstAt, t)
        existing.reactors.push({ id: r.id, authorName: r.authorName, createdAt: r.createdAt })
      } else {
        groups.set(key, {
          emoji: r.emoji,
          count: 1,
          mine: isMine,
          firstAt: t,
          reactors: [{ id: r.id, authorName: r.authorName, createdAt: r.createdAt }],
        })
      }
    }
    sanitized.reactions = Array.from(groups.values())
      .sort((a, b) => a.firstAt - b.firstAt)
      .map(({ firstAt: _firstAt, ...rest }) => rest)
  } else {
    sanitized.reactions = []
  }

  // Recursively sanitize replies — forward the same guest index so
  // a reply by Client 2 stays labelled consistently regardless of
  // depth.
  if (comment.replies && Array.isArray(comment.replies)) {
    sanitized.replies = comment.replies.map((reply: any) =>
      sanitizeComment(reply, isAdmin, isAuthenticated, clientName, guestIndex, viewerSessionId)
    )
  }

  return sanitized
}
