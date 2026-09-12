import webpush from 'web-push'
import { prisma, orgSettingsWhere, orgSettingsCreateBase } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import type { NotificationEventType } from '@/lib/external-notifications/constants'
import { loadLocaleMessages } from '@/i18n/locale'
import { logError, logMessage } from '@/lib/logging'
import { notificationDeepLink } from '@/lib/notification-links'
import { commentPlainText } from '@/lib/premiere-markers'

async function getPushLocaleText() {
  const settings = await prisma.settings.findUnique({
    where: orgSettingsWhere(),
    select: { language: true },
  })

  const locale = settings?.language || 'en'
  const messages = await loadLocaleMessages(locale).catch(() => null)

  return {
    auth: messages?.auth || {},
    webPush: messages?.push?.webPush || {},
    // 7.7.0: texts for the bell mirror (`formatBellPush`).
    bell: messages?.push?.bell || {},
    notificationsText: messages?.notificationsText || {},
  }
}

/**
 * Get VAPID subject from app domain or fallback
 * The VAPID subject identifies who is sending push notifications.
 * It can be a mailto: URL or the app's domain URL.
 */
async function getVapidSubject(): Promise<string> {
  try {
    const settings = await prisma.settings.findUnique({
      where: orgSettingsWhere(),
      select: { appDomain: true },
    })

    // Use the app domain if configured (preferred for self-hosted instances)
    if (settings?.appDomain) {
      // Ensure it's a valid URL format
      const domain = settings.appDomain.startsWith('http')
        ? settings.appDomain
        : `https://${settings.appDomain}`
      return domain
    }
  } catch {
    // Fall back to default if database not available
  }

  // Fallback: generic mailto that works for all instances
  // This is safe because VAPID subject is just an identifier for push services
  return 'mailto:push@localhost'
}

interface VapidKeys {
  publicKey: string
  privateKey: string
}

/**
 * Generate new VAPID keys
 */
function generateVapidKeys(): VapidKeys {
  const keys = webpush.generateVAPIDKeys()
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  }
}

/**
 * Get or create VAPID keys (auto-generate on first use)
 * Keys are stored encrypted in the database
 */
export async function getOrCreateVapidKeys(): Promise<VapidKeys> {
  // Try to get existing keys from settings
  const settings = await prisma.settings.findUnique({
    where: orgSettingsWhere(),
    select: { vapidPublicKey: true, vapidPrivateKey: true },
  })

  if (settings?.vapidPublicKey && settings?.vapidPrivateKey) {
    // Decrypt the private key
    return {
      publicKey: settings.vapidPublicKey,
      privateKey: decrypt(settings.vapidPrivateKey),
    }
  }

  // Generate new keys
  logMessage('[WEB-PUSH] Generating new VAPID keys...')
  const keys = generateVapidKeys()

  // Store keys (encrypt the private key)
  await prisma.settings.upsert({
    where: orgSettingsWhere(),
    create: { ...orgSettingsCreateBase(),
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: encrypt(keys.privateKey),
    },
    update: {
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: encrypt(keys.privateKey),
    },
  })

  logMessage('[WEB-PUSH] VAPID keys generated and stored')
  return keys
}

/**
 * Get the public VAPID key (for browser subscription)
 */
export async function getVapidPublicKey(): Promise<string> {
  const keys = await getOrCreateVapidKeys()
  return keys.publicKey
}

/**
 * VAPID details for ONE send, passed per call.
 *
 * 7.7.0: this used to call `webpush.setVapidDetails(...)`, which sets module-
 * wide state. Keys are per company (one Settings row each), and since the
 * bell mirror a request can push on behalf of a company other than the one
 * it is browsing as (the founder answering feedback runs as the recipient's
 * company). Two sends racing through a global setter could sign one
 * company's push with another company's key and fail with a signature
 * error. Per-call details cannot race.
 */
async function getVapidDetails(): Promise<{ subject: string; publicKey: string; privateKey: string }> {
  const keys = await getOrCreateVapidKeys()
  const subject = await getVapidSubject()
  return { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }
}

export interface PushNotificationPayload {
  title: string
  body: string
  icon?: string
  badge?: string
  tag?: string
  data?: Record<string, unknown>
  actions?: Array<{ action: string; title: string; icon?: string }>
}

