'use client'

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
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
import { ConfirmModal } from './ConfirmModal'
import { ShareModal } from './ShareModal'
import { SplitVersionsModal, type SplitVersionRow } from './SplitVersionsModal'
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
  /** Hide the inline Download-All / New-Folder buttons that sit next
   *  to the breadcrumb (1.0.9+). Use this when the parent page wants
   *  to render those actions in its own top bar and drive them
   *  through the imperative ref handle below. */
  hideHeaderActions?: boolean
}

/**
 * Imperative handle (1.0.9+). Lets a parent page drive the New-Folder
 * dialog and Download-All flow from buttons it renders outside the
 * FolderBrowser (e.g. a unified top action bar). Pair with
 * `hideHeaderActions` to avoid duplicate UI.
 */
export interface FolderBrowserHandle {
  openNewFolderDialog: (restricted?: boolean) => void
  downloadAll: () => void
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
  /** 1.6.0+: recursive byte total (as a stringified BigInt from the
   *  API). Rendered as "· X GB" in the FolderCard subtitle when
   *  greater than zero. */
  totalSize?: string | null
}

/** A single video row exactly as returned by /api/folders/[id]. */
interface VideoRow {
  id: string
  name: string
  version: number
  versionLabel?: string | null
  /** Filename the admin uploaded the video as (e.g. "ep03_v2.mov").
   *  Used as the new card name when the Split-versions modal pulls
   *  this row out of its group (1.0.8+). */
  originalFileName?: string | null
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
  /** 1.0.9+: distinguishes a real video upload from an image asset. */
  mediaType?: 'VIDEO' | 'IMAGE'
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
  /** 1.0.9+: media type of the latest version. */
  mediaType?: 'VIDEO' | 'IMAGE'
}

