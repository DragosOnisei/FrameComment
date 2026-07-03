'use client'

import { useEffect, useRef } from 'react'
import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import { detectLoggedInAdmin } from '@/lib/share-auth'

/**
 * 3.8.x: first-visit onboarding for the share (client) player.
 *
 * A focused 3-step guided tour for reviewers who aren't logged in:
 *   1. the Name field — set who the feedback is from,
 *   2. the yellow timeline handle — drag it to comment on a RANGE,
 *   3. the annotate (pen) button — draw directly on the frame.
 *
 * Runs once per browser (localStorage flag), and NEVER for a logged-in
 * admin. Popovers are restyled to the app's dark-glass look, and steps
 * 2 & 3 get a bouncing arrow pointing at their (small) target.
 */
const DONE_KEY = 'framecomment:onboarding-done'
const STYLE_ID = 'fc-onboarding-style'
const ARROW_ID = 'fc-onboarding-arrow'

// App-styled popover chrome + the animated attention arrow. Injected
// once; scoped to `.fc-onboarding` so it never touches other driver.js
// tours (e.g. the admin ShareTutorial).
const STYLE_CSS = `
.fc-onboarding.driver-popover {
  background-color: rgba(22, 37, 51, 0.94);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  backdrop-filter: blur(24px) saturate(160%);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 14px;
  box-shadow: 0 24px 60px -12px rgba(0,0,0,0.75);
  max-width: 320px;
}
.fc-onboarding .driver-popover-title { color: #fff; font-weight: 600; font-size: 16px; }
.fc-onboarding .driver-popover-description { color: rgba(255,255,255,0.72); line-height: 1.5; }
.fc-onboarding .driver-popover-progress-text { color: rgba(255,255,255,0.5); }
.fc-onboarding .driver-popover-close-btn { color: rgba(255,255,255,0.55); }
.fc-onboarding .driver-popover-close-btn:hover { color: #fff; }
.fc-onboarding .driver-popover-arrow { display: none; }
.fc-onboarding .driver-popover-footer button {
  text-shadow: none;
  border-radius: 8px;
  padding: 5px 14px;
  font-weight: 500;
  background: rgba(255,255,255,0.08);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.16);
}
.fc-onboarding .driver-popover-footer button:hover {
  background: rgba(255,255,255,0.16);
  color: #fff;
}
.fc-onboarding .driver-popover-footer button.driver-popover-next-btn {
  background: hsl(var(--primary, 209 100% 60%));
  border-color: transparent;
  box-shadow: 0 2px 10px -2px hsl(var(--primary, 209 100% 60%) / 0.55);
}
.fc-onboarding .driver-popover-footer button.driver-popover-next-btn:hover {
  filter: brightness(1.1);
}
#${ARROW_ID} {
  position: fixed;
  z-index: 1000000;
  pointer-events: none;
  color: hsl(var(--primary, 209 100% 60%));
  filter: drop-shadow(0 2px 6px rgba(0,0,0,0.5));
  animation: fc-onboarding-bounce 0.9s ease-in-out infinite;
  transition: top 0.2s ease, left 0.2s ease;
}
@keyframes fc-onboarding-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(11px); }
}
`

const ARROW_SVG = `<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M5.5 12.5 12 19l6.5-6.5"/></svg>`

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

    const ensureStyle = () => {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE_CSS
      document.head.appendChild(style)
    }

    const getArrow = (): HTMLDivElement => {
      let arrow = document.getElementById(ARROW_ID) as HTMLDivElement | null
      if (!arrow) {
        arrow = document.createElement('div')
        arrow.id = ARROW_ID
        arrow.innerHTML = ARROW_SVG
        arrow.style.display = 'none'
        document.body.appendChild(arrow)
      }
      return arrow
    }

    // Point the bouncing arrow at a target element (from just above it).
    const showArrowAt = (el: Element) => {
      const arrow = getArrow()
      const rect = el.getBoundingClientRect()
      arrow.style.display = 'block'
      arrow.style.left = `${rect.left + rect.width / 2 - 19}px`
      arrow.style.top = `${Math.max(6, rect.top - 46)}px`
    }
    const hideArrow = () => {
      const arrow = document.getElementById(ARROW_ID)
      if (arrow) (arrow as HTMLElement).style.display = 'none'
    }
    const removeArrow = () => {
      document.getElementById(ARROW_ID)?.remove()
    }

    const startTour = () => {
      if (cancelled || startedRef.current) return
      const nameEl = visible('tour-name')
      const rangeEl = visible('tour-range')
      const annotateEl = visible('tour-annotate')
      if (!nameEl || !rangeEl || !annotateEl) {
        if (attempts++ < 40) timer = setTimeout(startTour, 250)
        return
      }
      startedRef.current = true
      ensureStyle()

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
        popoverClass: 'fc-onboarding',
        overlayColor: 'rgba(0, 0, 0, 0.6)',
        stagePadding: 10,
        stageRadius: 10,
        popoverOffset: 14,
        onHighlighted: (el?: Element) => {
          // Bouncing arrow only on the small, easy-to-miss targets.
          const id = el?.getAttribute?.('data-tutorial')
          if (el && (id === 'tour-range' || id === 'tour-annotate')) {
            showArrowAt(el)
          } else {
            hideArrow()
          }
        },
        onDeselected: () => hideArrow(),
        onDestroyed: () => {
          removeArrow()
          try {
            localStorage.setItem(DONE_KEY, 'done')
          } catch {
            /* ignore */
          }
        },
      })
      d.drive()
    }

    ;(async () => {
      // A logged-in admin is redirected to the full admin view (see
      // share-auth.ts) — never show them the client onboarding tour.
      const isAdmin = await detectLoggedInAdmin()
      if (isAdmin) return
      if (!cancelled) timer = setTimeout(startTour, 600)
    })()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.getElementById(ARROW_ID)?.remove()
    }
  }, [])

  return null
}
