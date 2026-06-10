'use client'

import { useEffect, useState } from 'react'
import { UploadCloud } from 'lucide-react'

/**
 * 2.0.x+: full-viewport drop overlay shown the moment the user
 * starts dragging files from their OS over the admin app.
 * Doesn't intercept the drop itself — clicks/drops fall through
 * to the underlying folder browser, which already has the right
 * handler attached. Pure visual hint.
 *
 * Why a separate global overlay instead of relying on
 * FolderBrowser's own dashed drop ring: the user shouldn't have
 * to know they're aiming at a specific element. As soon as a
 * file leaves the desktop and hovers anywhere over the admin
 * tab, we want a clear "drop anywhere to upload" affordance.
 *
 * Implementation notes:
 *   - Listens on `window`, not on a specific element. Drag
 *     events bubble out of every container, so any drag with
 *     `types.includes('Files')` triggers the overlay.
 *   - Drag-leave is tricky: every internal element transition
 *     fires `dragleave` on the previous one and `dragenter` on
 *     the next. We track a counter so the overlay only hides
 *     once the cursor has fully left the viewport (counter
 *     hits 0).
 *   - Hidden when nothing is being dragged — the overlay
 *     unmounts entirely so it doesn't capture pointer events.
 */
export function GlobalDropOverlay() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let counter = 0

    const isFileDrag = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types
      if (!types) return false
      // `types` is a DOMStringList — `Array.from` so we can use
      // `includes`. Chrome / Firefox / Safari all surface "Files"
      // when an OS file/folder drag enters the page.
      return Array.from(types).includes('Files')
    }

    /**
     * 2.5.1+: skip the floating overlay when the page already shows
     * the FolderBrowser's big empty-state placeholder — that card is
     * already the drop target, and stacking a second floating popup
     * on top of it competes for attention without adding info. We
     * marker the empty-state with `data-empty-drop-zone="true"` so
     * this check stays decoupled from FolderBrowser's internals.
     */
    const hasEmptyDropZoneVisible = (): boolean => {
      if (typeof document === 'undefined') return false
      return !!document.querySelector('[data-empty-drop-zone="true"]')
    }

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      counter++
      if (counter === 1 && !hasEmptyDropZoneVisible()) setActive(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      counter = Math.max(0, counter - 1)
      if (counter === 0) setActive(false)
    }
    const onDrop = () => {
      counter = 0
      setActive(false)
    }
    // `dragover` must call preventDefault somewhere on the chain
    // or the browser refuses the drop. FolderBrowser already
    // does that on the relevant areas, so we don't need to.

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (!active) return null

  return (
    <div
      // pointer-events-none on the WRAPPER so the drag/drop
      // events fall through to the underlying folder browser
      // (it owns the actual drop handler). The card itself is
      // also non-interactive — purely a hint.
      className="fixed inset-0 z-[2147483600] pointer-events-none flex items-center justify-center animate-in fade-in duration-150"
      aria-hidden="true"
    >
      {/* 2.5.1+: v2.5 frosted glass refresh — same vocabulary as
          ConfirmDialog / popovers (translucent navy + spotlight
          radial tint + 40px backdrop blur). The icon sits in an
          accent-tinted disc so it reads as the focal point even on
          a busy background. Dashed border stays as the conventional
          "drop here" signal but in primary/40 over the glass card. */}
      <div
        className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-primary/45 ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white px-12 py-10"
        style={{
          backgroundColor: 'rgba(22, 37, 51, 0.62)',
          backgroundImage:
            'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          transform: 'translate3d(0, 0, 0)',
          willChange: 'backdrop-filter, transform',
          isolation: 'isolate',
        }}
      >
        <div className="rounded-full bg-primary/15 ring-1 ring-primary/30 p-4">
          <UploadCloud className="w-12 h-12 text-primary" />
        </div>
        <p className="text-lg font-semibold text-white">Drop files to upload</p>
        <p className="text-xs text-white/65 max-w-[300px] text-center leading-relaxed">
          Drop video files or whole folders anywhere on this page —
          they&apos;ll start uploading to the project you&apos;re viewing.
        </p>
      </div>
    </div>
  )
}
