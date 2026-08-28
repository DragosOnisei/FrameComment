/**
 * 7.3.9 — hand a URL to the browser as a download, without being popup-blocked.
 *
 * THE BUG THIS EXISTS FOR
 *
 * Every video download in this app mints a one-shot signed token and then opens
 * the resulting `/api/content/<token>?download=true` URL. Most callers did that
 * with `window.open(url, '_blank')`, which browsers permit only while the page
 * holds transient user activation — and the token has to be fetched first, so by
 * the time the URL exists the click that asked for it may no longer count. When
 * it does not, `window.open` returns null and does nothing at all: no error, no
 * tab, no download. Which is exactly what a user sees and reports as "the button
 * does nothing".
 *
 * A synthesized anchor is not a popup and is never blocked. FolderBrowser has
 * used one since the bulk download was written — its comment says "to avoid the
 * popup blocker" — so the fix was already in the codebase, in one place, while
 * every other caller kept the version that fails. This is that one place, made
 * shared.
 *
 * It is also better behaviour than the tab it replaces: the file downloads where
 * you are instead of flashing a window open and shut.
 *
 * `download = ''` on purpose rather than a filename: the content endpoint sends
 * a Content-Disposition header, and an empty attribute tells the browser to save
 * the response while letting that header name the file. Passing a name here
 * would override the server and get it wrong for every encoded rendition.
 */
export function triggerDownload(url: string, filename?: string): void {
  if (typeof document === 'undefined') return
  const link = document.createElement('a')
  link.href = url
  link.download = filename ?? ''
  link.rel = 'noopener'
  link.style.display = 'none'
  // Appended to the document because Firefox ignores a click on an anchor that
  // is not in the tree.
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
