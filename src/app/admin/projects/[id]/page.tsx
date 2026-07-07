'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import FolderBrowser, {
  type FolderBrowserHandle,
} from '@/components/FolderBrowser'
import AdminVideoManager, { type AdminVideoManagerHandle } from '@/components/AdminVideoManager'
import ProjectUploadsBlock from '@/components/ProjectUploadsBlock'
import { TopbarLeftSlot, TopbarRightSlot } from '@/components/TopbarSlots'
import { ArrowLeft, FolderUp, Upload, Download } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { useTranslations } from 'next-intl'
import { logError } from '@/lib/logging'
import { useAdminViewMode } from '@/lib/use-admin-view-mode'
import ViewModeToggle from '@/components/ViewModeToggle'
import {
  createFolderHierarchy,
  uniqueDirectoryPaths,
  type FileTreeEntry,
} from '@/lib/folder-upload'

// Force dynamic rendering (no static pre-rendering)
export const dynamic = 'force-dynamic'

export default function ProjectPage() {
  const t = useTranslations('projects')
  const tc = useTranslations('common')
  const params = useParams()
  const router = useRouter()
  const id = params?.id as string

  const [project, setProject] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [shareUrl, setShareUrl] = useState('')
  const videoManagerRef = useRef<AdminVideoManagerHandle | null>(null)
  // 1.7.0+: grid/table preference comes from the shared admin
  // view-mode store; the actual toggle UI lives in AdminHeader.
  // The hook keeps every consumer (dashboard, project page, folder
  // page) in lockstep via a window custom event.
  const [folderView, setFolderView] = useAdminViewMode()
  // FolderBrowser imperative handle (1.0.9+) — lets the top action
  // bar drive the New-Folder dialog so the button can sit alongside
  // Project settings instead of inline next to the breadcrumb.
  const folderBrowserRef = useRef<FolderBrowserHandle | null>(null)

  // 1.7.0+: monotonically-increasing fetch "generation" tag.
  // Every fetch increments it; only the LATEST fetch is allowed
  // to commit its result to state. When the user clicks rapidly
  // between folders the project page can fire 2-3 fetches back
  // to back; without this guard an older fetch that resolves
  // last would clobber the newer one's result (or worse, flip
  // loading=false with project=null, which renders the "Project
  // not found" screen).
  const fetchSeqRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Fetch project data function (extracted so it can be called on upload complete)
  // 2.2.0+: distinguishes a TERMINAL failure (the project genuinely
  // doesn't exist — 404 → bounce to dashboard) from a TRANSIENT one
  // (network error, rate-limit exhausted after apiFetch's own
  // retries, 5xx). The pre-2.2.0 code lumped both into "no project"
  // and rendered "Project not found" the instant `setLoading(false)`
  // ran. The fix has two parts:
  //
  //  - `apiFetch` already transparently retries 429s up to 3 times
  //    with Retry-After backoff (~15s total worst-case), so by the
  //    time we get to this catch the rate-limit window has had
  //    plenty of opportunity to bleed. We deliberately do NOT add
  //    a second layer of retry at the page level — that would
  //    quadruple the per-navigation hit count on the limit and
  //    actively make the problem worse under sustained load.
  //
  //  - On a transient failure we keep `loading=true` so the
  //    spinner stays visible instead of flashing the "Project not
  //    found" card. The user can navigate away (the alive/seq
  //    guards swallow the stale state) or refresh the tab to
  //    recover — both well-behaved patterns. A real 404 still
  //    redirects to the projects list cleanly.
  const fetchProject = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    let transientFailure = false
    try {
      const response = await apiFetch(`/api/projects/${id}`)
      // A newer fetch (or a route change that unmounted us) has
      // already started — drop this result on the floor.
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/projects')
          return
        }
        transientFailure = true
        throw new Error(`Failed to fetch project (HTTP ${response.status})`)
      }
      const data = await response.json()
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      setProject(data)
      // 3.5.x: the project-root FolderBrowser fetches its OWN root-level
      // videos (unlike the folder view, the page doesn't feed them in as
      // a `videos` prop). So refreshing `project` alone never updated the
      // root grid — a video uploaded at the root only appeared after a
      // manual page refresh. Nudge the FolderBrowser to re-fetch its root
      // videos on every project refresh (upload-complete + processing
      // poll), mirroring how the folder view's prop refreshes live.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('framecomment:folders-changed'))
      }
    } catch (error) {
      // Swallow stale errors so a rapid back/forward doesn't
      // surface a misleading card over a page the user has already
      // moved past.
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      logError('Error fetching project:', error)
      // Network errors / aborts also count as transient — they're
      // not "this project doesn't exist", they're "the request
      // didn't make it". Same treatment as a 5xx / exhausted 429.
      transientFailure = true
    } finally {
      // Only flip loading=false on a CLEAN result (either we have
      // data, or a definitive 404 bounce). Transient failures keep
      // the spinner up — the user can navigate away or refresh to
      // recover without ever seeing a misleading "Project not
      // found" card.
      if (seq === fetchSeqRef.current && aliveRef.current && !transientFailure) {
        setLoading(false)
      }
    }
  }, [id, router])

  // Fetch project data on mount
  useEffect(() => {
    fetchProject()
  }, [fetchProject])

  // Handle a whole-folder drop at the project root (1.0.7+). The
  // FolderBrowser walker has already filtered out non-video files and
  // populated each entry's `relativePath`. We mint the matching folders
  // at the project root, then hand the upload modal a list of
  // `(file, folderId)` pairs so each video lands in the right place.
  const handleUploadFolderTree = useCallback(
    async (
      entries: FileTreeEntry[],
      extras?: { directoryPaths?: string[] },
      // 3.9.x: when the user drops a folder onto a specific folder TILE,
      // the recreated hierarchy nests under that folder instead of the
      // project root. null = project root (the default drop-anywhere
      // behaviour).
      baseFolderId: string | null = null,
    ) => {
      // 1.7.1+: also accept extras.directoryPaths so empty drop
      // folders still mint a matching FrameComment folder. Bail
      // only when BOTH the file list and the directory list are
      // empty.
      if (
        (entries.length === 0 && (extras?.directoryPaths?.length ?? 0) === 0) ||
        !project?.id
      ) {
        return
      }
      try {
        const paths = uniqueDirectoryPaths(entries, extras?.directoryPaths)
        const pathToFolderId = await createFolderHierarchy(
          project.id,
          baseFolderId,
          paths,
        )
        const seeded = entries
          .map((entry) => {
            const dir = entry.relativePath.replace(/\/[^/]*$/, '')
            const isTopLevel = !dir || dir === entry.relativePath
            // Top-level (loose) files: at the project root there's
            // nowhere to host them so we drop them (edge case: a video
            // dropped alongside a folder). When dropped onto a folder
            // tile (baseFolderId set) they land directly in that folder.
            const targetFolderId = isTopLevel
              ? baseFolderId
              : pathToFolderId.get(dir) || baseFolderId
            if (!targetFolderId) return null
            return { file: entry.file, folderId: targetFolderId }
          })
          .filter(
            (e): e is { file: File; folderId: string } => e !== null,
          )
        if (seeded.length === 0) {
          // We minted folders but had nothing to upload — refresh so
          // the new empty folders show up in the grid anyway.
          fetchProject()
          return
        }
        videoManagerRef.current?.triggerUploadWithFolderTree(seeded)
        fetchProject()
      } catch (err) {
        logError('[ProjectPage] folder-tree upload failed:', err)
        alert(
          err instanceof Error
            ? `Failed to create folders: ${err.message}`
            : 'Failed to upload folder',
        )
      }
    },
    [project?.id, fetchProject],
  )

  // Listen for immediate updates (approval changes, comment deletes/posts, etc.)
  useEffect(() => {
    const handleUpdate = () => fetchProject()

    const handleCommentPosted = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail?.comments) {
        setProject((prev: any) => prev ? { ...prev, comments: customEvent.detail.comments } : prev)
      } else {
        fetchProject()
      }
    }

    window.addEventListener('videoApprovalChanged', handleUpdate)
    window.addEventListener('commentDeleted', handleUpdate)
    window.addEventListener('commentPosted', handleCommentPosted as EventListener)

    return () => {
      window.removeEventListener('videoApprovalChanged', handleUpdate)
      window.removeEventListener('commentDeleted', handleUpdate)
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
    }
  }, [fetchProject])

  // Auto-refresh when videos are processing to show real-time progress
  // Centralized polling to prevent duplicate network requests
  useEffect(() => {
    if (!project?.videos) return

    // Check if any videos are currently processing.
    // 3.5.x: also keep polling AFTER status flips to READY (which
    // happens at the first/SD tier) while the HD tiers are still being
    // produced — the hover-scrub storyboard sprite lands during that
    // window, so polling through the ladder lets the card pick it up
    // live instead of needing a manual refresh. Legacy rows have
    // plannedTiers === null and behave exactly as before.
    const hasProcessingVideos = project.videos.some((video: any) => {
      if (video.status === 'PROCESSING' || video.status === 'UPLOADING') return true
      const planned = Array.isArray(video.plannedTiers) ? video.plannedTiers : []
      const completed = Array.isArray(video.completedTiers) ? video.completedTiers : []
      return planned.length > 0 && completed.length < planned.length
    })

    if (hasProcessingVideos) {
      // Poll every 5 seconds while videos are processing (reduced from 3s to reduce load)
      const interval = setInterval(() => {
        fetchProject()
      }, 5000)

      return () => clearInterval(interval)
    }
  }, [project?.videos, fetchProject])

  // Fetch share URL
  useEffect(() => {
    async function fetchShareUrl() {
      if (!project?.slug) return
      try {
        const response = await apiFetch(`/api/share/url?slug=${project.slug}`)
        if (response.ok) {
          const data = await response.json()
          setShareUrl(data.shareUrl)
        }
      } catch (error) {
        logError('Error fetching share URL:', error)
      }
    }

    fetchShareUrl()
  }, [project?.slug])


  // 2.5.0+: render nothing while the first fetch is in flight instead
  // of flashing a centred "Loading…" placeholder — the sidebar +
  // topbar stay mounted from the layout, so users perceive an
  // instant navigation. The fetch resolves quickly enough that an
  // empty pane reads as "page rendering", not "page broken".
  // 3.5.x: the topbar action slots (Back, view toggle, Upload, Download
  // All) are rendered in EVERY state — loading, not-found and the normal
  // view — so they stay put when navigating into/out of a folder instead
  // of blinking out while the page refetches. The search pill + bell
  // already behave this way (they live in the persistent layout); this
  // matches them. Buttons whose handlers need the page body (Upload /
  // Download via refs) simply no-op for the brief loading moment.
  const topbarSlots = (
    <>
      <TopbarLeftSlot>
        <Link href="/admin/projects">
          <Button
            variant="ghost"
            size="sm"
            className="md:size-default md:h-10 md:px-4 bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 hover:ring-white/20 text-white border-0 backdrop-blur-md"
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4 md:mr-2" />
            <span className="hidden md:inline">Back</span>
          </Button>
        </Link>
      </TopbarLeftSlot>
      <TopbarRightSlot>
        {/* Grid / List view toggle — shares the per-user preference so
            the choice carries into folders and back. */}
        <ViewModeToggle value={folderView} onChange={setFolderView} />
        {(!project || project.status !== 'APPROVED') && (
          <Button
            variant="default"
            size="sm"
            className="w-9 px-0 shrink-0"
            onClick={() => videoManagerRef.current?.triggerUpload()}
            aria-label={t('uploadVideos')}
            title={t('uploadVideos')}
          >
            <Upload className="w-4 h-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-9 px-0 shrink-0 bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 hover:ring-white/20 text-white border-0 backdrop-blur-md"
          onClick={() => folderBrowserRef.current?.downloadAll()}
          aria-label="Download All"
          title="Download All"
        >
          <Download className="w-4 h-4" />
        </Button>
      </TopbarRightSlot>
    </>
  )

  if (loading) return topbarSlots

  if (!project) {
    return (
      <>
        {topbarSlots}
        <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">{t('projectNotFound')}</p>
            </CardContent>
          </Card>
        </div>
      </>
    )
  }

  // Filter comments to only show comments for active videos
  const iconBadgeClassName = 'rounded-md p-1.5 flex-shrink-0 bg-foreground/5 dark:bg-foreground/10'
  const iconBadgeIconClassName = 'w-4 h-4 text-primary'

  return (
    // 2.5.0+: drop the `bg-background` solid — it was covering the
    // layout's spotlight gradient, which is what gives the frosted
    // glass cards (FolderCard, VideoCard) their depth + light source.
    // The page is now transparent and just floats on top of the global
    // light spot. Also dropped `max-w-screen-2xl mx-auto` so the grid
    // flows flush-left next to the sidebar (Frame.io-style) instead
    // of being centred with empty margins on wide screens.
    <div className="flex-1 min-h-0">
      {/* 2.5.0+: action bar lives in the global topbar via portal
          slots so each page header reuses the same row. Back goes
          left (next to where Projects title sat); New Folder +
          Project Settings + the ProjectActions kebab go right. */}
      {/* 3.5.x: topbar slots defined above so they persist across the
          loading state (no flicker on folder navigation). */}
      {topbarSlots}
      <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6">

        {/* Frame.io-clean project view (1.0.6+): the page is just the
            folder grid. Everything else (client info, share link, due
            date, project actions) collapses into the top-bar ⋮ kebab
            above. */}
        <div className="space-y-6 min-w-0">
          <FolderBrowser
            ref={folderBrowserRef}
            projectId={project.id}
            projectSlug={project.slug}
            projectTitle={project.title}
            currentFolderId={null}
            onMutated={fetchProject}
            onUploadAsset={() => videoManagerRef.current?.triggerUpload()}
            onUploadFiles={(files) =>
              videoManagerRef.current?.triggerUploadWithFiles(files)
            }
            onUploadFolderTree={handleUploadFolderTree}
            onUploadFilesToFolder={(folderId, files) =>
              videoManagerRef.current?.triggerUploadWithFolderTree(
                files.map((file) => ({ file, folderId })),
              )
            }
            onUploadFolderTreeToFolder={(folderId, entries, extras) =>
              handleUploadFolderTree(entries, extras, folderId)
            }
            onUploadFilesAsVersion={(targetVideoId, files) =>
              videoManagerRef.current?.triggerUploadWithFolderTree(
                files.map((file) => ({
                  file,
                  // Root-level videos live at folderId=null; the new
                  // version must upload into the same scope before it's
                  // stacked onto the target.
                  folderId: null,
                  stackOntoVideoId: targetVideoId,
                })),
              )
            }
            hideHeaderActions
            stretch
            viewMode={folderView}
          />

          {/* AdminVideoManager mounted invisibly so the folder-tree
              drag-and-drop path has somewhere to send its upload
              modal. The visible UI on this page is just the folder
              grid above. */}
          <div className="sr-only" aria-hidden>
            <AdminVideoManager
              ref={videoManagerRef}
              projectId={project.id}
              folderId={null}
              videos={[]}
              projectStatus={project.status}
              restrictToLatestVersion={project.restrictCommentsToLatestVersion}
              onRefresh={fetchProject}
              sortMode="alphabetical"
              maxRevisions={project.maxRevisions}
              enableRevisions={project.enableRevisions}
            />
          </div>

          {/* Client Uploads block — only shown when reverse share is enabled */}
          {project.allowReverseShare && (
            <div className="min-w-0">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                  <span className={iconBadgeClassName}>
                    <FolderUp className={iconBadgeIconClassName} />
                  </span>
                  {t('clientUploads')}
                </h2>
              </div>
              <ProjectUploadsBlock projectId={project.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
