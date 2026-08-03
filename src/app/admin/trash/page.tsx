'use client'

/**
 * Trash page (1.0.8+).
 *
 * Global view of every soft-deleted folder and video across the
 * admin's scope. The list is rendered as a collapsible tree that
 * mirrors the original folder hierarchy at the moment of deletion:
 * when a folder gets trashed every video and sub-folder inside it
 * cascades along, and on this page they nest under their original
 * parent instead of flooding the top level.
 *
 * Actions per row:
 *   • Restore — un-trash the item (folder restores its subtree, video
 *     restores every version).
 *   • Delete permanently — wipe the row + storage right now.
 *
 * Top-bar action:
 *   • Empty Trash — permanently remove everything at once.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Film as FilmIcon,
  Folder as FolderIcon,
  FileText,
  Loader2,
  Lock,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { ConfirmModal } from '@/components/ConfirmModal'
import { logError } from '@/lib/logging'
import { useDownloadManager } from '@/contexts/DownloadManager'

interface TrashItem {
  /** 1.2.0+: projects can be trashed too. They render as top-level
   *  entries with the project gradient as a thumbnail; restore brings
   *  the whole subtree (videos + folders + comments) back at once. */
  kind: 'video' | 'folder' | 'project' | 'document'
  id: string
  /** For video groups, all version ids — used so Permanent Delete
   *  wipes every version, not just the latest (1.0.8+). */
  allIds?: string[]
  name: string
  versionCount?: number
  thumbnailUrl?: string | null
  duration?: number | null
  projectId: string
  projectTitle: string
  projectSlug: string | null
  parent: { kind: string; id: string | null; name: string }
  deletedAt: string
  expiresAt: string
  /** Whether a trashed project has an uploaded cover image. */
  hasCover?: boolean
}

