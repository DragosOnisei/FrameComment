/**
 * 7.8.0: numbered and bulleted lists in comments.
 *
 * The composer is a plain <textarea>, so a list is just lines that start with
 * "1. " or "- ". Two things make that feel like a list anyway:
 *
 *   1. `continueListOnNewline` — Shift+Enter at the end of "1. foo" inserts
 *      "\n2. " (and renumbers any numbered items that follow); Shift+Enter
 *      on an empty "3. " removes the marker instead, which is how every
 *      editor ends a list.
 *   2. `plainTextListsToHtml` — when a comment is displayed, runs of such
 *      lines become real <ol>/<ul> markup, which is what gives them the
 *      hanging indent the plain text cannot have.
 *
 * Both are pure and exercised by a script before release. The stored comment
 * stays plain text: the transform is display-only, so copy, paste, e-mail
 * and export all keep seeing "1. foo".
 */

const NUMBERED = /^(\s*)(\d{1,3})([.)])(\s+)(.*)$/
const BULLETED = /^(\s*)([-*•])(\s+)(.*)$/

export interface ListContinuation {
  value: string
  caret: number
}

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
  if (rest.trim() === '' && selectionStart === selectionEnd) {
    return {
      value: value.slice(0, lineStart) + value.slice(selectionStart),
      caret: lineStart,
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
