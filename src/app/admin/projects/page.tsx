'use client'

import { useEffect, useRef, useState } from 'react'
import CoverImageCropper, { type CoverImageCropperHandle } from '@/components/CoverImageCropper'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { FolderKanban, Plus, Eye, EyeOff, RefreshCw, Copy, Check, AlertCircle, ImagePlus, Lock, LockOpen, X as XIcon } from 'lucide-react'
import { projectGradient } from '@/lib/project-gradient'
import ProjectsList from '@/components/ProjectsList'
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
        <DialogContent className="sm:max-w-md max-h-[calc(100dvh-3rem)] sm:max-h-[85vh] flex flex-col">
          {/*
            1.2.0+: Frame.io-style composer.
            - Big preview tile up top (gradient by default, optional
              uploaded image), title input centered at the bottom of
              the tile.
            - Single "Make Restricted" toggle row.
            - Footer: Cancel + Create New Project.

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

            <div className="flex-1 overflow-y-auto space-y-4 -mx-4 px-4 sm:-mx-6 sm:px-6 pt-2">
              {formError && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-center gap-2">
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
              <div className="relative block aspect-square rounded-xl overflow-hidden ring-1 ring-border/40 group/cover">
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
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-black/40 text-white shadow-lg backdrop-blur-sm transition-transform duration-200 group-hover/cover:scale-105">
                      <ImagePlus className="w-6 h-6" />
                    </div>
                  </div>
                )}

                {/* Lock chip in the top-right corner. */}
                <button
                  type="button"
                  onClick={() => setRestricted((v) => !v)}
                  aria-pressed={restricted}
                  title={restricted ? 'Restricted (click to unlock)' : 'Unrestricted (click to lock)'}
                  className={`absolute top-3 right-3 z-30 inline-flex items-center justify-center w-9 h-9 rounded-lg backdrop-blur-sm shadow-md transition-colors ${
                    restricted
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-black/55 text-white hover:bg-black/70'
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
                    className="absolute top-3 right-14 z-30 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-black/55 text-white hover:bg-black/70 backdrop-blur-sm shadow-md transition-colors"
                    title="Remove image"
                  >
                    <XIcon className="w-4 h-4" />
                  </button>
                )}

                {/* Title input pinned at the bottom-center. */}
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
                    className="bg-black/40 border-white/20 text-white placeholder:text-white/70 backdrop-blur-md text-base font-semibold focus-visible:ring-primary/60"
                  />
                </div>
              </div>

              {/* Make Restricted toggle row. */}
              <button
                type="button"
                onClick={() => setRestricted((v) => !v)}
                className="w-full flex items-center gap-3 rounded-xl border border-border bg-card/40 hover:bg-card/70 px-4 py-3 text-left transition-colors"
              >
                <Lock
                  className={`w-5 h-5 shrink-0 ${
                    restricted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    Make Restricted
                  </div>
                  <p className="text-xs text-muted-foreground leading-snug">
                    Only people directly invited to the project will have access.
                  </p>
                </div>
                {/* Visual switch */}
                <span
                  aria-hidden="true"
                  className={`relative inline-flex h-6 w-10 shrink-0 rounded-full transition-colors ${
                    restricted ? 'bg-primary' : 'bg-muted'
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

            <DialogFooter className="pt-2">
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={creating}>{tc('cancel')}</Button>
              </DialogClose>
              <Button type="submit" disabled={creating}>
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
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">{t('loadingProjects')}</p>
      </div>
    )
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="flex-1 min-h-0 bg-background">
        <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
          {/* 1.3.0+: mobile-first header. `min-w-0 flex-1` lets the
              title block shrink so the long subtitle never pushes
              the action button past the viewport edge. The button
              is icon-only on phones, full label from sm: up. */}
          <div className="flex justify-between items-center gap-3 mb-4 sm:mb-6">
            <div className="min-w-0 flex-1">
              <h1 className="text-xl sm:text-3xl font-bold flex items-center gap-2 min-w-0">
                <FolderKanban className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
                <span className="truncate">{t('dashboard')}</span>
              </h1>
              <p className="text-muted-foreground mt-1 text-xs sm:text-base truncate">{t('dashboardDescription')}</p>
            </div>
            <Button
              variant="default"
              size="sm"
              className="shrink-0 sm:h-10 sm:px-4"
              onClick={openNewProjectModal}
              aria-label={t('newProject')}
            >
              <Plus className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">{t('newProject')}</span>
            </Button>
          </div>
          <div className="text-muted-foreground">{t('noProjects')}</div>
        </div>
        {renderNewProjectModal()}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="flex justify-between items-center gap-3 mb-4 sm:mb-6">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-3xl font-bold flex items-center gap-2 min-w-0">
              <FolderKanban className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
              <span className="truncate">{t('dashboard')}</span>
            </h1>
            <p className="text-muted-foreground mt-1 text-xs sm:text-base truncate">{t('dashboardDescription')}</p>
          </div>
          <Button
            variant="default"
            size="sm"
            className="shrink-0 sm:h-10 sm:px-4"
            onClick={openNewProjectModal}
            aria-label={t('newProject')}
          >
            <Plus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">{t('newProject')}</span>
          </Button>
        </div>

        <ProjectsList
          projects={projects}
          onProjectMutated={loadProjects}
          onNewProject={openNewProjectModal}
        />
      </div>
      {renderNewProjectModal()}
    </div>
  )
}
