'use client'

import * as React from 'react'
import { Loader2, Maximize, RotateCcw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import CoverImageCropper, {
  type CoverImageCropperHandle,
  MIN_SCALE,
  MAX_SCALE,
} from '@/components/CoverImageCropper'
import { logError } from '@/lib/logging'

/**
 * 3.2.x: profile-picture crop modal.
 *
 * When the user picks an avatar we no longer auto-crop the centre of
 * the image (which beheaded anyone not dead-centre). Instead we open
 * this modal: a square cropper with a CIRCULAR mask showing exactly
 * what will appear in the round avatar, plus drag-to-reposition and
 * zoom (wheel / pinch / slider, all from CoverImageCropper). On Apply
 * we render the visible square to a 256×256 JPEG data URL — the same
 * size the profile stores inline.
 */
export interface AvatarCropModalProps {
  /** Picked image file. Non-null = modal open. */
  file: File | null
  onCancel: () => void
  /** Receives a square 256px JPEG data URL once the user applies. */
  onApply: (dataUrl: string) => void
}

const AVATAR_OUTPUT = 256

export function AvatarCropModal({ file, onCancel, onApply }: AvatarCropModalProps) {
  const cropperRef = React.useRef<CoverImageCropperHandle>(null)
  const [busy, setBusy] = React.useState(false)
  // Mirrors the cropper's zoom so the slider below the image reflects
  // wheel / pinch / drag-clamped changes too.
  const [zoom, setZoom] = React.useState(1)

  const handleApply = React.useCallback(async () => {
    if (!cropperRef.current || busy) return
    setBusy(true)
    try {
      const cropped = await cropperRef.current.commit()
      if (!cropped) {
        setBusy(false)
        return
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = reject
        reader.readAsDataURL(cropped)
      })
      onApply(dataUrl)
    } catch (err) {
      logError('Avatar crop failed:', err)
    } finally {
      setBusy(false)
    }
  }, [busy, onApply])

  return (
    <Dialog
      open={!!file}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent
        overlayClassName="bg-transparent"
        className="sm:max-w-sm bg-white/[0.06] text-white ring-1 ring-white/10 border-0 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)]"
        style={{
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-white">Position your photo</DialogTitle>
        </DialogHeader>

        <p className="-mt-1 text-xs text-white/55">
          Drag to reposition · scroll or pinch to zoom. The circle is exactly
          what other people will see.
        </p>

        <div className="relative mx-auto mt-1 h-64 w-64 max-w-full overflow-hidden rounded-lg">
          {file && (
            <CoverImageCropper
              ref={cropperRef}
              file={file}
              outputSize={AVATAR_OUTPUT}
              showZoomControls={false}
              onZoomChange={setZoom}
              className="absolute inset-0 h-full w-full"
            />
          )}
          {/* Circular mask — inscribed circle = the exact avatar crop.
              The huge spread box-shadow darkens everything outside the
              circle; `pointer-events-none` keeps drag/zoom working on
              the cropper underneath. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 h-full w-full -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white/80"
            style={{ boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)' }}
          />
        </div>

        {/* 3.2.x: zoom control BELOW the image (not overlaid on it). */}
        <div className="mx-auto mt-3 flex w-64 max-w-full items-center gap-2">
          <Maximize className="h-3.5 w-3.5 shrink-0 text-white/60" />
          <input
            type="range"
            min={MIN_SCALE}
            max={MAX_SCALE}
            step={0.01}
            value={zoom}
            onChange={(e) => cropperRef.current?.setZoom(parseFloat(e.target.value))}
            className="h-1 flex-1 accent-primary"
            aria-label="Zoom"
          />
          <button
            type="button"
            onClick={() => cropperRef.current?.resetZoom()}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Reset"
            aria-label="Reset crop"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>

        <DialogFooter className="gap-2 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            className="border-0 bg-white/[0.06] text-white ring-1 ring-white/15 hover:bg-white/[0.12]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleApply}
            disabled={busy}
            style={{ color: '#ffffff' }}
            className="font-semibold"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AvatarCropModal
