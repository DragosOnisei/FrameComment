'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  Folder as FolderIcon,
  ChevronRight,
  ChevronLeft,
  Lock,
  Loader2,
  Download,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import VideoCard from '@/components/VideoCard'
import FolderCard from '@/components/FolderCard'
import { logError } from '@/lib/logging'
import { detectLoggedInAdmin } from '@/lib/share-auth'
import { useDownloadManager } from '@/contexts/DownloadManager'

/**
 * Public folder share page (1.0.6+).
 *
 * Mirrors the project share page in spirit but stays intentionally
 * simple for the first cut:
 *
 *  - NONE-mode folders open instantly.
 *  - PASSWORD-mode folders show a password challenge until the user
 *    provides the right secret; we then POST it to /verify and stash
 *    the returned share token in memory for subsequent navigation.
 *  - The contents grid renders subfolders + videos side by side.
 *  - Clicking a subfolder navigates to /share/folder/{childSlug}.
 *  - Clicking a video opens the existing project-share player in
 *    the same tab — that page already handles all the review UX
 *    (timeline, comments, etc.). The user might need to clear a
 *    second auth challenge if the *project* itself is password-
 *    protected at a different level.
 */
export const dynamic = 'force-dynamic'

type AuthMode = 'NONE' | 'PASSWORD' | 'OTP' | 'BOTH'

interface FolderInfo {
  id: string
  slug: string
  name: string
  projectId: string
  parentFolderId: string | null
  projectTitle: string
  projectSlug: string
  companyName: string | null
  authMode: AuthMode
  /** 1.4.x+: drives the "Download All" button on the public share. */
  allowAssetDownload?: boolean
  /** 1.4.x+: ISO datetime when the share link stops working. `null`
   *  (or absent) = no expiration. Renders the countdown banner. */
  shareExpiresAt?: string | null
}

interface SubfolderRow {
  id: string
  slug: string
  name: string
  itemCount: number
  /** Frame.io-style mosaic tiles served by the share API (1.0.7+) —
   *  the same shape FolderCard expects on the admin side. */
  previewItems?: Array<
    | {
        kind: 'video'
        videoId: string
        thumbnailUrl: string
        storyboardUrl?: string
      }
    | { kind: 'folder'; folderId: string }
  >
}

interface VideoRow {
  id: string
  name: string
  version: number
  versionLabel: string
  duration: number
  approved: boolean
  status?: string
  thumbnailPath: string | null
  /** Signed `/api/content/{token}` URL minted server-side. Lets the
   *  client render a real first-frame preview instead of the Film
   *  icon fallback (1.0.6+). */
  thumbnailUrl?: string | null
  previewUrl?: string | null
  storyboardUrl?: string | null
  createdAt?: string
  commentCount?: number
  createdBy?: {
    id: string
    name: string | null
    username: string | null
    email: string
  } | null
}

interface FolderShareResponse {
  folder: FolderInfo
  subfolders: SubfolderRow[]
  videos: VideoRow[]
  /** 1.4.x+: in-scope breadcrumb (root → current). Server builds this
   *  by walking parentFolderId from the current folder up to the
   *  share root (the slug passed via `?root=`). When the page loads
   *  at the share root directly, this is just `[{ current }]`. */
  ancestry?: Array<{ slug: string; name: string }>
  shareToken?: string
  isAdmin?: boolean
}

// 3.2.6+: the DownloadManagerProvider + <DownloadBanners /> used to be
// wrapped HERE, inside the folder page. That meant opening a video
// (which routes to `/share/[token]?video=…`) unmounted the provider —
// the folder ZIP kept downloading in the background but its progress
// banner vanished and never reappeared on "Back". The provider + banner
// now live in the shared `/share` layout (`app/share/layout.tsx`),
// which Next.js preserves across navigation between the folder grid and
// the player, so the banner persists. This page just consumes the
// provider via context (`useDownloadManager` in handleDownloadAll).
export default function PublicFolderSharePage() {
  return <PublicFolderSharePageInner />
}

function PublicFolderSharePageInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const slug = params?.slug as string
  // 1.4.x+: the share-root slug travels in the URL via `?root=...`.
  // It identifies WHERE the user first entered the share, so the
  // breadcrumb + Back button can stay within the share's subtree
  // and never link out to the project root. On the very first load
  // (no `?root=` query) the current folder IS the share root.
  const rootSlug = searchParams?.get('root') || slug

  const [data, setData] = useState<FolderShareResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // 3.8.x: seamless routing — a logged-in admin opening a folder share
  // link is sent into the FULL admin folder view (Back reveals sibling
  // folders) instead of the limited client share. Guests (no token)
  // stay on the share. Manual fetch (not apiFetch) so a 401 can't bounce
  // a guest to /login.
  const [isLoggedInAdmin, setIsLoggedInAdmin] = useState(false)
  useEffect(() => {
    let alive = true
    ;(async () => {
      // Refresh-then-session check: the access token is memory-only and
      // gone on a fresh load, so we mint one from the persisted refresh
      // token before asking /api/auth/session (see share-auth.ts).
      const ok = await detectLoggedInAdmin()
      if (alive && ok) setIsLoggedInAdmin(true)
    })()
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!isLoggedInAdmin || !data?.folder) return
    router.replace(
      `/admin/projects/${data.folder.projectId}/folder/${data.folder.id}`,
    )
  }, [isLoggedInAdmin, data?.folder, router])
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const [needsPassword, setNeedsPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [expiredAt, setExpiredAt] = useState<string | null>(null)
  const [bearer, setBearer] = useState<string | null>(null)

  const fetchFolder = useCallback(
    async (withToken?: string) => {
      try {
        setLoading(true)
        const qs = rootSlug && rootSlug !== slug
          ? `?root=${encodeURIComponent(rootSlug)}`
          : ''
        const res = await fetch(`/api/share/folder/${slug}${qs}`, {
          headers: withToken
            ? { Authorization: `Bearer ${withToken}` }
            : undefined,
          cache: 'no-store',
        })
        if (res.status === 401) {
          // Auth required — peek at the body for authMode + folder
          // name so the challenge can read like "Enter password for
          // Folder X".
          const body = await res.json().catch(() => ({}))
          setAuthMode(body.authMode || 'PASSWORD')
          if (body.authMode === 'OTP' || body.authMode === 'BOTH') {
            setFatalError(
              'This folder is configured for OTP/Both auth, which is not yet supported in folder shares. Ask the project owner to switch the folder to PASSWORD or NONE.',
            )
          } else {
            setNeedsPassword(true)
          }
          // Try to surface the folder name in the challenge.
          if (body.folder) {
            setData((prev) =>
              prev
                ? prev
                : ({
                    folder: {
                      ...body.folder,
                      slug,
                      authMode: body.authMode || 'PASSWORD',
                    } as any,
                    subfolders: [],
                    videos: [],
                  } as FolderShareResponse),
            )
          }
          return
        }
        if (res.status === 404) {
          setFatalError('Folder not found.')
          return
        }
        if (res.status === 410) {
          // 1.4.x+: link has expired. Surface a clean notice with the
          // expiry date if the API supplied it.
          const body = await res.json().catch(() => ({}))
          setExpiredAt(body?.expiredAt || null)
          setFatalError(body?.error || 'This share link has expired.')
          return
        }
        if (!res.ok) {
          throw new Error(`Failed to load folder (HTTP ${res.status})`)
        }
        const body = (await res.json()) as FolderShareResponse
        setData(body)
        setAuthMode(body.folder.authMode)
        setNeedsPassword(false)
        if (body.shareToken) setBearer(body.shareToken)
      } catch (err) {
        logError('[PublicFolderSharePage] fetch failed:', err)
        setFatalError(
          err instanceof Error ? err.message : 'Failed to load folder',
        )
      } finally {
        setLoading(false)
      }
    },
    [slug, rootSlug],
  )

  useEffect(() => {
    fetchFolder(bearer || undefined)
  }, [fetchFolder, bearer])

  // 1.4.x+: "Download All" hits the new share-folder ZIP endpoint.
  // The share token (in `bearer` state) is required for PASSWORD
  // folders; NONE folders work even without one. We can't use an
  // anchor tag because the share token has to ride in the
  // `Authorization` header — anchor downloads only carry cookies.
  // Instead we fetch the response, convert to a Blob, and trigger
  // a normal browser download on the resulting object URL.
  // 2.0.x+: route through the DownloadManager so the user gets the
  // bottom-right progress banner + Cancel button instead of a button
  // that just sits there in a loading state for the whole download.
  // The local `downloadingAll` flag is kept for the button disabled
  // state — the manager tracks the underlying job + cancellation.
  const [downloadingAll, setDownloadingAll] = useState(false)
  const { startStreamDownload } = useDownloadManager()
  const handleDownloadAll = useCallback(() => {
    if (downloadingAll) return
    setDownloadingAll(true)
    startStreamDownload({
      label: `${data?.folder?.name || 'Folder'}.zip`,
      url: `/api/share/folder/${slug}/download`,
      statUrl: `/api/share/folder/${slug}/download/stat`,
      fetcher: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...(init?.headers || {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
        }),
      fallbackFilename: `${data?.folder?.name || 'folder'}.zip`,
    })
    // Release the button-disabled state after a brief beat — the
    // manager already prevents the UI from queuing a duplicate
    // banner because each click creates a fresh job id; we just
    // want the button to feel responsive again so the user can
    // retry if they cancelled the previous one.
    setTimeout(() => setDownloadingAll(false), 800)
  }, [slug, bearer, data, downloadingAll, startStreamDownload])

  const handleSubmitPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || submitting) return
    try {
      setSubmitting(true)
      setPwError(null)
      const res = await fetch(`/api/share/folder/${slug}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.shareToken) {
        throw new Error(body.error || 'Access denied')
      }
      setBearer(body.shareToken)
      setNeedsPassword(false)
      // Re-fetch with the token now in hand.
      await fetchFolder(body.shareToken)
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Access denied')
    } finally {
      setSubmitting(false)
    }
  }

  if (fatalError) {
    // 1.4.x+: dedicated expired-link state when the API returned 410.
    // We render the date the link expired in the viewer's local TZ so
    // they have something concrete to send back to the studio.
    if (expiredAt) {
      const when = new Date(expiredAt)
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-3">
            <div className="mx-auto rounded-full bg-amber-500/10 p-3 w-fit">
              <Clock className="w-6 h-6 text-amber-500" />
            </div>
            <h1 className="text-xl font-semibold">This share link has expired</h1>
            <p className="text-sm text-muted-foreground">
              The link stopped working on{' '}
              <span className="text-foreground font-medium">
                {when.toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              . Ask the project owner for a fresh link.
            </p>
          </div>
        </div>
      )
    }
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold">Can't open this folder</h1>
          <p className="text-sm text-muted-foreground">{fatalError}</p>
        </div>
      </div>
    )
  }

  // 3.2.3+ Folder share initial loading: glass card on spotlight bg
  // instead of bare loader on flat `bg-background`. Same recipe as
  // the public/admin share initial-load cards so the client never
  // sees the legacy #121212 surface before the folder grid renders.
  if (loading && !data) {
    return (
      <div className="spotlight-bg-tr min-h-screen flex items-center justify-center p-4">
        <div
          className="rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white px-8 py-7 flex items-center gap-4"
          style={{
            backgroundColor: 'rgba(22, 37, 51, 0.62)',
            backgroundImage:
              'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            transform: 'translate3d(0, 0, 0)',
            willChange: 'backdrop-filter, transform',
            isolation: 'isolate',
          }}
        >
          <div className="h-5 w-5 rounded-full border-2 border-white/20 border-t-white/85 animate-spin" />
          <p className="text-sm font-medium text-white/85">Loading folder…</p>
        </div>
      </div>
    )
  }

  if (needsPassword) {
    const folderName = data?.folder?.name || 'folder'
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <form
          onSubmit={handleSubmitPassword}
          className="w-full max-w-sm rounded-xl bg-card border border-border shadow-2xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2 text-foreground">
            <div className="rounded-md bg-primary/10 p-2">
              <Lock className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold truncate">{folderName}</h1>
              <p className="text-xs text-muted-foreground">Enter the password to view this folder.</p>
            </div>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={submitting}
            placeholder="Folder password"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          {pwError && (
            <p className="text-xs text-destructive">{pwError}</p>
          )}
          <Button type="submit" disabled={submitting || !password.trim()} className="w-full">
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Verifying…
              </>
            ) : (
              'View folder'
            )}
          </Button>
        </form>
      </div>
    )
  }

  if (!data) {
    // Should be unreachable now (loading + fatalError above cover it),
    // but render a minimal fallback just in case.
    return null
  }

  const { folder, subfolders, videos } = data
  // 1.4.x+: in-scope breadcrumb returned by the server (root → current).
  // Falls back to a single entry when the API doesn't ship it yet so
  // older deploys keep rendering a sane header.
  const ancestry = data.ancestry?.length
    ? data.ancestry
    : [{ slug: folder.slug, name: folder.name }]
  const projectShareBase = `/share/${folder.projectSlug}`

  // Group videos by `name` so the public grid renders ONE card per
  // stack — exactly the same way the admin folder grid does (latest
  // version on top; the comment badge reflects the LATEST version's
  // comments, not the sum across versions).
  const videoGroups = (() => {
    const byName = new Map<string, VideoRow[]>()
    for (const v of videos) {
      const list = byName.get(v.name)
      if (list) list.push(v)
      else byName.set(v.name, [v])
    }
    const groups: Array<{
      id: string
      name: string
      versionLabel: string
      duration?: number
      versionCount: number
      approved: boolean
      thumbnailUrl?: string | null
      previewUrl?: string | null
      storyboardUrl?: string | null
      status?: string
      commentCount: number
      uploaderName: string | null
      createdAt?: string
    }> = []
    for (const [name, rows] of byName) {
      const sorted = [...rows].sort((a, b) => b.version - a.version)
      const latest = sorted[0]
      const uploaderName =
        latest.createdBy?.name ||
        latest.createdBy?.username ||
        latest.createdBy?.email ||
        null
      groups.push({
        id: latest.id,
        name,
        versionLabel: latest.versionLabel || `v${latest.version}`,
        duration: typeof latest.duration === 'number' ? latest.duration : undefined,
        versionCount: sorted.length,
        approved: sorted.some((v) => v.approved),
        thumbnailUrl: latest.thumbnailUrl ?? null,
        previewUrl: latest.previewUrl ?? null,
        storyboardUrl: latest.storyboardUrl ?? null,
        status: latest.status,
        // Latest version's own comments (per-version count from the
        // server), so a fresh v2 with no comments reads 0 — not the
        // stack total. Matches the admin grid.
        commentCount: latest.commentCount ?? 0,
        uploaderName,
        createdAt: latest.createdAt,
      })
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name))
  })()

  return (
    // 3.2.3+ Folder share styling: replace the flat `bg-background`
    // (#121212) wrapper with the v2.5 spotlight gradient (`spotlight-
    // bg-tr`) so the public folder share matches the admin look —
    // soft radial spotlight + cooler tint instead of the legacy
    // pure-dark surface. The wrapper inside keeps its max-width
    // constraint so cards still align with the rest of the page.
    <div className="spotlight-bg-tr min-h-screen">
      <div className="max-w-screen-xl mx-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6 space-y-5">
        {/* Header: in-scope breadcrumb + optional Back button.
            1.4.x+: the project title used to be rendered above as a
            hyperlink to /share/<projectSlug>, which let anyone with a
            folder share link pivot to the project root and see all
            the studio's other work. The breadcrumb is now built from
            the server-provided `ancestry` array (root → current) and
            never leaves the share's subtree. The first entry is the
            share root the user originally received; clicking it takes
            them back to that root. */}
        <header className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground min-w-0">
          {ancestry.length > 1 && (
            <button
              type="button"
              onClick={() => {
                // Go up one folder within the share scope. The parent
                // is `ancestry[ancestry.length - 2]`; its href keeps
                // the same `?root=` query so the breadcrumb stays
                // consistent for the parent page too.
                const parent = ancestry[ancestry.length - 2]
                const qs = rootSlug && rootSlug !== parent.slug
                  ? `?root=${encodeURIComponent(rootSlug)}`
                  : ''
                router.push(`/share/folder/${parent.slug}${qs}`)
              }}
              className="inline-flex items-center hover:text-foreground transition-colors shrink-0 p-1 -ml-1 rounded-md hover:bg-muted/50"
              aria-label="Back to parent folder"
              title="Back to parent folder"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          {ancestry.map((crumb, idx) => {
            const isLast = idx === ancestry.length - 1
            const qs = rootSlug && rootSlug !== crumb.slug
              ? `?root=${encodeURIComponent(rootSlug)}`
              : ''
            return (
              <span
                key={`${crumb.slug}-${idx}`}
                className="inline-flex items-center gap-2 min-w-0"
              >
                {idx > 0 && <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                {isLast ? (
                  <span
                    className="font-medium text-foreground truncate max-w-[260px]"
                    title={crumb.name}
                  >
                    {crumb.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      router.push(`/share/folder/${crumb.slug}${qs}`)
                    }
                    className="truncate max-w-[200px] hover:text-foreground transition-colors"
                    title={crumb.name}
                  >
                    {crumb.name}
                  </button>
                )}
              </span>
            )
          })}
        </header>

        {/* 1.4.x+: countdown banner. We render it whenever the folder
            ships a future `shareExpiresAt`, so the recipient knows
            ahead of time when the link will go dark. Past dates would
            have triggered the 410 above. */}
        {folder.shareExpiresAt && (() => {
          const expiry = new Date(folder.shareExpiresAt)
          const now = Date.now()
          const ms = expiry.getTime() - now
          if (ms <= 0) return null
          const days = Math.floor(ms / (24 * 60 * 60 * 1000))
          const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
          const label =
            days >= 1
              ? `Expires in ${days} ${days === 1 ? 'day' : 'days'}`
              : hours >= 1
                ? `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
                : 'Expires soon'
          // Highlight the banner in amber once we're within 24h so the
          // viewer knows time's running out; otherwise keep it muted.
          const accent =
            ms <= 24 * 60 * 60 * 1000
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'border-border bg-muted/40 text-muted-foreground'
          return (
            <div
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${accent}`}
              role="status"
              aria-live="polite"
            >
              <Clock className="w-3.5 h-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {label}{' '}
                <span className="text-foreground/80 font-medium">
                  ({expiry.toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })})
                </span>
              </span>
            </div>
          )
        })()}

        {/* Title row */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-lg sm:text-xl font-semibold flex items-center gap-2 min-w-0">
            <FolderIcon className="w-5 h-5 text-primary shrink-0" />
            <span className="truncate">{folder.name}</span>
          </h1>
          <div className="flex items-center gap-2 flex-wrap">
            {/* 1.4.x+: Download All — streams a ZIP of the whole folder
                tree (subfolders + latest-version videos) with original
                filenames preserved. 3.5.x: also shown when the current
                level holds only SUBFOLDERS (no loose videos) — the ZIP
                endpoint walks the tree recursively, so "Download All"
                at a folders-only level still grabs every nested video.
                Previously it required a loose video at this exact level,
                so a parent like "SCRIPT 3" (subfolders only) had no
                button even though there was plenty to download. */}
            {folder.allowAssetDownload &&
              (videoGroups.length > 0 || subfolders.length > 0) && (
              <Button
                size="sm"
                onClick={handleDownloadAll}
                disabled={downloadingAll}
                className="gap-1.5"
              >
                {downloadingAll ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span>Download All</span>
              </Button>
            )}
            {/* 1.4.x+: item count next to Download All counts UNIQUE
                video cards (grouped by name) instead of raw version
                rows from the DB. Otherwise a folder with 2 clips at
                v2 would render "4 items" while only 2 cards show on
                screen — and the actual ZIP only contains 2 files
                (we download the latest version per name on the
                server). Using `videoGroups.length` keeps the badge
                in sync with both the visible grid and the download. */}
            <span className="text-xs text-muted-foreground tabular-nums">
              {subfolders.length + videoGroups.length === 1
                ? '1 item'
                : `${subfolders.length + videoGroups.length} items`}
            </span>
          </div>
        </div>

        {/* Subfolders — public share now uses the SAME FolderCard
            component as the admin grid (1.0.7+), so the client sees
            the Frame.io-style mosaic cover, item count, and big
            folder glyph instead of the legacy small card. Rename /
            share / delete / drag handlers are intentionally omitted
            so the kebab disappears and the card stays read-only. */}
        {subfolders.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Folders</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
              {subfolders.map((f) => (
                <FolderCard
                  key={f.id}
                  id={f.id}
                  name={f.name}
                  itemCount={f.itemCount}
                  slug={f.slug}
                  previewItems={f.previewItems}
                  onOpen={() => {
                    // 1.4.x+: carry the share-root slug forward so the
                    // child page can compute its own in-scope
                    // breadcrumb back to the original share root.
                    const qs = rootSlug && rootSlug !== f.slug
                      ? `?root=${encodeURIComponent(rootSlug)}`
                      : ''
                    router.push(`/share/folder/${f.slug}${qs}`)
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* Videos — share grid uses the SAME VideoCard component as
            the admin grid so the client view stays visually in sync
            with internal review. Rename/Delete props are intentionally
            omitted so the kebab disappears and the card is read-only. */}
        {videoGroups.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Videos</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
              {videoGroups.map((v) => (
                <VideoCard
                  key={`video:${v.id}`}
                  id={v.id}
                  name={v.name}
                  versionLabel={v.versionLabel}
                  duration={v.duration}
                  versionCount={v.versionCount}
                  thumbnailUrl={v.thumbnailUrl}
                  previewUrl={v.previewUrl}
                  storyboardUrl={v.storyboardUrl}
                  status={v.status}
                  approved={v.approved}
                  commentCount={v.commentCount}
                  uploaderName={v.uploaderName}
                  createdAt={v.createdAt}
                  onOpen={(name) =>
                    // Pass the folder context so the player can scope
                    // its title-flyout + version dropdown to this
                    // folder, and so "All Videos" becomes a real
                    // "Back to folder" link (1.0.6+).
                    router.push(
                      `${projectShareBase}?video=${encodeURIComponent(name)}` +
                        `&folderId=${encodeURIComponent(folder.id)}` +
                        `&folderSlug=${encodeURIComponent(folder.slug)}`,
                    )
                  }
                />
              ))}
            </div>
          </section>
        )}

        {subfolders.length === 0 && videoGroups.length === 0 && (
          <div className="rounded-md border border-border/50 bg-card/50 p-8 text-center text-sm text-muted-foreground">
            This folder is empty.
          </div>
        )}

        <footer className="pt-6 text-[11px] text-muted-foreground text-center">
          Powered by FrameComment
        </footer>
      </div>
    </div>
  )
}
