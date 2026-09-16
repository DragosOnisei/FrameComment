/**
 * 7.8.0: numbered and bulleted lists in comments.
 *
 * The composer is a plain <textarea>, so a list is just lines that start with
 * "1. " or "- ". Two things make that feel like a list anyway:
 *
 *   1. `continueListOnNewline` — Shift+Enter at the end of "1. foo" inserts
 *      "\n2. " (and renumbers any numbered items that follow); Shift+Enter
 *      on an empty "3. " below another item removes the marker instead,
 *      which is how every editor ends a list.
 *   2. `plainTextListsToHtml` — when a comment is displayed, runs of such
 *      lines become real <ol>/<ul> markup, which is what gives them the
 *      hanging indent the plain text cannot have.
 *   3. (7.10.0) `indentListMarkerOnSpace` / `removeListMarkerOnBackspace` —
 *      the space after a marker typed at the start of a line indents it
 *      (`LIST_INDENT`), and Backspace straight after undoes that. The three
 *      keystrokes are wired by `handleListKeydown` (comment-list-keys.ts) in
 *      both the composer and the reply box.
 *
 * Both are pure and exercised by a script before release. The stored comment
 * stays plain text: the transform is display-only, so copy, paste, e-mail
 * and export all keep seeing "1. foo".
 */

const NUMBERED = /^(\s*)(\d{1,3})([.)])(\s+)(.*)$/
const BULLETED = /^(\s*)([-*•])(\s+)(.*)$/

/**
 * 7.10.0: the indent a marker gets when it is typed at the start of a line.
 * A <textarea> cannot indent one line by CSS, so the indent is literal spaces
 * in the text — the display transform strips them again (its regexes allow
 * leading whitespace), e-mail and export keep them harmlessly.
 */
export const LIST_INDENT = '    '
// A line that is nothing but a marker so far: "1." / "12)" / "-" / "*" / "•".
const MARKER_ONLY = /^(\d{1,3}[.)]|[-*•])$/
// "    1. " exactly — an auto-indented marker with nothing typed after it yet.
const INDENTED_EMPTY_MARKER = new RegExp(`^${LIST_INDENT}(\\d{1,3}[.)]|[-*•]) $`)

export interface ListContinuation {
  value: string
  caret: number
}

/** 7.10.0: the shape every list keystroke helper returns. */
export type ListEdit = ListContinuation

/**
 * What Shift+Enter should do at `selectionStart..selectionEnd` in `value`.
 * Returns null when the current line is not a list item (the caller then
 * lets the browser insert a plain newline).
 */
