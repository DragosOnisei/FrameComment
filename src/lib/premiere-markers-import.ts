/**
 * 7.14.0: Premiere Pro markers → comments. The reverse of premiere-markers.ts.
 *
 * An editor reviews a cut in Premiere, drops sequence markers with a name and
 * a comment on the moments that need a word, exports the sequence as Final
 * Cut Pro 7 XML (File → Export → Final Cut Pro XML) and imports that file
 * from the comments menu. Every sequence marker becomes one comment on the
 * open video, at the marker's frame, written in the importer's name.
 *
 * Pure, and deliberately DOM-free: the file is read by a small XML tree
 * reader written here rather than by the browser's DOMParser, so the same
 * code runs against a real Premiere export in a node script before release
 * and in the browser afterwards — one parser, not a browser one and a test
 * one that agree until they do not. xmeml is a simple format (elements and
 * text, no namespaces, attributes we never need), which is what makes a
 * reader this small adequate; anything it cannot read is reported as
 * unreadable rather than guessed at.
 *
 * Format notes, in addition to the ones in premiere-markers.ts:
 *   - Only markers that are DIRECT children of a `<sequence>` are timeline
 *     markers. `<marker>` also appears inside `<clipitem>` (a marker on the
 *     clip, in the clip's own frames) — those are not imported; mapping them
 *     onto the timeline needs the clip's speed and trims and is wrong often
 *     enough that Dragos chose to leave them out (2026-09-22).
 *   - A sequence used as a clip inside another sequence appears as a
 *     `<sequence>` nested under a `<clipitem>`. Its markers belong to the
 *     nested timeline, not this one, so only sequences with no `<clipitem>`
 *     ancestor count.
 *   - Marker frames are indices at the sequence's real rate
 *     (`<timebase>` + `<ntsc>`), counted from the sequence's first frame —
 *     the same origin as the exported video — so seconds = in / fps
 *     regardless of the sequence's starting timecode.
 *   - `<out>` is -1 for a point marker; a larger frame makes it a range.
 */

import { secondsToTimecode, timecodeToSeconds } from '@/lib/timecode'
import type { ClippedComment } from '@/lib/comments-clipboard'
import { commentPlainText } from '@/lib/premiere-markers'

// ─── a small XML tree reader ────────────────────────────────────────────────

export interface XmlNode {
  name: string
  children: XmlNode[]
  /** Character data of this element only (children's text excluded), decoded. */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

export class XmlReadError extends Error {}

/**
 * Reads well-formed XML of the shape xmeml uses into a tree. Handles the
 * prolog, DOCTYPE, comments, processing instructions, CDATA, self-closing
 * tags and quoted attribute values (which may legally contain `>`).
 * Mismatched tags are an error: a file this reader cannot follow is not one
 * we should place comments from.
 */
export function readXml(source: string): XmlNode {
  const s = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const root: XmlNode = { name: '#document', children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  const n = s.length

  const top = () => stack[stack.length - 1]

  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt === -1) {
      top().text += decodeEntities(s.slice(i))
      break
    }
    if (lt > i) top().text += decodeEntities(s.slice(i, lt))

    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      if (end === -1) throw new XmlReadError('Unterminated comment')
      i = end + 3
      continue
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9)
      if (end === -1) throw new XmlReadError('Unterminated CDATA section')
      top().text += s.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2)
      if (end === -1) throw new XmlReadError('Unterminated processing instruction')
      i = end + 2
      continue
    }
    if (s.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [ ... ].
      let j = lt + 2
      let depth = 0
      for (; j < n; j++) {
        const ch = s[j]
        if (ch === '[') depth++
        else if (ch === ']') depth--
        else if (ch === '>' && depth === 0) break
      }
      if (j >= n) throw new XmlReadError('Unterminated DOCTYPE')
      i = j + 1
      continue
    }

    // A tag. Find its end, skipping quoted attribute values.
    let j = lt + 1
    let quote: string | null = null
    for (; j < n; j++) {
      const ch = s[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
    }
    if (j >= n) throw new XmlReadError('Unterminated tag')
    const inner = s.slice(lt + 1, j)
    i = j + 1

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      const node = top()
      if (stack.length === 1 || node.name !== name) {
        throw new XmlReadError(`Unexpected closing tag </${name}>`)
      }
      stack.pop()
      continue
    }
    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(body.trim())
    if (!nameMatch) throw new XmlReadError('Malformed tag')
    const node: XmlNode = { name: nameMatch[0], children: [], text: '' }
    top().children.push(node)
    if (!selfClosing) stack.push(node)
  }

  if (stack.length !== 1) throw new XmlReadError(`Unclosed element <${top().name}>`)
  return root
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name)
}

