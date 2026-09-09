/**
 * 7.7.0: browser-side web-push plumbing shared by the enrolment bar
 * (`PushEnrollmentBanner`) and the Settings panel (`WebPushSection`).
 *
 * Until 7.7.0 all of this lived inside WebPushSection, which meant the only
 * way onto the push list was Settings → Notifications → Browser → Enable —
 * a path nobody on a busy team walks. The bar needs the same subscribe
 * routine, so it moved here. The decision logic (ask / subscribe quietly /
 * stay silent) is in `push-enrollment.ts` and is pure; this file is the part
 * that touches the browser and the API.
 *
 * Browser-only: localStorage, navigator, the API client. Never import from
 * server code.
 */

import { apiFetch, apiPost } from '@/lib/api-client'

/** Server-side subscription id for THIS browser (per origin, not per user). */
export const PUSH_SUBSCRIPTION_ID_KEY = 'framecomment_push_subscription_id'
/** Set when the person presses Disable in Settings; cleared on Enable. */
export const PUSH_OPT_OUT_KEY = 'fc:push-opted-out'
/** Timestamp of the last "Not now" on the enrolment bar. */
export const PUSH_PROMPT_DISMISSED_KEY = 'fc:push-prompt-dismissed-at'
/** Timestamp of the last failed silent subscription. */
export const PUSH_AUTO_FAILED_KEY = 'fc:push-auto-failed-at'
/** Timestamp of the last "Got it" on the iPhone/iPad Home Screen hint. */
export const PUSH_IOS_HINT_DISMISSED_KEY = 'fc:push-ios-hint-dismissed-at'

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** localStorage can throw (private mode, blocked site data): never let it. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function readTimestamp(key: string): number | null {
  const raw = readStored(key)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function writeTimestamp(key: string, now = Date.now()): void {
  try {
    window.localStorage.setItem(key, String(now))
  } catch {
    /* best effort */
  }
}

export function readFlag(key: string): boolean {
  return readStored(key) === '1'
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    /* best effort */
  }
}

/** Standard VAPID public-key decoding for `pushManager.subscribe`. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

/**
 * `navigator.serviceWorker.ready` never settles when registration failed
 * (blocked, or /sw.js unreachable), so anything awaiting it would hang for
 * the life of the page. Give up after a while and report "no worker".
 */
export async function getServiceWorkerRegistration(
  timeoutMs = 15000,
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  const timeout = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout])
  } catch {
    return null
  }
}

export async function fetchVapidPublicKey(): Promise<string> {
  const response = await apiFetch('/api/push/vapid-public-key')
  if (!response.ok) throw new Error('Failed to get VAPID key')
  const data = await response.json().catch(() => null)
  if (!data?.publicKey || typeof data.publicKey !== 'string') {
    throw new Error('Failed to get VAPID key')
  }
  return data.publicKey
}

function sameApplicationServerKey(
  subscription: PushSubscription,
  publicKey: Uint8Array,
): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return true // browsers that do not expose it: assume the same
  const a = new Uint8Array(current)
  if (a.length !== publicKey.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== publicKey[i]) return false
  return true
}

export interface SubscribeThisDeviceOptions {
  /** Reuse an already-resolved registration (the bar has one). */
  registration?: ServiceWorkerRegistration | null
  /** Reuse a prefetched key (the bar fetches it before the click). */
  vapidPublicKey?: string
  /**
   * Company-wide events for a device the server has NOT seen before. The bar
   * passes `[]`: a device enrolled on entry gets the person's own bell
   * notifications and nothing else until they add events in Settings. Left
   * out, the server keeps its default (everything on) — the Settings path.
   */
  initialEvents?: string[]
  /** Company-wide events to SET, on new and existing devices alike. */
  subscribedEvents?: string[]
}

export interface SubscribeThisDeviceResult {
  subscriptionId: string | null
  deviceName: string | null
}

/**
 * Subscribe this browser with the push service and register the result with
 * the server. Requires notification permission to be granted already; the
 * caller asks for it (inside the user's click, where Safari insists it must
 * happen).
 *
 * If the browser already holds a subscription for a DIFFERENT VAPID key (the
 * company's keys were regenerated), it is replaced — pushing to it would only
 * ever fail with a signature error and nothing would clean it up.
 */
export async function subscribeThisDevice(
  opts: SubscribeThisDeviceOptions = {},
): Promise<SubscribeThisDeviceResult> {
  const registration = opts.registration ?? (await getServiceWorkerRegistration())
  if (!registration) throw new Error('Service worker is not ready')

  const publicKey = opts.vapidPublicKey ?? (await fetchVapidPublicKey())
  const applicationServerKey = urlBase64ToUint8Array(publicKey)

  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameApplicationServerKey(subscription, applicationServerKey)) {
    await subscription.unsubscribe().catch(() => {})
    subscription = null
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as BufferSource,
    })
  }

  const keys = subscription.toJSON().keys
  const data = await apiPost('/api/push/subscribe', {
    endpoint: subscription.endpoint,
    keys: { p256dh: keys?.p256dh, auth: keys?.auth },
    ...(opts.subscribedEvents ? { subscribedEvents: opts.subscribedEvents } : {}),
    ...(opts.initialEvents ? { initialEvents: opts.initialEvents } : {}),
  })

  const subscriptionId: string | null =
    typeof data?.subscriptionId === 'string' ? data.subscriptionId : null
  try {
    if (subscriptionId) window.localStorage.setItem(PUSH_SUBSCRIPTION_ID_KEY, subscriptionId)
    // Subscribing is the opposite of opting out.
    window.localStorage.removeItem(PUSH_OPT_OUT_KEY)
  } catch {
    /* best effort */
  }

  return {
    subscriptionId,
    deviceName: typeof data?.deviceName === 'string' ? data.deviceName : null,
  }
}
