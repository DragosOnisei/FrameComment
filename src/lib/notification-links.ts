/**
 * 7.7.0: the bell's deep link, shared by the bell (browser) and the web-push
 * sender (server).
 *
 * This function lived inside `NotificationBell.tsx` from 3.5.0 until a push
 * notification needed to open the very same page a bell row opens — video,
 * folder and, since 6.14.0, the exact comment. One function keeps the two
 * paths from drifting apart: the push and the row always land in the same
 * place. Browser-safe on purpose (no imports), so a server module can use it
 * without dragging client code along.
 *
 * A logged-out browser that follows the link is bounced through /login and
 * comes back here afterwards (7.5.0 post-login redirect).
 */
export interface NotificationLinkTarget {
  projectId: string | null
  videoId?: string | null
  videoName: string | null
  folderId?: string | null
  commentId?: string | null
}

export function notificationDeepLink(n: NotificationLinkTarget): string | null {
  // 5.14: EARLY_ACCESS rows (landing-page requests) have no video to open;
  // 7.3.1 FEEDBACK_UPDATE rows neither. Clicking those just marks them read.
  if (!n.projectId || !n.videoName) return null
  // Include the STABLE video id so the review page can resolve the video even
  // if its display name changed (rename / version-stack) since the notification
  // was created — `video` (name) stays as a fallback for older links.
  const params = new URLSearchParams({ video: n.videoName })
  if (n.videoId) params.set('videoId', n.videoId)
  if (n.folderId) params.set('folderId', n.folderId)
  // 6.14.0: land ON the comment. The review page already knows how to read
  // `?comment=` — it scrolls the thread to that card and lifts it.
  if (n.commentId) params.set('comment', n.commentId)
  return `/admin/projects/${n.projectId}/share?${params.toString()}`
}
