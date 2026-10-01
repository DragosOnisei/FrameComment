'use client'

import { useEffect } from 'react'
import {
  ESC_BACK_SELECTOR,
  ESC_LAYER_SELECTOR,
  escMayGoBack,
  escStillUnused,
  isTextEditable,
  pickBackControl,
} from '@/lib/escape-back'

/**
 * 7.17.0: Esc presses the page's Back control when it closed nothing else.
 * The rules, and why they are split before/after dispatch, are in
 * src/lib/escape-back.ts. Mounted once, in the root layout.
 */
export function EscapeBack() {
  useEffect(() => {
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as Element | null
      const may = escMayGoBack({
        key: e.key,
        repeat: e.repeat,
        modifiers: e.metaKey || e.ctrlKey || e.altKey || e.shiftKey,
        composing: e.isComposing,
        editableTarget: isTextEditable(target) || isTextEditable(document.activeElement),
        layerOpen: !!document.querySelector(ESC_LAYER_SELECTOR),
        fullscreen:
          !!document.fullscreenElement ||
          !!(document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement ||
          !!document.querySelector('.fc-inpage-fullscreen'),
      })
      if (!may) return
      // Every other Esc handler runs during this dispatch; look again once it
      // is over, and only then decide.
      window.setTimeout(() => {
        if (!escStillUnused(e.defaultPrevented)) return
        const back = pickBackControl(
          Array.from(document.querySelectorAll<HTMLElement>(ESC_BACK_SELECTOR)),
        )
        back?.click()
      }, 0)
    }
    window.addEventListener('keydown', onKeyDownCapture, true)
    return () => window.removeEventListener('keydown', onKeyDownCapture, true)
  }, [])
  return null
}
