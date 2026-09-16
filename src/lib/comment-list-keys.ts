import type { KeyboardEvent } from 'react'
import {
  continueListOnNewline,
  indentListMarkerOnSpace,
  removeListMarkerOnBackspace,
  type ListEdit,
} from '@/lib/comment-lists'

/**
 * 7.10.0: the three keystrokes that make "1. " behave like a list inside a
 * plain <textarea> — Space indents a marker typed at the start of a line,
 * Shift+Enter continues the list, Backspace straight after the marker
 * removes it again. One function, used by the main composer AND the inline
 * reply box, so the two can never drift apart (the reply box had no list
 * behaviour at all before this).
 *
 * Returns true when the key was consumed. The edit is written to the element
 * as well as pushed to React state, and that is not belt-and-braces — it is
 * required, for the reason the emoticon handler in CommentInput documents:
 * the native `input` sync listener compares the DOM to React state and pushes
 * the DOM back when they differ, so the DOM must never hold the old text.
 * The caret is restored on the next frame because React sets `value` after
 * this returns, which would otherwise drop the caret at the end.
 *
 * Plain-text behaviour on purpose: the stored comment is exactly what the
 * box shows, and `plainTextListsToHtml` turns it into real list markup only
 * when it is displayed.
 */
export function handleListKeydown(
  e: KeyboardEvent<HTMLTextAreaElement>,
  push: (next: string) => void,
): boolean {
  // Ctrl/Cmd/Alt combinations belong to the browser and the player.
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  const el = e.currentTarget
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? el.value.length

  let edit: ListEdit | null = null
  if (e.key === 'Enter' && e.shiftKey) {
    edit = continueListOnNewline(el.value, start, end)
  } else if (e.key === ' ' && !e.shiftKey) {
    edit = indentListMarkerOnSpace(el.value, start, end)
  } else if (e.key === 'Backspace' && !e.shiftKey) {
    edit = removeListMarkerOnBackspace(el.value, start, end)
  }
  if (!edit) return false

  e.preventDefault()
  el.value = edit.value
  push(edit.value)
  const caret = edit.caret
  requestAnimationFrame(() => {
    try {
      el.setSelectionRange(caret, caret)
    } catch {
      /* Some browsers throw on programmatic setSelectionRange before the
         element is fully reflowed. Best-effort: the caret lands at the end. */
    }
  })
  return true
}