function FolderBrowserInner(
  {
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
    hideHeaderActions = false,
  }: FolderBrowserProps,
  ref: React.Ref<FolderBrowserHandle>,
) {
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

  // Frame.io-style modals (1.0.8+) — replace native window.confirm /
  // alert calls for the destructive Delete + share-link flows. We
  // keep a single shared piece of state per modal so any card / bulk
  // action can route through these without prop-drilling.
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    description?: React.ReactNode
    confirmLabel?: string
    variant?: 'default' | 'destructive'
    busy?: boolean
    onConfirm?: () => Promise<void> | void
  }>({ open: false, title: '' })
  // 1.4.x+: shareState carries enough context for the ShareModal to
  // both display the current expiration AND PATCH it to the right
  // endpoint when the admin hits Done. `kind === 'folder'` PATCHes
  // /api/folders/[id]; everything else (per-video / project root)
  // PATCHes /api/projects/[id] because the public share gate lives on
  // the project for those URLs.
  const [shareState, setShareState] = useState<{
    open: boolean
    title: string
    shareUrl: string
    kind: 'folder' | 'project'
    targetId: string | null
    initialExpiresAt: string | null
  }>({
    open: false,
    title: '',
    shareUrl: '',
    kind: 'folder',
    targetId: null,
    initialExpiresAt: null,
  })
  // Split-versions modal state (1.0.8+) — surfaces every version in a
  // group so the admin can lift selected rows back out into their
  // own standalone cards. Opened from the VideoCard kebab.
  const [splitState, setSplitState] = useState<{
    open: boolean
    groupName: string
    versions: SplitVersionRow[]
  }>({ open: false, groupName: '', versions: [] })
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
  // 1.1.0+: parallel set for folder cards. Bulk actions (delete /
  // move up / new folder with selection / download / drag-drop) all
  // operate on the COMBINED selection — `selectedVideoIds` +
  // `selectedFolderIds`. Stored separately so dispatch can branch by
  // entity kind (different API endpoints for folder vs video ops).
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [bulkBusy, setBulkBusy] = useState(false)
  // Drag-to-stack state (1.0.6+). When non-null, a video card is
  // mid-drag — sibling cards render with the "potential target"
  // affordance, the source card is ghosted.
  const [draggingVideoId, setDraggingVideoId] = useState<string | null>(null)
  // After "New Folder with Selection" we want the freshly-created
  // folder card to mount in inline-edit mode with the name pre-
  // selected (1.0.9+). The id sits here just long enough for the
  // matching FolderCard to consume it; FolderCard then calls
  // `onAutoEditDone` to clear it so the auto-edit doesn't retrigger
  // on a sibling refresh.
  const [pendingAutoEditFolderId, setPendingAutoEditFolderId] = useState<
    string | null
  >(null)

  const fetchFolders = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      // 1.0.8+: `silent` skips the spinner flicker on background
      // refreshes (e.g. after delete / move / drag-drop). The first
      // mount and explicit reloads still flip `loading` so the user
      // sees feedback when there genuinely is no data yet.
      if (!opts?.silent) setLoading(true)
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
            // 1.6.0: copy the recursive byte total through so
            // FolderCard can render "N items · X GB". Stays as the
            // raw string from the API — FolderCard converts via
            // `formatBytes()` which accepts string/number/BigInt.
            totalSize: f.totalSize ?? null,
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
            // 1.6.0: same totalSize pass-through for nested-folder
            // views as for the project root above.
            totalSize: f.totalSize ?? null,
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
  // exist in the DB, without waiting for the user to refresh. 1.0.8+:
  // silent so the spinner doesn't flash on every event.
  useEffect(() => {
    const handler = () => fetchFolders({ silent: true })
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
          await fetchFolders({ silent: true })
          onMutated?.()
          throw err
        }
      }

      await fetchFolders({ silent: true })
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
        await fetchFolders({ silent: true })
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
      // 1.4.x+: also read the folder's current shareExpiresAt so the
      // modal can pre-fill its toggle (ON when there's no expiry, OFF
      // with the chosen date when one is set). Best-effort — if the
      // fetch fails we just open with the default "no expiration".
      let initialExpiresAt: string | null = null
      try {
        const res = await apiFetch(`/api/folders/${folderId}`)
        if (res.ok) {
          const data = await res.json()
          const raw = data?.folder?.shareExpiresAt
          if (raw) {
            initialExpiresAt =
              typeof raw === 'string' ? raw : new Date(raw).toISOString()
          }
        }
      } catch {
        /* best-effort */
      }
      // 1.0.8+: replace the OS alert with the Frame.io-style share
      // modal (Link copied + Copy button + Done). The modal itself
      // does the clipboard write so the user can re-copy without
      // dismissing first.
      setShareState({
        open: true,
        title: folder.name,
        shareUrl: url,
        kind: 'folder',
        targetId: folderId,
        initialExpiresAt,
      })
      return
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
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move folder')
      }
    },
    [fetchFolders, onMutated],
  )

  const handleDropOnFolder = useCallback(
    async (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return
      // 1.1.0+: bulk drag with mixed selection. When the dragged
      // folder is part of the selection AND the combined selection
      // is ≥ 2, drop ALL selected items into the target — every
      // selected folder reparents to `targetId`, every selected
      // video's version group moves there too. Otherwise we ship
      // only the dragged folder (selection stays untouched).
      const combinedSize = selectedVideoIds.size + selectedFolderIds.size
      const isBulk = combinedSize >= 2 && selectedFolderIds.has(sourceId)
      if (!isBulk) {
        moveFolder(sourceId, targetId)
        return
      }
      try {
        for (const fid of selectedFolderIds) {
          if (fid === targetId) continue // can't nest a folder into itself
          await apiFetch(`/api/folders/${fid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentFolderId: targetId }),
          }).catch(() => null)
        }
        if (selectedVideoIds.size > 0) {
          const idsToMove: string[] = []
          for (const cardId of selectedVideoIds) {
            const grp = videoGroups.find((g) => g.allIds.includes(cardId))
            if (grp) idsToMove.push(...grp.allIds)
            else idsToMove.push(cardId)
          }
          if (idsToMove.length > 0) {
            await apiFetch('/api/videos/batch', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                videoIds: idsToMove,
                folderId: targetId,
              }),
            }).catch(() => null)
          }
        }
        clearSelection()
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move into folder')
      }
    },
    // `videoGroups` / `clearSelection` declared lower — TDZ-safe via
    // closure. eslint-disable-next-line react-hooks/exhaustive-deps
    [
      moveFolder,
      selectedVideoIds,
      selectedFolderIds,
      fetchFolders,
      onMutated,
    ],
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
    (folderId: string) => {
      // 1.1.0+: bulk-aware. When 2+ items (videos + folders) are
      // selected, clicking Delete on any folder kebab routes through
      // the combined bulk-delete flow. We inline the bulk path here
      // (rather than calling the lower-down `performBulkDelete`)
      // because that helper is declared further down the component
      // and lifting it up would hit JS's TDZ. The `videoGroups` /
      // `clearSelection` closure references resolve at click time,
      // by which point both have rendered.
      const combinedSize = selectedVideoIds.size + selectedFolderIds.size
      if (combinedSize >= 2) {
        const count = combinedSize
        setConfirmState({
          open: true,
          title: `Delete ${count} items?`,
          description:
            'Deleted items can be recovered for 30 days before being permanently deleted. Folders cascade-delete their entire contents.',
          confirmLabel: 'Delete',
          variant: 'destructive',
          onConfirm: async () => {
            setConfirmState((s) => ({ ...s, busy: true }))
            setBulkBusy(true)
            try {
              for (const cardId of selectedVideoIds) {
                const grp = videoGroups.find((g) => g.allIds.includes(cardId))
                const ids = grp ? grp.allIds : [cardId]
                for (const id of ids) {
                  await apiFetch(`/api/videos/${id}`, {
                    method: 'DELETE',
                  }).catch(() => null)
                }
              }
              for (const fid of selectedFolderIds) {
                await apiFetch(`/api/folders/${fid}`, {
                  method: 'DELETE',
                }).catch(() => null)
              }
              // 1.2.1+: nudge the AdminHeader Trash badge. We fire
              // once per user action (not once per item) so the
              // count doesn't get re-fetched N times in a tight
              // loop. Empty containers may have skipped Trash on
              // the server, but the count endpoint reflects the
              // truth either way.
              window.dispatchEvent(new CustomEvent('trash:changed'))
              clearSelection()
              await fetchFolders({ silent: true })
              onMutated?.()
            } finally {
              setBulkBusy(false)
              setConfirmState({ open: false, title: '' })
            }
          },
        })
        return
      }

      const folder = folders.find((f) => f.id === folderId)
      const name = folder?.name ?? 'this folder'

      // 1.2.1+: empty-folder fast path. If the folder has no
      // immediate children, it can't have deeper descendants
      // either — so we skip the confirm dialog entirely and just
      // delete. The server already hard-deletes empty folders
      // (skipping Trash), so the dialog's "moved to Trash"
      // language would be a lie anyway. Nothing to recover means
      // nothing to confirm.
      if (folder && folder.itemCount === 0) {
        ;(async () => {
          try {
            const res = await apiFetch(`/api/folders/${folderId}`, {
              method: 'DELETE',
            })
            if (!res.ok) {
              const err = await res.json().catch(() => ({}))
              throw new Error(err.error || 'Failed to delete folder')
            }
            // Empty-folder deletes don't touch the Trash count,
            // but firing the event is cheap and harmless — the
            // count endpoint reflects the true state either way.
            window.dispatchEvent(new CustomEvent('trash:changed'))
            await fetchFolders({ silent: true })
            onMutated?.()
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete folder')
          }
        })()
        return
      }

      // 1.0.8+: Frame.io-style ConfirmModal. The folder goes to
      // Trash for 30 days (server soft-deletes by default), and its
      // entire subtree comes back together on restore.
      setConfirmState({
        open: true,
        title: 'Delete folder?',
        description: (
          <>
            <span className="font-medium text-foreground">{name}</span>{' '}
            and everything inside will be moved to Trash. Items can be
            recovered for 30 days before being permanently deleted.
          </>
        ),
        confirmLabel: 'Delete',
        variant: 'destructive',
        onConfirm: async () => {
          setConfirmState((s) => ({ ...s, busy: true }))
          try {
            const res = await apiFetch(`/api/folders/${folderId}`, {
              method: 'DELETE',
            })
            if (!res.ok) {
              const err = await res.json().catch(() => ({}))
              throw new Error(err.error || 'Failed to delete folder')
            }
            // 1.2.1+: refresh the AdminHeader Trash badge — the
            // count endpoint handles both soft-delete (folder
            // moved to Trash) and the empty-folder short-circuit
            // (folder hard-deleted, count unchanged) correctly.
            window.dispatchEvent(new CustomEvent('trash:changed'))
            // Refresh both sources so the grid drops the deleted
            // folder immediately, no page reload needed (1.0.8+).
            await fetchFolders({ silent: true })
            onMutated?.()
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete folder')
          } finally {
            setConfirmState({ open: false, title: '' })
          }
        },
      })
    },
    // `selectedVideoIds` and `selectedFolderIds` are state declared
    // above and safe to include. `videoGroups` / `clearSelection`
    // are declared lower and would hit JS's TDZ if listed — they're
    // read via closure inside the callback body, which only runs
    // after render completes. eslint-disable-next-line react-hooks/exhaustive-deps
    [folders, fetchFolders, onMutated, selectedVideoIds, selectedFolderIds],
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
        mediaType: latest.mediaType,
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

  // ─── multi-select + bulk actions (1.0.6+) ────────────────
  // Hoisted above the kebab handlers (1.0.9+) so the bulk-aware
  // Delete / Move-up flows can read the live selection.
  const handleToggleVideoSelect = useCallback((id: string) => {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 1.1.0+: parallel toggle for folder cards.
  const handleToggleFolderSelect = useCallback((id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedVideoIds(new Set())
    setSelectedFolderIds(new Set())
  }, [])

  // Combined selection size — drives the floating toolbar count, the
  // kebab bulk-label gating, and every bulk handler's "is this a
  // multi-select?" check (1.1.0+).
  const totalSelected = selectedVideoIds.size + selectedFolderIds.size

  // 1.1.0+: shared bulk-delete that handles both folders AND videos
  // in the current selection. Used by every kebab Delete trigger
  // (video card, folder card, floating selection toolbar) when the
  // combined selection is ≥ 2.
  const performBulkDelete = useCallback(() => {
    const count = totalSelected
    if (count < 2) return
    setConfirmState({
      open: true,
      title: `Delete ${count} items?`,
      description:
        'Deleted items can be recovered for 30 days before being permanently deleted. Folders cascade-delete their entire contents.',
      confirmLabel: 'Delete',
      variant: 'destructive',
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, busy: true }))
        setBulkBusy(true)
        try {
          // Videos first (their groups expand to allIds), then folders
          // (one DELETE per folder — server cascades soft-delete).
          for (const cardId of selectedVideoIds) {
            const grp = videoGroups.find((g) => g.allIds.includes(cardId))
            const ids = grp ? grp.allIds : [cardId]
            for (const id of ids) {
              await apiFetch(`/api/videos/${id}`, {
                method: 'DELETE',
              }).catch(() => null)
            }
          }
          for (const folderId of selectedFolderIds) {
            await apiFetch(`/api/folders/${folderId}`, {
              method: 'DELETE',
            }).catch(() => null)
          }
          // 1.2.1+: bump the AdminHeader Trash badge.
          window.dispatchEvent(new CustomEvent('trash:changed'))
          clearSelection()
          await fetchFolders({ silent: true })
          onMutated?.()
        } finally {
          setBulkBusy(false)
          setConfirmState({ open: false, title: '' })
        }
      },
    })
  }, [
    totalSelected,
    selectedVideoIds,
    selectedFolderIds,
    videoGroups,
    clearSelection,
    fetchFolders,
    onMutated,
  ])

  const handleDeleteVideo = useCallback(
    (videoId: string, videoName?: string) => {
      // 1.0.9+: bulk-aware. When the user has 2+ items selected and
      // clicks Delete from ANY card's kebab, we delete the whole
      // selection regardless of which card was clicked. 1.1.0+: the
      // selection can include folders too, so we route through the
      // shared `performBulkDelete`. With 0 or 1 selected we fall
      // back to the original single-card delete.
      if (totalSelected >= 2) {
        performBulkDelete()
        return
      }

      const group = videoGroups.find((g) => g.allIds.includes(videoId))
      const name = videoName ?? group?.name ?? 'this asset'
      // 1.0.8+: Frame.io-style ConfirmModal for delete. Soft-deletes
      // every version in the group; user can restore from Trash for
      // 30 days.
      setConfirmState({
        open: true,
        title: 'Delete asset?',
        description: (
          <>
            <span className="font-medium text-foreground">{name}</span>{' '}
            will be moved to Trash. You can recover it for 30 days
            before it&apos;s permanently deleted.
          </>
        ),
        confirmLabel: 'Delete',
        variant: 'destructive',
        onConfirm: async () => {
          setConfirmState((s) => ({ ...s, busy: true }))
          const idsToDelete = group ? group.allIds : [videoId]
          const realErrors: string[] = []
          for (const id of idsToDelete) {
            try {
              const res = await apiFetch(`/api/videos/${id}`, {
                method: 'DELETE',
              })
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
          // 1.2.1+: a video DELETE always lands in Trash, so the
          // count always moves — fire the event regardless of how
          // many versions were involved.
          window.dispatchEvent(new CustomEvent('trash:changed'))
          // Refresh BOTH sources (1.0.8+): the parent page (so any
          // outer state lines up) and our own folder/video listing
          // (so the deleted card disappears from the grid without a
          // page reload).
          await fetchFolders({ silent: true })
          onMutated?.()
          setConfirmState({ open: false, title: '' })
          if (realErrors.length > 0) {
            alert(`Failed to delete video: ${realErrors[0]}`)
          }
        },
      })
    },
    [
      onMutated,
      videoGroups,
      fetchFolders,
      totalSelected,
      performBulkDelete,
    ],
  )

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

  // 1.4.x+: structured single-folder download. Hits the new
  // /api/folders/[id]/download endpoint that streams a ZIP of the
  // whole tree with folder names + original filenames preserved.
  //
  // We can't use a plain anchor tag here — admin auth in this app
  // is Bearer-based (`Authorization: Bearer <admin-token>`), and
  // `<a href="...">` only carries cookies. The endpoint would 401
  // and the browser would save the JSON error body as
  // `download.json`. Instead we go through `apiFetch` which adds
  // the Bearer header, take the response as a Blob, and trigger the
  // anchor-tag download on a generated object URL. The filename
  // comes from the response's Content-Disposition header so a future
  // server rename (e.g. unicode folder names) doesn't need a client
  // change.
  const handleDownloadFolder = useCallback(async (folderId: string) => {
    setBulkBusy(true)
    try {
      const res = await apiFetch(`/api/folders/${folderId}/download`)
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const body = await res.json()
          if (body?.error) msg = body.error
        } catch {
          /* ignore parse errors */
        }
        alert(`Failed to download folder: ${msg}`)
        return
      }
      const blob = await res.blob()
      // Try to read filename from Content-Disposition; fall back to
      // a generic name. The server-side route quotes the filename,
      // so we strip the surrounding `"`.
      const cd = res.headers.get('content-disposition') || ''
      const match = cd.match(/filename\*?="?([^";]+)"?/i)
      const filename = match?.[1] || 'folder.zip'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Give Safari a tick to actually start the save before we
      // revoke; some engines flake if we revoke too early.
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    } finally {
      setBulkBusy(false)
    }
  }, [])

  const handleBulkDownload = useCallback(async () => {
    // 1.1.0+: bulk download spans both selected videos AND every
    // video found recursively inside each selected folder. We walk
    // sub-folders client-side via the existing `/api/folders/[id]`
    // endpoint (which returns this folder's direct videos +
    // sub-folder ids) and accumulate the unique latest-version ids.
    const ids = new Set<string>(selectedVideoIds)
    const visited = new Set<string>()
    const queue: string[] = Array.from(selectedFolderIds)
    while (queue.length > 0) {
      const fid = queue.shift()!
      if (visited.has(fid)) continue
      visited.add(fid)
      try {
        const res = await apiFetch(`/api/folders/${fid}`)
        if (!res.ok) continue
        const data = await res.json().catch(() => null)
        const folderPayload = data?.folder
        if (!folderPayload) continue
        // Videos: take only the LATEST version per (projectId, name)
        // — same grouping the grid uses on the card.
        const vids = Array.isArray(folderPayload.videos)
          ? (folderPayload.videos as Array<any>)
          : []
        const byName = new Map<string, any>()
        for (const v of vids) {
          const key = `${v.projectId}:${v.name}`
          const prev = byName.get(key)
          if (!prev || (v.version ?? 0) > (prev.version ?? 0)) {
            byName.set(key, v)
          }
        }
        for (const v of byName.values()) ids.add(v.id)
        // Recurse into sub-folders.
        const subs = Array.isArray(folderPayload.subfolders)
          ? (folderPayload.subfolders as Array<any>)
          : []
        for (const sf of subs) {
          if (sf?.id) queue.push(sf.id)
        }
      } catch {
        // Best-effort — skip folders we can't read.
      }
    }
    downloadVideos(Array.from(ids))
  }, [selectedVideoIds, selectedFolderIds, downloadVideos])

  const handleDownloadAll = useCallback(() => {
    const ids = videoGroups.map((g) => g.id)
    downloadVideos(ids)
  }, [videoGroups, downloadVideos])

  // Expose New Folder + Download All triggers to a parent page that
  // wants to render those actions in its own top toolbar (1.0.9+).
  // Pair with the `hideHeaderActions` prop to suppress the inline
  // buttons and avoid duplicating the UI.
  useImperativeHandle(
    ref,
    () => ({
      openNewFolderDialog: (restricted = false) => {
        setNewDialogRestricted(restricted)
        setShowNewDialog(true)
      },
      downloadAll: () => {
        handleDownloadAll()
      },
    }),
    [handleDownloadAll],
  )

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
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to stack videos')
      }
    },
    [onMutated, fetchFolders],
  )

  // Drag-video-onto-folder handler (1.0.7+). When the user drops a
  // video card onto a folder card, every version that belongs to the
  // same version group (same `name` in this folder) is reparented to
  // the target folder in one batch call so the move stays atomic. We
  // optimistically remove the local card immediately to avoid a
  // visible "double image" while the fetch resolves.
  //
  // 1.0.9+: bulk-aware. Finder / Frame.io semantics — if the dragged
  // card is *part of* a selection of 2+ cards, dropping it onto a
  // folder moves the ENTIRE selection in one batch call. Dragging a
  // card that isn't selected still moves just that card so users can
  // shuffle a single asset without losing their selection.
  const handleMoveVideoToFolder = useCallback(
    async (sourceVideoId: string, targetFolderId: string) => {
      if (!sourceVideoId || !targetFolderId) return
      // 1.1.0+: bulk drag with mixed selection. When the dragged
      // card is part of the selection AND the combined selection is
      // ≥ 2, every selected video AND every selected folder gets
      // moved into the target. Otherwise we ship only the dragged
      // video's group (selection stays untouched).
      const combinedSize = selectedVideoIds.size + selectedFolderIds.size
      const isBulk = combinedSize >= 2 && selectedVideoIds.has(sourceVideoId)
      const sourceCardIds = isBulk
        ? Array.from(selectedVideoIds)
        : [sourceVideoId]
      const idsToMove: string[] = []
      for (const cardId of sourceCardIds) {
        const grp = videoGroups.find((g) => g.allIds.includes(cardId))
        if (grp) idsToMove.push(...grp.allIds)
        else idsToMove.push(cardId)
      }
      try {
        if (idsToMove.length > 0) {
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
        }
        if (isBulk && selectedFolderIds.size > 0) {
          for (const fid of selectedFolderIds) {
            // Skip nesting a folder into itself.
            if (fid === targetFolderId) continue
            await apiFetch(`/api/folders/${fid}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parentFolderId: targetFolderId }),
            }).catch(() => null)
          }
        }
        if (isBulk) clearSelection()
        // 1.0.8+: refresh BOTH the parent page state and this
        // FolderBrowser's own state. At the project root the videos
        // live in our local `rootVideos`; relying on `onMutated`
        // alone leaves the card visible until the user reloads.
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move video')
      }
    },
    [
      videoGroups,
      onMutated,
      fetchFolders,
      selectedVideoIds,
      selectedFolderIds,
      clearSelection,
    ],
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
  //
  // 1.0.9+: bulk-aware. When 2+ videos are selected we move EVERY
  // selected video's version group up one level in a single batch
  // call, irrespective of which card's kebab was clicked.
  const handleMoveVideoUp = useCallback(
    async (videoId: string) => {
      if (!canMoveUp) return
      // 1.1.0+: bulk-aware over BOTH videos AND folders. When the
      // combined selection is ≥ 2, move every selected video group
      // AND every selected folder up one level. With 0–1 selected
      // we fall back to moving just the kebab's video.
      const combinedSize = selectedVideoIds.size + selectedFolderIds.size
      const isBulk = combinedSize >= 2
      const sourceIds = isBulk
        ? Array.from(selectedVideoIds)
        : [videoId]
      const idsToMove: string[] = []
      for (const cardId of sourceIds) {
        const group = videoGroups.find((g) => g.allIds.includes(cardId))
        if (group) idsToMove.push(...group.allIds)
        else idsToMove.push(cardId)
      }
      try {
        if (idsToMove.length > 0) {
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
        }
        if (isBulk && selectedFolderIds.size > 0) {
          for (const fid of selectedFolderIds) {
            await apiFetch(`/api/folders/${fid}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parentFolderId }),
            }).catch(() => null)
          }
        }
        if (isBulk) clearSelection()
        await fetchFolders({ silent: true })
        onMutated?.()
        // 1.4.x+: invalidate Next.js App Router cache. Without this the
        // user could navigate UP to the parent folder and see a stale
        // page that still reflects the pre-move state — notably, the
        // parent's subfolders list wouldn't include the folder we just
        // emptied (visible as "Test 2 disappeared after Move Up" in
        // the bug report). router.refresh() forces a server re-render
        // on the next nav so the parent gets fresh subfolders +
        // videos data.
        router.refresh()
        // Same data-shape change concerns ANY sibling FolderBrowser
        // listening for this event (rare but possible if the page
        // embeds multiple instances).
        window.dispatchEvent(new CustomEvent('framecomment:folders-changed'))
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move video')
      }
    },
    [
      canMoveUp,
      parentFolderId,
      videoGroups,
      onMutated,
      fetchFolders,
      selectedVideoIds,
      selectedFolderIds,
      clearSelection,
      router,
    ],
  )

  // Per-video share handler (1.0.7+). For now we surface the same
  // project share URL but with `?video=NAME` (and `&folderId` when
  // applicable) so the link opens the public player straight on this
  // video. Copies to clipboard and shows a small confirmation.
  const handleShareVideo = useCallback(
    async (_videoId: string, videoName: string) => {
      if (typeof window === 'undefined') return
      // 1.4.x+: pre-load the project's current shareExpiresAt so the
      // modal can seed its toggle. Per-video links go through the
      // project's share-token gate, so expiration lives on the
      // project. Best-effort — fall back to "no expiration" UI on any
      // failure.
      let initialExpiresAt: string | null = null
      try {
        const meta = await apiFetch(`/api/projects/${projectId}`)
        if (meta.ok) {
          const data = await meta.json()
          const raw =
            data?.project?.shareExpiresAt ?? data?.shareExpiresAt ?? null
          if (raw) {
            initialExpiresAt =
              typeof raw === 'string' ? raw : new Date(raw).toISOString()
          }
        }
      } catch {
        /* best-effort */
      }
      // 1.2.0+: ask the server for an HMAC-signed URL that scopes the
      // share to this one video. Server-side filters lock the response
      // to this video name so a reviewer opening the link can't see
      // siblings via the thumbnail reel. We fall back to the legacy
      // unsigned URL if the request fails (e.g. SHARE_TOKEN_SECRET
      // not configured) — better to share something than nothing.
      try {
        const res = await apiFetch('/api/share-video-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            videoName,
            folderId: currentFolderId || undefined,
          }),
        })
        if (res.ok) {
          const data = await res.json()
          if (data?.url) {
            setShareState({
              open: true,
              title: videoName,
              shareUrl: data.url,
              kind: 'project',
              targetId: projectId,
              initialExpiresAt,
            })
            return
          }
        }
      } catch {
        /* fall through to unsigned URL */
      }
      const origin = window.location.origin
      const params = new URLSearchParams({ video: videoName })
      if (currentFolderId) params.set('folderId', currentFolderId)
      const url = `${origin}/share/${_projectSlug}?${params.toString()}`
      setShareState({
        open: true,
        title: videoName,
        shareUrl: url,
        kind: 'project',
        targetId: projectId,
        initialExpiresAt,
      })
    },
    [_projectSlug, currentFolderId, projectId],
  )

  // Split-versions handler (1.0.8+). Opens the modal seeded with
  // every version row in the group the user clicked. The actual
  // split is performed by `/api/videos/split` once the user submits.
  const handleSplitVersions = useCallback(
    (videoId: string, groupName: string) => {
      const group = videoGroups.find((g) => g.allIds.includes(videoId))
      if (!group) return
      // We need full per-version detail (thumbnail, originalFileName,
      // versionLabel, createdAt). Both root and folder paths feed
      // the same raw rows into `videos` / `rootVideos`, so we look
      // up by `id`.
      const source = videos.length > 0 ? videos : rootVideos
      const rows: SplitVersionRow[] = group.allIds
        .map((id) => source.find((v) => v.id === id))
        .filter((v): v is VideoRow => !!v)
        .sort((a, b) => b.version - a.version)
        .map((v) => ({
          id: v.id,
          version: v.version,
          versionLabel: v.versionLabel,
          originalFileName: v.originalFileName,
          thumbnailUrl: v.thumbnailUrl,
          createdAt: v.createdAt,
        }))
      if (rows.length === 0) return
      setSplitState({ open: true, groupName, versions: rows })
    },
    [videoGroups, videos, rootVideos],
  )

  const submitSplit = useCallback(
    async (selectedIds: string[]) => {
      if (selectedIds.length === 0) return
      try {
        const res = await apiFetch('/api/videos/split', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoIds: selectedIds }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to split versions')
        }
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to split versions')
      }
    },
    [fetchFolders, onMutated],
  )

  // Folder move-up handler (1.0.7+). Mirrors the video flow but
  // re-parents a folder via PATCH /api/folders/[id]. The server
  // already detects cycles, so we don't have to verify here.
  const handleMoveFolderUp = useCallback(
    async (folderId: string) => {
      if (!canMoveUp) return
      // 1.1.0+: bulk-aware. When 2+ items are selected, move every
      // selected folder + every selected video group up one level in
      // one pass. The folder PATCHes go one at a time (no batch
      // endpoint exists yet); video versions reuse the existing
      // `/api/videos/batch`.
      const combinedSize = selectedVideoIds.size + selectedFolderIds.size
      const isBulk = combinedSize >= 2
      const folderIdsToMove = isBulk
        ? Array.from(selectedFolderIds)
        : [folderId]
      try {
        for (const fid of folderIdsToMove) {
          await apiFetch(`/api/folders/${fid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentFolderId }),
          }).catch(() => null)
        }
        if (isBulk && selectedVideoIds.size > 0) {
          const videoIdsToMove: string[] = []
          for (const cardId of selectedVideoIds) {
            const grp = videoGroups.find((g) => g.allIds.includes(cardId))
            if (grp) videoIdsToMove.push(...grp.allIds)
            else videoIdsToMove.push(cardId)
          }
          if (videoIdsToMove.length > 0) {
            await apiFetch('/api/videos/batch', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                videoIds: videoIdsToMove,
                folderId: parentFolderId,
              }),
            }).catch(() => null)
          }
        }
        if (isBulk) clearSelection()
        await fetchFolders({ silent: true })
        onMutated?.()
        // 1.4.x+: see handleMoveVideoUp for the same router.refresh()
        // rationale — Next.js App Router cache would otherwise let
        // the parent folder render stale subfolder data after a
        // Move Up.
        router.refresh()
        window.dispatchEvent(new CustomEvent('framecomment:folders-changed'))
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to move folder')
      }
    },
    // `videoGroups` / `clearSelection` are below in the component;
    // we read them via closure at click time. See `handleDelete`
    // for the same TDZ workaround. eslint-disable-next-line react-hooks/exhaustive-deps
    [canMoveUp, parentFolderId, fetchFolders, onMutated, selectedVideoIds, selectedFolderIds, router],
  )

  // "New Folder with Selection" (1.0.9+). Creates a folder named
  // "New Folder" (with a "(2)", "(3)" suffix when there's already a
  // sibling by that name), moves every selected video's version
  // group into it via the batch endpoint, then marks the new folder
  // for inline auto-rename so the user can immediately type a real
  // name.
  const handleNewFolderWithSelection = useCallback(async () => {
    // 1.1.0+: accepts mixed selection — at least one video OR one
    // folder selected triggers the flow.
    if (selectedVideoIds.size + selectedFolderIds.size === 0) return
    // Pick a unique default name so two consecutive presses don't
    // produce two "New Folder" siblings.
    const existingNames = new Set(folders.map((f) => f.name))
    const base = 'New Folder'
    let candidate = base
    let suffix = 2
    while (existingNames.has(candidate)) {
      candidate = `${base} (${suffix})`
      suffix += 1
      if (suffix > 999) break // sanity
    }

    setBulkBusy(true)
    try {
      // 1. Create the folder at the current location.
      const createRes = await apiFetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          parentFolderId: currentFolderId,
          name: candidate,
        }),
      })
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to create folder')
      }
      const created = await createRes.json().catch(() => null)
      if (!created?.id) throw new Error('Folder created without id')

      // 2. Batch-move every version of every selected video card.
      const idsToMove: string[] = []
      for (const cardId of selectedVideoIds) {
        const group = videoGroups.find((g) => g.allIds.includes(cardId))
        if (group) idsToMove.push(...group.allIds)
        else idsToMove.push(cardId)
      }
      if (idsToMove.length > 0) {
        const moveRes = await apiFetch('/api/videos/batch', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoIds: idsToMove,
            folderId: created.id,
          }),
        })
        if (!moveRes.ok) {
          const err = await moveRes.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to move videos into folder')
        }
      }

      // 2b. 1.1.0+: also re-parent every selected folder into the
      //     new folder so the bulk selection genuinely "wraps" both
      //     kinds of items.
      for (const fid of selectedFolderIds) {
        // Don't try to nest the freshly-created folder into itself.
        if (fid === created.id) continue
        await apiFetch(`/api/folders/${fid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentFolderId: created.id }),
        }).catch(() => null)
      }

      // 3. Mark this folder for inline auto-rename. The FolderCard
      //    consumes the prop on mount, focuses + selects the name,
      //    and calls back once the edit finishes.
      setPendingAutoEditFolderId(created.id)
      clearSelection()
      await fetchFolders({ silent: true })
      onMutated?.()
    } catch (err) {
      alert(
        err instanceof Error
          ? err.message
          : 'Failed to create folder with selection',
      )
    } finally {
      setBulkBusy(false)
    }
  }, [
    selectedVideoIds,
    folders,
    projectId,
    currentFolderId,
    videoGroups,
    clearSelection,
    fetchFolders,
    onMutated,
  ])

  // 1.1.0+: Duplicate. Mirrors the FolderBrowser-level bulk-aware
  // pattern — when the combined selection is ≥ 1, duplicate every
  // selected video group + folder via the server endpoint (which
  // performs a REAL file copy in storage, not just a DB clone) into
  // the current folder. Falls back to duplicating the single card
  // whose kebab was clicked when nothing is selected.
  const handleDuplicate = useCallback(
    async (singleCardId?: string, singleKind?: 'video' | 'folder') => {
      const combinedSize = selectedVideoIds.size + selectedFolderIds.size
      const isBulk = combinedSize >= 1
      const videoCardIds = isBulk
        ? Array.from(selectedVideoIds)
        : singleKind === 'video' && singleCardId
          ? [singleCardId]
          : []
      const folderIdsArr = isBulk
        ? Array.from(selectedFolderIds)
        : singleKind === 'folder' && singleCardId
          ? [singleCardId]
          : []
      if (videoCardIds.length === 0 && folderIdsArr.length === 0) return
      setBulkBusy(true)
      try {
        const res = await apiFetch('/api/items/duplicate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            targetFolderId: currentFolderId,
            videoCardIds,
            folderIds: folderIdsArr,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to duplicate items')
        }
        if (isBulk) clearSelection()
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to duplicate items')
      } finally {
        setBulkBusy(false)
      }
    },
    [
      selectedVideoIds,
      selectedFolderIds,
      projectId,
      currentFolderId,
      clearSelection,
      fetchFolders,
      onMutated,
    ],
  )

  // Commit handler for the inline folder rename (1.0.9+). PATCHes
  // /api/folders/[id] then re-fetches so the grid resorts.
  const handleFolderRenameCommit = useCallback(
    async (folderId: string, newName: string) => {
      const trimmed = newName.trim()
      if (!trimmed) return
      try {
        const res = await apiFetch(`/api/folders/${folderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to rename folder')
        }
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to rename folder')
      }
    },
    [fetchFolders, onMutated],
  )

  const handleBulkDelete = useCallback(() => {
    const combined = selectedVideoIds.size + selectedFolderIds.size
    if (combined === 0) return
    const count = combined
    // 1.0.8+: Frame.io-style ConfirmModal. 1.1.0+: includes folders
    // in the bulk-delete loop — selected folders cascade-soft-delete
    // their entire subtree on the server.
    setConfirmState({
      open: true,
      title: count === 1 ? 'Delete item?' : `Delete ${count} items?`,
      description:
        'Deleted items can be recovered for 30 days before being permanently deleted. Folders cascade-delete their entire contents.',
      confirmLabel: 'Delete',
      variant: 'destructive',
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, busy: true }))
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
          for (const fid of selectedFolderIds) {
            await apiFetch(`/api/folders/${fid}`, { method: 'DELETE' }).catch(
              () => null,
            )
          }
          // 1.2.1+: nudge the AdminHeader Trash badge.
          window.dispatchEvent(new CustomEvent('trash:changed'))
          clearSelection()
          // Same dual refresh as the single-delete path (1.0.8+).
          await fetchFolders({ silent: true })
          onMutated?.()
        } finally {
          setBulkBusy(false)
          setConfirmState({ open: false, title: '' })
        }
      },
    })
  }, [selectedVideoIds, selectedFolderIds, videoGroups, onMutated, clearSelection, fetchFolders])

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
    if (target && target.closest('[role="menu"]')) return
    // 1.0.9+ / 1.1.0+: right-clicking a video OR folder card auto-
    // selects it so the context menu immediately exposes the bulk
    // actions (Download, Move up, New Folder with selection, Delete)
    // for that asset — no need to tick the checkbox first. Finder-
    // style semantics: right-clicking a card that's NOT part of the
    // current selection replaces the selection with just that card;
    // right-clicking one that's already selected leaves the
    // selection untouched so a multi-select right-click still acts
    // on the whole batch.
    const videoCard = target?.closest('[data-video-id]') as
      | HTMLElement
      | null
    const folderCard = target?.closest('[data-folder-id]') as
      | HTMLElement
      | null
    if (videoCard) {
      const vid = videoCard.getAttribute('data-video-id')
      if (vid) {
        // Drop any folder selection — right-click on a video isolates
        // it (unless it was already in the selection).
        if (!selectedVideoIds.has(vid)) {
          setSelectedVideoIds(new Set([vid]))
          setSelectedFolderIds(new Set())
        }
      }
    } else if (folderCard) {
      const fid = folderCard.getAttribute('data-folder-id')
      if (fid) {
        if (!selectedFolderIds.has(fid)) {
          setSelectedFolderIds(new Set([fid]))
          setSelectedVideoIds(new Set())
        }
      }
    }
    e.preventDefault()
    setCtxMenu({ open: true, x: e.clientX, y: e.clientY })
  }

  // 1.1.0+: clicking "empty space" — anywhere that isn't a video
  // card, a folder card, the floating selection toolbar, or a
  // menu/dialog surface — clears the current multi-select. Mirrors
  // Finder / Frame.io: click off the items and the selection drops.
  // Video cards are excluded because their own onClick toggles
  // selection; folder cards because clicking one navigates away.
  const handleContainerClick = (e: React.MouseEvent) => {
    // 1.1.0+: also clear folder-only selections. The original check
    // looked at `selectedVideoIds.size` only, so a folder-only
    // selection would never be cleared by clicking empty space.
    if (selectedVideoIds.size + selectedFolderIds.size === 0) return
    const target = e.target as HTMLElement | null
    if (!target) return
    if (
      target.closest('[data-video-id]') ||
      target.closest('[data-folder-id]') ||
      target.closest('[data-selection-toolbar]') ||
      target.closest('[role="menu"]') ||
      target.closest('[role="dialog"]')
    ) {
      return
    }
    clearSelection()
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
      onClick={handleContainerClick}
      onContextMenu={handleContextMenu}
      onDragOver={containerDragOver}
      onDragLeave={containerDragLeave}
      onDrop={containerDrop}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {breadcrumbRendered}
        {!hideHeaderActions && (
          <div className="flex items-center gap-2">
            {/* Download All — only useful inside a folder that has
                videos. Sequential download of the latest version per
                video name (matches what the user sees on the cards).
                1.0.9+: the parent page can hoist these into its own
                top bar via `hideHeaderActions` + the imperative ref. */}
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
        )}
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
          className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed py-10 sm:py-20 px-4 sm:px-6 text-center min-h-[280px] sm:min-h-[400px] transition-colors ${
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
      {totalSelected > 0 && (
        <div
          data-selection-toolbar
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full bg-popover text-popover-foreground border border-border shadow-2xl pl-2 pr-2 py-1.5"
        >
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
            {totalSelected}{' '}
            {totalSelected === 1 ? 'item' : 'items'} selected
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
        accept="video/*,image/jpeg,image/png,image/webp,image/gif"
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
        // 1.3.0+: start at 2 columns on phones (used to be 1) so the
        // cards don't fill the entire screen each. 2 fits a 360-414px
        // viewport comfortably; we step up to 3 → 4 → 5 → 6 on bigger
        // viewports.
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3 sm:gap-4">
          {folders.map((f) => (
            <FolderCard
              key={`folder:${f.id}`}
              id={f.id}
              name={f.name}
              itemCount={f.itemCount}
              totalSize={(f as any).totalSize}
              slug={f.slug}
              previewItems={f.previewItems}
              onOpen={handleOpenFolder}
              onRename={handleRename}
              onShare={handleShare}
              onDelete={handleDelete}
              onMoveUp={canMoveUp ? handleMoveFolderUp : undefined}
              autoEditOnMount={pendingAutoEditFolderId === f.id}
              onRenameCommit={handleFolderRenameCommit}
              onAutoEditDone={(folderId) => {
                setPendingAutoEditFolderId((cur) =>
                  cur === folderId ? null : cur,
                )
              }}
              onDragStart={(id) => setDraggingFolderId(id)}
              onDragEnd={() => setDraggingFolderId(null)}
              onDropFolder={handleDropOnFolder}
              onDropVideo={handleMoveVideoToFolder}
              isBeingDragged={draggingFolderId === f.id}
              isPotentialDropTarget={
                draggingFolderId !== null && draggingFolderId !== f.id
              }
              isPotentialVideoDropTarget={draggingVideoId !== null}
              // 1.1.0+: multi-select parity with VideoCard.
              isSelected={selectedFolderIds.has(f.id)}
              onToggleSelect={handleToggleFolderSelect}
              selectionMode={totalSelected > 0}
              bulkSelectionCount={totalSelected}
              onBulkDownload={handleBulkDownload}
              onNewFolderWithSelection={handleNewFolderWithSelection}
              onDuplicate={(fid) => void handleDuplicate(fid, 'folder')}
              onDownloadFolder={handleDownloadFolder}
            />
          ))}
          {(() => {
            // 1.0.9+: when the user drags a card that's part of a
            // selection of 2+, every selected card "comes along" —
            // they all ghost together so the user sees they're
            // moving the whole batch. Compute the active flag once
            // per render so the JSX below stays readable.
            const dragMovesSelection =
              draggingVideoId !== null &&
              selectedVideoIds.size >= 2 &&
              selectedVideoIds.has(draggingVideoId)
            // Thumbnails of every selected card — fed to VideoCard
            // so its onDragStart can paint a Frame.io-style stacked
            // drag image at the cursor (1.0.9+). The dragged card's
            // own thumbnail is included since it's selected; we
            // just supply the same array to every selected card.
            const bulkDragThumbs = videoGroups
              .filter((g) => selectedVideoIds.has(g.id))
              .map((g) => g.thumbnailUrl || '')
              .filter((u) => !!u)
            return videoGroups.map((v) => {
              const isSourceCard = draggingVideoId === v.id
              const isBulkBuddy =
                dragMovesSelection && selectedVideoIds.has(v.id)
              return (
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
              selectionMode={totalSelected > 0}
              onStartVideoDrag={(id) => setDraggingVideoId(id)}
              onEndVideoDrag={() => setDraggingVideoId(null)}
              onStackOnto={handleStackVideos}
              // 1.0.9+: ghost all selected siblings while one of them
              // is being dragged, not just the source card. Visually
              // mirrors Finder / Frame.io batch drags.
              isBeingDragged={isSourceCard || isBulkBuddy}
              isPotentialStackTarget={
                draggingVideoId !== null &&
                draggingVideoId !== v.id &&
                !isBulkBuddy
              }
              onOpen={handleOpenVideo}
              onRename={handleRenameVideo}
              onDelete={handleDeleteVideo}
              onMoveUp={canMoveUp ? handleMoveVideoUp : undefined}
              onShare={handleShareVideo}
              onSplitVersions={handleSplitVersions}
              bulkSelectionCount={totalSelected}
              onNewFolderWithSelection={handleNewFolderWithSelection}
              bulkDragThumbnails={bulkDragThumbs}
              mediaType={v.mediaType}
              onDownload={(vid) => {
                // Single-card download from the kebab. When bulk is
                // active the parent's `handleBulkDownload` covers the
                // selection; otherwise just grab this single id.
                if (totalSelected >= 2) {
                  void handleBulkDownload()
                } else {
                  void downloadVideos([vid])
                }
              }}
              onDuplicate={(vid) => void handleDuplicate(vid, 'video')}
            />
              )
            })
          })()}
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
        // 1.0.9+ / 1.1.0+: surface the same bulk actions that live
        // in the video/folder kebabs when there's an active selection.
        // The count reflects the COMBINED selection (videos +
        // folders).
        bulkSelectionCount={totalSelected}
        canBulkMoveUp={canMoveUp}
        onBulkMoveUp={() => {
          // Both handleMoveVideoUp and handleMoveFolderUp now check
          // the combined selection and bulk-act on it. Route through
          // whichever kind has a "first id" handy.
          const firstVideo = selectedVideoIds.values().next().value as
            | string
            | undefined
          const firstFolder = selectedFolderIds.values().next().value as
            | string
            | undefined
          if (firstVideo) void handleMoveVideoUp(firstVideo)
          else if (firstFolder) void handleMoveFolderUp(firstFolder)
        }}
        onBulkNewFolderWithSelection={() => {
          void handleNewFolderWithSelection()
        }}
        onBulkDownload={() => {
          void handleBulkDownload()
        }}
        onBulkDelete={() => {
          // Either handler short-circuits to the combined bulk path
          // when total selection ≥ 2; we just need to call one.
          const firstVideo = selectedVideoIds.values().next().value as
            | string
            | undefined
          const firstFolder = selectedFolderIds.values().next().value as
            | string
            | undefined
          if (firstVideo) handleDeleteVideo(firstVideo)
          else if (firstFolder) handleDelete(firstFolder)
        }}
        onBulkShare={() => {
          // Single-target only (gated upstream). Route to the right
          // share handler depending on what's selected.
          const firstVideo = selectedVideoIds.values().next().value as
            | string
            | undefined
          const firstFolder = selectedFolderIds.values().next().value as
            | string
            | undefined
          if (firstVideo) {
            const grp = videoGroups.find((g) => g.allIds.includes(firstVideo))
            void handleShareVideo(firstVideo, grp?.name ?? '')
          } else if (firstFolder) {
            void handleShare(firstFolder)
          }
        }}
        onBulkRename={() => {
          const firstVideo = selectedVideoIds.values().next().value as
            | string
            | undefined
          const firstFolder = selectedFolderIds.values().next().value as
            | string
            | undefined
          if (firstVideo) {
            const grp = videoGroups.find((g) => g.allIds.includes(firstVideo))
            void handleRenameVideo(firstVideo, grp?.name ?? '')
          } else if (firstFolder) {
            void handleRename(firstFolder)
          }
        }}
        onBulkDuplicate={() => {
          // handleDuplicate already reads the combined selection when
          // size >= 1, so the kind/id hints are only used at exactly
          // 0 selected (which shouldn't reach here anyway).
          void handleDuplicate()
        }}
      />

      {/* Frame.io-style confirmation + share dialogs (1.0.8+). One
          instance each covers Delete (single + bulk + folder) and
          Share (video + folder). */}
      <ConfirmModal
        open={confirmState.open}
        onOpenChange={(next) =>
          setConfirmState((s) => ({ ...s, open: next }))
        }
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel={confirmState.confirmLabel}
        variant={confirmState.variant}
        busy={confirmState.busy}
        onConfirm={async () => {
          await confirmState.onConfirm?.()
        }}
        onCancel={() => setConfirmState({ open: false, title: '' })}
      />
      <ShareModal
        open={shareState.open}
        onOpenChange={(next) =>
          setShareState((s) => ({ ...s, open: next }))
        }
        title={shareState.title}
        shareUrl={shareState.shareUrl}
        initialExpiresAt={shareState.initialExpiresAt}
        onSaveExpiration={async (next) => {
          if (!shareState.targetId) return
          const url =
            shareState.kind === 'folder'
              ? `/api/folders/${shareState.targetId}`
              : `/api/projects/${shareState.targetId}`
          try {
            const res = await apiFetch(url, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ shareExpiresAt: next }),
            })
            if (!res.ok) {
              const err = await res.json().catch(() => ({}))
              alert(err.error || 'Failed to save expiration')
            }
          } catch (err) {
            alert(
              err instanceof Error
                ? err.message
                : 'Failed to save expiration',
            )
          }
        }}
      />
      <SplitVersionsModal
        open={splitState.open}
        onOpenChange={(next) =>
          setSplitState((s) => ({ ...s, open: next }))
        }
        groupName={splitState.groupName}
        versions={splitState.versions}
        onSubmit={submitSplit}
      />
    </div>
  )
}

const FolderBrowser = forwardRef<FolderBrowserHandle, FolderBrowserProps>(
  FolderBrowserInner,
)
FolderBrowser.displayName = 'FolderBrowser'
export default FolderBrowser
