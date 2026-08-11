import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUserFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isPlatformOrgId, userIsPlatformAdmin } from '@/lib/platform'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'
export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const authMessages = messages?.auth || {}

  // Rate limiting: 120 requests per minute (session checks are frequent)
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: authMessages.tooManySessionRequests || 'Too many requests. Please slow down.'
  }, 'session-check')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const user = await getCurrentUserFromRequest(request)

    if (!user) {
      const response = NextResponse.json(
        { authenticated: false, user: null },
        { status: 401 }
      )
      
      // Add cache control headers
      response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      response.headers.set('Pragma', 'no-cache')
      response.headers.set('Expires', '0')
      
      return response
    }

    const response = NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        // 6.0.2: the optional alternative login handle. Without it the
        // Profile page seeded an EMPTY username box, which browsers then
        // autofilled with the saved login — and "Save profile" quietly
        // stored whatever autofill had put there.
        username: (user as any).username ?? null,
        name: user.name,
        // 2.5.1+: surface the profile avatar so the sidebar avatar
        // circle + the Profile page can render without extra fetches.
        avatarUrl: user.avatarUrl ?? null,
        role: user.role,
        // 5.10.1: lets the UI adapt platform-vs-tenant copy (e.g. the
        // project-deletion safety notes only apply to tenant companies).
        // 6.2.0: the platform is its OWN organization now, so the founder's
        // marketing company reads as the tenant it actually is.
        isPlatformOrg: isPlatformOrgId((user as any).organizationId ?? null),
        // 6.2.0: drives the redirect into the Founder area and gates its UI.
        isPlatformAdmin: userIsPlatformAdmin(user as any),
      },
    })
    
    // Add cache control headers to prevent caching of user session data
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Expires', '0')
    
    return response
  } catch (error) {
    logError('Session check error:', error)
    return NextResponse.json(
      { error: authMessages.errorOccurredCheckingSession || 'An error occurred checking session' },
      { status: 500 }
    )
  }
}
