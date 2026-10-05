/**
 * 7.18.0: the four kinds of media a folder can hold, decided in ONE place.
 *
 * Until now a file was a VIDEO unless its extension or MIME said image
 * (`isImageExtension` / `isImageMime`, 1.0.9). Audio and documents join
 * (Dragos, 2026-10-05: ".mp3, .pdf și .txt" — plus .wav/.m4a/.aac and .docx
 * on request), and every place that used to ask "image?" asks this module
 * instead: the upload route when it creates the row, the upload hooks when
 * they decide whether the worker is needed, the content route when it picks a
 * Content-Type for the original, and the UI for the chip under the name.
 *
 *   VIDEO     — the FFmpeg pipeline, tiers, storyboard, timeline comments.
 *   IMAGE     — READY at upload, the original IS the thumbnail.
 *   AUDIO     — READY at upload, no thumbnail (the card shows the audio glyph),
 *               plays in the player over a static artwork, timeline comments.
 *   DOCUMENT  — READY at upload, no thumbnail (pdf / text / word glyph),
 *               opens in DocumentViewer, no comments.
 *
 * Browser-safe and pure (no imports), so a node script checks the decisions
 * and both the server routes and the client components share the lists.
 */
export type MediaKind = 'VIDEO' | 'IMAGE' | 'AUDIO' | 'DOCUMENT'

export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac'] as const
export const DOCUMENT_EXTENSIONS = ['.pdf', '.txt', '.docx'] as const
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'] as const
export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.avi', '.webm', '.mkv'] as const

export const AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
] as const
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const

/** Documents stop at 500 MB (Dragos, 2026-10-05); audio keeps the video limits. */
export const DOCUMENT_MAX_BYTES = 500 * 1024 * 1024

/** Content-Type for an ORIGINAL file served by the content route, by extension. */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function extensionOf(filename: string | null | undefined): string {
  if (!filename) return ''
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

const has = (list: readonly string[], v: string) => (list as readonly string[]).includes(v)

/**
 * The kind of media a file is, from its name and (when the browser sent one)
 * its MIME type. The extension decides first: macOS hands over .mov/.avi with
 * an empty MIME, and a `.txt` arrives as text/plain which no other kind
 * claims. The MIME breaks the tie only for names without a known extension.
 * Anything unknown is VIDEO — the pipeline that validates magic bytes and
 * rejects what it cannot read, which is the safe failure.
 */
export function mediaKindFromFile(filename: string | null | undefined, mime?: string | null): MediaKind {
  const ext = extensionOf(filename)
  if (has(IMAGE_EXTENSIONS, ext)) return 'IMAGE'
  if (has(AUDIO_EXTENSIONS, ext)) return 'AUDIO'
  if (has(DOCUMENT_EXTENSIONS, ext)) return 'DOCUMENT'
  if (has(VIDEO_EXTENSIONS, ext)) return 'VIDEO'
  const m = (mime || '').split(';')[0].trim().toLowerCase()
  if (m.startsWith('image/')) return 'IMAGE'
  if (has(AUDIO_MIME_TYPES, m)) return 'AUDIO'
  if (has(DOCUMENT_MIME_TYPES, m)) return 'DOCUMENT'
  return 'VIDEO'
}

/** Media that has a timeline — the player, timecoded comments, the .srt export. */
export function isTimelineMedia(kind: string | null | undefined): boolean {
  return kind === 'VIDEO' || kind === 'AUDIO' || !kind
}

/** Media that the worker never touches: READY the moment the upload lands. */
export function skipsEncoding(kind: string | null | undefined): boolean {
  return kind === 'IMAGE' || kind === 'AUDIO' || kind === 'DOCUMENT'
}

export type DocumentKind = 'pdf' | 'text' | 'word'

/** Which viewer a DOCUMENT needs, from its file name. */
export function documentKind(filename: string | null | undefined): DocumentKind {
  const ext = extensionOf(filename)
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'word'
  return 'text'
}

/**
 * The chip under a card's name: "Video 9:16", "Image", "Audio", "PDF",
 * "Text", "Word". `aspect` is the caller's ratio label for videos (the grid
 * computes it from width/height); it is ignored for every other kind.
 */
export function mediaKindLabel(kind: string | null | undefined, filename?: string | null, aspect?: string | null): string {
  switch (kind) {
    case 'IMAGE':
      return 'Image'
    case 'AUDIO':
      return 'Audio'
    case 'DOCUMENT': {
      const d = documentKind(filename)
      return d === 'pdf' ? 'PDF' : d === 'word' ? 'Word' : 'Text'
    }
    default:
      return aspect ? `Video ${aspect}` : 'Video'
  }
}

/** Content-Type for an original file, by its name; video/mp4 when unknown. */
export function originalContentType(filename: string | null | undefined): string {
  return MEDIA_CONTENT_TYPES[extensionOf(filename)] || 'video/mp4'
}

/** The `accept` attribute for the upload inputs — every kind the app takes. */
export const UPLOAD_ACCEPT = [
  'video/*',
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
].join(',')

/** Client-side pre-check for a dropped/picked file: is it something we upload as media? */
export function isAcceptedMediaFile(name: string | null | undefined, mime?: string | null): boolean {
  const ext = extensionOf(name)
  if (has(VIDEO_EXTENSIONS, ext) || has(IMAGE_EXTENSIONS, ext) || has(AUDIO_EXTENSIONS, ext) || has(DOCUMENT_EXTENSIONS, ext)) return true
  const m = (mime || '').toLowerCase()
  return m.startsWith('video/') || m.startsWith('image/') || has(AUDIO_MIME_TYPES, m) || has(DOCUMENT_MIME_TYPES, m)
}
