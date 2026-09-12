'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { apiFetch, apiPost, apiPatch } from '@/lib/api-client'
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from '@/lib/external-notifications/constants'
import { Bell, BellOff, Send, Trash2, Smartphone, Monitor, Pencil, Check, X, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { logError } from '@/lib/logging'
import {
  PUSH_OPT_OUT_KEY,
  PUSH_SUBSCRIPTION_ID_KEY,
  isPushSupported as detectPushSupport,
  subscribeThisDevice,
  writeFlag,
} from '@/lib/push-client'

interface PushSubscription {
  id: string
  deviceName: string | null
  userAgent: string | null
  subscribedEvents: string[]
  createdAt: string
  lastUsedAt: string
  endpoint: string
}

const EVENT_LABEL_KEYS: Record<NotificationEventType, string> = {
  SHARE_ACCESS: 'sharePageAccess',
  ADMIN_ACCESS: 'adminLogin',
  CLIENT_COMMENT: 'newComments',
  CLIENT_UPLOAD: 'clientUploads',
  SECURITY_ALERT: 'securityAlerts',
  DUE_DATE_REMINDER: 'dueDateReminders',
}

export function WebPushSection({ active }: { active: boolean }) {
  const t = useTranslations('settings.webPush')
  const te = useTranslations('settings.externalNotifications')
  const tc = useTranslations('common')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [subscriptions, setSubscriptions] = useState<PushSubscription[]>([])
  const [currentDeviceSubscribed, setCurrentDeviceSubscribed] = useState(false)
  const [currentSubscriptionId, setCurrentSubscriptionId] = useState<string | null>(null)
  const [permissionState, setPermissionState] = useState<NotificationPermission | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  /**
   * 7.8.1: the three-step test for THIS device.
   *
   * "Nothing arrives" has three different causes that look identical from
   * the outside: the server could not hand the message to the push service;
   * the push service accepted it but this browser never received it (its
   * push channel is blocked — managed Macs, VPNs, or two copies of Chrome
   * where the other one holds the subscription); or the browser received it
   * and the operating system hid the banner. The service worker now posts
   * `fc:push-received` to open pages the moment a push arrives, so this
   * component can tell the second case from the third instead of guessing.
   */
  type TestPhase = 'idle' | 'sending' | 'sent' | 'received' | 'not-received' | 'failed'
  const [testPhase, setTestPhase] = useState<TestPhase>('idle')
  const [testSentAt, setTestSentAt] = useState<number | null>(null)
  const [testStatusCode, setTestStatusCode] = useState<number | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [lastReceived, setLastReceived] = useState<{ at: number; title: string } | null>(null)
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || data.type !== 'fc:push-received') return
      const at = typeof data.receivedAt === 'number' ? data.receivedAt : Date.now()
      const title = typeof data.title === 'string' ? data.title : 'FrameComment'
      setLastReceived({ at, title })
      setTestPhase((phase) => (phase === 'sending' || phase === 'sent' ? 'received' : phase))
      if (testTimerRef.current) {
        clearTimeout(testTimerRef.current)
        testTimerRef.current = null
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage)
      if (testTimerRef.current) clearTimeout(testTimerRef.current)
    }
  }, [])

  // Check browser support (shared with the enrolment bar since 7.7.0)
  const isPushSupported = detectPushSupport()

  // Load subscriptions
  const loadSubscriptions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch('/api/push/subscribe')
      if (!response.ok) {
        throw new Error(t('failedToLoadSubs'))
      }
      const data = await response.json()
      setSubscriptions(data.subscriptions || [])

      // Check if current device is subscribed using localStorage ID
      const storedId = localStorage.getItem(PUSH_SUBSCRIPTION_ID_KEY)
      if (storedId) {
        const found = data.subscriptions?.find(
          (s: PushSubscription) => s.id === storedId
        )
        if (found) {
          setCurrentDeviceSubscribed(true)
          setCurrentSubscriptionId(storedId)
        } else {
          // Stored ID no longer exists on server (subscription was removed)
          localStorage.removeItem(PUSH_SUBSCRIPTION_ID_KEY)
          setCurrentDeviceSubscribed(false)
          setCurrentSubscriptionId(null)
        }
      } else {
        setCurrentDeviceSubscribed(false)
        setCurrentSubscriptionId(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToLoadSubs'))
    } finally {
      setLoading(false)
    }
  }, [t])

  // Check notification permission and listen for changes
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return

    // Initial check
    setPermissionState(Notification.permission)

    // Listen for permission changes via Permissions API (works in most browsers)
    let permissionStatus: PermissionStatus | null = null
    const handlePermissionChange = () => {
      setPermissionState(Notification.permission)
    }

    navigator.permissions?.query({ name: 'notifications' }).then((status) => {
      permissionStatus = status
      status.addEventListener('change', handlePermissionChange)
    }).catch(() => {
      // Permissions API not supported, fall back to visibilitychange only
    })

    // Also re-check when PWA comes back to foreground (covers macOS system settings changes)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setPermissionState(Notification.permission)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      permissionStatus?.removeEventListener('change', handlePermissionChange)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // Load data when active
  useEffect(() => {
    if (active && isPushSupported) {
      void loadSubscriptions()
    }
  }, [active, isPushSupported, loadSubscriptions])

  // Subscribe current device
  const handleSubscribe = async () => {
    setError(null)
    setSuccess(null)

    try {
      // Request notification permission
      const permission = await Notification.requestPermission()
      setPermissionState(permission)

      if (permission !== 'granted') {
        setError(t('permissionDenied'))
        return
      }

      // 7.7.0: shared with the enrolment bar. No `initialEvents` here: a
      // device enabled from Settings keeps getting every company-wide event
      // by default, exactly as before — the switches are right below.
      const { subscriptionId } = await subscribeThisDevice()
      setCurrentDeviceSubscribed(true)
      setCurrentSubscriptionId(subscriptionId)
      setSuccess(t('enabledSuccess'))
      await loadSubscriptions()
    } catch (err) {
      logError('Subscribe error:', err)
      setError(err instanceof Error ? err.message : t('failedToSubscribe'))
    }
  }

  // Unsubscribe current device
  const handleUnsubscribe = async () => {
    setError(null)
    setSuccess(null)

    try {
      // Unsubscribe from push manager
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await subscription.unsubscribe()
      }

      // Remove from server
      if (currentSubscriptionId) {
        await apiPost('/api/push/unsubscribe', {
          subscriptionId: currentSubscriptionId,
        })
      }

      localStorage.removeItem(PUSH_SUBSCRIPTION_ID_KEY)
      // 7.7.0: Disable is a decision. Without this flag the enrolment bar
      // would see "permission granted, device not registered" on the next
      // page load and quietly subscribe the device again.
      writeFlag(PUSH_OPT_OUT_KEY, true)
      setCurrentDeviceSubscribed(false)
      setCurrentSubscriptionId(null)
      setSuccess(t('disabledSuccess'))
      await loadSubscriptions()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToUnsubscribe'))
    }
  }

  // Remove a subscription
  const handleRemoveSubscription = async (subscriptionId: string) => {
    setError(null)
    try {
      // apiPost returns parsed JSON directly, throws on error
      await apiPost('/api/push/unsubscribe', { subscriptionId })
      if (subscriptionId === currentSubscriptionId) {
        localStorage.removeItem(PUSH_SUBSCRIPTION_ID_KEY)
        writeFlag(PUSH_OPT_OUT_KEY, true)
        setCurrentDeviceSubscribed(false)
        setCurrentSubscriptionId(null)
      }
      await loadSubscriptions()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToRemove'))
    }
  }

  // 7.8.1: test THIS device and report each step (see TestPhase above).
  const handleTestThisDevice = async () => {
    if (!currentSubscriptionId) return
    setError(null)
    setSuccess(null)
    setTestError(null)
    setTestStatusCode(null)
    setTestPhase('sending')
    if (testTimerRef.current) clearTimeout(testTimerRef.current)
    try {
      const data = await apiPost('/api/push/test', { subscriptionId: currentSubscriptionId })
      setTestSentAt(Date.now())
      setTestStatusCode(typeof data?.statusCode === 'number' ? data.statusCode : null)
      setTestPhase((phase) => (phase === 'received' ? phase : 'sent'))
      // The push service usually delivers within a second or two; fifteen is
      // generous enough that "not received" means blocked, not slow.
      testTimerRef.current = setTimeout(() => {
        setTestPhase((phase) => (phase === 'sent' ? 'not-received' : phase))
      }, 15000)
    } catch (err) {
      setTestError(err instanceof Error ? err.message : t('failedToTest'))
      setTestPhase('failed')
    }
  }

  // Send test notification to another listed device (no receipt to observe
  // from here — it lands on that device, not this one).
  const handleTestNotification = async (subscriptionId: string) => {
    if (subscriptionId === currentSubscriptionId) {
      await handleTestThisDevice()
      return
    }
    setError(null)
    setSuccess(null)
    try {
      // apiPost returns parsed JSON directly, throws on error
      await apiPost('/api/push/test', { subscriptionId })
      setSuccess(t('testSent'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToTest'))
    }
  }

  const clock = (ms: number) => new Date(ms).toLocaleTimeString()

  // Update subscription events
  const handleToggleEvent = async (subscriptionId: string, eventType: string, enabled: boolean) => {
    const subscription = subscriptions.find((s) => s.id === subscriptionId)
    if (!subscription) return

    const currentEvents = subscription.subscribedEvents
    const newEvents = enabled
      ? [...currentEvents, eventType]
      : currentEvents.filter((e) => e !== eventType)

    try {
      // apiPatch returns parsed JSON directly, throws on error
      await apiPatch('/api/push/subscribe', {
        subscriptionId,
        subscribedEvents: newEvents,
      })
      await loadSubscriptions()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToUpdateSub'))
    }
  }

  // Update device name
  const handleUpdateName = async (subscriptionId: string) => {
    try {
      // apiPatch returns parsed JSON directly, throws on error
      await apiPatch('/api/push/subscribe', {
        subscriptionId,
        deviceName: editName,
      })
      setEditingId(null)
      await loadSubscriptions()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToUpdateName'))
    }
  }

  // Not supported UI
  if (!isPushSupported) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>{t('notSupported')}</p>
        <p className="mt-2">{t('requirements')}</p>
        <ul className="list-disc list-inside mt-1 space-y-1">
          <li>{t('modernBrowser')}</li>
          <li>{t('httpsRequired')}</li>
          <li>{t('serviceWorker')}</li>
        </ul>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Status messages */}
      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-md">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 text-sm text-green-600 bg-green-50 dark:bg-green-900/20 dark:text-green-400 rounded-md">
          {success}
        </div>
      )}

      {/* Current device subscription */}
      <div className="p-4 border rounded-lg space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {currentDeviceSubscribed ? (
              <Bell className="h-5 w-5 text-green-500" />
            ) : (
              <BellOff className="h-5 w-5 text-muted-foreground" />
            )}
            <div>
              <h4 className="font-medium">{t('thisDevice')}</h4>
              <p className="text-sm text-muted-foreground">
                {currentDeviceSubscribed
                  ? t('enabled')
                  : permissionState === 'denied'
                    ? t('blocked')
                    : t('enablePrompt')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {currentDeviceSubscribed && currentSubscriptionId && (
              <Button
                onClick={handleTestThisDevice}
                variant="secondary"
                disabled={testPhase === 'sending'}
                title={t('sendTestTitle')}
              >
                {testPhase === 'sending' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span className="ml-2">{t('testThisDevice')}</span>
              </Button>
            )}
            <Button
              onClick={currentDeviceSubscribed ? handleUnsubscribe : handleSubscribe}
              variant={currentDeviceSubscribed ? 'outline' : 'default'}
              disabled={permissionState === 'denied' && !currentDeviceSubscribed}
            >
              {currentDeviceSubscribed ? tc('disable') : tc('enable')}
            </Button>
          </div>
        </div>

        {permissionState === 'denied' && !currentDeviceSubscribed && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t('enableInstructions')}
          </p>
        )}

        {/* 7.8.1: the three steps of a test, each named as it happens. */}
        {testPhase !== 'idle' && (
          <div className="rounded-md border border-border/60 bg-accent/5 p-3 text-xs space-y-1.5">
            {testPhase === 'sending' && <p>{t('testSending')}</p>}
            {testPhase === 'failed' && (
              <p className="text-red-500">{t('testStepServiceFailed', { error: testError ?? '' })}</p>
            )}
            {(testPhase === 'sent' || testPhase === 'received' || testPhase === 'not-received') && (
              <p className="text-green-600 dark:text-green-400">
                {t('testStepService', {
                  time: testSentAt ? clock(testSentAt) : '',
                  status: testStatusCode ?? '?',
                })}
              </p>
            )}
            {testPhase === 'sent' && <p className="text-muted-foreground">{t('testStepWaiting')}</p>}
            {testPhase === 'received' && lastReceived && (
              <>
                <p className="text-green-600 dark:text-green-400">
                  {t('testStepReceived', { time: clock(lastReceived.at), title: lastReceived.title })}
                </p>
                <p className="text-muted-foreground">{t('testHintReceived')}</p>
              </>
            )}
            {testPhase === 'not-received' && (
              <>
                <p className="text-amber-600 dark:text-amber-400">{t('testStepNotReceived')}</p>
                <p className="text-muted-foreground">{t('testHintNotReceived')}</p>
              </>
            )}
          </div>
        )}
        {testPhase === 'idle' && lastReceived && (
          <p className="text-xs text-muted-foreground">
            {t('lastPushReceived', { time: clock(lastReceived.at), title: lastReceived.title })}
          </p>
        )}
      </div>

      {/* Subscribed devices */}
      {subscriptions.length > 0 && (
        <div className="space-y-3">
          <h4 className="font-medium text-sm">{t('subscribedDevices')} ({subscriptions.length})</h4>
          <div className="space-y-3">
            {subscriptions.map((sub) => (
              <div key={sub.id} className="p-4 border rounded-lg space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    {sub.userAgent?.includes('Mobile') ? (
                      <Smartphone className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <Monitor className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      {editingId === sub.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="h-7 w-40"
                            autoFocus
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => handleUpdateName(sub.id)}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => setEditingId(null)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">
                            {sub.deviceName || t('unknownDevice')}
                          </span>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={() => {
                              setEditingId(sub.id)
                              setEditName(sub.deviceName || '')
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          {sub.id === currentSubscriptionId && (
                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
                              {t('current')}
                            </span>
                          )}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground truncate">
                        {t('lastUsed')} {new Date(sub.lastUsedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => handleTestNotification(sub.id)}
                      title={t('sendTestTitle')}
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleRemoveSubscription(sub.id)}
                      title={t('removeTitle')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Event toggles */}
                <div className="space-y-3 border-2 border-border p-4 rounded-lg bg-accent/5">
                  <h4 className="font-semibold text-sm">{te('sendFor')}</h4>
                  {/* 7.7.0: the bell mirror is not a switch — a device on
                      this list always gets the owner's own notifications. */}
                  <p className="text-xs text-muted-foreground">{t('bellAlwaysOn')}</p>
                  <div className="space-y-3">
                    {NOTIFICATION_EVENT_TYPES.map((eventType) => (
                      <div key={eventType} className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label className="text-sm font-normal">{te(EVENT_LABEL_KEYS[eventType])}</Label>
                        </div>
                        <Switch
                          checked={sub.subscribedEvents.includes(eventType)}
                          onCheckedChange={(checked) =>
                            handleToggleEvent(sub.id, eventType, checked)
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No subscriptions */}
      {subscriptions.length === 0 && !loading && (
        <div className="text-center text-sm text-muted-foreground py-8">
          <BellOff className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>{t('noDevices')}</p>
          <p className="mt-1">{t('getStarted')}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-center text-sm text-muted-foreground py-4">
          {tc('loading')}
        </div>
      )}
    </div>
  )
}
