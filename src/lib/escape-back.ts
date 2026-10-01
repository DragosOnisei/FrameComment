/**
 * 7.17.0: Esc works as Back.
 *
 * Asked for by Dragos on 2026-09-29: Esc should do what the Back pill in the
 * top-left does — player → folder, folder → parent folder or project,
 * project → projects, analytics → project. The catch is that Esc already
 * means "close this" in more than thirty places (dialogs, menus, the
 * notification panel, Quick Look, compare, the drawing tools, range editing,
 * marker mode, renaming, the comment box), and a press that closes a menu
 * must NEVER also leave the page. So Esc goes back only when it closed
 * nothing.
 *
 * "Closed nothing" is decided in two halves, because the handlers that close
 * things do not all say that they did:
 *
 *   1. BEFORE anyone handles the key (a capture listener on window, the very
 *      first code to see the event), look at the page: is focus in a field,
 *      is anything open that Esc closes, is the player fullscreen? Checking
 *      the DOM then — not afterwards — matters: by the time the event has
 *      finished dispatching, the menu Esc just closed may already be gone,
 *      and the page would look "at rest" when it was not.
 *   2. AFTER every handler has run (a task later), was the event marked as
 *      used (`defaultPrevented`)? The modes without a DOM marker (range
 *      editing, drawing, marker mode, compare) mark it; that is how they are
 *      told apart from a page at rest.
 *
 * Only a Back control that opted in (`data-esc-back`) is ever pressed, and it
 * is pressed with a real click, so Esc does exactly what the button does —
 * the same link, the same router, the same state saved on the way out. A
 * page with no such control (Global Settings, Users, the project settings
 * form — where Esc after an edit would throw the unsaved changes away) is
 * untouched.
 */

/** Anything open that Esc closes — roles the app's popups already carry, plus
 *  `data-esc-layer` for the few that have no role. */
export const ESC_LAYER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-modal="true"]',
  '[data-esc-layer]',
].join(',')

export const ESC_BACK_SELECTOR = '[data-esc-back]'

export interface EscSnapshot {
  key: string
  repeat: boolean
  modifiers: boolean
  composing: boolean
  /** Focus (or the event target) is a text field, select or editable region. */
  editableTarget: boolean
  /** Something Esc closes is open right now. */
  layerOpen: boolean
  /** Browser fullscreen, or the player's own in-page fullscreen (Android). */
  fullscreen: boolean
}

/** Decided before any handler ran: may this press become Back at all? */
export function escMayGoBack(s: EscSnapshot): boolean {
  if (s.key !== 'Escape') return false
  if (s.repeat || s.modifiers || s.composing) return false
  if (s.editableTarget || s.layerOpen || s.fullscreen) return false
  return true
}

/** Decided after every handler ran: did one of them use the key? */
export function escStillUnused(defaultPrevented: boolean): boolean {
  return !defaultPrevented
}

/** True for inputs that take text (a checkbox or a button is not "typing"). */
export function isTextEditable(el: Element | null | undefined): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type)
  }
  return (el as HTMLElement).isContentEditable === true
}

/**
 * The Back control to press: the first opted-in one that is actually on
 * screen. A page can render its pill in the top bar AND keep an older copy in
 * a hidden branch; pressing a hidden one would do nothing visible.
 */
export function pickBackControl(candidates: HTMLElement[]): HTMLElement | null {
  for (const el of candidates) {
    if ((el as HTMLButtonElement).disabled) continue
    if (el.getClientRects().length === 0) continue
    return el
  }
  return null
}
