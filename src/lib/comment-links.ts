/**
 * 7.12.0: URLs pasted into a comment become links.
 *
 * Comments are plain text typed into a textarea, and until now a URL in one
 * was just blue-less text you had to select and copy — an editor pasting the
 * deep link of the cut they mean ("see 00:23 in the CLEAN edit: https://…")
 * gave the reader a wall of characters and no way through it. This turns each
 * URL into a real anchor at display time; the stored comment stays exactly
 * what was typed, like the list transform.
 *
 * It runs LAST in the display pipeline, on HTML that DOMPurify has already
 * sanitized, which is what makes it safe: the text is escaped (`&` is
 * `&amp;`, `<` is `&lt;`), so a match can only ever be http(s)/www text, and
 * the href is built from that match — never from raw input — and
 * attribute-escaped again. Existing tags are stepped over, so a URL inside a
 * `<li>` gets linked but an attribute never does, and an anchor DOMPurify let
 * through is left alone rather than nested.
 *
 * Links to the app itself (same host) open in the same tab, like any
 * navigation; everything else opens in a new tab with `noopener noreferrer`,
 * so a review thread never hands its window to a third-party page.
 */

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi
// Entities that mean "the URL ended here" in escaped text.
const ENTITY_STOP_RE = /&(?:lt|gt|quot|nbsp|#39|#x27);/i
const TRAILING_PUNCT_RE = /[.,;:!?…]+$/

export interface LinkifyOptions {
  /** `location.host` of the app; a link to it opens in the same tab. */
  sameHost?: string | null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
}

function encodeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Trim what a sentence, not the URL, owns: trailing punctuation and unbalanced closers. */
function trimUrlEnd(match: string): string {
  let url = match
  const stop = url.search(ENTITY_STOP_RE)
  if (stop !== -1) url = url.slice(0, stop)
  url = url.replace(TRAILING_PUNCT_RE, '')
  // "(see https://x.y/z)" — drop closers that have no opener inside the URL.
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (url.endsWith(close)) {
      const opens = url.split(open).length - 1
      const closes = url.split(close).length - 1
      if (closes > opens) url = url.slice(0, -1)
      else break
    }
  }
  return url
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).host.toLowerCase()
  } catch {
    return null
  }
}

function linkifyText(text: string, opts: LinkifyOptions): string {
  return text.replace(URL_RE, (raw, offset: number, whole: string) => {
    const shown = trimUrlEnd(raw)
    if (shown.length === 0) return raw
    // A URL right after a word character ("foohttps://…") is not a URL.
    const before = offset > 0 ? whole[offset - 1] : ''
    if (before && /[\w/]/.test(before)) return raw
    const rest = raw.slice(shown.length)
    const decoded = decodeEntities(shown)
    const href = /^www\./i.test(decoded) ? `https://${decoded}` : decoded
    const host = hostOf(href)
    if (!host) return raw
    const internal = !!opts.sameHost && host === opts.sameHost.toLowerCase()
    const attrs = internal ? '' : ' target="_blank" rel="noopener noreferrer nofollow"'
    return `<a href="${encodeAttr(href)}"${attrs}>${shown}</a>${rest}`
  })
}

/**
 * Turn URLs in the text nodes of already-sanitized HTML into anchors.
 * Tags are passed through untouched; text inside an existing <a> is left
 * as it is.
 */
export function linkifyHtml(html: string, opts: LinkifyOptions = {}): string {
  if (!html || !/https?:\/\/|www\./i.test(html)) return html
  let out = ''
  let i = 0
  let anchorDepth = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    const text = lt === -1 ? html.slice(i) : html.slice(i, lt)
    out += anchorDepth > 0 ? text : linkifyText(text, opts)
    if (lt === -1) break
    const gt = html.indexOf('>', lt)
    if (gt === -1) {
      // Unterminated tag: the sanitizer never emits one, but never loop.
      out += html.slice(lt)
      break
    }
    const tag = html.slice(lt, gt + 1)
    if (/^<a[\s>]/i.test(tag)) anchorDepth++
    else if (/^<\/a\s*>/i.test(tag)) anchorDepth = Math.max(0, anchorDepth - 1)
    out += tag
    i = gt + 1
  }
  return out
}