function childText(node: XmlNode, name: string): string | null {
  const c = child(node, name)
  return c ? c.text : null
}

// ─── the markers ────────────────────────────────────────────────────────────

export interface ParsedMarker {
  name: string
  comment: string
  inFrame: number
  /** -1 for a point marker. */
  outFrame: number
}

export interface ParsedSequence {
  name: string
  /** Real frame rate, or null when the sequence carries no `<rate>`. */
  fps: number | null
  markers: ParsedMarker[]
}

/** `<rate>` → real fps: timebase 30 + NTSC TRUE is 29.97, 24 + TRUE is 23.976. */
export function rateToFps(rateNode: XmlNode | undefined): number | null {
  if (!rateNode) return null
  const timebase = Number.parseInt(childText(rateNode, 'timebase') ?? '', 10)
  if (!Number.isFinite(timebase) || timebase <= 0) return null
  const ntsc = /^\s*true\s*$/i.test(childText(rateNode, 'ntsc') ?? '')
  return ntsc ? (timebase * 1000) / 1001 : timebase
}

function parseMarker(node: XmlNode): ParsedMarker | null {
  const inFrame = Number.parseInt(childText(node, 'in') ?? '', 10)
  if (!Number.isFinite(inFrame) || inFrame < 0) return null
  const outRaw = Number.parseInt(childText(node, 'out') ?? '-1', 10)
  const outFrame = Number.isFinite(outRaw) && outRaw > inFrame ? outRaw : -1
  return {
    name: (childText(node, 'name') ?? '').trim(),
    comment: (childText(node, 'comment') ?? '').replace(/\r\n?/g, '\n').trim(),
    inFrame,
    outFrame,
  }
}

/**
 * Every timeline — `<sequence>` with no `<clipitem>` ancestor — in document
 * order, each with its own frame rate and its direct `<marker>` children.
 * Sequences without markers are included so the caller can say "the file
 * has a sequence but it has no markers" instead of "no sequence".
 */
export function parseSequences(root: XmlNode): ParsedSequence[] {
  const out: ParsedSequence[] = []
  const walk = (node: XmlNode, insideClip: boolean) => {
    if (node.name === 'sequence' && !insideClip) {
      out.push({
        name: (childText(node, 'name') ?? '').trim(),
        fps: rateToFps(child(node, 'rate')),
        markers: node.children
          .filter((c) => c.name === 'marker')
          .map(parseMarker)
          .filter((m): m is ParsedMarker => m !== null),
      })
    }
    const nextInsideClip = insideClip || node.name === 'clipitem'
    for (const c of node.children) walk(c, nextInsideClip)
  }
  walk(root, false)
  return out
}

/** Reads the file and returns its timelines; throws XmlReadError when it is not xmeml. */
export function parsePremiereMarkersXml(source: string): ParsedSequence[] {
  const root = readXml(source)
  const xmeml = root.children.find((c) => c.name === 'xmeml')
  if (!xmeml) throw new XmlReadError('Not a Final Cut Pro XML file (no <xmeml> root)')
  return parseSequences(xmeml)
}

/**
 * Which timeline the import reads: the one with the most markers. Premiere
 * exports the sequence you selected, and a project export with several
 * marked sequences is rare enough that the busiest one, named in the
 * confirmation, is the right default.
 */
