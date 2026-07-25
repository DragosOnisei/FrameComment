import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin, requireApiDeleteUsers, getCurrentUserFromRequest } from '@/lib/auth'
import { hashPassword, validatePassword, verifyPassword } from '@/lib/encryption'
import { revokeAllUserTokens } from '@/lib/token-revocation'
import { invalidateAdminSessions } from '@/lib/session-invalidation'
import { rateLimit } from '@/lib/rate-limit'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'
import { canManageUsers, canAssignRole, canActOnUser, isAppRole } from '@/lib/permissions'
import { isGraceOwner } from '@/lib/ownership'

export const runtime = 'nodejs'



// Prevent static generation for this route
export const dynamic = 'force-dynamic'

// GET /api/users/[id] - Get user by ID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const usersMessages = messages?.users || {}

  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limiting: 60 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: usersMessages.tooManyRequestsSlowDown || 'Too many requests. Please slow down.'
  }, 'user-read')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params
    // 4.3.0+: you can read your OWN record (Profile page) always; reading
    // anyone else's is user-management data → Owner/Admin only.
    if (authResult.id !== id && !canManageUsers(authResult.role)) {
      return NextResponse.json(
        { error: usersMessages.unauthorized || 'Unauthorized' },
        { status: 403 }
      )
    }
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        // 2.5.1+: expose the inline avatar so the Profile page can
        // hydrate its preview from a single GET round-trip.
        avatarUrl: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        // Exclude password from response
      },
    })

    if (!user) {
      return NextResponse.json(
        { error: usersMessages.userNotFound || 'User not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ user })
  } catch (error) {
    logError('Error fetching user:', error)
    // SECURITY: Generic message
    return NextResponse.json(
      { error: usersMessages.unableToProcessRequest || 'Unable to process request' },
      { status: 500 }
    )
  }
}

// PATCH /api/users/[id] - Update user
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const usersMessages = messages?.users || {}

  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  try {
    const { id } = await params
    const body = await request.json()
    const { email, username, name, avatarUrl, password, oldPassword, role } = body

    const isSelf = authResult.id === id

    // Load the target's current role + grace status once — the guards below and
    // the role-change logic both need them.
    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { role: true },
    })
    if (!targetUser) {
      return NextResponse.json(
        { error: usersMessages.userNotFound || 'User not found' },
        { status: 404 }
      )
    }
    const targetIsGraceOwner = await isGraceOwner(id)

    // 4.3.0+: editing SOMEONE ELSE requires user-management power and a valid
    // target — never the Owner and never a grace-period owner (those are hard-
    // protected so a hijacker can't lock the real owner out). Editing your OWN
    // profile (name / avatar / email / username / password) stays open to any role.
    if (!isSelf) {
      const allowed = canActOnUser({
        actorId: authResult.id,
        actorRole: authResult.role,
        targetId: id,
        targetRole: targetUser.role,
        targetIsGraceOwner,
      })
      if (!allowed) {
        return NextResponse.json(
          { error: usersMessages.unauthorized || 'You are not allowed to modify this user' },
          { status: 403 }
        )
      }
    }

    // Build update data
    const updateData: any = {}

    // Track if security-sensitive fields changed
    let roleChanged = false

    if (email !== undefined) {
      // Check if email is already taken by another user
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          NOT: { id },
        },
      })

      if (existingUser) {
        return NextResponse.json(
          { error: usersMessages.emailAlreadyTaken || 'Email already taken' },
          { status: 409 }
        )
      }

      updateData.email = email
    }

    if (username !== undefined) {
      // Check if username is already taken by another user
      const existingUsername = await prisma.user.findFirst({
        where: {
          username,
          NOT: { id },
        },
      })

      if (existingUsername) {
        return NextResponse.json(
          { error: usersMessages.usernameAlreadyTaken || 'Username already taken' },
          { status: 409 }
        )
      }

      updateData.username = username || null
    }

    if (name !== undefined) {
      updateData.name = name
    }

    // 2.5.1+: avatar update. Accept either an empty string / null
    // (clear the avatar — fall back to initials) or a `data:` URL
    // capped at ~250KB so we don't blow up routine session lookups.
    if (avatarUrl !== undefined) {
      if (avatarUrl === null || avatarUrl === '') {
        updateData.avatarUrl = null
      } else if (typeof avatarUrl === 'string') {
        if (!avatarUrl.startsWith('data:image/')) {
          return NextResponse.json(
            { error: 'Invalid avatar — must be a data:image URL' },
            { status: 400 }
          )
        }
        if (avatarUrl.length > 256 * 1024) {
          return NextResponse.json(
            { error: 'Avatar too large — please crop to a smaller image' },
            { status: 413 }
          )
        }
        updateData.avatarUrl = avatarUrl
      }
    }

    if (role !== undefined) {
      // 4.3.0+ role-change rules:
      //  - never on your own account (no self-escalation / self-demotion),
      //  - must be an assignable role (OWNER is never assignable here —
      //    ownership only moves through the transfer flow),
      //  - actor can't grant a role above their own level,
      //  - target can't be the Owner or a grace-period owner (already enforced
      //    by the non-self guard above).
      if (isSelf) {
        return NextResponse.json(
          { error: usersMessages.cannotChangeOwnRole || 'You cannot change your own role' },
          { status: 403 }
        )
      }
      if (!isAppRole(role) || !canAssignRole(authResult.role, role)) {
        return NextResponse.json(
          { error: usersMessages.cannotAssignThisRole || 'You are not allowed to assign this role' },
          { status: 403 }
        )
      }
      if (targetUser.role !== role) {
        updateData.role = role
        roleChanged = true
      }
    }

    // Track if password is being changed (for session regeneration)
    let passwordChanged = false

    // 2.5.1+ password handling fix.
    //
    // The old version coerced `password` to '' when it was undefined
    // AND when it was an invalid string, then quietly skipped the
    // update branch in BOTH cases. The result: a caller that
    // explicitly sent a weak/short new password got back a 200 OK
    // ("user updated successfully") even though nothing in the DB
    // had changed — and the old password kept working. That's
    // exactly the failure pattern we just hit on the Profile page.
    //
    // Fix: distinguish "no password supplied" (legitimate — caller
    // is updating something else) from "invalid password supplied"
    // (return 400 with the first validator complaint so the UI can
    // surface it).
    const passwordWasProvided =
      password !== undefined && password !== null && password !== ''

    if (passwordWasProvided) {
      const newPassword = typeof password === 'string' ? password.trim() : ''
      const oldPasswordStr = typeof oldPassword === 'string' ? oldPassword : ''
      const passwordValidation = validatePassword(newPassword)

      if (!passwordValidation.isValid) {
        return NextResponse.json(
          {
            error:
              passwordValidation.errors[0] ||
              'Password does not meet the security requirements',
          },
          { status: 400 }
        )
      }

      // Get user's current password hash
      const userWithPassword = await prisma.user.findUnique({
        where: { id },
        select: { password: true },
      })

      if (!userWithPassword) {
        return NextResponse.json(
          { error: usersMessages.userNotFound || 'User not found' },
          { status: 404 }
        )
      }

      // SECURITY: Verify old password before allowing password change
      const isOldPasswordValid = await verifyPassword(oldPasswordStr, userWithPassword.password)
      if (!isOldPasswordValid) {
        return NextResponse.json(
          { error: usersMessages.currentPasswordIncorrect || 'Current password is incorrect' },
          { status: 401 }
        )
      }

      updateData.password = await hashPassword(newPassword)
      passwordChanged = true
    }

    // Update user
    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    // SECURITY: Handle session security for sensitive changes
    const currentUser = await getCurrentUserFromRequest(request)
    let securityMessage = ''

    if (passwordChanged) {
      if (currentUser && currentUser.id === id) {
        // User is changing their own password - revoke all sessions to force fresh login
        await revokeAllUserTokens(user.id)
      } else {
        // Admin is changing another user's password - revoke their sessions
        await revokeAllUserTokens(user.id)
      }

      securityMessage = usersMessages.allSessionsInvalidatedUserMustLoginAgain || 'All sessions have been invalidated - user will need to log in again.'
    }

    if (roleChanged) {
      if (currentUser && currentUser.id === id) {
        // User's own role is changing - revoke sessions to refresh permissions on next login
        await revokeAllUserTokens(user.id)
        securityMessage = securityMessage
          ? `${securityMessage} ${usersMessages.roleUpdatedLoginAgainToRefreshPermissions || 'Role updated - please log in again to refresh permissions.'}`
          : (usersMessages.roleUpdatedLoginAgainToRefreshPermissions || 'Role updated - please log in again to refresh permissions.')
      } else {
        // Another admin is changing this user's role - revoke all their sessions
        await revokeAllUserTokens(user.id)
        securityMessage = securityMessage
          ? `${securityMessage} ${usersMessages.roleChangedUserMustLoginAgain || 'Role changed - user will need to log in again.'}`
          : (usersMessages.roleChangedUserMustLoginAgainToReflectPermissions || 'Role changed - user will need to log in again to reflect new permissions.')
      }
    }

    return NextResponse.json({
      user,
      message: securityMessage || usersMessages.userUpdatedSuccessfully || 'User updated successfully'
    })
  } catch (error) {
    logError('Error updating user:', error)
    // SECURITY: Generic message
    return NextResponse.json(
      { error: usersMessages.operationFailed || 'Operation failed' },
      { status: 500 }
    )
  }
}

