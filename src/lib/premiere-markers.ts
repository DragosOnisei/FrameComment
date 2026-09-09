/**
 * 7.8.0: comments → Premiere Pro markers.
 *
 * Editors asked for the notes to land in their timeline instead of being
 * retyped from the sidebar. Premiere Pro imports the Final Cut Pro 7 XML
 * interchange format ("xmeml", File → Import); a `<sequence>` in that file
 * may carry `<marker>` elements, and so may the `<clipitem>` inside it.
 * Importing the file therefore gives the editor a sequence named after the
 * cut, one marker per comment at the comment's frame, the author and the
 * text in the marker, and the same markers on the clip itself so they can be
 * copied onto the real timeline. The referenced media is offline by design
 * (we cannot know the editor's local path); relinking is one click and the
 * markers do not depend on it.
 *
 * Pure: no DOM, no network — the same function is exercised by a script
 * before every release. Frame math goes through the project's own
 * `timecodeToSeconds`, so drop-frame rates (29.97, 59.94) resolve exactly
 * the way the player resolves them.
 *
 * Format notes that cost time to learn, kept here so nobody re-learns them:
 *   - `<rate>` is an integer `<timebase>` plus an `<ntsc>` flag; 23.976 is
 *     timebase 24 + NTSC TRUE, 29.97 is 30 + TRUE. Marker frames are indices
 *     at the real rate, which is exactly what `timecodeToSeconds(tc) * fps`
 *     gives.
 *   - A marker with no duration has `<out>-1</out>`; ranged comments get a
 *     real out frame instead.
 *   - Everything user-written is XML-escaped; control characters are
 *     dropped because XML 1.0 forbids them and Premiere rejects the file.
 */

import { timecodeToSeconds, isDropFrame } from '@/lib/timecode'

export interface MarkerVideo {
  name: string
  versionLabel?: string | null
  fps: number
  /** Seconds. */
  duration: number
  width: number
  height: number
}

export interface MarkerReply {
  authorName?: string | null
  content: string
}

export interface MarkerComment {
  timecode: string
  timecodeEnd?: string | null
  authorName?: string | null
  /** May contain the sanitized HTML the app stores; tags are stripped. */
  content: string
  replies?: MarkerReply[]
}

export interface PremiereRate {
  timebase: number
  ntsc: boolean
}

/** 23.976 → 24/NTSC, 29.97 → 30/NTSC, 59.94 → 60/NTSC, integers as they are. */
export function fpsToRate(fps: number): PremiereRate {
  const timebase = Math.max(1, Math.round(fps))
  const ntsc = Math.abs(fps - timebase) > 0.01
  return { timebase, ntsc }
}

