/**
 * 6.2.0 Founder area — the single place that answers "is this the platform?".
 *
 * Before this, platform privileges (access links, early-access recipients,
 * platform-only settings fields, Danger Zone exemptions) were hardcoded to
 * `'org-1'` — which is the founder's own marketing company. That coupled the
 * platform's identity to a client relationship and meant that company could
 * never be treated as an ordinary paying customer.
 *
 * Now there is a dedicated platform organization (`Organization.isPlatform`,
 * fixed id below) and the founder has an account inside it. Every other
 * organization — 'org-1' included — is an ordinary tenant.
 *
 * NOTE the deliberate split:
 *   - PRIVILEGE checks use the helpers here.
 *   - The `currentOrgId() ?? 'org-1'` fallback in src/lib/db.ts stays as it is.
 *     That one is about the LEGACY `Settings` row (`id: 'default'`) and the
 *     operator's pre-multi-tenant data, not about who owns the platform.
 */

import { NextRequest, NextResponse } from 'next/server'
import { currentOrgId } from './db'
import { requireApiAuth, type AuthUser } from './auth'
import { isOwner } from './permissions'

/**
 * Fixed id created by the `20260806100000_platform_org` migration. A constant
 * (not a query) so synchronous context checks stay synchronous. Overridable by
 * env for installs that need a different id.
 */
export function platformOrgId(): string {
  return process.env.PLATFORM_ORG_ID?.trim() || 'org-platform'
}

/** Is the CURRENT request running in the platform organization's context? */
export function isPlatformOrgContext(): boolean {
  return currentOrgId() === platformOrgId()
}

/** Does this org id belong to the platform? */
export function isPlatformOrgId(orgId: string | null | undefined): boolean {
  return !!orgId && orgId === platformOrgId()
}

/**
 * A platform admin is an OWNER inside the platform organization: the founder.
 * Kept deliberately narrow — this identity can read across every tenant, so
 * widening it later should be a conscious decision.
 */
export function userIsPlatformAdmin(
  user: { organizationId?: string | null; role?: string } | null | undefined,
): boolean {
  if (!user) return false
  return isPlatformOrgId(user.organizationId ?? null) && isOwner(user.role ?? '')
}

/**
 * Guard for every `/api/founder/*` route. Returns 404 (not 403) for everyone
 * else so the founder surface isn't discoverable by probing.
 */
export async function requirePlatformAdmin(
  request: NextRequest,
): Promise<AuthUser | Response> {
  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth
  if (!userIsPlatformAdmin(auth as any)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return auth
}
