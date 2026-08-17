import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { prisma, prismaPrivileged, setDatabaseUserContext, setDatabaseOrgContext, orgSettingsWhere } from './db'
import { enterOrgContext } from './org-context'
import { verifyPassword } from './encryption'
import { revokeToken, isTokenRevoked, isUserTokensRevoked } from './token-revocation'
import { getRedis } from './redis'
import { isShareSessionRevoked } from './session-invalidation'
import { logError, logWarn } from './logging'
import { getAdminSessionTimeoutSeconds } from './settings'
import {
  isStaff,
  canManageSettings,
  canManageUsers,
  canDeleteUsers,
  isOwner,
} from './permissions'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  // 2.5.1+: data: URL string for the inline-stored profile avatar.
  // Optional — undefined when the caller selected the legacy field
  // set (id/email/name/role only). Nullable when the user simply
  // has no avatar yet, in which case the UI falls back to initials.
  avatarUrl?: string | null
  role: string
  // 5.0 multi-tenant: the user's organization. Read FRESH from the DB on
  // every request (never trusted from the token), so moving a user between
  // orgs or deleting an org takes effect immediately. Nullable only for
  // legacy rows mid-migration; effectively 'org-1' for all existing users.
  organizationId?: string | null
}

interface AdminAccessPayload extends jwt.JwtPayload {
  type: 'admin_access'
  userId: string
  email: string
  role: string
  sessionId: string
  // 5.0 multi-tenant: informational claim only — org resolution always goes
  // through the DB user row. Absent on pre-5.x tokens (legacy sessions keep
  // working; the DB read supplies the org).
  organizationId?: string | null
}

interface AdminRefreshPayload extends jwt.JwtPayload {
  type: 'admin_refresh'
  userId: string
  email: string
  role: string
  sessionId: string
  rotationId: string
  organizationId?: string | null
  /** 6.13.0 — when the SESSION started (epoch seconds), carried unchanged
   *  through every rotation. Rotation refreshes the token, not the session:
   *  without this the 30-day window slid forward forever and a session that
   *  an attacker kept alive would never expire on its own. Absent on tokens
   *  minted before 6.13.0 — those fall back to `iat`. */
  sat?: number
}

interface SharePayload extends jwt.JwtPayload {
  type: 'share'
  shareId: string
  projectId: string
  permissions: string[]
  sessionId: string
  guest: boolean
  recipientId?: string
  authMode?: string
  adminOverride?: boolean
  // Folder-share scope (1.0.6+). When set, this token only grants
  // access to the folder subtree rooted at `folderId` inside the
  // parent project — not the whole project. Token consumers that
  // serve content (video stream, comments, etc.) must additionally
  // verify the requested video lives somewhere under this folder.
  // Absent (undefined) means a project-wide share token, same as
  // before.
  folderId?: string
  // 5.0 multi-tenant: the organization that owns the shared project. Minted
  // into every new share token; verifyShareToken arms the request org
  // context from it (resolving via the privileged client for older tokens),
  // so a share link can never read outside its own company.
  organizationId?: string | null
}

function safeParseInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const ADMIN_ACCESS_SECRET = process.env.JWT_SECRET
const ADMIN_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET
const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET

const ACCESS_TOKEN_DURATION = safeParseInt(process.env.ADMIN_ACCESS_TTL_SECONDS, 15 * 60) // 15 minutes
// 6.3.2: 30 days (720 hours). This is the token that decides how long a
// person stays signed in — the ACCESS token stays short-lived and is renewed
// silently in the background, so lengthening this doesn't widen the window an
// intercepted access token would be useful for. Overridable per install via
// ADMIN_REFRESH_TTL_SECONDS.
const REFRESH_TOKEN_DURATION = safeParseInt(process.env.ADMIN_REFRESH_TTL_SECONDS, 30 * 24 * 60 * 60) // 30 days
const SHARE_TOKEN_DURATION = safeParseInt(process.env.SHARE_TOKEN_TTL_SECONDS, 45 * 60) // 45 minutes
// 6.13.0: the hard ceiling on a session, activity or not. OWASP is explicit
// that every session needs an absolute timeout on top of the idle one —
// "still logged in" must eventually stop being true. 30 days matches the
// refresh window, so in practice this is the boundary the user will meet.
const ABSOLUTE_SESSION_DURATION = safeParseInt(
  process.env.ADMIN_ABSOLUTE_SESSION_SECONDS,
  30 * 24 * 60 * 60,
) // 30 days
// 6.13.0: rotation leeway. Two tabs waking up together both present the same
// refresh token; the second one is not a thief, it is a race with itself.
// Within this window a replayed token replays its OWN successor instead of
// being treated as theft — the same call answers twice, which is what the
// client actually meant. Long enough for a slow mobile network, short enough
// that a stolen token is useless by the time it is copied out.
const ROTATION_LEEWAY_SECONDS = safeParseInt(process.env.ADMIN_ROTATION_LEEWAY_SECONDS, 20)
const DUMMY_BCRYPT_HASH = '$2a$14$aoLibk0GEJrzo6fSqPoQIONMGynUKWEoQhkCrFcEapn6I.WzXXdki'