export function pickSequence(sequences: ParsedSequence[]): ParsedSequence | null {
  let best: ParsedSequence | null = null
  for (const s of sequences) {
    if (!best || s.markers.length > best.markers.length) best = s
  }
  return best
}

// ─── markers → comments ─────────────────────────────────────────────────────

/** Comments are stored as sanitized HTML; a marker's text is literal, so the three characters HTML would read are escaped. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The comment's text: the marker's name on the first line, its comment
 * below; whichever one exists when only one does. Premiere gives a new
 * marker the name "" and the comment "" — an empty result means nothing to
 * post, and the caller counts it.
 */
export function markerCommentText(marker: Pick<ParsedMarker, 'name' | 'comment'>): string {
  const name = marker.name.trim()
  const comment = marker.comment.trim()
  if (name && comment && name !== comment) return `${name}\n${comment}`
  return name || comment
}

export interface ImportTargetVideo {
  fps: number
  /** Seconds; 0 or less when unknown. */
  duration: number
}

export interface ExistingComment {
  timecode: string
  timestampMs?: number | null
  content: string
}

export interface MarkerImportPlan {
  /** What will be posted, in timeline order. */
  items: ClippedComment[]
  /** The rate the frames were read at — the sequence's, or the video's when the file has none. */
  fps: number
  /** True when the file carried no rate and the video's was assumed. */
  assumedVideoFps: boolean
  skippedEmpty: number
  skippedBeyondEnd: number
  skippedDuplicate: number
}

/**
 * Places the markers on the video. Frames become seconds at the SEQUENCE's
 * rate (that is what the frame indices count), then a timecode at the
 * VIDEO's rate (that is what the player and the list display). A marker past
 * the end of the video is skipped, not clamped — a note on a frame that does
 * not exist is a note on the wrong frame. A marker identical to a comment
 * already on the video (same moment, same text) is skipped too, so importing
 * the same file twice does not double the list.
 */
export function planMarkerImport(
  sequence: ParsedSequence,
  video: ImportTargetVideo,
  existing: ExistingComment[],
  authorName?: string | null,
): MarkerImportPlan {
  const fps = sequence.fps ?? video.fps
  const assumedVideoFps = sequence.fps == null
  const seen = new Set<string>()
  for (const c of existing) {
    let ms: number | null = typeof c.timestampMs === 'number' ? c.timestampMs : null
    if (ms == null) {
      try {
        ms = Math.round(timecodeToSeconds(c.timecode, video.fps) * 1000)
      } catch {
        continue
      }
    }
    seen.add(`${ms}|${commentPlainText(c.content)}`)
  }

  const plan: MarkerImportPlan = {
    items: [],
    fps,
    assumedVideoFps,
    skippedEmpty: 0,
    skippedBeyondEnd: 0,
    skippedDuplicate: 0,
  }
  const markers = [...sequence.markers].sort((a, b) => a.inFrame - b.inFrame)
  for (const m of markers) {
    const text = markerCommentText(m)
    if (!text) {
      plan.skippedEmpty++
      continue
    }
    const seconds = m.inFrame / fps
    // Half a second of grace: a marker on the last frame of a 24.96 s clip
    // whose stored duration reads 24.9 is on the clip.
    if (video.duration > 0 && seconds > video.duration + 0.5) {
      plan.skippedBeyondEnd++
      continue
    }
    const timestampMs = Math.round(seconds * 1000)
    const key = `${timestampMs}|${text}`
    if (seen.has(key)) {
      plan.skippedDuplicate++
      continue
    }
    seen.add(key)
    const item: ClippedComment = {
      content: escapeHtml(text),
      timecode: secondsToTimecode(seconds, video.fps),
      timestampMs,
    }
    if (m.outFrame > m.inFrame) {
      const endSeconds = m.outFrame / fps
      if (!(video.duration > 0) || endSeconds <= video.duration + 0.5) {
        item.timecodeEnd = secondsToTimecode(endSeconds, video.fps)
      }
    }
    if (authorName) item.authorName = authorName
    plan.items.push(item)
  }
  return plan
}
