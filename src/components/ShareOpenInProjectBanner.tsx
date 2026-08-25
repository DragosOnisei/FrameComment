'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, FolderOpen } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { detectLoggedInAdmin } from '@/lib/share-auth'
import { getAccessToken } from '@/lib/token-store'

/**
 * 7.1.0: "you are signed in" as an offer, not as a redirect.
 *
 * Both share pages used to do this: detect a valid admin session and
 * immediately `router.replace()` into the admin app, aiming at the folder that
 * holds the shared content. The intent was helpful — the full app lets you walk
 * to sibling folders — but the effect was that clicking a link to ONE video
 * dropped you into a folder listing every video in it. When a folder holds
 * several near-identical cuts (same edit, different subtitle colour) the person
 * who followed the link could no longer tell which one had been shared with
 * them. The link's entire purpose was lost at the moment it succeeded.
 *
 * So the share link now always shows what was shared, to everyone. A signed-in
 * viewer additionally gets this banner, and reaches the folder by choosing to.
 *
 * It checks AUTHORISATION, not just authentication, which the old redirect did
 * not. `detectLoggedInAdmin()` answers "is anyone logged in", so a person signed
 * into a DIFFERENT organisation who opened this link was redirected into a
 * project their session cannot read — landing on an empty or refused page under
 * row-level security. Offering a button that leads somewhere forbidden would be
 * the same bug wearing a nicer hat, and it would also confirm to an outsider
 * that the project exists. The banner therefore appears only after the session
 * has proved it can actually read this project; otherwise the viewer sees the
 * ordinary client page, which is the correct answer for them.
 *
 * Rendering nothing is the default and every failure path — no session, no
 * token, a refused or unreachable project — ends there.
 */
interface ShareOpenInProjectBannerProps {
  /** Project the shared content belongs to. Nothing renders without it. */
  projectId?: string | null
  /**
   * Folder holding the shared content, when known. Decides both the link target
   * and the wording: "open the folder" is only honest if we have one.
   */
  folderId?: string | null
}

export default function ShareOpenInProjectBanner({
  projectId,
  folderId,
}: ShareOpenInProjectBannerProps) {
  const t = useTranslations('share')
  const [href, setHref] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let alive = true
    ;(async () => {
      // Manual fetch throughout, never apiFetch: its refresh interceptor sends
      // a 401 to /login, and a guest reading a public share must never be
      // bounced to a sign-in page. detectLoggedInAdmin() uses the shared,
      // de-duplicated refresh, so a genuine guest returns false immediately and
      // two callers can never race the refresh-token-reuse revocation.
      const signedIn = await detectLoggedInAdmin()
      if (!alive || !signedIn) return

      const token = getAccessToken()
      if (!token) return

      try {
        const res = await fetch(`/api/projects/${projectId}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!alive || !res.ok) return
      } catch {
        return
      }

      setHref(
        folderId
          ? `/admin/projects/${projectId}/folder/${folderId}`
          : `/admin/projects/${projectId}`,
      )
    })()
    return () => {
      alive = false
    }
  }, [projectId, folderId])

  if (!href) return null

  return (
    <div className="shrink-0 px-2 pt-2 sm:px-3">
      <div className="flex items-center gap-3 rounded-lg bg-white/[0.06] ring-1 ring-white/10 px-3 py-2">
        <FolderOpen className="w-4 h-4 shrink-0 text-white/60" aria-hidden />
        <span className="flex-1 min-w-0 text-xs sm:text-sm text-white/70">
          {t('signedInViewingClientPage')}
        </span>
        <Link
          href={href}
          className="
            shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg
            text-xs sm:text-sm font-medium
            bg-primary text-primary-foreground shadow-sm
            hover:bg-primary/90 active:scale-95 transition-colors
          "
        >
          <span>{folderId ? t('openInProjectFolder') : t('openInProject')}</span>
          <ArrowRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
