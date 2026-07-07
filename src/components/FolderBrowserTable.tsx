'use client'

import { useState } from 'react'
import { Folder as FolderIcon, Film, Image as ImageIcon } from 'lucide-react'
import { formatDuration } from '@/lib/utils'
import { formatBytes } from '@/lib/project-gradient'

/**
 * 1.7.0+: compact "table" layout for the FolderBrowser grid. Same data
 * as the Frame.io-style cards but flattened into Name / Type /
 * Duration / Size rows so admins managing dense libraries can scan
 * faster.
 *
 * 3.5.x: full parity with the grid view —
 *   - selection: plain click (only this), Cmd/Ctrl-click (toggle),
 *     Shift-click (range); plus a checkbox in front of each row.
 *   - drag-and-drop: drag a row (or a whole multi-selection) onto a
 *     video to stack it as a new version, or onto a folder to move it
 *     in. Uses the same `VIDEO_MIME` / `FOLDER_MIME` payloads and the
 *     same (bulk-aware) handlers as the cards.
 *   - double-click drills in / opens the player.
 */

// Same custom MIME payloads the grid cards use, so a row dragged from
// the table can drop onto a card and vice-versa.
const FOLDER_MIME = 'application/x-framecomment-folder'
const VIDEO_MIME = 'application/x-framecomment-video'

interface FolderRow {
  id: string
  name: string
  itemCount: number
  totalSize?: string | null
}

interface VideoGroup {
  id: string
  name: string
  duration?: number
  versionLabel?: string
  versionCount?: number
  thumbnailUrl?: string | null
  mediaType?: 'VIDEO' | 'IMAGE'
  originalFileSize?: string | number | null
}

interface FolderBrowserTableProps {
  folders: FolderRow[]
  videoGroups: VideoGroup[]
  selectedFolderIds: Set<string>
  selectedVideoIds: Set<string>
  // `additive` true = Cmd/Ctrl-click (extend); `range` true =
  // Shift-click (select range); both false = plain click (select only
  // this row). Matches the grid cards.
  onToggleFolder: (id: string, additive: boolean, range: boolean) => void
  onToggleVideo: (id: string, additive: boolean, range: boolean) => void
  onOpenFolder: (id: string) => void
  onOpenVideo: (name: string) => void
  // 3.5.x drag-and-drop parity with the grid (all bulk-aware in the
  // parent: dragging a selected row carries the whole selection).
  onStackVideo: (sourceId: string, targetId: string) => void
  onMoveVideoToFolder: (sourceVideoId: string, targetFolderId: string) => void
  onDropFolderOnFolder: (sourceId: string, targetId: string) => void
  /** 3.9.x: OS files/folders dropped onto a folder ROW upload straight
   *  INTO that folder — list-view parity with the grid card's
   *  `onDropOSFiles`. We hand over the raw DataTransfer so the parent
   *  can snapshot the FileSystemEntry tree synchronously. */
  onDropOSFiles?: (targetFolderId: string, dataTransfer: DataTransfer) => void
  /** 3.9.x: OS files dropped onto a VIDEO ROW upload as a NEW VERSION
   *  of that video — list-view parity with the grid card's
   *  `onDropOSFiles` on VideoCard. */
  onDropOSFilesOnVideo?: (targetVideoId: string, dataTransfer: DataTransfer) => void
}

