/**
 * 7.3.4 — the classic text faces become emoji as you type them.
 *
 * `:)` has meant a smile for forty years and people type it without thinking.
 * Every chat app they use turns it into one, so a review tool that leaves it as
 * two characters of punctuation feels like it is not listening.
 *
 * WHY IT IS NOT A GLOBAL FIND-AND-REPLACE
 *
 * Two of the classic faces are also substrings of things nobody means as a
 * face. `:/` lives inside every `http://` and `:(` inside plenty of pasted
 * code. So a token only converts when the character in front of it is
 * whitespace or the start of the text, which is the rule that lets someone
 * paste a URL into a comment and get a URL back.
 *
 * And it converts only what was JUST typed — the token has to end exactly at
 * the caret. Editing a word in the middle of a finished sentence never
 * rewrites something further along that happens to look like a face.
 *
 * The longest token wins, so `>:(` becomes an angry face rather than a `>`
 * followed by a sad one.
 *
 * `8)` is deliberately absent while `8-)` is here. The whitespace rule is not
 * enough to save it: people write numbered lists, and "point 8) is wrong" would
 * have turned into a pair of sunglasses. A face nobody can type is a smaller
 * loss than a list that mangles itself.
 */

/**
 * Tokens are matched case-insensitively, which is what makes `:d`, `:D`, `xD`
 * and `XD` all work. The punctuation is exact.
 */
const EMOTICONS: ReadonlyArray<readonly [string, string]> = [
  // Three characters and up first — see the longest-token rule above.
  [">:(", '😠'],
  [":'(", '😢'],
  [':-)', '🙂'],
  [':-(', '🙁'],
  [':-d', '😀'],
  [';-)', '😉'],
  [':-p', '😛'],
  [':-o', '😮'],
  [':-|', '😐'],
  [':-/', '😕'],
  [':-*', '😘'],
  ['8-)', '😎'],
  [':-s', '😖'],
  // Two characters.
  [':)', '🙂'],
  [':(', '🙁'],
  [':d', '😀'],
  [';)', '😉'],
  [':p', '😛'],
  [':o', '😮'],
  [':|', '😐'],
  [':/', '😕'],
  [':*', '😘'],
  ['xd', '😆'],
  [':s', '😖'],
  ['<3', '❤️'],
]

/** Sorted once, longest first, so matching never settles for a shorter token. */
const SORTED = [...EMOTICONS].sort((a, b) => b[0].length - a[0].length)

/**
 * If the text ending at `caret` finishes with a known face, return the value
 * with it replaced and the caret moved to just after the emoji. Returns `null`
 * when there is nothing to do, so the caller can take the cheap path and leave
 * the caret alone.
 */
export function convertEmoticonAtCaret(
  value: string,
  caret: number,
): { value: string; caret: number } | null {
  if (caret <= 0 || caret > value.length) return null
  const upTo = value.slice(0, caret).toLowerCase()

  for (const [token, emoji] of SORTED) {
    if (!upTo.endsWith(token)) continue
    const start = caret - token.length
    // Start of text, or a space/newline in front. This is the guard that keeps
    // `http://` and `x:(y` intact.
    const before = start > 0 ? value[start - 1] : ''
    if (before !== '' && !/\s/.test(before)) return null
    return {
      value: value.slice(0, start) + emoji + value.slice(caret),
      caret: start + emoji.length,
    }
  }
  return null
}

/**
 * Drop-in `onChange` body for a controlled comment textarea:
 *
 *   onChange={(e) => emoticonOnChange(e.currentTarget, setText)}
 *
 * The element is written synchronously as well as pushed through `push`, and in
 * the main composer that is required rather than tidy. That textarea also
 * carries a native `input` listener whose job is to sync the DOM back into
 * React whenever the two diverge — it exists to catch OS-level insertions — and
 * if it read the element after this had converted the state but before React
 * had re-rendered, it would find `:)` still in the DOM, decide React was out of
 * date, and push the unconverted text straight back. Writing the element too
 * closes that window whatever order the listeners run in.
 *
 * The caret is restored on the next frame because React assigns `value` after
 * this returns, which would otherwise leave the caret at the end of the text.
 */
export function emoticonOnChange(
  el: HTMLTextAreaElement,
  push: (next: string) => void,
): void {
  const raw = el.value
  const caret = el.selectionStart ?? raw.length
  const conv = convertEmoticonAtCaret(raw, caret)
  if (!conv) {
    push(raw)
    return
  }
  el.value = conv.value
  push(conv.value)
  requestAnimationFrame(() => {
    try {
      el.setSelectionRange(conv.caret, conv.caret)
    } catch {
      /* Some browsers throw on programmatic setSelectionRange before the
         element is fully reflowed. Best-effort: the caret lands at the end. */
    }
  })
}
