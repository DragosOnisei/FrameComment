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
  ChevronDown,
  ChevronRight,
  Film as FilmIcon,
  Folder as FolderIcon,
  Loader2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { ConfirmModal } from '@/components/ConfirmModal'
import { logError } from '@/lib/logging'

interface TrashItem {
  kind: 'video' | 'folder'
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
}

export default function TrashPage() {
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
            await fetchTrash()
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete')
          } finally {
            setConfirmState({ open: false, title: '' })
          }
        },
      })
    },
    [fetchTrash],
  )

  const handleEmptyTrash = useCallback(() => {
    if (items.length === 0) return
    setConfirmState({
      open: true,
      title: 'Empty Trash?',
      description: `${items.length} ${items.length === 1 ? 'item' : 'items'} will be deleted permanently. This action cannot be undone.`,
      confirmLabel: 'Empty Trash',
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, busy: true }))
        try {
          const res = await apiFetch('/api/trash/empty', { method: 'POST' })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || 'Failed to empty Trash')
          }
          await fetchTrash()
        } catch (err) {
          alert(err instanceof Error ? err.message : 'Failed to empty Trash')
        } finally {
          setConfirmState({ open: false, title: '' })
        }
      },
    })
  }, [items.length, fetchTrash])

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
    <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-6">
      <div className="flex items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Trash2 className="w-6 h-6 text-muted-foreground" />
            Trash
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Items here are recoverable for 30 days, then deleted
            permanently.
          </p>
        </div>
        {items.length > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={handleEmptyTrash}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Empty Trash
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
        <div className="rounded-2xl border border-dashed border-border/50 bg-card/40 p-16 text-center">
          <Trash2 className="w-12 h-12 mx-auto text-muted-foreground/40" />
          <p className="mt-4 text-sm text-muted-foreground">
            Trash is empty.
          </p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-8">
          {projectGroups.map((group) => (
            <section key={group.projectId}>
              <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-3">
                {group.projectTitle}
              </h2>
              <div className="rounded-xl border border-border/50 bg-card divide-y divide-border/40 overflow-hidden">
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
                  />
                ))}
              </div>
              {group.projectId && (
                <div className="mt-2 text-xs text-muted-foreground">
                  <Link
                    href={`/admin/projects/${group.projectId}`}
                    className="hover:text-foreground"
                  >
                    Go to project →
                  </Link>
                </div>
              )}
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
}) {
  const collapsed = collapsedFolderIds.has(node.id)
  const busy = busyIds.has(node.id)
  const hasChildren = node.children && node.children.length > 0
  const isFolder = node.kind === 'folder'

  return (
    <>
      <div
        className="flex items-center gap-3 p-3"
        style={{ paddingLeft: 12 + depth * 24 }}
      >
        {/* Chevron / spacer. Folders with children get a chevron;
            videos + empty folders get a same-width placeholder so
            every row aligns visually. */}
        {isFolder && hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleCollapsed(node.id)}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
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

        <div className="relative w-16 h-10 rounded-md bg-muted/40 ring-1 ring-border/30 overflow-hidden flex items-center justify-center shrink-0">
          {node.kind === 'video' && node.thumbnailUrl ? (
            <img
              src={node.thumbnailUrl}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
            />
          ) : isFolder ? (
            <FolderIcon className="w-5 h-5 text-primary/70" />
          ) : (
            <FilmIcon className="w-5 h-5 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">
            {node.name}
            {node.kind === 'video' &&
              typeof node.versionCount === 'number' &&
              node.versionCount > 1 && (
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  · {node.versionCount} versions
                </span>
              )}
            {isFolder && hasChildren && (
              <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                · {node.children.length}{' '}
                {node.children.length === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            From: {node.parent?.name ?? '—'} ·{' '}
            {daysLeft(node.expiresAt)} day
            {daysLeft(node.expiresAt) === 1 ? '' : 's'} left
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onRestore(node)}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Undo2 className="w-4 h-4 mr-1.5" />
            )}
            Restore
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => onPermanentDelete(node)}
          >
            <X className="w-4 h-4" />
          </Button>
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
            />
          ))}
        </div>
      )}
    </>
  )
}
