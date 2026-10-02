/**
 * 7.17.6: what a click OUTSIDE an open edit box does to it.
 *
 * Dragos, 2026-10-02: "if I open Edit on a comment and change nothing, a
 * click outside should leave edit mode as if I pressed Cancel; if I did
 * change something, a click outside should do nothing — as today." The
 * second half protects a half-written edit from a stray click; the first
 * half removes the Cancel press from the case where there is nothing to
 * cancel.
 *
 * Clicks that are NOT "outside" in the user's sense, and must never close
 * the edit:
 *   - inside the edit box itself (textarea, Save, Cancel);
 *   - in a layer that opened over the page (menu, dialog, listbox, the
 *     emoji picker — the same `data-esc-layer` family Esc respects);
 *   - in the comment composer at the bottom, which while an edit is open is
 *     the place to attach a file or start a drawing FOR that edit
 *     ("Attaching to the comment you are editing — press Save there");
 *   - anywhere while drawing mode is on: the click is a stroke on the video.
 *
 * Pure, so a node script checks it; MessageBubble supplies the facts.
 */
export const EDIT_OUTSIDE_IGNORE_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"],[data-esc-layer],[data-comment-dropzone]'

export interface OutsideClickFacts {
  /** The pointer landed inside the edit box (textarea or its buttons). */
  insideEditor: boolean
  /** The pointer landed in a popup layer or in the comment composer. */
  insideIgnoredLayer: boolean
  /** Annotation drawing mode is active (the click draws on the video). */
  drawing: boolean
  /** The text in the box equals the text the edit started from. */
  unchanged: boolean
}

/** True when the edit should close (as Cancel would) because of the click. */
export function shouldExitEditOnOutsideClick(f: OutsideClickFacts): boolean {
  if (f.insideEditor || f.insideIgnoredLayer || f.drawing) return false
  return f.unchanged
}
