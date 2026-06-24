'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Download,
  Upload,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AdminVideoManager, { type AdminVideoManagerHandle } from '@/components/AdminVideoManager'
import FolderBrowser, {
  type FolderBrowserHandle,
} from '@/components/FolderBrowser'
import { TopbarLeftSlot, TopbarRightSlot } from '@/components/TopbarSlots'
import { apiFetch } from '@/lib/api-client'
import { useTranslations } from 'next-intl'
import { logError } from '@/lib/logging'
import { useAdminViewMode } from '@/lib/use-admin-view-mode'
import {
  createFolderHierarchy,
  uniqueDirectoryPaths,
  type FileTreeEntry,
} from '@/lib/folder-upload'

export const dynamic = 'force-dynamic'

/**
 * Admin folder-drill-down page (1.0.6+). Mirrors the admin project
 * page but scoped to a single folder: same FolderBrowser at the top
 * (showing subfolders) + AdminVideoManager below (showing the videos
 * that live directly in this folder). The breadcrumb is fetched from
 * the API and passed into FolderBrowser so the user can walk back up
 * the tree.
 */
export default function ProjectFolderPage() {
  const t = useTranslations('projects')
  const tc = useTranslations('common')
  const params = useParams()
  const router = useRouter()
  const projectId = params?.id as string
  const folderId = params?.folderId as string

  const [folder, setFolder] = useState<any>(null)
  const [project, setProject] = useState<any>(null)
  const [breadcrumb, setBreadcrumb] = useState<Array<{ id: string; name: string; slug: string }>>([])
  const [videos, setVideos] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // AdminVideoManager still needs a sortMode prop even though its
  // visible list is hidden (we use it only for the upload modal).
  const sortMode = 'alphabetical' as const
  const videoManagerRef = useRef<AdminVideoManagerHandle | null>(null)
  // FolderBrowser imperative handle (1.0.9+). Lets us drive the
  // browser's New-Folder dialog and Download-All flow from buttons
  // we render up in the top toolbar, alongside Upload + Settings.
  const folderBrowserRef = useRef<FolderBrowserHandle | null>(null)
  // 1.7.0+: grid/table preference comes from the shared admin
  // view-mode store; the actual toggle UI lives in AdminHeader.
  const [folderView] = useAdminViewMode()

  // 1.7.0+: stale-fetch guard. The user can navigate between
  // folders quickly (back, forward, into a sibling) and each
  // navigation kicks off a fresh fetchFolder. Without this seq
  // tag the older fetch can resolve last and either show the
  // wrong folder or flip the page into an error state ("Failed
  // to load project") that's no longer relevant.
  const fetchSeqRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const fetchFolder = useCallback(async (opts?: { silent?: boolean }) => {
    const seq = ++fetchSeqRef.current
    try {
      // Don't flash the full-screen "Loading…" view on background
      // polls — only on the first ever fetch / explicit refresh.
      if (!opts?.silent) setLoading(true)
      const [folderRes, projectRes] = await Promise.all([
        apiFetch(`/api/folders/${folderId}`),
        apiFetch(`/api/projects/${projectId}`),
      ])
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      if (folderRes.status === 404) {
        router.push(`/admin/projects/${projectId}`)
        return
      }
      // Project 404 happens on rapid navigation when the URL projectId
      // briefly references a deleted/moved project. Mirror the project
      // page's behaviour: bounce to the project list instead of flashing
      // a "Failed to load project" card.
      if (projectRes.status === 404) {
        router.push('/admin/projects')
        return
      }
      if (!folderRes.ok) {
        // Pull the server's `detail` so we see the real DB / Prisma
        // error instead of a generic "Failed to load folder".
        const body = await folderRes.json().catch(() => ({}))
        throw new Error(body?.detail || body?.error || 'Failed to load folder')
      }
      if (!projectRes.ok) throw new Error('Failed to load project')
      const folderData = await folderRes.json()
      const projectData = await projectRes.json()
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      setFolder(folderData.folder)
      setBreadcrumb(folderData.breadcrumb || [])
      setProject(projectData)
      setVideos(folderData.folder?.videos || [])
      setError(null)
    } catch (err) {
      // A newer fetch already ran — drop this stale error so it
      // doesn't render an obsolete "Failed to load project" card
      // over a page the user has already moved past.
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      logError('[ProjectFolderPage] fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load folder')
    } finally {
      if (!opts?.silent && seq === fetchSeqRef.current && aliveRef.current) {
        setLoading(false)
      }
    }
  }, [projectId, folderId, router])

  useEffect(() => {
    fetchFolder()
  }, [fetchFolder])

  // Handle a whole-folder drop (1.0.7+). The user dropped a folder
  // from their OS — we mint the matching FrameComment folders under
  // the current one first, then hand the upload modal a list of
  // `(file, folderId)` pairs so each video lands in the right place.
  // Hidden files and non-video files were already filtered out by the
  // FolderBrowser walker.
  const handleUploadFolderTree = useCallback(
    async (
      entries: FileTreeEntry[],
      extras?: { directoryPaths?: string[] },
    ) => {
      // 1.7.1+: empty drop folders still mint a matching folder
      // in FrameComment via `extras.directoryPaths`. Skip only
      // when the whole drop produced no files AND no folders.
      if (
        entries.length === 0 &&
        (extras?.directoryPaths?.length ?? 0) === 0
      ) {
        return
      }
      try {
        const paths = uniqueDirectoryPaths(entries, extras?.directoryPaths)
        const pathToFolderId = await createFolderHierarchy(
          projectId,
          folderId,
          paths,
        )
        const seeded = entries.map((entry) => {
          const dir = entry.relativePath.replace(/\/[^/]*$/, '')
          const isTopLevel = !dir || dir === entry.relativePath
          const targetFolderId = isTopLevel
            ? folderId
            : pathToFolderId.get(dir) || folderId
          return { file: entry.file, folderId: targetFolderId }
        })
        if (seeded.length === 0) {
          // Nothing to upload — just refresh so the new empty
          // folders appear in the grid.
          fetchFolder({ silent: true })
          return
        }
        videoManagerRef.current?.triggerUploadWithFolderTree(seeded)
        // Refresh in the background so the new folders show up in the
        // grid as soon as the upload begins.
        fetchFolder({ silent: true })
      } catch (err) {
        logError('[ProjectFolderPage] folder-tree upload failed:', err)
        alert(
          err instanceof Error
            ? `Failed to create folders: ${err.message}`
            : 'Failed to upload folder',
        )
      }
    },
    [projectId, folderId, fetchFolder],
  )

  // Auto-poll while any video in this folder is still being
  // processed by the worker (UPLOADING / PROCESSING). Stops as soon
  // as everything is READY, so we don't hammer the API. Mirrors the
  // logic on the project page so the new card lights up with its
  // thumbnail without the user having to refresh manually (1.0.6+).
  useEffect(() => {
    if (!videos || videos.length === 0) return
    const stillWorking = videos.some(
      (v: any) => v.status === 'UPLOADING' || v.status === 'PROCESSING',
    )
    if (!stillWorking) return
    const interval = setInterval(() => {
      // Silent: don't flash the full-screen "Loading…" view on each poll.
      fetchFolder({ silent: true })
    }, 4000)
    return () => clearInterval(interval)
  }, [videos, fetchFolder])

  // Listen for the same global events the project page uses so we
  // stay in sync after comments are posted / videos approved.
  useEffect(() => {
    const handler = () => fetchFolder()
    window.addEventListener('videoApprovalChanged', handler)
    window.addEventListener('commentDeleted', handler)
    window.addEventListener('commentPosted', handler)
    return () => {
      window.removeEventListener('videoApprovalChanged', handler)
      window.removeEventListener('commentDeleted', handler)
      window.removeEventListener('commentPosted', handler)
    }
  }, [fetchFolder])

  // 2.5.0+: render nothing while the first fetch is in flight — see
  // the matching note on the project root page. Sidebar + topbar
  // stay mounted from the layout, so navigation feels instant.
  if (loading) return null

  if (error || !folder || !project) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <p className="text-muted-foreground">{error || 'Folder not found'}</p>
            <Link href={`/admin/projects/${projectId}`}>
              <Button variant="outline">Back to project</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Build the breadcrumb shape FolderBrowser expects (id + name only;
  // slug is internal to the helper return value).
  const breadcrumbForBrowser = breadcrumb.map((b) => ({ id: b.id, name: b.name }))

  return (
    // 2.5.0+: drop the `bg-background` solid so the layout's spotlight
    // gradient shows through behind FolderCard / VideoCard glass; also
    // drop the centred max-w wrapper so folders flow flush-left next
    // to the sidebar.
    <div className="flex-1 min-h-0">
      {/* 2.5.0+: action bar lives in the global topbar via portal slots
          — same recipe as the project root page.
          2.5.1+: Back navigates ONE step up the tree. If the current
          folder has a `parentFolderId`, jump to that folder's page;
          otherwise we're a top-level folder under the project, so
          fall back to the project root. Previously it always went
          to the project root which lost the user's place when they
          were 2+ levels deep (e.g. VDA > Test Folder > YouTube). */}
      <TopbarLeftSlot>
        <Link
          href={
            folder?.parentFolderId
              ? `/admin/projects/${projectId}/folder/${folder.parentFolderId}`
              : `/admin/projects/${projectId}`
          }
        >
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
        {/* 2.5.0+: New Folder is an in-grid tile now; Project Settings
            moved into the ProjectActions kebab on the project root.
            We keep Upload + Download All here because they're the
            primary actions inside a folder. Text collapses to icon
            below `md` so the toolbar lines up with the search pill's
            own icon-only state — every group expands together. */}
        {project && project.status !== 'APPROVED' && (
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
      <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6">

        <div className="space-y-6">
          {/* Unified Frame.io-style grid (1.0.6+) — folders and
              videos render as siblings in the SAME grid inside
              FolderBrowser. */}
          <FolderBrowser
            ref={folderBrowserRef}
            projectId={project.id}
            projectSlug={project.slug}
            projectTitle={project.title}
            currentFolderId={folderId}
            breadcrumb={breadcrumbForBrowser}
            onMutated={() => fetchFolder({ silent: true })}
            onUploadAsset={() => videoManagerRef.current?.triggerUpload()}
            onUploadFiles={(files) =>
              videoManagerRef.current?.triggerUploadWithFiles(files)
            }
            onUploadFolderTree={handleUploadFolderTree}
            videos={videos}
            hideHeaderActions
            stretch
            viewMode={folderView}
          />

          {/* AdminVideoManager stays mounted but invisible — its
              imperative `triggerUpload` ref still drives the upload
              modal launched by the top-bar button and the right-click
              "Upload Asset" menu item. Passing `videos={[]}` keeps it
              from rendering its own version-grouped card list, which
              would duplicate what FolderBrowser already shows. */}
          <div className="sr-only" aria-hidden>
            <AdminVideoManager
              ref={videoManagerRef}
              projectId={project.id}
              folderId={folderId}
              videos={[]}
              projectStatus={project.status}
              restrictToLatestVersion={project.restrictCommentsToLatestVersion}
              onRefresh={fetchFolder}
              sortMode={sortMode}
              maxRevisions={project.maxRevisions}
              enableRevisions={project.enableRevisions}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