interface PushSubscriptionData {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Send a push notification to a single subscription
 */
async function sendToSubscription(
  subscription: PushSubscriptionData,
  payload: PushNotificationPayload
): Promise<{ success: boolean; error?: string; statusCode?: number }> {
  try {
    const vapidDetails = await getVapidDetails()

    const pushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    }

    // web-push returns a response object with statusCode
    // 201 = Created (success), 200 = OK (success)
    const response = await webpush.sendNotification(pushSubscription, JSON.stringify(payload), {
      vapidDetails,
    })

    // Check if response indicates success (2xx status codes)
    if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
      return { success: true, statusCode: response.statusCode }
    }

    // If we get here without throwing, the notification was accepted
    return { success: true, statusCode: response.statusCode }
  } catch (error) {
    // Check if this is a WebPushError with a success status code
    // Some push services return 201 which web-push might handle oddly
    if (error instanceof webpush.WebPushError) {
      // 201 Created is actually success
      if (error.statusCode === 201 || error.statusCode === 200) {
        return { success: true, statusCode: error.statusCode }
      }

      // 410 Gone or 404 Not Found = subscription expired
      if (error.statusCode === 410 || error.statusCode === 404) {
        // Remove invalid subscription
        await prisma.pushSubscription.delete({
          where: { endpoint: subscription.endpoint },
        }).catch(() => {
          // Ignore if already deleted
        })
        logMessage('[WEB-PUSH] Removed expired subscription:', subscription.endpoint.slice(0, 50))
        return { success: false, error: 'Subscription expired', statusCode: error.statusCode }
      }

      // 7.8.1: the service's own body names the reason (bad VAPID key, wrong
      // audience, payload too large…) — the number alone never did.
      logError('[WEB-PUSH] Push error:', error.statusCode, error.message, String(error.body || '').slice(0, 300))
      return { success: false, error: `Push service error: ${error.statusCode}`, statusCode: error.statusCode }
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logError('[WEB-PUSH] Send error:', errorMessage)
    return { success: false, error: errorMessage }
  }
}

/**
 * Send push notifications to all subscribed admin devices for an event
 */
export async function sendPushNotifications(
  eventType: NotificationEventType,
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number }> {
  try {
    // 7.8.1: PNG — an SVG icon makes macOS drop the whole notification (see
    // src/app/brand/icon-192.png). No default badge (Android renders it as a
    // white silhouette; a coloured logomark there is a blob).
    const defaultIcon = '/brand/icon-192.png'
    const normalizedPayload = {
      ...payload,
      icon: payload.icon || defaultIcon,
    }

    // Get all subscriptions that include this event type
    const subscriptions = await prisma.pushSubscription.findMany({
      where: {
        subscribedEvents: {
          has: eventType,
        },
      },
      select: {
        id: true,
        endpoint: true,
        p256dh: true,
        auth: true,
      },
    })

    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0 }
    }

    let sent = 0
    let failed = 0

    // Send to all subscriptions in parallel
    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const result = await sendToSubscription(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          normalizedPayload
        )

        if (result.success) {
          // Update lastUsedAt
          await prisma.pushSubscription.update({
            where: { id: sub.id },
            data: { lastUsedAt: new Date() },
          }).catch(() => {
            // Ignore update errors
          })
        }

        return result
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        sent++
      } else {
        failed++
      }
    }

    logMessage(`[WEB-PUSH] Event ${eventType}: sent=${sent}, failed=${failed}`)
    return { sent, failed }
  } catch (error) {
    logError('[WEB-PUSH] Failed to send notifications:', error)
    return { sent: 0, failed: 0 }
  }
}

/**
 * Send a test push notification to a specific subscription
 */
export async function sendTestNotification(
  subscriptionId: string
): Promise<{ success: boolean; error?: string; statusCode?: number }> {
  const { webPush } = await getPushLocaleText()

  const subscription = await prisma.pushSubscription.findUnique({
    where: { id: subscriptionId },
    select: { endpoint: true, p256dh: true, auth: true, deviceName: true },
  })

  if (!subscription) {
    return { success: false, error: webPush.subscriptionNotFound || 'Subscription not found' }
  }

  const payload: PushNotificationPayload = {
    title: webPush.testTitle || 'FrameComment Test',
    body: (webPush.testBodyForDevice || 'Test notification for {device}')
      .replace('{device}', subscription.deviceName || webPush.thisDevice || 'this device'),
    icon: '/brand/icon-192.png',
    tag: 'test',
    // 7.8.1: the send time travels with the payload so the notification can be
    // matched to the click that caused it.
    data: { type: 'TEST', sentAt: Date.now() },
  }

  return sendToSubscription(subscription, payload)
}

/**
 * Map notification event types to user-friendly titles and create payloads
 */
