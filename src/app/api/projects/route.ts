import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateUniqueSlug } from '@/lib/utils'
import { requireApiAdmin } from '@/lib/auth'
import { encrypt } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import { createProjectSchema, validateRequest } from '@/lib/validation'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'
import { uploadFile } from '@/lib/storage'
import { generateSecurePassword } from '@/lib/password-utils'

export const runtime = 'nodejs'



// Prevent static generation for this route
export const dynamic = 'force-dynamic'

// GET /api/projects - List all projects
export async function GET(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const projectMessages = messages?.projects || {}

  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limiting: 100 requests per minute for listing projects
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: projectMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.'
  }, 'admin-projects-list')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    // Optimized query: only fetch essential fields + minimal video data for list view
    const projects = await prisma.project.findMany({
      // 1.2.0+: hide soft-deleted projects from the dashboard list.
      // They live on the dedicated Trash page until the cleanup cron
      // purges them after TRASH_RETENTION_DAYS.
      where: { deletedAt: null } as any,
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        watermarkEnabled: true,
        sharePassword: true,
        authMode: true,
        hideFeedback: true,
        guestMode: true,
        allowAssetDownload: true,
        allowClientAssetUpload: true,
        previewResolution: true,
        companyName: true,
        dueDate: true,
        maxRevisions: true,
        enableRevisions: true,
        // 1.2.0+: cover image path. Cast through `any` until the
        // generated Prisma client picks up the new column locally.
        coverImagePath: true,
        videos: {
          select: {
            id: true,
            status: true,
          },
        },
        recipients: {
          select: {
            id: true,
            name: true,
            isPrimary: true,
          },
        },
        _count: {
          select: {
            videos: true,
            comments: true,
            // Total folders in the project (any depth) — shown in the
            // dashboard tile in place of the old video count (1.0.6+).
            folders: true,
          },
        },
      } as any,
      orderBy: {
        createdAt: 'desc',
      },
    })

    // Sum total bytes (originalFileSize) per project in a single
    // grouped query. BigInt → number conversion happens client-side
    // by serialising via .toString(); we expose the value as a number
    // string in JSON so it survives JSON.stringify.
    const sizeRows = await prisma.video.groupBy({
      by: ['projectId'],
      where: { projectId: { in: (projects as any[]).map((p: any) => p.id) } },
      _sum: { originalFileSize: true },
    })
    const sizeByProject = new Map<string, string>()
    for (const row of sizeRows) {
      sizeByProject.set(
        row.projectId,
        ((row._sum?.originalFileSize ?? BigInt(0)) as bigint).toString(),
      )
    }

    const sanitizedProjects = (projects as any[]).map(({ sharePassword, recipients, ...project }: any) => ({
      ...project,
      sharePassword: Boolean(sharePassword),
      recipients,
      // Serialise BigInt as a string so it survives JSON; the client
      // parses it back to a Number (file sizes fit comfortably in
      // Number.MAX_SAFE_INTEGER even for multi-TB libraries).
      totalSize: sizeByProject.get(project.id) ?? '0',
    }))

    return NextResponse.json({ projects: sanitizedProjects })
  } catch (error) {
    return NextResponse.json(
      { error: projectMessages.unableToProcessRequest || 'Unable to process request' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const projectMessages = messages?.projects || {}

  // Check authentication
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }
  const admin = authResult

  // Rate limiting: Max 20 projects per hour
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 20,
    message: projectMessages.tooManyProjectsCreated || 'Too many projects created. Please try again later.'
  }, 'create-project')
  if (rateLimitResult) return rateLimitResult

  try {
    // 1.2.0+: support both legacy JSON body AND the new multipart body
    // used by the Frame.io-style modal (carries an optional coverImage
    // file + a minimal `restricted` flag).
    const contentType = (request.headers.get('content-type') || '').toLowerCase()
    let coverImageFile: File | null = null
    let body: any

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData()
      const titleRaw = String(form.get('title') || '').trim()
      const restrictedRaw = String(form.get('restricted') || 'false').toLowerCase()
      const restricted = restrictedRaw === 'true'
      const fileEntry = form.get('coverImage')
      if (fileEntry && typeof (fileEntry as any).arrayBuffer === 'function') {
        coverImageFile = fileEntry as File
        // Guard: cover image type + size. Anything bigger than 10MB is
        // almost certainly a mistake and would balloon the storage
        // bucket; anything that isn't an image gets rejected outright.
        if (!coverImageFile.type.startsWith('image/')) {
          return NextResponse.json(
            { error: 'Cover image must be an image file' },
            { status: 400 },
          )
        }
        if (coverImageFile.size > 10 * 1024 * 1024) {
          return NextResponse.json(
            { error: 'Cover image must be smaller than 10MB' },
            { status: 400 },
          )
        }
      }
      // Auto-generate a strong password whenever the project is
      // restricted — the new modal hides the field on purpose; the
      // admin can view / rotate the password later from Project
      // Settings.
      body = {
        title: titleRaw,
        authMode: restricted ? 'PASSWORD' : 'NONE',
        sharePassword: restricted ? generateSecurePassword() : undefined,
      }
    } else {
      body = await request.json()
    }

    // Validate request body
    const validation = validateRequest(createProjectSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400 }
      )
    }

    const {
      title,
      description,
      companyName,
      clientCompanyId,
      recipientEmail,
      recipientName,
      sharePassword,
      authMode,
      enableRevisions,
      maxRevisions,
      restrictCommentsToLatestVersion,
      dueDate,
      dueReminder,
      isShareOnly
    } = validation.data

    // Normalize auth/password inputs
    const trimmedPassword = sharePassword?.trim()
    const resolvedAuthMode = authMode || 'PASSWORD'

    // Enforce password presence for password-based modes
    if (resolvedAuthMode === 'PASSWORD' || resolvedAuthMode === 'BOTH') {
      if (!trimmedPassword) {
        return NextResponse.json(
          { error: projectMessages.passwordAuthRequiresSharePassword || 'Password authentication mode requires a share password.' },
          { status: 400 }
        )
      }
      // Password strength validation (8+ chars, letter, number) is handled by Zod schema
    }

    // Clear password for modes that don't use it
    const passwordForStorage = (resolvedAuthMode === 'OTP' || resolvedAuthMode === 'NONE')
      ? null
      : (trimmedPassword || null)

    // Fetch default settings for watermark and preview resolution
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        defaultPreviewResolution: true,
        defaultSkipTranscoding: true,
        defaultWatermarkEnabled: true,
        defaultWatermarkText: true,
        defaultWatermarkPositions: true,
        defaultWatermarkOpacity: true,
        defaultWatermarkFontSize: true,
        defaultTimestampDisplay: true,
        defaultUsePreviewForApprovedPlayback: true,
        defaultAllowClientAssetUpload: true,
        defaultApplyPreviewLut: true,
        defaultAllowReverseShare: true,
        defaultShowClientTutorial: true,
        defaultAllowAssetDownload: true,
        defaultClientCanApprove: true,
      },
    })

    // Generate unique slug from title
    const slug = await generateUniqueSlug(title, prisma)

    // Encrypt share password if provided (so we can decrypt it later for email notifications)
    const encryptedSharePassword = passwordForStorage ? encrypt(passwordForStorage) : null

    // Use transaction to ensure atomicity: if recipient creation fails, project creation is rolled back
    const project = await prisma.$transaction(async (tx) => {
      const newProject = await tx.project.create({
        data: {
          title,
          slug,
          description,
          companyName: companyName || null,
          clientCompanyId: clientCompanyId || null,
          sharePassword: encryptedSharePassword,
          authMode: resolvedAuthMode,
          enableRevisions: isShareOnly ? false : (enableRevisions || false),
          maxRevisions: isShareOnly ? 0 : (enableRevisions ? (maxRevisions || 3) : 0),
          restrictCommentsToLatestVersion: isShareOnly ? false : (restrictCommentsToLatestVersion || false),
          status: isShareOnly ? 'SHARE_ONLY' : 'IN_REVIEW',
          hideFeedback: isShareOnly ? true : false,
          approvedAt: isShareOnly ? new Date() : null,
          // 2.0.x+: default to "auto" (= match source) instead of
          // legacy "720p" cap. With the cap, a 1080×1920 vertical
          // source would only get 480p + 720p tiers from the worker
          // even though the player's pendingQualities (driven by
          // source resolution) includes 1080p — and that mismatch
          // left the Quality menu showing "1080p — Finalizing..."
          // forever after the worker actually finished. The schema
          // default has been "auto" since Phase A; the API just
          // missed the memo.
          previewResolution: settings?.defaultPreviewResolution || 'auto',
          skipTranscoding: settings?.defaultSkipTranscoding ?? false,
          watermarkEnabled: settings?.defaultWatermarkEnabled ?? true,
          watermarkText: settings?.defaultWatermarkText || null,
          watermarkPositions: settings?.defaultWatermarkPositions || 'center',
          watermarkOpacity: settings?.defaultWatermarkOpacity ?? 30,
          watermarkFontSize: settings?.defaultWatermarkFontSize || 'medium',
          timestampDisplay: settings?.defaultTimestampDisplay || 'TIMECODE',
          usePreviewForApprovedPlayback: settings?.defaultUsePreviewForApprovedPlayback ?? false,
          allowClientAssetUpload: settings?.defaultAllowClientAssetUpload ?? false,
          allowReverseShare: settings?.defaultAllowReverseShare ?? false,
          showClientTutorial: settings?.defaultShowClientTutorial ?? false,
          allowAssetDownload: settings?.defaultAllowAssetDownload ?? true,
          clientCanApprove: settings?.defaultClientCanApprove ?? true,
          applyPreviewLut: settings?.defaultApplyPreviewLut ?? true,
          dueDate: dueDate ? new Date(dueDate) : null,
          dueReminder: dueReminder || null,
          createdById: admin.id,
        },
      })

      // Create recipient if email provided (validated by schema)
      if (recipientEmail) {
        await tx.projectRecipient.create({
          data: {
            projectId: newProject.id,
            email: recipientEmail,
            name: recipientName || null,
            isPrimary: true,
          },
        })
      }

      return newProject
    }, {
      // 3.3.x: give the transaction room so a momentarily busy DB
      // (connection-pool contention under load) can't abort the
      // create at Prisma's default 5s and surface "Failed to create
      // project" even though it would have committed.
      timeout: 30_000,
      maxWait: 15_000,
    })

    // 1.2.0+: if a cover image was uploaded with the create request,
    // persist it to the storage abstraction and stamp the path on the
    // freshly-created project. Failure here is non-fatal — the project
    // already exists with the gradient fallback; we just log and move
    // on rather than rolling the whole thing back.
    if (coverImageFile) {
      try {
        const extFromType = coverImageFile.type.split('/')[1] || 'jpg'
        const ext = extFromType.split(';')[0].replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg'
        const coverPath = `projects/${project.id}/cover.${ext}`
        const buffer = Buffer.from(await coverImageFile.arrayBuffer())
        await uploadFile(coverPath, buffer, buffer.length, coverImageFile.type)
        await prisma.project.update({
          where: { id: project.id },
          data: { coverImagePath: coverPath } as any,
        })
        ;(project as any).coverImagePath = coverPath
      } catch (err) {
        logError('[API] Cover image upload failed (project created without cover):', err)
      }
    }

    return NextResponse.json(project)
  } catch (error) {
    logError('[API] Project creation error:', error)
    return NextResponse.json(
      { error: projectMessages.failedToCreateProjectApi || 'Failed to create project' },
      { status: 500 }
    )
  }
}
