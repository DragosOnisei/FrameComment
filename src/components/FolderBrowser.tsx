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
import { useDownloadManager } from '@/contexts/DownloadManager'
import { getPublicShareOrigin } from '@/lib/public-share-origin'
import { formatBytes } from '@/lib/project-gradient'
import FolderCard from './FolderCard'
import VideoCard from './VideoCard'
import NewFolderDialog from './NewFolderDialog'
import FolderContextMenu from './FolderContextMenu'
import { ConfirmModal } from './ConfirmModal'
import { ShareModal } from './ShareModal'
import { RenameDialog } from './ui/rename-dialog'
import { SplitVersionsModal, type SplitVersionRow } from './SplitVersionsModal'
import QuickPreviewOverlay, { type QuickPreviewTarget } from './QuickPreviewOverlay'
import FolderBrowserTable from './FolderBrowserTable'
import { useAdminSortMode } from '@/lib/use-admin-sort-mode'
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
   *  into the current folder. 1.7.1+: receives an optional
   *  `extras.directoryPaths` listing every directory the walker saw,
   *  including empty ones, so the parent can mint matching folders
   *  even when no media file is inside. */
  onUploadFolderTree?: (
    entries: FileTreeEntry[],
    extras?: { directoryPaths?: string[] },
  ) => void
  /** Hide the inline Download-All / New-Folder buttons that sit next
   *  to the breadcrumb (1.0.9+). Use this when the parent page wants
   *  to render those actions in its own top bar and drive them
   *  through the imperative ref handle below. */
  hideHeaderActions?: boolean
  /** 1.7.0+: switch between the Frame.io-style card grid (default)
   *  and a compact table layout with Name / Type / Duration / Size
   *  columns. The parent page owns the toggle UI + persistence so
   *  FolderBrowser stays presentational. */
  viewMode?: 'grid' | 'table'
}

/**
 * Imperative handle (1.0.9+). Lets a parent page drive the New-Folder
 * dialog and Download-All flow from buttons it renders outside the
 * FolderBrowser (e.g. a unified top action bar). Pair with
 * `hideHeaderActions` to avoid duplicate UI.
 */
// 3.5.x: guard against accidental gigantic downloads. Clicking
// "Download All" at a project root (e.g. VDA holds ~2 TB) would
// otherwise kick off a massive transfer with no warning. When the
// total of what's about to be downloaded exceeds this threshold we
// pop a confirmation first. 10 GiB.
const LARGE_DOWNLOAD_THRESHOLD = 10 * 1024 * 1024 * 1024