export async function createNotificationPayload(
  eventType: NotificationEventType,
  data: {
    projectTitle?: string
    videoName?: string
    authorName?: string
    content?: string
    ip?: string
    email?: string
    title?: string
    body?: string
    notifyType?: string
  }
): Promise<PushNotificationPayload> {
  const { auth, webPush, notificationsText } = await getPushLocaleText()

  const basePayload = {
    icon: '/brand/icon-192.png',
    tag: eventType,
    data: { type: eventType, ...data },
  }

  switch (eventType) {
    case 'ADMIN_ACCESS':
      return {
        ...basePayload,
        title: data.title || auth.adminLogin || 'Admin Login',
        body: data.body || `${data.email || auth.someoneLabel || 'Someone'} ${auth.loggedInShort || 'logged in'}`,
      }

    case 'SHARE_ACCESS':
      return {
        ...basePayload,
        title: data.title || notificationsText.shareLinkOpenedShortTitle || 'Share Link Opened',
        body: data.body || `${data.email || notificationsText.someone || auth.someoneLabel || 'Someone'} ${(notificationsText.openedProjectShort || 'opened {projectTitle}').replace('{projectTitle}', data.projectTitle || notificationsText.aProject || 'a project')}`,
      }

    case 'CLIENT_COMMENT':
      return {
        ...basePayload,
        title: webPush.newCommentTitle || 'New Comment',
        body: `${data.authorName || notificationsText.someone || auth.someoneLabel || 'Someone'} ${webPush.onLabel || 'on'} ${data.videoName || data.projectTitle || webPush.aVideo || 'a video'}${data.content ? `: "${data.content.slice(0, 50)}${data.content.length > 50 ? '...' : ''}"` : ''}`,
      }

    case 'SECURITY_ALERT':
      return {
        ...basePayload,
        title: data.title || auth.securityAlertTitle || 'Security Alert',
        body: data.body || webPush.securityEventOccurred || 'A security event occurred',
      }

    case 'CLIENT_UPLOAD':
      return {
        ...basePayload,
        title: webPush.clientUploadTitle || 'New Upload',
        body: `${data.authorName || notificationsText.someone || auth.someoneLabel || 'Someone'} ${webPush.uploadedFilesTo || 'uploaded files to'} ${data.projectTitle || webPush.aProject || 'a project'}`,
      }

    case 'DUE_DATE_REMINDER':
      return {
        ...basePayload,
        title: data.title || webPush.deadlineReminderTitle || 'Deadline Reminder',
        body: data.body || `${data.projectTitle || webPush.aProjectCapitalized || 'A project'} ${webPush.deadlineApproaching || 'deadline is approaching'}`,
      }

    default:
      return {
        ...basePayload,
        title: webPush.defaultNotificationTitle || 'FrameComment Notification',
        body: webPush.defaultNotificationBody || 'You have a new notification',
      }
  }
}

// ─── 7.7.0: the bell, mirrored to the recipient's devices ───────────────────
//
// `sendPushNotifications` above is a broadcast: an event goes to every device
// in the company that opted into that event. The bell (`Notification` rows,
// src/lib/inapp-notifications.ts) is the opposite — addressed to one person:
// the editor whose cut got feedback, the Project Managers, the author who was
// replied to. Until 7.7.0 those rows lived only in the bell, so the phone in
// someone's pocket learned nothing until they opened the app. Every bell row
// now also goes to every device that person enrolled, unconditionally: a
// device on the list means "tell me about my things". The company-wide event
// switches in Settings are unrelated and untouched.

/** The fields of a bell row the push needs (a subset of InAppNotification). */
export interface BellPushSource {
  id: string
  type: string
  projectId: string | null
  videoId: string | null
  videoName: string | null
  folderId: string | null
  actorName: string | null
  message: string | null
  commentId?: string | null
}

export type BellPushStrings = Record<string, string | undefined>

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? '')
}

/**
 * Bell row → push payload. Pure, so it can be checked without a browser or a
 * push service. Wording mirrors the bell rows in NotificationBell.tsx: the
 * push and the row should read as the same event.
 */
export interface BellPushExtras {
  /**
   * 7.8.1: the text of the comment the row points at, already reduced to plain
   * text. The bell row itself carries none (it is a signal, by design); the
   * push shows a line of it, the way a Slack banner shows the message.
   */
  commentText?: string | null
}

