'use client'

import { useEffect, useRef, useState } from 'react'
import CoverImageCropper, { type CoverImageCropperHandle } from '@/components/CoverImageCropper'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { FolderKanban, Eye, EyeOff, RefreshCw, Copy, Check, AlertCircle, ImagePlus, Lock, LockOpen, X as XIcon } from 'lucide-react'
import { projectGradient } from '@/lib/project-gradient'
import ProjectsList from '@/components/ProjectsList'
import { TemplateModal } from '@/components/TemplateModal'
import { TopbarLeftSlot, TopbarRightSlot } from '@/components/TopbarSlots'
import ViewModeToggle from '@/components/ViewModeToggle'
import SortModeToggle from '@/components/SortModeToggle'
import { useAdminViewMode } from '@/lib/use-admin-view-mode'
import { useAdminSortMode } from '@/lib/use-admin-sort-mode'
import { apiFetch } from '@/lib/api-client'
import { copyToClipboard } from '@/lib/clipboard'
import { logError } from '@/lib/logging'
import { useTranslations } from 'next-intl'
import { SharePasswordRequirements } from '@/components/SharePasswordRequirements'
import { generateSecurePassword } from '@/lib/password-utils'

export default function AdminPage() {
  const t = useTranslations('projects')
  const tc = useTranslations('common')
  const router = useRouter()
  const [projects, setProjects] = useState<any[] | null>(null)
  const [loading, setLoading] = useState(true)

  // 2.4.2+ Template wizard state
  const [showTemplateModal, setShowTemplateModal] = useState(false)

  // 2.5.0+: view + sort toggles live in the topbar's right slot
  // alongside Template. The shared `useAdminViewMode` /
  // `useAdminSortMode` hooks already persist these per-tab in
  // localStorage so navigating away and back keeps the user's
  // last choice.
  const [adminView, setAdminView] = useAdminViewMode()
  const [adminSort, setAdminSort] = useAdminSortMode()

  // New Project Modal state
  const [showNewProjectModal, setShowNewProjectModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [isShareOnly, setIsShareOnly] = useState(false)
  const [passwordProtected, setPasswordProtected] = useState(true)
  const [sharePassword, setSharePassword] = useState('')
  const [showPassword, setShowPassword] = useState(true)
  const [copied, setCopied] = useState(false)
  const [authMode, setAuthMode] = useState<'PASSWORD' | 'OTP' | 'BOTH'>('PASSWORD')
  const [smtpConfigured, setSmtpConfigured] = useState(false)
  // 1.2.0+: Frame.io-style modal state. `restricted` collapses the
  // legacy passwordProtected/authMode UI into a single toggle; the
  // server auto-generates a password when restricted=true and the
  // admin can view / rotate it later from Project Settings.
  const [restricted, setRestricted] = useState(false)
  const [coverImageFile, setCoverImageFile] = useState<File | null>(null)
  // 1.2.0+: when a file is picked we hand it to <CoverImageCropper>
  // for in-place positioning + zoom. The cropper draws the final
  // square via canvas only at submit time (via the imperative
  // `commit()` handle below), so we don't keep a blob URL of the
  // preview here — the cropper manages its own object URL.
  const cropperRef = useRef<CoverImageCropperHandle | null>(null)
  // 1.2.0+: pin the preview gradient to a random seed at modal-open
  // time so it stays stable while the user types the title. Without
  // this the gradient would re-roll on every keystroke (since
  // projectGradient hashes its input).
  const [gradientSeed, setGradientSeed] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [clientCompanyId, setClientCompanyId] = useState<string | null>(null)
  const [recipientName, setRecipientName] = useState('')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [formError, setFormError] = useState('')

  // Check if SMTP is configured
  async function checkSmtpConfiguration() {
    try {
      const res = await apiFetch('/api/settings')
      if (res.ok) {
        const data = await res.json()
        setSmtpConfigured(data.smtpConfigured !== false)
      }
    } catch (err) {
      logError('Failed to check SMTP configuration:', err)
    }
  }

  const loadProjects = async () => {
    try {
      const projectsRes = await apiFetch('/api/projects')
      if (projectsRes.ok) {
        const data = await projectsRes.json()
        setProjects(data.projects || data || [])
      } else {
        setProjects([])
      }
    } catch (error) {
      setProjects([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadProjects()
    checkSmtpConfiguration()
  }, [])

  // Password helpers
  function handleGeneratePassword() {
    setSharePassword(generateSecurePassword())
    setCopied(false)
  }

  function handleCopyPassword() {
    void copyToClipboard(sharePassword)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Open new project modal
  function openNewProjectModal() {
    setProjectTitle('')
    setProjectDescription('')
    setCompanyName('')
    setClientCompanyId(null)
    setRecipientName('')
    setRecipientEmail('')
    setIsShareOnly(false)
    // Auth is OFF by default — most users want a quick public project.
    setPasswordProtected(false)
    setSharePassword(generateSecurePassword())
    setShowPassword(true)
    setCopied(false)
    setAuthMode('PASSWORD')
    setRestricted(false)
    setCoverImageFile(null)
    // Roll a fresh gradient seed for this modal session. We use
    // crypto.randomUUID where available (modern browsers) and fall
    // back to a Math.random hex so the modal stays usable on older
    // engines / SSR-derived paths.
    setGradientSeed(
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `seed-${Math.random().toString(36).slice(2, 12)}`,
    )
    setFormError('')
    setShowNewProjectModal(true)
  }

  // 1.2.0+: cover image picker handler. The actual crop preview is
  // managed by <CoverImageCropper>, which owns its own object URL;
  // we just keep the raw File in state and re-render the cropper
  // when it changes.
  function handlePickCoverImage(file: File | null) {
    if (!file) {
      setCoverImageFile(null)
      return
    }
    if (!file.type.startsWith('image/')) {
      setFormError('Please select an image file')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setFormError('Image must be smaller than 10MB')
      return
    }
    setCoverImageFile(file)
  }

  // Create project — 1.2.0+ multipart path. Sends title + restricted
  // flag + optional cover image in one form; server handles auth-mode
  // mapping and cover upload.
  async function handleCreateProject() {
    const title = projectTitle.trim() || 'Untitled Project'

    setCreating(true)
    setFormError('')

    try {
      // 1.2.0+: if a cover was picked, pull the cropped square via
      // the cropper's imperative handle. Fall back to the raw file
      // if the canvas export fails for any reason — better to ship
      // something than nothing.
      let coverToUpload: File | null = null
      if (coverImageFile) {
        try {
          coverToUpload = (await cropperRef.current?.commit()) || coverImageFile
        } catch {
          coverToUpload = coverImageFile
        }
      }

      const form = new FormData()
      form.append('title', title)
      form.append('restricted', restricted ? 'true' : 'false')
      if (coverToUpload) form.append('coverImage', coverToUpload)

      const res = await apiFetch('/api/projects', {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || t('failedToCreateProject'))
      }
      const project = await res.json()
      setCoverImageFile(null)
      setShowNewProjectModal(false)
      router.push(`/admin/projects/${project.id}`)
    } catch (error) {
      if (error instanceof Error) {
        setFormError(error.message || t('failedToCreateProject'))
      } else {
        setFormError(t('failedToCreateProject'))
      }
    } finally {
      setCreating(false)
    }
  }

  // Create modal is intentionally minimal in 1.0.6+: auth is always
  // password-based when enabled, so the dropdown is gone. Switch to
  // OTP / Both later from Project Settings if needed.
  const needsPassword = authMode === 'PASSWORD' || authMode === 'BOTH'

  // Render new project modal
  function renderNewProjectModal() {
    return (
      <Dialog open={showNewProjectModal} onOpenChange={setShowNewProjectModal}>
        <DialogContent
          hideClose
          overlayClassName="bg-transparent"
          className="sm:max-w-md max-h-[calc(100dvh-3rem)] sm:max-h-[85vh] flex flex-col bg-white/[0.06] text-white ring-1 ring-white/10 border-0 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)]"
          style={{
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
          }}
        >
          {/*
            1.2.0+: Frame.io-style composer.
            - Big preview tile up top (gradient by default, optional
              uploaded image), title input centered at the bottom of
              the tile.
            - Single "Make Restricted" toggle row.
            - Footer: Cancel + Create New Project.

            2.5.1+ glass refresh: same recipe as NewFolderDialog /
            AddUser modal — transparent backdrop, frosted shell,
            white text hierarchy, brand-blue primary action.

            The legacy fields (description, recipient, share-only,
            explicit password / authMode dropdown) live in Project
            Settings — they were noise on the create step.
          */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!creating) void handleCreateProject()
            }}
            className="contents"
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{t('createNew')}</DialogTitle>
              <DialogDescription>{t('createDescription')}</DialogDescription>
            </DialogHeader>

            {/* `px-0.5` on the scroll container lets the inner
                rings render fully on the left/right edges — same fix
                as the AddUser modal. */}
            <div className="flex-1 overflow-y-auto space-y-4 -mx-4 px-[calc(1rem+2px)] sm:-mx-6 sm:px-[calc(1.5rem+2px)] pt-2">
              {formError && (
                <div className="p-3 bg-destructive/15 ring-1 ring-destructive/30 rounded-md flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                  <span className="text-sm text-destructive">{formError}</span>
                </div>
              )}

              {/*
                Preview tile — whole tile is now the file-picker
                target (label). Gradient by default; an uploaded
                image replaces it. A centered icon hints at the
                upload affordance when the tile is still empty.
                The lock chip in the top-right reflects the
                Make Restricted toggle and animates between
                LockOpen ↔ Lock when the user flips it.
              */}
              {/*
                1.2.0+: outer wrapper is always a plain <div> with
                aspect-square + ring. When NO image is loaded a
                transparent <label> overlay opens the file picker on
                click. Once an image is loaded the overlay is gone,
                so drag / wheel-zoom on the cropper can't accidentally
                re-trigger the picker. Replacing the image is done by
                the explicit X button (clears the file → label
                returns next paint).
              */}
              <div className="relative block aspect-square rounded-xl overflow-hidden ring-1 ring-white/15 group/cover">
                {/* Layer 1: background — gradient or cropper */}
                {coverImageFile ? (
                  <CoverImageCropper
                    ref={cropperRef}
                    file={coverImageFile}
                    className="absolute inset-0"
                  />
                ) : (
                  <div
                    className="absolute inset-0"
                    style={{ background: projectGradient(gradientSeed || 'untitled') }}
                  />
                )}

                {/* Layer 2: invisible file-picker label, only when
                    no image is loaded. Sits ABOVE the gradient but
                    BELOW the lock chip / title input which have a
                    higher z-index. */}
                {!coverImageFile && (
                  <label
                    htmlFor="coverImageInputFallback"
                    className="absolute inset-0 z-10 cursor-pointer"
                    title="Upload image"
                  >
                    <input
                      id="coverImageInputFallback"
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null
                        handlePickCoverImage(f)
                        e.target.value = ''
                      }}
                    />
                  </label>
                )}

                {/* Bottom gradient so the title input stays readable
                    on top of busy covers. */}
                <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/55 via-black/20 to-transparent pointer-events-none z-20" />

                {/* Centered upload affordance — only shown in the
                    empty state. Pointer-events-none so the click
                    falls through to the <label> below it. */}
                {!coverImageFile && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white/[0.08] text-white ring-1 ring-white/15 backdrop-blur-md shadow-lg transition-transform duration-200 group-hover/cover:scale-105">
                      <ImagePlus className="w-6 h-6" />
                    </div>
                  </div>
                )}

                {/* Lock chip in the top-right corner. 2.5.1+: glass
                    when idle, brand-blue when locked — matches the
                    v2.5 active-state vocabulary used everywhere
                    else (accent swatches, count badges, etc.). */}
                <button
                  type="button"
                  onClick={() => setRestricted((v) => !v)}
                  aria-pressed={restricted}
                  title={restricted ? 'Restricted (click to unlock)' : 'Unrestricted (click to lock)'}
                  className={`absolute top-3 right-3 z-30 inline-flex items-center justify-center w-9 h-9 rounded-lg backdrop-blur-md shadow-md transition-colors ${
                    restricted
                      ? 'bg-primary text-white ring-1 ring-primary/60'
                      : 'bg-white/[0.08] text-white ring-1 ring-white/15 hover:bg-white/[0.14]'
                  }`}
                >
                  <span
                    key={restricted ? 'locked' : 'unlocked'}
                    className="inline-flex items-center justify-center w-full h-full animate-in zoom-in-50 spin-in-12 duration-200"
                  >
                    {restricted ? (
                      <Lock className="w-4 h-4" />
                    ) : (
                      <LockOpen className="w-4 h-4" />
                    )}
                  </span>
                </button>

                {/* Remove cover image button (visible only when one is set) */}
                {coverImageFile && (
                  <button
                    type="button"
                    onClick={() => handlePickCoverImage(null)}
                    className="absolute top-3 right-14 z-30 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-white/[0.08] text-white ring-1 ring-white/15 hover:bg-white/[0.14] backdrop-blur-md shadow-md transition-colors"
                    title="Remove image"
                  >
                    <XIcon className="w-4 h-4" />
                  </button>
                )}

                {/* Title input pinned at the bottom-center. 2.5.1+:
                    softer glass instead of `bg-black/40` — reads
                    better over both gradient and uploaded covers. */}
                <div className="absolute inset-x-4 bottom-4 z-30">
                  <Input
                    id="projectTitle"
                    placeholder="Untitled Project"
                    value={projectTitle}
                    onChange={(e) => setProjectTitle(e.target.value)}
                    autoComplete="off"
                    data-form-type="other"
                    data-lpignore="true"
                    data-1p-ignore
                    autoFocus
                    // 2.5.1+: `transition-none` kills the base
                    // Input's `transition-all duration-200`, which
                    // was animating the focus-state changes through
                    // a brief lighter intermediate — that's the
                    // white-ish flash users saw on click. We also
                    // zero out the WebKit tap-highlight (mobile)
                    // and force the caret to white so nothing else
                    // pops in/out around the click.
                    className="!transition-none bg-black/35 border-0 ring-1 ring-white/20 text-white caret-white placeholder:text-white/55 backdrop-blur-md text-base font-semibold focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0 focus-visible:outline-none focus:outline-none"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  />
                </div>
              </div>

              {/* Make Restricted toggle row. 2.5.1+: glass surface
                  in line with the rest of the v2.5 chrome. The
                  inner switch is hand-rolled (not Radix) so its
                  visual stays consistent here. */}
              <button
                type="button"
                onClick={() => setRestricted((v) => !v)}
                className="w-full flex items-center gap-3 rounded-xl bg-white/[0.04] ring-1 ring-white/10 hover:bg-white/[0.08] px-4 py-3 text-left transition-colors"
              >
                <Lock
                  className={`w-5 h-5 shrink-0 ${
                    restricted ? 'text-primary' : 'text-white/55'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-white">
                    Make Restricted
                  </div>
                  <p className="text-xs text-white/55 leading-snug">
                    Only people directly invited to the project will have access.
                  </p>
                </div>
                {/* Visual switch */}
                <span
                  aria-hidden="true"
                  className={`relative inline-flex h-6 w-10 shrink-0 rounded-full transition-colors ${
                    restricted ? 'bg-primary' : 'bg-white/15 ring-1 ring-white/10'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      restricted ? 'translate-x-[18px]' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              </button>
            </div>

            {/* 2.5.1+: footer centred (no `sm:justify-end` from the
                shadcn default) — Cancel + Create New Project sit
                together in the middle of the modal so neither
                action gets buried in a corner. */}
            <DialogFooter className="pt-3 gap-3 flex-row justify-center sm:justify-center">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={creating}
                  className="bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/15 text-white border-0"
                >
                  {tc('cancel')}
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={creating}
                style={{ color: '#ffffff' }}
                className="font-semibold"
              >
                {creating ? tc('creating') : 'Create New Project'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <p className="text-muted-foreground">{t('loadingProjects')}</p>
      </div>
    )
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="flex-1 min-h-0">
        {/* 2.5.0+: title + actions live in the AdminTopBar slots
            (see TopbarSlots). Template is disabled in the empty
            state because there's no project yet to scaffold into,
            but stays visible so the feature is discoverable. */}
        <TopbarLeftSlot>
          {/* 2.5.0+: title block pinned to absolute pixel sizes
              (not rem) so it can't drift with viewport / root
              font-size. The icon sits naked next to the title —
              no chip — so there's no boxed surface that the eye
              can compare against the (now-larger) project tiles. */}
          <FolderKanban size={20} className="text-primary shrink-0" />
          <h1
            className="font-semibold truncate"
            style={{ fontSize: 18, lineHeight: '24px' }}
          >
            Projects
          </h1>
        </TopbarLeftSlot>
        <TopbarRightSlot>
          {/* Empty state: Template disabled (no project to scaffold
              into), view + sort toggles still rendered so the bar
              stays visually consistent with the populated state. */}
          <Button
            variant="ghost"
            size="sm"
            className="sm:h-9 sm:px-3 ring-1 ring-white/10 text-white hover:text-white"
            style={{
              backgroundColor: 'rgba(255,255,255,0.06)',
              backdropFilter: 'blur(12px) saturate(140%)',
              WebkitBackdropFilter: 'blur(12px) saturate(140%)',
            }}
            onClick={() => setShowTemplateModal(true)}
            disabled
            title="Create a project first to use templates"
            aria-label="Create from template"
          >
            Template
          </Button>
          <ViewModeToggle value={adminView} onChange={setAdminView} />
          <SortModeToggle value={adminSort} onChange={setAdminSort} />
        </TopbarRightSlot>

        <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
          <div className="text-muted-foreground">{t('noProjects')}</div>
        </div>
        {renderNewProjectModal()}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0">
      {/* 2.5.0+: title + primary actions are portalled into the
          AdminTopBar slots so the page body is just the grid. */}
      <TopbarLeftSlot>
        {/* 2.5.0+: title block pinned to absolute pixel sizes
            (not rem) so it never grows with viewport width or
            root font-size. */}
        <div
          className="inline-flex items-center justify-center rounded-lg bg-primary/15 text-primary shrink-0"
          style={{ width: 36, height: 36 }}
        >
          <FolderKanban size={20} />
        </div>
        <h1
          className="font-semibold truncate"
          style={{ fontSize: 18, lineHeight: '24px' }}
        >
          Projects
        </h1>
      </TopbarLeftSlot>
      <TopbarRightSlot>
        {/* 2.4.2+: Template wizard — opens the split-pane modal
            with YouTube/UGC templates that scaffold a multi-level
            folder structure into an existing project. The
            standalone "New Project" button was dropped here in
            2.5.0+ — the empty New Project tile at the end of the
            grid already covers that affordance. */}
        <Button
          variant="ghost"
          size="sm"
          className="sm:h-9 sm:px-3 ring-1 ring-white/10 text-white hover:text-white"
          style={{
            backgroundColor: 'rgba(255,255,255,0.06)',
            backdropFilter: 'blur(12px) saturate(140%)',
            WebkitBackdropFilter: 'blur(12px) saturate(140%)',
          }}
          onClick={() => setShowTemplateModal(true)}
          aria-label="Create from template"
        >
          Template
        </Button>
        <ViewModeToggle value={adminView} onChange={setAdminView} />
        <SortModeToggle value={adminSort} onChange={setAdminSort} />
      </TopbarRightSlot>

      <div className="px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <ProjectsList
          projects={projects}
          onProjectMutated={loadProjects}
          onNewProject={openNewProjectModal}
        />
      </div>
      {renderNewProjectModal()}
      {/* 2.4.2+: Template wizard. Always mounted so the modal
          state animates open/close cleanly. The projects list it
          consumes is the same one rendered above — when a project
          has been created mid-session, it shows up here too. */}
      <TemplateModal
        open={showTemplateModal}
        onOpenChange={setShowTemplateModal}
        projects={(projects || []).map((p) => ({ id: p.id, title: p.title || 'Untitled project' }))}
      />
    </div>
  )
}
