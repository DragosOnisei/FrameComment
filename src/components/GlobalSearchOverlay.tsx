'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'
import { copyToClipboard } from '@/lib/clipboard'
import { formatDuration } from '@/lib/utils'
import { formatBytes } from '@/lib/project-gradient'
import { getPublicShareOrigin } from '@/lib/public-share-origin'
import {
  Search,
  X,
  Film,
  Image as ImageIcon,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  FolderOpen,
  Check,
} from 'lucide-react'

/**
 * 1.7.0+: Frame.io-style global video search overlay. Mounted once
 * by AdminHeader; opens/closes via the `open` prop.
 *
 * Layout — always two-pane the moment a query starts returning
 * matches: a scrollable list on the left, and a live preview /
 * action panel on the right. The first result is auto-selected so
 * the right pane is never empty.
 *
 * Behaviour:
 *  - As the user types we debounce ~120 ms then GET /api/search.
 *    Below 3 chars we suppress the request entirely (saves a round
 *    trip on every keystroke).
 *  - Default limit is 5 (compact "live" view). Hitting Enter or
 *    clicking "See all N results" reissues the search with a
 *    larger limit so the left rail expands to the full match set.
 *  - Right pane shows: preview thumbnail (with duration overlay),
 *    title, project / folder path, metadata grid (file, size,
 *    resolution, duration, version, upload date) and three actions
 *    — Copy URL (signed share link), Download (original via the
 *    existing download-token flow) and View in Project (deep-link
 *    into the admin player).
 *  - Escape closes. Cmd/Ctrl+K from AdminHeader re-opens.
 */

interface SearchResult {
  id: string
  name: string
  projectId: string
  folderId: string | null
  projectName: string | null
  folderName: string | null
  thumbnailUrl: string | null
  previewUrl: string | null
  duration: number
  width: number
  height: number
  mediaType: 'VIDEO' | 'IMAGE'
  originalFileName: string
  originalFileSize: string
  createdAt: string
  updatedAt: string
  status: string
  versionLabel: string
}

// 3.3.x: folder search results for the "Folders" tab.
interface FolderResult {
  id: string
  name: string
  slug: string
  projectId: string
  projectName: string | null
  parentName: string | null
  videoCount: number
  subfolderCount: number
}

type SearchTab = 'videos' | 'folders'

interface GlobalSearchOverlayProps {
  open: boolean
  onClose: () => void
}

// 1.7.0+: a single limit covers both the live dropdown and the
// full results view — the left rail is scrollable, so there's no
// reason to artificially cap it at 5. Bump the ceiling to 200 so
// long projects (many stacks matching a common term) still fit
// without paginating.
const RESULT_LIMIT = 200
const MIN_QUERY = 3
const DEBOUNCE_MS = 120