export default function FolderBrowserTable({
  folders,
  videoGroups,
  selectedFolderIds,
  selectedVideoIds,
  onToggleFolder,
  onToggleVideo,
  onOpenFolder,
  onOpenVideo,
  onStackVideo,
  onMoveVideoToFolder,
  onDropFolderOnFolder,
  onDropOSFiles,
  onDropOSFilesOnVideo,
}: FolderBrowserTableProps) {
  // Local drag bookkeeping (visual only — the actual move/stack logic
  // lives in the parent handlers).
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [draggingKind, setDraggingKind] = useState<'folder' | 'video' | null>(
    null,
  )
  const [dropHoverId, setDropHoverId] = useState<string | null>(null)

  const clearDrag = () => {
    setDraggingId(null)
    setDraggingKind(null)
    setDropHoverId(null)
  }

  // Dim the dragged row + (when it's part of a multi-select) every
  // selected sibling of the same kind, so a bulk drag visibly carries
  // the whole batch.
  const isDimmed = (kind: 'folder' | 'video', id: string) => {
    if (!draggingId) return false
    if (draggingId === id && draggingKind === kind) return true
    if (draggingKind !== kind) return false
    if (kind === 'video')
      return selectedVideoIds.has(draggingId) && selectedVideoIds.has(id)
    return selectedFolderIds.has(draggingId) && selectedFolderIds.has(id)
  }

  const rowClass = (selected: boolean, dimmed: boolean, dropHover: boolean) =>
    `group w-full grid grid-cols-[minmax(0,1fr)_120px_120px_140px] gap-3 px-3 sm:px-4 py-2 text-left text-sm transition-colors cursor-pointer outline-none [&:last-child]:rounded-b-xl ${
      dropHover
        ? 'ring-2 ring-inset ring-primary/60 bg-primary/10'
        : selected
          ? 'bg-primary/15 ring-1 ring-inset ring-primary/40 text-white'
          : 'text-white hover:bg-white/[0.05]'
    } ${dimmed ? 'opacity-40' : ''}`

  return (
    // 2.5.1+: full v2.5 frosted glass — same recipe as the Projects
    // dashboard table view.
    <div
      className="rounded-xl overflow-hidden ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55)] text-white"
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
      {/* Table header */}
      <div className="grid grid-cols-[minmax(0,1fr)_120px_120px_140px] gap-3 px-3 sm:px-4 py-2 border-b border-white/10 bg-white/[0.03] text-[11px] uppercase tracking-wide font-medium text-white/55">
        <div>Name</div>
        <div>Type</div>
        <div>Duration</div>
        <div>Size</div>
      </div>
      <div role="rowgroup" className="divide-y divide-white/10">
        {folders.map((f) => {
          const selected = selectedFolderIds.has(f.id)
          const dimmed = isDimmed('folder', f.id)
          const dropHover = dropHoverId === f.id
          return (
            <div
              key={`folder:${f.id}`}
              // Same marker the grid cards carry — the FolderBrowser's
              // "click empty space clears the selection" handler skips
              // anything inside a [data-folder-id]/[data-video-id]. Without
              // it, every row click cleared the selection it just made.
              data-folder-id={f.id}
              // 3.9.x: marks this row as an OS-file drop target so the
              // FolderBrowser container drop handler bails (the row
              // already routed the files into this folder).
              data-accepts-os-files={onDropOSFiles ? 'true' : undefined}
              role="button"
              tabIndex={0}
              aria-selected={selected}
              draggable
              onClick={(e) =>
                onToggleFolder(f.id, e.metaKey || e.ctrlKey, e.shiftKey)
              }
              onDoubleClick={() => onOpenFolder(f.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onOpenFolder(f.id)
                }
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(FOLDER_MIME, f.id)
                e.dataTransfer.setData('text/plain', `folder:${f.id}`)
                setDraggingId(f.id)
                setDraggingKind('folder')
              }}
              onDragEnd={clearDrag}
              onDragOver={(e) => {
                const types = Array.from(e.dataTransfer.types)
                const isVideo = types.includes(VIDEO_MIME)
                const isFolder = types.includes(FOLDER_MIME)
                const isFiles = types.includes('Files')
                // 3.9.x: real OS files dragged in → upload INTO this
                // folder. preventDefault to allow the drop, but no
                // stopPropagation (the container bails via the
                // data-accepts-os-files marker; window resets its
                // overlay).
                if (isFiles && !isVideo && !isFolder && onDropOSFiles) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  if (dropHoverId !== f.id) setDropHoverId(f.id)
                  return
                }
                if (!isVideo && !isFolder) return
                if (isFolder && draggingId === f.id) return // onto self
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropHoverId !== f.id) setDropHoverId(f.id)
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the row bounds (children fire
                // spurious leaves otherwise).
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                if (
                  e.clientX <= r.left ||
                  e.clientX >= r.right ||
                  e.clientY <= r.top ||
                  e.clientY >= r.bottom
                ) {
                  setDropHoverId((cur) => (cur === f.id ? null : cur))
                }
              }}
              onDrop={(e) => {
                // 3.9.x: OS file/folder drop → upload straight into this
                // folder. Hand the DataTransfer up so the parent can
                // snapshot the entry tree synchronously.
                const types = Array.from(e.dataTransfer.types)
                if (types.includes('Files') && onDropOSFiles) {
                  e.preventDefault()
                  onDropOSFiles(f.id, e.dataTransfer)
                  clearDrag()
                  return
                }
                e.preventDefault()
                const vid = e.dataTransfer.getData(VIDEO_MIME)
                if (vid) {
                  onMoveVideoToFolder(vid, f.id)
                } else {
                  const fid = e.dataTransfer.getData(FOLDER_MIME)
                  if (fid && fid !== f.id) onDropFolderOnFolder(fid, f.id)
                }
                clearDrag()
              }}
              className={rowClass(selected, dimmed, dropHover)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <FolderIcon className="w-4 h-4 text-primary/80 shrink-0" />
                <span className="truncate" title={f.name}>
                  {f.name}
                </span>
              </div>
              <div className="text-white/55 self-center">Folder</div>
              <div className="text-white/55 self-center tabular-nums">—</div>
              <div className="text-white/55 self-center tabular-nums">
                {f.totalSize && Number(f.totalSize) > 0
                  ? formatBytes(f.totalSize)
                  : `${f.itemCount} ${f.itemCount === 1 ? 'item' : 'items'}`}
              </div>
            </div>
          )
        })}
        {videoGroups.map((v) => {
          const selected = selectedVideoIds.has(v.id)
          const isImage = v.mediaType === 'IMAGE'
          const dimmed = isDimmed('video', v.id)
          const dropHover = dropHoverId === v.id
          return (
            <div
              key={`video:${v.id}`}
              // See the folder row above — this marker keeps a row click
              // from being treated as an "empty space" click that clears
              // the selection.
              data-video-id={v.id}
              // 3.9.x: OS-file drop target marker so the container drop
              // handler bails (this row routed the files into a new
              // version of the video).
              data-accepts-os-files={onDropOSFilesOnVideo ? 'true' : undefined}
              role="button"
              tabIndex={0}
              aria-selected={selected}
              draggable
              onClick={(e) =>
                onToggleVideo(v.id, e.metaKey || e.ctrlKey, e.shiftKey)
              }
              onDoubleClick={() => onOpenVideo(v.name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onOpenVideo(v.name)
                }
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(VIDEO_MIME, v.id)
                e.dataTransfer.setData('text/plain', `video:${v.id}`)
                setDraggingId(v.id)
                setDraggingKind('video')
              }}
              onDragEnd={clearDrag}
              onDragOver={(e) => {
                const types = Array.from(e.dataTransfer.types)
                const isVideo = types.includes(VIDEO_MIME)
                const isFiles = types.includes('Files')
                // 3.9.x: real OS files → upload as a new version of this
                // video. No stopPropagation (container bails via the
                // data-accepts-os-files marker; window resets its overlay).
                if (isFiles && !isVideo && onDropOSFilesOnVideo) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  if (dropHoverId !== v.id) setDropHoverId(v.id)
                  return
                }
                // Otherwise videos accept only video drops (stacking).
                if (!isVideo) return
                if (draggingId === v.id) return // onto self
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropHoverId !== v.id) setDropHoverId(v.id)
              }}
              onDragLeave={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                if (
                  e.clientX <= r.left ||
                  e.clientX >= r.right ||
                  e.clientY <= r.top ||
                  e.clientY >= r.bottom
                ) {
                  setDropHoverId((cur) => (cur === v.id ? null : cur))
                }
              }}
              onDrop={(e) => {
                const types = Array.from(e.dataTransfer.types)
                // 3.9.x: OS file drop → upload as a new version.
                if (types.includes('Files') && onDropOSFilesOnVideo) {
                  e.preventDefault()
                  onDropOSFilesOnVideo(v.id, e.dataTransfer)
                  clearDrag()
                  return
                }
                const src = e.dataTransfer.getData(VIDEO_MIME)
                if (src && src !== v.id) {
                  e.preventDefault()
                  onStackVideo(src, v.id)
                }
                clearDrag()
              }}
              className={rowClass(selected, dimmed, dropHover)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <RowThumb thumbnailUrl={v.thumbnailUrl} isImage={isImage} />
                <span className="truncate" title={v.name}>
                  {v.name}
                </span>
                {v.versionLabel && (
                  <span className="text-[10px] uppercase text-white/55 shrink-0">
                    {v.versionLabel}
                  </span>
                )}
              </div>
              <div className="text-white/55 self-center">
                {isImage ? 'Image' : 'Video'}
              </div>
              <div className="text-white/55 self-center tabular-nums">
                {!isImage && typeof v.duration === 'number' && v.duration > 0
                  ? formatDuration(v.duration)
                  : '—'}
              </div>
              <div className="text-white/55 self-center tabular-nums">
                {v.originalFileSize && Number(v.originalFileSize) > 0
                  ? formatBytes(v.originalFileSize)
                  : '—'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 3.9.x: list-view thumbnail that keeps the row's fixed footprint but
// renders the frame at the VIDEO's real aspect ratio instead of
// cropping it into a 16:9 box (a 9:16 reel used to get squished into a
// landscape sliver). The thumbnail JPEG is generated at the clip's
// native aspect, so we read it straight off the loaded image
// (naturalWidth/Height) — no extra API field needed — and size the
// image to that aspect within a FIXED-WIDTH slot so the Name column
// stays aligned across rows regardless of orientation.
const THUMB_H = 24 // px — same height as the old h-6 box
const THUMB_SLOT_W = 44 // fixed slot width → aligned text column
const THUMB_MIN_W = 14
const THUMB_MAX_W = 44

function RowThumb({
  thumbnailUrl,
  isImage,
}: {
  thumbnailUrl?: string | null
  isImage: boolean
}) {
  const [aspect, setAspect] = useState<number | null>(null)
  const Icon = isImage ? ImageIcon : Film
  // Fall back to 16:9 until the image resolves its natural size.
  const a = aspect ?? 16 / 9
  const width = Math.round(
    Math.min(THUMB_MAX_W, Math.max(THUMB_MIN_W, THUMB_H * a)),
  )

  return (
    <div
      className="shrink-0 flex items-center justify-center"
      style={{ width: THUMB_SLOT_W, height: THUMB_H }}
    >
      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              const next = img.naturalWidth / img.naturalHeight
              setAspect((cur) =>
                cur === null || Math.abs(cur - next) / next > 0.01
                  ? next
                  : cur,
              )
            }
          }}
          // Box matches the clip's aspect, so object-cover fills it
          // exactly with no crop/stretch.
          className="object-cover rounded bg-white/10 ring-1 ring-white/10"
          style={{ width, height: THUMB_H }}
        />
      ) : (
        <div
          className="rounded bg-white/10 ring-1 ring-white/10 flex items-center justify-center"
          style={{ width: Math.round(THUMB_H * (16 / 9)), height: THUMB_H }}
        >
          <Icon className="w-3.5 h-3.5 text-white/55" />
        </div>
      )}
    </div>
  )
}
