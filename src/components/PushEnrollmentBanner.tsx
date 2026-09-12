'use client'

/**
 * 7.7.0: the bar that greets a team member on entering the admin app and
 * offers to turn on browser notifications for this device.
 *
 * The product goal is that nobody has to keep opening FrameComment to see
 * whether anything happened: what lands in the bell (new feedback on your
 * cuts, replies to your comments, cuts sent to you) should reach the phone or
 * the desktop even with the app closed. Web push has existed since 3.x, but
 * enabling it meant finding Settings → Notifications → Browser → Enable, and
 * nobody did. This bar brings the switch to the front door.
 *
 * Why not simply call `Notification.requestPermission()` on load: Safari and
 * Firefox ignore the call outside a user gesture, and Chrome demotes sites
 * that ask on load to a "quiet" prompt most people never see. So the bar asks
 * with one button; the click IS the gesture, and the native prompt appears.
 *
 * What it does on each entry (`decidePushEnrollment`):
 *   - permission never asked → show the bar ("Not now" snoozes it a week);
 *   - permission granted but this device not registered (fresh login on this
 *     browser, cleared site data) → register quietly, no bar;
 *   - permission denied, or Disable pressed in Settings → nothing; Settings
 *     already explains how to change either.
 *
 * Devices enrolled here receive the person's OWN bell notifications and every
 * client comment (`initialEvents: ['CLIENT_COMMENT']`, 7.8.3) — push is about
 * comments and nothing else; the other company-wide events (share opened,
 * admin login, uploads, security alerts, deadlines) are not pushed to anyone.
 *
 * iPhone/iPad: Safari delivers web push only to sites added to the Home
 * Screen, and in a plain tab `PushManager` does not exist. In that one case
 * the bar tells the person the step that makes notifications possible.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Check, Loader2, Smartphone, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/components/AuthProvider'
import { isStaff } from '@/lib/permissions'
import { logError } from '@/lib/logging'
import {
  decidePushEnrollment,
  shouldShowIosInstallHint,
} from '@/lib/push-enrollment'
import {
  PUSH_AUTO_FAILED_KEY,
  PUSH_IOS_HINT_DISMISSED_KEY,
  PUSH_OPT_OUT_KEY,
  PUSH_PROMPT_DISMISSED_KEY,
  PUSH_SUBSCRIPTION_ID_KEY,
  fetchVapidPublicKey,
  getServiceWorkerRegistration,
  isPushSupported,
  readFlag,
  readStored,
  readTimestamp,
  subscribeThisDevice,
  writeTimestamp,
} from '@/lib/push-client'

type Mode = 'hidden' | 'prompt' | 'busy' | 'done' | 'ios-hint'

function isStandaloneDisplay(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
    // iOS Safari's own flag for Home Screen web apps.
    return (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

export default function PushEnrollmentBanner() {
  const { user, loading } = useAuth()
  const t = useTranslations('pushPrompt')
  const [mode, setMode] = useState<Mode>('hidden')
  const [error, setError] = useState<string | null>(null)
  const vapidKeyRef = useRef<string | null>(null)
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)

  const userId = user?.id ?? null
  const role = user?.role ?? null
  // The founder is bounced to /founder by the layout; no bar for that account.
  const eligible = !loading && !!userId && isStaff(role) && !user?.isPlatformAdmin

  useEffect(() => {
    if (!eligible) return
    let cancelled = false

    const run = async () => {
      const now = Date.now()
      if (!isPushSupported()) {
        if (
          shouldShowIosInstallHint({
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            maxTouchPoints: navigator.maxTouchPoints ?? 0,
            standalone: isStandaloneDisplay(),
            pushSupported: false,
            dismissedAt: readTimestamp(PUSH_IOS_HINT_DISMISSED_KEY),
            now,
          })
        ) {
          setMode('ios-hint')
        }
        return
      }

      const registration = await getServiceWorkerRegistration()
      if (cancelled || !registration) return
      registrationRef.current = registration
      const browserSubscription = await registration.pushManager
        .getSubscription()
        .catch(() => null)
      if (cancelled) return

      const decision = decidePushEnrollment({
        supported: true,
        permission: Notification.permission,
        hasBrowserSubscription: !!browserSubscription,
        hasStoredId: !!readStored(PUSH_SUBSCRIPTION_ID_KEY),
        optedOut: readFlag(PUSH_OPT_OUT_KEY),
        dismissedAt: readTimestamp(PUSH_PROMPT_DISMISSED_KEY),
        lastAutoFailureAt: readTimestamp(PUSH_AUTO_FAILED_KEY),
        now,
      })

      if (decision === 'subscribe-silently') {
        try {
          await subscribeThisDevice({ registration, initialEvents: ['CLIENT_COMMENT'] })
        } catch (err) {
          // A device another admin registered on this browser answers 409;
          // remember the failure so this does not run on every page load.
          writeTimestamp(PUSH_AUTO_FAILED_KEY)
          logError('[push] silent enrolment failed:', err)
        }
        return
      }

      if (decision === 'prompt') {
        // Prefetch the VAPID key so the click handler can ask the browser
        // FIRST and subscribe right after, both inside the gesture Safari
        // requires.
        fetchVapidPublicKey()
          .then((key) => {
            vapidKeyRef.current = key
          })
          .catch(() => {})
        if (!cancelled) setMode('prompt')
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [eligible, userId])

  const enable = useCallback(async () => {
    setError(null)
    setMode('busy')
    try {
      // First await in the handler on purpose: the permission request must
      // run inside the click.
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        // Blocked (Settings explains how to undo) or the dialog was closed
        // without an answer: step aside for now, ask again on a later visit.
        setMode('hidden')
        return
      }
      await subscribeThisDevice({
        registration: registrationRef.current,
        vapidPublicKey: vapidKeyRef.current ?? undefined,
        initialEvents: ['CLIENT_COMMENT'],
      })
      setMode('done')
      window.setTimeout(() => setMode('hidden'), 5000)
    } catch (err) {
      logError('[push] enrolment failed:', err)
      // 7.7.1: say WHY. The generic line alone hid a server 500 for a whole
      // release; the API's own message ("Failed to get VAPID public key",
      // "already registered by another admin", …) is what makes the report
      // actionable.
      const detail = err instanceof Error && err.message ? ` (${err.message})` : ''
      setError(`${t('failed')}${detail}`)
      setMode('prompt')
    }
  }, [t])

  const notNow = useCallback(() => {
    writeTimestamp(PUSH_PROMPT_DISMISSED_KEY)
    setMode('hidden')
  }, [])

  const dismissIosHint = useCallback(() => {
    writeTimestamp(PUSH_IOS_HINT_DISMISSED_KEY)
    setMode('hidden')
  }, [])

  if (mode === 'hidden') return null

  const shell =
    'w-full border-b border-white/10 bg-white/[0.04] text-white select-text'
  const inner =
    'max-w-screen-2xl mx-auto px-4 md:px-6 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'

  if (mode === 'ios-hint') {
    return (
      <div role="status" className={shell}>
        <div className={inner}>
          <Smartphone className="w-4 h-4 shrink-0 text-primary" />
          <span className="font-medium">{t('iosHintTitle')}</span>
          <span className="text-white/70">{t('iosHintBody')}</span>
          <button
            type="button"
            onClick={dismissIosHint}
            className="ml-auto shrink-0 px-3 py-1 rounded-md ring-1 ring-white/15 text-white/85 hover:bg-white/[0.08] transition-colors"
          >
            {t('gotIt')}
          </button>
        </div>
      </div>
    )
  }

  if (mode === 'done') {
    return (
      <div role="status" className={shell}>
        <div className={inner}>
          <Check className="w-4 h-4 shrink-0 text-green-400" />
          <span className="text-white/85">{t('done')}</span>
          <button
            type="button"
            onClick={() => setMode('hidden')}
            aria-label={t('dismiss')}
            className="ml-auto shrink-0 p-1 rounded-md text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  const busy = mode === 'busy'
  return (
    <div role="status" className={shell}>
      <div className={inner}>
        <Bell className="w-4 h-4 shrink-0 text-primary" />
        <span className="font-medium">{t('title')}</span>
        <span className="hidden md:inline text-white/70">{t('body')}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={notNow}
            disabled={busy}
            className="px-3 py-1 rounded-md text-white/75 hover:text-white hover:bg-white/[0.08] transition-colors disabled:opacity-60"
          >
            {t('notNow')}
          </button>
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="px-3 py-1 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 inline-flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {busy ? t('enabling') : t('enable')}
          </button>
        </span>
        {error && <span className="basis-full text-xs text-amber-300">{error}</span>}
      </div>
    </div>
  )
}
