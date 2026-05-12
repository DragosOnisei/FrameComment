'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { FolderKanban, Plus, Eye, EyeOff, RefreshCw, Copy, Check, AlertCircle } from 'lucide-react'
import ProjectsList from '@/components/ProjectsList'
import { apiFetch, apiPost } from '@/lib/api-client'
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
    // They can flip the checkbox if they need a password / OTP.
    setPasswordProtected(false)
    setSharePassword(generateSecurePassword())
    setShowPassword(true)
    setCopied(false)
    setAuthMode('PASSWORD')
    setFormError('')
    setShowNewProjectModal(true)
  }

  // Create project
  async function handleCreateProject() {
    if (!projectTitle.trim()) {
      setFormError(t('titleRequired2'))
      return
    }

    // Client-side validation for password modes
    const needsPasswordForMode = passwordProtected && (authMode === 'PASSWORD' || authMode === 'BOTH')
    if (needsPasswordForMode && !sharePassword.trim()) {
      setFormError(t('passwordRequired'))
      return
    }

    setCreating(true)
    setFormError('')

    try {
      const data: Record<string, unknown> = {
        title: projectTitle,
        authMode: passwordProtected ? authMode : 'NONE',
        isShareOnly: isShareOnly,
      }
      
      // Only include optional fields if they have values
      if (projectDescription) data.description = projectDescription
      if (companyName) data.companyName = companyName
      if (clientCompanyId) data.clientCompanyId = clientCompanyId
      if (recipientName) data.recipientName = recipientName
      if (recipientEmail) data.recipientEmail = recipientEmail
      
      // Only include password for password-based auth modes
      if ((authMode === 'PASSWORD' || authMode === 'BOTH') && passwordProtected && sharePassword) {
        data.sharePassword = sharePassword
      }

      const project = await apiPost('/api/projects', data)
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
        <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-3rem)] sm:max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderKanban className="w-5 h-5 text-primary" />
              {t('createNew')}
            </DialogTitle>
            <DialogDescription>
              {t('createDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-4 -mx-4 px-4 sm:-mx-6 sm:px-6">
            {formError && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive">{formError}</span>
              </div>
            )}

            {/* Project Title */}
            <div className="space-y-2">
              <Label htmlFor="projectTitle">{t('titleRequired')}</Label>
              <Input
                id="projectTitle"
                placeholder={t('titlePlaceholder')}
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                autoComplete="off"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore
              />
            </div>

            {/* Authentication Section */}
            <div className="space-y-4 border rounded-lg p-4 bg-primary-visible border-2 border-primary-visible">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <Label htmlFor="passwordProtected" className="text-sm font-semibold">
                    {t('requireAuth')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('requireAuthDescription')}
                  </p>
                </div>
                <input
                  id="passwordProtected"
                  type="checkbox"
                  checked={passwordProtected}
                  onChange={(e) => setPasswordProtected(e.target.checked)}
                  className="h-5 w-5 rounded border-border text-primary focus:ring-primary mt-1"
                />
              </div>

              {passwordProtected && (
                <div className="space-y-3 pt-2 border-t">
                  {/* Password Field — always Password auth (1.0.6+) */}
                  {needsPassword && (
                    <div className="space-y-2">
                      <Label htmlFor="sharePassword">{t('sharePassword')}</Label>
                      <div className="flex gap-2">
                        <div className="relative flex-1 min-w-0">
                          <Input
                            id="sharePassword"
                            value={sharePassword}
                            onChange={(e) => setSharePassword(e.target.value)}
                            type={showPassword ? 'text' : 'password'}
                            className="pr-10 font-mono text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={handleGeneratePassword}
                          title={t('generatePassword')}
                          className="flex-shrink-0"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={handleCopyPassword}
                          title={t('copyPassword')}
                          className="flex-shrink-0"
                        >
                          {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </div>
                      {sharePassword && (
                        <SharePasswordRequirements password={sharePassword} />
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t('savePasswordWarning')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {!passwordProtected && (
                <div className="flex items-start gap-2 p-2 bg-warning-visible border-2 border-warning-visible rounded-md">
                  <span className="text-warning text-sm font-bold">!</span>
                  <p className="text-xs text-warning font-medium">
                    {t('noAuthWarning')}
                  </p>
                </div>
              )}
            </div>

          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={creating}>{tc('cancel')}</Button>
            </DialogClose>
            <Button onClick={handleCreateProject} disabled={creating}>
              <Plus className="w-4 h-4 mr-2" />
              {creating ? tc('creating') : t('createProject')}
            </Button>
          </DialogFooter>
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

        <ProjectsList projects={projects} onProjectMutated={loadProjects} />
      </div>
      {renderNewProjectModal()}
    </div>
  )
}
