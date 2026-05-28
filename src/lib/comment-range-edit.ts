/**
 * 1.9.0+: Shared "range-edit" mode for the comment composer.
 *
 * Clicking the timestamp chip in CommentInput activates this mode.
 * While active:
 *   - the white playhead handle dims (CustomVideoControls reads
 *     `isRangeEditActive` via the `commentRangeEditChanged` window
 *     event below);
 *   - the ←/→ arrow keys move the YELLOW OUT handle frame-by-frame
 *     instead of stepping the playhead (VideoPlayer's global keydown
 *     handler routes accordingly);
 *   - Escape, a click on the <video>, or a click outside the timeline
 *     deactivates and returns the player to its normal frame-step
 *     behaviour.
 *
 * State lives at module scope (not React) so non-React-tree consumers
 * (e.g. document-level key handlers) can read the latest value without
 * a render round-trip. All mutations broadcast through a single
 * window event so every listener sees the same source of truth.
 */
let _active = false
let _videoId: string | null = null

export function isRangeEditActive(): boolean {
  return _active
}

export function getRangeEditVideoId(): string | null {
  return _videoId
}

/**
 * Set the range-edit mode on/off. Idempotent: re-emits the event only
 * when the state actually changes, so listeners don't get spammed.
 *
 * Activating without a videoId is allowed (the caller may not know it
 * yet) but consumers should still treat the active flag as primary.
 */
export function setRangeEditActive(
  active: boolean,
  videoId?: string | null,
): void {
  const nextVideoId = active ? videoId ?? null : null
  if (_active === active && _videoId === nextVideoId) return
  _active = active
  _videoId = nextVideoId
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('commentRangeEditChanged', {
        detail: { active: _active, videoId: _videoId },
      }),
    )
  }
}

/**
 * Convenience: toggle the current state. Useful for the chip click
 * handler, which is the only interactive entrypoint to turning the
 * mode ON.
 */
export function toggleRangeEdit(videoId?: string | null): void {
  setRangeEditActive(!_active, videoId)
}
