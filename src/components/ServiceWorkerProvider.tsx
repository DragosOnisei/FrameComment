'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { logError, logMessage } from '@/lib/logging'
import { isSafeReturnPath } from '@/lib/post-login-redirect'

/**
 * ServiceWorkerProvider registers the service worker for PWA functionality.
 * Place this component in your layout to enable push notifications.
 */
export function ServiceWorkerProvider() {
  const router = useRouter()

  /**
   * 7.16.1: a click on a system notification, relayed by the service worker
   * (`fc:open-url`, see askPageToOpen in public/sw.js), does exactly what a
   * click on the bell row does — `router.push` to the deep link and a
   * `comment:focus` for a page that is already on that video, where a changed
   * query string alone would not re-run the landing. Here and not in the bell
   * because the bell is not mounted on the player page (its top bar is hidden
   * there), and that is the page most often open when a comment arrives.
   * Answers on the port so the worker knows not to reload the tab instead.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const d = event.data
      if (!d || d.type !== 'fc:open-url') return
      const port = event.ports?.[0]
      const target = typeof d.url === 'string' ? d.url : ''
      if (!isSafeReturnPath(target)) {
        port?.postMessage({ ok: false })
        return
      }
      port?.postMessage({ ok: true })
      router.push(target)
      let commentId: string | null = null
      try {
        commentId = new URL(target, window.location.origin).searchParams.get('comment')
      } catch {
        commentId = null
      }
      if (commentId) {
        window.dispatchEvent(new CustomEvent('comment:focus', { detail: { commentId } }))
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [router])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) {
      logMessage('[SW] Service workers not supported')
      return
    }

    // Register service worker
    const registerServiceWorker = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
        })

        logMessage('[SW] Service worker registered:', registration.scope)

        // Check for updates periodically
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New service worker available
                logMessage('[SW] New service worker available')
              }
            })
          }
        })
      } catch (error) {
        logError('[SW] Service worker registration failed:', error)
      }
    }

    // Register on load
    if (document.readyState === 'complete') {
      registerServiceWorker()
    } else {
      window.addEventListener('load', registerServiceWorker)
      return () => window.removeEventListener('load', registerServiceWorker)
    }
  }, [])

  // This component doesn't render anything
  return null
}
