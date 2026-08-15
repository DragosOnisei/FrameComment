import { Comment } from '@prisma/client'
import { prisma, orgSettingsWhere, currentOrgId } from './db'
import { sendCommentNotificationEmail, sendAdminCommentNotificationEmail, getEmailSettings, sendEmail, getRecipientLocale } from './email'
import { generateNotificationSummaryEmail, generateAdminSummaryEmail } from './email-templates'
import { getProjectRecipients } from './recipients'
import { generateShareUrl } from './url'
import { getRedis } from './redis'
import { buildUnsubscribeUrl, generateRecipientUnsubscribeToken } from './unsubscribe'
import { normalizeNotificationDataTimecode } from '@/worker/notification-helpers'
import { logError, logMessage } from '@/lib/logging'

interface NotificationContext {
  comment: Comment
  project: { id: string; title: string; slug: string }
  video: { name: string; versionLabel: string; fps?: number | null } | null
  isReply: boolean
  attachmentNames?: string[]
}


/**
 * Send immediate notification (when schedule is IMMEDIATE)
 * @param target - 'client' to send to clients, 'admin' to send to admins
 */
export async function sendImmediateNotification(context: NotificationContext, target: 'client' | 'admin' = 'client') {
  const { comment, project, video, attachmentNames } = context

  // Check if notification was cancelled (comment deleted)
  const redis = getRedis()
  const cancelled = await redis.get(`comment_cancelled:${comment.id}`)

  if (cancelled) {
    logMessage(`[IMMEDIATE] Comment ${comment.id} notification was cancelled, skipping send`)
    return
  }

  const shareUrl = await generateShareUrl(project.slug)
  const videoName = video?.name || 'Unknown Video'
  const versionLabel = video?.versionLabel || 'Unknown Version'
  const authorEmail = comment.authorEmail?.toLowerCase() || null

  if (target === 'client') {
    // Send to clients — skip author if they are a client
    const allRecipients = await getProjectRecipients(comment.projectId)
    const recipients = allRecipients.filter(r => {
      if (!r.receiveNotifications || !r.email) return false
      // Skip the author (client who wrote this comment)
      if (!comment.isInternal && authorEmail && r.email.toLowerCase() === authorEmail) return false
      return true
    })

    if (recipients.length === 0) {
      logMessage(`[IMMEDIATE→CLIENT] Skipped - no recipients for project "${project.title}"`)
      return
    }

    logMessage(`[IMMEDIATE→CLIENT] Sending to ${recipients.length} recipient(s) for "${project.title}"`)
    logMessage(`[IMMEDIATE→CLIENT]   Video: ${videoName} (${versionLabel})`)
    logMessage(`[IMMEDIATE→CLIENT]   Author: ${comment.authorName || (comment.isInternal ? 'Admin' : 'Client')}`)

    const emailPromises = recipients.map(async (recipient) => {
      let unsubscribeUrl: string | undefined
      try {
        const token = generateRecipientUnsubscribeToken({
          recipientId: recipient.id!,
          projectId: comment.projectId,
          recipientEmail: recipient.email!,
        })
        unsubscribeUrl = buildUnsubscribeUrl(new URL(shareUrl).origin, token)
      } catch {
        unsubscribeUrl = undefined
      }

      // Resolve per-recipient locale
      const recipientLocale = await getRecipientLocale(recipient.email!)

      return sendCommentNotificationEmail({
        clientEmail: recipient.email!,
        clientName: recipient.name || 'Client',
        projectTitle: project.title,
        videoName,
        versionLabel,
        authorName: comment.authorName || (comment.isInternal ? 'Admin' : 'Client'),
        commentContent: comment.content,
        timecode: comment.timecode,
        fps: video?.fps,
        commentId: comment.id,
        shareUrl,
        unsubscribeUrl,
        attachmentNames,
        locale: recipientLocale,
      }).then(result => {
        if (result.success) {
          logMessage(`[IMMEDIATE→CLIENT]   Sent to ${recipient.email}`)
        } else {
          logError(`[IMMEDIATE→CLIENT]   Failed to ${recipient.email}: ${result.error}`)
        }
        return result
      })
    })

    await Promise.allSettled(emailPromises)
  } else {
    // Send to admins — skip author if they are an admin
    const admins = await prisma.user.findMany({
      where: {}, /* 4.3.0: all internal roles (User table is staff-only) */
      select: { email: true, name: true }
    })

    // Skip the author admin
    const targetAdmins = admins.filter(a => {
      if (comment.isInternal && authorEmail && a.email.toLowerCase() === authorEmail) return false
      return true
    })

    if (targetAdmins.length === 0) {
      logMessage(`[IMMEDIATE→ADMIN] Skipped - no admins to notify for "${project.title}"`)
      return
    }

    logMessage(`[IMMEDIATE→ADMIN] Sending to ${targetAdmins.length} admin(s) for "${project.title}"`)
    logMessage(`[IMMEDIATE→ADMIN]   Video: ${videoName} (${versionLabel})`)
    logMessage(`[IMMEDIATE→ADMIN]   Author: ${comment.authorName || (comment.isInternal ? 'Admin' : 'Client')}`)

    const result = await sendAdminCommentNotificationEmail({
      adminEmails: targetAdmins.map(a => a.email),
      clientName: comment.authorName || (comment.isInternal ? 'Admin' : 'Client'),
      clientEmail: comment.authorEmail,
      projectTitle: project.title,
      projectId: project.id,
      videoName,
      versionLabel,
      commentContent: comment.content,
      timecode: comment.timecode,
      fps: video?.fps,
      commentId: comment.id,
      shareUrl,
      attachmentNames,
    })

    if (result.success) {
      logMessage(`[IMMEDIATE→ADMIN]   ${result.message}`)
    } else {
      logError(`[IMMEDIATE→ADMIN]   Failed: ${result.message}`)
    }
  }
}