/** Frame index at the real frame rate for a HH:MM:SS:FF / HH:MM:SS;FF timecode. */
export function timecodeToFrame(timecode: string, fps: number): number {
  const seconds = timecodeToSeconds(timecode, fps)
  return Math.max(0, Math.round(seconds * fps))
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * The app stores comments as sanitized HTML (plain text plus the few tags the
 * composer allows). A marker wants text: line breaks kept, tags gone,
 * entities decoded. No DOM, so it also runs in a script.
 */
export function commentPlainText(html: string): string {
  return html
    // Two paragraphs back to back are one line break, not two.
    .replace(/<\/(p|div)>\s*<(p|div)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Block boundaries become line breaks on both sides ("x<p>y</p>" reads as
    // two lines); a list item starts its own line with a bullet.
    .replace(/<\/(p|div|ol|ul)>/gi, '\n')
    .replace(/<(p|div)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const n =
          code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : whole
      }
      return ENTITIES[code.toLowerCase()] ?? whole
    })
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// XML 1.0 forbids C0 control characters other than tab, newline and carriage
// return. Built with fromCharCode rather than written as escapes so the source
// file itself contains none of them.
const XML_FORBIDDEN = new RegExp(
  '[' +
    String.fromCharCode(0) + '-' + String.fromCharCode(8) +
    String.fromCharCode(11) + String.fromCharCode(12) +
    String.fromCharCode(14) + '-' + String.fromCharCode(31) +
    ']',
  'g',
)
// Path separators, the characters Windows refuses, whitespace (a space after a
// colon would otherwise leave "Hero_ Final") and control characters.
const FILENAME_UNSAFE = new RegExp(
  '[\\\\/:*?"<>|\\s' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']+',
  'g',
)

/** XML 1.0: escape the five, drop the control characters the spec forbids. */
export function xmlEscape(value: string): string {
  return value
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function rateXml(rate: PremiereRate, indent: string): string {
  return `${indent}<rate>\n${indent}\t<timebase>${rate.timebase}</timebase>\n${indent}\t<ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>\n${indent}</rate>`
}

export interface BuiltMarker {
  inFrame: number
  outFrame: number
  name: string
  comment: string
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** One marker per top-level comment, replies folded into the marker text. */
export function buildMarkers(video: MarkerVideo, comments: MarkerComment[]): BuiltMarker[] {
  const markers: BuiltMarker[] = []
  for (const c of comments) {
    let inFrame: number
    try {
      inFrame = timecodeToFrame(c.timecode, video.fps)
    } catch {
      continue // a malformed timecode cannot be placed; skip rather than fail the file
    }
    let outFrame = -1
    if (c.timecodeEnd) {
      try {
        const end = timecodeToFrame(c.timecodeEnd, video.fps)
        if (end > inFrame) outFrame = end
      } catch {
        /* point marker */
      }
    }
    const author = (c.authorName || '').trim() || 'Anonymous'
    const text = commentPlainText(c.content)
    const replyLines = (c.replies ?? [])
      .map((r) => {
        const who = (r.authorName || '').trim() || 'Anonymous'
        const body = commentPlainText(r.content)
        return body ? `↳ ${who}: ${body}` : ''
      })
      .filter(Boolean)
    const comment = [text, ...replyLines].filter(Boolean).join('\n')
    markers.push({
      inFrame,
      outFrame,
      name: `${author}: ${firstLine(text, 80) || '(attachment)'}`,
      comment,
    })
  }
  markers.sort((a, b) => a.inFrame - b.inFrame)
  return markers
}

function markerXml(m: BuiltMarker, indent: string): string {
  return [
    `${indent}<marker>`,
    `${indent}\t<name>${xmlEscape(m.name)}</name>`,
    `${indent}\t<comment>${xmlEscape(m.comment)}</comment>`,
    `${indent}\t<in>${m.inFrame}</in>`,
    `${indent}\t<out>${m.outFrame}</out>`,
    `${indent}</marker>`,
  ].join('\n')
}

function safeFileStem(name: string): string {
  const stem = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(FILENAME_UNSAFE, '_')
    .trim()
  return stem || 'video'
}

export function premiereMarkersFileName(video: Pick<MarkerVideo, 'name' | 'versionLabel'>): string {
  const label = (video.versionLabel || '').trim()
  return `${safeFileStem(video.name)}${label ? `_${label.replace(/[^\w.-]+/g, '_')}` : ''}_markers.xml`
}

export interface BuildOptions {
  /** Injected so the output is reproducible in tests. */
  uuid?: string
}

/**
 * The whole file. One sequence, one video track, one clip spanning the cut,
 * the markers on both the sequence and the clip.
 */
export function buildPremiereMarkersXml(
  video: MarkerVideo,
  comments: MarkerComment[],
  opts: BuildOptions = {},
): string {
  if (!(video.fps > 0)) throw new Error('A frame rate is required to place markers')
  const rate = fpsToRate(video.fps)
  const markers = buildMarkers(video, comments)
  const lastFrame = markers.reduce((max, m) => Math.max(max, m.inFrame, m.outFrame), 0)
  const durationFrames = Math.max(
    Math.ceil(Math.max(0, video.duration) * video.fps),
    lastFrame + 1,
    1,
  )
  const uuid =
    opts.uuid ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `fc-${Date.now().toString(16)}`)
  const label = (video.versionLabel || '').trim()
  const sequenceName = `${video.name}${label ? ` ${label}` : ''} — FrameComment markers`
  const clipName = video.name
  const pathurl = `file://localhost/${encodeURIComponent(video.name)}`
  const width = Math.max(1, Math.round(video.width || 1920))
  const height = Math.max(1, Math.round(video.height || 1080))
  const displayformat = isDropFrame(video.fps) ? 'DF' : 'NDF'

  const sequenceMarkers = markers.map((m) => markerXml(m, '\t\t')).join('\n')
  const clipMarkers = markers.map((m) => markerXml(m, '\t\t\t\t\t\t')).join('\n')

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="4">`,
    `\t<sequence id="sequence-1">`,
    `\t\t<uuid>${xmlEscape(uuid)}</uuid>`,
    `\t\t<duration>${durationFrames}</duration>`,
    rateXml(rate, '\t\t'),
    `\t\t<name>${xmlEscape(sequenceName)}</name>`,
    `\t\t<media>`,
    `\t\t\t<video>`,
    `\t\t\t\t<format>`,
    `\t\t\t\t\t<samplecharacteristics>`,
    rateXml(rate, '\t\t\t\t\t\t'),
    `\t\t\t\t\t\t<width>${width}</width>`,
    `\t\t\t\t\t\t<height>${height}</height>`,
    `\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>`,
    `\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>`,
    `\t\t\t\t\t\t<fielddominance>none</fielddominance>`,
    `\t\t\t\t\t</samplecharacteristics>`,
    `\t\t\t\t</format>`,
    `\t\t\t\t<track>`,
    `\t\t\t\t\t<clipitem id="clipitem-1">`,
    `\t\t\t\t\t\t<name>${xmlEscape(clipName)}</name>`,
    `\t\t\t\t\t\t<duration>${durationFrames}</duration>`,
    rateXml(rate, '\t\t\t\t\t\t'),
    `\t\t\t\t\t\t<start>0</start>`,
    `\t\t\t\t\t\t<end>${durationFrames}</end>`,
    `\t\t\t\t\t\t<in>0</in>`,
    `\t\t\t\t\t\t<out>${durationFrames}</out>`,
    `\t\t\t\t\t\t<file id="file-1">`,
    `\t\t\t\t\t\t\t<name>${xmlEscape(clipName)}</name>`,
    `\t\t\t\t\t\t\t<pathurl>${xmlEscape(pathurl)}</pathurl>`,
    rateXml(rate, '\t\t\t\t\t\t\t'),
    `\t\t\t\t\t\t\t<duration>${durationFrames}</duration>`,
    `\t\t\t\t\t\t\t<media>`,
    `\t\t\t\t\t\t\t\t<video>`,
    `\t\t\t\t\t\t\t\t\t<samplecharacteristics>`,
    rateXml(rate, '\t\t\t\t\t\t\t\t\t\t'),
    `\t\t\t\t\t\t\t\t\t\t<width>${width}</width>`,
    `\t\t\t\t\t\t\t\t\t\t<height>${height}</height>`,
    `\t\t\t\t\t\t\t\t\t</samplecharacteristics>`,
    `\t\t\t\t\t\t\t\t</video>`,
    `\t\t\t\t\t\t\t</media>`,
    `\t\t\t\t\t\t</file>`,
    clipMarkers,
    `\t\t\t\t\t</clipitem>`,
    `\t\t\t\t</track>`,
    `\t\t\t</video>`,
    `\t\t</media>`,
    `\t\t<timecode>`,
    rateXml(rate, '\t\t\t'),
    `\t\t\t<string>00:00:00:00</string>`,
    `\t\t\t<frame>0</frame>`,
    `\t\t\t<displayformat>${displayformat}</displayformat>`,
    `\t\t</timecode>`,
    sequenceMarkers,
    `\t</sequence>`,
    `</xmeml>`,
    ``,
  ]
  // Marker groups are '' when there are no comments; drop those empty lines,
  // keep the final '' so the file ends with a newline.
  return lines.filter((line, idx) => line !== '' || idx === lines.length - 1).join('\n')
}