if (process.env.SKIP_ENV_VALIDATION !== '1') {
  const missing: string[] = []
  if (!ADMIN_ACCESS_SECRET) missing.push('JWT_SECRET')
  if (!ADMIN_REFRESH_SECRET) missing.push('JWT_REFRESH_SECRET')
  if (!SHARE_TOKEN_SECRET) missing.push('SHARE_TOKEN_SECRET')
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Generate with: openssl rand -base64 32`)
  }
}

function signAdminAccess(user: AuthUser, sessionId: string, ttlSeconds?: number): string {
  if (!ADMIN_ACCESS_SECRET) throw new Error('JWT_SECRET missing')
  const payload: AdminAccessPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    sessionId,
    organizationId: user.organizationId ?? null,
    type: 'admin_access',
  }
  return jwt.sign(payload, ADMIN_ACCESS_SECRET, { expiresIn: ttlSeconds || ACCESS_TOKEN_DURATION, algorithm: 'HS256' })
}

function signAdminRefresh(
  user: AuthUser,
  sessionId: string,
  rotationId: string,
  sessionStartedAt: number,
  ttlSeconds: number,
): string {
  if (!ADMIN_REFRESH_SECRET) throw new Error('JWT_REFRESH_SECRET missing')
  const payload: AdminRefreshPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    sessionId,
    rotationId,
    organizationId: user.organizationId ?? null,
    type: 'admin_refresh',
    sat: sessionStartedAt,
  }
  return jwt.sign(payload, ADMIN_REFRESH_SECRET, { expiresIn: ttlSeconds, algorithm: 'HS256' })
}

/** Seconds left in the absolute window that started at `sessionStartedAt`. */
function absoluteSecondsLeft(sessionStartedAt: number): number {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return sessionStartedAt + ABSOLUTE_SESSION_DURATION - nowSeconds
}

export function signShareToken(params: {
  shareId: string
  projectId: string
  permissions: string[]
  guest: boolean
  sessionId?: string
  recipientId?: string
  authMode?: string
  adminOverride?: boolean
  ttlSeconds?: number
  /** When set, scopes the token to a folder subtree inside the
   *  project (1.0.6+ folder shares). Omit for a project-wide token. */
  folderId?: string
  /** 5.0 multi-tenant: owning org of the shared project. */
  organizationId?: string | null
}): string {
  if (!SHARE_TOKEN_SECRET) throw new Error('SHARE_TOKEN_SECRET missing')
  const sessionId = params.sessionId || crypto.randomBytes(16).toString('base64url')
  const payload: SharePayload = {
    type: 'share',
    shareId: params.shareId,
    projectId: params.projectId,
    permissions: params.permissions,
    guest: params.guest,
    sessionId,
    recipientId: params.recipientId,
    authMode: params.authMode,
    adminOverride: params.adminOverride,
    folderId: params.folderId,
    organizationId: params.organizationId ?? null,
  }
  return jwt.sign(payload, SHARE_TOKEN_SECRET, {
    expiresIn: params.ttlSeconds || SHARE_TOKEN_DURATION,
    algorithm: 'HS256',
  })
}

export async function verifyAdminAccessToken(token: string): Promise<AdminAccessPayload | null> {
  try {
    if (!ADMIN_ACCESS_SECRET) return null
    const decoded = jwt.verify(token, ADMIN_ACCESS_SECRET, { algorithms: ['HS256'] }) as AdminAccessPayload
    if (decoded.type !== 'admin_access') return null
    if (await isTokenRevoked(token)) return null
    if (await isUserTokensRevoked(decoded.userId, decoded.iat)) return null
    return decoded
  } catch {
    return null
  }
}

export async function verifyAdminRefreshToken(token: string): Promise<AdminRefreshPayload | null> {
  try {
    if (!ADMIN_REFRESH_SECRET) return null
    const decoded = jwt.verify(token, ADMIN_REFRESH_SECRET, { algorithms: ['HS256'] }) as AdminRefreshPayload
    if (decoded.type !== 'admin_refresh') return null
    if (await isTokenRevoked(token)) return null
    if (await isUserTokensRevoked(decoded.userId, decoded.iat)) return null
    return decoded
  } catch {
    return null
  }
}

export async function verifyShareToken(token: string): Promise<SharePayload | null> {
  try {
    if (!SHARE_TOKEN_SECRET) return null
    const decoded = jwt.verify(token, SHARE_TOKEN_SECRET, { algorithms: ['HS256'] }) as SharePayload
    if (decoded.type !== 'share') return null
    if (await isTokenRevoked(token)) return null

    // Check if session is revoked (auth mode changes, etc.).
    //
    // Special case: projects with `authMode === 'NONE'` use a
    // deterministic sessionId of the form `none:<projectId>:<ip>`. There
    // is no "log in again" for those projects — every page reload from
    // the same IP rebuilds the same sessionId — so a stale revocation
    // entry permanently locks the project from that IP, even after the
    // share endpoint hands the browser a freshly-signed JWT. Since
    // session invalidation can't meaningfully kick out a NONE-mode
    // viewer (they're back the moment they hit refresh), we skip the
    // check entirely for NONE rather than booby-trapping every future
    // token. Token-level revocation via `isTokenRevoked` above still
    // applies, so an individual JWT can still be killed.
    if (
      decoded.authMode !== 'NONE' &&
      decoded.sessionId &&
      (await isShareSessionRevoked(decoded.sessionId))
    ) {
      return null
    }

    // 5.0 multi-tenant: arm the request's org context from the token so every
    // subsequent query in the share route is scoped to the OWNING company —
    // a share link can never resolve another org's data, even with swapped
    // ids in the URL. New tokens carry the claim; for older tokens (≤45 min
    // TTL) we resolve the project's org once via the privileged client.
    let organizationId = decoded.organizationId ?? null
    if (!organizationId && decoded.projectId) {
      try {
        const project = (await prismaPrivileged.project.findUnique({
          where: { id: decoded.projectId },
          select: { organizationId: true } as any,
        })) as any
        organizationId = project?.organizationId ?? null
      } catch {
        /* resolution is best-effort pre-flip */
      }
    }
    if (organizationId) {
      enterOrgContext(organizationId)
      decoded.organizationId = organizationId
    }

    return decoded
  } catch {
    return null
  }
}

export function parseBearerToken(request: NextRequest, headerName: string = 'authorization'): string | null {
  const header = request.headers.get(headerName)
  if (!header) return null
  const [scheme, value] = header.split(' ')
  if (!value || scheme.toLowerCase() !== 'bearer') return null
  return value.trim()
}

export async function issueAdminTokens(user: AuthUser, fingerprintHash?: string) {
  const sessionId = crypto.randomUUID()
  const rotationId = crypto.randomUUID()
  const sessionStartedAt = Math.floor(Date.now() / 1000)
  // 6.13.0: the access token is SHORT-lived and always has been meant to be.
  // It used to be signed with the admin session timeout, which was 12 hours
  // and is now 720 — that would have made the bearer token every API route
  // accepts valid for a month, and moving the refresh token into an HttpOnly
  // cookie would have bought almost nothing. The long number governs how long
  // you may stay signed IN; this one governs how long a single leaked
  // credential is worth anything.
  const refreshTtl = Math.min(REFRESH_TOKEN_DURATION, ABSOLUTE_SESSION_DURATION)
  const accessToken = signAdminAccess(user, sessionId, ACCESS_TOKEN_DURATION)
  const refreshToken = signAdminRefresh(user, sessionId, rotationId, sessionStartedAt, refreshTtl)

  if (fingerprintHash) {
    await storeTokenFingerprint(user.id, refreshToken, fingerprintHash)
  }

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: Date.now() + ACCESS_TOKEN_DURATION * 1000,
    refreshExpiresAt: Date.now() + refreshTtl * 1000,
    /** 6.13.0: how long the cookie carrying the refresh token may live. */
    refreshMaxAgeSeconds: refreshTtl,
    sessionId,
  }
}

export async function refreshAdminTokens(params: {
  refreshToken: string
  fingerprintHash?: string
}) {
  const { refreshToken, fingerprintHash } = params

  // 6.13.0 — device binding is checked FIRST, before the leeway cache can
  // hand anything back. Otherwise a token stolen and replayed from another
  // machine inside the 20-second window would be served a live successor with
  // both the fingerprint check and theft detection skipped.
  if (fingerprintHash) {
    const presentedFingerprint = await getTokenFingerprint(
      (decodeRefreshTokenUnsafely(refreshToken)?.userId as string) || '',
      refreshToken,
    )
    if (presentedFingerprint && presentedFingerprint !== fingerprintHash) {
      const owner = decodeRefreshTokenUnsafely(refreshToken)
      if (owner?.userId) {
        logError(`[AUTH] Refresh token presented from a different device for user ${owner.userId}`)
        await revokeToken(refreshToken, remainingTtl(refreshToken, ADMIN_REFRESH_SECRET))
        await revokeTokenFamily(owner.userId)
      }
      return null
    }
  }

  // 6.13.0 — did this exact token just get exchanged? Replay its successor.
  const successor = await readRotationSuccessor(refreshToken)
  if (successor) return successor

  // 6.13.0 — reuse detection, before anything else.
  //
  // Rotation revokes the old refresh token. If a revoked-but-otherwise-valid
  // token comes back, someone is replaying a copy: either the legitimate
  // client raced itself, or a stolen token is in play. We cannot tell them
  // apart, and the safe reading of an ambiguous signal is theft — so the whole
  // family dies and everyone re-authenticates. Without this the rotation is
  // theatre: a thief with a copy just keeps rotating alongside the victim.
  if (await isReplayedRefreshToken(refreshToken)) {
    const replayed = decodeRefreshTokenUnsafely(refreshToken)
    if (replayed?.userId) {
      logError(`[AUTH] Refresh token replay for user ${replayed.userId} — revoking the session family`)
      await revokeTokenFamily(replayed.userId)
    }
    return null
  }

  const payload = await verifyAdminRefreshToken(refreshToken)
  if (!payload) return null

  // 6.13.0 — refuse every refresh token minted before this release.
  //
  // Those tokens were handed to `localStorage`, carry a 30-day TTL, and any
  // copy an XSS or a malicious extension took before today would otherwise
  // stay a working session for another month — the cleanup in token-store.ts
  // only removes the victim's own copy. `sat` is the marker: no `sat` means
  // pre-cookie, so it dies here and the person signs in once. That one login
  // is the entire migration cost, and it is the point of doing this at all.
  if (typeof payload.sat !== 'number') {
    await revokeToken(refreshToken, remainingTtl(refreshToken, ADMIN_REFRESH_SECRET))
    return null
  }

  // 6.13.0 — absolute session cap. `sat` rides through every rotation, so
  // this is measured from the original login, not from the last refresh.
  const sessionStartedAt = payload.sat
  const secondsLeft = absoluteSecondsLeft(sessionStartedAt)
  if (secondsLeft <= 0) {
    await revokeToken(refreshToken, remainingTtl(refreshToken, ADMIN_REFRESH_SECRET))
    return null
  }

  const user = (await prismaPrivileged.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      organizationId: true,
    } as any,
  })) as AuthUser | null
  if (!user) {
    await revokeToken(refreshToken, remainingTtl(refreshToken, ADMIN_REFRESH_SECRET))
    return null
  }

  const rotationId = crypto.randomUUID()
  // The renewed tokens never outlive the absolute window they were born into.
  const refreshTtl = Math.min(REFRESH_TOKEN_DURATION, secondsLeft)
  const accessTtl = Math.min(ACCESS_TOKEN_DURATION, secondsLeft)
  const accessToken = signAdminAccess(user, payload.sessionId, accessTtl)
  const newRefreshToken = signAdminRefresh(
    user,
    payload.sessionId,
    rotationId,
    sessionStartedAt,
    refreshTtl,
  )

  // Revoke old refresh token on rotation
  await revokeToken(refreshToken, remainingTtl(refreshToken, ADMIN_REFRESH_SECRET))
  if (fingerprintHash) {
    await storeTokenFingerprint(user.id, newRefreshToken, fingerprintHash)
  }

  const rotated: RotationSuccessor = {
    accessToken,
    refreshToken: newRefreshToken,
    accessExpiresAt: Date.now() + accessTtl * 1000,
    refreshExpiresAt: Date.now() + refreshTtl * 1000,
    refreshMaxAgeSeconds: refreshTtl,
    sessionId: payload.sessionId,
    /** Epoch ms when this session dies no matter what. */
    absoluteExpiresAt: (sessionStartedAt + ABSOLUTE_SESSION_DURATION) * 1000,
  }

  await rememberRotationSuccessor(refreshToken, rotated)

  return rotated
}

interface RotationSuccessor {
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
  refreshMaxAgeSeconds: number
  sessionId: string
  absoluteExpiresAt: number
}

function rotationCacheKey(token: string): string {
  return `rt:rotated:${crypto.createHash('sha256').update(token).digest('base64url')}`
}

/** What this token was exchanged for, if that happened moments ago. */
async function readRotationSuccessor(token: string): Promise<RotationSuccessor | null> {
  try {
    const raw = await getRedis().get(rotationCacheKey(token))
    return raw ? (JSON.parse(raw) as RotationSuccessor) : null
  } catch {
    return null
  }
}

/**
 * Remember the successor for a few seconds. This holds a live refresh token in
 * Redis briefly — a deliberate trade: Redis is internal and already holds the
 * revocation list and device fingerprints, and the alternative is logging
 * people out for the crime of having two tabs open.
 */
async function rememberRotationSuccessor(token: string, successor: RotationSuccessor): Promise<void> {
  try {
    await getRedis().setex(rotationCacheKey(token), ROTATION_LEEWAY_SECONDS, JSON.stringify(successor))
  } catch {
    // A Redis hiccup costs a race-losing tab its session, not correctness.
  }
}

/** Signature + expiry are fine, but the token has already been rotated away. */
async function isReplayedRefreshToken(token: string): Promise<boolean> {
  try {
    if (!ADMIN_REFRESH_SECRET) return false
    jwt.verify(token, ADMIN_REFRESH_SECRET, { algorithms: ['HS256'] })
  } catch {
    // Forged or expired — not a replay, just invalid. The normal path 401s.
    return false
  }
  return await isTokenRevoked(token)
}

function decodeRefreshTokenUnsafely(token: string): AdminRefreshPayload | null {
  try {
    return jwt.decode(token) as AdminRefreshPayload | null
  } catch {
    return null
  }
}

export async function revokeTokenFamily(userId: string) {
  // Reuse user-level revocation for blast radius control
  const redis = getRedis()
  await redis.setex(`blacklist:user:${userId}`, REFRESH_TOKEN_DURATION, Date.now().toString())
}

export async function revokePresentedTokens(tokens: { accessToken?: string | null; refreshToken?: string | null }) {
  const { accessToken, refreshToken } = tokens

  if (accessToken) {
    await revokeToken(accessToken, remainingTtl(accessToken, ADMIN_ACCESS_SECRET))
  }
  if (refreshToken) {
    await revokeToken(refreshToken, remainingTtl(refreshToken, ADMIN_REFRESH_SECRET))
  }
}

export async function verifyCredentials(usernameOrEmail: string, password: string): Promise<AuthUser | null> {
  try {
    const user = (await prismaPrivileged.user.findFirst({
      where: {
        OR: [{ email: usernameOrEmail }, { username: usernameOrEmail }],
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        password: true,
        organizationId: true,
      } as any,
    })) as (AuthUser & { password: string }) | null

    if (!user) {
      await verifyPassword(password, DUMMY_BCRYPT_HASH)
      return null
    }

    const isValid = await verifyPassword(password, user.password)
    if (!isValid) {
      return null
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId ?? null,
    }
  } catch (error) {
    logError('Error verifying credentials:', error)
    return null
  }
}

export async function getCurrentUserFromRequest(request: NextRequest): Promise<AuthUser | null> {
  const bearer = parseBearerToken(request)
  if (!bearer) return null
  const payload = await verifyAdminAccessToken(bearer)
  if (!payload) return null

  // 5.0 multi-tenant: `organizationId` joins the select. The `as any` cast
  // keeps this compiling against a pre-5.x generated Prisma client (the
  // sandbox can't regenerate); the Docker build's fresh client types it fully.
  const user = (await prismaPrivileged.user.findUnique({
    where: { id: payload.userId },
    // 2.5.1+: include `avatarUrl` so the session payload carries it
    // back to the client without an extra round-trip.
    // 6.0.2: `username` joins it so the Profile page can seed the real
    // value instead of an empty box that browsers then autofill.
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      avatarUrl: true,
      role: true,
      organizationId: true,
    } as any,
  })) as AuthUser | null

  if (user) {
    await setDatabaseUserContext(user.id, user.role)
    // Arm the RLS org context for the REST OF THIS REQUEST: the ALS entry
    // makes the db.ts extension wrap every subsequent model operation in a
    // [set_config(org), op] batch transaction (see org-context.ts).
    if (user.organizationId) {
      enterOrgContext(user.organizationId)
      await setDatabaseOrgContext(user.organizationId)
    }
  }

  return user
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const headerStore = await headers()
  const bearerHeader = headerStore.get('authorization')
  if (!bearerHeader) return null
  const [scheme, token] = bearerHeader.split(' ')
  if (!token || scheme.toLowerCase() !== 'bearer') return null
  const payload = await verifyAdminAccessToken(token)
  if (!payload) return null

  const user = (await prismaPrivileged.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      organizationId: true,
    } as any,
  })) as AuthUser | null

  if (user) {
    await setDatabaseUserContext(user.id, user.role)
    if (user.organizationId) {
      enterOrgContext(user.organizationId)
      await setDatabaseOrgContext(user.organizationId)
    }
  }

  return user
}

// ---------------------------------------------------------------------------
// 4.7.x: SERVER-SIDE billing suspension gate.
//
// The client-side <BillingWall> overlay is UX only — a user can delete the
// overlay node in devtools and keep using the admin app until they refresh.
// This gate enforces suspension on the SERVER so tampering with the DOM
// achieves nothing: while the instance is billing-suspended, every admin
// CONTENT route (everything going through requireApiAdmin) returns 402
// BILLING_SUSPENDED. A short allow-list stays open so the admin can still
// authenticate, poll billing status, load the Settings page and add a card to
// fix billing. Public client share routes never pass through here, so client
// share links are unaffected.
//
// The suspended flag is cached for a few seconds so we don't add a DB read to
// every single content request; resolution (card added) lifts the gate within
// that window.
let billingSuspendedCache: { value: boolean; at: number } | null = null
const BILLING_SUSPENDED_CACHE_MS = 5000

async function isInstanceBillingSuspended(): Promise<boolean> {
  const now = Date.now()
  if (billingSuspendedCache && now - billingSuspendedCache.at < BILLING_SUSPENDED_CACHE_MS) {
    return billingSuspendedCache.value
  }
  try {
    const settings = (await prisma.settings.findUnique({
      where: orgSettingsWhere(),
      select: { billingSuspended: true } as any,
    })) as any
    const value = !!settings?.billingSuspended
    billingSuspendedCache = { value, at: now }
    return value
  } catch {
    // Never lock the whole app out on a transient DB error.
    return false
  }
}

// Prefixes that MUST stay reachable while suspended: authenticate, read
// billing status (so the wall + Billing pane work), load Settings, manage
// Users, and fix billing. Users is intentionally open so an admin who went
// over the free tier by adding too many people can delete users to drop back
// under the tier and lift the suspension. Everything else is content and gets
// blocked.
const BILLING_GATE_ALLOW_PREFIXES = [
  '/api/billing',
  '/api/auth',
  '/api/session',
  '/api/settings',
  '/api/profile',
  '/api/users',
]

/**
 * Returns a 402 Response when the instance is billing-suspended AND the request
 * targets a non-allow-listed (content) route; otherwise null. Call this from
 * the admin content gate after authentication succeeds.
 */
export async function billingSuspensionGate(request: NextRequest): Promise<Response | null> {
  const path = request.nextUrl?.pathname || ''
  if (BILLING_GATE_ALLOW_PREFIXES.some((p) => path.startsWith(p))) return null
  if (await isInstanceBillingSuspended()) {
    return NextResponse.json(
      { error: 'Billing suspended', code: 'BILLING_SUSPENDED' },
      { status: 402 },
    )
  }
  return null
}

/**
 * 4.3.0+: base gate for the admin app. Historically this required role ===
 * 'ADMIN'; with the new role system it accepts ANY authenticated internal user
 * (Owner / Admin / Editor / Marketing / Producer). This is the correct gate for
 * ordinary CONTENT routes (videos, folders, projects, comments, admin share) —
 * every internal role can use those. Sensitive routes must use the stricter
 * guards below (requireApiManageSettings / requireApiManageUsers /
 * requireApiDeleteUsers / requireApiOwner) instead of this one.
 *
 * The role is read fresh from the DB on every request (see
 * getCurrentUserFromRequest), so a demotion takes effect immediately.
 *
 * 4.7.x: also enforces the billing suspension gate — when the instance is
 * suspended, content routes 402 so DOM-tampering can't bypass the wall.
 */
export async function requireApiAdmin(request: NextRequest): Promise<AuthUser | Response> {
  const user = await getCurrentUserFromRequest(request)
  if (!user || !isStaff(user.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const gate = await billingSuspensionGate(request)
  if (gate) return gate
  return user
}

/** OWNER + ADMIN only. Gate for App Settings, Storage config, Billing. */
export async function requireApiManageSettings(request: NextRequest): Promise<AuthUser | Response> {
  const user = await getCurrentUserFromRequest(request)
  if (!user || !isStaff(user.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canManageSettings(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return user
}

/** OWNER + ADMIN only. Gate for adding users and changing roles. */
export async function requireApiManageUsers(request: NextRequest): Promise<AuthUser | Response> {
  const user = await getCurrentUserFromRequest(request)
  if (!user || !isStaff(user.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canManageUsers(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return user
}

/** OWNER + ADMIN only. Gate for deleting user accounts (per-target rules still apply). */
export async function requireApiDeleteUsers(request: NextRequest): Promise<AuthUser | Response> {
  const user = await getCurrentUserFromRequest(request)
  if (!user || !isStaff(user.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canDeleteUsers(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return user
}

/** OWNER only. Gate for ownership transfer / reversal / company deletion. */
export async function requireApiOwner(request: NextRequest): Promise<AuthUser | Response> {
  const user = await getCurrentUserFromRequest(request)
  if (!user || !isStaff(user.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isOwner(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return user
}

export async function requireApiAuth(request: NextRequest): Promise<AuthUser | Response> {
  const user = await getCurrentUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return user
}

export async function getShareContext(request: NextRequest): Promise<SharePayload | null> {
  const bearer = parseBearerToken(request)
  if (!bearer) return null
  return verifyShareToken(bearer)
}

/**
 * Get complete authentication context for a request
 *
 * Preferred method for dual-auth routes (admin + share token support).
 * Returns all auth information in a single call, preventing redundant lookups.
 *
 * @param request - NextRequest object
 * @returns Object containing user, isAdmin flag, and share context
 */
export async function getAuthContext(request: NextRequest): Promise<{
  user: AuthUser | null
  isAdmin: boolean
  shareContext: SharePayload | null
}> {
  const user = await getCurrentUserFromRequest(request)
  const shareContext = await getShareContext(request)
  // 4.3.0+: any internal role (Owner/Admin/Editor/Marketing/Producer) is
  // "admin" for the purposes of content access vs. a public share token.
  const isAdmin = isStaff(user?.role)

  return { user, isAdmin, shareContext }
}

export async function getAdminOverrideFromRequest(request: NextRequest): Promise<AuthUser | null> {
  const adminHeader = parseBearerToken(request, 'x-admin-authorization')
  if (!adminHeader) return null
  const payload = await verifyAdminAccessToken(adminHeader)
  if (!payload) return null
  const user = (await prismaPrivileged.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      organizationId: true,
    } as any,
  })) as AuthUser | null
  if (user) {
    await setDatabaseUserContext(user.id, user.role)
    if (user.organizationId) {
      enterOrgContext(user.organizationId)
      await setDatabaseOrgContext(user.organizationId)
    }
  }
  return user
}

export async function requireShareToken(request: NextRequest) {
  const token = await getShareContext(request)
  if (!token) {
    return NextResponse.json({ error: 'Share token required' }, { status: 401 })
  }
  return token
}

function remainingTtl(token: string, secret: string | undefined | null): number {
  const fallbackTtl = 60 // Ensure a valid TTL even if token parsing fails

  if (!secret) {
    logWarn('[AUTH] Missing JWT secret while computing remaining TTL')
    return fallbackTtl
  }

  const decoded = jwt.decode(token) as jwt.JwtPayload | null
  if (!decoded?.exp) {
    logWarn('[AUTH] Token missing exp claim while computing remaining TTL')
    return fallbackTtl
  }

  const now = Math.floor(Date.now() / 1000)
  const ttl = decoded.exp - now
  if (ttl <= 0) {
    return 0
  }

  return ttl
}

async function storeTokenFingerprint(userId: string, refreshToken: string, fingerprintHash: string): Promise<void> {
  try {
    const redis = getRedis()
    const key = `token_fingerprint:${userId}:${hashToken(refreshToken)}`
    await redis.setex(key, REFRESH_TOKEN_DURATION, fingerprintHash)
  } catch (error) {
    logError('[AUTH] Failed to store token fingerprint:', error)
  }
}

async function getTokenFingerprint(userId: string, refreshToken: string): Promise<string | null> {
  try {
    const redis = getRedis()
    const key = `token_fingerprint:${userId}:${hashToken(refreshToken)}`
    const fingerprint = await redis.get(key)
    return fingerprint
  } catch (error) {
    logError('[AUTH] Failed to get token fingerprint:', error)
    return null
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url')
}
