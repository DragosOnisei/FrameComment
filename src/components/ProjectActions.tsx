'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Project } from '@prisma/client'
import { copyToClipboard } from '@/lib/clipboard'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Trash2, ExternalLink, Archive, ArchiveRestore, RotateCcw, Send, Loader2, CheckCircle, BarChart3, FolderKanban, Copy, Check, Calendar, MoreVertical, Settings as SettingsIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { UnapproveModal } from './UnapproveModal'
import { apiPost, apiPatch, apiDelete } from '@/lib/api-client'
import { computePopoverStyle } from '@/lib/popover-position'

interface Video {
  id: string
  name: string
  versionLabel: string
  status: string
  approved: boolean
}

interface ProjectActionsProps {
  project: Project
  videos: Video[]
  onRefresh?: () => void
  shareUrl?: string
  recipients?: any[]
}

export default function ProjectActions({ project, videos, onRefresh, shareUrl = '', recipients = [] }: ProjectActionsProps) {
  const t = useTranslations('projects')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const [isDeleting, setIsDeleting] = useState(false)
  const [isTogglingApproval, setIsTogglingApproval] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  // Kebab menu state — collapses the verbose action button list into
  // a single ⋮ dropdown at the top of the card (1.0.6+).
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // 1.3.1+: Frame.io-style smart-positioned popover.
  const kebabRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Unapprove modal state
  const [showUnapproveModal, setShowUnapproveModal] = useState(false)

  // Notification modal state
  const [showNotificationModal, setShowNotificationModal] = useState(false)
  const [notificationType, setNotificationType] = useState<'entire-project' | 'specific-video'>('entire-project')
  const [selectedVideoName, setSelectedVideoName] = useState<string>('')
  const [selectedVideoId, setSelectedVideoId] = useState<string>('')
  const [sendPasswordSeparately, setSendPasswordSeparately] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Read SMTP configuration status from project data
  const smtpConfigured = (project as any).smtpConfigured !== false

  // Check if at least one recipient has an email address
  const hasRecipientWithEmail = (project as any).recipients?.some((r: any) => r.email && r.email.trim() !== '') || false

  // Check if project is password protected
  const isPasswordProtected = (project as any).sharePassword !== null &&
                               (project as any).sharePassword !== undefined &&
                               (project as any).sharePassword !== ''

  // Filter only ready videos
  const readyVideos = videos.filter(v => v.status === 'READY')

  // Check if all unique videos have at least one approved version
  const videosByNameForApproval = readyVideos.reduce((acc, video) => {
    if (!acc[video.name]) {
      acc[video.name] = []
    }
    acc[video.name].push(video)
    return acc
  }, {} as Record<string, Video[]>)

  const allVideosHaveApprovedVersion = Object.values(videosByNameForApproval).every((versions: Video[]) =>
    versions.some(v => v.approved)
  )

  const canApproveProject = readyVideos.length > 0 && allVideosHaveApprovedVersion

  // Group videos by name
  const videosByName = readyVideos.reduce((acc, video) => {
    if (!acc[video.name]) {
      acc[video.name] = []
    }
    acc[video.name].push(video)
    return acc
  }, {} as Record<string, Video[]>)

  const videoNames = Object.keys(videosByName)
  const versionsForSelectedVideo = selectedVideoName ? videosByName[selectedVideoName] : []

  // Reset selections when notification type changes
  const handleNotificationTypeChange = (type: 'entire-project' | 'specific-video') => {
    setNotificationType(type)
    setSelectedVideoName('')
    setSelectedVideoId('')
  }

  // Reset version selection when video name changes
  const handleVideoNameChange = (name: string) => {
    setSelectedVideoName(name)
    setSelectedVideoId('')
  }

  const handleSendNotification = async () => {
    // Prevent rapid-fire notification sends
    if (loading) return

    // Validation
    if (notificationType === 'specific-video' && !selectedVideoId) {
      setMessage({ type: 'error', text: t('selectVideoAndVersion') })
      return
    }

    setLoading(true)
    setMessage({ type: 'success', text: t('sendingNotificationProgress') })

    // Send notification in background without blocking UI
    apiPost(`/api/projects/${project.id}/notify`, {
      videoId: notificationType === 'specific-video' ? selectedVideoId : null,
      notifyEntireProject: notificationType === 'entire-project',
      sendPasswordSeparately: isPasswordProtected && sendPasswordSeparately
    })
      .then((data) => {
        setMessage({ type: 'success', text: data.message || t('notificationSentSuccessfully') })
        setSelectedVideoName('')
        setSelectedVideoId('')
        setSendPasswordSeparately(false)
      })
      .catch((error) => {
        setMessage({ type: 'error', text: error instanceof Error ? error.message : t('failedToSendNotification') })
      })
      .finally(() => {
        setLoading(false)
      })
  }

  const handleViewSharePage = () => {
    router.push(`/admin/projects/${project.id}/share`)
  }

  const handleToggleApproval = async () => {
    // Prevent double-clicks during approval toggle
    if (isTogglingApproval) return

    const isCurrentlyApproved = project.status === 'APPROVED'

    if (isCurrentlyApproved) {
      // Show the unapprove modal to let user choose
      setShowUnapproveModal(true)
    } else {
      // For approval, just confirm and proceed
      if (!confirm(t('confirmApproveProject'))) {
        return
      }

      setIsTogglingApproval(true)

      // Approve project in background without blocking UI
      apiPatch(`/api/projects/${project.id}`, { status: 'APPROVED' })
        .then(() => {
          alert(t('approvedSuccessfully'))
          // Refresh in background
          onRefresh?.()
          router.refresh()
        })
        .catch(() => {
          alert(t('failedToApprove'))
        })
        .finally(() => {
          setIsTogglingApproval(false)
        })
    }
  }

  const handleUnapprove = async (unapproveVideos: boolean) => {
    // Prevent double-clicks during unapproval
    if (isTogglingApproval) return

    setIsTogglingApproval(true)
    setShowUnapproveModal(false)

    // Unapprove project in background without blocking UI
    apiPost(`/api/projects/${project.id}/unapprove`, { unapproveVideos })
      .then((data) => {
        // Show appropriate success message
        if (data.unapprovedVideos && data.unapprovedCount > 0) {
          alert(`${t('unapprovedSuccessfully')} ${data.unapprovedCount} ${t('videosUnapproved')}`)
        } else if (data.unapprovedVideos && data.unapprovedCount === 0) {
          alert(`${t('unapprovedSuccessfully')} ${t('noVideosApproved')}`)
        } else {
          alert(`${t('unapprovedSuccessfully')} ${t('videosRemainApproved')}`)
        }
        // Refresh in background
        onRefresh?.()
        router.refresh()
      })
      .catch(() => {
        alert(t('failedToUnapprove'))
      })
      .finally(() => {
        setIsTogglingApproval(false)
      })
  }

  const handleUnapproveProjectOnly = () => {
    handleUnapprove(false)
  }

  const handleUnapproveAll = () => {
    handleUnapprove(true)
  }

  const handleCancelUnapprove = () => {
    setShowUnapproveModal(false)
  }

  const handleDelete = async () => {
    // Prevent double-clicks during deletion
    if (isDeleting) return

    if (!confirm(t('deleteConfirm'))) {
      return
    }

    // Double confirmation for safety
    if (!confirm(t('deleteLastWarning'))) {
      return
    }

    setIsDeleting(true)

    // Delete project in background without blocking UI
    apiDelete<{ wasEmpty?: boolean }>(`/api/projects/${project.id}`)
      .then((data) => {
        // 1.2.1+: kick the AdminHeader Trash badge unless the
        // server hard-deleted the project (empty containers skip
        // Trash, so the count doesn't move).
        if (!data?.wasEmpty) {
          window.dispatchEvent(new CustomEvent('trash:changed'))
        }
        // Redirect to admin page after successful deletion
        router.push('/admin/projects')
        router.refresh()
      })
      .catch(() => {
        alert(t('failedToDelete'))
        setIsDeleting(false)
      })
  }

  const handleToggleArchive = async () => {
    if (isArchiving) return

    const isCurrentlyArchived = project.status === 'ARCHIVED'
    const action = isCurrentlyArchived ? 'unarchive' : 'archive'
    const newStatus = isCurrentlyArchived ? 'IN_REVIEW' : 'ARCHIVED'

    if (!confirm(isCurrentlyArchived ? t('unarchiveConfirm') : t('archiveConfirm'))) {
      return
    }

    setIsArchiving(true)

    apiPatch(`/api/projects/${project.id}`, { status: newStatus })
      .then(() => {
        alert(action === 'archive' ? t('archivedSuccessfully') : t('unarchivedSuccessfully'))
        onRefresh?.()
        router.refresh()
      })
      .catch(() => {
        alert(action === 'archive' ? t('failedToArchive') : t('failedToUnarchive'))
      })
      .finally(() => {
        setIsArchiving(false)
      })
  }

  // Helper: copy share link to clipboard with a brief "copied" state
  // on the menu item.
  const handleCopyLink = () => {
    if (!shareUrl) return
    copyToClipboard(shareUrl).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 1500)
    })
  }

  return (
    <>
      {/* Kebab-only render (1.0.6+) — the Card / title / client info /
          share link panel were collapsed: the page now drops you
          straight into the folder grid (Frame.io style), and every
          project-level action lives behind this ⋮. */}
      <div ref={menuRef} className="relative inline-block">
        <button
          ref={kebabRef}
          type="button"
          onClick={() => {
            if (menuOpen) {
              setMenuOpen(false)
              return
            }
            const rect = kebabRef.current?.getBoundingClientRect()
            if (rect) setMenuStyle(computePopoverStyle(rect, { width: 260 }))
            setMenuOpen(true)
          }}
          className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('projectActions')}
          aria-label={t('projectActions')}
        >
          <MoreVertical className="w-5 h-5" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            // 1.3.1+: Frame.io-style smart popover (see VideoCard).
            // 2.5.0+: solid `#162533` fill + white text + hairline
            // white/10 ring, matching the FolderCard kebab so the
            // whole admin chrome reads as one design family.
            style={{ ...menuStyle, backgroundColor: '#162533' }}
            className="z-50 overflow-y-auto rounded-lg text-white ring-1 ring-white/10 shadow-2xl p-1"
          >
            {shareUrl && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  handleCopyLink()
                  // keep the menu open briefly so the user sees the
                  // copied-state flash before it auto-closes.
                  setTimeout(() => setMenuOpen(false), 800)
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left"
              >
                {linkCopied ? (
                  <Check className="w-4 h-4 shrink-0 text-success" />
                ) : (
                  <Copy className="w-4 h-4 shrink-0" />
                )}
                {linkCopied ? tc('copied') : t('shareLink')}
              </button>
            )}
            {shareUrl && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  window.open(shareUrl, '_blank', 'noopener,noreferrer')
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left"
              >
                <ExternalLink className="w-4 h-4 shrink-0" />
                {tc('open')}
              </button>
            )}
            {(shareUrl) && (
              <div className="my-1 h-px bg-white/10" role="separator" />
            )}
            {readyVideos.length > 0 && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setShowNotificationModal(true)
                }}
                disabled={smtpConfigured === false || !hasRecipientWithEmail}
                title={
                  smtpConfigured === false
                    ? t('smtpNotConfigured')
                    : !hasRecipientWithEmail
                    ? t('noRecipientsEmail')
                    : ''
                }
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4 shrink-0" />
                {t('sendNotification')}
              </button>
            )}
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setMenuOpen(false)
                handleViewSharePage()
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left"
            >
              <ExternalLink className="w-4 h-4 shrink-0" />
              {t('viewSharePage')}
            </button>
                    {/* 2.5.0+: Project Settings entry, moved here from
                        the inline topbar action. */}
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setMenuOpen(false)
                        router.push(`/admin/projects/${project.id}/settings`)
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left"
                    >
                      <SettingsIcon className="w-4 h-4 shrink-0" />
                      {t('projectSettings')}
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setMenuOpen(false)
                        router.push(`/admin/projects/${project.id}/analytics`)
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left"
                    >
                      <BarChart3 className="w-4 h-4 shrink-0" />
                      {t('viewAnalytics')}
                    </button>
                    {project.status !== 'ARCHIVED' && (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          setMenuOpen(false)
                          handleToggleApproval()
                        }}
                        disabled={
                          isTogglingApproval ||
                          (project.status !== 'APPROVED' && !canApproveProject)
                        }
                        title={
                          project.status !== 'APPROVED' && !canApproveProject
                            ? t('approveFirst')
                            : ''
                        }
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {project.status === 'APPROVED' ? (
                          <>
                            <RotateCcw className="w-4 h-4 shrink-0" />
                            {isTogglingApproval ? tc('changing') : t('unapproveProject')}
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-4 h-4 shrink-0" />
                            {isTogglingApproval ? tc('changing') : t('approveProject')}
                          </>
                        )}
                      </button>
                    )}
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setMenuOpen(false)
                        handleToggleArchive()
                      }}
                      disabled={isArchiving}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left disabled:opacity-50"
                    >
                      {project.status === 'ARCHIVED' ? (
                        <>
                          <ArchiveRestore className="w-4 h-4 shrink-0" />
                          {isArchiving ? t('unarchiving') : t('unarchiveProject')}
                        </>
                      ) : (
                        <>
                          <Archive className="w-4 h-4 shrink-0" />
                          {isArchiving ? t('archiving') : t('archiveProject')}
                        </>
                      )}
                    </button>
                    <div className="my-1 h-px bg-white/10" role="separator" />
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setMenuOpen(false)
                handleDelete()
              }}
              disabled={isDeleting}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-destructive/10 text-destructive text-left disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4 shrink-0" />
              {isDeleting ? tc('deleting') : t('deleteProject')}
            </button>
          </div>
        )}
      </div>

      {/* Notification Modal */}
      <Dialog open={showNotificationModal} onOpenChange={setShowNotificationModal}>
        <DialogContent className="max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5 text-primary" />
              {t('sendNotification')}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Notification Type Selection */}
            <div>
              <label className="text-sm font-medium mb-2 block">
                {t('notificationType')}
              </label>
              <Select value={notificationType} onValueChange={handleNotificationTypeChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="entire-project">
                    {t('entireProject')}
                  </SelectItem>
                  <SelectItem value="specific-video">
                    {t('specificVideo')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Show video/version selectors only for specific video notification */}
            {notificationType === 'specific-video' && (
              <>
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    {t('selectVideo')}
                  </label>
                  <Select value={selectedVideoName} onValueChange={handleVideoNameChange}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('selectVideoPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {videoNames.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedVideoName && (
                  <div>
                    <label className="text-sm font-medium mb-2 block">
                      {t('selectVersion')}
                    </label>
                    <Select value={selectedVideoId} onValueChange={setSelectedVideoId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('selectVersionPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {versionsForSelectedVideo.map((video) => (
                          <SelectItem key={video.id} value={video.id}>
                            {video.versionLabel}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}

            {/* Password checkbox - only show if project is password protected */}
            {isPasswordProtected && (
              <div className="flex items-center space-x-2 p-3 bg-muted rounded-md">
                <input
                  type="checkbox"
                  id="send-password"
                  checked={sendPasswordSeparately}
                  onChange={(e) => setSendPasswordSeparately(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <label
                  htmlFor="send-password"
                  className="text-sm font-medium cursor-pointer"
                >
                  {t('sendPasswordSeparate')}
                </label>
              </div>
            )}

            {isPasswordProtected && (
              <p className="text-xs text-muted-foreground bg-accent/50 p-3 rounded-md border border-border">
                <strong>{t('noteLabel')}</strong> {t('passwordProtected')} {sendPasswordSeparately ? t('passwordSentSeparate') : t('passwordNotIncluded')}
              </p>
            )}

            <Button
              onClick={handleSendNotification}
              disabled={loading || (notificationType === 'specific-video' && !selectedVideoId)}
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('sendingNotification')}
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  {t('sendEmailNotification')}
                </>
              )}
            </Button>

            {message && (
              <div
                className={`p-3 rounded-md text-sm font-medium ${
                  message.type === 'success'
                    ? 'bg-success-visible text-success border-2 border-success-visible'
                    : 'bg-destructive-visible text-destructive border-2 border-destructive-visible'
                }`}
              >
                {message.text}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {notificationType === 'entire-project'
                ? t('notifyAllVideos')
                : t('notifySpecificVideo')}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unapprove Modal */}
      <UnapproveModal
        show={showUnapproveModal}
        onCancel={handleCancelUnapprove}
        onUnapproveProjectOnly={handleUnapproveProjectOnly}
        onUnapproveAll={handleUnapproveAll}
        processing={isTogglingApproval}
      />
    </>
  )
}
