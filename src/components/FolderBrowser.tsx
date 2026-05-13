'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ChevronRight,
  FolderPlus,
  Home,
  Loader2,
  UploadCloud,
  Upload,
  Folder as FolderIcon,
  Files,
  Download,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { logError } from '@/lib/logging'
import FolderCard from './FolderCard'
import VideoCard from './VideoCard'
import NewFolderDialog from './NewFolderDialog'
import FolderContextMenu from './FolderContextMenu'
import {
  snapshotDataTransferEntries,
  walkSnapshotEntries,
  entriesFromInputFiles,
  isAcceptedVideoFile,
  type FileTreeEntry,
} from '@/lib/folder-upload'

/**
 * Frame.io-style folder browser used on the admin project page and
 * on the folder sub-route page. Renders:
 *
 *  - Breadcrumb (Project / Folder A / Folder B …) that links back up
 *    the tree.
 *  - "New Folder" button which opens the create dialog.
 *  - Grid of folder cards at the current level.
 *
 * Videos are rendered separately by the parent component (the
 * existing AdminVideoManager keeps its upload + versions UX). This
 * component focuses on the folder dimension.
 *
 * On rename / delete the browser hits the existing Phase B endpoints
 * (PATCH / DELETE /api/folders/[id]) and re-fetches the current
 * level.
 */
export interface FolderBrowserProps {
  projectId: string
  /** Slug of the parent project — used to build links back to the
   *  project root. */
  projectSlug: string
  /** Human-readable project name — first item in the breadcrumb. */
  projectTitle: string
  /** null at project root; a folder id when drilled into a folder. */
  currentFolderId: string | null
  /** Breadcrumb supplied by the parent (server-fetched in the folder
   *  sub-route page). When `currentFolderId` is null this is empty. */
  breadcrumb?: Array<{ id: string; name: string }>
  /** Called after a successful create / rename / delete so the parent
   *  can also refresh its own state (e.g. video list).         */
  onMutated?: () => void
  /** Triggered by the "Upload Asset" item of the right-click context
   *  menu. The parent page wires this to its AdminVideoManager (which
   *  owns the actual file picker + upload pipeline). When omitted the
   *  menu item is rendered disabled. */
  onUploadAsset?: () => void
  /** Triggered by the "Upload Folder" item of the right-click context
   *  menu. Folder upload is a 1.0.7 feature; the menu item is rendered
   *  disabled when this prop is omitted. */
  onUploadFolder?: () => void
  /** When true, the outer container stretches vertically so the
   *  right-click context menu is available across a much larger
   *  surface (not just the folder grid itself). Use on pages where
   *  the FolderBrowser is the only / primary content. */
  stretch?: boolean
  /** Videos that live directly in the current folder. Rendered as
   *  cards in the SAME grid as folders so the page reads as one
   *  uniform Frame.io-style grid (1.0.6+). Pass the raw video rows
   *  from /api/folders/[id] — grouping by name happens here. */
  videos?: VideoRow[]
  /** Called when the empty-state drop zone receives OS files (drag-
   *  drop OR file picker / folder picker). The parent page wires
   *  this to AdminVideoManager's `triggerUploadWithFiles` so the
   *  upload modal opens pre-seeded with the dropped files. */
  onUploadFiles?: (files: File[]) => void
  /** Called when the user drops (or picks) a directory containing
   *  sub-folders. Entries arrive flat with `relativePath` already
   *  populated; the parent is responsible for re-creating the folder
   *  hierarchy and routing each video into the right sub-folder
   *  (1.0.6+). When omitted, folder drops fall back to a flat upload
   *  into the current folder. */
  onUploadFolderTree?: (entries: FileTreeEntry[]) => void
}

interface FolderRow {
  id: string
  slug: string
  name: string
  itemCount: number
  /** Up to 4 preview tiles for the Frame.io-style mosaic cover
   *  (1.0.7+). Tiles can be either video thumbnails (when the folder
   *  has videos directly inside) or folder glyphs (when the folder
   *  only has sub-folders). Falls back to the plain folder icon when
   *  the array is empty. */
  previewItems?: Array<
    | { kind: 'video'; videoId: string; thumbnailUrl: string }
    | { kind: 'folder'; folderId: string }
  >
}

/** A single video row exactly as returned by /api/folders/[id]. */
interface VideoRow {
  id: string
  name: string
  version: number
  versionLabel?: string | null
  duration?: number | null
  approved?: boolean
  thumbnailPath?: string | null
  /** Signed `/api/content/{token}` URL produced server-side. The
   *  server mints these on every folder GET so they stay fresh. */
  thumbnailUrl?: string | null
  /** Signed `/api/content/{token}` URL for a low-quality preview
   *  (720p when available, else 1080p / 2160p / original). Used as
   *  the FALLBACK hover-scrub source when there's no storyboard. */
  previewUrl?: string | null
  /** Signed URL to the storyboard sprite-sheet JPEG. When present
   *  the card scrubs via CSS background-position (instant). */
  storyboardUrl?: string | null
  status?: string
  createdAt?: string | Date
  /** Total number of comments on this specific version. */
  commentCount?: number
  /** Admin who uploaded the video (1.0.6+); null for legacy rows. */
  createdBy?: {
    id: string
    name: string | null
    username: string | null
    email: string
  } | null
}

