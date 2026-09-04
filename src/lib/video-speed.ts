import { timecodeToSeconds, secondsToTimecode } from '@/lib/timecode'

/**
 * 7.5.0: permanent playback-speed rewrite ("Save" next to the speed pill).
 *
 * The player's speed menu is a private viewing aid; this module is about the
 * moment it stops being private: an admin picks a speed, presses Save, and
 * the ORIGINAL file is re-encoded at that speed — the master, every encoded
 * quality, every share link and every download from then on. Pure functions
 * only (browser-safe): the ladder both the menu and the API validate
 * against, the audio-tempo chain the worker feeds ffmpeg, and the arithmetic
 * that repositions existing comments/markers so a note left on a frame stays
 * on that frame after the frame moved earlier in time.
 */

/** The speed ladder, per Dragos's spec (2026-09-02, 0.5x added 2026-09-03).
 *  The menu renders exactly this; J/L step through it, and J below the
 *  bottom rung enters reverse playback (see VideoPlayer). */
export const PLAYBACK_SPEED_LADDER = [0.5, 1, 1.1, 1.15, 1.2, 1.25, 1.5, 2, 4] as const

/** Factors that can be BAKED into the file: strictly faster than 1x. 1x is
 *  not on it — saving a 1x "change" would re-encode the master for nothing.
 *  0.5x is not on it either, on purpose: the rewrite pins the source frame
 *  rate, so a 0.5x master would be slow motion by frame DUPLICATION — a
 *  stuttering deliverable nobody asked for. Half speed is a viewing aid; if
 *  a real slow-mo export is ever wanted it needs frame interpolation, not a
 *  flag flip here. */
export const SAVEABLE_SPEED_FACTORS = PLAYBACK_SPEED_LADDER.filter((f) => f > 1)

/**
 * 7.5.0: sessionStorage key set by the player right before the post-confirm
 * reload, holding the id of the video being rewritten. The admin page reads
 * it to keep showing the PROCESSING card for that exact version instead of
 * silently falling back to an older version of the stack — live testing
 * showed the player swapping to v1 (normal speed, full length) mid-rewrite,
 * which read as "the speed save did nothing". Session-scoped on purpose:
 * per-tab, survives the reload, gone when the tab closes.
 */
export const SPEED_REWRITE_STORAGE_KEY = 'fc:speed-rewrite-video-id'

export function isSaveableSpeedFactor(factor: number): boolean {
  return SAVEABLE_SPEED_FACTORS.some((f) => Math.abs(f - factor) < 0.001)
}

/** "1.15x", "2x" — one formatter for the menu, the Save button and the
 *  warning dialog, so no surface ever shows a differently-rounded number. */
export function formatSpeedFactor(factor: number): string {
  return `${factor}x`.replace(/\.?0+x$/, 'x')
}

/**
 * ffmpeg's atempo filter only accepts 0.5–2.0 per instance, so 4x has to be
 * two chained doublings. Every ladder factor ≤ 2 is a single instance. The
 * chain preserves pitch — a 1.15x ad must not sound like chipmunks.
 */
export function atempoChainForFactor(factor: number): string[] {
  const chain: string[] = []
  let remaining = factor
  while (remaining > 2) {
    chain.push('atempo=2')
    remaining /= 2
  }
  // Guard the rounding dust: 4 / 2 / 2 can land at 1.0000000000000002.
  if (Math.abs(remaining - 1) > 1e-9) chain.push(`atempo=${remaining}`)
  return chain
}

/**
 * A moment on the OLD timeline lands at oldTime / factor on the new one:
 * the same frame, reached sooner. Used for Comment.timestampMs and
 * Marker.timestampMs.
 */
export function rescaleMsForSpeed(ms: number, factor: number): number {
  return Math.max(0, Math.round(ms / factor))
}

/**
 * Same rescale for the HH:MM:SS:FF strings. The fps does not change in the
 * rewrite (the worker pins the source rate), so old and new timecodes speak
 * the same frame language — only the moment moves.
 */
export function rescaleTimecodeForSpeed(
  timecode: string,
  factor: number,
  fps: number,
): string {
  return secondsToTimecode(timecodeToSeconds(timecode, fps) / factor, fps)
}

/**
 * 7.6.0: one tick of the reverse shuttle, as arithmetic.
 *
 * The loop in VideoPlayer runs on requestAnimationFrame and asks this how
 * many whole FRAMES to step back this tick. Frame-quantized because seeking
 * is what costs (an HLS seek may fetch a segment): 1x reverse on a 25fps clip
 * is 25 seeks a second, never 60. The fractional remainder is carried so the
 * wall-clock speed stays exact even when a seek runs late. The step is clamped
 * because rAF stops entirely in a hidden tab — the first tick after coming
 * back would otherwise carry minutes of "elapsed" time and teleport the
 * playhead to 0. Pure, so the simulation exercises the same code.
 */
export const SHUTTLE_MAX_STEP_SECONDS = 0.25

export function advanceShuttle(
  carrySeconds: number,
  elapsedSeconds: number,
  speed: number,
  fps: number,
): { frames: number; carry: number } {
  const frame = 1 / (fps > 0 ? fps : 24)
  const step = Math.min(Math.max(0, elapsedSeconds), SHUTTLE_MAX_STEP_SECONDS) * speed
  let carry = carrySeconds + step
  const frames = Math.floor(carry / frame)
  carry -= frames * frame
  return { frames, carry }
}
