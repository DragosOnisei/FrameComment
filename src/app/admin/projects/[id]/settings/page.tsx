'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PasswordInput } from '@/components/ui/password-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { ReprocessModal } from '@/components/ReprocessModal'
import ProjectCoverImage from '@/components/ProjectCoverImage'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { copyToClipboard } from '@/lib/clipboard'
import { RecipientManager } from '@/components/RecipientManager'
import { ScheduleSelector } from '@/components/ScheduleSelector'
import { SharePasswordRequirements } from '@/components/SharePasswordRequirements'
import { CompanyNameInput } from '@/components/CompanyNameInput'
import { apiFetch } from '@/lib/api-client'
import { sanitizeSlug, generateRandomSlug, generateSecurePassword } from '@/lib/password-utils'
import { apiPatch, apiPost } from '@/lib/api-client'
import { logError } from '@/lib/logging'
import Link from 'next/link'
import { ArrowLeft, Save, RefreshCw, Copy, Check, Calendar, FileText, Users, Share2, Video, Shield, Image as ImageIcon, Upload as UploadIcon, Trash2, Settings as SettingsIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from 'next-intl'
import { TopbarLeftSlot, TopbarRightSlot } from '@/components/TopbarSlots'
import { GlassCalendar } from '@/components/GlassCalendar'

interface Project {
  id: string
  title: string
  slug: string
  description: string | null
  companyName: string | null
  clientCompanyId: string | null
  enableRevisions: boolean
  maxRevisions: number
  restrictCommentsToLatestVersion: boolean
  hideFeedback: boolean
  timestampDisplay: string
  sharePassword: string | null
  sharePasswordDecrypted: string | null
  authMode: string
  guestMode: boolean
  guestLatestOnly: boolean
  previewResolution: string
  watermarkEnabled: boolean
  watermarkText: string | null
  skipTranscoding: boolean
  watermarkPositions: string
  watermarkOpacity: number
  watermarkFontSize: string
  applyPreviewLut: boolean
  allowAssetDownload: boolean
  allowClientAssetUpload: boolean
  allowReverseShare: boolean
  clientCanApprove: boolean
  usePreviewForApprovedPlayback: boolean
  showClientTutorial: boolean
  clientNotificationSchedule: string
  clientNotificationTime: string | null
  clientNotificationDay: number | null
  dueDate: string | null
  dueReminder: string | null
}

export default function ProjectSettingsPage() {
  const params = useParams()
  const router = useRouter()
  const t = useTranslations('projects')
  const tc = useTranslations('common')
  const projectId = params?.id as string

  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [copiedPassword, setCopiedPassword] = useState(false)

  // Form state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [clientCompanyId, setClientCompanyId] = useState<string | null>(null)
  const [enableRevisions, setEnableRevisions] = useState(false)
  const [maxRevisions, setMaxRevisions] = useState<number | ''>('')
  const [restrictCommentsToLatestVersion, setRestrictCommentsToLatestVersion] = useState(false)
  const [hideFeedback, setHideFeedback] = useState(false)
  const [timestampDisplay, setTimestampDisplay] = useState<'AUTO' | 'TIMECODE'>('TIMECODE')
  const [sharePassword, setSharePassword] = useState('')
  const [authMode, setAuthMode] = useState('PASSWORD')
  const [guestMode, setGuestMode] = useState(false)
  const [guestLatestOnly, setGuestLatestOnly] = useState(true)
  const [useCustomSlug, setUseCustomSlug] = useState(false) // Toggle for custom slug
  const [customSlugValue, setCustomSlugValue] = useState('') // Store custom slug value
  const [previewResolution, setPreviewResolution] = useState('720p')
  const [skipTranscoding, setSkipTranscoding] = useState(false)
  const [watermarkEnabled, setWatermarkEnabled] = useState(true)
  const [watermarkText, setWatermarkText] = useState('')
  const [useCustomWatermark, setUseCustomWatermark] = useState(false)
  const [watermarkPositions, setWatermarkPositions] = useState('center')
  const [watermarkOpacity, setWatermarkOpacity] = useState(30)
  const [watermarkFontSize, setWatermarkFontSize] = useState('medium')
  const [applyPreviewLut, setApplyPreviewLut] = useState(true)
  const [allowAssetDownload, setAllowAssetDownload] = useState(true)
  const [allowClientAssetUpload, setAllowClientAssetUpload] = useState(false)
  const [allowReverseShare, setAllowReverseShare] = useState(false)
  const [clientCanApprove, setClientCanApprove] = useState(true)
  const [usePreviewForApprovedPlayback, setUsePreviewForApprovedPlayback] = useState(false)
  const [showClientTutorial, setShowClientTutorial] = useState(true)

  // Notification settings state
  const [clientNotificationSchedule, setClientNotificationSchedule] = useState('HOURLY')
  const [clientNotificationTime, setClientNotificationTime] = useState('09:00')
  const [clientNotificationDay, setClientNotificationDay] = useState(1)

  // Due date state
  const [dueDate, setDueDate] = useState('')
  const [dueReminder, setDueReminder] = useState<'NONE' | 'DAY_BEFORE' | 'WEEK_BEFORE'>('NONE')

  // 1.5.8+: per-project cover image. The cover is shown on the
  // Projects Dashboard tile and (when set) replaces the default
  // deterministic gradient. We let admins edit it from here as a
  // simple replace-the-existing-image flow.
  //
  // The admin GET endpoint requires a bearer token, so we render the
  // preview via `<ProjectCoverImage>` (apiFetch + blob URL) instead
  // of a naked <img src>. `coverCacheKey` bumps every time we mutate
  // the cover so the component re-fetches.
  const [coverExists, setCoverExists] = useState(false)
  const [coverCacheKey, setCoverCacheKey] = useState<number>(Date.now())
  const [coverUploading, setCoverUploading] = useState(false)
  const [coverError, setCoverError] = useState('')
  const coverInputRef = useRef<HTMLInputElement | null>(null)

  // 1.5.8+: shared-folder list for the Security tab. Fetched on
  // mount from a dedicated endpoint so the main project payload
  // stays unchanged for everywhere else that uses it.
  type SharedFolderRow = {
    id: string
    name: string
    slug: string
    authMode: string
    shareExpiresAt: string | null
    parentFolderId: string | null
    hasPassword: boolean
    // 3.2.6+: timestamps (ISO) for the share-link date filter below.
    // The filter uses `updatedAt` (bumps on create / slug rotation /
    // expiry change) so a folder re-shared today shows under "Today",
    // not just folders first created today. `createdAt` kept for
    // reference / fallback.
    createdAt: string
    updatedAt?: string
  }
  const [sharedFolders, setSharedFolders] = useState<SharedFolderRow[]>([])
  // 3.2.6+: date filter for the Security → Folder share links list.
  // Defaults to "today" so a project with hundreds of folders opens
  // showing only the links created today; the segmented control lets
  // the admin widen the window up to "all time".
  type ShareLinkRange = 'today' | 'week' | 'month' | 'year' | 'all'
  const [shareLinkRange, setShareLinkRange] = useState<ShareLinkRange>('today')
  // 1.5.8+: per-row pending state so we can disable buttons + show a
  // small "…" while a folder's share is being updated.
  const [folderShareBusyId, setFolderShareBusyId] = useState<string | null>(null)
  const [folderShareError, setFolderShareError] = useState<string | null>(null)
  // 1.5.8+: rotate-share-link confirmation. Holds the row that the
  // admin clicked "Delete link" on, then the ConfirmDialog renders
  // against this and invokes the actual rotation on OK.
  const [folderToRevoke, setFolderToRevoke] = useState<SharedFolderRow | null>(null)
  // 1.5.8+: tiny success flag per row so the admin gets a visible
  // "Link revoked" badge for a few seconds after a rotation — the
  // raw slug change wasn't obvious enough on its own.
  const [folderJustRevokedId, setFolderJustRevokedId] = useState<string | null>(null)
  // 2.5.1+: GlassCalendar popover state for the per-folder share
  // expiration. Only one calendar can be open at a time across the
  // whole list — track the active folderId + the trigger button's
  // viewport-anchored rect so the popover positions correctly.
  const [calendarFolderId, setCalendarFolderId] = useState<string | null>(null)
  const [calendarAnchor, setCalendarAnchor] = useState<DOMRect | null>(null)
  // 2.5.1+: per-row "Copied" badge for the share-link copy button.
  // Holds the folderId that was just copied, cleared after ~1.8s.
  const [folderJustCopiedId, setFolderJustCopiedId] = useState<string | null>(null)
  // 2.5.1+: cached short links per folder id. Populated by the
  // effect below that mints (or reuses) a tidy
  // `https://<shortDomain>/<slug>` for each shared folder when the
  // list loads. If `Settings.shortLinkDomain` isn't configured, the
  // map stays empty and the row falls back to the long URL — same
  // behaviour as ShareModal.
  const [folderShortLinks, setFolderShortLinks] = useState<Record<string, string>>({})

  /**
   * 2.5.1+: copy a folder's share link to the clipboard. Prefers the
   * tidy short URL (`https://<shortDomain>/<slug>`) when the admin
   * has configured `Settings.shortLinkDomain`; silently falls back
   * to the long `/share/folder/<slug>` URL otherwise. Same pattern
   * as ShareModal so the UX matches end-to-end.
   */
  async function copyFolderShareLink(folder: { id: string; slug: string }) {
    const longUrl = `${window.location.origin}/share/folder/${folder.slug}`
    // Prefer the cached short link — already minted by the effect
    // above when the list loaded. Skips the network round-trip and
    // matches whatever the row visually shows.
    let toCopy = folderShortLinks[folder.id] || longUrl
    if (!folderShortLinks[folder.id]) {
      try {
        const res = await apiFetch('/api/short-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: longUrl, expiresAt: null }),
        })
        if (res.ok) {
          const data = (await res.json()) as {
            shortUrl: string
            shortDomainConfigured: boolean
          }
          if (data.shortDomainConfigured && data.shortUrl) {
            toCopy = data.shortUrl
            // Cache so subsequent renders show the short URL too.
            setFolderShortLinks((prev) => ({ ...prev, [folder.id]: data.shortUrl }))
          }
        }
      } catch {
        // Silent fallback to long URL.
      }
    }
    await copyToClipboard(toCopy)
    setFolderJustCopiedId(folder.id)
    window.setTimeout(() => {
      setFolderJustCopiedId((prev) => (prev === folder.id ? null : prev))
    }, 1800)
  }

  /**
   * Update a single folder's share expiration. Pass a Date to set a
   * future expiry, or `null` to clear it (link becomes unlimited).
   * Optimistically updates the row in-place so the countdown chip
   * reflects the change without a re-fetch.
   */
  async function patchFolderShareExpiry(
    folderId: string,
    expiresAt: Date | null,
  ) {
    setFolderShareBusyId(folderId)
    setFolderShareError(null)
    try {
      const res = await apiFetch(`/api/folders/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareExpiresAt: expiresAt ? expiresAt.toISOString() : null,
        }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setFolderShareError(json?.error || 'Failed to update share link')
        return
      }
      setSharedFolders((rows) =>
        rows.map((r) =>
          r.id === folderId
            ? { ...r, shareExpiresAt: expiresAt ? expiresAt.toISOString() : null }
            : r,
        ),
      )
    } catch (err) {
      logError('[ProjectSettings] patchFolderShareExpiry', err)
      setFolderShareError('Failed to update share link')
    } finally {
      setFolderShareBusyId(null)
    }
  }

  /**
   * Rotate a folder's share slug so anyone holding the old URL is
   * locked out. The folder content survives — only the public URL
   * changes. The caller has already shown the ConfirmDialog and
   * confirmed; this function does the actual network round-trip.
   */
  async function rotateFolderShareLink(folderId: string) {
    setFolderShareBusyId(folderId)
    setFolderShareError(null)
    try {
      const res = await apiFetch(`/api/folders/${folderId}/rotate-share-link`, {
        method: 'POST',
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setFolderShareError(json?.error || 'Failed to rotate share link')
        return
      }
      const json = await res.json()
      if (json?.slug) {
        // 1.5.8: drop the row immediately. The server also stamps
        // shareExpiresAt to epoch 0 so subsequent reloads keep this
        // folder out of the list until it's re-shared from
        // FolderBrowser. Resharing sets a real expiration (or null)
        // which makes the row reappear automatically.
        setSharedFolders((rows) => rows.filter((r) => r.id !== folderId))
      }
    } catch (err) {
      logError('[ProjectSettings] rotateFolderShareLink', err)
      setFolderShareError('Failed to rotate share link')
    } finally {
      setFolderShareBusyId(null)
    }
  }

  // SMTP and recipients validation (for OTP)
  const [smtpConfigured, setSmtpConfigured] = useState(true)
  const [recipients, setRecipients] = useState<any[]>([])
  const hasRecipientWithEmail = recipients?.some((r: any) => r.email && r.email.trim() !== '') || false

  // Collapsible section state (all collapsed by default, used on mobile)
  const [showProjectDetails, setShowProjectDetails] = useState(false)
  const [showClientInfo, setShowClientInfo] = useState(false)
  const [showClientSharePage, setShowClientSharePage] = useState(false)
  const [showVideoProcessing, setShowVideoProcessing] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)

  // Desktop sidebar navigation
  const [activeSection, setActiveSection] = useState('project-details')

  // Track original processing settings for change detection
  const [originalSettings, setOriginalSettings] = useState({
    title: '',
    previewResolution: '720p',
    skipTranscoding: false,
    watermarkEnabled: true,
    watermarkText: null as string | null,
    watermarkPositions: 'center',
    watermarkOpacity: 30,
    watermarkFontSize: 'medium',
    applyPreviewLut: true,
  })

  // Reprocessing state
  // 2.2.4+: ReprocessModal is gone. The Save Changes button now
  // saves settings directly without offering reprocess as a side
  // effect. Reprocess + Regen Thumbnails got their own dedicated
  // buttons under Video Processing, each with its own confirm
  // dialog. We keep the state vars around for the old modal so we
  // can remove the renderer below in one swipe without breaking
  // unrelated handlers — they default to false / null forever now.
  const [showReprocessModal, setShowReprocessModal] = useState(false)
  const [pendingUpdates, setPendingUpdates] = useState<any>(null)
  const [reprocessing, setReprocessing] = useState(false)
  // 2.2.4+: dedicated maintenance state
  const [regeneratingThumbnails, setRegeneratingThumbnails] = useState(false)
  const [showReprocessConfirm, setShowReprocessConfirm] = useState(false)
  const [showRegenThumbsConfirm, setShowRegenThumbsConfirm] = useState(false)
  const [maintenanceResult, setMaintenanceResult] = useState<{ kind: 'reprocess' | 'regen-thumbs'; count: number } | null>(null)

  // Auto-generate slug from title
  const autoGeneratedSlug = sanitizeSlug(title)

  // Use custom slug if enabled, otherwise use auto-generated
  const slug = useCustomSlug ? customSlugValue : autoGeneratedSlug

  // Sanitize slug for live preview
  const sanitizedSlug = sanitizeSlug(slug)

  const copyPassword = async () => {
    if (sharePassword) {
      await copyToClipboard(sharePassword)
      setCopiedPassword(true)
      setTimeout(() => setCopiedPassword(false), 2000)
    }
  }

  useEffect(() => {
    async function loadProject() {
      try {
        const response = await apiFetch(`/api/projects/${projectId}`)
        if (!response.ok) {
          throw new Error(t('failedToLoad'))
        }
        const data = await response.json()
        setProject(data)

        // Set SMTP status and recipients
        setSmtpConfigured(data.smtpConfigured !== false)
        setRecipients(data.recipients || [])

        // Set form values
        setTitle(data.title)
        setDescription(data.description || '')
        setCompanyName(data.companyName || '')
        setClientCompanyId(data.clientCompanyId || null)
        setEnableRevisions(data.enableRevisions)
        setMaxRevisions(data.maxRevisions)
        setRestrictCommentsToLatestVersion(data.restrictCommentsToLatestVersion)
        setHideFeedback(data.hideFeedback || false)
        setTimestampDisplay(data.timestampDisplay || 'TIMECODE')
        setPreviewResolution(data.previewResolution)
        setSkipTranscoding(data.skipTranscoding ?? false)
        setWatermarkEnabled(data.watermarkEnabled ?? true)
        setWatermarkText(data.watermarkText || '')
        setUseCustomWatermark(!!data.watermarkText)
        setWatermarkPositions(data.watermarkPositions || 'center')
        setWatermarkOpacity(data.watermarkOpacity ?? 30)
        setWatermarkFontSize(data.watermarkFontSize || 'medium')
        setApplyPreviewLut(data.applyPreviewLut ?? true)
        setAllowAssetDownload(data.allowAssetDownload ?? true)
        setAllowClientAssetUpload(data.allowClientAssetUpload ?? false)
        setAllowReverseShare(data.allowReverseShare ?? false)
        setClientCanApprove(data.clientCanApprove ?? true)
        setUsePreviewForApprovedPlayback(data.usePreviewForApprovedPlayback ?? false)
        setShowClientTutorial(data.showClientTutorial ?? true)
        setAuthMode(data.authMode || 'PASSWORD')
        setGuestMode(data.guestMode || false)
        setGuestLatestOnly(data.guestLatestOnly ?? true)
        setSharePassword(data.sharePassword || '')

        // Store original processing settings
        setOriginalSettings({
          title: data.title,
          previewResolution: data.previewResolution,
          skipTranscoding: data.skipTranscoding ?? false,
          watermarkEnabled: data.watermarkEnabled ?? true,
          watermarkText: data.watermarkText,
          watermarkPositions: data.watermarkPositions || 'center',
          watermarkOpacity: data.watermarkOpacity ?? 30,
          watermarkFontSize: data.watermarkFontSize || 'medium',
          applyPreviewLut: data.applyPreviewLut ?? true,
        })

        // Check if slug was manually customized (different from auto-generated from title)
        const autoGeneratedSlug = sanitizeSlug(data.title)
        if (data.slug !== autoGeneratedSlug) {
          setUseCustomSlug(true)
          setCustomSlugValue(data.slug)
        }

        // Set due date
        if (data.dueDate) {
          const d = new Date(data.dueDate)
          setDueDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
        }
        setDueReminder(data.dueReminder || 'NONE')

        // Set notification settings
        setClientNotificationSchedule(data.clientNotificationSchedule || 'HOURLY')
        setClientNotificationTime(data.clientNotificationTime || '09:00')
        setClientNotificationDay(data.clientNotificationDay ?? 1)

        // 1.5.8+: hydrate per-project cover image existence. The
        // actual fetch is delegated to <ProjectCoverImage>, which
        // handles the bearer-auth + blob-URL dance.
        setCoverExists(!!data.coverImagePath)
        setCoverCacheKey(Date.now())

        // Mark initial load as complete
        setInitialLoadComplete(true)
      } catch (err) {
        setError(t('failedToLoadSettings'))
      } finally {
        setLoading(false)
      }
    }

    loadProject()
  }, [projectId, t])

  // 1.5.8+: fetch the shared-folder list for the Security tab in
  // parallel with the main project load. Failure here just leaves
  // the list empty — the Security tab still renders, it just won't
  // list any folders.
  useEffect(() => {
    let cancelled = false
    async function loadSharedFolders() {
      try {
        const res = await apiFetch(`/api/projects/${projectId}/shared-folders`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        if (Array.isArray(data?.folders)) {
          setSharedFolders(data.folders as SharedFolderRow[])
        }
      } catch {
        // Non-fatal — silently skip the panel.
      }
    }
    void loadSharedFolders()
    return () => {
      cancelled = true
    }
  }, [projectId])

  // 2.5.1+: mint a tidy `https://<shortDomain>/<slug>` short link
  // for every folder in the shared list, so the Security rows can
  // show the SAME link the admin gets from Copy in ShareModal
  // (`https://fcmt.io/krhewABV`) instead of the long signed URL.
  // The POST is idempotent server-side — same `targetUrl` reuses
  // the existing short link, so re-running on every load doesn't
  // create slug churn. Silently no-ops when `shortLinkDomain` is
  // not configured (`shortDomainConfigured: false`) — the row then
  // falls back to the long URL.
  useEffect(() => {
    if (sharedFolders.length === 0) return
    if (typeof window === 'undefined') return
    let cancelled = false
    const origin = window.location.origin
    void (async () => {
      const results = await Promise.all(
        sharedFolders.map(async (f) => {
          if (folderShortLinks[f.id]) return [f.id, folderShortLinks[f.id]] as const
          try {
            const res = await apiFetch('/api/short-links', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetUrl: `${origin}/share/folder/${f.slug}`,
                expiresAt: null,
              }),
            })
            if (!res.ok) return [f.id, ''] as const
            const data = (await res.json()) as {
              shortUrl: string
              shortDomainConfigured: boolean
            }
            if (data.shortDomainConfigured && data.shortUrl) {
              return [f.id, data.shortUrl] as const
            }
            return [f.id, ''] as const
          } catch {
            return [f.id, ''] as const
          }
        }),
      )
      if (cancelled) return
      setFolderShortLinks((prev) => {
        const next = { ...prev }
        for (const [id, url] of results) {
          if (url) next[id] = url
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- folderShortLinks
    // intentionally omitted; we read inside the closure but only want to
    // re-run when the folder list itself changes (rotations / new shares).
  }, [sharedFolders])

  // Track if initial load is complete
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)

  // Clear password when switching to NONE mode
  useEffect(() => {
    if (initialLoadComplete && authMode === 'NONE') {
      setSharePassword('')
    }
  }, [authMode, initialLoadComplete])

  /**
   * 1.5.8+: Replace the per-project cover image. POSTs the raw file
   * to `/api/projects/[id]/cover` (which writes to
   * `projects/{id}/cover.{ext}` and updates the DB pointer), then
   * refreshes the preview URL with a cache-buster so the new image
   * shows up immediately on the settings page and the dashboard tile.
   */
  async function handleCoverUpload(file: File) {
    setCoverError('')
    setCoverUploading(true)
    try {
      // Client-side guardrails — server re-validates everything.
      const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']
      if (!allowed.includes(file.type.toLowerCase())) {
        setCoverError('Use PNG, JPEG, WEBP or GIF.')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        setCoverError('Image too large (max 5 MB).')
        return
      }

      const form = new FormData()
      form.append('file', file)
      const res = await apiFetch(`/api/projects/${projectId}/cover`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setCoverError(json?.error || 'Failed to upload image.')
        return
      }
      setCoverExists(true)
      setCoverCacheKey(Date.now())
    } catch (err) {
      logError('[ProjectSettings] handleCoverUpload', err)
      setCoverError('Failed to upload image.')
    } finally {
      setCoverUploading(false)
    }
  }

  /**
   * 1.5.8+: Remove the cover image. After removal the dashboard tile
   * falls back to the deterministic gradient. Idempotent on the
   * server so a double-click is safe.
   */
  async function handleCoverRemove() {
    setCoverError('')
    setCoverUploading(true)
    try {
      const res = await apiFetch(`/api/projects/${projectId}/cover`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 204) {
        const json = await res.json().catch(() => null)
        setCoverError(json?.error || 'Failed to remove image.')
        return
      }
      setCoverExists(false)
      setCoverCacheKey(Date.now())
    } catch (err) {
      logError('[ProjectSettings] handleCoverRemove', err)
      setCoverError('Failed to remove image.')
    } finally {
      setCoverUploading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setSuccess(false)

    try {
      const sanitizedSlug = sanitizeSlug(slug)

      if (!sanitizedSlug) {
        setError(t('shareLinkEmpty'))
        setSaving(false)
        return
      }

      // Validate OTP requirements
      if ((authMode === 'OTP' || authMode === 'BOTH') && !smtpConfigured) {
        setError(t('otpRequiresSMTP'))
        setSaving(false)
        return
      }

      if ((authMode === 'OTP' || authMode === 'BOTH') && !hasRecipientWithEmail) {
        setError(t('otpRequiresRecipients'))
        setSaving(false)
        return
      }

      // Ensure revision values are valid numbers before saving
      const finalMaxRevisions = typeof maxRevisions === 'number' ? maxRevisions : parseInt(String(maxRevisions), 10) || 1

      // Validate: maxRevisions must be at least 1
      if (enableRevisions && finalMaxRevisions < 1) {
        setError(t('maxRevisionsMinError'))
        setSaving(false)
        return
      }

      const updates: any = {
        title,
        slug: sanitizedSlug,
        description: description || null,
        companyName: companyName || null,
        clientCompanyId: clientCompanyId || null,
        enableRevisions,
        maxRevisions: enableRevisions ? finalMaxRevisions : 0,
        restrictCommentsToLatestVersion,
        hideFeedback,
        timestampDisplay,
        previewResolution,
        skipTranscoding,
        watermarkEnabled,
        watermarkText: useCustomWatermark ? watermarkText : null,
        watermarkPositions,
        watermarkOpacity,
        watermarkFontSize,
        applyPreviewLut,
        allowAssetDownload,
        allowClientAssetUpload,
        allowReverseShare,
        clientCanApprove,
        usePreviewForApprovedPlayback,
        showClientTutorial,
        sharePassword: sharePassword || null,
        authMode,
        guestMode,
        guestLatestOnly,
        clientNotificationSchedule,
        clientNotificationTime: (clientNotificationSchedule === 'DAILY' || clientNotificationSchedule === 'WEEKLY') ? clientNotificationTime : null,
        clientNotificationDay: clientNotificationSchedule === 'WEEKLY' ? clientNotificationDay : null,
        dueDate: dueDate ? `${dueDate}T12:00:00.000Z` : null,
        dueReminder: dueDate ? dueReminder : null,
      }

      // 2.2.4+: previously this block compared current vs original
      // processing settings (title, previewResolution, skipTranscoding,
      // watermark*, applyPreviewLut) and popped a ReprocessModal asking
      // the operator whether to re-encode every video in the project.
      // That was always a confusing place for it — Save Changes should
      // save changes, not nuke encode work. Reprocess + Regen Thumbnails
      // now live as dedicated buttons under the Default Preview
      // Resolution field, each with its own ConfirmDialog. Save just
      // saves now.
      await saveSettings(updates)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSave'))
      setSaving(false)
    }
  }

  async function saveSettings(updates: any, shouldReprocess = false) {
    setSaving(true)
    setError('')

    try {
      // Save project settings
      await apiPatch(`/api/projects/${projectId}`, updates)

      // Update custom slug value to sanitized version if using custom slug
      const sanitizedSlug = updates.slug
      if (useCustomSlug) {
        setCustomSlugValue(sanitizedSlug)
      }

      // Reprocess videos if requested
      if (shouldReprocess) {
        await reprocessVideos()
      }

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)

      // Reload project data to reflect changes
      const refreshResponse = await apiFetch(`/api/projects/${projectId}`)
      if (refreshResponse.ok) {
        const refreshedData = await refreshResponse.json()
        setProject(refreshedData)
        setWatermarkEnabled(refreshedData.watermarkEnabled ?? true)
        setWatermarkText(refreshedData.watermarkText || '')
        setUseCustomWatermark(!!refreshedData.watermarkText)
        setWatermarkPositions(refreshedData.watermarkPositions || 'center')
        setWatermarkOpacity(refreshedData.watermarkOpacity ?? 30)
        setWatermarkFontSize(refreshedData.watermarkFontSize || 'medium')
        setApplyPreviewLut(refreshedData.applyPreviewLut ?? true)

        // Update original settings
        setOriginalSettings({
          title: refreshedData.title,
          previewResolution: refreshedData.previewResolution,
          skipTranscoding: refreshedData.skipTranscoding ?? false,
          watermarkEnabled: refreshedData.watermarkEnabled ?? true,
          watermarkText: refreshedData.watermarkText,
          watermarkPositions: refreshedData.watermarkPositions || 'center',
          watermarkOpacity: refreshedData.watermarkOpacity ?? 30,
          watermarkFontSize: refreshedData.watermarkFontSize || 'medium',
          applyPreviewLut: refreshedData.applyPreviewLut ?? true,
        })
      }

      // Refresh the page
      router.refresh()

      // Close modal and reset pending updates
      setShowReprocessModal(false)
      setPendingUpdates(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSave'))
    } finally {
      setSaving(false)
    }
  }

  async function reprocessVideos() {
    setReprocessing(true)
    try {
      await apiPost(`/api/projects/${projectId}/reprocess`, {})
    } catch (err) {
      logError('Error reprocessing videos:', err)
      // Don't throw - we still want to save settings
    } finally {
      setReprocessing(false)
    }
  }

  // 2.2.4+: Reprocess Videos button handler. Called from the
  // ConfirmDialog after the operator confirms. We surface the count
  // returned by the endpoint so the operator can sanity-check that
  // the right set of videos got picked up.
  async function handleConfirmReprocess() {
    setShowReprocessConfirm(false)
    setReprocessing(true)
    setError('')
    try {
      const res: any = await apiPost(`/api/projects/${projectId}/reprocess`, {})
      const count = typeof res?.count === 'number' ? res.count : 0
      setMaintenanceResult({ kind: 'reprocess', count })
      setTimeout(() => setMaintenanceResult(null), 6000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSave'))
    } finally {
      setReprocessing(false)
    }
  }

  // 2.2.4+: Re-generate Thumbnails button handler. Enqueues the
  // lightweight `regenerate-thumbnail` job for every READY video in
  // the project. No encode work, no status churn — just thumbnails.
  async function handleConfirmRegenThumbs() {
    setShowRegenThumbsConfirm(false)
    setRegeneratingThumbnails(true)
    setError('')
    try {
      const res: any = await apiPost(`/api/projects/${projectId}/regenerate-thumbnails`, {})
      const count = typeof res?.count === 'number' ? res.count : 0
      setMaintenanceResult({ kind: 'regen-thumbs', count })
      setTimeout(() => setMaintenanceResult(null), 6000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToSave'))
    } finally {
      setRegeneratingThumbnails(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <p className="text-white/55">{tc('loading')}</p>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <p className="text-white/55">{t('projectNotFound')}</p>
      </div>
    )
  }

  // 1.5.8: dropped "Client Information & Notifications" and
  // "Client Share Page" from the sidebar entirely. The underlying
  // state, content blocks, and CollapsibleSection renders below are
  // gated on these IDs being present, so removing them here also
  // takes those panes out of the desktop right pane (`activeSection`
  // can never be 'client-info' or 'client-share' anymore) and out of
  // the mobile collapsible list further down. To restore them, add
  // their entries back to this array.
  const settingSections = [
    { id: 'project-details', label: t('projectDetails'), icon: FileText },
    { id: 'video-processing', label: t('videoProcessing'), icon: Video },
    { id: 'security', label: t('security'), icon: Shield },
  ]

  return (
    <div className="flex-1 min-h-0">
      {/* 2.5.1+: portal the page title block + Save Changes into the
          shared AdminTopBar slots, same pattern as Global Settings /
          Projects / Users. Back pill on the left next to the title,
          Save Changes glass pill on the right. The body header below
          is gone — the bottom Save button is gone too — so the only
          way to save is the topbar action. */}
      <TopbarLeftSlot>
        <Link href={`/admin/projects/${projectId}`}>
          <Button
            variant="ghost"
            size="sm"
            className="md:size-default md:h-10 md:px-4 bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 hover:ring-white/20 text-white border-0 backdrop-blur-md shrink-0"
            aria-label={tc('back')}
          >
            <ArrowLeft className="w-4 h-4 md:mr-2" />
            <span className="hidden md:inline">{tc('back')}</span>
          </Button>
        </Link>
        <SettingsIcon size={20} className="text-primary shrink-0" />
        <h1
          className="font-semibold truncate text-white"
          style={{ fontSize: 18, lineHeight: '24px' }}
        >
          {t('projectSettings')}
        </h1>
      </TopbarLeftSlot>
      <TopbarRightSlot>
        <Button
          onClick={handleSave}
          variant="ghost"
          size="sm"
          disabled={saving}
          className="sm:h-9 sm:px-3 ring-1 ring-white/10 text-white hover:text-white"
          style={{
            backgroundColor: 'rgba(255,255,255,0.06)',
            backdropFilter: 'blur(12px) saturate(140%)',
            WebkitBackdropFilter: 'blur(12px) saturate(140%)',
          }}
        >
          <Save className="w-4 h-4 sm:mr-2" />
          <span className="hidden sm:inline">{saving ? tc('saving') : tc('saveChanges')}</span>
        </Button>
      </TopbarRightSlot>

      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        {/* 2.5.1+: project name subtitle removed — the topbar pill
            already shows the project context. The body now starts
            directly with the section nav + panel. */}

        {error && (
          <div
            className="mb-4 sm:mb-6 p-3 sm:p-4 rounded-lg ring-1 ring-red-400/30"
            style={{
              backgroundColor: 'rgba(248, 113, 113, 0.10)',
              backdropFilter: 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: 'blur(24px) saturate(160%)',
            }}
          >
            <p className="text-xs sm:text-sm text-red-300 font-medium">{error}</p>
          </div>
        )}

        {success && (
          <div
            className="mb-4 sm:mb-6 p-3 sm:p-4 rounded-lg ring-1 ring-emerald-400/30"
            style={{
              backgroundColor: 'rgba(52, 211, 153, 0.10)',
              backdropFilter: 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: 'blur(24px) saturate(160%)',
            }}
          >
            <p className="text-xs sm:text-sm text-emerald-300 font-medium">{t('settingsSaved')}</p>
          </div>
        )}

        {/* Section content blocks (shared between mobile and desktop layouts) */}
        {(() => {
          const projectDetailsContent = (
            <>
	              {/* Project Title — own glass card to match the
	                  Branding section layout (one field per card). */}
	              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
	                <Label htmlFor="title" className="text-white">{t('titleLabel')}</Label>
	                <Input
                  id="title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('titlePlaceholderShort')}
                  className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/45 focus-visible:ring-primary/60"
                />
                <p className="text-xs text-white/55">
                  {t('titleHint')}
                </p>
              </div>

              {/* Description — own glass card. */}
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <Label htmlFor="description" className="text-white">{t('descriptionLabel')}</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('descriptionPlaceholderShort')}
                  rows={3}
                  className="bg-white/[0.04] border-white/10 text-white placeholder:text-white/45 focus-visible:ring-primary/60"
                />
                <p className="text-xs text-white/55">
                  {t('descriptionHint')}
                </p>
              </div>

              {/* 1.5.8: Custom Link + Share Link card hidden to declutter
                  settings. Slug logic preserved — auto-generated slugs
                  continue to work, custom slugs already saved keep
                  resolving. Restore the UI by removing the `{false && `
                  wrapper. */}
              {false && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="useCustomSlug">{t('customLink')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('customLinkDescription')}
                    </p>
                  </div>
                  <Switch
                    id="useCustomSlug"
                    checked={useCustomSlug}
                    onCheckedChange={setUseCustomSlug}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="slug">{t('shareLink')}</Label>
                  <div className="flex gap-2 items-center">
                    <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                      /share/
                    </span>
                    {useCustomSlug ? (
                      <>
                        <Input
                          id="slug"
                          type="text"
                          value={customSlugValue}
                          onChange={(e) => setCustomSlugValue(e.target.value)}
                          placeholder={t('shareLinkPlaceholder')}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setCustomSlugValue(generateRandomSlug())}
                          title={t('generateRandomURL')}
                          className="h-10 w-10 p-0 flex-shrink-0"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      </>
                    ) : (
                      <Input
                        id="slug"
                        type="text"
                        value={autoGeneratedSlug}
                        disabled
                        className="flex-1 opacity-60"
                      />
                    )}
                  </div>
                  {useCustomSlug && customSlugValue && customSlugValue !== sanitizedSlug && (
                    <p className="text-xs text-warning">
                      {t('willBeSavedAs')} <span className="font-mono font-semibold">{sanitizedSlug}</span>
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
	                    {useCustomSlug
	                      ? t('customSlugHint')
	                      : t('autoSlugHint')}
	                  </p>
	                </div>
	              </div>
              )}

              {/* 1.5.8: Revision Tracking section hidden to declutter
                  settings. The feature still works (DB column + API
                  endpoints unchanged); restore the UI by removing the
                  `{false && ` wrapper. */}
              {false && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="enableRevisions">{t('enableRevisionTracking')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('enableRevisionTrackingDescription')}
                    </p>
                  </div>
                  <Switch
                    id="enableRevisions"
                    checked={enableRevisions}
                    onCheckedChange={setEnableRevisions}
                  />
                </div>

                {enableRevisions && (
                  <div className="space-y-2">
                    <Label htmlFor="maxRevisions">{t('maxRevisions')}</Label>
                    <Input
                      id="maxRevisions"
                      type="number"
                      min="1"
                      max="20"
                      value={maxRevisions}
                      onChange={(e) => {
                        const val = e.target.value
                        if (val === '') {
                          setMaxRevisions('')
                        } else {
                          const num = parseInt(val, 10)
                          if (!isNaN(num)) setMaxRevisions(num)
                        }
                      }}
                      onBlur={(e) => {
                        const val = e.target.value
                        if (val === '') {
                          setMaxRevisions(1)
                        } else {
                          const num = parseInt(val, 10)
                          if (isNaN(num) || num < 1) setMaxRevisions(1)
                          else if (num > 20) setMaxRevisions(20)
                        }
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('maxRevisionsHint')}
                    </p>
                  </div>
                )}
              </div>
              )}

              {/* 1.5.8: Due Date section hidden to declutter settings.
                  Logic preserved — projects with existing due dates keep
                  them in the DB and reminders still fire. Restore the
                  UI by removing the `{false && ` wrapper. */}
              {false && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <Label htmlFor="dueDate" className="flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  {t('dueDateLabel')}
                </Label>
                <div className="space-y-3">
                  <Input
                    id="dueDate"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('dueDateHint')}
                  </p>

                  {dueDate && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <Label htmlFor="dueReminder">{t('reminder')}</Label>
                      <Select value={dueReminder} onValueChange={(v) => setDueReminder(v as 'NONE' | 'DAY_BEFORE' | 'WEEK_BEFORE')}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NONE">{t('noReminder')}</SelectItem>
                          <SelectItem value="DAY_BEFORE">{t('dayBefore')}</SelectItem>
                          <SelectItem value="WEEK_BEFORE">{t('weekBefore')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {t('reminderHint')}
                      </p>
                    </div>
                  )}

                  {dueDate && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => { setDueDate(''); setDueReminder('NONE') }}
                    >
                      {t('clearDueDate')}
                    </Button>
                  )}
                </div>
              </div>
              )}

              {/* 1.5.8+: per-project cover image. Shown on the
                  Projects Dashboard tile. Removing falls back to the
                  deterministic gradient. */}
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="space-y-0.5">
                  <Label className="flex items-center gap-2">
                    <ImageIcon className="w-4 h-4" />
                    Cover image
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Shown on this project&apos;s tile in the dashboard. Leave empty to use the auto-generated gradient. PNG, JPEG, WEBP or GIF up to 5 MB.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 ring-white/15 bg-white/[0.04]">
                    {coverExists ? (
                      <ProjectCoverImage
                        projectId={projectId}
                        cacheKey={coverCacheKey}
                        alt="Cover preview"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageIcon className="h-7 w-7 text-white/40" />
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={coverInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) handleCoverUpload(f)
                        // Reset so the same file can be re-selected after
                        // an error or removal.
                        e.target.value = ''
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={coverUploading}
                      onClick={() => coverInputRef.current?.click()}
                      className="gap-2 bg-white/[0.04] hover:bg-white/[0.08] border-white/15 text-white shadow-none"
                    >
                      <UploadIcon className="h-4 w-4" />
                      {coverExists ? 'Change image' : 'Upload image'}
                    </Button>
                    {coverExists && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={coverUploading}
                        onClick={handleCoverRemove}
                        className="gap-2 h-9 px-3 rounded-lg ring-1 ring-red-400/25 hover:ring-red-400/45 text-red-300 hover:text-red-200 shadow-none transition-all"
                        style={{
                          backgroundColor: 'rgba(248, 113, 113, 0.08)',
                          backdropFilter: 'blur(12px) saturate(140%)',
                          WebkitBackdropFilter: 'blur(12px) saturate(140%)',
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>

                {coverError && (
                  <p className="text-xs text-red-300">{coverError}</p>
                )}
                {coverUploading && !coverError && (
                  <p className="text-xs text-white/55">Uploading…</p>
                )}
              </div>
            </>
          )

          // Client Info & Notifications content
          const clientInfoContent = (
            <>
              {/* Company/Brand Selection */}
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="space-y-2">
                  <Label htmlFor="companyName">{t('companyBrandName')}</Label>
                  <CompanyNameInput
                    value={companyName}
                    selectedId={clientCompanyId}
                    onChange={(name, id) => {
                      setCompanyName(name)
                      setClientCompanyId(id)
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('companyBrandNameHint')}
                  </p>
                </div>
              </div>

              {/* Recipients */}
              <div className="space-y-3">
                <RecipientManager
                  projectId={projectId}
                  companyId={clientCompanyId}
                  onError={setError}
                  onRecipientsChange={setRecipients}
                />
              </div>

              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <ScheduleSelector
                  schedule={clientNotificationSchedule}
                  time={clientNotificationTime}
                  day={clientNotificationDay}
                  onScheduleChange={setClientNotificationSchedule}
                  onTimeChange={setClientNotificationTime}
                  onDayChange={setClientNotificationDay}
                  label={t('clientNotificationSchedule')}
	                  description={t('clientNotificationScheduleDescription')}
	                />
	              </div>
            </>
          )

          // Client Share Page content
          const clientShareContent = (
            <>
              {/* ── Approval & Workflow ─────────────────────────────────── */}
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="clientCanApprove">{t('allowClientApproval')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('allowClientApprovalDescription')}
                    </p>
                  </div>
                  <Switch
                    id="clientCanApprove"
                    checked={clientCanApprove}
                    onCheckedChange={setClientCanApprove}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="usePreviewForApprovedPlayback">{t('usePreviewForApproved')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('usePreviewForApprovedDescription')}
                    </p>
                  </div>
                  <Switch
                    id="usePreviewForApprovedPlayback"
                    checked={usePreviewForApprovedPlayback}
                    onCheckedChange={setUsePreviewForApprovedPlayback}
                  />
                </div>
                {usePreviewForApprovedPlayback && watermarkEnabled && (
                  <p className="text-xs text-muted-foreground italic">
                    {t('cleanPreviewHint')}
                  </p>
                )}
              </div>

              {/* ── Client Access ────────────────────────────────────────── */}
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="allowAssetDownload">{t('allowAssetDownloads')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('allowAssetDownloadsDescription')}
                    </p>
                  </div>
                  <Switch
                    id="allowAssetDownload"
                    checked={allowAssetDownload}
                    onCheckedChange={setAllowAssetDownload}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="allowClientAssetUpload">{t('allowClientFileAttachments')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('allowClientFileAttachmentsDescription')}
                    </p>
                  </div>
                  <Switch
                    id="allowClientAssetUpload"
                    checked={allowClientAssetUpload}
                    onCheckedChange={setAllowClientAssetUpload}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="allowReverseShare">{t('allowReverseShare')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('allowReverseShareDescription')}
                    </p>
                  </div>
                  <Switch
                    id="allowReverseShare"
                    checked={allowReverseShare}
                    onCheckedChange={setAllowReverseShare}
                  />
                </div>
              </div>

              {/* ── Presentation ─────────────────────────────────────────── */}
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="showClientTutorial">{t('showClientTutorial')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('showClientTutorialDescription')}
                    </p>
                  </div>
                  <Switch
                    id="showClientTutorial"
                    checked={showClientTutorial}
                    onCheckedChange={setShowClientTutorial}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 pt-2 mt-1 border-t border-border">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="hideFeedback">{t('hideFeedbackSection')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('hideFeedbackSectionDescription')}
                    </p>
                  </div>
                  <Switch
                    id="hideFeedback"
                    checked={hideFeedback}
                    onCheckedChange={setHideFeedback}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="restrictComments">{t('restrictCommentsLatest')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('restrictCommentsLatestDescription')}
                    </p>
                  </div>
                  <Switch
                    id="restrictComments"
                    checked={restrictCommentsToLatestVersion}
                    onCheckedChange={setRestrictCommentsToLatestVersion}
                  />
                </div>

                <div className="space-y-2 pt-2 mt-2 border-t border-border">
                  <Label>{t('commentTimestampDisplay')}</Label>
                  <Select value={timestampDisplay} onValueChange={(v) => setTimestampDisplay(v as 'AUTO' | 'TIMECODE')}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TIMECODE">{t('timecodeFormat')}</SelectItem>
                      <SelectItem value="AUTO">{t('simpleTimeFormat')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('commentTimestampDisplayHint')}
                  </p>
                </div>
              </div>
            </>
          )

          // Video Processing content
          const videoProcessingContent = (
            <>
              {/* 1.5.8: Skip Transcoding card hidden — operator never
                  wants to expose this on a per-project basis (it lets
                  the original file bypass our preview pipeline
                  entirely, which is a one-way decision usually made
                  at install time, not per project). State + handler
                  preserved; remove `{false && ` to bring the toggle
                  back. */}
              {false && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="skipTranscoding">{t('skipTranscoding')}</Label>
                    <p className="text-xs text-muted-foreground">{t('skipTranscodingHint')}</p>
                  </div>
                  <Switch id="skipTranscoding" checked={skipTranscoding} onCheckedChange={(checked) => {
                    setSkipTranscoding(checked)
                    if (checked) {
                      setWatermarkEnabled(false)
                      setApplyPreviewLut(false)
                    }
                  }} />
                </div>
                {skipTranscoding && (
                  <p className="text-xs text-warning">{t('skipTranscodingWarning')}</p>
                )}
              </div>
              )}

              {!skipTranscoding && (
	              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
	                <div className="space-y-2">
	                  {/* 1.5.8: relabelled "Preview Resolution" →
	                      "Default Preview Resolution" so the page reads
	                      cleanly with only this Video Processing field
	                      remaining. */}
	                  <Label className="text-white">Default Preview Resolution</Label>
	                  <Select value={previewResolution} onValueChange={setPreviewResolution}>
                    <SelectTrigger className="bg-white/[0.04] border-white/15 text-white hover:bg-white/[0.06] hover:border-white/25 focus:ring-primary/60 transition-colors">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      className="border-0 ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] text-white"
                      style={{
                        backgroundColor: 'rgba(22, 37, 51, 0.55)',
                        backgroundImage:
                          'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
                        backdropFilter: 'blur(24px) saturate(160%)',
                        WebkitBackdropFilter: 'blur(24px) saturate(160%)',
                      }}
                    >
                      {/* 1.9.4+ Phase A: Auto matches the source — we
                          always start with a fast 480p tier, then
                          climb the ladder up to whatever the input
                          actually resolves at (no upscaling). */}
                      <SelectItem value="auto" className="text-white focus:bg-primary/15 focus:text-primary data-[state=checked]:text-primary">Auto (match source — recommended)</SelectItem>
                      <SelectItem value="720p" className="text-white focus:bg-primary/15 focus:text-primary data-[state=checked]:text-primary">{t('resolution720p')}</SelectItem>
                      <SelectItem value="1080p" className="text-white focus:bg-primary/15 focus:text-primary data-[state=checked]:text-primary">{t('resolution1080p')}</SelectItem>
                      <SelectItem value="2160p" className="text-white focus:bg-primary/15 focus:text-primary data-[state=checked]:text-primary">{t('resolution2160p')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-white/55">
                    The progressive ladder always starts at 480p for fast first playback, then climbs to the chosen cap (or the source resolution in Auto mode).
                  </p>
                </div>
              </div>
              )}

              {/* 2.2.4+: Maintenance actions. Previously these were
                  hidden behind the "save settings" flow — the
                  ReprocessModal popped only when the operator
                  changed an unrelated processing field, easy to
                  miss. Now two dedicated buttons right under the
                  Default Preview Resolution dropdown, each gated
                  by its own ConfirmDialog. */}
              {!skipTranscoding && (
                <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-white">Maintenance</h3>
                    <p className="text-xs text-white/55">
                      Operations that act on every video already in this project. Originals on disk are never touched — both actions only refresh derived files (encoded previews / thumbnails).
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3 items-stretch">
                    {/* 2.2.4+: flex column with flex-1 spacer on the
                        description pushes the Button to the bottom of
                        each card. Without this, the shorter Re-generate
                        Thumbnails description used to leave its button
                        floating mid-card while Re-process Videos sat at
                        the bottom — visually mismatched. */}
                    <div className="flex flex-col p-3 rounded-md ring-1 ring-white/10 bg-white/[0.03]">
                      <div className="flex items-center gap-2 mb-2">
                        <RefreshCw className="w-4 h-4 text-white/55" />
                        <span className="text-sm font-medium text-white">Re-process Videos</span>
                      </div>
                      <p className="text-xs text-white/55 leading-relaxed flex-1 mb-3">
                        Smart re-process: scans every video for missing quality tiers (480p / 720p / 1080p / 2160p, capped at the Default Preview Resolution above) and only encodes the gaps. Already-finished tiers stay on disk and keep playing, and thumbnails are never touched.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowReprocessConfirm(true)}
                        disabled={reprocessing || regeneratingThumbnails}
                        className="w-full bg-white/[0.04] hover:bg-white/[0.08] border-white/15 text-white shadow-none"
                      >
                        {reprocessing ? (
                          <>
                            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                            Reprocessing…
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Re-process Videos
                          </>
                        )}
                      </Button>
                    </div>

                    <div className="flex flex-col p-3 rounded-md ring-1 ring-white/10 bg-white/[0.03]">
                      <div className="flex items-center gap-2 mb-2">
                        <ImageIcon className="w-4 h-4 text-white/55" />
                        <span className="text-sm font-medium text-white">Re-generate Thumbnails</span>
                      </div>
                      <p className="text-xs text-white/55 leading-relaxed flex-1 mb-3">
                        Re-extracts a still frame for every video and writes it back to the row. Lightweight — does not touch encoded tiers or playback. Use this when card grids show empty thumbnails after a maintenance pass.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowRegenThumbsConfirm(true)}
                        disabled={regeneratingThumbnails || reprocessing}
                        className="w-full bg-white/[0.04] hover:bg-white/[0.08] border-white/15 text-white shadow-none"
                      >
                        {regeneratingThumbnails ? (
                          <>
                            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                            Enqueuing…
                          </>
                        ) : (
                          <>
                            <ImageIcon className="w-4 h-4 mr-2" />
                            Re-generate Thumbnails
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {maintenanceResult && (
                    <div className="text-xs text-emerald-300">
                      {maintenanceResult.kind === 'reprocess'
                        ? `Queued ${maintenanceResult.count} video(s) for full re-process.`
                        : `Queued ${maintenanceResult.count} thumbnail(s) for regeneration.`}
                    </div>
                  )}
                </div>
              )}

              {/* 1.5.8: Watermark configuration card hidden. The
                  per-project watermark settings (enable, custom text,
                  positions, font size, opacity) are all preserved in
                  state and DB; remove `{false && ` to bring them back
                  to the UI when needed. */}
              {false && !skipTranscoding && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="watermarkEnabled">{t('enableWatermarks')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('enableWatermarksDescription')}
                    </p>
                  </div>
                  <Switch
                    id="watermarkEnabled"
                    checked={watermarkEnabled}
                    onCheckedChange={setWatermarkEnabled}
                  />
                </div>

                {watermarkEnabled && (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="customWatermark">{t('customWatermarkText')}</Label>
                        <p className="text-xs text-muted-foreground">
                          {t('customWatermarkTextDescription')}
                        </p>
                      </div>
                      <Switch
                        id="customWatermark"
                        checked={useCustomWatermark}
                        onCheckedChange={setUseCustomWatermark}
                      />
                    </div>

                    {useCustomWatermark && (
                      <div className="space-y-2">
                        <Input
                          value={watermarkText}
                          onChange={(e) => setWatermarkText(e.target.value)}
                          placeholder={t('watermarkPlaceholder')}
                          className="font-mono"
                          maxLength={100}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('watermarkDefaultHint', { title: project?.title ?? '' })}
                          <br />
                          <span className="text-warning">{t('watermarkAllowedChars')}</span>
                        </p>
                      </div>
                    )}

                    <div className="space-y-2 pt-2 border-t border-border">
                      <Label>{t('watermarkPositions')}</Label>
                      <p className="text-xs text-muted-foreground">{t('watermarkPositionsHint')}</p>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => {
                          const selected = watermarkPositions.split(',').map(p => p.trim()).includes(pos)
                          return (
                            <button
                              key={pos}
                              type="button"
                              onClick={() => {
                                const current = new Set(watermarkPositions.split(',').map(p => p.trim()).filter(Boolean))
                                if (current.has(pos)) {
                                  current.delete(pos)
                                  if (current.size === 0) return
                                } else {
                                  current.add(pos)
                                }
                                setWatermarkPositions(Array.from(current).join(','))
                              }}
                              className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                                selected
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-muted/50 text-muted-foreground border-border hover:border-primary/50'
                              }`}
                            >
                              {t(`position.${pos}`)}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>{t('watermarkFontSize')}</Label>
                      <Select value={watermarkFontSize} onValueChange={setWatermarkFontSize}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="small">{t('fontSizeSmall')}</SelectItem>
                          <SelectItem value="medium">{t('fontSizeMedium')}</SelectItem>
                          <SelectItem value="large">{t('fontSizeLarge')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>{t('watermarkOpacity')}</Label>
                        <span className="text-xs text-muted-foreground">{watermarkOpacity}%</span>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        step={5}
                        value={watermarkOpacity}
                        onChange={(e) => setWatermarkOpacity(Number(e.target.value))}
                        className="w-full accent-primary"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{t('opacitySubtle')}</span>
                        <span>{t('opacityBold')}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
              )}

              {/* 1.5.8: Apply Preview LUT card hidden — operator
                  uses the global setting from Admin Settings instead
                  of overriding per project. State + DB column kept;
                  remove `{false && ` to bring it back. */}
              {false && !skipTranscoding && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="applyPreviewLut">{t('applyPreviewLut')}</Label>
                    <p className="text-xs text-muted-foreground">{t('applyPreviewLutHint')}</p>
                  </div>
                  <Switch id="applyPreviewLut" checked={applyPreviewLut} onCheckedChange={setApplyPreviewLut} />
                </div>
              </div>
              )}
            </>
          )

          // 3.2.6+: date-range filter for the folder share-links list.
          // Computed here (same scope as securityContent) so the list +
          // empty-state can both read it. "today" = since local midnight;
          // the rest are rolling windows; "all" disables the cutoff.
          const shareLinkRanges: { id: ShareLinkRange; label: string }[] = [
            { id: 'today', label: 'Today' },
            { id: 'week', label: 'Last week' },
            { id: 'month', label: 'Last month' },
            { id: 'year', label: 'Last year' },
            { id: 'all', label: 'All time' },
          ]
          const shareLinkCutoffMs: number | null = (() => {
            if (shareLinkRange === 'all') return null
            const now = new Date()
            if (shareLinkRange === 'today') {
              const d = new Date(now)
              d.setHours(0, 0, 0, 0)
              return d.getTime()
            }
            const days =
              shareLinkRange === 'week' ? 7 : shareLinkRange === 'month' ? 30 : 365
            return now.getTime() - days * 24 * 60 * 60 * 1000
          })()
          const visibleSharedFolders =
            shareLinkCutoffMs == null
              ? sharedFolders
              : sharedFolders.filter((f) => {
                  // Prefer updatedAt (when the share link was last
                  // (re)created/activated); fall back to createdAt.
                  const t = new Date(f.updatedAt ?? f.createdAt).getTime()
                  // Fail-open: if the timestamp is missing or unparseable
                  // (e.g. an older API response without the field), never
                  // hide the link — better to show a stray row than to
                  // make a freshly-shared folder vanish from the list.
                  if (Number.isNaN(t)) return true
                  return t >= shareLinkCutoffMs
                })

          // Security content
          const securityContent = (
            <>
              {/* 1.5.8: Authentication Method card hidden. The
                  `authMode` state still flows through save and the
                  share routes enforce it, so existing per-project
                  values are still honored — admins just don't change
                  it from here. Remove `{false && ` to expose. */}
              {false && (
	              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
	                <div className="space-y-2">
	                  <Label>{t('authMethod')}</Label>
	                  <Select value={authMode} onValueChange={setAuthMode}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PASSWORD">{t('passwordOnly')}</SelectItem>
                      <SelectItem value="OTP" disabled={!smtpConfigured || !hasRecipientWithEmail}>
                        {t('otpOnly')} {!smtpConfigured || !hasRecipientWithEmail ? t('requiresSMTP') : ''}
                      </SelectItem>
                      <SelectItem value="BOTH" disabled={!smtpConfigured || !hasRecipientWithEmail}>
                        {t('bothAuth')} {!smtpConfigured || !hasRecipientWithEmail ? t('requiresSMTP') : ''}
                      </SelectItem>
                      <SelectItem value="NONE">{t('noAuth')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {authMode === 'PASSWORD' && t('passwordDescriptionLong')}
                    {authMode === 'OTP' && t('otpDescriptionLong')}
                    {authMode === 'BOTH' && t('bothDescriptionLong')}
                    {authMode === 'NONE' && t('noAuthDescription')}
                  </p>
                  {!smtpConfigured && authMode !== 'NONE' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('configureSMTPLong')}
                    </p>
                  )}
                  {smtpConfigured && !hasRecipientWithEmail && authMode !== 'NONE' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('addRecipientForOtp')}
                    </p>
                  )}
                </div>

                {authMode === 'NONE' && (
                  <div className="flex items-start gap-2 p-3 bg-warning-visible border-2 border-warning-visible rounded-md">
                    <span className="text-warning text-sm font-bold">!</span>
                    <p className="text-sm text-warning font-medium">
                      {guestMode ? t('noAuthWarningGuest') : t('noAuthWarningFull')}
                    </p>
                  </div>
                )}
              </div>
              )}

              {/* 1.5.8: Guest Mode card hidden. `guestMode` and
                  `guestLatestOnly` state still apply via save and
                  the share page; admins just don't toggle them from
                  here anymore. */}
              {false && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="guestMode">{t('guestMode')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('guestModeDescription')}
                    </p>
                  </div>
                  <Switch
                    id="guestMode"
                    checked={guestMode}
                    onCheckedChange={setGuestMode}
                  />
                </div>

                {authMode === 'NONE' && !guestMode && (
                  <div className="flex items-start gap-2 p-3 bg-primary-visible border border-primary-visible rounded-md">
                    <span className="text-primary text-sm font-bold">i</span>
                    <p className="text-sm text-primary">
                      <strong>{t('recommended')}:</strong> {t('guestModeRecommendation')}
                    </p>
                  </div>
                )}

                {guestMode && (
                  <div className="flex items-center justify-between gap-4 pt-2 mt-2 border-t border-border">
                    <div className="space-y-0.5 flex-1">
                      <Label htmlFor="guestLatestOnly">{t('restrictToLatestVersion')}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t('restrictToLatestVersionDescription')}
                      </p>
                    </div>
                    <Switch
                      id="guestLatestOnly"
                      checked={guestLatestOnly}
                      onCheckedChange={setGuestLatestOnly}
                    />
                  </div>
                )}

                {authMode === 'NONE' && !guestMode && (
                  <div className="flex items-start gap-2 p-2 bg-warning-visible/50 border border-warning-visible rounded-md">
                    <span className="text-warning text-xs font-bold">!</span>
                    <p className="text-xs text-warning font-medium">
                      {t('guestModeRecommendedWarning')}
                    </p>
                  </div>
                )}
              </div>
              )}

              {/* 1.5.8+: Shared folders panel — lists every folder in
                  this project with the share link the client uses
                  and a humanised countdown until the share expires.
                  Folders without `shareExpiresAt` are tagged "Never
                  expires" so the admin can see them too. The slug is
                  shown as the share URL fragment (`/share/folder/…`)
                  so admins can copy-paste it. Empty list = project
                  has no folders yet — we show a small placeholder
                  rather than rendering a blank card. */}
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="space-y-0.5">
                  <Label className="flex items-center gap-2">
                    <Share2 className="w-4 h-4" />
                    Folder share links
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Folders that can be shared with clients and when their access expires.
                  </p>
                </div>

                {/* 3.2.6+: date-range filter for the share-links list.
                    Defaults to "Today"; the admin can widen the window
                    up to "All time". Filters by folder creation date so
                    a project with hundreds of folders isn't a wall of
                    links on open. */}
                {sharedFolders.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {shareLinkRanges.map((r) => {
                      const active = shareLinkRange === r.id
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setShareLinkRange(r.id)}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-medium ring-1 transition-colors',
                            active
                              ? 'bg-primary/15 text-primary ring-primary/40'
                              : 'bg-white/[0.04] text-white/70 ring-white/10 hover:bg-white/[0.08] hover:text-white',
                          )}
                        >
                          {r.label}
                        </button>
                      )
                    })}
                  </div>
                )}

                {folderShareError && (
                  <p className="text-xs text-red-300">{folderShareError}</p>
                )}

                {sharedFolders.length === 0 ? (
                  <p className="text-xs text-white/55 italic">
                    No folders in this project yet.
                  </p>
                ) : visibleSharedFolders.length === 0 ? (
                  <p className="text-xs text-white/55 italic">
                    No share links created in this period. Try a wider range.
                  </p>
                ) : (
                  // 3.2.6+: the list scrolls INTERNALLY (max-height +
                  // overflow) so a long folder list doesn't grow the
                  // whole page — the left settings nav and the rest of
                  // the page stay fixed. `overscroll-contain` stops the
                  // scroll from chaining to the page once the list hits
                  // its top/bottom.
                  <ul className="max-h-[58vh] overflow-y-auto overscroll-contain divide-y divide-white/10 rounded-md ring-1 ring-white/10 bg-white/[0.03]">
                    {visibleSharedFolders.map((folder) => {
                      const expires = folder.shareExpiresAt
                        ? new Date(folder.shareExpiresAt)
                        : null
                      const now = Date.now()
                      let expiryLabel = 'Never expires'
                      let expiryTone: 'muted' | 'warning' | 'danger' = 'muted'
                      if (expires) {
                        const diffMs = expires.getTime() - now
                        if (diffMs <= 0) {
                          expiryLabel = 'Expired'
                          expiryTone = 'danger'
                        } else {
                          const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
                          const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
                          if (days >= 1) {
                            expiryLabel = `Expires in ${days} day${days === 1 ? '' : 's'}`
                          } else {
                            expiryLabel = `Expires in ${hours} hour${hours === 1 ? '' : 's'}`
                          }
                          expiryTone = days <= 1 ? 'warning' : 'muted'
                        }
                      }
                      const toneClass =
                        expiryTone === 'danger'
                          ? 'text-red-300'
                          : expiryTone === 'warning'
                          ? 'text-amber-300'
                          : 'text-white/55'
                      const isBusy = folderShareBusyId === folder.id
                      const isLimited = !!folder.shareExpiresAt
                      return (
                        <li
                          key={folder.id}
                          className="flex flex-col gap-2 px-3 py-3"
                        >
                          {/* Top row — folder name, full share URL with
                              copy button, current expiry status. */}
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3 min-w-0">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium truncate text-white">{folder.name}</p>
                              <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                                <p className="text-xs text-white/55 truncate font-mono">
                                  {folderShortLinks[folder.id]
                                    || `${typeof window !== 'undefined' ? window.location.origin : ''}/share/folder/${folder.slug}`}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => void copyFolderShareLink(folder)}
                                  title={folderJustCopiedId === folder.id ? 'Copied!' : 'Copy share link'}
                                  aria-label="Copy share link"
                                  className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md bg-white/[0.04] hover:bg-white/[0.10] ring-1 ring-white/15 hover:ring-white/25 text-white/70 hover:text-white transition-colors"
                                >
                                  {folderJustCopiedId === folder.id ? (
                                    <Check className="w-3 h-3 text-emerald-300" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </div>
                              {(folder.hasPassword || folder.authMode === 'OTP' || folder.authMode === 'BOTH') && (
                                <p className="text-[10px] uppercase tracking-wide text-white/40 mt-0.5">
                                  {folder.hasPassword && 'Password protected'}
                                  {folder.authMode === 'OTP' && 'OTP'}
                                  {folder.authMode === 'BOTH' && 'Password + OTP'}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 whitespace-nowrap">
                              {folderJustRevokedId === folder.id && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/30 text-emerald-300 font-medium">
                                  ✓ Link revoked — new URL active
                                </span>
                              )}
                              <span className={`text-xs ${toneClass}`}>
                                {expiryLabel}
                              </span>
                            </div>
                          </div>

                          {/* Controls — limit / unlimit / revoke. */}
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              value={isLimited ? 'limited' : 'unlimited'}
                              onValueChange={(v) => {
                                if (v === 'unlimited') {
                                  void patchFolderShareExpiry(folder.id, null)
                                  return
                                }
                                // Default limited expiry: 7 days from now.
                                // Admin can fine-tune via the date input
                                // that appears once limited is selected.
                                const inSevenDays = new Date(
                                  Date.now() + 7 * 24 * 60 * 60 * 1000,
                                )
                                void patchFolderShareExpiry(folder.id, inSevenDays)
                              }}
                              disabled={isBusy}
                            >
                              <SelectTrigger className="h-8 w-[140px] text-xs bg-white/[0.04] border-white/15 text-white hover:bg-white/[0.06] hover:border-white/25 focus:ring-primary/60 transition-colors">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent
                                className="border-0 ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] text-white"
                                style={{
                                  backgroundColor: 'rgba(22, 37, 51, 0.55)',
                                  backgroundImage:
                                    'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
                                  backdropFilter: 'blur(24px) saturate(160%)',
                                  WebkitBackdropFilter: 'blur(24px) saturate(160%)',
                                }}
                              >
                                <SelectItem value="unlimited" className="text-white focus:bg-primary/15 focus:text-primary data-[state=checked]:text-primary">Unlimited</SelectItem>
                                <SelectItem value="limited" className="text-white focus:bg-primary/15 focus:text-primary data-[state=checked]:text-primary">Limited (date)</SelectItem>
                              </SelectContent>
                            </Select>

                            {isLimited && (
                              <button
                                type="button"
                                data-glass-calendar-trigger
                                disabled={isBusy}
                                onClick={(e) => {
                                  const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                                  // Toggle: same folder twice = close.
                                  if (calendarFolderId === folder.id) {
                                    setCalendarFolderId(null)
                                    setCalendarAnchor(null)
                                  } else {
                                    setCalendarFolderId(folder.id)
                                    setCalendarAnchor(rect)
                                  }
                                }}
                                className="h-8 px-3 text-xs inline-flex items-center gap-2 rounded-md bg-white/[0.04] hover:bg-white/[0.06] ring-1 ring-white/15 hover:ring-white/25 text-white focus-visible:outline-none focus-visible:ring-primary/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Calendar className="w-3.5 h-3.5 text-white/70" />
                                <span>
                                  {folder.shareExpiresAt
                                    ? new Date(folder.shareExpiresAt).toLocaleDateString(undefined, {
                                        day: '2-digit',
                                        month: 'short',
                                        year: 'numeric',
                                      })
                                    : 'Pick date'}
                                </span>
                              </button>
                            )}

                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-3 text-xs gap-1.5 rounded-lg ring-1 ring-red-400/25 hover:ring-red-400/45 text-red-300 hover:text-red-200 shadow-none transition-all ml-auto"
                              style={{
                                backgroundColor: 'rgba(248, 113, 113, 0.08)',
                                backdropFilter: 'blur(12px) saturate(140%)',
                                WebkitBackdropFilter: 'blur(12px) saturate(140%)',
                              }}
                              onClick={() => setFolderToRevoke(folder)}
                              disabled={isBusy}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete link
                            </Button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {/* 2.5.1+: single GlassCalendar instance for all rows —
                  portalled to body anyway, so we don't need one per
                  row. `calendarFolderId` tracks which row is active. */}
              <GlassCalendar
                open={!!calendarFolderId}
                anchorRect={calendarAnchor}
                value={(() => {
                  if (!calendarFolderId) return null
                  const row = sharedFolders.find((r) => r.id === calendarFolderId)
                  return row?.shareExpiresAt ? new Date(row.shareExpiresAt) : null
                })()}
                min={new Date()}
                onChange={(next) => {
                  if (!calendarFolderId) return
                  void patchFolderShareExpiry(calendarFolderId, next)
                }}
                onClose={() => {
                  setCalendarFolderId(null)
                  setCalendarAnchor(null)
                }}
              />

              {(authMode === 'PASSWORD' || authMode === 'BOTH') && (
              <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                <div className="space-y-2">
                  <Label htmlFor="password">{t('sharePagePassword')}</Label>
                  <div className="flex gap-2 w-full">
                    <PasswordInput
                      id="password"
                      value={sharePassword}
                      onChange={(e) => setSharePassword(e.target.value)}
                      placeholder={t('enterPassword')}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSharePassword(generateSecurePassword())}
                      title={t('generatePassword')}
                      className="h-10 w-10 p-0 flex-shrink-0 bg-white/[0.04] hover:bg-white/[0.08] border-white/15 text-white shadow-none"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                    {sharePassword && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={copyPassword}
                        title={copiedPassword ? tc('copied') : t('copyPassword')}
                        className="h-10 w-10 p-0 flex-shrink-0 bg-white/[0.04] hover:bg-white/[0.08] border-white/15 text-white shadow-none"
                      >
                        {copiedPassword ? (
                          <Check className="w-4 h-4 text-emerald-300" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                  </div>
                  {sharePassword && (
                    <SharePasswordRequirements password={sharePassword} />
                  )}
                  <p className="text-xs text-muted-foreground">
	                    {t('sharePagePasswordHint')}
	                  </p>
	                </div>
	              </div>
	              )}
            </>
          )

          return (
            <>
              {/* Mobile: stacked collapsible cards */}
              <div className="lg:hidden space-y-4 sm:space-y-6">
                <CollapsibleSection className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white" style={{ backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }} title={t('projectDetails')} description={t('projectDetailsDescription')} open={showProjectDetails} onOpenChange={setShowProjectDetails} contentClassName="space-y-4 border-t border-white/10 pt-4">
                  {projectDetailsContent}
                </CollapsibleSection>
                {/* 1.5.8: Client Information & Notifications and
                    Client Share Page panes hidden from the mobile
                    collapsible stack. The content blocks
                    (`clientInfoContent`, `clientShareContent`) are
                    still defined so existing state stays connected;
                    just not rendered. Restore by un-commenting. */}
                <CollapsibleSection className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white" style={{ backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }} title={t('videoProcessing')} description={t('videoProcessingDescription')} open={showVideoProcessing} onOpenChange={setShowVideoProcessing} contentClassName="space-y-6 border-t border-white/10 pt-4">
                  {videoProcessingContent}
                </CollapsibleSection>
                <CollapsibleSection className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white" style={{ backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }} title={t('security')} description={t('securityDescription')} open={showSecurity} onOpenChange={setShowSecurity} contentClassName="space-y-4 border-t border-white/10 pt-4">
                  {securityContent}
                </CollapsibleSection>
              </div>

              {/* Desktop: sidebar nav + content panel */}
              <div className="hidden lg:flex gap-6">
                <div className="w-56 flex-shrink-0">
                  <nav
                    className="space-y-1 p-2 rounded-xl bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] sticky top-6"
                    style={{
                      backdropFilter: 'blur(20px) saturate(140%)',
                      WebkitBackdropFilter: 'blur(20px) saturate(140%)',
                    }}
                  >
                    {settingSections.map((section) => (
                      <button
                        key={section.id}
                        onClick={() => setActiveSection(section.id)}
                        className={cn(
                          'w-full text-left px-3 py-2.5 rounded-lg text-sm flex items-center gap-2.5 transition-colors',
                          activeSection === section.id
                            ? 'bg-primary/15 text-primary font-medium'
                            : 'text-white/75 hover:text-white hover:bg-white/5'
                        )}
                      >
                        <section.icon className="w-4 h-4 flex-shrink-0" />
                        {section.label}
                      </button>
                    ))}
                  </nav>
                </div>

                <div className="flex-1 min-w-0">
                  {activeSection === 'project-details' && (
                    <CollapsibleSection className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white" style={{ backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }} title={t('projectDetails')} description={t('projectDetailsDescription')} open={true} onOpenChange={() => {}} collapsible={false} contentClassName="space-y-4 border-t border-white/10 pt-4">
                      {projectDetailsContent}
                    </CollapsibleSection>
                  )}
                  {/* 1.5.8: Client Info & Notifications and Client
                      Share Page panes removed from the desktop right
                      panel. They were unreachable anyway after we
                      dropped their entries from `settingSections`,
                      but cleaning them up here too keeps the file
                      shorter and easier to read. Restore by adding
                      the entries back to `settingSections` and the
                      `activeSection === '…' && <CollapsibleSection>`
                      blocks back here. */}
                  {activeSection === 'video-processing' && (
                    <CollapsibleSection className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white" style={{ backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }} title={t('videoProcessing')} description={t('videoProcessingDescription')} open={true} onOpenChange={() => {}} collapsible={false} contentClassName="space-y-6 border-t border-white/10 pt-4">
                      {videoProcessingContent}
                    </CollapsibleSection>
                  )}
                  {activeSection === 'security' && (
                    <CollapsibleSection className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white" style={{ backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' }} title={t('security')} description={t('securityDescription')} open={true} onOpenChange={() => {}} collapsible={false} contentClassName="space-y-4 border-t border-white/10 pt-4">
                      {securityContent}
                    </CollapsibleSection>
                  )}
                </div>
              </div>
            </>
          )
        })()}

        {/* Error notification at bottom */}
        {error && (
          <div
            className="mt-4 sm:mt-6 p-3 sm:p-4 rounded-lg ring-1 ring-red-400/30"
            style={{
              backgroundColor: 'rgba(248, 113, 113, 0.10)',
              backdropFilter: 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: 'blur(24px) saturate(160%)',
            }}
          >
            <p className="text-xs sm:text-sm text-red-300 font-medium">{error}</p>
          </div>
        )}

        {/* 1.5.8: bottom success banner removed — it was duplicating
            the top one for the same `success` flag. The top banner
            (rendered above the form) is enough and stays in view
            while users scroll back up to verify. */}

        {/* 2.5.1+: bottom Save Changes button removed — the Save
            Changes pill is portalled into the AdminTopBar's right
            slot now, same UX as Global Settings. The bottom padding
            stays so the floating banners (uploads / processing)
            don't cover the last card. */}
        <div className="pb-20 lg:pb-24" />

        {/* 2.2.4+: ReprocessModal still renders, but `showReprocessModal`
            is never set to true anywhere now — kept for any future
            programmatic use. Save Changes no longer hands off here. */}
        <ReprocessModal
          show={showReprocessModal}
          onCancel={() => {
            setShowReprocessModal(false)
            setPendingUpdates(null)
            setSaving(false)
          }}
          onSaveWithoutReprocess={() => saveSettings(pendingUpdates, false)}
          onSaveAndReprocess={() => saveSettings(pendingUpdates, true)}
          saving={saving}
          reprocessing={reprocessing}
        />

        {/* 2.2.4+: Re-process Videos confirm. Destructive because it
            wipes every video's encoded preview tiers — they'll have
            to climb the ladder from scratch. */}
        <ConfirmDialog
          open={showReprocessConfirm}
          onOpenChange={setShowReprocessConfirm}
          title="Re-process every video in this project?"
          description="Smart mode — only missing quality tiers (480p / 720p / 1080p / 2160p, capped at the Default Preview Resolution) get encoded. Videos that already have everything are skipped. Already-finished tiers, playback, AND thumbnails are not touched."
          confirmLabel="Re-process"
          onConfirm={handleConfirmReprocess}
        />

        {/* 2.2.4+: Re-generate Thumbnails confirm. Default variant — it
            only refreshes a still frame per video; no encode work, no
            playback impact. */}
        <ConfirmDialog
          open={showRegenThumbsConfirm}
          onOpenChange={setShowRegenThumbsConfirm}
          title="Re-generate every thumbnail in this project?"
          description="A still frame will be re-extracted for every video and saved as its card thumbnail. Custom thumbnails (uploaded via the player) are preserved. Encoded tiers and playback are not affected."
          confirmLabel="Re-generate"
          onConfirm={handleConfirmRegenThumbs}
        />

        {/* 1.5.8+: themed confirm dialog for the "Delete link"
            action on the Security → Folder share links panel.
            Replaces the native window.confirm() so the warning
            uses the same dark Radix Dialog as the rest of the app. */}
        <ConfirmDialog
          open={!!folderToRevoke}
          onOpenChange={(open) => {
            if (!open) setFolderToRevoke(null)
          }}
          variant="destructive"
          title={folderToRevoke ? `Delete share link for "${folderToRevoke.name}"?` : 'Delete share link?'}
          description="Anyone with the current share link will lose access immediately. A new link will be generated for this folder — its content stays untouched."
          confirmLabel="Delete link"
          cancelLabel="Cancel"
          onConfirm={async () => {
            if (!folderToRevoke) return
            await rotateFolderShareLink(folderToRevoke.id)
            setFolderToRevoke(null)
          }}
        />
      </div>
    </div>
  )
}