/**
 * Queue notification for later batch sending (when schedule is not IMMEDIATE)
 * @param alreadySentTo - sides already handled via IMMEDIATE, pre-mark as sent
 */
export async function queueNotification(
  context: NotificationContext,
  alreadySentTo?: { admins?: boolean; clients?: boolean }
) {
  const { comment, project, video, isReply, attachmentNames } = context

  const type = comment.isInternal ? 'ADMIN_REPLY' : 'CLIENT_COMMENT'

  logMessage(`[QUEUE] Adding ${type} to queue for "${project.title}"`)
  logMessage(`[QUEUE]   Video: ${video?.name || 'N/A'} (${video?.versionLabel || 'N/A'})`)
  logMessage(`[QUEUE]   Author: ${comment.authorName || (comment.isInternal ? 'Admin' : 'Client')}`)

  // Get parent comment context if this is a reply
  let parentCommentData = null
  if (isReply && comment.parentId) {
    const parentComment = await prisma.comment.findUnique({
      where: { id: comment.parentId },
      select: { authorName: true, content: true, timecode: true }
    })

    if (parentComment) {
      parentCommentData = {
        authorName: parentComment.authorName || 'Client',
        content: parentComment.content,
        timecode: parentComment.timecode
      }
    }
  }

  const now = new Date()

  await prisma.notificationQueue.create({
    data: {
      projectId: comment.projectId,
      type,
      // 5.0 multi-tenant: queue rows follow the request's org (comment
      // creation always runs inside an armed request context; the 'org-1'
      // fallback covers legacy/boot paths).
      organizationId: currentOrgId(),
      // Pre-mark sides that were already sent immediately
      sentToAdmins: alreadySentTo?.admins || false,
      adminSentAt: alreadySentTo?.admins ? now : undefined,
      sentToClients: alreadySentTo?.clients || false,
      clientSentAt: alreadySentTo?.clients ? now : undefined,
      data: {
        type, // Include type in data JSON for email templates
        commentId: comment.id,
        videoId: comment.videoId,
        videoName: video?.name || 'Unknown Video',
        videoLabel: video?.versionLabel,
        fps: video?.fps || null,
        authorName: comment.authorName || (comment.isInternal ? 'Admin' : 'Client'),
        authorEmail: comment.authorEmail,
        content: comment.content,
        timecode: comment.timecode,
        isReply,
        parentCommentId: comment.parentId,
        parentComment: parentCommentData,
        attachmentNames: attachmentNames || [],
        createdAt: comment.createdAt.toISOString()
      }
    }
  })

  logMessage(`[QUEUE]   Queued successfully`)
}

/**
 * Flush all pending admin notifications immediately as a summary email.
 * Called when admin notification schedule changes so queued items are not lost.
 */
