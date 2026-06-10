'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations, useLocale } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Plus, ArrowUpDown, Lock } from 'lucide-react'
import { type ViewMode } from '@/components/ViewModeToggle'
import { useAdminViewMode } from '@/lib/use-admin-view-mode'
import { useAdminSortMode } from '@/lib/use-admin-sort-mode'
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
  const router = useRouter()

  /**
   * 2.5.1+: Frame.io-style enter-on-double-click for project tiles.
   * Mirrors the FolderCard / VideoCard behaviour the rest of the
   * admin uses — a single click on a tile is now a no-op (room to
   * grow into multi-select later), only a double-click drills into
   * the project. Cmd/Ctrl-click and middle-click still open the
   * project in a new tab, same affordance the old `<Link>` gave.
   */
  const handleProjectClick = (e: React.MouseEvent, projectId: string) => {
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      window.open(`/admin/projects/${projectId}`, '_blank', 'noopener')
    }
    // Otherwise: do nothing. Double-click handles the actual nav.
  }
  const handleProjectAuxClick = (e: React.MouseEvent, projectId: string) => {
    // Middle-click on a non-anchor element doesn't trigger `click`
    // in most browsers — `auxClick` does. Open in a new tab.
    if (e.button === 1) {
      window.open(`/admin/projects/${projectId}`, '_blank', 'noopener')
    }
  }
  const handleProjectDoubleClick = (projectId: string) => {
    router.push(`/admin/projects/${projectId}`)
  }
  // 1.7.2+: sort mode now comes from the shared admin sort store
  // (useAdminSortMode). The toggle UI lives in AdminHeader, next
  // to the view-mode toggle. We narrow the union to the two
  // alphabetical variants because the dashboard no longer offers
  // status / dueDate sorts.
  const [sortMode] = useAdminSortMode()
  // 1.7.0+: view mode now lives in a single shared store
  // (useAdminViewMode) instead of a component-local state. The
  // canonical setter lives in AdminHeader; this component just
  // reads the live value and renders accordingly. The previous
  // `admin_projects_view` localStorage key is left untouched —
  // we don't migrate it because new installs start with the
  // shared key, and existing users will set their preference once
  // from the header on first interaction.
  const [viewMode] = useAdminViewMode()
  // No-op setter kept for the legacy local toggle which we've
  // removed from the JSX below.
  const _setViewMode = (_: ViewMode) => {}
  void _setViewMode

  // 1.7.2+: persistence + status/dueDate migration moved into
  // the useAdminSortMode hook. Nothing to do here.

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
      {/* 1.7.2+: Grid/Table and A-Z toggles both live in
          AdminHeader's center cluster now — the dashboard body
          stays clean and the controls are reachable from any
          admin page. */}

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
        // 2.5.0 (revised): looser grid so each tile has room for a
        // chunky icon + two lines of meta without truncation.
        //
        // 2.5.1+: bumped one column at every desktop breakpoint
        // (lg→4, xl→5, 2xl→6) so wide displays can pack 6 tiles
        // per row instead of 5. Cards stay the same shape — they
        // just shrink proportionally to fit the extra column.
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {sortedProjects.map((project) => {
            const folderCount = project._count?.folders ?? 0
            const sizeLabel = formatBytes(project.totalSize)
            const isLocked =
              !!project.sharePassword ||
              (project.authMode && project.authMode !== 'NONE')

            const videoCount = project._count?.videos ?? 0
            return (
              <div
                key={project.id}
                className="group relative"
                data-project-tile
              >
                {/* 2.5.0 (revised): two-zone integrated card. Logo /
                    cover stays at a clean aspect-square so the brand
                    art isn't stretched into a portrait frame, and the
                    meta (title + folder/video count + timestamp) sits
                    in its own info strip BELOW the cover, all wrapped
                    in one rounded frame. A short dark fade bleeds out
                    of the cover into the info strip so the seam reads
                    as a single continuous panel, not two stacked
                    rectangles. */}
                <div
                  role="button"
                  tabIndex={0}
                  // 2.5.1+: `mousedown` preventDefault blocks the
                  // browser from focusing the div on mouse click —
                  // a focusable div (`tabIndex=0`) otherwise paints
                  // the default blue focus ring as soon as the
                  // pointer presses it. Suppressing focus on click
                  // is the same trick MUI / Radix use for "button-
                  // like containers that shouldn't look pressed".
                  // The keyboard handler below still focuses
                  // properly via Tab, so a11y survives.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => handleProjectClick(e, project.id)}
                  onAuxClick={(e) => handleProjectAuxClick(e, project.id)}
                  onDoubleClick={() => handleProjectDoubleClick(project.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleProjectDoubleClick(project.id)
                    }
                  }}
                  // 2.5.1+: NO focus ring, NO outline, NO webkit tap
                  // highlight — click on the tile is meant to feel
                  // inert. Double-click is what actually navigates.
                  className="block rounded-xl overflow-hidden ring-1 ring-border/40 hover:ring-border transition-[box-shadow,outline] cursor-pointer outline-none focus:outline-none focus-visible:outline-none select-none [-webkit-tap-highlight-color:transparent]"
                  aria-label={project.title}
                >
                  {/* Top: square cover / logo zone. */}
                  <div className="relative aspect-square">
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
                      <div
                        className="absolute inset-0"
                        style={{ background: projectGradient(project.id) }}
                      />
                    )}

                    {/* Bottom fade — short gradient that bleeds the
                        cover into the info strip. Tinted to the same
                        dark-blue ink (#13181d) as the info strip
                        below so the cover-to-info seam reads as a
                        single continuous panel, not a black slab
                        clipped onto a coloured tile. */}
                    <div
                      className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-[#13181d]/65 pointer-events-none"
                      aria-hidden
                    />

                    {/* Lock pip — kept on top-LEFT so the kebab takes
                        the conventional top-right corner. */}
                    {isLocked && (
                      <span
                        className="absolute top-2 left-2 inline-flex items-center justify-center w-7 h-7 rounded-md bg-black/40 text-white backdrop-blur-sm"
                        title="Password protected"
                        aria-label="Password protected"
                      >
                        <Lock className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </div>

                  {/* Bottom: info strip. Dark-blue ink (#13181d) at
                      80% opacity — softer than pure black, lets the
                      spotlight glow behind the card register on the
                      edges. White text hierarchy stays the same:
                      title bold, stats at 80%, timestamp at 60%. */}
                  <div className="bg-[#13181d]/80 px-4 py-3.5">
                    <div
                      className="text-white text-base font-semibold truncate"
                      title={project.title}
                    >
                      {project.title}
                    </div>
                    {/* 2.5.0 (revised): the stats line gets a hard
                        title attribute so the FULL string survives
                        even when an unusually long size label (e.g.
                        "1,024 GB") forces a single-line truncate at
                        narrow grid columns. The flex / gap-x-1.5
                        layout naturally wraps to a second row
                        instead of clipping if there's not enough
                        room. */}
                    <div
                      className="text-white/80 text-xs tabular-nums mt-1 flex flex-wrap gap-x-1.5"
                      title={`${folderCount} ${folderCount === 1 ? 'folder' : 'folders'} · ${videoCount} ${videoCount === 1 ? 'video' : 'videos'} · ${sizeLabel}`}
                    >
                      <span>{folderCount} {folderCount === 1 ? 'folder' : 'folders'}</span>
                      <span aria-hidden>·</span>
                      <span>{videoCount} {videoCount === 1 ? 'video' : 'videos'}</span>
                      <span aria-hidden>·</span>
                      <span>{sizeLabel}</span>
                    </div>
                    <div className="text-white/55 text-[11px] mt-1 truncate">
                      Updated {formatRelativeTime(project.updatedAt)}
                    </div>
                  </div>
                </div>

                {/* Kebab is a sibling of the card wrapper (not inside it) so
                    clicks on its trigger don't bubble up and follow
                    the card href. Positioned over the tile's top-
                    right corner. Solid dark fill (no backdrop blur)
                    keeps it legible on any cover — backdrop-filter
                    creates a containing block for `position: fixed`
                    in modern browsers, which would nail the kebab
                    dropdown to this wrapper instead of the viewport
                    and make it open hundreds of pixels off-screen. */}
                <div className="absolute top-2 right-2 z-10">
                  <div className="rounded-md bg-black/55 text-white">
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
              className="group flex flex-col items-center justify-center h-full min-h-[200px] rounded-xl border border-dashed border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground hover:border-border transition-colors"
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
              className="group flex flex-col items-center justify-center h-full min-h-[200px] rounded-xl border border-dashed border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground hover:border-border transition-colors"
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
        /* Table View — 2.5.1+: full v2.5 frosted glass recipe to
           match Project Settings panels, banners, and dialogs.
           Was on a flat `bg-[#13181d]/65` before; bumped to the
           same translucent navy + spotlight-tinted radial wash +
           40px backdrop blur the rest of the v2.5 system uses, so
           the table sits in the same lit-glass surface family as
           the rest of the admin UI. */
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
          <div className="flex items-center justify-between px-3 sm:px-5 py-2.5 border-b border-white/10 bg-white/[0.03]">
            <span className="text-sm font-medium">{tn('projects')}</span>
            <span className="text-xs text-white/55">{sortedProjects.length} {t('projectsCount')}</span>
          </div>
          {/* Table Header — status column removed (1.0.6+); videos &
              comments columns swapped for folders & total size.
              1.2.0+: Client + Due Date columns retired (the create
              modal no longer asks for either; both still exist in
              Project Settings if the workflow needs them).
              1.3.0+: tighter side padding on phones; the header row
              hides on `<sm` since only Name + kebab show there. */}
          <div className="hidden sm:flex items-center gap-4 px-3 sm:px-5 py-2 text-xs text-white/55 bg-white/[0.02] border-b border-white/10">
            <span className="flex-1 min-w-0">{tc('name')}</span>
            <span className="w-20 text-center hidden lg:block">Folders</span>
            <span className="w-20 text-center hidden lg:block">Videos</span>
            <span className="w-24 text-right hidden lg:block">Size</span>
            <span className="w-24 hidden xl:block">{tc('created')}</span>
            <span className="w-24 hidden lg:block">{tc('updated')}</span>
            <span className="w-8"></span>
          </div>
          <div className="divide-y divide-white/10">
            {sortedProjects.map((project) => {
              const folderCount = project._count?.folders ?? 0
              const videoCount = project._count?.videos ?? 0
              const sizeLabel = formatBytes(project.totalSize)
              const hasCover = !!(project as any).coverImagePath

              return (
                <div
                  key={project.id}
                  role="button"
                  tabIndex={0}
                  // See grid view: preventDefault on mousedown blocks
                  // the focus that the browser would otherwise apply
                  // to a focusable div on click. No focus = no flash.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => handleProjectClick(e, project.id)}
                  onAuxClick={(e) => handleProjectAuxClick(e, project.id)}
                  onDoubleClick={() => handleProjectDoubleClick(project.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleProjectDoubleClick(project.id)
                    }
                  }}
                  className="flex items-center gap-3 sm:gap-4 px-3 sm:px-5 py-2.5 sm:py-3 text-sm hover:bg-white/5 transition-colors cursor-pointer outline-none focus:outline-none focus-visible:outline-none select-none [-webkit-tap-highlight-color:transparent]"
                  aria-label={project.title}
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
                  <span className="flex-1 min-w-0 font-medium truncate text-white">{project.title}</span>
                  <span className="w-20 text-center text-xs text-white/65 tabular-nums hidden lg:block">{folderCount}</span>
                  <span className="w-20 text-center text-xs text-white/65 tabular-nums hidden lg:block">{videoCount}</span>
                  <span className="w-24 text-right text-xs text-white/65 tabular-nums hidden lg:block">{sizeLabel}</span>
                  <span className="w-24 text-xs text-white/55 hidden xl:block">
                    {formatDate(project.createdAt)}
                  </span>
                  <span className="w-24 text-xs text-white/55 hidden lg:block">
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
                </div>
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
                className="w-full flex items-center gap-3 sm:gap-4 px-3 sm:px-5 py-2.5 sm:py-3 text-sm text-white/55 hover:text-white hover:bg-white/5 transition-colors text-left"
              >
                <div className="w-8 h-8 shrink-0 rounded-md border border-dashed border-white/20 bg-white/[0.03] flex items-center justify-center">
                  <Plus className="w-4 h-4" />
                </div>
                <span className="flex-1 min-w-0 font-medium">{t('newProject')}</span>
              </button>
            ) : (
              <Link
                href="/admin/projects/new"
                className="w-full flex items-center gap-3 sm:gap-4 px-3 sm:px-5 py-2.5 sm:py-3 text-sm text-white/55 hover:text-white hover:bg-white/5 transition-colors"
              >
                <div className="w-8 h-8 shrink-0 rounded-md border border-dashed border-white/20 bg-white/[0.03] flex items-center justify-center">
                  <Plus className="w-4 h-4" />
                </div>
                <span className="flex-1 min-w-0 font-medium">{t('newProject')}</span>
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  )
}
