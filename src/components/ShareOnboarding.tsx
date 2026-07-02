'use client'

import { useEffect, useRef } from 'react'
import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import { getAccessToken } from '@/lib/token-store'

/**
 * 3.8.x: first-visit onboarding for the share (client) player.
 *
 * A focused 3-step guided tour for reviewers who aren't logged in:
 *   1. the Name field — set who the feedback is from,
 *   2. the yellow timeline handle — drag it to comment on a RANGE,
 *   3. the annotate (pen) button — draw directly on the frame.
 *
 * Runs once per browser (localStorage flag), and NEVER for a logged-in
 * admin (we check the session first). It waits for the three anchors to
 * be on screen before starting, so it only fires in the player view
 * with the comment box visible.
 */
const DONE_KEY = 'framecomment:onboarding-done'

export default function ShareOnboarding() {
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current || typeof window === 'undefined') return
    try {
      if (localStorage.getItem(DONE_KEY) === 'done') return
    } catch {
      return
    }

    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    // Pick the on-screen anchor for an id (desktop + mobile duplicates
    // may both exist; use whichever is actually visible).
    const visible = (id: string): Element | null => {
      const els = Array.from(
        document.querySelectorAll(`[data-tutorial="${id}"]`),
      )
      return (
        els.find((el) => (el as HTMLElement).offsetParent !== null) ||
        els[0] ||
        null
      )
    }

    const startTour = () => {
      if (cancelled || startedRef.current) return
      const nameEl = visible('tour-name')
      const rangeEl = visible('tour-range')
      const annotateEl = visible('tour-annotate')
      if (!nameEl || !rangeEl || !annotateEl) {
        // Not in the player view yet (or feedback hidden) — retry for a
        // while, then give up quietly.
        if (attempts++ < 40) timer = setTimeout(startTour, 250)
        return
      }
      startedRef.current = true

      const steps: DriveStep[] = [
        {
          element: nameEl,
          popover: {
            title: 'Set your name',
            description:
              'Type your name here so your feedback is attributed to you. It’s remembered on this device.',
          },
        },
        {
          element: rangeEl,
          popover: {
            title: 'Select a range',
            description:
              'Drag this yellow handle along the timeline to leave a comment on a range of frames — not just a single moment.',
          },
        },
        {
          element: annotateEl,
          popover: {
            title: 'Draw on the video',
            description:
              'Click here to draw annotations right on the frame — arrows, boxes, scribbles — attached to your comment.',
          },
        },
      ]

      const d = driver({
        showProgress: true,
        steps,
        allowClose: true,
        nextBtnText: 'Next',
        prevBtnText: 'Back',
        doneBtnText: 'Done',
        overlayColor: 'rgba(0, 0, 0, 0.6)',
        stagePadding: 8,
        stageRadius: 8,
        popoverOffset: 12,
        onDestroyed: () => {
          try {
            localStorage.setItem(DONE_KEY, 'done')
          } catch {
            /* ignore */
          }
        },
      })
      d.drive()
    }

    // Skip entirely for a logged-in admin (they get redirected into the
    // admin app anyway), then kick off the tour. Manual token check — no
    // apiFetch, whose 401 interceptor could bounce a guest to /login.
    ;(async () => {
      const token = getAccessToken()
      if (token) {
        try {
          const res = await fetch('/api/auth/session', {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          })
          if (res.ok) {
            const data = await res.json().catch(() => null)
            if (data?.authenticated) return // logged in → no client tour
          }
        } catch {
          /* fall through — show the tour */
        }
      }
      if (!cancelled) timer = setTimeout(startTour, 600)
    })()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return null
}