// Sizes arrive as string | number | bigint | null from the API
// (Prisma BigInt → string). Coerce to a plain number of bytes for
// summing; anything unparseable counts as 0 so it never blocks.
function coerceBytes(
  v: string | number | bigint | null | undefined,
): number {
  if (v == null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'bigint') return Number(v)
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

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
    | {
        kind: 'video'
        videoId: string
        thumbnailUrl: string
        storyboardUrl?: string
      }
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
  /** Stringified byte size of this version's source file (the folder
   *  API serialises the BigInt to a string). Drives the List view's
   *  Size column. */
  originalFileSize?: string | number | null
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
  /** TUS upload progress 0..100 for the latest version (status =
   *  UPLOADING). Drives the thin bar on the card's bottom edge. */
  uploadProgress?: number | null
  /** Worker transcode progress 0..100 for the latest version
   *  (status = PROCESSING). Drives the same bar. */
  processingProgress?: number | null
  /** Sum of comments across every version in the group. */
  commentCount: number
  /** "uploader" = createdBy of the latest version. */
  uploaderName?: string | null
  /** ISO timestamp of the latest version's upload. */
  createdAt?: string | Date
  /** 1.0.9+: media type of the latest version. */
  mediaType?: 'VIDEO' | 'IMAGE'
  /** Byte size of the latest version's source file — List view Size. */
  originalFileSize?: string | number | null
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
    viewMode = 'grid',
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
  // 2.2.6+: optimistic drop placeholders. The moment a user drops
  // files into the grid we push synthetic "uploading" cards here
  // so the grid reflects the action instantly — pre-2.2.6 the user
  // saw nothing until TUS uploaded a few % AND the server polled
  // the new row, which on multi-GB files felt frozen. Each
  // placeholder is matched against incoming `videoGroups` by
  // normalised filename → as soon as the real row lands we drop
  // the placeholder (the real card already has the bottom progress
  // bar via ProcessingStatusContext, so the swap is visually
  // continuous). Safety net: placeholders auto-expire after 90s in
  // case server creation fails silently — wouldn't want a ghost
  // card stuck on screen forever.
  const [pendingDropPlaceholders, setPendingDropPlaceholders] = useState<
    Array<{ localId: string; fileName: string; folderId: string; droppedAt: number }>
  >([])
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
  // 1.7.0+: macOS Quick Look-style preview. When non-null, the
  // QuickPreviewOverlay is open with the embedded video/folder.
  // Triggered by Space while exactly one item is selected.
  const [quickPreview, setQuickPreview] = useState<QuickPreviewTarget>(null)
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

  // 2.2.6+: helper used by every drop-into-current-folder path
  // (empty-state, populated-grid container, breadcrumb home drop).
  // Pushed in front of the actual `onUploadFiles` call so the
  // synthetic cards render the same instant the browser fires
  // `drop`.
  const addPendingDropPlaceholders = useCallback(
    (files: File[]) => {
      if (!currentFolderId || !files.length) return
      const droppedAt = Date.now()
      const additions = files.map((f, i) => ({
        // crypto.randomUUID exists in every browser supported by
        // Next.js 16 — guarded just in case for older test runners.
        localId: `pending:${droppedAt}:${i}:${
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? (crypto as any).randomUUID()
            : Math.random().toString(36).slice(2)
        }`,
        fileName: f.name || `Untitled-${i + 1}`,
        folderId: currentFolderId,
        droppedAt,
      }))
      setPendingDropPlaceholders((prev) => [...additions, ...prev])
    },
    [currentFolderId],
  )

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

  // 3.8.x: folder-structure templates (right-click menu). Creates a set
  // of public sub-folders inside the CURRENT folder in one shot, then
  // refreshes once. Best-effort per name so one failure doesn't abort
  // the rest.
  const handleCreateTemplate = useCallback(
    async (names: string[]) => {
      for (const name of names) {
        try {
          await apiFetch('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              parentFolderId: currentFolderId,
              name,
            }),
          })
        } catch {
          /* keep going with the remaining folders */
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

  // 2.0.x+: themed rename dialog (RenameDialog) replaces the native
  // window.prompt(). State drives a controlled <RenameDialog />
  // rendered at the bottom of the component; the kebab handler
  // (`handleRename`) just sets the target folderId + opens it.
  const [renameTarget, setRenameTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  // 3.8.x: same themed dialog for VIDEO rename (was a native
  // window.prompt). Separate target so it can't collide with folder rename.
  const [renameVideoTarget, setRenameVideoTarget] = useState<{
    id: string
    name: string
  } | null>(null)

  const handleRename = useCallback(
    (folderId: string) => {
      const current = folders.find((f) => f.id === folderId)
      setRenameTarget({ id: folderId, name: current?.name || '' })
    },
    [folders],
  )

  const handleRenameSubmit = useCallback(
    async (next: string) => {
      if (!renameTarget) return
      try {
        const res = await apiFetch(`/api/folders/${renameTarget.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: next }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to rename folder')
        }
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        // Surface to the user — keep the dialog open by returning
        // false so they can fix the name and try again.
        alert(err instanceof Error ? err.message : 'Failed to rename folder')
        return false
      }
    },
    [renameTarget, fetchFolders, onMutated],
  )

  const handleShare = useCallback(
    async (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId)
      if (!folder) return
      // 1.6.1: mint against the public origin (admin's appDomain
      // when configured) so editors on the LAN don't accidentally
      // copy a 192.168.x.x link out to clients.
      const url = `${getPublicShareOrigin()}/share/folder/${folder.slug}`
      // 3.8.x PERF: open the modal INSTANTLY. The long folder URL is
      // already known from the in-memory folder (its slug), so there's
      // nothing to wait for. We used to `await` a GET on
      // /api/folders/[id] here purely to read `shareExpiresAt` for the
      // expiration toggle — but that endpoint mints preview tokens for
      // every item in the folder and can take several seconds, during
      // which the modal didn't even appear (the "takes forever to
      // generate the link" bug). Now we open first, then hydrate the
      // expiry in the BACKGROUND and patch it into the open modal when
      // it arrives (the toggle populates a beat later; the URL + short
      // link generation start immediately).
      setShareState({
        open: true,
        title: folder.name,
        shareUrl: url,
        kind: 'folder',
        targetId: folderId,
        initialExpiresAt: null,
      })
      // Best-effort background expiry hydration — never blocks the modal.
      void (async () => {
        try {
          const res = await apiFetch(`/api/folders/${folderId}`)
          if (!res.ok) return
          const data = await res.json()
          const raw = data?.folder?.shareExpiresAt
          if (!raw) return
          const iso =
            typeof raw === 'string' ? raw : new Date(raw).toISOString()
          setShareState((prev) =>
            prev.open && prev.targetId === folderId
              ? { ...prev, initialExpiresAt: iso }
              : prev,
          )
        } catch {
          /* best-effort — modal already open with the working link */
        }
      })()
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

  // 1.7.8+: pull the shared admin A-Z / Z-A sort preference. It
  // drives both the folder card order (sortedFolders below) and
  // the video group order so the entire grid flips together.
  const [sortMode] = useAdminSortMode()
  const sortedFolders = useMemo(() => {
    // Server already returns folders ordered name-asc; we only
    // reverse for Z-A. Cheap operation, no allocation cost on the
    // common A-Z path.
    if (sortMode !== 'alphabetical-reverse') return folders
    return [...folders].sort((a, b) => b.name.localeCompare(a.name))
  }, [folders, sortMode])

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
      // The card shows the LATEST version (v2, v3, …), so its comment
      // badge must reflect THAT version's comments — not the sum across
      // the whole stack. Comments are tied to a specific version's
      // videoId (server counts `_count.comments` per row), so stacking
      // a fresh v2 (0 comments) over a v1 with 8 comments must read 0,
      // not 8. (Older builds summed the stack — that was the bug.)
      const latestComments = latest.commentCount ?? 0
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
        uploadProgress: (latest as any).uploadProgress ?? null,
        processingProgress: (latest as any).processingProgress ?? null,
        allIds: sorted.map((v) => v.id),
        commentCount: latestComments,
        uploaderName,
        createdAt: latest.createdAt,
        mediaType: latest.mediaType,
        originalFileSize: latest.originalFileSize ?? null,
      })
    }
    // Folders are ordered by name asc on the server; mirror that for
    // videos so the unified grid reads alphabetically. 1.7.8+: the
    // A-Z / Z-A direction comes from the shared admin sort mode.
    const sorted = groups.sort((a, b) => a.name.localeCompare(b.name))
    return sortMode === 'alphabetical-reverse' ? sorted.reverse() : sorted
  }, [videos, rootVideos, sortMode])

  // 3.9.x: mirror the grouped videos into a ref so async pollers
  // (thumbnail-regenerate completion watcher) can read the freshest
  // grid state without capturing a stale closure.
  const videoGroupsRef = useRef<VideoGroup[]>([])
  useEffect(() => {
    videoGroupsRef.current = videoGroups
  }, [videoGroups])

  // 2.2.6+: prune drop placeholders. Two reasons to remove one:
  //   (a) a real video row landed with a matching filename — the
  //       real card already has the upload/processing bar so the
  //       placeholder would just sit on top of it.
  //   (b) auto-expiry after 90s — covers the case where the server
  //       upload failed silently (network drop mid-TUS, etc) so we
  //       don't leave a ghost card stuck on screen forever.
  // Matching is done against the video's `originalFileName` (no
  // path component) AND its plain `name` after stripping the
  // extension, both lowercased.
  useEffect(() => {
    if (pendingDropPlaceholders.length === 0) return
    const PLACEHOLDER_TTL_MS = 90_000
    const now = Date.now()

    const norm = (s: string | undefined | null) => {
      if (!s) return ''
      const trimmed = s.replace(/^.*[\\/]/, '') // strip any leading path
      const dot = trimmed.lastIndexOf('.')
      const base = dot > 0 ? trimmed.slice(0, dot) : trimmed
      return base.trim().toLowerCase()
    }

    const realNames = new Set<string>()
    for (const v of videoGroups) {
      if ((v as any).originalFileName) realNames.add(norm((v as any).originalFileName))
      if (v.name) realNames.add(norm(v.name))
    }

    setPendingDropPlaceholders((prev) => {
      const filtered = prev.filter((p) => {
        if (now - p.droppedAt > PLACEHOLDER_TTL_MS) return false
        if (realNames.has(norm(p.fileName))) return false
        return true
      })
      return filtered.length === prev.length ? prev : filtered
    })
  }, [videoGroups, pendingDropPlaceholders.length])

  // 2.2.6+: backup sweep — even if `videoGroups` never changes (eg
  // user dropped a file, walked away, server never created the row),
  // re-evaluate every 5s so the placeholders eventually expire by
  // the TTL rule above.
  useEffect(() => {
    if (pendingDropPlaceholders.length === 0) return
    const id = setInterval(() => {
      const now = Date.now()
      setPendingDropPlaceholders((prev) => {
        const filtered = prev.filter((p) => now - p.droppedAt <= 90_000)
        return filtered.length === prev.length ? prev : filtered
      })
    }, 5_000)
    return () => clearInterval(id)
  }, [pendingDropPlaceholders.length])

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

  // Opens the themed rename dialog (glass) instead of the native
  // window.prompt. The actual PATCH happens in handleRenameVideoSubmit.
  const handleRenameVideo = useCallback(
    (videoId: string, currentName: string) => {
      setRenameVideoTarget({ id: videoId, name: currentName })
    },
    [],
  )

  const handleRenameVideoSubmit = useCallback(
    async (next: string) => {
      if (!renameVideoTarget) return
      try {
        const res = await apiFetch(`/api/videos/${renameVideoTarget.id}`, {
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
        // Keep the dialog open so the user can retry / fix the name.
        alert(err instanceof Error ? err.message : 'Failed to rename video')
        return false
      }
    },
    [renameVideoTarget, onMutated],
  )

  // 3.8.x: regenerate a single video's thumbnail (right-click / kebab).
  // Enqueues a worker job, then shows a bottom-right "Regenerating
  // thumbnail…" banner and polls the grid until the new cover lands.
  //
  // 3.9.x: the old two-shot refresh (4s + 9s) was too eager — the
  // worker sometimes needs longer (re-download the original from
  // storage, ffprobe, then ffmpeg), so the cover appeared "later" with
  // no feedback in between. Now we drive an indeterminate task banner
  // and poll the grid every few seconds, flipping the banner to
  // "Thumbnail updated" the moment the row's `thumbnailPath` changes.
  const { startTask } = useDownloadManager()
  const handleRegenerateThumbnail = useCallback(
    async (videoId: string) => {
      const group = videoGroupsRef.current.find(
        (g) => g.id === videoId || g.allIds.includes(videoId),
      )
      const label = group?.name || 'Video'
      const beforePath = group?.thumbnailPath ?? null

      let task: ReturnType<typeof startTask> | null = null
      try {
        const res = await apiFetch(`/api/videos/${videoId}/regenerate-thumbnail`, {
          method: 'POST',
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to regenerate thumbnail')
        }

        task = startTask({
          label,
          sublabel: 'Regenerating thumbnail…',
          icon: 'refresh',
        })

        // Poll the grid until the row's thumbnailPath flips (covers the
        // common null → set case; an in-place overwrite that keeps the
        // same path falls through to the graceful timeout below). Cap
        // the watch at ~60s so a wedged worker never leaves the banner
        // spinning forever.
        const ATTEMPTS = 20
        const INTERVAL_MS = 3000
        for (let i = 0; i < ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, INTERVAL_MS))
          await fetchFolders({ silent: true })
          onMutated?.()
          // Give React a beat to commit the fetch into state + sync the
          // ref before we read it.
          await new Promise((r) => setTimeout(r, 300))
          const nowPath =
            videoGroupsRef.current.find(
              (g) => g.id === videoId || g.allIds.includes(videoId),
            )?.thumbnailPath ?? null
          if (nowPath && nowPath !== beforePath) {
            task.finish('success', 'Thumbnail updated')
            return
          }
        }
        // Timed out watching for the change — the worker has almost
        // certainly finished by now (and the grid was refreshed each
        // tick), so close the banner cleanly rather than as an error.
        task.finish('success', 'Thumbnail updated')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to regenerate thumbnail'
        if (task) task.finish('error', msg)
        else alert(msg)
      }
    },
    [fetchFolders, onMutated, startTask],
  )

  // ─── multi-select + bulk actions (1.0.6+) ────────────────
  // Hoisted above the kebab handlers (1.0.9+) so the bulk-aware
  // Delete / Move-up flows can read the live selection.
  // 3.5.x: Finder/Explorer selection semantics.
  //   - plain click          → select ONLY the clicked item
  //   - Cmd/Ctrl + click      → toggle that item, keep the rest
  //   - Shift + click         → select the contiguous RANGE from the
  //                             last anchor to the clicked item
  // The grid renders folders first, then videos, so the range walks a
  // single combined ordered list spanning both types.
  const selectionAnchorRef = useRef<{
    kind: 'folder' | 'video'
    id: string
  } | null>(null)

  const orderedSelectableItems = useMemo(
    () => [
      ...sortedFolders.map((f) => ({ kind: 'folder' as const, id: f.id })),
      ...videoGroups.map((v) => ({ kind: 'video' as const, id: v.id })),
    ],
    [sortedFolders, videoGroups],
  )

  const selectItem = useCallback(
    (
      kind: 'folder' | 'video',
      id: string,
      additive: boolean,
      range: boolean,
    ) => {
      const anchor = selectionAnchorRef.current
      // Shift-click: select everything between the anchor and the
      // clicked item (inclusive). Keep the anchor so further shift-
      // clicks re-extend from the same origin.
      if (range && anchor) {
        const items = orderedSelectableItems
        const aIdx = items.findIndex(
          (it) => it.kind === anchor.kind && it.id === anchor.id,
        )
        const cIdx = items.findIndex((it) => it.kind === kind && it.id === id)
        if (aIdx !== -1 && cIdx !== -1) {
          const lo = Math.min(aIdx, cIdx)
          const hi = Math.max(aIdx, cIdx)
          const slice = items.slice(lo, hi + 1)
          setSelectedFolderIds(
            new Set(
              slice.filter((it) => it.kind === 'folder').map((it) => it.id),
            ),
          )
          setSelectedVideoIds(
            new Set(
              slice.filter((it) => it.kind === 'video').map((it) => it.id),
            ),
          )
          return
        }
        // Anchor went stale (item removed) — fall through to plain.
      }

      if (additive) {
        if (kind === 'folder') {
          setSelectedFolderIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        } else {
          setSelectedVideoIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        selectionAnchorRef.current = { kind, id }
        return
      }

      // Plain click: select only this item.
      if (kind === 'folder') {
        setSelectedFolderIds(new Set([id]))
        setSelectedVideoIds(new Set())
      } else {
        setSelectedVideoIds(new Set([id]))
        setSelectedFolderIds(new Set())
      }
      selectionAnchorRef.current = { kind, id }
    },
    [orderedSelectableItems],
  )

  const handleToggleVideoSelect = useCallback(
    (id: string, additive: boolean, range = false) =>
      selectItem('video', id, additive, range),
    [selectItem],
  )

  const handleToggleFolderSelect = useCallback(
    (id: string, additive: boolean, range = false) =>
      selectItem('folder', id, additive, range),
    [selectItem],
  )

  const clearSelection = useCallback(() => {
    setSelectedVideoIds(new Set())
    setSelectedFolderIds(new Set())
    selectionAnchorRef.current = null
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
   *
   * 2.0.x+: multi-file jobs (ids.length > 1) get tracked in the
   * DownloadManager so the user sees "X / Y files" progress + a
   * Cancel button. Single-video downloads skip the banner —
   * they're one anchor click, fast, no value in chrome around them.
   */
  const { startManualDownload } = useDownloadManager()
  const downloadVideos = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    setBulkBusy(true)
    const useBanner = ids.length > 1
    const job = useBanner
      ? startManualDownload({
          label: `${ids.length} files`,
          totalItems: ids.length,
        })
      : null
    try {
      for (const id of ids) {
        if (job?.signal.aborted) break
        const url = await fetchDownloadUrl(id)
        if (!url) {
          job?.bumpItem()
          continue
        }
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
        job?.bumpItem()
        await new Promise((r) => setTimeout(r, 400))
      }
      if (job) {
        job.finish(job.signal.aborted ? 'error' : 'success',
          job.signal.aborted ? 'Cancelled' : undefined)
      }
    } finally {
      setBulkBusy(false)
    }
  }, [startManualDownload])

  // 2.0.x+: routes through DownloadManager so the user sees a
  // bottom-right progress banner with percentage + Cancel button.
  // The manager fetches /stat for the byte total, then streams the
  // ZIP from /download chunk-by-chunk, accumulating bytes into the
  // banner state. Same Bearer auth via apiFetch — passed as the
  // custom fetcher so /stat is also authed.
  const { startStreamDownload } = useDownloadManager()

  // 3.5.x: anything over LARGE_DOWNLOAD_THRESHOLD gets a confirmation
  // first so nobody accidentally kicks off a multi-terabyte transfer
  // (the VDA project root is the worst case). Under the threshold the
  // download just runs. We reuse the shared ConfirmModal via
  // confirmState — same glass treatment as every other confirm.
  const guardLargeDownload = useCallback(
    (bytes: number, run: () => void) => {
      if (bytes <= LARGE_DOWNLOAD_THRESHOLD) {
        run()
        return
      }
      setConfirmState({
        open: true,
        title: 'Download this much?',
        description: (
          <>
            You&apos;re about to download{' '}
            <span className="font-semibold text-white">
              {formatBytes(bytes)}
            </span>
            . That can take a long time and a lot of disk space. Continue?
          </>
        ),
        confirmLabel: 'Download anyway',
        variant: 'destructive',
        onConfirm: () => {
          setConfirmState({ open: false, title: '' })
          run()
        },
      })
    },
    [],
  )

  const handleDownloadFolder = useCallback((folderId: string) => {
    const bytes = coerceBytes(
      folders.find((f) => f.id === folderId)?.totalSize,
    )
    guardLargeDownload(bytes, () => {
      startStreamDownload({
        label: 'Folder.zip',
        url: `/api/folders/${folderId}/download`,
        statUrl: `/api/folders/${folderId}/download/stat`,
        fetcher: apiFetch as any,
        fallbackFilename: 'folder.zip',
      })
    })
  }, [startStreamDownload, folders, guardLargeDownload])

  const handleBulkDownload = useCallback(() => {
    // 2.0.x+: each selected folder gets its OWN ZIP — exactly as if
    // the user had clicked "Download folder" on it individually.
    // Previously the bulk handler flattened all sub-tree videos into
    // one giant list and then triggered a per-file anchor click for
    // every leaf, which (a) produced N separate browser saves
    // instead of N tidy ZIPs and (b) lost the folder layout the
    // user was expecting in the archive.
    //
    // Selected LOOSE videos (i.e. selectedVideoIds outside any
    // selected folder) still go through the original
    // single-file-per-click pipeline — they have no folder to ZIP.
    const looseVideoIds = Array.from(selectedVideoIds)
    const folderBytes = Array.from(selectedFolderIds).reduce(
      (sum, fid) => sum + coerceBytes(folders.find((f) => f.id === fid)?.totalSize),
      0,
    )
    const videoBytes = looseVideoIds.reduce(
      (sum, vid) =>
        sum + coerceBytes(videoGroups.find((g) => g.id === vid)?.originalFileSize),
      0,
    )
    guardLargeDownload(folderBytes + videoBytes, () => {
      for (const folderId of selectedFolderIds) {
        startStreamDownload({
          label: 'Folder.zip', // overwritten by stat with the real name
          url: `/api/folders/${folderId}/download`,
          statUrl: `/api/folders/${folderId}/download/stat`,
          fetcher: apiFetch as any,
          fallbackFilename: 'folder.zip',
        })
      }
      if (looseVideoIds.length > 0) {
        downloadVideos(looseVideoIds)
      }
    })
  }, [
    selectedVideoIds,
    selectedFolderIds,
    downloadVideos,
    startStreamDownload,
    folders,
    videoGroups,
    guardLargeDownload,
  ])

  const handleDownloadAll = useCallback(() => {
    // 3.5.x: "Download All" now grabs EVERYTHING at this level — each
    // folder as its own ZIP (recursive, via the stream endpoint) plus
    // any loose videos. Previously it only pulled loose videos, so at
    // a folders-only level (e.g. the 01_VDA root) clicking it did
    // nothing at all. Same per-folder-ZIP + per-video pipeline as the
    // bulk-selection download.
    const looseVideoIds = videoGroups.map((g) => g.id)
    if (folders.length === 0 && looseVideoIds.length === 0) return
    const folderBytes = folders.reduce(
      (sum, f) => sum + coerceBytes(f.totalSize),
      0,
    )
    const videoBytes = videoGroups.reduce(
      (sum, g) => sum + coerceBytes(g.originalFileSize),
      0,
    )
    guardLargeDownload(folderBytes + videoBytes, () => {
      for (const f of folders) {
        startStreamDownload({
          label: 'Folder.zip', // overwritten by stat with the real name
          url: `/api/folders/${f.id}/download`,
          statUrl: `/api/folders/${f.id}/download/stat`,
          fetcher: apiFetch as any,
          fallbackFilename: 'folder.zip',
        })
      }
      if (looseVideoIds.length > 0) {
        downloadVideos(looseVideoIds)
      }
    })
  }, [
    videoGroups,
    folders,
    downloadVideos,
    startStreamDownload,
    guardLargeDownload,
  ])

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
      // 3.5.x: bulk-aware. If the dragged card is part of a 2+ video
      // selection, stack the WHOLE selection onto the target in one
      // call — the server orders them by their `_V<n>` suffix so they
      // layer in the right order (V2, V3, V4, …). Dragging a card that
      // isn't part of the selection still stacks just that one.
      const isBulk =
        selectedVideoIds.size >= 2 && selectedVideoIds.has(sourceId)
      try {
        if (isBulk) {
          // Sources in grid order, excluding the target's own group.
          const targetGroup = videoGroups.find((g) =>
            g.allIds.includes(targetId),
          )
          const targetGroupIds = new Set(
            targetGroup ? targetGroup.allIds : [targetId],
          )
          const sourceVideoIds = videoGroups
            .filter(
              (g) => selectedVideoIds.has(g.id) && !targetGroupIds.has(g.id),
            )
            .map((g) => g.id)
          if (sourceVideoIds.length === 0) return
          const res = await apiFetch('/api/videos/stack-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetVideoId: targetId, sourceVideoIds }),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || 'Failed to stack videos')
          }
          clearSelection()
        } else {
          const res = await apiFetch(`/api/videos/${sourceId}/stack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetVideoId: targetId }),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || 'Failed to stack videos')
          }
        }
        await fetchFolders({ silent: true })
        onMutated?.()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to stack videos')
      }
    },
    [onMutated, fetchFolders, selectedVideoIds, videoGroups, clearSelection],
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
      // 3.8.x PERF: fetch the project's shareExpiresAt in PARALLEL with
      // minting the signed URL (they used to run strictly one after the
      // other, doubling the wait before the modal appeared). The expiry
      // only seeds the expiration toggle, so we never block the modal on
      // it — we open as soon as the (required) signed URL is ready and
      // patch the expiry in when it lands.
      const expiryPromise: Promise<string | null> = (async () => {
        try {
          const meta = await apiFetch(`/api/projects/${projectId}`)
          if (!meta.ok) return null
          const data = await meta.json()
          const raw =
            data?.project?.shareExpiresAt ?? data?.shareExpiresAt ?? null
          if (!raw) return null
          return typeof raw === 'string' ? raw : new Date(raw).toISOString()
        } catch {
          return null
        }
      })()
      const patchExpiry = () => {
        void expiryPromise.then((iso) => {
          if (!iso) return
          setShareState((prev) =>
            prev.open && prev.targetId === projectId && prev.title === videoName
              ? { ...prev, initialExpiresAt: iso }
              : prev,
          )
        })
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
              initialExpiresAt: null,
            })
            patchExpiry()
            return
          }
        }
      } catch {
        /* fall through to unsigned URL */
      }
      // 1.6.1: prefer the admin-configured public origin so videos
      // share to the client domain even when we're browsing LAN.
      const origin = getPublicShareOrigin()
      const params = new URLSearchParams({ video: videoName })
      if (currentFolderId) params.set('folderId', currentFolderId)
      const url = `${origin}/share/${_projectSlug}?${params.toString()}`
      setShareState({
        open: true,
        title: videoName,
        shareUrl: url,
        kind: 'project',
        targetId: projectId,
        initialExpiresAt: null,
      })
      patchExpiry()
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
    // 3.5.x: flat-file drop is allowed wherever the parent wired an
    // `onUploadFiles` handler — including the PROJECT ROOT, where
    // `currentFolderId` is null (root uploads go to folderId=null).
    // Previously the `!!currentFolderId` gate silently disabled
    // dropping individual video files at the root.
    const canDropFiles = !!onUploadFiles
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
    // 3.5.x: flat-file drop is allowed wherever the parent wired an
    // `onUploadFiles` handler — including the PROJECT ROOT, where
    // `currentFolderId` is null (root uploads go to folderId=null).
    // Previously the `!!currentFolderId` gate silently disabled
    // dropping individual video files at the root.
    const canDropFiles = !!onUploadFiles
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
            // 1.7.1+: forward to the tree-upload handler even when
            // there are zero media files — the parent still mints
            // the matching FrameComment folders from
            // `extras.directoryPaths` so empty drop folders survive.
            if (videoEntries.length === 0 && walked.directoryPaths.length === 0) {
              return
            }
            onUploadFolderTree?.(videoEntries, {
              directoryPaths: walked.directoryPaths,
            })
            return
          }
          // No directory was dropped — fall back to the flat-files
          // path if the parent gave us a handler for it.
          if (canDropFiles && flatFiles.length) {
            addPendingDropPlaceholders(flatFiles)
            onUploadFiles?.(flatFiles)
          }
        } catch (err) {
          if (canDropFiles && flatFiles.length) {
            addPendingDropPlaceholders(flatFiles)
            onUploadFiles?.(flatFiles)
          }
        }
      })()
      return
    }

    if (canDropFiles && flatFiles.length) {
      addPendingDropPlaceholders(flatFiles)
      onUploadFiles?.(flatFiles)
    }
  }

  const hasItems = folders.length > 0 || videoGroups.length > 0

  // 1.7.0+: Space opens a macOS Quick Look-style preview for the
  // single currently-selected item. Mirrors the system shortcut
  // users already know from Finder.
  //
  // Tricky bit: after the user clicks the selection checkbox the
  // browser parks focus on that <button>. Native button behaviour
  // dispatches a synthetic `click` when Space is pressed/released,
  // which would re-toggle the selection. We defend against that by:
  //   1. Registering the listener in the CAPTURE phase so we win
  //      over any element-level handler.
  //   2. Calling `e.preventDefault()` AND `e.stopPropagation()` on
  //      both keydown AND keyup to suppress the button's space
  //      activation entirely.
  //   3. Blurring the active element so even if a click slips
  //      through (e.g. another listener swallowed our preventDefault)
  //      it won't land on the selection button.
  //
  // Bail out when typing in an input/textarea or when modifier keys
  // are held so we don't hijack form interactions or shortcuts like
  // Cmd+Space.
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' '

    const shouldHandle = (e: KeyboardEvent): boolean => {
      if (!isSpace(e)) return false
      if (e.metaKey || e.ctrlKey || e.altKey) return false
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return false
      if ((e.target as HTMLElement | null)?.isContentEditable) return false
      if (quickPreview) return false
      const totalSelected = selectedVideoIds.size + selectedFolderIds.size
      return totalSelected === 1
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!shouldHandle(e)) return
      e.preventDefault()
      e.stopPropagation()
      // Drop focus from the selection checkbox so the button's
      // own keyup-triggered click can't toggle the selection.
      const active = document.activeElement as HTMLElement | null
      if (active && typeof active.blur === 'function') active.blur()

      if (selectedVideoIds.size === 1) {
        const id = Array.from(selectedVideoIds)[0]
        const group = videoGroups.find((g) => g.id === id)
        if (!group) return
        const found = (videos as any[])
          .concat(rootVideos as any[])
          .find((v: any) => v.id === group.id)
        setQuickPreview({
          kind: 'video',
          id: group.id,
          name: group.name,
          duration: group.duration ?? null,
          width: found?.width ?? null,
          height: found?.height ?? null,
          mediaType: group.mediaType,
          thumbnailUrl: group.thumbnailUrl ?? null,
          previewUrl: group.previewUrl ?? null,
          versionLabel: group.versionLabel ?? null,
          uploaderName: group.uploaderName ?? null,
          createdAt: group.createdAt ?? null,
        })
      } else if (selectedFolderIds.size === 1) {
        const id = Array.from(selectedFolderIds)[0]
        const folder = folders.find((f) => f.id === id)
        if (!folder) return
        setQuickPreview({
          kind: 'folder',
          id: folder.id,
          name: folder.name,
          itemCount: folder.itemCount,
          totalSize: folder.totalSize ?? null,
        })
      }
    }

    // Keyup belt-and-braces: even if some other listener swallowed
    // our keydown preventDefault, the same suppression on keyup
    // stops the synthetic click on focused buttons.
    const onKeyUp = (e: KeyboardEvent) => {
      if (!shouldHandle(e)) return
      e.preventDefault()
      e.stopPropagation()
    }

    document.addEventListener('keydown', onKeyDown, true) // capture
    document.addEventListener('keyup', onKeyUp, true) // capture
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
    }
  }, [
    quickPreview,
    selectedVideoIds,
    selectedFolderIds,
    videoGroups,
    folders,
    videos,
    rootVideos,
  ])

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
            {/* 2.1.7+: Upload dropdown in the folder toolbar. The
                empty-state Upload button only rendered when the
                folder was empty — once a user had any content in
                the folder the only way to upload more was OS
                drag-drop, which kept tripping users up. We gate
                this on `hasItems` to avoid duplicating the dropdown
                with the empty-state copy (their refs would
                collide and outside-click handling would only fire
                on one of them). When the folder is empty the
                existing empty-state dropdown still handles uploads
                as before. */}
            {currentFolderId && onUploadFiles && hasItems && (
              <div ref={uploadMenuRef} className="relative">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setUploadMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={uploadMenuOpen}
                >
                  <Upload className="w-4 h-4 sm:mr-2" />
                  <span className="hidden sm:inline">Upload</span>
                </Button>
                {uploadMenuOpen && (
                  <div
                    role="menu"
                    // 2.5.0+: solid `#162533` glass-style dropdown,
                    // matches the rest of the v2.5 menus.
                    style={{ backgroundColor: '#162533' }}
                    className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-lg text-white ring-1 ring-white/10 shadow-2xl p-1"
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
            )}
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
        // 2.5.0+: frosted-glass empty state replaces the old dashed
        // border. Same vocabulary as the rest of the v2.5 chrome —
        // bg-white/[0.04] tint + hairline white-10 ring + soft
        // outward shadow. Hover-over with an OS-file drag flips to
        // a brand-blue tinted glass so the drop target reads clearly.
        // 2.5.1+: `data-empty-drop-zone` lets the GlobalDropOverlay
        // suppress its own popup when this big empty-state placeholder
        // is already visible — the empty state IS the drop target,
        // and stacking a second floating card on top of it just
        // muddies the affordance.
        <div
          data-empty-drop-zone="true"
          className={`flex flex-col items-center justify-center rounded-2xl py-10 sm:py-20 px-4 sm:px-6 text-center min-h-[280px] sm:min-h-[400px] transition-colors shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] ${
            isFileDropHover
              ? 'bg-primary/10 ring-1 ring-primary/40'
              : 'bg-white/[0.04] ring-1 ring-white/10'
          }`}
        >
          <div className="rounded-full bg-primary/15 ring-1 ring-primary/30 p-5">
            <UploadCloud className="w-12 h-12 text-primary" />
          </div>
          <p className="mt-5 text-sm text-white/65">
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
                  // 2.5.0+: solid `#162533` glass-style dropdown,
                  // matches the rest of the v2.5 menus.
                  style={{ backgroundColor: '#162533' }}
                  className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-30 min-w-[180px] rounded-lg text-white ring-1 ring-white/10 shadow-2xl p-1"
                >
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setUploadMenuOpen(false)
                      filesInputRef.current?.click()
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left"
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
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left"
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
          selected. 2.5.0+ refresh: aligned with the rest of the
          frosted-glass vocabulary — white-tinted glass pill with a
          hairline ring, brand-blue count badge on the left, and
          destructive-tinted Delete button on the right. */}
      {totalSelected > 0 && (
        <div
          data-selection-toolbar
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2"
        >
          <div
            className="flex items-center gap-1 rounded-full bg-white/[0.06] text-white ring-1 ring-white/10 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.65)] pl-2 pr-2 py-1.5"
            style={{ backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }}
          >
            <button
              type="button"
              onClick={clearSelection}
              className="rounded-full p-1.5 text-white/55 hover:text-white hover:bg-white/[0.08] transition-colors"
              title="Clear selection"
              aria-label="Clear selection"
            >
              <X className="w-4 h-4" />
            </button>
            {/* Brand-blue count chip — mirrors the v2.5 "active" state
                used on accent swatches, dropdown items, etc. so the
                user reads at a glance that something is selected. */}
            <span className="text-xs font-semibold tracking-tight px-2.5 h-7 inline-flex items-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/30 select-none">
              {totalSelected}{' '}
              {totalSelected === 1 ? 'item' : 'items'}
            </span>
            <div className="h-5 w-px bg-white/10 mx-1" aria-hidden />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleBulkDownload}
              disabled={bulkBusy}
              className="rounded-full h-8 px-3 text-white/85 hover:text-white hover:bg-white/[0.08] disabled:opacity-50"
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
              className="rounded-full h-8 px-3 text-destructive hover:text-destructive hover:bg-destructive/15 focus-visible:ring-destructive/60 focus-visible:ring-offset-0 disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </div>
          {/* 1.7.0+: discoverability hint for the Quick Preview
              shortcut. 2.5.0+ glass refresh keeps it visually
              quieter than the action pill above so the toolbar
              reads as primary / hint as supporting. */}
          {totalSelected === 1 && (
            <span
              className="text-[11px] text-white/65 ring-1 ring-white/10 rounded-full px-2.5 py-0.5 select-none shadow-[0_6px_16px_-10px_rgba(0,0,0,0.6)]"
              style={{
                backgroundColor: 'rgba(255,255,255,0.04)',
                backdropFilter: 'blur(16px) saturate(140%)',
                WebkitBackdropFilter: 'blur(16px) saturate(140%)',
              }}
            >
              Press{' '}
              <kbd className="px-1 py-px rounded bg-white/10 text-white font-mono text-[10px] ring-1 ring-white/10">
                Space
              </kbd>{' '}
              for quick preview
            </span>
          )}
        </div>
      )}

      {/* File-drop overlay (1.0.6+) — only shown when there's
          already content in the folder, otherwise the empty-state
          dashed box already communicates "drop here". Pointer-
          events-none so the underlying drag events keep reaching
          the container. */}
      {/* 2.0.x+: dropped the per-folder dashed overlay — the
          GlobalDropOverlay mounted in the admin layout covers
          the entire viewport with a single hint, so doubling up
          here just added visual noise (border + tinted bg over
          the grid, plus a card in the middle). The drag handler
          still runs and feeds files to the folder browser; only
          the visual chrome is suppressed. */}

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
          if (files.length) {
            // 2.2.6+: mirror the drop-handler optimistic placeholders
            // for the Upload Video(s) file-picker too — same UX win.
            addPendingDropPlaceholders(files)
            onUploadFiles?.(files)
          }
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
            if (videoFiles.length) {
              addPendingDropPlaceholders(videoFiles)
              onUploadFiles?.(videoFiles)
            }
          }
          e.target.value = ''
        }}
      />

      {!loading && !error && (folders.length > 0 || videoGroups.length > 0) && viewMode === 'table' && (
        <FolderBrowserTable
          folders={sortedFolders}
          videoGroups={videoGroups}
          selectedFolderIds={selectedFolderIds}
          selectedVideoIds={selectedVideoIds}
          onToggleFolder={handleToggleFolderSelect}
          onToggleVideo={handleToggleVideoSelect}
          onOpenFolder={handleOpenFolder}
          onOpenVideo={handleOpenVideo}
          // 3.5.x: drag-and-drop parity with the grid. Same bulk-aware
          // handlers — dragging a selected row carries the whole
          // selection (stack onto a video, move into a folder).
          onStackVideo={handleStackVideos}
          onMoveVideoToFolder={handleMoveVideoToFolder}
          onDropFolderOnFolder={handleDropOnFolder}
        />
      )}
      {!loading && !error && (folders.length > 0 || videoGroups.length > 0) && viewMode !== 'table' && (
        // 1.3.0+: start at 2 columns on phones (used to be 1) so the
        // cards don't fill the entire screen each. 2 fits a 360-414px
        // viewport comfortably; we step up to 3 → 4 → 5 → 6 on bigger
        // viewports.
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3 sm:gap-4 items-start">
          {sortedFolders.map((f) => (
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

          {/* 2.2.6+: optimistic drop placeholders — instant feedback
              the moment files enter the grid. Replaced by real
              VideoCards as soon as the server-side row is observed
              (matched by normalised filename in the prune effect). */}
          {pendingDropPlaceholders.map((p) => {
            const dot = p.fileName.lastIndexOf('.')
            const displayName =
              dot > 0 ? p.fileName.slice(0, dot) : p.fileName
            return (
              <div
                key={p.localId}
                className="rounded-lg overflow-hidden border border-border bg-card animate-in fade-in-0 duration-150"
              >
                <div className="aspect-video relative bg-black/40">
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span className="text-[10px]">Generating thumbnail…</span>
                  </div>
                  {/* Thin blue bar at the bottom edge of the cover —
                      indeterminate (no TUS hook here yet), so it
                      pulses left-right until the real card takes
                      over and shows actual upload progress. */}
                  <div className="absolute left-0 right-0 bottom-0 h-1 bg-primary/10">
                    <div className="h-full w-1/3 bg-primary animate-[pulse_1.4s_ease-in-out_infinite] rounded-r-full" />
                  </div>
                </div>
                <div className="px-2.5 py-2">
                  <div
                    className="text-xs font-medium truncate text-card-foreground"
                    title={p.fileName}
                  >
                    {displayName || 'Uploading…'}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                    Uploading…
                  </div>
                </div>
              </div>
            )
          })}
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
              uploadProgress={v.uploadProgress ?? null}
              processingProgress={v.processingProgress ?? null}
              plannedTiers={(v as any).plannedTiers ?? null}
              completedTiers={(v as any).completedTiers ?? null}
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
              onRegenerateThumbnail={handleRegenerateThumbnail}
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

          {/* 2.5.0+: in-flow "+ New Folder" tile, same recipe as the
              Projects dashboard's "+ New Project" placeholder. Sits
              at the END of the grid so the dashed tile always closes
              the row and doesn't interrupt the natural reading order
              of existing content. Visibil indiferent de selecție —
              utilizatorii vor să poată crea un folder nou chiar și
              când au deja câteva item-uri selectate, fără să fie
              nevoiți să deselecteze mai întâi. Structura oglindește
              VideoCard / FolderCard exact: aspect-video cover +
              label footer pe `p-4` — așa tile-ul intră în grid la
              aceeași dimensiune ca orice alt card. */}
          <button
            type="button"
            onClick={() => {
              setNewDialogRestricted(false)
              setShowNewDialog(true)
            }}
            className="group flex flex-col rounded-xl ring-1 ring-dashed ring-white/15 bg-white/[0.02] hover:bg-white/[0.05] hover:ring-white/30 text-white/55 hover:text-white transition-colors text-left"
            aria-label="New Folder"
          >
            <span className="relative aspect-video rounded-t-xl flex items-center justify-center">
              <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/[0.06] ring-1 ring-white/10 group-hover:bg-white/[0.12] transition-colors">
                <FolderPlus className="w-6 h-6" />
              </span>
            </span>
            {/* Footer sincronizat 1:1 cu FolderCard ca înălțime
                (`p-4` + `text-base font-semibold` name + `text-xs
                mt-1` meta spacer), dar textul e centrat orizontal
                în loc de left-aligned — pe placeholder-ul "+ New
                Folder" centrul citește mai natural decât stânga,
                care s-ar alinia la numele folderelor reale și ar
                trage atenția în jos-stânga al tile-ului. */}
            <span className="flex flex-col items-center p-4 rounded-b-xl">
              <span className="text-base font-semibold">New Folder</span>
              <span className="text-xs mt-1 invisible" aria-hidden>.</span>
            </span>
          </button>
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
        // 3.5.x: the context-menu "Upload Folder" used to be wired only
        // to the (never-passed) `onUploadFolder` prop, so it rendered
        // disabled everywhere — including the project root — even though
        // dragging a folder in already worked. Fall back to triggering
        // the component's own hidden `webkitdirectory` picker, which
        // routes through `onUploadFolderTree` (wired on both the folder
        // AND root pages). Now it's enabled wherever folder upload is
        // supported.
        onUploadFolder={
          onUploadFolder
            ? onUploadFolder
            : onUploadFolderTree
              ? () => folderInputRef.current?.click()
              : undefined
        }
        onNewFolder={() => {
          setNewDialogRestricted(false)
          setShowNewDialog(true)
        }}
        onNewRestrictedFolder={() => {
          setNewDialogRestricted(true)
          setShowNewDialog(true)
        }}
        onUgcTemplate={() => handleCreateTemplate(['9:16', '4:5'])}
        onYtTemplate={() => handleCreateTemplate(['IN EDIT', 'CLEAN', 'FINAL'])}
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
        // 3.5.x: "Split versions" — only for a single selected video
        // that actually has more than one version. Integrated into the
        // existing right-click menu (no separate popup).
        canSplitVersions={(() => {
          if (selectedVideoIds.size !== 1 || selectedFolderIds.size !== 0)
            return false
          const firstVideo = selectedVideoIds.values().next().value as
            | string
            | undefined
          if (!firstVideo) return false
          const grp = videoGroups.find((g) => g.allIds.includes(firstVideo))
          return !!grp && grp.versionCount > 1
        })()}
        onSplitVersions={() => {
          const firstVideo = selectedVideoIds.values().next().value as
            | string
            | undefined
          if (!firstVideo) return
          const grp = videoGroups.find((g) => g.allIds.includes(firstVideo))
          handleSplitVersions(firstVideo, grp?.name ?? '')
        }}
        // 3.8.x: regenerate thumbnail — single video selected (any version).
        canRegenerateThumbnail={
          selectedVideoIds.size === 1 && selectedFolderIds.size === 0
        }
        onRegenerateThumbnail={() => {
          const firstVideo = selectedVideoIds.values().next().value as
            | string
            | undefined
          if (firstVideo) void handleRegenerateThumbnail(firstVideo)
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
      <RenameDialog
        open={!!renameTarget}
        onOpenChange={(next) => { if (!next) setRenameTarget(null) }}
        title="Rename folder"
        initialValue={renameTarget?.name || ''}
        onSubmit={handleRenameSubmit}
      />
      <RenameDialog
        open={!!renameVideoTarget}
        onOpenChange={(next) => { if (!next) setRenameVideoTarget(null) }}
        title="Rename video"
        initialValue={renameVideoTarget?.name || ''}
        onSubmit={handleRenameVideoSubmit}
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
      <QuickPreviewOverlay
        target={quickPreview}
        onClose={() => setQuickPreview(null)}
        projectId={projectId}
      />
    </div>
  )
}

const FolderBrowser = forwardRef<FolderBrowserHandle, FolderBrowserProps>(
  FolderBrowserInner,
)
FolderBrowser.displayName = 'FolderBrowser'
export default FolderBrowser
