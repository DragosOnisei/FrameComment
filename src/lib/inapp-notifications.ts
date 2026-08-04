/**
 * 3.5.0+ In-app notification system (the admin "bell").
 *
 * This module is the single source of truth for the internal, in-app
 * notifications that power the bell in the admin top bar. It is
 * deliberately separate from `NotificationQueue` (which drives
 * EXTERNAL email / push delivery to clients + admins).
 *
 * Flow: a reviewer clicks "Send to editor" on a video → we create (or
 * bump) one `Notification` row addressed to that video's uploader
 * (`Video.createdById`) → we publish it on a Redis channel so the
 * editor's bell updates live over SSE, with no page refresh.
 *
 * Why the `prisma as any` cast below: the `Notification` model is new
 * in 3.5.0. The generated Prisma client always includes it after
 * `prisma generate` (which the Docker build runs), but keeping the
 * delegate access behind a single typed boundary here means the rest
 * of the codebase consumes fully-typed helpers and never has to know
 * about the model's generated delegate. All public functions in this
 * file are explicitly typed.
 */

import { prisma } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import { logError } from '@/lib/logging'

// Narrow accessor for the new delegate. Confined to this file.
const notificationDelegate = () => (prisma as any).notification

/** Redis pub/sub channel for one recipient's live bell stream. */
export function notificationChannel(userId: string): string {
  return `notif:user:${userId}`
}

/**
 * Shape sent to the client (bell list + SSE events). Dates are
 * serialized to ISO strings so it survives JSON.stringify over the
 * wire without any client-side Date reconstruction surprises.
 */
export interface InAppNotification {
  id: string
  type: string
  // 5.14: nullable — EARLY_ACCESS notifications have no project/video;
  // they carry `message` instead.
  projectId: string | null
  videoId: string | null
  videoName: string | null
  folderId: string | null
  actorName: string | null
  message: string | null
  isRead: boolean
  createdAt: string
}

interface NotificationRow {
  id: string
  type: string
  projectId: string | null
  videoId: string | null
  videoName: string | null
  folderId: string | null
  actorName: string | null
  message?: string | null
  isRead: boolean
  createdAt: Date | string
}

export function serializeNotification(row: NotificationRow): InAppNotification {
  return {
    id: row.id,
    type: row.type,
    projectId: row.projectId ?? null,
    videoId: row.videoId ?? null,
    videoName: row.videoName ?? null,
    folderId: row.folderId ?? null,
    actorName: row.actorName ?? null,
    message: row.message ?? null,
    isRead: row.isRead,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
  }
}

/**
 * Create a notification for the recipient, OR bump an existing unread
 * one for the same (recipient, video) to the top instead of stacking
 * duplicates. Returns the resulting row, serialized.
 *
 * Dedupe is intentional: a reviewer can leave a batch of comments and
 * hit "Send to editor" repeatedly; the editor should see one live
 * entry per video, freshened — not ten identical rows.
 */
export async function createOrBumpNotification(params: {
  recipientId: string
  projectId: string
  videoId: string
  videoName: string
  folderId?: string | null
  actorName?: string | null
  type?: string
  /** 5.0 multi-tenant: explicit owning org (worker paths run outside a
   *  request context). Defaults to 'org-1' when omitted. */
  organizationId?: string | null
}): Promise<InAppNotification> {
  const {
    recipientId,
    projectId,
    videoId,
    videoName,
    folderId = null,
    actorName = null,
    type = 'NEW_COMMENTS',
    organizationId = null,
  } = params

  const delegate = notificationDelegate()

  const existing = await delegate.findFirst({
    where: { recipientId, videoId, isRead: false },
    orderBy: { createdAt: 'desc' },
  })

  let row: NotificationRow
  if (existing) {
    // Bump to "now" so it floats to the top of the bell, and refresh
    // the actor / denormalized name in case they changed.
    row = await delegate.update({
      where: { id: existing.id },
      data: {
        createdAt: new Date(),
        actorName,
        videoName,
        folderId,
        type,
      },
    })
  } else {
    row = await delegate.create({
      data: {
        recipientId,
        projectId,
        videoId,
        videoName,
        folderId,
        actorName,
        type,
        organizationId: organizationId ?? 'org-1',
      },
    })
  }

  return serializeNotification(row)
}

/**
 * Publish a notification on the recipient's Redis channel so any open
 * SSE stream delivers it live. Best-effort: a Redis hiccup must not
 * fail the originating request (the row is already persisted and the
 * polling fallback will pick it up).
 */
export async function publishNotification(
  recipientId: string,
  notification: InAppNotification,
): Promise<void> {
  try {
    await getRedis().publish(
      notificationChannel(recipientId),
      JSON.stringify(notification),
    )
  } catch (err) {
    logError('[inapp-notifications] publish failed:', err)
  }
}

