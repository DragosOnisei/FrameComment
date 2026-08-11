import { isStaff } from '@/lib/permissions'
import { NextRequest, NextResponse } from 'next/server'
import { prisma, orgSettingsWhere } from '@/lib/db'
import { armOrgForProjectSlug } from '@/lib/share-org'
import { isSmtpConfigured, getRateLimitSettings, getShareTokenTtlSeconds } from '@/lib/settings'
import { getCurrentUserFromRequest, getShareContext, signShareToken, parseBearerToken } from '@/lib/auth'
import { getPrimaryRecipient, getProjectRecipients } from '@/lib/recipients'
import { verifyProjectAccess, fetchProjectWithVideos } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { trackSharePageAccess, readAnalyticsConsent } from '@/lib/share-access-tracking'
import { getRedis } from '@/lib/redis'
import { getClientIpAddress } from '@/lib/utils'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logMessage } from '@/lib/logging'
import { verifyVideoShareName } from '@/lib/share-video-sig'
import { groupByStack, sortVersionsDesc } from '@/lib/video-stack'
export const runtime = 'nodejs'




export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    // 5.5 multi-tenant: arm the owning org FIRST (privileged slug->org resolve;
    // post-flip every query below, incl. settings/rate-limit reads, is RLS-scoped).
    await armOrgForProjectSlug(token)
    const locale = await getConfiguredLocale().catch(() => 'en')
    const messages = await loadLocaleMessages(locale).catch(() => null)
    const shareMessages = messages?.share
    const { shareSessionRateLimit } = await getRateLimitSettings()
    const shareTtlSeconds = await getShareTokenTtlSeconds()

    const rateLimitResult = await rateLimit(request, {
      windowMs: 15 * 60 * 1000,
      maxRequests: shareSessionRateLimit || 300,
      message: shareMessages?.tooManyRequestsGeneric || 'Too many requests. Please try again later.'
    }, `share-access:${token}`)
    if (rateLimitResult) return rateLimitResult

    // NOTE: this entire result is cast to `any` because the project
    // schema's `shareExpiresAt` field (1.4.x+) is only present in the
    // Prisma client AFTER `prisma generate` runs against the migrated
    // DB. Casting at the awaited-call boundary keeps consumer code
    // working in both the pre-migrate (stale client) and post-migrate
    // (fresh client) states.
    const projectMeta = (await prisma.project.findFirst({
      // 1.2.0+: a soft-deleted project must look 404 to clients.
      where: { slug: token, deletedAt: null } as any,
      select: {
        id: true,
        guestMode: true,
        guestLatestOnly: true,
        sharePassword: true,
        authMode: true,
        // 1.4.x+: read share expiration so we can hard-reject after
        // the cut-off.
        shareExpiresAt: true,
      } as any,
    })) as any

    if (!projectMeta) {
      // SECURITY: Return same response shape as auth-required projects
      // to prevent project enumeration via status code differences
      return NextResponse.json({
        error: shareMessages?.authenticationRequired || 'Authentication required',
        authMode: 'PASSWORD',
        guestMode: false,
      }, { status: 401 })
    }

    // 1.4.x+: hard-reject expired share links. Admin override below
    // (after auth context is read) keeps admins able to inspect the
    // project regardless. For everyone else, 410 Gone is the spec-
    // correct status for a resource that used to exist but doesn't
    // anymore — the public share page renders a clean "link expired"
    // notice when it sees it.
    const expiresAt = (projectMeta as any).shareExpiresAt as Date | null
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      const adminUser = await getCurrentUserFromRequest(request)
      if (!isStaff(adminUser?.role)) {
        return NextResponse.json(
          {
            error: 'This share link has expired.',
            expiredAt: expiresAt.toISOString(),
          },
          { status: 410 },
        )
      }
    }

    const shareContext = await getShareContext(request)
    const isGuest = !!shareContext?.guest

    // SECURITY: If user sent a bearer token but it failed verification (revoked, expired, invalid),
    // handle based on current authMode:
    // - NONE auth: Ignore invalid token, proceed as if no token sent
    // - PASSWORD/OTP/BOTH: Return 401 to force re-authentication
    const bearerToken = parseBearerToken(request)
    if (bearerToken && !shareContext && projectMeta.authMode !== 'NONE') {
      const currentUser = await getCurrentUserFromRequest(request)
      const isAdmin = currentUser != null && isStaff(currentUser.role)

      if (!isAdmin) {
        // Token was sent but invalid/revoked - force re-authentication
        return NextResponse.json({
          error: shareMessages?.sessionExpiredOrInvalid || 'Session expired or invalid. Please authenticate again.',
          requiresPassword: true,
          authMode: projectMeta.authMode || 'PASSWORD',
          guestMode: projectMeta.guestMode || false
        }, { status: 401 })
      }
    }

    const project = await fetchProjectWithVideos(
      token,
      isGuest,
      projectMeta.guestLatestOnly || false,
      projectMeta.id
    )

    if (!project) {
      return NextResponse.json({ error: shareMessages?.accessDenied || 'Access denied' }, { status: 403 })
    }

    const accessCheck = await verifyProjectAccess(request, projectMeta.id, projectMeta.sharePassword, projectMeta.authMode)

    if (!accessCheck.authorized) {
      return NextResponse.json({
        error: shareMessages?.authenticationRequired || 'Authentication required',
        requiresPassword: true,
        authMode: project.authMode || 'PASSWORD',
        guestMode: project.guestMode || false
      }, { status: 401 })
    }

    const { isAdmin } = accessCheck

    // Track share page access for projects with no authentication (authMode = NONE)
    // Only track as NONE if guest mode is disabled; otherwise let guest endpoint track as GUEST
    if (projectMeta.authMode === 'NONE' && !projectMeta.guestMode && !isAdmin) {
      // Use Redis for 30-minute deduplication
      const redis = getRedis()
      const ipAddress = getClientIpAddress(request)
      const dedupeKey = `share_access:${projectMeta.id}:${ipAddress}`
      const alreadyTracked = await redis.get(dedupeKey)

      if (!alreadyTracked) {
        // CRITICAL: Use deterministic sessionId for NONE authMode
        // This must match the sessionId used in JWT token for session invalidation to work
        const sessionId = `none:${projectMeta.id}:${ipAddress}`

        await trackSharePageAccess({
          projectId: projectMeta.id,
          accessMethod: 'NONE',
          sessionId,
          request,
          analyticsConsent: readAnalyticsConsent(request),
        })

        // Set 30-minute deduplication window
        await redis.set(dedupeKey, '1', 'EX', 30 * 60)
      }
    }

    const hasShareSession = !!shareContext
    // If guestMode is enabled, require guest token (restricted access)
    // This applies to ALL authModes - guest restrictions are independent of auth requirements
    if (projectMeta.guestMode && !isAdmin && !hasShareSession && !isGuest) {
      return NextResponse.json({
        error: shareMessages?.guestEntryRequired || 'Guest entry required',
        requiresPassword: false,
        authMode: projectMeta.authMode,
        guestMode: true
      }, { status: 401 })
    }

    // 1.2.0+: single-video share. When the admin shares a single video,
    // the URL carries `?v={name}&sig={hmac}`. We verify the signature
    // here and, on match, scope the response to that one video name so
    // the reviewer cannot navigate to siblings via the thumbnail reel.
    // The scope applies to EVERY viewer — admins included — so an admin
    // opening the link in the same browser session sees exactly what
    // their client will see, which is the whole point of "Copy link".
    // Admins wanting the full project view just use the bare share URL
    // without `v` / `sig`.
    const singleVideoName = (request.nextUrl.searchParams.get('v') || '').trim()
    const singleVideoSig = (request.nextUrl.searchParams.get('sig') || '').trim()
    const singleVideoScopeActive =
      singleVideoName.length > 0 &&
      singleVideoSig.length > 0 &&
      verifyVideoShareName(token, singleVideoName, singleVideoSig)

    const videosSanitizedBase = project.videos.map((video: any) => ({
      id: video.id,
      name: video.name,
      version: video.version,
      versionLabel: video.versionLabel,
      originalFileName: video.originalFileName,
      originalFileSize: video.originalFileSize.toString(),
      duration: video.duration,
      width: video.width,
      height: video.height,
      fps: video.fps,
      codec: video.codec,
      status: video.status,
      approved: video.approved,
      approvedAt: video.approvedAt,
      thumbnailPath: video.thumbnailPath,
      // 3.8.x: storyboard sprite path — lets SharePageClient mint a
      // storyboard token so the player timeline gets the same
      // hover-scrub frame preview the folder/version thumbnails have.
      storyboardPath: video.storyboardPath ?? null,
      // folderId surfaced (1.0.6+) so the share page can scope the
      // title-flyout to videos from one folder when arriving via a
      // folder share link.
      folderId: video.folderId ?? null,
      createdAt: video.createdAt,
      // Explicitly omit: projectId, originalStoragePath, preview720Path, preview1080Path,
      // cleanPreview720Path, cleanPreview1080Path, processingError, processingProgress,
      // uploadProgress
      streamUrl720p: '',
      streamUrl1080p: '',
      downloadUrl: null,
      thumbnailUrl: null,
    }))

    // When the single-video signature validated, drop every other
    // video from the response before grouping. Everything downstream
    // (videosByName, the thumbnail reel, the version chip) keys off
    // this array, so this single filter is enough to lock the share
    // to one video.
    // 6.2.1: the scope is by NAME, and a stack takes the name of its newest
    // delivery — so uploading v6 renames the whole stack and a link minted for
    // "…_v5" suddenly matches nothing. The old code then returned an EMPTY
    // payload and the client landed on a blank "Select a video to begin"
    // screen, with no way to tell that anything was wrong.
    //
    // Two changes: match the stack the name USED to belong to (originalFileName
    // still carries each version's own upload name), and never scope down to
    // nothing — if the target can't be resolved, fall back to the whole
    // project so the visitor gets the grid instead of a dead end.
    const stripExt = (n: string) => {
      const dot = n.lastIndexOf('.')
      return dot > 0 ? n.slice(0, dot) : n
    }
    let scopedVideos = videosSanitizedBase
    if (singleVideoScopeActive) {
      const exact = videosSanitizedBase.filter((v: any) => v.name === singleVideoName)
      // The link's name may be an older version's ORIGINAL upload name: find
      // that row, then take every row of the stack it lives in.
      const byOriginal = exact.length
        ? []
        : videosSanitizedBase.filter(
            (v: any) => stripExt(String(v.originalFileName || '')) === singleVideoName,
          )
      if (exact.length > 0) {
        scopedVideos = exact
      } else if (byOriginal.length > 0) {
        const names = new Set(byOriginal.map((v: any) => v.name))
        scopedVideos = videosSanitizedBase.filter((v: any) => names.has(v.name))
      } else {
        logMessage(
          `[share] single-video scope "${singleVideoName}" no longer matches any video on ${token} — serving the full project instead of an empty page`,
        )
      }
    }

    // 6.1.0: versions are grouped by the explicit STACK. The client payload
    // stays keyed by display name (the share URL signs the name), and every
    // row of a stack carries the same one; two stacks sharing a name are
    // disambiguated rather than merged into one fake version list.
    const videosByName: Record<string, any[]> = {}
    for (const rows of groupByStack(scopedVideos as any[]).values()) {
      const sorted = sortVersionsDesc(rows as any[])
      const name = (sorted[0] as any).name as string
      if (!videosByName[name]) {
        videosByName[name] = sorted
      } else {
        let n = 2
        while (videosByName[`${name} (${n})`]) n++
        videosByName[`${name} (${n})`] = sorted
      }
    }

    const sortedVideosByName: Record<string, any[]> = {}
    const sortedKeys = Object.keys(videosByName).sort((nameA, nameB) => {
      const hasApprovedA = videosByName[nameA].some((v: any) => v.approved)
      const hasApprovedB = videosByName[nameB].some((v: any) => v.approved)

      if (hasApprovedA !== hasApprovedB) {
        return hasApprovedA ? 1 : -1
      }
      return 0
    })

    sortedKeys.forEach(key => {
      sortedVideosByName[key] = videosByName[key]
    })

    // Parallelize independent queries for better performance
    const [smtpConfigured, globalSettings, primaryRecipient] = await Promise.all([
      isSmtpConfigured(),
      prisma.settings.findUnique({
        where: orgSettingsWhere(),
        select: {
          companyName: true,
          defaultPreviewResolution: true,
          maxCommentAttachments: true,
          maxReverseShareFiles: true,
          privacyDisclosureEnabled: true,
          privacyDisclosureText: true,
        },
      }),
      getPrimaryRecipient(project.id)
    ])

    let allRecipients: Array<{id: string, name: string | null, email: string | null}> = []
    // Include recipients for all authenticated users (guest mode is the only restriction)
    if (!isGuest) {
      const recipients = await getProjectRecipients(project.id)
      allRecipients = recipients
        .filter(r => r.id)
        .map(r => ({
          id: r.id!,
          name: r.name,
          email: r.email
        }))
    }

    const sanitizedVideos = isGuest ? videosSanitizedBase.map(video => ({
      id: video.id,
      name: video.name,
      folderId: video.folderId ?? null,
      version: video.version,
      versionLabel: video.versionLabel,
      duration: video.duration,
      width: video.width,
      height: video.height,
      fps: video.fps,
      status: video.status,
      streamUrl720p: video.streamUrl720p,
      streamUrl1080p: video.streamUrl1080p,
      downloadUrl: video.downloadUrl,
      thumbnailUrl: video.thumbnailUrl,
      thumbnailPath: video.thumbnailPath,
      storyboardPath: video.storyboardPath ?? null,
    })) : videosSanitizedBase

    const sanitizedVideosByName = isGuest ? Object.keys(sortedVideosByName).reduce((acc: any, name: string) => {
      acc[name] = sortedVideosByName[name].map(video => ({
        id: video.id,
        name: video.name,
        // 6.2.1: guests need `folderId` too. The share page scopes the grid to
        // the folder the link came from, and stripping the field made EVERY
        // guest arriving from a folder share match nothing — a blank page. The
        // id is already in their URL, so this reveals nothing new.
        folderId: video.folderId ?? null,
        version: video.version,
        versionLabel: video.versionLabel,
        duration: video.duration,
        width: video.width,
        height: video.height,
        fps: video.fps,
        status: video.status,
        streamUrl720p: video.streamUrl720p,
        streamUrl1080p: video.streamUrl1080p,
        downloadUrl: video.downloadUrl,
        thumbnailUrl: video.thumbnailUrl,
        thumbnailPath: video.thumbnailPath,
        storyboardPath: video.storyboardPath ?? null,
      }))
      return acc
    }, {}) : sortedVideosByName

    // Extract authenticated recipient ID from share token (for OTP-authenticated users)
    const authenticatedRecipientId = shareContext?.recipientId || null

    const projectData = {
      ...(isGuest ? {} : { id: project.id }),

      title: project.title,
      description: project.description,

      ...(isGuest ? {} : { status: project.status }),

      guestMode: project.guestMode || false,
      isGuest: isGuest,

      ...(isGuest ? {} : {
        clientName: project.companyName || primaryRecipient?.name || 'Client',
        clientEmail: primaryRecipient?.email || null,
        companyName: project.companyName || null,
        recipients: allRecipients,
        authenticatedRecipientId,
      }),

      // Not sensitive; used by share UI to format comment timestamp badges
      timestampDisplay: project.timestampDisplay,

      ...(isGuest ? {} : {
        enableRevisions: project.enableRevisions,
        maxRevisions: project.maxRevisions,
        restrictCommentsToLatestVersion: project.restrictCommentsToLatestVersion,
        hideFeedback: project.hideFeedback,
        previewResolution: project.previewResolution,
        watermarkEnabled: project.watermarkEnabled,
        usePreviewForApprovedPlayback: project.usePreviewForApprovedPlayback,
      }),

      allowAssetDownload: project.allowAssetDownload,
      allowClientAssetUpload: project.allowClientAssetUpload,
      allowReverseShare: project.allowReverseShare,
      clientCanApprove: project.clientCanApprove,
      showClientTutorial: project.showClientTutorial ?? true,

      // 1.4.x+: expose the share-link expiration so the public share
      // page can render a countdown banner ("Expires in N days").
      // Hard-rejected above for non-admin viewers if already past, so
      // we only end up here when either there's no expiry, the
      // expiry is in the future, or the viewer is an admin.
      shareExpiresAt: expiresAt ? expiresAt.toISOString() : null,

      videos: sanitizedVideos,
      videosByName: sanitizedVideosByName,

      ...(isGuest ? {} : { smtpConfigured }),

      settings: {
        companyName: globalSettings?.companyName || 'Studio',
        defaultPreviewResolution: globalSettings?.defaultPreviewResolution || 'auto',
        maxCommentAttachments: globalSettings?.maxCommentAttachments ?? 10,
        maxReverseShareFiles: globalSettings?.maxReverseShareFiles ?? 10,
        privacyDisclosureEnabled: globalSettings?.privacyDisclosureEnabled ?? false,
        privacyDisclosureText: globalSettings?.privacyDisclosureText || null,
      },
    }

    const responseBody: any = projectData

    // If no share token present, issue a short-lived viewer token (view-only) for this project
    if (!shareContext && !isAdmin) {
      // CRITICAL: For NONE authMode, use deterministic sessionId based on IP
      // This must match the sessionId used in SharePageAccess tracking
      let sessionId = accessCheck.shareTokenSessionId || `share:${project.id}:${token}`

      if (projectMeta.authMode === 'NONE') {
        sessionId = `none:${projectMeta.id}:${getClientIpAddress(request)}`
      }

      const shareToken = signShareToken({
        shareId: token,
        projectId: project.id,
        permissions: ['view', 'comment', 'download'],
        guest: false,
        sessionId,
        authMode: projectMeta.authMode,
        ttlSeconds: shareTtlSeconds,
        organizationId: (project as any).organizationId ?? null,
      })
      responseBody.shareToken = shareToken
      // Expose the per-client session id so the share UI can compare it
      // against Comment.editorSessionId and decide whether to show the
      // Edit button for the viewer's own comments.
      responseBody.clientSessionId = sessionId
    } else if (accessCheck.shareTokenSessionId) {
      responseBody.clientSessionId = accessCheck.shareTokenSessionId
    }

    return NextResponse.json(responseBody)
  } catch (error) {
    return NextResponse.json({
      error: (await loadLocaleMessages(await getConfiguredLocale().catch(() => 'en')).catch(() => null))?.share?.unableToProcessRequest || 'Unable to process request'
    }, { status: 500 })
  }
}