/** One card per video name; we collapse multiple versions of the
 *  same name into a single entry and show the LATEST version on the
 *  card subtext. */
interface VideoGroup {
  /** ID of the latest version — used as the kebab target. */
  id: string
  name: string
  versionLabel?: string
  duration?: number
  versionCount: number
  approved: boolean
  thumbnailPath?: string | null
  thumbnailUrl?: string | null
  previewUrl?: string | null
  storyboardUrl?: string | null
  allIds: string[]
  /** Status of the latest version — surfaces as a "Processing…" /
   *  "Failed" overlay on the card so the user can see why there's
   *  no thumbnail yet. */
  status?: string
  /** Sum of comments across every version in the group. */
  commentCount: number
  /** "uploader" = createdBy of the latest version. */
  uploaderName?: string | null
  /** ISO timestamp of the latest version's upload. */
  createdAt?: string | Date
}

export default function FolderBrowser({
  projectId,
  projectSlug: _projectSlug,
  projectTitle,
  currentFolderId,
  breadcrumb = [],
  onMutated,
  onUploadAsset,
  onUploadFolder,
  stretch = false,
  videos = [],
  onUploadFiles,
  onUploadFolderTree,
}: FolderBrowserProps) {
  const router = useRouter()
  // Drop zone state — true while the user is dragging OS files over
  // the empty state, used for the highlight ring.
  const [isFileDropHover, setIsFileDropHover] = useState(false)
  // Upload dropdown ("Files" / "Folder") open state.
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false)
  const uploadMenuRef = useRef<HTMLDivElement>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // Mark the folder input with `webkitdirectory` once it's mounted —
  // React doesn't recognise the attribute as a typed prop on input,
  // and DOM-attribute spelling is camelCase-via-setAttribute.
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '')
      folderInputRef.current.setAttribute('directory', '')
    }
  }, [])

  // Close the Upload dropdown on outside click / Escape.
  useEffect(() => {
    if (!uploadMenuOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!uploadMenuRef.current) return
      if (!uploadMenuRef.current.contains(e.target as Node)) setUploadMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUploadMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [uploadMenuOpen])
  const [folders, setFolders] = useState<FolderRow[]>([])
  // Root-level videos returned by `/api/folders?parentFolderId=root`
  // (1.0.7+). At nested folder levels this stays empty — the parent
  // page passes its own video list via the `videos` prop instead.
  const [rootVideos, setRootVideos] = useState<VideoRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewDialog, setShowNewDialog] = useState(false)
  // When true the New Folder dialog renders in "restricted" mode and
  // also asks for a password (used by the right-click context menu's
  // "New Restricted Folder" action).
  const [newDialogRestricted, setNewDialogRestricted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Right-click context menu state. `ctxMenu.open === false` keeps the
  // menu unmounted; x/y are viewport-coordinate click positions used
  // by the (fixed) menu container.
  const [ctxMenu, setCtxMenu] = useState<{ open: boolean; x: number; y: number }>({
    open: false,
    x: 0,
    y: 0,
  })
  // Drag-and-drop: tracks the folder currently being dragged so the
  // sibling cards can render their drop-target visual feedback and
  // skip themselves.
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [breadcrumbDropHover, setBreadcrumbDropHover] = useState<string | null>(null)
  // Multi-select state (1.0.6+). IDs are video group IDs (latest
  // version per name), same identity the grid uses as React keys.
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [bulkBusy, setBulkBusy] = useState(false)
  // Drag-to-stack state (1.0.6+). When non-null, a video card is
  // mid-drag — sibling cards render with the "potential target"
  // affordance, the source card is ghosted.
  const [draggingVideoId, setDraggingVideoId] = useState<string | null>(null)

  const fetchFolders = useCallback(async () => {
    try {
      setLoading(true)
      const url = currentFolderId
        ? `/api/folders/${currentFolderId}`
        : `/api/folders?projectId=${projectId}&parentFolderId=root`
      const res = await apiFetch(url)
      if (!res.ok) throw new Error(`Failed to load folders (HTTP ${res.status})`)
      const data = await res.json()
      // /api/folders root response shapes (1.0.7+):
      //   Array            — folders only (no root videos at all)
      //   { folders, videos } — same folders plus the videos that
      //                         live at the project root
      // /api/folders/[id] returns { folder, breadcrumb } as before.
      const rootShape =
        !Array.isArray(data) &&
        Array.isArray((data as any).folders) &&
        Array.isArray((data as any).videos)
      if (Array.isArray(data) || rootShape) {
        const foldersArray: any[] = Array.isArray(data)
          ? data
          : (data as any).folders
        setFolders(
          foldersArray.map((f: any) => ({
            id: f.id,
            slug: f.slug,
            name: f.name,
            // Prefer the API-provided `itemCount` (counts video
            // groups, not versions). Falls back to the raw _count
            // sum for older API responses that don't include it.
            itemCount:
              typeof f.itemCount === 'number'
                ? f.itemCount
                : (f._count?.subfolders ?? 0) + (f._count?.videos ?? 0),
            previewItems: Array.isArray(f.previewItems) ? f.previewItems : [],
          })),
        )
        // Root-level videos (1.0.7+) — videos parked at the project
        // root, e.g. ones the user just moved up out of a top-level
        // folder. Stored separately so we don't fight the parent
        // page's `videos` prop when inside a folder.
        if (rootShape) {
          setRootVideos((data as any).videos as VideoRow[])
        } else {
          setRootVideos([])
        }
      } else if (data?.folder?.subfolders) {
        setFolders(
          data.folder.subfolders.map((f: any) => ({
            id: f.id,
            slug: f.slug,
            name: f.name,
            itemCount:
              typeof f.itemCount === 'number'
                ? f.itemCount
                : (f._count?.subfolders ?? 0) + (f._count?.videos ?? 0),
            previewItems: Array.isArray(f.previewItems) ? f.previewItems : [],
          })),
        )
      } else {
        setFolders([])
      }
      setError(null)
    } catch (err) {
      logError('[FolderBrowser] fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load folders')
    } finally {
      setLoading(false)
    }
  }, [projectId, currentFolderId])

  useEffect(() => {
    fetchFolders()
  }, [fetchFolders])

  // Refetch when a programmatic folder create finishes elsewhere in
  // the page (1.0.7+). Used by the folder-tree drag-and-drop path so
  // the brand-new sub-folders show up in the grid as soon as they
  // exist in the DB, without waiting for the user to refresh.
  useEffect(() => {
    const handler = () => fetchFolders()
    window.addEventListener('framecomment:folders-changed', handler)
    return () => {
      window.removeEventListener('framecomment:folders-changed', handler)
    }
  }, [fetchFolders])

  // ─── handlers ───────────────────────────────────────────────
  // Create a folder. When `password` is provided (the "New Restricted
  // Folder" path) we follow up with a PATCH that flips authMode to
  // PASSWORD and stores the encrypted share password. If the PATCH
  // fails we DELETE the dangling folder so the user doesn't end up
  // with a public folder they thought was restricted.
  const handleCreate = useCallback(
    async (name: string, password?: string) => {
      const res = await apiFetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          parentFolderId: currentFolderId,
          name,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to create folder')
      }
      const created = await res.json().catch(() => null)

      if (password && created?.id) {
        try {
          const patch = await apiFetch(`/api/folders/${created.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              authMode: 'PASSWORD',
              sharePassword: password,
            }),
          })
          if (!patch.ok) {
            const err = await patch.json().catch(() => ({}))
            // Roll back: delete the folder we just created so the user
            // can retry cleanly.
            await apiFetch(`/api/folders/${created.id}`, { method: 'DELETE' }).catch(
              () => null,
            )
            throw new Error(err.error || 'Failed to set folder password')
          }
        } catch (err) {
          await fetchFolders()
          onMutated?.()
          throw err
        }
      }

      await fetchFolders()
      onMutated?.()
    },
    [projectId, currentFolderId, fetchFolders, onMutated],
  )

  const handleOpenFolder = useCallback(
    (folderId: string) => {
      router.push(`/admin/projects/${projectId}/folder/${folderId}`)
    },
    [router, projectId],
  )

  const handleRename = useCallback(
    async (folderId: string) => {
      const current = folders.find((f) => f.id === folderId)
      const next = window.prompt('Rename folder to:', current?.name || '')
      if (!next || !next.trim() || next.trim() === current?.name) return
      try {
        const res = await apiFetch(`/api/folders/${folderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: next.trim() }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to rename folder')
        }
        await fetchFolders()
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to rename folder')
      }
    },
    [folders, fetchFolders, onMutated],
  )

  const handleShare = useCallback(
    async (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId)
      if (!folder) return
      const url = `${window.location.origin}/share/folder/${folder.slug}`
      try {
        await navigator.clipboard.writeText(url)
        alert(`Folder share link copied to clipboard:\n${url}`)
      } catch {
        // Fallback: show the link in a prompt so the user can copy it manually.
        window.prompt('Folder share link:', url)
      }
    },
    [folders],
  )

  // ─── drag-and-drop handlers ────────────────────────────────
  // Moves a folder to a new parent (or to the project root when
  // newParentId is null). The server enforces cycle detection and
  // same-project constraints; we just re-fetch on success.
  const moveFolder = useCallback(
    async (folderId: string, newParentId: string | null) => {
      try {
        const res = await apiFetch(`/api/folders/${folderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentFolderId: newParentId }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to move folder')
        }
        await fetchFolders()
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move folder')
      }
    },
    [fetchFolders, onMutated],
  )

  const handleDropOnFolder = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return
      moveFolder(sourceId, targetId)
    },
    [moveFolder],
  )

  // Drop target on a breadcrumb crumb: moves the folder to that
  // crumb's level. The first crumb is the project root (null parent);
  // others are folder ancestors (their own id is the new parent).
  const handleDropOnBreadcrumb = useCallback(
    (crumbFolderId: string | null) => {
      if (!draggingFolderId) return
      // Avoid no-op moves: dropping onto current level == doing nothing
      if (crumbFolderId === currentFolderId) return
      moveFolder(draggingFolderId, crumbFolderId)
    },
    [draggingFolderId, currentFolderId, moveFolder],
  )

  const handleDelete = useCallback(
    async (folderId: string) => {
      try {
        const res = await apiFetch(`/api/folders/${folderId}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to delete folder')
        }
        await fetchFolders()
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to delete folder')
      }
    },
    [fetchFolders, onMutated],
  )

  // ─── video helpers ─────────────────────────────────────────
  // Group videos by name so multiple versions of the same asset
  // collapse into a single card (the latest version drives the
  // subtext + the kebab target). The server already orders rows by
  // `[name asc, version desc]`, so the first row of each group is
  // the latest version.
  const videoGroups = useMemo<VideoGroup[]>(() => {
    // At nested folder levels the parent page passes videos via the
    // `videos` prop; at the project root FolderBrowser fetches them
    // itself (in `rootVideos`) since the parent doesn't currently
    // know about them. Either way we group them the same way.
    const allVideos = videos.length > 0 ? videos : rootVideos
    const byName = new Map<string, VideoRow[]>()
    for (const v of allVideos) {
      const existing = byName.get(v.name)
      if (existing) existing.push(v)
      else byName.set(v.name, [v])
    }
    const groups: VideoGroup[] = []
    for (const [name, rows] of byName) {
      // Sort within the group: latest version first.
      const sorted = [...rows].sort((a, b) => b.version - a.version)
      const latest = sorted[0]
      const totalComments = sorted.reduce(
        (acc, v) => acc + (v.commentCount ?? 0),
        0,
      )
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
        thumbnailPath: latest.thumbnailPath ?? null,
        thumbnailUrl: latest.thumbnailUrl ?? null,
        previewUrl: latest.previewUrl ?? null,
        storyboardUrl: latest.storyboardUrl ?? null,
        status: latest.status,
        allIds: sorted.map((v) => v.id),
        commentCount: totalComments,
        uploaderName,
        createdAt: latest.createdAt,
      })
    }
    // Folders are ordered by name asc on the server; mirror that for
    // videos so the unified grid reads alphabetically.
    return groups.sort((a, b) => a.name.localeCompare(b.name))
  }, [videos, rootVideos])

  const handleOpenVideo = useCallback(
    (videoName: string) => {
      // FolderBrowser only renders on admin pages (1.0.7+), so we
      // navigate into the admin video player rather than the public
      // share URL. This keeps admin privileges (rename / delete
      // comments, admin badges, no "Client N" labelling) instead of
      // re-entering as an anonymous reviewer. Pass folderId so the
      // player's title flyout stays scoped to the current folder.
      const base = `/admin/projects/${projectId}/share?video=${encodeURIComponent(videoName)}`
      const url = currentFolderId
        ? `${base}&folderId=${encodeURIComponent(currentFolderId)}`
        : base
      router.push(url)
    },
    [router, projectId, currentFolderId],
  )

  const handleRenameVideo = useCallback(
    async (videoId: string, currentName: string) => {
      const next = window.prompt('Rename video to:', currentName)
      if (!next || !next.trim() || next.trim() === currentName) return
      try {
        const res = await apiFetch(`/api/videos/${videoId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: next.trim() }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to rename video')
        }
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to rename video')
      }
    },
    [onMutated],
  )

  const handleDeleteVideo = useCallback(
    async (videoId: string) => {
      // Delete every version that shares this video's name so the
      // card disappears as a whole. The card's `id` here is the
      // latest version; we use `videoGroups` to find the siblings.
      const group = videoGroups.find((g) => g.allIds.includes(videoId))
      const idsToDelete = group ? group.allIds : [videoId]
      // Collect errors but don't bail on the first one — when one
      // version was already deleted (e.g. a stale UI from a prior
      // attempt), the rest of the group should still go down, and
      // a 404 should be treated as "already gone" rather than a real
      // failure (1.0.7+).
      const realErrors: string[] = []
      for (const id of idsToDelete) {
        try {
          const res = await apiFetch(`/api/videos/${id}`, { method: 'DELETE' })
          if (!res.ok && res.status !== 404) {
            const err = await res.json().catch(() => ({}))
            realErrors.push(err.error || `HTTP ${res.status}`)
          }
        } catch (err) {
          realErrors.push(
            err instanceof Error ? err.message : 'Network error',
          )
        }
      }
      // Always refresh so a stale row clears even if it was the
      // 404 case; only surface an alert when something genuinely
      // failed.
      onMutated?.()
      if (realErrors.length > 0) {
        alert(`Failed to delete video: ${realErrors[0]}`)
      }
    },
    [onMutated, videoGroups],
  )

  // ─── multi-select + bulk actions (1.0.6+) ────────────────
  const handleToggleVideoSelect = useCallback((id: string) => {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedVideoIds(new Set())
  }, [])

  // Mint a one-shot signed download URL for a single video. Uses the
  // existing POST /api/videos/[id]/download-token endpoint which
  // handles admin auth + permission checks server-side.
  const fetchDownloadUrl = async (videoId: string): Promise<string | null> => {
    try {
      const res = await apiFetch(`/api/videos/${videoId}/download-token`, {
        method: 'POST',
      })
      if (!res.ok) return null
      const data = await res.json()
      return data?.url || null
    } catch {
      return null
    }
  }

  /**
   * Trigger a browser download for each video sequentially. We use a
   * hidden anchor + small delay between hits to avoid the popup
   * blocker that fires on multiple programmatic downloads.
   */
  const downloadVideos = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    setBulkBusy(true)
    try {
      for (const id of ids) {
        const url = await fetchDownloadUrl(id)
        if (!url) continue
        const a = document.createElement('a')
        a.href = url
        // The /api/content endpoint already sets a Content-Disposition
        // header on download requests, so leaving `download` empty is
        // fine — the browser picks up the filename from the response.
        a.download = ''
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
        await new Promise((r) => setTimeout(r, 400))
      }
    } finally {
      setBulkBusy(false)
    }
  }, [])

  const handleBulkDownload = useCallback(() => {
    // Collapse video-group ids → only the latest version per name
    // (the card id). That's what the user sees and what they
    // expect to grab.
    const ids = Array.from(selectedVideoIds)
    downloadVideos(ids)
  }, [selectedVideoIds, downloadVideos])

  const handleDownloadAll = useCallback(() => {
    const ids = videoGroups.map((g) => g.id)
    downloadVideos(ids)
  }, [videoGroups, downloadVideos])

  // Drag-to-stack handler (1.0.6+). Reparents the source video's
  // group into the target video's group via POST
  // /api/videos/[id]/stack. Server enforces same-folder + same-
  // project constraints and renumbers versions atomically.
  const handleStackVideos = useCallback(
    async (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return
      try {
        const res = await apiFetch(`/api/videos/${sourceId}/stack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetVideoId: targetId }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to stack videos')
        }
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to stack videos')
      }
    },
    [onMutated],
  )

  // Drag-video-onto-folder handler (1.0.7+). When the user drops a
  // video card onto a folder card, every version that belongs to the
  // same version group (same `name` in this folder) is reparented to
  // the target folder in one batch call so the move stays atomic. We
  // optimistically remove the local card immediately to avoid a
  // visible "double image" while the fetch resolves.
  const handleMoveVideoToFolder = useCallback(
    async (sourceVideoId: string, targetFolderId: string) => {
      if (!sourceVideoId || !targetFolderId) return
      const group = videoGroups.find((g) => g.allIds.includes(sourceVideoId))
      const idsToMove = group ? group.allIds : [sourceVideoId]
      try {
        const res = await apiFetch('/api/videos/batch', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoIds: idsToMove,
            folderId: targetFolderId,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to move video')
        }
        // Tell the page to refetch — it'll bring back a folder grid
        // with the moved video gone from here and the folder's item
        // count bumped by one.
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move video')
      }
    },
    [videoGroups, onMutated],
  )

  // "Move up one folder" target (1.0.7+). When we're inside ANY
  // folder the user can move things one level up: a deep folder
  // bubbles up to its parent, and a top-level folder bubbles up to
  // the project root. `parentFolderId === null` means "project root";
  // `canMoveUp === false` only when we're already at the project
  // root (currentFolderId is null), since there is nothing above the
  // project itself.
  const canMoveUp = !!currentFolderId
  const parentFolderId = useMemo<string | null>(() => {
    if (!currentFolderId) return null
    if (!Array.isArray(breadcrumb) || breadcrumb.length < 2) return null
    return breadcrumb[breadcrumb.length - 2]?.id ?? null
  }, [currentFolderId, breadcrumb])

  // Move-up handler (1.0.7+) — moves the whole version group of a
  // single video one level up the tree. Uses the same batch endpoint
  // as the drag-onto-folder path so the move stays atomic. Sending
  // `folderId: null` parks the group at the project root, which the
  // API accepts.
  const handleMoveVideoUp = useCallback(
    async (videoId: string) => {
      if (!canMoveUp) return
      const group = videoGroups.find((g) => g.allIds.includes(videoId))
      const idsToMove = group ? group.allIds : [videoId]
      try {
        const res = await apiFetch('/api/videos/batch', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoIds: idsToMove,
            folderId: parentFolderId,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to move video')
        }
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move video')
      }
    },
    [canMoveUp, parentFolderId, videoGroups, onMutated],
  )

  // Per-video share handler (1.0.7+). For now we surface the same
  // project share URL but with `?video=NAME` (and `&folderId` when
  // applicable) so the link opens the public player straight on this
  // video. Copies to clipboard and shows a small confirmation.
  const handleShareVideo = useCallback(
    async (_videoId: string, videoName: string) => {
      if (typeof window === 'undefined') return
      const origin = window.location.origin
      const params = new URLSearchParams({ video: videoName })
      if (currentFolderId) params.set('folderId', currentFolderId)
      const url = `${origin}/share/${_projectSlug}?${params.toString()}`
      try {
        await navigator.clipboard.writeText(url)
        alert(`Link copied to clipboard:\n${url}`)
      } catch {
        // Older browsers / strict permissions — at least show the URL
        // so the user can copy it manually.
        window.prompt('Copy this share link:', url)
      }
    },
    [_projectSlug, currentFolderId],
  )

  // Folder move-up handler (1.0.7+). Mirrors the video flow but
  // re-parents a folder via PATCH /api/folders/[id]. The server
  // already detects cycles, so we don't have to verify here.
  const handleMoveFolderUp = useCallback(
    async (folderId: string) => {
      if (!canMoveUp) return
      try {
        const res = await apiFetch(`/api/folders/${folderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentFolderId }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to move folder')
        }
        await fetchFolders()
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move folder')
      }
    },
    [canMoveUp, parentFolderId, fetchFolders, onMutated],
  )

  const handleBulkDelete = useCallback(async () => {
    if (selectedVideoIds.size === 0) return
    const count = selectedVideoIds.size
    if (
      !window.confirm(
        `Delete ${count} ${count === 1 ? 'video' : 'videos'}? This removes every version and its comments.`,
      )
    ) {
      return
    }
    setBulkBusy(true)
    try {
      for (const cardId of selectedVideoIds) {
        const group = videoGroups.find((g) => g.allIds.includes(cardId))
        const idsToDelete = group ? group.allIds : [cardId]
        for (const id of idsToDelete) {
          await apiFetch(`/api/videos/${id}`, { method: 'DELETE' }).catch(
            () => null,
          )
        }
      }
      clearSelection()
      onMutated?.()
    } finally {
      setBulkBusy(false)
    }
  }, [selectedVideoIds, videoGroups, onMutated, clearSelection])

  // ─── breadcrumb rendering ──────────────────────────────────
  // The parent passes breadcrumb when at a folder sub-route. At
  // project root we render just the project name (no chevrons).
  // Each crumb is ALSO a drop target during folder drag — dragging a
  // folder onto an ancestor crumb moves it to that level. The "root"
  // crumb (project name) drops the folder back to the project root.
  const FOLDER_MIME = 'application/x-framecomment-folder'
  const crumbDropProps = (crumbFolderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!draggingFolderId) return
      if (!Array.from(e.dataTransfer.types).includes(FOLDER_MIME)) return
      if (crumbFolderId === currentFolderId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDragEnter: (e: React.DragEvent) => {
      if (!draggingFolderId) return
      if (!Array.from(e.dataTransfer.types).includes(FOLDER_MIME)) return
      if (crumbFolderId === currentFolderId) return
      setBreadcrumbDropHover(crumbFolderId ?? '__root__')
    },
    onDragLeave: () => setBreadcrumbDropHover(null),
    onDrop: (e: React.DragEvent) => {
      const source = e.dataTransfer.getData(FOLDER_MIME)
      setBreadcrumbDropHover(null)
      if (!source) return
      e.preventDefault()
      handleDropOnBreadcrumb(crumbFolderId)
    },
  })

  const breadcrumbRendered = useMemo(() => {
    const crumbActive = (id: string | null) =>
      breadcrumbDropHover === (id ?? '__root__')
    return (
      <nav
        aria-label="Folder path"
        className="flex items-center gap-1 text-sm text-muted-foreground min-w-0 flex-wrap"
      >
        <Link
          href={`/admin/projects/${projectId}`}
          {...crumbDropProps(null)}
          className={`inline-flex items-center gap-1.5 hover:text-foreground transition-colors rounded-md px-1.5 py-0.5 ${
            crumbActive(null) ? 'bg-primary/15 text-primary' : ''
          }`}
        >
          <Home className="w-3.5 h-3.5" />
          <span className="truncate max-w-[160px]" title={projectTitle}>
            {projectTitle}
          </span>
        </Link>
        {breadcrumb.map((b, i) => {
          const isLast = i === breadcrumb.length - 1
          return (
            <span key={b.id} className="inline-flex items-center gap-1 min-w-0">
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
              {isLast ? (
                <span
                  className={`font-medium text-foreground truncate max-w-[160px] px-1.5 py-0.5 rounded-md ${
                    crumbActive(b.id) ? 'bg-primary/15 text-primary' : ''
                  }`}
                  title={b.name}
                  {...crumbDropProps(b.id)}
                >
                  {b.name}
                </span>
              ) : (
                <Link
                  href={`/admin/projects/${projectId}/folder/${b.id}`}
                  {...crumbDropProps(b.id)}
                  className={`hover:text-foreground transition-colors truncate max-w-[140px] rounded-md px-1.5 py-0.5 ${
                    crumbActive(b.id) ? 'bg-primary/15 text-primary' : ''
                  }`}
                  title={b.name}
                >
                  {b.name}
                </Link>
              )}
            </span>
          )
        })}
      </nav>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectTitle, breadcrumb, breadcrumbDropHover, draggingFolderId, currentFolderId])

  // Open the right-click context menu at the cursor. Skip the
  // browser's native menu only when the click landed on the
  // browser's "empty" surface (not on a folder card, which has its
  // own kebab menu and shouldn't trigger this one).
  const handleContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (target && target.closest('[data-folder-id]')) return
    if (target && target.closest('[role="menu"]')) return
    e.preventDefault()
    setCtxMenu({ open: true, x: e.clientX, y: e.clientY })
  }

  // OS file drag-and-drop handlers, attached to the outer container
  // (1.0.6+) so dropping files works the same whether the folder is
  // empty or already has content. We carefully ignore in-app folder
  // drags (those use a custom MIME type — see FolderCard).
  //
  // 1.0.7+: also handles whole-folder drops. When the user drops a
  // directory (or several) from their OS, we walk it via
  // `webkitGetAsEntry` and emit the file list with each entry's
  // relative path so the parent page can re-create the hierarchy as
  // FrameComment folders. The same outer container drop zone serves
  // both file and folder drops — empty-state, project root, and
  // already-populated folders all support the same gesture.
  const containerDragOver = (e: React.DragEvent) => {
    const canDropFiles = !!currentFolderId && !!onUploadFiles
    const canDropTree = !!onUploadFolderTree
    if (!canDropFiles && !canDropTree) return
    const types = Array.from(e.dataTransfer.types)
    if (types.includes(FOLDER_MIME)) return // in-app folder reorder
    if (!types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!isFileDropHover) setIsFileDropHover(true)
  }
  const containerDragLeave = (e: React.DragEvent) => {
    // Only clear when the cursor leaves the FolderBrowser bounding
    // box. Without this check, dragging over a child element fires
    // a leave on the parent and we'd flicker the overlay off/on.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const { clientX: x, clientY: y } = e
    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      setIsFileDropHover(false)
    }
  }
  const containerDrop = (e: React.DragEvent) => {
    const canDropFiles = !!currentFolderId && !!onUploadFiles
    const canDropTree = !!onUploadFolderTree
    if (!canDropFiles && !canDropTree) return
    e.preventDefault()
    setIsFileDropHover(false)

    // Try the modern entry-walk path first. CRITICAL: we snapshot
    // every dropped DataTransferItem into FileSystemEntry objects
    // synchronously here — `webkitGetAsEntry()` only works inside the
    // synchronous portion of the drop handler. Anything we do with
    // those entries (including the recursive directory walk) can then
    // be async safely.
    const snapshot = canDropTree
      ? snapshotDataTransferEntries(e.dataTransfer.items)
      : null
    const flatFiles = canDropFiles ? Array.from(e.dataTransfer.files) : []

    if (snapshot && snapshot.length > 0) {
      void (async () => {
        try {
          const walked = await walkSnapshotEntries(snapshot)
          if (walked.hadDirectory) {
            const videoEntries = walked.entries.filter((entry) =>
              isAcceptedVideoFile(entry.file),
            )
            if (videoEntries.length === 0) return
            onUploadFolderTree?.(videoEntries)
            return
          }
          // No directory was dropped — fall back to the flat-files
          // path if the parent gave us a handler for it.
          if (canDropFiles && flatFiles.length) {
            onUploadFiles?.(flatFiles)
          }
        } catch (err) {
          if (canDropFiles && flatFiles.length) {
            onUploadFiles?.(flatFiles)
          }
        }
      })()
      return
    }

    if (canDropFiles && flatFiles.length) {
      onUploadFiles?.(flatFiles)
    }
  }

  const hasItems = folders.length > 0 || videoGroups.length > 0

  return (
    <div
      className={`relative space-y-3${stretch ? ' min-h-[calc(100vh-9rem)]' : ''}`}
      onContextMenu={handleContextMenu}
      onDragOver={containerDragOver}
      onDragLeave={containerDragLeave}
      onDrop={containerDrop}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {breadcrumbRendered}
        <div className="flex items-center gap-2">
          {/* Download All — only useful inside a folder that has
              videos. Sequential download of the latest version per
              video name (matches what the user sees on the cards). */}
          {currentFolderId && videoGroups.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDownloadAll}
              disabled={bulkBusy}
            >
              <Download className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Download All</span>
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setNewDialogRestricted(false)
              setShowNewDialog(true)
            }}
          >
            <FolderPlus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">New Folder</span>
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Loading folders…
        </div>
      )}

      {!loading && error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && !error && !hasItems && (
        // Frame.io-style empty state (1.0.6+). The container above
        // handles OS-file drag/drop — here we only render the visual
        // dashed border + CTA. At the project root we swap the CTA
        // for "New Folder" since videos can't live at the root.
        <div
          className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed py-20 px-6 text-center min-h-[400px] transition-colors ${
            isFileDropHover
              ? 'border-primary/70 bg-primary/5'
              : 'border-border/40 bg-card/30'
          }`}
        >
          <div className="rounded-full bg-muted/50 p-5">
            <UploadCloud className="w-12 h-12 text-muted-foreground/70" />
          </div>
          <p className="mt-5 text-sm text-muted-foreground">
            {currentFolderId
              ? 'Drag files and folders to begin.'
              : onUploadFolderTree
                ? 'Drag a folder of videos here, or create your first folder.'
                : 'No folders here yet. Create your first folder to get started.'}
          </p>
          {currentFolderId ? (
            // Upload button with a small dropdown for Files / Folder.
            <div ref={uploadMenuRef} className="relative mt-4">
              <Button
                type="button"
                onClick={() => setUploadMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={uploadMenuOpen}
              >
                <Upload className="w-4 h-4 mr-2" />
                Upload
              </Button>
              {uploadMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-30 min-w-[180px] rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-2xl p-1"
                >
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setUploadMenuOpen(false)
                      filesInputRef.current?.click()
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
                  >
                    <Files className="w-4 h-4 shrink-0" />
                    Upload files
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setUploadMenuOpen(false)
                      folderInputRef.current?.click()
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
                  >
                    <FolderIcon className="w-4 h-4 shrink-0" />
                    Upload folder
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Button
              type="button"
              className="mt-4"
              onClick={() => {
                setNewDialogRestricted(false)
                setShowNewDialog(true)
              }}
            >
              <FolderPlus className="w-4 h-4 mr-2" />
              New Folder
            </Button>
          )}
        </div>
      )}

      {/* Floating multi-select action bar (1.0.6+). Appears at the
          bottom-center of the viewport when any video card is
          selected. Mirrors Frame.io's selection toolbar — count on
          the left, actions on the right, easy to dismiss with X. */}
      {selectedVideoIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full bg-popover text-popover-foreground border border-border shadow-2xl pl-2 pr-2 py-1.5">
          <button
            type="button"
            onClick={clearSelection}
            className="rounded-full p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium px-1 select-none">
            {selectedVideoIds.size}{' '}
            {selectedVideoIds.size === 1 ? 'video' : 'videos'} selected
          </span>
          <div className="h-5 w-px bg-border" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleBulkDownload}
            disabled={bulkBusy}
            className="rounded-full"
          >
            <Download className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Download</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleBulkDelete}
            disabled={bulkBusy}
            className="rounded-full text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Delete</span>
          </Button>
        </div>
      )}

      {/* File-drop overlay (1.0.6+) — only shown when there's
          already content in the folder, otherwise the empty-state
          dashed box already communicates "drop here". Pointer-
          events-none so the underlying drag events keep reaching
          the container. */}
      {isFileDropHover && hasItems && currentFolderId && (
        <div
          aria-hidden
          className="absolute inset-0 z-40 rounded-2xl border-2 border-dashed border-primary/70 bg-primary/10 backdrop-blur-[1px] flex items-center justify-center pointer-events-none"
        >
          <div className="flex flex-col items-center gap-3 text-primary">
            <UploadCloud className="w-12 h-12" />
            <p className="text-sm font-medium">Drop files to upload here</p>
          </div>
        </div>
      )}

      {/* Hidden file inputs used by the Upload dropdown above. The
          folder input gets `webkitdirectory` set imperatively in an
          effect since the prop isn't part of React's typed API. */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          if (files.length) onUploadFiles?.(files)
          e.target.value = ''
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          if (!files.length) {
            e.target.value = ''
            return
          }
          // When the input has `webkitdirectory` set, each File carries
          // a `webkitRelativePath` like "MyFolder/Sub/video.mp4". We
          // route folder pickers through the same tree handler used by
          // drag-drop so videos in nested sub-folders land in the
          // matching FrameComment hierarchy instead of all collapsing
          // to the current folder.
          const entries = entriesFromInputFiles(files).filter((entry) =>
            isAcceptedVideoFile(entry.file),
          )
          const hasNesting = entries.some((entry) =>
            entry.relativePath.includes('/'),
          )
          if (hasNesting && onUploadFolderTree && entries.length) {
            onUploadFolderTree(entries)
          } else {
            const videoFiles = files.filter((f) => isAcceptedVideoFile(f))
            if (videoFiles.length) onUploadFiles?.(videoFiles)
          }
          e.target.value = ''
        }}
      />

      {!loading && !error && (folders.length > 0 || videoGroups.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {folders.map((f) => (
            <FolderCard
              key={`folder:${f.id}`}
              id={f.id}
              name={f.name}
              itemCount={f.itemCount}
              slug={f.slug}
              previewItems={f.previewItems}
              onOpen={handleOpenFolder}
              onRename={handleRename}
              onShare={handleShare}
              onDelete={handleDelete}
              onMoveUp={canMoveUp ? handleMoveFolderUp : undefined}
              onDragStart={(id) => setDraggingFolderId(id)}
              onDragEnd={() => setDraggingFolderId(null)}
              onDropFolder={handleDropOnFolder}
              onDropVideo={handleMoveVideoToFolder}
              isBeingDragged={draggingFolderId === f.id}
              isPotentialDropTarget={
                draggingFolderId !== null && draggingFolderId !== f.id
              }
              isPotentialVideoDropTarget={draggingVideoId !== null}
            />
          ))}
          {videoGroups.map((v) => (
            <VideoCard
              key={`video:${v.id}`}
              id={v.id}
              name={v.name}
              versionLabel={v.versionLabel}
              duration={v.duration}
              versionCount={v.versionCount}
              thumbnailUrl={v.thumbnailUrl ?? null}
              previewUrl={v.previewUrl ?? null}
              storyboardUrl={v.storyboardUrl ?? null}
              status={v.status}
              approved={v.approved}
              commentCount={v.commentCount}
              uploaderName={v.uploaderName ?? null}
              createdAt={v.createdAt}
              isSelected={selectedVideoIds.has(v.id)}
              onToggleSelect={handleToggleVideoSelect}
              selectionMode={selectedVideoIds.size > 0}
              onStartVideoDrag={(id) => setDraggingVideoId(id)}
              onEndVideoDrag={() => setDraggingVideoId(null)}
              onStackOnto={handleStackVideos}
              isBeingDragged={draggingVideoId === v.id}
              isPotentialStackTarget={
                draggingVideoId !== null && draggingVideoId !== v.id
              }
              onOpen={handleOpenVideo}
              onRename={handleRenameVideo}
              onDelete={handleDeleteVideo}
              onMoveUp={canMoveUp ? handleMoveVideoUp : undefined}
              onShare={handleShareVideo}
            />
          ))}
        </div>
      )}

      <NewFolderDialog
        open={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        onSubmit={handleCreate}
        defaultName=""
        restricted={newDialogRestricted}
      />

      <FolderContextMenu
        open={ctxMenu.open}
        x={ctxMenu.x}
        y={ctxMenu.y}
        onClose={() => setCtxMenu((c) => ({ ...c, open: false }))}
        onUploadAsset={onUploadAsset}
        onUploadFolder={onUploadFolder}
        onNewFolder={() => {
          setNewDialogRestricted(false)
          setShowNewDialog(true)
        }}
        onNewRestrictedFolder={() => {
          setNewDialogRestricted(true)
          setShowNewDialog(true)
        }}
      />
    </div>
  )
}