export function formatBellPush(
  n: BellPushSource,
  s: BellPushStrings = {},
  extras: BellPushExtras = {},
): PushNotificationPayload {
  const actor = (n.actorName || '').trim()
  const video = (n.videoName || '').trim()
  const message = (n.message || '').trim()
  const clip = (text: string) => (text.length > 180 ? `${text.slice(0, 177)}...` : text)
  // One line for a banner: newlines become spaces, and it is cut shorter than
  // the message clip above because the video name shares the line.
  const snippet = (extras.commentText || '').replace(/\s+/g, ' ').trim()
  const shortSnippet = snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet

  let title: string
  let body: string
  switch (n.type) {
    case 'COMMENT_REPLY':
      title = actor
        ? fillTemplate(s.replyTitle || '{actor} replied to your comment', { actor })
        : s.replyTitleAnonymous || 'Someone replied to your comment'
      body = shortSnippet
        ? video
          ? fillTemplate(s.replyBodyWithText || '{video}: {text}', { video, text: shortSnippet })
          : shortSnippet
        : video
      break
    case 'FEEDBACK_UPDATE':
      title = s.feedbackTitle || 'Your feedback has a reply'
      body =
        clip(message) ||
        (actor ? fillTemplate(s.feedbackBody || '{actor} answered your report', { actor }) : '')
      break
    case 'EARLY_ACCESS':
      title = s.earlyAccessTitle || 'New early-access request'
      body = clip(message)
      break
    default:
      // NEW_COMMENTS — the first fresh comment of a round, and the manual
      // "Send to editor". Any future type that carries a video reads the same.
      if (video) {
        title = fillTemplate(s.newCommentsTitle || 'New comments on {video}', { video })
        body = shortSnippet
          ? fillTemplate(s.newCommentsBodyWithText || '{actor}: {text}', {
              actor: actor || s.someone || 'Someone',
              text: shortSnippet,
            })
          : actor
            ? fillTemplate(s.newCommentsBody || '{actor} left feedback', { actor })
            : s.newCommentsBodyAnonymous || 'Someone left feedback'
      } else {
        title = s.defaultTitle || 'FrameComment'
        body = clip(message) || s.defaultBody || 'You have a new notification'
      }
  }

  return {
    title,
    body,
    icon: '/brand/icon-192.png',
    // One tag per (type, video): a reviewer pressing "Send to editor" five
    // times replaces the notification on the editor's phone instead of
    // stacking five. The service worker sets `renotify`, so it still alerts.
    tag: `bell:${n.type}:${n.videoId ?? n.id}`,
    data: {
      type: 'IN_APP',
      bellType: n.type,
      notificationId: n.id,
      // Same destination as clicking the bell row (video, folder, comment).
      url: notificationDeepLink(n, { notificationId: n.id }) ?? '/admin',
      ...(n.projectId ? { projectId: n.projectId } : {}),
    },
  }
}

/**
 * Deliver one bell row to every device its recipient enrolled. Never throws;
 * returns counts for the log. Runs through the RLS-armed client, so the caller
 * must be in the RECIPIENT's organisation context (see `publishNotification`).
 * Cheap for people without devices: one indexed query, then done — the
 * payload (locale texts) is only built when there is somewhere to send it.
 */
export async function sendBellPush(
  userId: string,
  source: BellPushSource,
): Promise<{ sent: number; failed: number }> {
  try {
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    })
    if (subscriptions.length === 0) return { sent: 0, failed: 0 }

    const { bell } = await getPushLocaleText()

    // 7.8.1: a line of the comment itself. The row names the comment it is
    // about (the newest one, per createOrBumpNotification); read it through
    // the armed client — same company as the recipient — and never let a
    // failure here cost the notification.
    let commentText: string | null = null
    if (source.commentId) {
      try {
        const comment = await prisma.comment.findUnique({
          where: { id: source.commentId },
          select: { content: true },
        })
        if (comment?.content) commentText = commentPlainText(comment.content)
      } catch (err) {
        logError('[WEB-PUSH] comment text lookup failed (non-fatal):', err)
      }
    }

    const payload = formatBellPush(source, bell, { commentText })

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const result = await sendToSubscription(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          payload
        )
        if (result.success) {
          await prisma.pushSubscription
            .update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } })
            .catch(() => {
              // Ignore update errors
            })
        }
        return result
      })
    )

    let sent = 0
    let failed = 0
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) sent++
      else failed++
    }
    logMessage(`[WEB-PUSH] bell ${source.type} for user ${userId}: sent=${sent}, failed=${failed}`)
    return { sent, failed }
  } catch (error) {
    logError('[WEB-PUSH] bell push failed:', error)
    return { sent: 0, failed: 0 }
  }
}