export async function flushPendingAdminNotifications(): Promise<void> {
  try {
    const pendingNotifications = await prisma.notificationQueue.findMany({
      where: {
        sentToAdmins: false,
        adminFailed: false,
      },
      include: {
        project: {
          select: { id: true, title: true, slug: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    })

    if (pendingNotifications.length === 0) {
      logMessage('[FLUSH-ADMIN] No pending notifications to flush')
      return
    }

    // Filter out cancelled notifications
    const redis = getRedis()
    const validNotifications = []
    const cancelledIds: string[] = []

    for (const notification of pendingNotifications) {
      const commentId = (notification.data as any).commentId
      if (commentId) {
        const isCancelled = await redis.get(`comment_cancelled:${commentId}`)
        if (isCancelled) {
          cancelledIds.push(notification.id)
          continue
        }
      }
      validNotifications.push(notification)
    }

    if (cancelledIds.length > 0) {
      await prisma.notificationQueue.deleteMany({
        where: { id: { in: cancelledIds } }
      })
    }

    if (validNotifications.length === 0) {
      logMessage('[FLUSH-ADMIN] All pending notifications were cancelled')
      return
    }

    // Group by project
    const projectGroups: Record<string, any> = {}
    for (const notification of validNotifications) {
      const projectId = notification.projectId
      if (!projectGroups[projectId]) {
        projectGroups[projectId] = {
          projectId,
          projectTitle: notification.project.title,
          shareUrl: await generateShareUrl(notification.project.slug),
          notifications: []
        }
      }
      projectGroups[projectId].notifications.push(
        normalizeNotificationDataTimecode(notification.data)
      )
    }

    const admins = await prisma.user.findMany({
      where: {}, /* 4.3.0: all internal roles (User table is staff-only) */
      select: { email: true, name: true }
    })

    if (admins.length === 0) {
      logMessage('[FLUSH-ADMIN] No admins found')
      return
    }

    const emailSettings = await getEmailSettings()
    const companyName = emailSettings.companyName || 'FrameComment'
    const projects = Object.values(projectGroups)

    logMessage(`[FLUSH-ADMIN] Sending ${validNotifications.length} queued notification(s) to ${admins.length} admin(s)`)

    for (const admin of admins) {
      const summaryEmail = await generateAdminSummaryEmail({
        companyName,
        accentColor: emailSettings.accentColor || undefined,
        appDomain: emailSettings.appDomain || undefined,
        adminName: admin.name || '',
        period: 'before schedule change',
        projects,
        locale: emailSettings.language || 'en',
      })

      await sendEmail({
        to: admin.email,
        subject: summaryEmail.subject,
        html: summaryEmail.html,
      })
    }

    // Mark as sent
    const ids = validNotifications.map(n => n.id)
    const now = new Date()
    await prisma.notificationQueue.updateMany({
      where: { id: { in: ids } },
      data: { sentToAdmins: true, adminSentAt: now }
    })

    await prisma.settings.update({
      where: orgSettingsWhere(),
      data: { lastAdminNotificationSent: now }
    })

    logMessage(`[FLUSH-ADMIN] Flushed ${validNotifications.length} notification(s)`)
  } catch (error) {
    logError('[FLUSH-ADMIN] Error flushing notifications:', error)
  }
}

/**
 * Flush all pending client notifications for a project immediately as a summary email.
 * Called when a project's client notification schedule changes so queued items are not lost.
 */
export async function flushPendingClientNotifications(projectId: string): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        slug: true,
        notificationQueue: {
          where: {
            sentToClients: false,
            clientFailed: false,
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    })

    if (!project || project.notificationQueue.length === 0) {
      logMessage(`[FLUSH-CLIENT] No pending notifications for project ${projectId}`)
      return
    }

    // Filter out cancelled notifications
    const redis = getRedis()
    const validNotifications = []
    const cancelledIds: string[] = []

    for (const notification of project.notificationQueue) {
      const commentId = (notification.data as any).commentId
      if (commentId) {
        const isCancelled = await redis.get(`comment_cancelled:${commentId}`)
        if (isCancelled) {
          cancelledIds.push(notification.id)
          continue
        }
      }
      validNotifications.push(notification)
    }

    if (cancelledIds.length > 0) {
      await prisma.notificationQueue.deleteMany({
        where: { id: { in: cancelledIds } }
      })
    }

    if (validNotifications.length === 0) {
      logMessage(`[FLUSH-CLIENT] All pending notifications were cancelled for project ${projectId}`)
      return
    }

    const allRecipients = await getProjectRecipients(projectId)
    const recipients = allRecipients.filter(r => r.receiveNotifications && r.email)

    if (recipients.length === 0) {
      logMessage(`[FLUSH-CLIENT] No recipients with notifications enabled for project ${projectId}`)
      return
    }

    const emailSettings = await getEmailSettings()
    const companyName = emailSettings.companyName || 'FrameComment'
    const shareUrl = await generateShareUrl(project.slug)
    const notifications = validNotifications.map(n =>
      normalizeNotificationDataTimecode(n.data as any)
    )

    logMessage(`[FLUSH-CLIENT] Sending ${validNotifications.length} queued notification(s) to ${recipients.length} recipient(s) for "${project.title}"`)

    for (const recipient of recipients) {
      let unsubscribeUrl: string | undefined
      try {
        const token = generateRecipientUnsubscribeToken({
          recipientId: recipient.id!,
          projectId: project.id,
          recipientEmail: recipient.email!,
        })
        unsubscribeUrl = buildUnsubscribeUrl(new URL(shareUrl).origin, token)
      } catch {
        unsubscribeUrl = undefined
      }

      const summaryEmail = await generateNotificationSummaryEmail({
        companyName,
        accentColor: emailSettings.accentColor || undefined,
        projectTitle: project.title,
        shareUrl,
        recipientName: recipient.name || recipient.email!,
        recipientEmail: recipient.email!,
        period: 'before schedule change',
        notifications,
        unsubscribeUrl,
        locale: await getRecipientLocale(recipient.email!),
      })

      await sendEmail({
        to: recipient.email!,
        subject: summaryEmail.subject,
        html: summaryEmail.html,
      })
    }

    // Mark as sent
    const ids = validNotifications.map(n => n.id)
    const now = new Date()
    await prisma.notificationQueue.updateMany({
      where: { id: { in: ids } },
      data: { sentToClients: true, clientSentAt: now }
    })

    await prisma.project.update({
      where: { id: projectId },
      data: { lastClientNotificationSent: now }
    })

    logMessage(`[FLUSH-CLIENT] Flushed ${validNotifications.length} notification(s) for "${project.title}"`)
  } catch (error) {
    logError('[FLUSH-CLIENT] Error flushing notifications:', error)
  }
}