/**
 * 4.3.x: auto "Send to editor" on the FIRST comment of a review round, plus
 * Project Manager fan-out.
 *
 * Replaces the manual "Send to editor" button (people kept forgetting to press
 * it). Called from the comment-create route whenever a comment is posted.
 *
 * Recipients on the first comment of a round:
 *   - the video's uploader (the "editor"), and
 *   - every Project Manager (level 60): PMs are pinged for EVERY video that
 *     gets a comment, not only the ones they uploaded.
 * The person who just commented is never pinged about their own comment.
 *
 * A reviewer can easily leave 100 comments in one sitting, so to avoid 100 bell
 * pings we notify ONLY on the FIRST comment of a version, then stay silent no
 * matter how many more comments arrive — AND even after a recipient has read the
 * notification (we key off comment COUNT, not read state). The ping re-arms only
 * when a version's comment count is back at zero, which in practice means the
 * editor uploaded a NEW version: each stacked version is its own Video row with
 * its own, initially empty, comment set.
 *
 * Safe no-op (never throws): the video is gone, or there is no one left to
 * notify (no uploader on record and no Project Managers).
 */
export async function maybeNotifyEditorForComment(params: {
  videoId: string
  actorUserId: string | null
  actorName: string | null
}): Promise<void> {
  try {
    const video = (await prisma.video.findUnique({
      where: { id: params.videoId },
      select: {
        id: true,
        name: true,
        projectId: true,
        folderId: true,
        createdById: true,
        deletedAt: true,
        // 5.0 multi-tenant: notifications follow the video's org.
        organizationId: true,
      } as any,
    })) as any
    if (!video || video.deletedAt) return

    // This helper runs AFTER the comment is created, so the just-posted comment
    // is already counted → count === 1 means it's the first of the round.
    const commentCount = await prisma.comment.count({ where: { videoId: video.id } })
    if (commentCount > 1) return

    // Build the recipient set: the uploader (if any) plus every Project Manager.
    // Raw SQL for the PM lookup so it keeps working even before `prisma generate`
    // knows the PROJECT_MANAGER enum value.
    const recipientIds = new Set<string>()
    if (video.createdById) recipientIds.add(video.createdById)
    try {
      const projectManagers = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "User" WHERE "role" = 'PROJECT_MANAGER'`,
      )
      for (const pm of projectManagers) recipientIds.add(pm.id)
    } catch (pmErr) {
      logError('[maybeNotifyEditorForComment] Project Manager lookup failed (non-fatal):', pmErr)
    }

    // Never ping the person who just commented about their own comment.
    if (params.actorUserId) recipientIds.delete(params.actorUserId)
    if (recipientIds.size === 0) return

    for (const recipientId of recipientIds) {
      const notification = await createOrBumpNotification({
        recipientId,
        projectId: video.projectId,
        videoId: video.id,
        videoName: video.name,
        folderId: video.folderId,
        actorName: params.actorName,
        organizationId: (video as any).organizationId ?? null,
      })
      await publishNotification(recipientId, notification)
    }
  } catch (err) {
    logError('[maybeNotifyEditorForComment] failed (non-fatal):', err)
  }
}

/**
 * Recent notifications for a recipient, newest first.
 *
 * 4.x: the bell is now an inbox, not a "pending" queue — we return BOTH
 * read and unread rows (capped at `limit`) so a notification stays visible
 * after it's been read (it just loses its unread dot) and can be filtered
 * client-side into All / Unread / Read tabs. A row leaves the list only when
 * it's explicitly deleted. `unreadCount` is the authoritative badge number
 * (all unread rows, not just the ones in this page).
 */
export async function listNotifications(
  recipientId: string,
  limit = 50,
): Promise<{ notifications: InAppNotification[]; unreadCount: number }> {
  const delegate = notificationDelegate()
  const [rows, unreadCount] = await Promise.all([
    delegate.findMany({
      where: { recipientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    delegate.count({ where: { recipientId, isRead: false } }),
  ])
  return {
    notifications: (rows as NotificationRow[]).map(serializeNotification),
    unreadCount,
  }
}

/** Mark a single notification read (scoped to the owner). */
export async function markNotificationRead(
  recipientId: string,
  id: string,
): Promise<void> {
  const delegate = notificationDelegate()
  await delegate.updateMany({
    where: { id, recipientId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  })
}

/** Mark a single notification UNread again (scoped to the owner). */
export async function markNotificationUnread(
  recipientId: string,
  id: string,
): Promise<void> {
  const delegate = notificationDelegate()
  await delegate.updateMany({
    where: { id, recipientId, isRead: true },
    data: { isRead: false, readAt: null },
  })
}

/** Permanently remove a single notification (scoped to the owner). */
export async function deleteNotification(
  recipientId: string,
  id: string,
): Promise<void> {
  const delegate = notificationDelegate()
  await delegate.deleteMany({ where: { id, recipientId } })
}

/** Mark every unread notification for a recipient as read. */
export async function markAllNotificationsRead(
  recipientId: string,
): Promise<void> {
  const delegate = notificationDelegate()
  await delegate.updateMany({
    where: { recipientId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  })
}

/** Mark every notification for a recipient as UNread. */
export async function markAllNotificationsUnread(
  recipientId: string,
): Promise<void> {
  const delegate = notificationDelegate()
  await delegate.updateMany({
    where: { recipientId, isRead: true },
    data: { isRead: false, readAt: null },
  })
}
