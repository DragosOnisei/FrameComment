'use client'

/**
 * 6.3.4 — "only show a spinner if the wait is actually noticeable".
 *
 * Opening a clip used to walk through four separate loading cards in a row
 * (project fetch → target resolution → version tokens → player mount). Each one
 * was individually correct and the whole sequence read as a stuck app, because
 * most of those steps finish in tens of milliseconds and the flicker is what
 * the eye registers, not the wait.
 *
 * This returns `true` only once `active` has stayed true for `delayMs`, and
 * flips back to false immediately. Fast paths therefore render nothing at all.
 */

import { useEffect, useRef, useState } from 'react'

export function useDelayedFlag(active: boolean, delayMs = 350): boolean {
  const [shown, setShown] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!active) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setShown(false)
      return
    }
    timerRef.current = setTimeout(() => setShown(true), delayMs)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [active, delayMs])

  return shown
}