export default function GlobalSearchOverlay({ open, onClose }: GlobalSearchOverlayProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState(0)
  // 3.3.x: Folders tab. The same fetch returns both videos + folders,
  // so switching tabs is instant (no re-query).
  const [activeTab, setActiveTab] = useState<SearchTab>('videos')
  const [folderResults, setFolderResults] = useState<FolderResult[]>([])
  const [folderTotal, setFolderTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)

  // 1.7.0+: split width between the left rail and the right preview
  // pane is user-resizable. The handle lives between the two panes;
  // the user drags it to bias the layout toward whichever side they
  // want bigger. Persisted in localStorage so the preference
  // survives across sessions.
  const SPLIT_STORAGE_KEY = 'globalSearchLeftWidth'
  const DEFAULT_LEFT = 420
  const MIN_LEFT = 240
  // Right pane has a fixed floor wide enough for all three action
  // buttons (Copy URL · Download · View in Project) to sit on the
  // same row. Below this width the View-in-Project button wraps to
  // a second line and the action strip looks fragmented, so we
  // simply stop letting the user drag the divider any further.
  const MIN_RIGHT = 460
  const [leftWidth, setLeftWidth] = useState<number>(DEFAULT_LEFT)
  const [isDragging, setIsDragging] = useState(false)
  const leftWidthRef = useRef(leftWidth)
  useEffect(() => {
    leftWidthRef.current = leftWidth
  }, [leftWidth])
  const panelRef = useRef<HTMLDivElement>(null)

  // Hydrate persisted width once the overlay mounts.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY)
      const parsed = raw ? parseInt(raw, 10) : NaN
      if (Number.isFinite(parsed) && parsed > 0) setLeftWidth(parsed)
    } catch {
      /* localStorage disabled — keep default */
    }
  }, [])

  // Drag lifecycle for the divider.
  useEffect(() => {
    if (!isDragging) return
    const panel = panelRef.current
    if (!panel) return
    const panelLeft = panel.getBoundingClientRect().left
    const panelWidth = panel.getBoundingClientRect().width
    const maxLeft = Math.max(MIN_LEFT, panelWidth - MIN_RIGHT)

    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX =
        (e as TouchEvent).touches?.[0]?.clientX ?? (e as MouseEvent).clientX
      if (typeof clientX !== 'number') return
      const next = Math.max(MIN_LEFT, Math.min(maxLeft, clientX - panelLeft))
      setLeftWidth(Math.round(next))
    }
    const onUp = () => {
      setIsDragging(false)
      try {
        window.localStorage.setItem(SPLIT_STORAGE_KEY, String(leftWidthRef.current))
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
    document.addEventListener('touchcancel', onUp)

    // Cursor + text-selection lock for visual consistency while
    // dragging across the entire viewport.
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
      document.removeEventListener('touchcancel', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
    }
  }, [isDragging])

  // Reset state every time the overlay opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setTotal(0)
      setSelectedId(null)
      setCopied(false)
      // 3.3.x: always land on the Videos tab when the overlay opens,
      // even if the user left it on Folders last time.
      setActiveTab('videos')
      setFolderResults([])
      setFolderTotal(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Escape closes the overlay from anywhere inside it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Debounced search. Refires on query / expanded changes; aborts
  // an in-flight request when a fresher one comes in.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < MIN_QUERY) {
      setResults([])
      setTotal(0)
      setFolderResults([])
      setFolderTotal(0)
      setLoading(false)
      return
    }

    const abort = new AbortController()
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const url = `/api/search?q=${encodeURIComponent(trimmed)}&limit=${RESULT_LIMIT}`
        const res = await apiFetch(url, { signal: abort.signal })
        if (!res.ok) {
          setResults([])
          setTotal(0)
          setFolderResults([])
          setFolderTotal(0)
          return
        }
        const data = await res.json()
        const fresh: SearchResult[] = Array.isArray(data?.results) ? data.results : []
        setResults(fresh)
        setTotal(typeof data?.total === 'number' ? data.total : fresh.length)
        // 3.3.x: folders come back in the same payload.
        const freshFolders: FolderResult[] = Array.isArray(data?.folders) ? data.folders : []
        setFolderResults(freshFolders)
        setFolderTotal(typeof data?.folderTotal === 'number' ? data.folderTotal : freshFolders.length)
        // Auto-select the top match so the right pane is populated
        // from the first keystroke. Keep the existing selection if
        // it's still in the result set (user was inspecting it
        // before refining the query).
        if (fresh.length > 0) {
          setSelectedId((prev) =>
            prev && fresh.some((r) => r.id === prev) ? prev : fresh[0].id,
          )
        } else {
          setSelectedId(null)
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          setResults([])
          setTotal(0)
          setFolderResults([])
          setFolderTotal(0)
        }
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [query, open])

  const selected = useMemo(
    () => results.find((r) => r.id === selectedId) || null,
    [results, selectedId],
  )

  const navigateToVideo = useCallback(
    (r: SearchResult) => {
      const params = new URLSearchParams({ video: r.name })
      if (r.folderId) params.set('folderId', r.folderId)
      // Navigate FIRST so the share-page route resolves while the
      // overlay is still mounted; closing the overlay before
      // `router.push` has had a tick can briefly unmount under a
      // loading-state of the destination page and flash a
      // "Project not found" card. Defer onClose by a frame.
      router.push(`/admin/projects/${r.projectId}/share?${params.toString()}`)
      requestAnimationFrame(() => onClose())
    },
    [router, onClose],
  )

  // 3.3.x: open a folder from the Folders tab — same deferred-close
  // pattern as videos so the destination route resolves cleanly.
  const navigateToFolder = useCallback(
    (f: FolderResult) => {
      router.push(`/admin/projects/${f.projectId}/folder/${f.id}`)
      requestAnimationFrame(() => onClose())
    },
    [router, onClose],
  )

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // 3.3.x: on the Folders tab, Enter opens the first folder match.
      if (activeTab === 'folders') {
        if (e.key === 'Enter' && folderResults.length > 0) {
          e.preventDefault()
          navigateToFolder(folderResults[0])
        }
        return
      }
      if (results.length === 0) return
      const currentIdx = selected
        ? results.findIndex((r) => r.id === selected.id)
        : -1
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const nextIdx = Math.min(currentIdx + 1, results.length - 1)
        setSelectedId(results[Math.max(nextIdx, 0)].id)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const nextIdx = Math.max(currentIdx - 1, 0)
        setSelectedId(results[nextIdx].id)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        // Enter jumps into the highlighted (or first) result.
        if (selected) navigateToVideo(selected)
      }
    },
    [results, selected, navigateToVideo, activeTab, folderResults, navigateToFolder],
  )

  const copyShareUrl = useCallback(async () => {
    if (!selected) return
    try {
      let url: string | null = null
      try {
        const res = await apiFetch('/api/share-video-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: selected.projectId,
            videoName: selected.name,
            folderId: selected.folderId || undefined,
          }),
        })
        if (res.ok) {
          const data = await res.json()
          if (data?.url) url = data.url
        }
      } catch {
        /* fall through */
      }
      // 1.7.0+: the share-video-link endpoint mints its URL using
      // the server's view of `request.url`, which is the LAN host
      // when the admin is browsing over WireGuard. Rewrite the
      // origin to the admin-configured public domain so the
      // copied link is reachable by remote clients — same
      // behaviour as FolderBrowser's share modal (v1.6.1).
      const publicOrigin = getPublicShareOrigin()
      if (url && publicOrigin) {
        try {
          const u = new URL(url)
          const pub = new URL(publicOrigin)
          // Set protocol + hostname + port separately. Assigning
          // `host` in one shot doesn't always clear an existing
          // port when the new host string omits one (Chromium will
          // keep the LAN's :3000 attached to framecomment.com),
          // which produces a junk URL like
          // `framecomment.com:3000/...`. Setting `port = pub.port`
          // (empty string when the public domain uses the default
          // port) reliably strips it.
          u.protocol = pub.protocol
          u.hostname = pub.hostname
          u.port = pub.port
          url = u.toString()
        } catch {
          /* keep server URL as-is if either side fails to parse */
        }
      }
      if (!url) {
        // Last-resort fallback when the signed endpoint isn't
        // available (e.g. SHARE_TOKEN_SECRET unset). Point at the
        // public share path with a name-only filter so the client
        // still lands on the right video.
        const origin = publicOrigin
        const params = new URLSearchParams({ video: selected.name })
        if (selected.folderId) params.set('folderId', selected.folderId)
        url = `${origin}/admin/projects/${selected.projectId}/share?${params.toString()}`
      }
      await copyToClipboard(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard rejected */
    }
  }, [selected])

  const downloadOriginal = useCallback(async () => {
    if (!selected || downloadBusy) return
    setDownloadBusy(true)
    try {
      const res = await apiFetch(`/api/videos/${selected.id}/download-token`, {
        method: 'POST',
      })
      if (!res.ok) return
      const data = await res.json()
      if (data?.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer')
      }
    } catch {
      /* retry will be by user */
    } finally {
      setDownloadBusy(false)
    }
  }, [selected, downloadBusy])

  if (!open) return null

  const trimmedQuery = query.trim()
  const hasQuery = trimmedQuery.length >= MIN_QUERY
  const showPanel = hasQuery && (results.length > 0 || loading)

  return (
    <div
      // 2.5.0+: no dim scrim — the same call we made for the
      // template modal. Page underneath stays visible and the
      // floating cards below carry the frosted-glass look.
      className="fixed inset-0 z-[100] bg-transparent flex flex-col items-stretch"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Global video search"
    >
      {/* Top search bar — frosted-glass pill, same recipe as the
          template modal's panels: ~6% white tint, inline 20px blur
          + saturate(140%), hairline ring + soft outward shadow.
          Explicit inline backdrop-filter so it never gets purged. */}
      <div className="w-full max-w-screen-2xl mx-auto px-3 sm:px-6 pt-3 sm:pt-6 shrink-0">
        <div
          className="rounded-xl overflow-hidden bg-white/[0.06] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
          style={{
            backdropFilter: 'blur(40px) saturate(140%)',
            WebkitBackdropFilter: 'blur(40px) saturate(140%)',
          }}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <Search className="w-5 h-5 text-white/55 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Search videos, folders…"
              className="flex-1 bg-transparent outline-none border-0 text-base text-white placeholder:text-white/45"
              aria-label="Search videos"
            />
            {loading && (
              <Loader2 className="w-4 h-4 text-white/55 animate-spin shrink-0" />
            )}
            {/* 3.3.x: Videos (default) / Folders tabs live on the right
                of the search bar. The API returns both result sets in
                one payload, so switching is instant. Only shown once a
                query is active so the empty bar stays clean. */}
            {hasQuery && (
              <div className="shrink-0 flex items-center gap-1">
                {([
                  ['videos', 'Videos', total],
                  ['folders', 'Folders', folderTotal],
                ] as const).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveTab(key as SearchTab)}
                    className={`px-2.5 py-1 rounded-lg text-[13px] font-medium ring-1 transition-colors ${
                      activeTab === key
                        ? 'bg-primary/15 text-primary ring-primary/40'
                        : 'bg-white/[0.04] text-white/60 ring-white/10 hover:bg-white/[0.1] hover:text-white'
                    }`}
                  >
                    {label}
                    {count > 0 ? ` (${count})` : ''}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-white/55 hover:text-white hover:bg-white/5 transition-colors shrink-0"
              aria-label="Close search"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Two-pane results panel — always renders the moment the
          query is long enough to have matches. Empty-state and the
          loading state both still render the panel so the layout
          doesn't jump. */}
      {hasQuery && (
        <div className="flex-1 w-full max-w-screen-2xl mx-auto px-3 sm:px-6 py-3 sm:py-4 overflow-hidden min-h-0 flex flex-col">
          {activeTab === 'videos' ? (
          <div
            ref={panelRef}
            className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[var(--search-left-w)_4px_1fr] gap-0 rounded-xl overflow-hidden bg-white/[0.06] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
            style={
              {
                // Custom property drives the left column width on
                // desktop; below md it collapses to a single column
                // via the grid-cols-1 default above.
                ['--search-left-w' as any]: `${leftWidth}px`,
                // 2.5.0+: explicit inline backdrop-filter so the
                // frosted blur lands even if a Tailwind utility
                // got purged. Same recipe as the template modal.
                backdropFilter: 'blur(40px) saturate(140%)',
                WebkitBackdropFilter: 'blur(40px) saturate(140%)',
              } as React.CSSProperties
            }
          >
            {/* Left rail */}
            <div
              className="overflow-y-auto flex flex-col min-h-0"
              // 3.5.x: darker backdrop ONLY on the results column so the
              // text reads well over bright project gradients. The card
              // itself stays frosted glass — only the results sit on a
              // darker surface.
              style={{ backgroundColor: 'rgba(8,13,24,0.55)' }}
            >
              {results.length === 0 && !loading && (
                <div className="px-4 py-6 text-sm text-white/55 text-center">
                  No videos match &ldquo;{trimmedQuery}&rdquo;.
                </div>
              )}
              <div className="divide-y divide-white/10">
                {results.map((r) => {
                  const active = r.id === selectedId
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      onDoubleClick={() => navigateToVideo(r)}
                      // 2.5.0+: brand-blue tint for the active
                      // row (same recipe as the sidebar's active
                      // link). Neutral white-5 hover for the rest.
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                        active
                          ? 'bg-primary/15 text-primary'
                          : 'hover:bg-white/5 text-white/85'
                      }`}
                    >
                      <ResultThumbnail r={r} small />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {r.name}
                        </div>
                        <div className={`text-xs truncate ${active ? 'text-primary/70' : 'text-white/55'}`}>
                          {r.projectName || 'Unknown project'}
                          {r.folderName ? ` · ${r.folderName}` : ''}
                          {r.mediaType !== 'IMAGE' && r.duration > 0
                            ? ` · ${formatDuration(r.duration)}`
                            : ''}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
              {/* When more matches exist beyond RESULT_LIMIT we hint
                  at the cap so the admin can refine the query — the
                  list itself is already fully scrollable. */}
              {total > results.length && (
                <div className="px-4 py-2.5 text-[11px] text-white/55 text-center border-t border-white/10">
                  Showing top {results.length} of {total} — refine your search to narrow down
                </div>
              )}
            </div>

            {/* Resize handle — sits between the two panes. The
                column is 4 px wide (matches the grid template) and
                gets a 1 px tick centered inside, with a wider
                invisible hit area for easier grabbing. Hidden on
                mobile (single-column layout). Double-click resets
                to the default split. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize search panes"
              onMouseDown={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onTouchStart={() => setIsDragging(true)}
              onDoubleClick={() => {
                setLeftWidth(DEFAULT_LEFT)
                try {
                  window.localStorage.setItem(
                    SPLIT_STORAGE_KEY,
                    String(DEFAULT_LEFT),
                  )
                } catch {
                  /* ignore */
                }
              }}
              className="hidden md:flex relative items-center justify-center cursor-col-resize group"
              title="Drag to resize • double-click to reset"
            >
              <span
                className={`block w-px h-full bg-white/10 group-hover:bg-primary/60 transition-colors ${
                  isDragging ? 'bg-primary w-0.5' : ''
                }`}
              />
            </div>

            {/* Right pane — preview + actions. `min-w-0` is critical
                here: without it, intrinsic-width children (long
                filenames, video tag at native size, etc.) make the
                grid track stretch past `1fr` and the whole panel
                grows a horizontal scrollbar. */}
            <div className="overflow-y-auto overflow-x-hidden min-h-0 min-w-0">
              {!showPanel ? null : !selected ? (
                <div className="h-full flex items-center justify-center text-sm text-white/55">
                  {loading ? 'Searching…' : 'Select a result to see details.'}
                </div>
              ) : (
                <DetailsPane
                  r={selected}
                  copied={copied}
                  downloadBusy={downloadBusy}
                  onCopyUrl={copyShareUrl}
                  onDownload={downloadOriginal}
                  onView={() => navigateToVideo(selected)}
                />
              )}
            </div>
          </div>
          ) : (
          /* 3.3.x: Folders tab — single full-width list. Folder names
             aren't heavy to render (no thumbnails/preview tokens), so
             a flat scrollable list keeps it as fast as the user liked
             the video search. Click a row to open that folder. */
          <div
            className="flex-1 min-h-0 rounded-xl overflow-hidden bg-white/[0.06] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white flex flex-col"
            style={{
              backdropFilter: 'blur(40px) saturate(140%)',
              WebkitBackdropFilter: 'blur(40px) saturate(140%)',
            }}
          >
            <div
              className="overflow-y-auto overflow-x-hidden min-h-0"
              // 3.5.x: same darker results backdrop as the Videos tab.
              style={{ backgroundColor: 'rgba(8,13,24,0.55)' }}
            >
              {folderResults.length === 0 ? (
                <div className="px-4 py-8 text-sm text-white/55 text-center">
                  {loading ? 'Searching…' : 'No folders match your search.'}
                </div>
              ) : (
                <div className="divide-y divide-white/10">
                  {folderResults.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => navigateToFolder(f)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.06] transition-colors"
                    >
                      <span className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25">
                        <FolderOpen className="w-4 h-4" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-white truncate">
                          {f.name}
                        </div>
                        <div className="text-xs text-white/55 truncate">
                          {f.projectName || 'Unknown project'}
                          {f.parentName ? ` · ${f.parentName}` : ''}
                          {` · ${f.videoCount} video${f.videoCount === 1 ? '' : 's'}`}
                          {f.subfolderCount > 0
                            ? ` · ${f.subfolderCount} folder${f.subfolderCount === 1 ? '' : 's'}`
                            : ''}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {folderResults.length > 0 && folderTotal > folderResults.length && (
                <div className="px-4 py-2.5 text-[11px] text-white/55 text-center border-t border-white/10">
                  Showing top {folderResults.length} of {folderTotal} — refine your search to narrow down
                </div>
              )}
            </div>
          </div>
          )}
        </div>
      )}

      {/* Empty filler so the backdrop fills the rest of the screen
          when the user hasn't started typing yet. Click closes. */}
      {!hasQuery && <div className="flex-1" onMouseDown={onClose} />}
    </div>
  )
}

function ResultThumbnail({ r, small }: { r: SearchResult; small?: boolean }) {
  const [errored, setErrored] = useState(false)
  const hasThumb = !!r.thumbnailUrl && !errored
  const isImage = r.mediaType === 'IMAGE'
  // List rows want a fixed visual height so the rail stays aligned,
  // but vertical clips (9:16 etc.) need narrow thumbnails so they
  // don't get stretched. We give the wrapper a fixed height, set
  // the aspect-ratio from the real source dimensions, and use a
  // min-width so portrait thumbnails don't collapse to a thin
  // sliver. The full-size preview pane (small=false) still fills
  // its parent's width via the DetailsPane wrapper.
  const aspectRatio =
    r.width > 0 && r.height > 0 ? `${r.width} / ${r.height}` : '16 / 9'
  const wrapperClass = small
    ? 'h-11 min-w-[28px] max-w-[80px] shrink-0 rounded bg-muted overflow-hidden flex items-center justify-center relative'
    : 'w-full aspect-video shrink-0 rounded bg-muted overflow-hidden flex items-center justify-center relative'
  return (
    <div
      className={wrapperClass}
      style={small ? { aspectRatio } : undefined}
    >
      {hasThumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={r.thumbnailUrl!}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : isImage ? (
        <ImageIcon className="w-4 h-4 text-muted-foreground" />
      ) : (
        <Film className="w-4 h-4 text-muted-foreground" />
      )}
      {!small && !isImage && r.duration > 0 && (
        <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs font-medium tabular-nums">
          {formatDuration(r.duration)}
        </span>
      )}
    </div>
  )
}

/**
 * Right-pane media preview. Renders a real `<video>` element with
 * native controls (play / pause / scrubber / volume / fullscreen)
 * when a preview URL is available, otherwise falls back to the
 * thumbnail tag. Images render via the thumbnail path. The
 * wrapper enforces the real source aspect ratio so portrait clips
 * don't get letter-boxed.
 */
function VideoPreview({
  r,
  aspectRatio,
}: {
  r: SearchResult
  aspectRatio: string
}) {
  const [errored, setErrored] = useState(false)
  const isImage = r.mediaType === 'IMAGE'
  const hasPreview = !isImage && !!r.previewUrl && !errored
  const hasThumb = !!r.thumbnailUrl

  return (
    <div
      className="w-full bg-black rounded-lg overflow-hidden flex items-center justify-center max-h-[55vh]"
      style={{ aspectRatio }}
    >
      {hasPreview ? (
        <video
          // Re-mount per video so the player resets to t=0 when the
          // user picks a new result instead of preserving the
          // previous playhead.
          key={r.id}
          src={r.previewUrl!}
          poster={r.thumbnailUrl || undefined}
          controls
          preload="metadata"
          playsInline
          className="w-full h-full object-contain bg-black"
          onError={() => setErrored(true)}
        />
      ) : hasThumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={r.thumbnailUrl!}
          alt=""
          className="w-full h-full object-contain"
        />
      ) : isImage ? (
        <ImageIcon className="w-10 h-10 text-muted-foreground" />
      ) : (
        <Film className="w-10 h-10 text-muted-foreground" />
      )}
    </div>
  )
}

function DetailsPane({
  r,
  copied,
  downloadBusy,
  onCopyUrl,
  onDownload,
  onView,
}: {
  r: SearchResult
  copied: boolean
  downloadBusy: boolean
  onCopyUrl: () => void
  onDownload: () => void
  onView: () => void
}) {
  const size = formatBytes(r.originalFileSize)
  const resolution =
    r.width > 0 && r.height > 0 ? `${r.width}×${r.height}` : null
  // 1.7.0+: honour the actual video aspect ratio (portrait /
  // landscape / square) so a 9:16 vertical doesn't get letter-
  // boxed inside a 16:9 box. Fall back to 16:9 when dimensions
  // aren't known yet (still-processing rows).
  const aspectRatio =
    r.width > 0 && r.height > 0 ? `${r.width} / ${r.height}` : '16 / 9'
  return (
    <div className="p-4 sm:p-6 space-y-4 min-w-0">
      {/* 3.5.x: black "stage" behind the preview. Negative margins
          bleed it to the pane's top + left + right edges (cancelling
          the panel padding) so the area around and above the video is
          black like the clip's own bars; inner padding keeps the video
          inset as before. The area BELOW the video stays on the glass
          panel (only the metadata sits there). */}
      <div className="-mt-4 sm:-mt-6 -mx-4 sm:-mx-6 px-4 sm:px-6 pt-4 sm:pt-6 bg-black">
        <VideoPreview r={r} aspectRatio={aspectRatio} />
      </div>
      <div className="min-w-0">
        {/* `break-words` (combined with `break-all` for long
            unbroken tokens like uppercase filenames) lets a long
            title fall to a second line when the right pane shrinks
            instead of overflowing horizontally. */}
        <h2 className="text-lg font-semibold leading-tight break-words [overflow-wrap:anywhere] text-white">
          {r.name}
        </h2>
        <p className="text-xs text-white/55 mt-1 flex items-center gap-1 break-words [overflow-wrap:anywhere]">
          <FolderOpen className="w-3.5 h-3.5 shrink-0" />
          <span className="min-w-0">
            {r.projectName || 'Unknown project'}
            {r.folderName ? ` / ${r.folderName}` : ''}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Meta label="File" value={r.originalFileName} />
        <Meta label="Size" value={size} />
        {resolution && <Meta label="Resolution" value={resolution} />}
        {r.mediaType !== 'IMAGE' && r.duration > 0 && (
          <Meta label="Duration" value={formatDuration(r.duration)} />
        )}
        {r.versionLabel && <Meta label="Version" value={r.versionLabel} />}
        <Meta
          label="Uploaded"
          value={new Date(r.createdAt).toLocaleDateString()}
        />
      </div>

      {/* `flex-nowrap` keeps the three actions glued to a single
          row; the parent right-pane minimum width (MIN_RIGHT in the
          overlay) is sized to always fit them all so wrapping
          shouldn't happen at desktop widths. `shrink-0` on each
          button prevents Tailwind's default flex shrink from
          chopping a button's label when space is tight. */}
      <div className="flex flex-nowrap gap-2 pt-3 border-t border-white/10">
        {/* 2.5.0+: action chips share the modal's frosted-glass
            vocabulary — white-7 tinted, hairline white-10 ring,
            shadow for depth. Same recipe as the YT/UGC cards. */}
        <button
          type="button"
          onClick={onCopyUrl}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md ring-1 ring-white/10 bg-white/[0.07] hover:bg-white/[0.12] hover:ring-white/20 text-white text-sm transition-all shadow-[0_2px_8px_-4px_rgba(0,0,0,0.4)] shrink-0"
          title="Copy share link"
        >
          {copied ? (
            <>
              <Check className="w-4 h-4 text-green-400" /> Copied
            </>
          ) : (
            <>
              <Copy className="w-4 h-4" /> Copy URL
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={downloadBusy}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md ring-1 ring-white/10 bg-white/[0.07] hover:bg-white/[0.12] hover:ring-white/20 text-white text-sm transition-all shadow-[0_2px_8px_-4px_rgba(0,0,0,0.4)] disabled:opacity-60 shrink-0"
          title="Download original file"
        >
          {downloadBusy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Download
        </button>
        <button
          type="button"
          onClick={onView}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md ring-1 ring-white/10 bg-white/[0.07] hover:bg-white/[0.12] hover:ring-white/20 text-white text-sm transition-all shadow-[0_2px_8px_-4px_rgba(0,0,0,0.4)] shrink-0"
          title="Open in project"
        >
          <ExternalLink className="w-4 h-4" />
          View in Project
        </button>
      </div>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-white/45 font-medium">
        {label}
      </div>
      {/* `overflow-wrap: anywhere` breaks the long filename strings
          across multiple lines instead of truncating with an
          ellipsis — keeps the full value visible no matter how
          narrow the right pane gets. */}
      <div className="text-sm break-words [overflow-wrap:anywhere]" title={value}>
        {value}
      </div>
    </div>
  )
}
