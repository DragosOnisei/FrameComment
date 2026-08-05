import { isStaff } from './permissions'
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUserFromRequest, getShareContext } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getClientIpAddress } from '@/lib/utils'
import { stackKeyOf } from '@/lib/video-stack'

/**
 * Verify project access using dual authentication pattern
 *
 * Two authentication paths:
 * 1. Admin Path: JWT authentication (bypasses password protection)
 * 2. Share Path: bearer share token scoped to project
 *
 * This replaces duplicate auth logic in 6+ API routes.
 *
 * @param request - Next.js request object
 * @param projectId - Project ID to verify access for
 * @param sharePassword - Project's share password (null if not password-protected)
 * @returns Object with authorization status and user type
 */
export async function verifyProjectAccess(
  request: NextRequest,
  projectId: string,
  _sharePassword: string | null,
  authMode: string = 'PASSWORD',
  options?: {
    requiredPermission?: string
    requiredAnyPermission?: string[]
    allowGuest?: boolean
  }
): Promise<{
  authorized: boolean
  isAdmin: boolean
  isAuthenticated: boolean
  isGuest?: boolean
  permissions?: string[]
  shareTokenSessionId?: string
  errorResponse?: NextResponse
}> {
  const allowGuest = options?.allowGuest ?? true
  const requiredPermission = options?.requiredPermission
  const requiredAnyPermission = options?.requiredAnyPermission

  // Check if user is admin (admins bypass password protection)
  const currentUser = await getCurrentUserFromRequest(request)
  const isAdmin = currentUser != null && isStaff(currentUser.role)
  const shareContext = await getShareContext(request)

  if (isAdmin) {
    return {
      authorized: true,
      isAdmin: true,
      isAuthenticated: true,
      permissions: ['view', 'comment', 'download', 'approve'],
      shareTokenSessionId: `admin:${currentUser.id}`,
    }
  }

  const isUnauthenticated = authMode === 'NONE'
  if (isUnauthenticated && !shareContext) {
    const sessionId = `none:${projectId}:${getClientIpAddress(request)}`
    return {
      authorized: true,
      isAdmin: false,
      isAuthenticated: true,
      isGuest: false,
      permissions: ['view', 'comment', 'download', 'approve'],
      shareTokenSessionId: sessionId,
    }
  }

  if (!shareContext) {
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: false,
      errorResponse: NextResponse.json(
        { error: 'Authentication required', authMode },
        { status: 401 }
      )
    }
  }

  if (shareContext.projectId !== projectId) {
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: false,
      errorResponse: NextResponse.json(
        { error: 'Access denied' },
        { status: 401 }
      )
    }
  }

  const isGuest = !!shareContext.guest
  const permissions = Array.isArray(shareContext.permissions) ? shareContext.permissions : []

  if (!allowGuest && isGuest) {
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: true,
      isGuest: true,
      permissions,
      errorResponse: NextResponse.json(
        { error: 'Guest access is restricted for this action' },
        { status: 403 }
      )
    }
  }

  if (requiredPermission && !permissions.includes(requiredPermission)) {
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: true,
      isGuest,
      permissions,
      errorResponse: NextResponse.json(
        { error: 'Insufficient permissions' },
        { status: 403 }
      )
    }
  }

  if (
    requiredAnyPermission &&
    requiredAnyPermission.length > 0 &&
    !requiredAnyPermission.some(permission => permissions.includes(permission))
  ) {
    return {
      authorized: false,
      isAdmin: false,
      isAuthenticated: true,
      isGuest,
      permissions,
      errorResponse: NextResponse.json(
        { error: 'Insufficient permissions' },
        { status: 403 }
      )
    }
  }

  return {
    authorized: true,
    isAdmin: false,
    isAuthenticated: true,
    isGuest,
    permissions,
    shareTokenSessionId: shareContext.sessionId,
  }
}

export async function fetchProjectWithVideos(
  token: string,
  isGuest: boolean,
  guestLatestOnly: boolean,
  projectId: string
) {
  // 5.12.1: every share-view listing must EXCLUDE soft-deleted rows. The
  // status filter alone left trashed videos (still READY) visible on client
  // share links, and let a trashed row whose name matches a live stack show
  // up as a ghost version in the reviewer's reel.
  if (isGuest && guestLatestOnly) {
    const allVideos = await prisma.video.findMany({
      where: {
        projectId,
        status: 'READY',
        deletedAt: null,
      } as any,
      orderBy: { version: 'desc' },
    })

    // 6.1.0: latest row per STACK (rows arrive version-desc, so the first one
    // seen for a stack is its newest). Keying on the name collapsed two
    // unrelated assets that happened to share a filename into one.
    const latestVideoIds: string[] = []
    const seenStacks = new Set<string>()
    for (const video of allVideos) {
      const key = stackKeyOf(video as any)
      if (!seenStacks.has(key)) {
        latestVideoIds.push(video.id)
        seenStacks.add(key)
      }
    }

    return prisma.project.findUnique({
      where: { slug: token },
      include: {
        videos: {
          where: {
            id: { in: latestVideoIds },
            status: 'READY',
            deletedAt: null,
          } as any,
          orderBy: { version: 'desc' },
        },
      },
    })
  }

  return prisma.project.findUnique({
    where: { slug: token },
    include: {
      videos: {
        where: { status: 'READY', deletedAt: null } as any,
        orderBy: { version: 'desc' },
      },
    },
  })
}