export default function TrashPage() {
  // 5.10.1: tenant companies see the 24h purge-window note (the throttle
  // doesn't apply to the platform org).
  const { user: authUser } = useAuth()
  const isPlatformUser = (authUser as any)?.isPlatformOrg !== false

  // 5.10.2: live clock for the per-project purge countdown (tenant
  // 24h Trash window). 30s tick keeps the "Xh Ym" label honest
  // without meaningful render cost.
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // 5.10.2: tenant safety window — a trashed PROJECT can only be
  // purged 24h after it entered Trash (mirrors the server gate in
  // src/lib/danger-zone.ts; the platform org is exempt). Returns the
  // remaining lock in ms, or 0 when purge is available. Defined
  // before the handlers below that list it as a dependency.
  const purgeLockMs = useCallback(
    (item: TrashItem) => {
      if (isPlatformUser || item.kind !== 'project') return 0
      const readyAt = new Date(item.deletedAt).getTime() + 24 * 60 * 60 * 1000
      return Math.max(0, readyAt - nowTs)
    },
    [isPlatformUser, nowTs],
  )

  // 3.3.x: bottom-right progress banner (shared download/task manager,
  // mounted in the admin layout) so emptying Trash runs in the
  // background with a "Deleting … / N items" bar instead of freezing
  // the page behind one giant blocking request.
  const { startManualDownload } = useDownloadManager()
  const [items, setItems] = useState<TrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // Folders default to expanded so the user sees the cascade at a
  // glance; tracking the COLLAPSED set lets us key by id without
  // having to seed every folder up front.
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(
    new Set(),
  )
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    description?: React.ReactNode
    confirmLabel?: string
    busy?: boolean
    onConfirm?: () => Promise<void> | void
  }>({ open: false, title: '' })

  const fetchTrash = useCallback(async () => {
    try {
      setLoading(true)
      const res = await apiFetch('/api/trash')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(data.items || [])
      setError(null)
    } catch (err) {
      logError('[TrashPage] fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load Trash')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTrash()
  }, [fetchTrash])

  const markBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleCollapsed = (folderId: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const handleRestore = useCallback(
    async (item: TrashItem) => {
      markBusy(item.id, true)
      try {
        const res = await apiFetch(
          `/api/trash/${item.kind}/${item.id}/restore`,
          { method: 'POST' },
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to restore')
        }
        // 1.2.1+: restoring removes the item from Trash — refresh
        // the AdminHeader badge so the count drops immediately.
        window.dispatchEvent(new CustomEvent('trash:changed'))
        await fetchTrash()
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to restore')
      } finally {
        markBusy(item.id, false)
      }
    },
    [fetchTrash],
  )

  const handlePermanentDelete = useCallback(
    (item: TrashItem) => {
      setConfirmState({
        open: true,
        title: 'Delete permanently?',
        description: (
          <>
            <span className="font-medium text-foreground">{item.name}</span>{' '}
            will be deleted right now. This action cannot be undone.
            {item.kind === 'project' && !isPlatformUser && (
              // 5.10.2: safety note as its own section — divider +
              // exclamation icon (span-only: description is a <p>).
              <span className="mt-3 pt-3 border-t border-white/10 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
                <span className="text-amber-400">
                  For safety, a project must stay in Trash for 24 hours
                  before it can be permanently deleted.
                </span>
              </span>
            )}
          </>
        ),
        confirmLabel: 'Delete permanently',
        onConfirm: async () => {
          setConfirmState((s) => ({ ...s, busy: true }))
          try {
            if (item.kind === 'folder') {
              const res = await apiFetch(
                `/api/folders/${item.id}?permanent=1`,
                { method: 'DELETE' },
              )
              if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error(err.error || 'Failed to delete')
              }
            } else if (item.kind === 'project') {
              // 1.2.1+: projects route to their own DELETE endpoint
              // with ?permanent=1. The previous build fell through
              // to the video branch and silently 404'd, leaving the
              // project stuck in Trash.
              const res = await apiFetch(
                `/api/projects/${item.id}?permanent=1`,
                { method: 'DELETE' },
              )
              if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error(err.error || 'Failed to delete')
              }
            } else if (item.kind === 'document') {
              const res = await apiFetch(
                `/api/documents/${item.id}?permanent=true`,
                { method: 'DELETE' },
              )
              if (!res.ok && res.status !== 404) {
                const err = await res.json().catch(() => ({}))
                throw new Error(err.error || 'Failed to delete')
              }
            } else {
              const ids =
                item.allIds && item.allIds.length > 0
                  ? item.allIds
                  : [item.id]
              const errors: string[] = []
              for (const id of ids) {
                const res = await apiFetch(
                  `/api/videos/${id}?permanent=1`,
                  { method: 'DELETE' },
                )
                if (!res.ok && res.status !== 404) {
                  const err = await res.json().catch(() => ({}))
                  errors.push(err.error || `HTTP ${res.status}`)
                }
              }
              if (errors.length > 0) {
                throw new Error(errors[0])
              }
            }
            // 1.2.1+: permanently removing an item drops the Trash
            // count — refresh the header badge.
            window.dispatchEvent(new CustomEvent('trash:changed'))
            await fetchTrash()
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete')
          } finally {
            setConfirmState({ open: false, title: '' })
          }
        },
      })
    },
    [fetchTrash, isPlatformUser],
  )

  // 3.3.x: permanently delete a single trash item (video group /
  // folder / project). Extracted so the Empty-Trash background worker
  // can reuse it. 404 is treated as success — the row was already
  // removed (e.g. cascaded when its parent project was deleted).
  //
  // 5.12.2: 429-aware. On big sweeps (300+ items) the per-endpoint rate
  // limits kicked in near the tail and ~10 items "could not be deleted"
  // (retrying Empty Trash immediately hit the same window). Rate-limited
  // calls now wait with exponential backoff and retry instead of failing
  // the item — Empty Trash is a background banner task, so taking a few
  // extra seconds is invisible; losing items is not.
  const deleteWithBackoff = useCallback(async (url: string, signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      const res = await apiFetch(url, { method: 'DELETE' })
      if (res.status !== 429 || attempt >= 6) return res
      const waitMs = Math.min(30_000, 1500 * 2 ** attempt)
      await new Promise((r) => setTimeout(r, waitMs))
      if (signal?.aborted) return res
    }
  }, [])

  const deleteOneTrashItem = useCallback(async (item: TrashItem, signal?: AbortSignal) => {
    if (item.kind === 'folder') {
      const res = await deleteWithBackoff(`/api/folders/${item.id}?permanent=1`, signal)
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    } else if (item.kind === 'project') {
      const res = await deleteWithBackoff(`/api/projects/${item.id}?permanent=1`, signal)
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    } else if (item.kind === 'document') {
      const res = await deleteWithBackoff(`/api/documents/${item.id}?permanent=true`, signal)
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    } else {
      const ids = item.allIds && item.allIds.length > 0 ? item.allIds : [item.id]
      for (const id of ids) {
        const res = await deleteWithBackoff(`/api/videos/${id}?permanent=1`, signal)
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
      }
    }
  }, [deleteWithBackoff])

  const handleEmptyTrash = useCallback(() => {
    if (items.length === 0) return
    // 5.10.2: tenant projects inside their 24h safety window are kept —
    // together with everything that belongs to them. Without this, the
    // item-by-item delete would gut a locked project (its videos and
    // folders have no individual lock), defeating the safety window.
    const lockedProjectIds = new Set(
      items
        .filter((i) => i.kind === 'project' && purgeLockMs(i) > 0)
        .map((i) => i.id),
    )
    const snapshot = items.filter(
      (i) => !lockedProjectIds.has(i.id) && !lockedProjectIds.has(i.projectId),
    )
    const skipped = items.length - snapshot.length
    const count = snapshot.length
    if (count === 0) {
      setConfirmState({
        open: true,
        title: 'Nothing to delete yet',
        description:
          'Everything in Trash belongs to a project still inside its 24-hour safety window. Try again once the countdown on the project ends.',
        confirmLabel: 'OK',
        onConfirm: () => setConfirmState({ open: false, title: '' }),
      })
      return
    }
    setConfirmState({
      open: true,
      title: 'Empty Trash?',
      description: (
        <>
          {count} {count === 1 ? 'item' : 'items'} will be deleted
          permanently. This action cannot be undone.
          {skipped > 0 && (
            <span className="mt-3 pt-3 border-t border-white/10 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
              <span className="text-amber-400">
                {skipped} {skipped === 1 ? 'item belongs' : 'items belong'} to
                a project still inside its 24-hour safety window and will be
                kept.
              </span>
            </span>
          )}
        </>
      ),
      confirmLabel: 'Empty Trash',
      onConfirm: () => {
        // 3.3.x: close the dialog immediately and do the work in the
        // background with a progress banner — the admin can keep
        // navigating while Trash empties, even with many large items.
        setConfirmState({ open: false, title: '' })
        // Optimistically clear the list; the banner reports progress
        // and we re-sync at the end in case some deletes failed.
        // 5.10.2: locked projects (and their contents) stay visible.
        setItems((prev) =>
          prev.filter(
            (i) => lockedProjectIds.has(i.id) || lockedProjectIds.has(i.projectId),
          ),
        )
        window.dispatchEvent(new CustomEvent('trash:changed'))

        const { bumpItem, finish, signal } = startManualDownload({
          label: 'Emptying Trash',
          totalItems: count,
          unit: 'items',
          icon: 'trash',
        })

        void (async () => {
          // Projects first (their delete cascades children), then
          // videos, then folders — mirrors the server's order so a
          // cascade-removed child just 404s harmlessly.
          const rank = (k: string) => (k === 'project' ? 0 : k === 'video' ? 1 : 2)
          const ordered = [...snapshot].sort((a, b) => rank(a.kind) - rank(b.kind))
          let next = 0
          let failed = 0
          const CONCURRENCY = 3
          const worker = async () => {
            while (next < ordered.length) {
              if (signal.aborted) return
              const item = ordered[next++]
              try {
                await deleteOneTrashItem(item, signal)
              } catch (err) {
                failed++
                logError('[TrashPage] empty: item delete failed', err)
              }
              bumpItem()
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, ordered.length) }, () => worker()),
          )
          finish(
            failed > 0 ? 'error' : 'success',
            failed > 0 ? `${failed} item${failed === 1 ? '' : 's'} could not be deleted` : undefined,
          )
          window.dispatchEvent(new CustomEvent('trash:changed'))
          // Re-sync the list (restores any rows that failed to delete).
          void fetchTrash()
        })()
      },
    })
  }, [items, startManualDownload, deleteOneTrashItem, fetchTrash, purgeLockMs])

  const daysLeft = (expiresAt: string) => {
    const ms = new Date(expiresAt).getTime() - Date.now()
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
  }

  // Build a tree per project (1.0.8+). Folders nest videos + sub-
  // folders whose `parent.id` points to a folder that's ALSO in the
  // trash list. Anything else (root-level deletes, or items whose
  // original parent was never trashed) stays at the project's top
  // level.
  type TreeNode = TrashItem & { children: TreeNode[] }
  const projectGroups = useMemo(() => {
    const folderIds = new Set(
      items.filter((i) => i.kind === 'folder').map((i) => i.id),
    )

    const byProject = new Map<string, TrashItem[]>()
    for (const item of items) {
      const list = byProject.get(item.projectId) ?? []
      list.push(item)
      byProject.set(item.projectId, list)
    }

    return Array.from(byProject.entries()).map(([projectId, rows]) => {
      const nodeById = new Map<string, TreeNode>()
      for (const r of rows) {
        nodeById.set(r.id, { ...r, children: [] })
      }
      const roots: TreeNode[] = []
      for (const r of rows) {
        const node = nodeById.get(r.id)!
        const parentInTrash =
          r.parent?.id && folderIds.has(r.parent.id)
            ? nodeById.get(r.parent.id)
            : undefined
        if (parentInTrash) {
          parentInTrash.children.push(node)
        } else {
          roots.push(node)
        }
      }
      // Inside each folder: folders first, then videos; both
      // alphabetical so the tree reads stable on every refresh.
      const sortNodes = (list: TreeNode[]) => {
        list.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        for (const n of list) sortNodes(n.children)
      }
      sortNodes(roots)
      return {
        projectId,
        projectTitle: rows[0]?.projectTitle ?? '—',
        roots,
      }
    })
  }, [items])

  return (
    // 1.3.1+: explicit `w-full max-w-full` + `overflow-x-hidden`
    // guard rails so a long subtitle / file name in a TrashRow can
    // never push the right-hand actions (Empty Trash, Delete) off
    // the visible viewport edge on phones.
    <div className="w-full max-w-full overflow-x-hidden">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6">
      {/* 1.3.0+: min-w-0 + truncate on the description so the
          "Empty Trash" button stays visible at 360-414px viewports.
          The button collapses to icon-only on phones. */}
      <div className="flex items-center justify-between gap-3 mb-4 sm:mb-6 min-w-0">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-semibold flex items-center gap-2 min-w-0">
            <Trash2 className="w-5 h-5 sm:w-6 sm:h-6 text-muted-foreground shrink-0" />
            <span className="truncate">Trash</span>
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1 truncate">
            Items here are recoverable for 30 days, then deleted
            permanently.
          </p>
        </div>
        {items.length > 0 && (
          // 1.3.1+: destructive accent so the action stands out on
          // phones — the plain outline button was easy to miss against
          // the dark background.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // 2.5.0+: destructive glass — `bg-destructive/15` tint
            // + ring keep the dangerous action visually distinct
            // without using a solid red fill that would clash with
            // the rest of the v2.5 chrome.
            className="shrink-0 sm:h-10 sm:px-4 bg-destructive/15 hover:bg-destructive/25 ring-1 ring-destructive/30 hover:ring-destructive/50 text-destructive hover:text-destructive border-0 focus-visible:ring-destructive/60 focus-visible:ring-offset-0"
            onClick={handleEmptyTrash}
            aria-label="Empty Trash"
          >
            <Trash2 className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Empty Trash</span>
          </Button>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Loading Trash…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive p-3 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        // 2.5.0+: frosted-glass empty state, same vocabulary as the
        // rest of the v2.5 chrome. White/0.04 tint + ring + soft
        // outward shadow give the surface depth without competing
        // with the spotlight gradient. Brand-tinted glass disc holds
        // the trash icon so the surface reads "purposefully empty",
        // not "missing content".
        <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] p-10 sm:p-16 text-center">
          <div className="mx-auto inline-flex items-center justify-center w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-primary/15 ring-1 ring-primary/30">
            <Trash2 className="w-8 h-8 sm:w-10 sm:h-10 text-primary" />
          </div>
          <p className="mt-6 text-base font-medium text-white">
            Trash is empty
          </p>
          <p className="mt-1.5 text-sm text-white/55">
            Deleted projects and folders will appear here.
          </p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-8 min-w-0">
          {projectGroups.map((group) => (
            <section key={group.projectId} className="min-w-0">
              <h2 className="text-xs uppercase tracking-wide text-white/55 mb-3">
                {group.projectTitle}
              </h2>
              {/* 2.5.0+: frosted-glass panel with hairline white-10
                  divider between rows — matches the table view on
                  Projects dashboard and the settings panes. */}
              <div className="rounded-xl bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] divide-y divide-white/10 overflow-hidden min-w-0">
                {group.roots.map((node) => (
                  <TrashRow
                    key={`${node.kind}:${node.id}`}
                    node={node}
                    depth={0}
                    collapsedFolderIds={collapsedFolderIds}
                    onToggleCollapsed={toggleCollapsed}
                    busyIds={busyIds}
                    onRestore={handleRestore}
                    onPermanentDelete={handlePermanentDelete}
                    daysLeft={daysLeft}
                    purgeLockMs={purgeLockMs}
                  />
                ))}
              </div>
              {/* 2.5.0+: dropped the "Go to project →" link — the
                  user can click the project chip on any restored
                  item to navigate, and we want this surface to
                  stay focused on the trash actions only. */}
            </section>
          ))}
        </div>
      )}

      <ConfirmModal
        open={confirmState.open}
        onOpenChange={(next) =>
          setConfirmState((s) => ({ ...s, open: next }))
        }
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel={confirmState.confirmLabel}
        variant="destructive"
        busy={confirmState.busy}
        onConfirm={async () => {
          await confirmState.onConfirm?.()
        }}
        onCancel={() => setConfirmState({ open: false, title: '' })}
      />
      </div>
    </div>
  )
}

