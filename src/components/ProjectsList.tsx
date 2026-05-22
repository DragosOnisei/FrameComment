'use client'

import { useEffect, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Plus, ArrowUpDown, Lock } from 'lucide-react'
import ViewModeToggle, { type ViewMode } from '@/components/ViewModeToggle'
import ProjectCardKebab from '@/components/ProjectCardKebab'
import { formatDate } from '@/lib/utils'
import { projectGradient, formatBytes, formatRelativeTime } from '@/lib/project-gradient'
import ProjectCoverImage from '@/components/ProjectCoverImage'

interface Project {
  id: string
  title: string
  slug: string
  companyName: string | null
  status: string
  sharePassword?: boolean
  authMode?: string
  createdAt: Date
  updatedAt: Date
  maxRevisions: number
  enableRevisions: boolean
  dueDate: string | null
  videos: any[]
  recipients: any[]
  _count: { comments: number; videos: number; folders: number }
  /** Total bytes of all videos in this project, serialised as string
   *  to survive BigInt → JSON. Falls back to '0' when missing. */
  totalSize?: string
}

interface ProjectsListProps {
  projects: Project[]
  /** Called after a card kebab action mutates a project (archive,
   *  delete) so the parent can re-fetch the list. Falls back to a
   *  router.refresh() inside the kebab if not supplied. */
  onProjectMutated?: () => void
  /**
   * 1.2.0+: when provided, the "+ New Project" tile and the empty
   *  state CTA open the Frame.io-style modal hosted by the parent
   *  instead of navigating to the legacy `/admin/projects/new` page.
   */
  onNewProject?: () => void
}

