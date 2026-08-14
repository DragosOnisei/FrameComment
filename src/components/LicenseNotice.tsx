import Link from 'next/link'

/**
 * 6.7.1 — the AGPL §13 source offer.
 *
 * FrameComment is a derivative work of ViTransfer, licensed AGPL-3.0. Section
 * 13 of that licence is the one GPL doesn't have: if people use the software
 * OVER A NETWORK, they must be prominently offered the Corresponding Source —
 * even though no files ever change hands. Running framecomment.com is exactly
 * that case, so this notice has to be reachable from anywhere a person
 * interacts with the app: the public site, the login page, and the client
 * share pages that guests see without ever visiting the marketing site.
 *
 * It also names the licence next to the copyright line. MINDQUB owns its own
 * additions and its branding; it does not own the inherited code, and an
 * unqualified "All rights reserved" on a page rendered by AGPL code says
 * otherwise to every visitor.
 *
 * Keep this component in one piece. If it needs to change, it should change
 * everywhere at once.
 */

const AGPL_URL = 'https://www.gnu.org/licenses/agpl-3.0.html'
const SOURCE_URL = 'https://github.com/DragosOnisei/FrameComment'
const UPSTREAM_URL = 'https://github.com/MansiVisuals/ViTransfer'

export function LicenseNotice({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-white/55 ${className}`}>
      FrameComment is free software licensed under the{' '}
      <a
        href={AGPL_URL}
        target="_blank"
        rel="noopener noreferrer license"
        className="underline underline-offset-2 hover:text-white transition-colors"
      >
        AGPL-3.0
      </a>
      .{' '}
      <a
        href={SOURCE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-white transition-colors"
      >
        Source code
      </a>
      . Based on{' '}
      <a
        href={UPSTREAM_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-white transition-colors"
      >
        ViTransfer
      </a>{' '}
      by Mansi Visuals.
    </p>
  )
}

/**
 * Compact one-liner for cramped surfaces (login card, share page footer).
 * Links to /source rather than repeating three external links.
 */
export function LicenseNoticeCompact({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-muted-foreground ${className}`}>
      Free software under the{' '}
      <a
        href={AGPL_URL}
        target="_blank"
        rel="noopener noreferrer license"
        className="underline underline-offset-2 hover:text-foreground transition-colors"
      >
        AGPL-3.0
      </a>
      .{' '}
      <Link
        href="/source"
        className="underline underline-offset-2 hover:text-foreground transition-colors"
      >
        Get the source
      </Link>
      .
    </p>
  )
}

export const LICENSE_LINKS = { AGPL_URL, SOURCE_URL, UPSTREAM_URL }