/**
 * One row of the Trash tree. Renders the item + its (collapsible)
 * children. Folders show a chevron and a child count; videos render
 * as a leaf. `depth` drives a small left indent so nested items
 * read as nested.
 */
function TrashRow({
  node,
  depth,
  collapsedFolderIds,
  onToggleCollapsed,
  busyIds,
  onRestore,
  onPermanentDelete,
  daysLeft,
  purgeLockMs,
}: {
  node: import('react').ReactElement extends never
    ? never
    : TrashItem & {
        children: any[]
      }
  depth: number
  collapsedFolderIds: Set<string>
  onToggleCollapsed: (folderId: string) => void
  busyIds: Set<string>
  onRestore: (item: TrashItem) => void
  onPermanentDelete: (item: TrashItem) => void
  daysLeft: (expiresAt: string) => number
  /** 5.10.2: remaining ms of the tenant 24h purge window (0 = free). */
  purgeLockMs: (item: TrashItem) => number
}) {
  const collapsed = collapsedFolderIds.has(node.id)
  const busy = busyIds.has(node.id)
  const hasChildren = node.children && node.children.length > 0
  const isFolder = node.kind === 'folder'

  // 5.10.2: tenant projects are purge-locked for their first 24h in
  // Trash (server enforces it; this greys out the button and shows a
  // countdown so the user isn't invited into a refused action).
  const lockMs = purgeLockMs(node)
  const lockLabel = (() => {
    if (lockMs <= 0) return null
    const totalMin = Math.ceil(lockMs / 60_000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  })()

  // 1.3.0+: tighter indent step on phones (12 vs 24) so deep nests
  // don't push the controls off-screen. Plus mobile-friendly side
  // padding on the row (p-2 vs p-3) so the 16x40 thumbnail + name +
  // Restore + X all fit at 360px.
  const isMobileDepthFactor = typeof window !== 'undefined' && window.innerWidth < 640 ? 12 : 24
  return (
    <>
      <div
        className="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 min-w-0 w-full"
        style={{ paddingLeft: 8 + depth * isMobileDepthFactor }}
      >
        {/* Chevron / spacer. Folders with children get a chevron;
            videos + empty folders get a same-width placeholder so
            every row aligns visually. */}
        {isFolder && hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleCollapsed(node.id)}
            className="rounded-md p-1 text-white/55 hover:text-white hover:bg-white/[0.08] transition-colors shrink-0"
            aria-label={collapsed ? 'Expand folder' : 'Collapse folder'}
          >
            {collapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
        ) : (
          <span className="w-6 h-6 shrink-0" />
        )}

        <div className="relative w-16 h-10 rounded-md bg-white/[0.04] ring-1 ring-white/10 overflow-hidden flex items-center justify-center shrink-0">
          {node.kind === 'video' && node.thumbnailUrl ? (
            <img
              src={node.thumbnailUrl}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : isFolder ? (
            <FolderIcon className="w-5 h-5 text-primary/70" />
          ) : node.kind === 'document' ? (
            <FileText className="w-5 h-5 text-primary/70" />
          ) : (
            <FilmIcon className="w-5 h-5 text-white/55" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate text-white">
            {node.name}
            {node.kind === 'video' &&
              typeof node.versionCount === 'number' &&
              node.versionCount > 1 && (
                <span className="ml-2 text-xs text-white/55 tabular-nums">
                  · {node.versionCount} versions
                </span>
              )}
            {isFolder && hasChildren && (
              <span className="ml-2 text-xs text-white/55 tabular-nums">
                · {node.children.length}{' '}
                {node.children.length === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>
          <div className="text-xs text-white/55 truncate">
            From: {node.parent?.name ?? '—'} ·{' '}
            {daysLeft(node.expiresAt)} day
            {daysLeft(node.expiresAt) === 1 ? '' : 's'} left
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* 2.5.0+: glass-style action buttons — same recipe as the
              other v2.5 row actions. Restore stays neutral white,
              the permanent-delete X gets a red tint via the
              destructive token so it reads as the dangerous path. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onRestore(node)}
            aria-label="Restore"
            className="bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 hover:ring-white/20 text-white border-0"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Undo2 className="w-4 h-4 sm:mr-1.5" />
            )}
            <span className="hidden sm:inline">Restore</span>
          </Button>
          {lockLabel ? (
            // 5.10.2: purge-locked tenant project — greyed-out lock
            // button + live countdown until permanent delete unlocks.
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled
              aria-label={`Permanent delete available in ${lockLabel}`}
              title={`For safety, a project must stay in Trash for 24 hours. You can delete it permanently in ${lockLabel}.`}
              className="bg-white/[0.04] ring-1 ring-white/10 text-white/40 border-0 disabled:opacity-100 cursor-not-allowed gap-1.5"
            >
              <Lock className="w-3.5 h-3.5" />
              <span className="text-[11px] tabular-nums text-amber-400/90">
                {lockLabel}
              </span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // 2.5.0+: focus-visible ring forced to destructive too,
              // otherwise the default brand-blue focus ring bleeds
              // into the red icon and reads as a mixed cyan tint on
              // click/keyboard focus.
              className="bg-destructive/15 hover:bg-destructive/25 ring-1 ring-destructive/30 hover:ring-destructive/50 text-destructive hover:text-destructive border-0 focus-visible:ring-destructive/60 focus-visible:ring-offset-0"
              disabled={busy}
              onClick={() => onPermanentDelete(node)}
              aria-label="Delete permanently"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Children — recursive render, hidden when the parent is
          collapsed. */}
      {isFolder && hasChildren && !collapsed && (
        <div className="bg-muted/10">
          {node.children.map((child: any) => (
            <TrashRow
              key={`${child.kind}:${child.id}`}
              node={child}
              depth={depth + 1}
              collapsedFolderIds={collapsedFolderIds}
              onToggleCollapsed={onToggleCollapsed}
              busyIds={busyIds}
              onRestore={onRestore}
              onPermanentDelete={onPermanentDelete}
              daysLeft={daysLeft}
              purgeLockMs={purgeLockMs}
            />
          ))}
        </div>
      )}
    </>
  )
}
