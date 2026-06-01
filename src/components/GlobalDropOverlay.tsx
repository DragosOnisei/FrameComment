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

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      counter++
      if (counter === 1) setActive(true)
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
      <div className="flex flex-col items-center gap-4 text-primary rounded-2xl border-2 border-dashed border-primary/70 bg-background/95 backdrop-blur-md px-12 py-10 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
        <UploadCloud className="w-16 h-16" />
        <p className="text-lg font-semibold">Drop files to upload</p>
        <p className="text-xs text-muted-foreground max-w-[300px] text-center">
          Drop video files or whole folders anywhere on this page —
          they&apos;ll start uploading to the project you&apos;re viewing.
        </p>
      </div>
    </div>
  )
}
