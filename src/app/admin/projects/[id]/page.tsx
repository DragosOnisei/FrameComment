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
import ProjectActions from '@/components/ProjectActions'
import ProjectUploadsBlock from '@/components/ProjectUploadsBlock'
import { ArrowLeft, FolderPlus, Settings, FolderUp } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { useTranslations } from 'next-intl'
import { logError } from '@/lib/logging'
import { useAdminViewMode } from '@/lib/use-admin-view-mode'
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
  const [folderView] = useAdminViewMode()
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
          null,
          paths,
        )
        const seeded = entries
          .map((entry) => {
            const dir = entry.relativePath.replace(/\/[^/]*$/, '')
            const isTopLevel = !dir || dir === entry.relativePath
            // At project root we can't host loose files — they must
            // live inside a folder. Drop any top-level files (this is
            // an edge case: the user dropped a single video together
            // with a folder).
            if (isTopLevel) return null
            const targetFolderId = pathToFolderId.get(dir) || null
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

    // Check if any videos are currently processing
    const hasProcessingVideos = project.videos.some(
      (video: any) => video.status === 'PROCESSING' || video.status === 'UPLOADING'
    )

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


  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">{tc('loading')}</p>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{t('projectNotFound')}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Filter comments to only show comments for active videos
  const iconBadgeClassName = 'rounded-md p-1.5 flex-shrink-0 bg-foreground/5 dark:bg-foreground/10'
  const iconBadgeIconClassName = 'w-4 h-4 text-primary'

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        {/* 1.3.0+: top action bar is now phone-friendly. On `<sm` the
            buttons are icon-only with no min-width so they all fit
            on one row even at 360px. From sm: up, the labels return
            and a 150px floor restores the desktop look. */}
        <div className="mb-4 sm:mb-6 flex items-center justify-between gap-2">
          <Link href="/admin/projects">
            <Button
              variant="outline"
              size="sm"
              className="sm:size-default sm:h-10 sm:px-4 sm:min-w-[150px]"
              aria-label="Back"
            >
              <ArrowLeft className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Back</span>
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            {/* 1.7.0+: the Grid / Table toggle that lived here was
                moved to AdminHeader so the same control flips both
                this view and the projects dashboard. */}
            {/* New Folder hoisted up here (1.0.9+) so it sits alongside
                Project settings instead of inline next to the
                breadcrumb. Driven through the FolderBrowser ref. */}
            <Button
              variant="outline"
              size="sm"
              className="sm:h-10 sm:px-4 sm:min-w-[150px]"
              onClick={() => folderBrowserRef.current?.openNewFolderDialog()}
              aria-label="New Folder"
            >
              <FolderPlus className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">New Folder</span>
            </Button>
            <Link href={`/admin/projects/${id}/settings`}>
              <Button
                variant="outline"
                size="sm"
                className="sm:h-10 sm:px-4 sm:min-w-[150px]"
                aria-label={t('projectSettings')}
              >
                <Settings className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">{t('projectSettings')}</span>
              </Button>
            </Link>
            {/* Project kebab (1.0.6+) — Send Notification, View Admin
                Share Page, View Analytics, Copy share link, Approve /
                Archive / Delete. Replaces the entire right sidebar. */}
            <ProjectActions
              project={project}
              videos={project.videos}
              onRefresh={fetchProject}
              shareUrl={shareUrl}
              recipients={project.recipients || []}
            />
          </div>
        </div>

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
            onUploadFolderTree={handleUploadFolderTree}
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
