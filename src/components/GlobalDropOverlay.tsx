'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { UploadCloud } from 'lucide-react'

/**
 * 2.0.x+: full-viewport drop overlay shown the moment the user starts
 * dragging OS files over the admin app. The actual drop is handled by
 * the FolderBrowser on project/folder pages — this is a visual hint.
 *
 * 4.1.8+ fixes:
 *   - We now `preventDefault()` on `dragover` + `drop` for FILE drags at
 *     the window level so the browser never NAVIGATES to a dropped file
 *     (previously, on pages without an upload handler like Trash, letting
 *     go opened the video in the browser).
 *   - Because the browser used to swallow the drop on those pages, the
 *     window `drop` never fired and the overlay got stuck until a reload.
 *     Preventing default guarantees the reset fires; we also reset on
 *     `dragend` and when the tab loses focus as belt-and-suspenders.
 *   - The hint only appears on pages that actually accept uploads
 *     (project / folder views), not on Trash / Users / Settings / Profile.
 */
export function GlobalDropOverlay() {
  const pathname = usePathname()
  const [active, setActive] = useState(false)

  // Pages that don't accept drag-to-upload — never show the hint there.
  const uploadCapable = !/^\/admin\/(trash|users|settings|profile)(\/|$)/.test(
    pathname || '',
  )

  useEffect(() => {
    let counter = 0

    const isFileDrag = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types
      if (!types) return false
      return Array.from(types).includes('Files')
    }

    const hasEmptyDropZoneVisible = (): boolean => {
      if (typeof document === 'undefined') return false
      return !!document.querySelector('[data-empty-drop-zone="true"]')
    }

    const reset = () => {
      counter = 0
      setActive(false)
    }

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      counter++
      if (counter === 1 && uploadCapable && !hasEmptyDropZoneVisible()) {
        setActive(true)
      }
    }
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      counter = Math.max(0, counter - 1)
      if (counter === 0) setActive(false)
    }
    // Prevent the browser's default "open the file" for OS file drags
    // anywhere in the app. Without this, dropping on a page that has no
    // upload handler navigates the tab to the file (and leaves the hint
    // stuck because the `drop` event never bubbles here).
    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault()
      reset()
    }
    const onDragEnd = () => reset()
    const onBlur = () => reset()

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
      window.removeEventListener('blur', onBlur)
    }
  }, [uploadCapable])

  if (!active) return null

  return (
    <div
      className="fixed inset-0 z-[2147483600] pointer-events-none flex items-center justify-center animate-in fade-in duration-150"
      aria-hidden="true"
    >
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
