'use client'

import { Folder as FolderIcon, Film, Image as ImageIcon } from 'lucide-react'
import { formatDuration } from '@/lib/utils'
import { formatBytes } from '@/lib/project-gradient'

/**
 * 1.7.0+: compact "table" layout for the FolderBrowser grid. Same
 * data as the Frame.io-style cards but flattened into rows with
 * Name / Type / Duration / Size columns so admins managing dense
 * libraries can scan faster.
 *
 * Selection + open behaviour mirrors the cards: single-click toggles
 * selection, double-click drills in / opens the player. The kebab
 * menus, drag-and-drop and right-click context menu are intentionally
 * NOT replicated here — the table view is read-first; for those
 * power features users flip back to grid. (We render a thin selection
 * ring on selected rows the same way the cards do.)
 */

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
  thumbnailUrl?: string | null
  mediaType?: 'VIDEO' | 'IMAGE'
  // The size of the video group's latest version, passed through as
  // a stringified BigInt or a number when the caller has it. The
  // folder GET endpoint exposes originalFileSize on each row; the
  // table reads that via the `videos` map below.
}

interface FolderBrowserTableProps {
  folders: FolderRow[]
  videoGroups: VideoGroup[]
  selectedFolderIds: Set<string>
  selectedVideoIds: Set<string>
  onToggleFolder: (id: string) => void
  onToggleVideo: (id: string) => void
  onOpenFolder: (id: string) => void
  onOpenVideo: (name: string) => void
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
}: FolderBrowserTableProps) {
  return (
    // 2.5.1+: full v2.5 frosted glass — same recipe as the Projects
    // dashboard table view (translucent navy + spotlight radial wash +
    // 40px backdrop blur + hairline white-15 ring + elevation shadow).
    // Replaces the previous `bg-card` solid which broke the glass
    // continuity with the rest of the admin UI.
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
          return (
            <button
              key={`folder:${f.id}`}
              type="button"
              onClick={() => onToggleFolder(f.id)}
              onDoubleClick={() => onOpenFolder(f.id)}
              aria-selected={selected}
              // 1.7.5+: round the bottom-left/right corners on the
              // last row in the list so the selection ring follows
              // the outer container's `rounded-xl` curve instead
              // of being clipped flat against the bottom edge.
              className={`w-full grid grid-cols-[minmax(0,1fr)_120px_120px_140px] gap-3 px-3 sm:px-4 py-2 text-left text-sm transition-colors [&:last-child]:rounded-b-xl ${
                selected
                  ? 'bg-primary/15 ring-1 ring-inset ring-primary/40 text-white'
                  : 'text-white hover:bg-white/[0.05]'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <FolderIcon className="w-4 h-4 text-primary/80 shrink-0" />
                <span className="truncate" title={f.name}>{f.name}</span>
              </div>
              <div className="text-white/55 self-center">Folder</div>
              <div className="text-white/55 self-center tabular-nums">
                —
              </div>
              <div className="text-white/55 self-center tabular-nums">
                {f.totalSize && Number(f.totalSize) > 0
                  ? formatBytes(f.totalSize)
                  : `${f.itemCount} ${f.itemCount === 1 ? 'item' : 'items'}`}
              </div>
            </button>
          )
        })}
        {videoGroups.map((v) => {
          const selected = selectedVideoIds.has(v.id)
          const isImage = v.mediaType === 'IMAGE'
          const TypeIcon = isImage ? ImageIcon : Film
          return (
            <button
              key={`video:${v.id}`}
              type="button"
              onClick={() => onToggleVideo(v.id)}
              onDoubleClick={() => onOpenVideo(v.name)}
              aria-selected={selected}
              className={`w-full grid grid-cols-[minmax(0,1fr)_120px_120px_140px] gap-3 px-3 sm:px-4 py-2 text-left text-sm transition-colors [&:last-child]:rounded-b-xl ${
                selected
                  ? 'bg-primary/15 ring-1 ring-inset ring-primary/40 text-white'
                  : 'text-white hover:bg-white/[0.05]'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {v.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={v.thumbnailUrl}
                    alt=""
                    className="w-10 h-6 object-cover rounded shrink-0 bg-white/10 ring-1 ring-white/10"
                  />
                ) : (
                  <div className="w-10 h-6 rounded bg-white/10 ring-1 ring-white/10 flex items-center justify-center shrink-0">
                    <TypeIcon className="w-3.5 h-3.5 text-white/55" />
                  </div>
                )}
                <span className="truncate" title={v.name}>{v.name}</span>
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
                {/* The table view doesn't have direct access to
                    `originalFileSize` on each VideoGroup (the grid
                    cards don't render it either). Surface a dash
                    here for now; a follow-up can extend VideoGroup
                    if admins want exact byte totals per row. */}
                —
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