export default function ProjectsList({ projects, onProjectMutated, onNewProject }: ProjectsListProps) {
  const t = useTranslations('projects')
  const tc = useTranslations('common')
  const tn = useTranslations('nav')
  const locale = useLocale()
  const [sortMode, setSortMode] = useState<'status' | 'alphabetical' | 'alphabetical-reverse' | 'dueDate'>(() => {
    // Load sort mode from localStorage
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('admin_projects_sort_mode')
      if (stored === 'status' || stored === 'alphabetical' || stored === 'alphabetical-reverse' || stored === 'dueDate') {
        return stored
      }
    }
    return 'alphabetical'
  })
  // 1.2.0+: lazy initial value so the first render already reflects
  // the saved preference. Previously the initial state was hard-coded
  // to 'grid' and a useEffect synced FROM localStorage on mount — but
  // a sibling effect then SYNCED BACK 'grid' to localStorage before
  // the read effect committed, wiping the saved preference on every
  // reload. Both effects collapse into the lazy init below.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'grid'
    const stored = localStorage.getItem('admin_projects_view')
    if (stored === 'grid' || stored === 'table') return stored
    // Migrate the old 'list' preference to 'table'.
    if (stored === 'list') return 'table'
    return 'grid'
  })

  useEffect(() => {
    localStorage.setItem('admin_projects_view', viewMode)
  }, [viewMode])

  // Save sort mode to localStorage
  useEffect(() => {
    localStorage.setItem('admin_projects_sort_mode', sortMode)
  }, [sortMode])

  // If the user previously selected status/dueDate, snap back to A-Z
  // so the visible button label always matches the actual order.
  useEffect(() => {
    if (sortMode !== 'alphabetical' && sortMode !== 'alphabetical-reverse') {
      setSortMode('alphabetical')
    }
  }, [sortMode])

  function getDueDateColor(dueDate: string, status: string): string {
    // Completed projects (approved, archived, share-only) should never show overdue styling
    if (status === 'APPROVED' || status === 'ARCHIVED' || status === 'SHARE_ONLY') {
      return 'text-muted-foreground'
    }
    const due = new Date(dueDate)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate())
    const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86400000)
    if (diffDays < 0) return 'text-destructive'
    if (diffDays <= 1) return 'text-warning'
    if (diffDays <= 7) return 'text-primary'
    return 'text-muted-foreground'
  }

  // Show every project — no status filter applied (1.0.6+).
  const sortedProjects = [...projects].sort((a, b) => {
    if (sortMode === 'alphabetical') {
      return a.title.localeCompare(b.title)
    } else if (sortMode === 'alphabetical-reverse') {
      return b.title.localeCompare(a.title)
    } else if (sortMode === 'dueDate') {
      // Projects with due dates first, sorted earliest first
      if (!a.dueDate && !b.dueDate) return a.title.localeCompare(b.title)
      if (!a.dueDate) return 1
      if (!b.dueDate) return -1
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
    } else {
      // Status sorting
      const statusPriority: Record<string, number> = { IN_REVIEW: 1, SHARE_ONLY: 2, APPROVED: 3, ARCHIVED: 4 }
      const priorityDiff = (statusPriority[a.status] || 99) - (statusPriority[b.status] || 99)
      if (priorityDiff !== 0) return priorityDiff
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    }
  })

  return (
    <>
      {projects.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2 mb-3">
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSortMode(
                sortMode === 'alphabetical' ? 'alphabetical-reverse' : 'alphabetical',
              )
            }
            title={sortMode === 'alphabetical' ? t('zToA') : t('aToZ')}
          >
            <ArrowUpDown className="w-4 h-4" />
            <span className="hidden sm:inline ml-2">
              {sortMode === 'alphabetical' ? t('aToZ') : t('zToA')}
            </span>
          </Button>
        </div>
      )}

      {projects.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">{t('noProjectsYet')}</p>
            {onNewProject ? (
              <Button variant="default" size="default" onClick={onNewProject}>
                <Plus className="w-4 h-4 mr-2" />
                {t('createFirst')}
              </Button>
            ) : (
              <Link href="/admin/projects/new">
                <Button variant="default" size="default">
                  <Plus className="w-4 h-4 mr-2" />
                  {t('createFirst')}
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : viewMode === 'grid' ? (
        // Frame.io-style tile grid (1.0.6+). Each project is a square
        // gradient cover with the project name + folder count + total
        // size below; kebab lives in the footer next to the
        // "Updated 2h ago" timestamp. A "New Project" placeholder sits
        // at the end of the grid so creating one feels in-flow.
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {sortedProjects.map((project) => {
            const folderCount = project._count?.folders ?? 0
            const sizeLabel = formatBytes(project.totalSize)
            const isLocked =
              !!project.sharePassword ||
              (project.authMode && project.authMode !== 'NONE')

            return (
              <div key={project.id} className="group">
                <Link
                  href={`/admin/projects/${project.id}`}
                  className="block relative aspect-square rounded-xl overflow-hidden ring-1 ring-border/40 hover:ring-border transition-[box-shadow,outline]"
                  aria-label={project.title}
                >
                  {/* 1.2.0+: prefer an uploaded cover image; fall back
                      to the deterministic gradient. The cover image is
                      admin-gated (bearer token), so we route through
                      ProjectCoverImage which fetches via apiFetch +
                      blob URL instead of a naked <img src> that would
                      401. When a cover exists we render a neutral
                      muted backdrop underneath (NOT the gradient) so
                      the user never sees the wrong-colour gradient
                      flash before their cover loads, and no gradient
                      edge bleeds out from behind the image on hover. */}
                  {(project as any).coverImagePath ? (
                    <>
                      <div className="absolute inset-0 bg-muted" />
                      <ProjectCoverImage
                        projectId={project.id}
                        cacheKey={
                          project.updatedAt
                            ? new Date(project.updatedAt).getTime()
                            : undefined
                        }
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    </>
                  ) : (
                    // 1.2.0+: hover-zoom dropped at the user's request
                    // for a calmer dashboard — the tile still
                    // brightens its ring on hover, that's enough.
                    <div
                      className="absolute inset-0"
                      style={{ background: projectGradient(project.id) }}
                    />
                  )}
                  {isLocked && (
                    <span
                      className="absolute top-2 right-2 inline-flex items-center justify-center w-7 h-7 rounded-md bg-black/40 text-white backdrop-blur-sm"
                      title="Password protected"
                      aria-label="Password protected"
                    >
                      <Lock className="w-3.5 h-3.5" />
                    </span>
                  )}
                </Link>
                <div className="mt-2 flex items-start gap-2 min-w-0">
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/admin/projects/${project.id}`}
                      className="block text-sm font-semibold text-foreground truncate hover:underline"
                      title={project.title}
                    >
                      {project.title}
                    </Link>
                    <div className="text-xs text-muted-foreground tabular-nums mt-0.5 truncate">
                      {folderCount} {folderCount === 1 ? 'folder' : 'folders'} · {sizeLabel}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                      Updated {formatRelativeTime(project.updatedAt)}
                    </div>
                  </div>
                  <ProjectCardKebab
                    projectId={project.id}
                    projectSlug={project.slug}
                    projectTitle={project.title}
                    projectStatus={project.status}
                    projectFolderCount={project._count?.folders ?? 0}
                    projectVideoCount={project._count?.videos ?? 0}
                    onMutated={onProjectMutated}
                  />
                </div>
              </div>
            )
          })}

          {/* + New Project tile — same footprint as a project, dark
              dashed look so it reads as "add" without taking colour
              away from the real tiles. 1.2.0+: when a parent passes
              `onNewProject`, the tile opens that modal instead of
              navigating to the legacy /new page. */}
          {onNewProject ? (
            <button
              type="button"
              onClick={onNewProject}
              className="group flex flex-col items-center justify-center aspect-square rounded-xl border border-dashed border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground hover:border-border transition-colors"
              aria-label={t('newProject')}
            >
              <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted/60 group-hover:bg-muted transition-colors">
                <Plus className="w-6 h-6" />
              </span>
              <span className="mt-3 text-sm font-medium">{t('newProject')}</span>
            </button>
          ) : (
            <Link
              href="/admin/projects/new"
              className="group flex flex-col items-center justify-center aspect-square rounded-xl border border-dashed border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground hover:border-border transition-colors"
              aria-label={t('newProject')}
            >
              <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted/60 group-hover:bg-muted transition-colors">
                <Plus className="w-6 h-6" />
              </span>
              <span className="mt-3 text-sm font-medium">{t('newProject')}</span>
            </Link>
          )}
        </div>
      ) : (
        /* Table View */
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-4 sm:px-5 py-2.5 border-b bg-muted/30">
            <span className="text-sm font-medium">{tn('projects')}</span>
            <span className="text-xs text-muted-foreground">{sortedProjects.length} {t('projectsCount')}</span>
          </div>
          {/* Table Header — status column removed (1.0.6+); videos &
              comments columns swapped for folders & total size.
              1.2.0+: Client + Due Date columns retired (the create
              modal no longer asks for either; both still exist in
              Project Settings if the workflow needs them). */}
          <div className="hidden sm:flex items-center gap-4 px-5 py-2 text-xs text-muted-foreground bg-muted/20 border-b">
            <span className="flex-1 min-w-0">{tc('name')}</span>
            <span className="w-20 text-center hidden lg:block">Folders</span>
            <span className="w-24 text-right hidden lg:block">Size</span>
            <span className="w-24 hidden xl:block">{tc('created')}</span>
            <span className="w-24 hidden lg:block">{tc('updated')}</span>
            <span className="w-8"></span>
          </div>
          <div className="divide-y">
            {sortedProjects.map((project) => {
              const folderCount = project._count?.folders ?? 0
              const sizeLabel = formatBytes(project.totalSize)
              const hasCover = !!(project as any).coverImagePath

              return (
                <Link
                  key={project.id}
                  href={`/admin/projects/${project.id}`}
                  className="flex items-center gap-4 px-5 py-3 text-sm hover:bg-accent/30 transition-colors"
                >
                  {/* 1.2.0+: tiny rounded thumbnail before the title,
                      Frame.io-style. Cover image when uploaded, else
                      the project gradient. Same visual identity as
                      the grid view tile, just at avatar size. */}
                  <div className="relative w-8 h-8 shrink-0 rounded-md overflow-hidden ring-1 ring-border/40">
                    {hasCover ? (
                      <>
                        <div className="absolute inset-0 bg-muted" />
                        <ProjectCoverImage
                          projectId={project.id}
                          cacheKey={
                            project.updatedAt
                              ? new Date(project.updatedAt).getTime()
                              : undefined
                          }
                          className="absolute inset-0 w-full h-full object-cover"
                        />
                      </>
                    ) : (
                      <div
                        className="absolute inset-0"
                        style={{ background: projectGradient(project.id) }}
                      />
                    )}
                  </div>
                  <span className="flex-1 min-w-0 font-medium truncate">{project.title}</span>
                  <span className="w-20 text-center text-xs text-muted-foreground tabular-nums hidden lg:block">{folderCount}</span>
                  <span className="w-24 text-right text-xs text-muted-foreground tabular-nums hidden lg:block">{sizeLabel}</span>
                  <span className="w-24 text-xs text-muted-foreground hidden xl:block">
                    {formatDate(project.createdAt)}
                  </span>
                  <span className="w-24 text-xs text-muted-foreground hidden lg:block">
                    {formatDate(project.updatedAt)}
                  </span>
                  <ProjectCardKebab
                    projectId={project.id}
                    projectSlug={project.slug}
                    projectTitle={project.title}
                    projectStatus={project.status}
                    projectFolderCount={project._count?.folders ?? 0}
                    projectVideoCount={project._count?.videos ?? 0}
                    onMutated={onProjectMutated}
                  />
                </Link>
              )
            })}

            {/* 1.2.0+: in-flow "New Project" row at the end of the
                table, mirroring the grid view's `+` tile. Calls the
                parent-supplied modal opener so the same Frame.io-
                style composer pops up. */}
            {onNewProject ? (
              <button
                type="button"
                onClick={onNewProject}
                className="w-full flex items-center gap-4 px-5 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors text-left"
              >
                <div className="w-8 h-8 shrink-0 rounded-md border border-dashed border-border/60 bg-muted/30 flex items-center justify-center">
                  <Plus className="w-4 h-4" />
                </div>
                <span className="flex-1 min-w-0 font-medium">{t('newProject')}</span>
              </button>
            ) : (
              <Link
                href="/admin/projects/new"
                className="w-full flex items-center gap-4 px-5 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
              >
                <div className="w-8 h-8 shrink-0 rounded-md border border-dashed border-border/60 bg-muted/30 flex items-center justify-center">
                  <Plus className="w-4 h-4" />
                </div>
                <span className="flex-1 min-w-0 font-medium">{t('newProject')}</span>
              </Link>
            )}
          </div>
        </Card>
      )}
    </>
  )
}
