/**
 * 7.7.0: the decision logic behind the "Enable notifications" bar that greets
 * every team member on entering the admin app.
 *
 * Pure on purpose — no DOM, no storage, no network — so it can be exercised
 * with plain inputs (see the verification notes in the 7.7.0 changelog). The
 * browser plumbing that feeds it lives in `push-client.ts`; the component
 * that renders it is `PushEnrollmentBanner`.
 *
 * Why a bar with a button rather than the browser's own prompt on page load:
 * Safari and Firefox refuse `Notification.requestPermission()` unless it runs
 * inside a user gesture, and Chrome demotes sites that ask on load to its
 * "quiet" prompt that most people never notice. One click on our bar is the
 * only way the native prompt reliably appears everywhere.
 */

export type PushEnrollmentDecision = 'subscribe-silently' | 'prompt' | 'nothing'

/** How long "Not now" keeps the bar away. */
export const PUSH_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000
/** After a failed silent subscription, wait this long before trying again. */
export const PUSH_AUTO_RETRY_MS = 24 * 60 * 60 * 1000
/** How long "Got it" keeps the iPhone/iPad Home Screen hint away. */
export const PUSH_IOS_HINT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000

export interface PushEnrollmentState {
  /** Service worker + PushManager + Notification all present. */
  supported: boolean
  permission: 'default' | 'granted' | 'denied'
  /** `registration.pushManager.getSubscription()` returned one. */
  hasBrowserSubscription: boolean
  /** This browser remembers a server-side subscription id for itself. */
  hasStoredId: boolean
  /** The person pressed Disable in Settings on this browser. */
  optedOut: boolean
  /** When "Not now" was last pressed, or null. */
  dismissedAt: number | null
  /** When a silent subscription last failed, or null. */
  lastAutoFailureAt: number | null
  now: number
}

export function decidePushEnrollment(s: PushEnrollmentState): PushEnrollmentDecision {
  if (!s.supported) return 'nothing'
  // Disable in Settings is a decision; the bar must never quietly undo it.
  if (s.optedOut) return 'nothing'
  // Blocked in the browser: only the person can change that, and Settings
  // already explains how (lock icon → allow notifications).
  if (s.permission === 'denied') return 'nothing'
  if (s.permission === 'granted') {
    // Already subscribed AND the server knows this device: nothing to do.
    if (s.hasBrowserSubscription && s.hasStoredId) return 'nothing'
    // Permission is there but the device is not registered (fresh login on
    // this browser, cleared site data, browser dropped the subscription):
    // finish the job without asking — the person already said yes once.
    if (
      s.lastAutoFailureAt !== null &&
      s.now - s.lastAutoFailureAt < PUSH_AUTO_RETRY_MS
    ) {
      return 'nothing'
    }
    return 'subscribe-silently'
  }
  // permission === 'default': never asked, or the native dialog was closed.
  if (s.dismissedAt !== null && s.now - s.dismissedAt < PUSH_PROMPT_SNOOZE_MS) {
    return 'nothing'
  }
  return 'prompt'
}

export interface IosInstallHintInput {
  userAgent: string
  platform: string
  maxTouchPoints: number
  /** Running as a Home Screen web app already. */
  standalone: boolean
  pushSupported: boolean
  dismissedAt: number | null
  now: number
}

/**
 * iOS (16.4+) delivers web push only to sites added to the Home Screen; in a
 * Safari tab `PushManager` simply does not exist. Instead of showing nothing,
 * tell iPhone/iPad people the one step that makes notifications possible.
 * iPadOS reports itself as a Mac, hence the touch-points check.
 */
export function shouldShowIosInstallHint(i: IosInstallHintInput): boolean {
  if (i.pushSupported) return false
  if (i.standalone) return false
  const ios =
    /iPad|iPhone|iPod/.test(i.userAgent) ||
    (i.platform === 'MacIntel' && i.maxTouchPoints > 1)
  if (!ios) return false
  if (i.dismissedAt !== null && i.now - i.dismissedAt < PUSH_IOS_HINT_SNOOZE_MS) {
    return false
  }
  return true
}
