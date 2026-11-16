import { apiPost } from '@/lib/api-client'

/**
 * 7.20.3: tells the server an upload was paused or resumed, so the
 * abandoned-upload reaper and the bottom-right banner can tell "paused"
 * from "dead" (see /api/videos/[id]/upload-pause). Fire-and-forget: a
 * failed report must never stand in the way of the pause itself — the
 * worst case is the pre-7.20.3 behaviour.
 */
export function reportUploadPaused(videoId: string | null | undefined, paused: boolean): void {
  if (!videoId) return
  apiPost(`/api/videos/${videoId}/upload-pause`, { paused }).catch(() => {
    /* best effort */
  })
}
