'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Folder as FolderIcon,
  ChevronRight,
  Lock,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import VideoCard from '@/components/VideoCard'
import { logError } from '@/lib/logging'

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
}

interface SubfolderRow {
  id: string
  slug: string
  name: string
  itemCount: number
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
  shareToken?: string
  isAdmin?: boolean
}

export default function PublicFolderSharePage() {
  const params = useParams()
  const router = useRouter()
  const slug = params?.slug as string

  const [data, setData] = useState<FolderShareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const [needsPassword, setNeedsPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [bearer, setBearer] = useState<string | null>(null)

  const fetchFolder = useCallback(
    async (withToken?: string) => {
      try {
        setLoading(true)
        const res = await fetch(`/api/share/folder/${slug}`, {
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
    [slug],
  )

  useEffect(() => {
    fetchFolder(bearer || undefined)
  }, [fetchFolder, bearer])

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
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold">Can't open this folder</h1>
          <p className="text-sm text-muted-foreground">{fatalError}</p>
        </div>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
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
  const projectShareBase = `/share/${folder.projectSlug}`

  // Group videos by `name` so the public grid renders ONE card per
  // stack — exactly the same way the admin folder grid does (latest
  // version on top, comment counts summed across versions).
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
        commentCount: sorted.reduce((acc, v) => acc + (v.commentCount ?? 0), 0),
        uploaderName,
        createdAt: latest.createdAt,
      })
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name))
  })()

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-screen-xl mx-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6 space-y-5">
        {/* Header: project + folder breadcrumb */}
        <header className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground min-w-0">
          <Link
            href={projectShareBase}
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <span className="truncate max-w-[200px]" title={folder.projectTitle}>
              {folder.projectTitle}
            </span>
          </Link>
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium text-foreground truncate max-w-[260px]" title={folder.name}>
            {folder.name}
          </span>
        </header>

        {/* Title row */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-lg sm:text-xl font-semibold flex items-center gap-2 min-w-0">
            <FolderIcon className="w-5 h-5 text-primary shrink-0" />
            <span className="truncate">{folder.name}</span>
          </h1>
          <span className="text-xs text-muted-foreground tabular-nums">
            {subfolders.length + videos.length === 1
              ? '1 item'
              : `${subfolders.length + videos.length} items`}
          </span>
        </div>

        {/* Subfolders */}
        {subfolders.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Folders</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
              {subfolders.map((f) => (
                <Link
                  key={f.id}
                  href={`/share/folder/${f.slug}`}
                  className="group flex flex-col gap-2 rounded-xl border border-border/50 bg-card p-4 transition-all hover:border-border hover:shadow-md"
                >
                  <div className="rounded-md bg-foreground/5 dark:bg-foreground/10 p-2.5 w-fit">
                    <FolderIcon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate" title={f.name}>
                      {f.name}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
                      {f.itemCount === 1 ? '1 item' : `${f.itemCount} items`}
                    </div>
                  </div>
                </Link>
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
                    router.push(
                      `${projectShareBase}?video=${encodeURIComponent(name)}`,
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