// DELETE /api/users/[id] - Delete user
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const usersMessages = messages?.users || {}

  // 4.3.0+: deleting users is Owner/Admin only.
  const authResult = await requireApiDeleteUsers(request)
  if (authResult instanceof Response) {
    return authResult
  }

  try {
    const { id } = await params
    // Get current user from auth
    const currentUser = authResult

    // Prevent deleting yourself
    if (currentUser.id === id) {
      return NextResponse.json(
        { error: usersMessages.cannotDeleteOwnAccount || 'Cannot delete your own account' },
        { status: 400 }
      )
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id },
    })

    if (!user) {
      return NextResponse.json(
        { error: usersMessages.userNotFound || 'User not found' },
        { status: 404 }
      )
    }

    // 4.3.0+: never delete the Owner or a grace-period owner. Ownership is only
    // ever removed through the transfer flow (with its 30-day rescue window) —
    // this is the hard rule that keeps an Admin (or a hijacked session) from
    // deleting the account owner. Also re-confirms not-self.
    const targetIsGraceOwner = await isGraceOwner(id)
    if (
      !canActOnUser({
        actorId: currentUser.id,
        actorRole: currentUser.role,
        targetId: id,
        targetRole: (user as any).role,
        targetIsGraceOwner,
      })
    ) {
      return NextResponse.json(
        { error: usersMessages.cannotDeleteThisUser || 'You are not allowed to delete this user' },
        { status: 403 }
      )
    }

    // Invalidate all sessions for this user BEFORE deletion
    // This ensures any active tokens are revoked immediately
    await invalidateAdminSessions(id)

    // Delete user
    await prisma.user.delete({
      where: { id },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error deleting user:', error)
    // SECURITY: Generic message
    return NextResponse.json(
      { error: usersMessages.operationFailed || 'Operation failed' },
      { status: 500 }
    )
  }
}
