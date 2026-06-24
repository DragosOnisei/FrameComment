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
  projectId: string
  videoId: string
  videoName: string
  folderId: string | null
  actorName: string | null
  isRead: boolean
  createdAt: string
}

interface NotificationRow {
  id: string
  type: string
  projectId: string
  videoId: string
  videoName: string
  folderId: string | null
  actorName: string | null
  isRead: boolean
  createdAt: Date | string
}

export function serializeNotification(row: NotificationRow): InAppNotification {
  return {
    id: row.id,
    type: row.type,
    projectId: row.projectId,
    videoId: row.videoId,
    videoName: row.videoName,
    folderId: row.folderId ?? null,
    actorName: row.actorName ?? null,
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
}): Promise<InAppNotification> {
  const {
    recipientId,
    projectId,
    videoId,
    videoName,
    folderId = null,
    actorName = null,
    type = 'NEW_COMMENTS',
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
 * Pending notifications for a recipient, newest first.
 *
 * The bell is a "pending inbox": only UNREAD rows are returned. Once a
 * notification is clicked (marked read) it drops out of this list and
 * won't come back on the next poll/refresh — so a handled item simply
 * disappears, which is the behaviour users expect.
 */
export async function listNotifications(
  recipientId: string,
  limit = 30,
): Promise<{ notifications: InAppNotification[]; unreadCount: number }> {
  const delegate = notificationDelegate()
  const [rows, unreadCount] = await Promise.all([
    delegate.findMany({
      where: { recipientId, isRead: false },
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