export function continueListOnNewline(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ListContinuation | null {
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  const line = value.slice(lineStart, selectionStart)
  const numbered = NUMBERED.exec(line)
  const bulleted = numbered ? null : BULLETED.exec(line)
  if (!numbered && !bulleted) return null

  const indent = (numbered ?? bulleted)![1]
  const rest = numbered ? numbered[5] : bulleted![4]

  // An empty item means "I am done with the list": drop the marker and leave
  // the caret on the now-empty line. Only when nothing is selected — a
  // selection means the person is replacing text, not ending a list.
  //
  // 7.10.0: …but only when there IS a list to be done with, i.e. the line
  // above is an item of the same kind. A lone "1. " followed by Shift+Enter
  // is not someone leaving a list, it is someone starting one and checking
  // that the numbering follows — Dragos did exactly that, watched "1. "
  // vanish, and reported that Shift+Enter "does nothing". Ending the list
  // still works the way every editor does it: Shift+Enter twice.
  if (rest.trim() === '' && selectionStart === selectionEnd) {
    const prevLine =
      lineStart > 0
        ? value.slice(value.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1)
        : null
    const prevIsItem =
      prevLine !== null && (numbered ? NUMBERED.test(prevLine) : BULLETED.test(prevLine))
    if (prevIsItem) {
      return {
        value: value.slice(0, lineStart) + value.slice(selectionStart),
        caret: lineStart,
      }
    }
  }

  let marker: string
  let renumberFrom: number | null = null
  let separator = ''
  if (numbered) {
    const next = Number(numbered[2]) + 1
    separator = numbered[3]
    marker = `${indent}${next}${separator}${numbered[4]}`
    renumberFrom = next
  } else {
    marker = `${indent}${bulleted![2]}${bulleted![3]}`
  }

  const insert = `\n${marker}`
  let after = value.slice(selectionEnd)

  // Inserting in the middle of a numbered list: the items that follow shift
  // by one so the list keeps counting straight. Stops at the first line that
  // is not a numbered item at the same indent with the same separator.
  if (renumberFrom !== null) {
    const tailStart = after.indexOf('\n')
    if (tailStart !== -1) {
      const head = after.slice(0, tailStart)
      const lines = after.slice(tailStart + 1).split('\n')
      let expected = renumberFrom + 1
      for (let i = 0; i < lines.length; i++) {
        const m = NUMBERED.exec(lines[i])
        if (!m || m[1] !== indent || m[3] !== separator) break
        lines[i] = `${indent}${expected}${separator}${m[4]}${m[5]}`
        expected++
      }
      after = `${head}\n${lines.join('\n')}`
    }
  }

  return {
    value: value.slice(0, selectionStart) + insert + after,
    caret: selectionStart + insert.length,
  }
}

/**
 * 7.10.0: what typing a space should do. When the line so far is exactly a
 * marker ("1." / "-"), the line becomes "    1. " — the marker moves in and
 * reads as a list item from that moment, which is the "auto indent" the
 * plain textarea can otherwise not show. Null for every ordinary space.
 */
export function indentListMarkerOnSpace(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ListEdit | null {
  if (selectionStart !== selectionEnd) return null
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  const line = value.slice(lineStart, selectionStart)
  if (!MARKER_ONLY.test(line)) return null
  // Only at the end of the line: a space typed into "1.|more" is a space.
  const lineEnd = value.indexOf('\n', selectionStart)
  if (value.slice(selectionStart, lineEnd === -1 ? value.length : lineEnd) !== '') return null
  const replaced = `${LIST_INDENT}${line} `
  return {
    value: value.slice(0, lineStart) + replaced + value.slice(selectionStart),
    caret: lineStart + replaced.length,
  }
}

/**
 * 7.10.0: Backspace right after an auto-indented marker ("    1. |") removes
 * the whole marker, indent included, instead of one space — the way every
 * editor un-lists a line — so a person who did not want a list is not left
 * with four invisible spaces to hunt down. Null for every ordinary Backspace.
 */
export function removeListMarkerOnBackspace(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ListEdit | null {
  if (selectionStart !== selectionEnd) return null
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  const line = value.slice(lineStart, selectionStart)
  if (!INDENTED_EMPTY_MARKER.test(line)) return null
  return {
    value: value.slice(0, lineStart) + value.slice(selectionStart),
    caret: lineStart,
  }
}

function isListBlock(chunk: string): boolean {
  return /^<(ol|ul)\b/.test(chunk)
}

/**
 * Display-time transform: runs of "1. …" lines become <ol>, runs of "- …"
 * lines become <ul>. Input is the already-sanitized HTML string of a
 * comment (plain text with escaped entities and newlines); output is the
 * same string with those runs replaced by list markup. Content that already
 * contains list tags is returned untouched.
 *
 * Newlines directly before or after a list block are dropped: the block
 * breaks the line by itself, and with `white-space: pre-wrap` a leftover
 * "\n" would paint an empty line above or below the list.
 */
export function plainTextListsToHtml(html: string): string {
  if (!html || /<(ol|ul|li)\b/i.test(html)) return html
  if (!/^\s*(\d{1,3}[.)]|[-*•])\s+\S/m.test(html)) return html

  const lines = html.split('\n')
  const chunks: string[] = []
  let i = 0
  while (i < lines.length) {
    const numbered = NUMBERED.exec(lines[i])
    const bulleted = numbered ? null : BULLETED.exec(lines[i])
    if (!numbered && !bulleted) {
      chunks.push(lines[i])
      i++
      continue
    }
    const kind = numbered ? 'ol' : 'ul'
    const start = numbered ? Number(numbered[2]) : 1
    const items: string[] = []
    while (i < lines.length) {
      const m = kind === 'ol' ? NUMBERED.exec(lines[i]) : BULLETED.exec(lines[i])
      if (!m) break
      const text = kind === 'ol' ? m[5] : m[4]
      if (text.trim() === '') break // an empty marker is not an item
      items.push(`<li>${text}</li>`)
      i++
    }
    if (items.length === 0) {
      chunks.push(lines[i])
      i++
      continue
    }
    const startAttr = kind === 'ol' && start !== 1 ? ` start="${start}"` : ''
    chunks.push(`<${kind}${startAttr}>${items.join('')}</${kind}>`)
  }

  let out = ''
  for (let k = 0; k < chunks.length; k++) {
    if (k > 0 && !isListBlock(chunks[k - 1]) && !isListBlock(chunks[k])) out += '\n'
    out += chunks[k]
  }
  return out
}
