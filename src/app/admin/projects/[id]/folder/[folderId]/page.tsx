'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Download,
  FolderPlus,
  Settings,
  Upload,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AdminVideoManager, { type AdminVideoManagerHandle } from '@/components/AdminVideoManager'
import FolderBrowser, {
  type FolderBrowserHandle,
} from '@/components/FolderBrowser'
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
    async (entries: FileTreeEntry[]) => {
      if (entries.length === 0) return
      try {
        const paths = uniqueDirectoryPaths(entries)
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

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">{tc('loading')}</p>
      </div>
    )
  }

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
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        {/* 1.3.0+: Frame.io-style top action bar. On phones (<sm)
            every button is icon-only with no min-width so the entire
            row — Back + Upload + Download + New Folder + Settings —
            fits on a single line at 360px. From sm: up we restore the
            150px floor + visible labels so the desktop layout is
            unchanged. Removed `flex-wrap` so buttons never stack into
            a 2x2 grid on mobile (Frame.io-style single-row toolbar). */}
        <div className="mb-4 sm:mb-6 flex items-center justify-between gap-2">
          <Link href={`/admin/projects/${projectId}`}>
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
          <div className="flex items-center gap-1 sm:gap-2">
            {project && project.status !== 'APPROVED' && (
              // Upload is the primary action — solid blue variant.
              <Button
                variant="default"
                size="sm"
                className="sm:h-10 sm:px-4 sm:min-w-[150px]"
                onClick={() => videoManagerRef.current?.triggerUpload()}
                aria-label={t('uploadVideos')}
              >
                <Upload className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">{t('uploadVideos')}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="sm:h-10 sm:px-4 sm:min-w-[150px]"
              onClick={() => folderBrowserRef.current?.downloadAll()}
              aria-label="Download All"
            >
              <Download className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Download All</span>
            </Button>
            {/* 1.7.0+: the Grid / Table toggle moved to AdminHeader
                so the same control flips both the dashboard and the
                folder browser. We still read folderView via
                useAdminViewMode below to pick the right layout. */}
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
            <Link href={`/admin/projects/${projectId}/settings`}>
              <Button
                variant="outline"
                size="sm"
                className="sm:h-10 sm:px-4 sm:min-w-[150px]"
                aria-label="Project settings"
              >
                <Settings className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Project settings</span>
              </Button>
            </Link>
          </div>
        </div>

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
