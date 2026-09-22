/**
 * In-page fullscreen — the player's own fullscreen for Android browsers.
 *
 * 7.13.3: every Chromium browser on Android answers `requestFullscreen()`
 * with its own notice over the bottom of the screen — "framecomment.com – to
 * exit full screen, drag from the top and touch the back button". It is the
 * browser's anti-spoofing UI (Chromium's ExclusiveAccessManager, on by
 * default since spring 2026; before that a plain Android toast that went
 * away by itself), it is drawn by the browser process, and nothing a page
 * does can style, move or dismiss it: there is no CSS, no API and no
 * fullscreen option for it. Since it became a persistent snackbar it sits
 * over the bottom of the video for at least ten seconds, and longer with
 * accessibility timeouts, until the viewer swipes it away — Dragos reported
 * it as "the message at the bottom that never goes away" on 2026-09-22.
 *
 * The only lever a page has is not to ask the browser for fullscreen. So on
 * Android the player fills the viewport by itself: the container becomes
 * `position: fixed; inset: 0` (class `fc-inpage-fullscreen`, rules in
 * globals.css next to the `:fullscreen` ones), `isFullscreen` is set by
 * hand so the floating control bar and auto-hide behave exactly as in
 * browser fullscreen, and a history entry is pushed so the Back gesture —
 * which Chrome itself teaches as the way out of fullscreen — leaves it
 * instead of leaving the page. The price is the browser's own bar: Chrome
 * keeps its address bar and the system bars, which real fullscreen would
 * hide. That is the trade Dragos chose over the notice.
 *
 * iPhone and iPad are NOT routed here: WebKit shows no such notice, and on
 * iPhone the native `<video>` fullscreen is the one that fills the screen.
 * Desktop keeps element fullscreen too — its notice is a small bubble that
 * Escape dismisses, and desktop users expect the real thing.
 */

/** Marker stored in `history.state` for the entry pushed on entering. */
export const IN_PAGE_FULLSCREEN_HISTORY_KEY = 'fcInPageFullscreen'

/**
 * Android only — by user agent, because the decision is about which browser
 * UI appears, not about input capabilities. Chrome's "Desktop site" mode
 * removes the token and gets browser fullscreen with the notice; that is a
 * choice the viewer made and a rare one.
 */
export function prefersInPageFullscreen(userAgent: string | null | undefined): boolean {
  return /\bAndroid\b/i.test(userAgent || '')
}

/** True when `state` is the entry pushed by `enterInPageFullscreen`. */
export function isInPageFullscreenHistoryState(state: unknown): boolean {
  return (
    !!state &&
    typeof state === 'object' &&
    (state as Record<string, unknown>)[IN_PAGE_FULLSCREEN_HISTORY_KEY] === true
  )
}

/**
 * Landscape or not, for the rotate-to-fullscreen behaviour.
 *
 * `screen.orientation.type` is the phone's physical orientation and is
 * preferred whenever the browser exposes it. The `(orientation: landscape)`
 * media query is only a fallback: it compares the layout viewport's width
 * and height, so a browser that shrinks the layout viewport for the
 * on-screen keyboard (Firefox for Android, or any browser under
 * `interactive-widget=resizes-content`) can report "landscape" the moment a
 * comment box is focused on a wide-ish phone — and rotate-to-fullscreen
 * would then fire while someone is typing.
 */
export function resolveLandscape(
  orientationType: string | null | undefined,
  mediaQueryLandscape: boolean
): boolean {
  if (typeof orientationType === 'string' && orientationType.length > 0) {
    return orientationType.startsWith('landscape')
  }
  return mediaQueryLandscape
}
