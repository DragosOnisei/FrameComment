'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { FolderKanban, Plus, Eye, EyeOff, RefreshCw, Copy, Check, AlertCircle, ImagePlus, Lock, LockOpen, X as XIcon } from 'lucide-react'
import { projectGradient } from '@/lib/project-gradient'
import ProjectsList from '@/components/ProjectsList'
import { apiFetch } from '@/lib/api-client'
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
  const [coverImagePreview, setCoverImagePreview] = useState<string | null>(null)
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
    navigator.clipboard.writeText(sharePassword)
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
    if (coverImagePreview) URL.revokeObjectURL(coverImagePreview)
    setCoverImagePreview(null)
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

  // 1.2.0+: cover image picker handler. Generates an object URL so
  // the preview shows immediately; revoked when the modal closes or
  // a new image is picked.
  function handlePickCoverImage(file: File | null) {
    if (coverImagePreview) URL.revokeObjectURL(coverImagePreview)
    if (!file) {
      setCoverImageFile(null)
      setCoverImagePreview(null)
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
    setCoverImagePreview(URL.createObjectURL(file))
  }

  // Create project — 1.2.0+ multipart path. Sends title + restricted
  // flag + optional cover image in one form; server handles auth-mode
  // mapping and cover upload.
  async function handleCreateProject() {
    const title = projectTitle.trim() || 'Untitled Project'

    setCreating(true)
    setFormError('')

    try {
      const form = new FormData()
      form.append('title', title)
      form.append('restricted', restricted ? 'true' : 'false')
      if (coverImageFile) form.append('coverImage', coverImageFile)

      const res = await apiFetch('/api/projects', {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || t('failedToCreateProject'))
      }
      const project = await res.json()
      if (coverImagePreview) URL.revokeObjectURL(coverImagePreview)
      setCoverImagePreview(null)
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
              <label
                className="relative block aspect-square rounded-xl overflow-hidden ring-1 ring-border/40 hover:ring-border cursor-pointer group/cover"
                title={coverImagePreview ? 'Replace image' : 'Upload image'}
              >
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null
                    handlePickCoverImage(f)
                    e.target.value = ''
                  }}
                />

                {coverImagePreview ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={coverImagePreview}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                ) : (
                  <div
                    className="absolute inset-0"
                    style={{ background: projectGradient(gradientSeed || 'untitled') }}
                  />
                )}

                {/* Subtle bottom gradient overlay so the title input
                    stays readable over busy cover images. */}
                <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/55 via-black/20 to-transparent pointer-events-none" />

                {/* Centered upload affordance. Hidden once an image
                    is loaded; the user can still click anywhere on
                    the tile to swap it. */}
                {!coverImagePreview && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-black/40 text-white shadow-lg backdrop-blur-sm transition-transform duration-200 group-hover/cover:scale-105">
                      <ImagePlus className="w-6 h-6" />
                    </div>
                  </div>
                )}

                {/* Lock chip in the top-right corner — visual
                    indicator of the Make Restricted toggle. The
                    icon morphs between LockOpen / Lock with a
                    rotate+scale animation. Tile click would
                    otherwise open the file picker, so the chip
                    stops propagation and flips the toggle directly
                    for a one-click feel. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setRestricted((v) => !v)
                  }}
                  aria-pressed={restricted}
                  title={restricted ? 'Restricted (click to unlock)' : 'Unrestricted (click to lock)'}
                  className={`absolute top-3 right-3 inline-flex items-center justify-center w-9 h-9 rounded-lg backdrop-blur-sm shadow-md transition-colors ${
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
                {coverImagePreview && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handlePickCoverImage(null)
                    }}
                    className="absolute top-3 right-14 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-black/55 text-white hover:bg-black/70 backdrop-blur-sm shadow-md transition-colors"
                    title="Remove image"
                  >
                    <XIcon className="w-4 h-4" />
                  </button>
                )}

                {/* Title input pinned at the bottom-center, inline
                    over the cover. Clicking it must NOT trigger the
                    file picker — onClick stops propagation, and we
                    use a wrapper to opt out of the parent <label>. */}
                <div className="absolute inset-x-4 bottom-4">
                  <Input
                    id="projectTitle"
                    placeholder="Untitled Project"
                    value={projectTitle}
                    onChange={(e) => setProjectTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    autoComplete="off"
                    data-form-type="other"
                    data-lpignore="true"
                    data-1p-ignore
                    autoFocus
                    className="bg-black/40 border-white/20 text-white placeholder:text-white/70 backdrop-blur-md text-base font-semibold focus-visible:ring-primary/60"
                  />
                </div>
              </label>

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
          <div className="flex justify-between items-center gap-4 mb-4 sm:mb-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
                <FolderKanban className="w-7 h-7 sm:w-8 sm:h-8" />
                {t('dashboard')}
              </h1>
              <p className="text-muted-foreground mt-1 text-sm sm:text-base">{t('dashboardDescription')}</p>
            </div>
            <Button variant="default" size="default" onClick={openNewProjectModal}>
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
        <div className="flex justify-between items-center gap-4 mb-4 sm:mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
              <FolderKanban className="w-7 h-7 sm:w-8 sm:h-8" />
              {t('dashboard')}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">{t('dashboardDescription')}</p>
          </div>
          <Button variant="default" size="default" onClick={openNewProjectModal}>
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
