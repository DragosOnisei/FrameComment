import { prisma } from './db'
import { hashPassword } from './encryption'
import { logError, logMessage } from './logging'

/**
 * Ensure security settings are initialized
 */
async function ensureSecuritySettings() {
  try {
    await prisma.securitySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        hotlinkProtection: 'LOG_ONLY',
        ipRateLimit: 1000, // High limit for video streaming with HTTP Range requests
        sessionRateLimit: 600, // 10 req/sec average for video buffering/seeking
        passwordAttempts: 5,
        trackAnalytics: true,
        trackSecurityLogs: true,
        viewSecurityEvents: false, // Hide security dashboard by default
      },
      update: {
        // Don't overwrite existing settings
      },
    })
  } catch (error) {
    logError('Error initializing security settings:', error)
    // Don't throw - app should still start even if this fails
  }
}

/**
 * Ensure default admin user exists
 * This is called automatically when the app starts
 *
 * SECURITY: Only creates default admin if NO admin users exist in the database
 * This prevents recreating default credentials on rebuilds (security risk)
 */
export async function ensureDefaultAdmin() {
  try {
    // SECURITY: Check if ANY internal user exists (not just the default one).
    // This prevents recreating the default admin after it's been changed/removed.
    // 4.3.0+: must match ANY role, not just 'ADMIN' — otherwise once the founder
    // becomes OWNER this check finds nothing and tries to recreate the seed user
    // every boot (→ "Unique constraint failed on email"). The User table only
    // ever holds internal staff, so "any user" is the right test.
    const anyAdmin = await prisma.user.findFirst()

    if (anyAdmin) {
      // Initialize security settings even if admin exists
      await ensureSecuritySettings()
      return
    }

    // No admin exists - require credentials from environment variables
    // SECURITY: No default credentials - must be set in .env file
    const adminEmail = process.env.ADMIN_EMAIL
    const adminPassword = process.env.ADMIN_PASSWORD

    if (!adminEmail || !adminPassword) {
      logError('')
      logError('===============================================================')
      logError('CRITICAL ERROR: Admin credentials not configured!')
      logError('===============================================================')
      logError('')
      logError('No admin user exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set.')
      logError('')
      logError('REQUIRED: Set these environment variables in your .env file:')
      logError('  ADMIN_EMAIL=your-admin@example.com')
      logError('  ADMIN_PASSWORD=YourSecurePassword123')
      logError('')
      logError('Then restart the application.')
      logError('===============================================================')
      logError('')
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment variables for initial setup')
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(adminEmail)) {
      throw new Error(`Invalid ADMIN_EMAIL format: ${adminEmail}`)
    }

    // Validate password strength
    if (adminPassword.length < 8) {
      throw new Error('ADMIN_PASSWORD must be at least 8 characters long')
    }

    logMessage('')
    logMessage('===============================================================')
    logMessage('Creating initial admin user...')
    logMessage('===============================================================')
    logMessage(`Email: ${adminEmail}`)
    logMessage('Password: ********')
    logMessage('===============================================================')
    logMessage('')

    const adminUsername = process.env.ADMIN_USERNAME || adminEmail.split('@')[0]
    const hashedPassword = await hashPassword(adminPassword)

    await prisma.user.create({
      data: {
        username: adminUsername,
        email: adminEmail,
        password: hashedPassword,
        name: process.env.ADMIN_NAME || 'Admin',
        // 4.3.0+: the founding account is the OWNER (top of the role hierarchy)
        // so a fresh install always has exactly one owner. `as any` because the
        // generated client may still lag the schema until `prisma generate`.
        role: 'OWNER' as any,
      },
    })

    logMessage('Admin user created successfully!')
    logMessage('')

    // Initialize security settings
    await ensureSecuritySettings()
  } catch (error) {
    logError('Error ensuring default admin:', error)
    // Don't throw - app should still start even if this fails
  }
}

/**
 * 4.3.0+: guarantee the account has exactly one founding OWNER.
 *
 * Runs on every boot but only ACTS when no OWNER exists yet — so it's the
 * self-healing safety net for the role migration. When there's no owner, it
 * promotes the founder: the account whose email matches ADMIN_EMAIL (the
 * originally-seeded admin — i.e. the first person who set up the app), falling
 * back to the earliest-created user if that email isn't found. This is what
 * makes the app actively KNOW the founder is the Owner rather than guessing.
 *
 * Uses raw SQL so it works even before `prisma generate` catches up with the
 * new UserRole enum, and never touches anything once an owner is in place
 * (including during a 30-day ownership-transfer grace window, where an owner
 * always exists).
 */
export async function ensureFoundingOwner(): Promise<void> {
  try {
    const owners = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "User" WHERE "role" = 'OWNER' LIMIT 1`,
    )
    if (owners.length > 0) return // an owner already exists — leave everything alone

    let founder: { id: string; email: string } | undefined
    const adminEmail = process.env.ADMIN_EMAIL
    if (adminEmail) {
      // ADMIN_EMAIL is configured → promote EXACTLY that account, or NOBODY.
      // We deliberately do NOT fall back to "earliest user" here: on an install
      // with many admins that guess could crown the wrong person. Promoting only
      // the known founder (and never touching any other user) is what makes
      // "only I become Owner, everyone else stays Admin" a guarantee.
      const byEmail = await prisma.$queryRawUnsafe<Array<{ id: string; email: string }>>(
        `SELECT "id", "email" FROM "User" WHERE "email" = $1 LIMIT 1`,
        adminEmail,
      )
      founder = byEmail[0]
      if (!founder) {
        logError(
          `[INIT] No OWNER set: ADMIN_EMAIL (${adminEmail}) does not match any user. ` +
            `Set an owner manually (UPDATE "User" SET role='OWNER' WHERE email='<you>').`,
        )
        return
      }
    } else {
      // No ADMIN_EMAIL configured at all → last-resort so the account still has
      // an owner: the earliest-created user.
      const earliest = await prisma.$queryRawUnsafe<Array<{ id: string; email: string }>>(
        `SELECT "id", "email" FROM "User" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1`,
      )
      founder = earliest[0]
    }
    if (!founder) return // no users at all (fresh, pre-seed) — nothing to promote

    // Promotes exactly ONE row; no other user is ever modified.
    await prisma.$executeRawUnsafe(
      `UPDATE "User" SET "role" = 'OWNER', "updatedAt" = NOW() WHERE "id" = $1`,
      founder.id,
    )
    logMessage(`[INIT] Founding owner ensured: ${founder.email}`)
  } catch (error) {
    logError('[INIT] ensureFoundingOwner failed (non-fatal):', error)
  }
}
