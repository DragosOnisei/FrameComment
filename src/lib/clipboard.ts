/**
 * 2.2.6+: clipboard write that survives insecure contexts.
 *
 * `navigator.clipboard.writeText` is only available in secure
 * contexts (HTTPS, or http://localhost). FrameComment is often
 * deployed on a LAN (e.g. TrueNAS) reachable over plain HTTP
 * — in that case the whole `navigator.clipboard` object is
 * `undefined`, and the unguarded `await navigator.clipboard
 * .writeText(...)` call throws "Cannot read properties of
 * undefined (reading 'writeText')". Visible to the user as a
 * red toast next to the kebab menu.
 *
 * This helper:
 *   1. Tries the modern API when it's actually available.
 *   2. Falls back to the legacy `document.execCommand('copy')`
 *      path — works on plain HTTP without a user gesture as
 *      long as the call lives in a click handler, which is the
 *      shape of every place we copy share links + passwords.
 *
 * Returns `true` on success, `false` on failure so callers can
 * toast accordingly. Never throws.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permissions error, Safari Private Mode, etc. — fall through
      // to the legacy execCommand path below.
    }
  }
  // Legacy fallback. document.execCommand('copy') was deprecated
  // years ago but remains the only reliable way to copy text in
  // an insecure context. We mount a hidden, fixed-position
  // textarea so the page doesn't visibly jump while we select.
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
