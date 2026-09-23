/**
 * 7.15.0: comments → SubRip subtitles (.srt).
 *
 * Editors asked for the notes to travel with the cut as captions rather than
 * as timeline markers: an .srt drops onto any NLE's caption track (Premiere,
 * Resolve, Final Cut via a converter) and onto any player, and the note is
 * then READ over the picture at the moment it is about — "logo too small"
 * appears while the logo is on screen. The 7.8.0 Final Cut XML export did
 * the same with markers and was retired from the menu on 2026-09-23 at
 * Dragos's request ("așa e mai ușor pentru editori"); its builder stays in
 * premiere-markers.ts because the import (7.14.0) shares its text helpers
 * and round-trips through it in the release script.
 *
 * Format notes worth keeping:
 *   - A cue is `index`, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, one or more text
 *     lines, then a BLANK line. A blank line inside the text would end the
 *     cue early, so the text has its empty lines removed.
 *   - Times are milliseconds with a comma — the one thing every SRT reader
 *     agrees on. A comment's exact moment (`timestampMs`) is preferred over
 *     its frame-rounded timecode, so the caption appears where the reviewer
 *     actually paused.
 *   - Cues never overlap. Premiere puts an imported .srt on ONE caption
 *     track, and two captions on one track cannot share a moment; a comment
 *     with no range is shown for a default span and cut short if the next
 *     comment arrives first. Comments on the same frame become one cue
 *     with both notes, so nothing is dropped.
 *   - UTF-8 with a BOM and CRLF line ends. Premiere and Windows tools sniff
 *     the encoding, and without the BOM a Romanian ș or ț has been read as
 *     Latin-1 garbage more than once; the BOM costs three bytes and removes
 *     the guess.
 *
 * Pure: no DOM, no network — the same function is exercised by a node
 * script before every release.
 */

import { timecodeToSeconds } from '@/lib/timecode'
import { commentPlainText } from '@/lib/premiere-markers'

export interface SrtVideo {
  name: string
  versionLabel?: string | null
  fps: number
  /** Seconds; 0 or less when unknown. */
  duration: number
}

export interface SrtReply {
  authorName?: string | null
  content: string
}

export interface SrtComment {
  timecode: string
  timecodeEnd?: string | null
  /** The exact moment, when the comment has one (1.0.3+). */
  timestampMs?: number | null
  authorName?: string | null
  /** May contain the sanitized HTML the app stores; tags are stripped. */
  content: string
  replies?: SrtReply[]
}

export interface SrtOptions {
  /** How long a comment with no range stays on screen. */
  defaultDurationMs?: number
  /** The least a cue is allowed to last when the next comment crowds it. */
  minDurationMs?: number
}

export const SRT_DEFAULT_DURATION_MS = 4000
export const SRT_MIN_DURATION_MS = 500

export interface SrtCue {
  startMs: number
  endMs: number
  lines: string[]
}

/** `HH:MM:SS,mmm` — hours grow past two digits rather than wrapping. */
export function srtTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const milli = total % 1000
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(h)}:${two(m)}:${two(s)},${String(milli).padStart(3, '0')}`
}

/** The cue's text for one comment: author on the first line's front, replies indented, no blank lines. */
export function commentCueLines(c: SrtComment): string[] {
  const author = (c.authorName || '').trim() || 'Anonymous'
  const text = commentPlainText(c.content) || '(attachment)'
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) lines.push('(attachment)')
  lines[0] = `${author}: ${lines[0]}`
  for (const r of c.replies ?? []) {
    const who = (r.authorName || '').trim() || 'Anonymous'
    const body = commentPlainText(r.content)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (body.length === 0) continue
    lines.push(`↳ ${who}: ${body[0]}`)
    for (const extra of body.slice(1)) lines.push(`  ${extra}`)
  }
  return lines
}

function startMsOf(c: SrtComment, fps: number): number | null {
  if (typeof c.timestampMs === 'number' && Number.isFinite(c.timestampMs) && c.timestampMs >= 0) {
    return Math.round(c.timestampMs)
  }
  try {
    return Math.max(0, Math.round(timecodeToSeconds(c.timecode, fps) * 1000))
  } catch {
    return null // a malformed timecode cannot be placed; skip rather than fail the file
  }
}

/**
 * Comments → non-overlapping cues in time order. Exported for the tests;
 * `buildCommentsSrt` is what the menu calls.
 */
export function buildSrtCues(
  video: SrtVideo,
  comments: SrtComment[],
  opts: SrtOptions = {},
): SrtCue[] {
  const defaultDuration = opts.defaultDurationMs ?? SRT_DEFAULT_DURATION_MS
  const minDuration = opts.minDurationMs ?? SRT_MIN_DURATION_MS
  const durationMs = video.duration > 0 ? Math.round(video.duration * 1000) : 0

  // Group by frame: two notes left on the same frame are one caption with
  // both texts, not two captions fighting for the same moment.
  const groups = new Map<string, { startMs: number; endMs: number; lines: string[] }>()
  for (const c of comments) {
    const start = startMsOf(c, video.fps)
    if (start === null) continue
    let end = start + defaultDuration
    if (c.timecodeEnd) {
      try {
        const e = Math.round(timecodeToSeconds(c.timecodeEnd, video.fps) * 1000)
        if (e > start) end = e
      } catch {
        /* point caption */
      }
    }
    // A caption cannot outlive the picture — unless the note is on the very
    // last frame, where it gets the minimum span so it exists at all.
    if (durationMs > 0 && end > durationMs) end = Math.max(durationMs, start + minDuration)
    const key = c.timecode
    const g = groups.get(key)
    const lines = commentCueLines(c)
    if (g) {
      g.startMs = Math.min(g.startMs, start)
      g.endMs = Math.max(g.endMs, end)
      g.lines.push(...lines)
    } else {
      groups.set(key, { startMs: start, endMs: end, lines })
    }
  }

  const cues = [...groups.values()].sort((a, b) => a.startMs - b.startMs)
  // No overlaps: a cue ends the millisecond before the next one starts if it
  // would otherwise run into it. When the next comment is so close that not
  // even the minimum span fits, the cue keeps the minimum and the reader
  // shows them stacked — the alternative is dropping a note.
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1]
    if (cues[i].endMs >= next.startMs) {
      cues[i].endMs = Math.max(next.startMs - 1, cues[i].startMs + minDuration)
    }
  }
  return cues
}

function safeFileStem(name: string): string {
  const stem = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .trim()
  return stem || 'video'
}

export function commentsSrtFileName(video: Pick<SrtVideo, 'name' | 'versionLabel'>): string {
  const label = (video.versionLabel || '').trim()
  return `${safeFileStem(video.name)}${label ? `_${label.replace(/[^\w.-]+/g, '_')}` : ''}_comments.srt`
}

/** The whole file: BOM, CRLF, one cue per non-overlapping moment. */
export function buildCommentsSrt(
  video: SrtVideo,
  comments: SrtComment[],
  opts: SrtOptions = {},
): string {
  const cues = buildSrtCues(video, comments, opts)
  const blocks = cues.map((cue, i) =>
    [`${i + 1}`, `${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}`, ...cue.lines].join('\r\n'),
  )
  return '﻿' + blocks.join('\r\n\r\n') + (blocks.length ? '\r\n' : '')
}
