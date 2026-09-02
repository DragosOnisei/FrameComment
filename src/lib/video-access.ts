import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma, prismaPrivileged, orgSettingsWhere } from './db'
import { enterOrgContext } from './org-context'
import { logError, logMessage } from './logging'
import { getClientIpAddress } from './utils'
import { getClientSessionTimeoutSeconds } from './settings'
import { getRedis } from './redis'

type CachedValue<T> = { value: T; expiresAt: number; version?: string }
type SecuritySettingsResult = {
  hotlinkProtection: string
  ipRateLimit: number
  sessionRateLimit: number
  shareSessionRateLimit: number
  trackSecurityLogs: boolean
  trackAnalytics: boolean
}

const SECURITY_SETTINGS_CACHE_TTL_MS = 90_000
const securitySettingsCache: CachedValue<SecuritySettingsResult> = {
  value: {
    hotlinkProtection: 'LOG_ONLY',
    ipRateLimit: 1000,
    sessionRateLimit: 600,
    shareSessionRateLimit: 300,
    trackSecurityLogs: true,
    trackAnalytics: true
  },
  expiresAt: 0,
  version: undefined
}

const TOKEN_CACHE_TTL_MS = 10_000
const TOKEN_CACHE_MAX_ENTRIES = 500
type CachedTokenEntry = CachedValue<VideoAccessToken>
const tokenVerificationCache = new Map<string, CachedTokenEntry>()
const TOKEN_REV_VERSION_KEY = 'video_token_rev_version'

interface VideoAccessToken {
  videoId: string
  projectId: string
  quality: string
  sessionId: string
  ipAddress: string
  createdAt: number
  isAdmin: boolean
  // 5.0 multi-tenant: the owning org, resolved once at mint time. Verification
  // arms the request org context from it so the content route's video/project
  // lookups stay inside the owning company (RLS backstop post-flip). Absent on
  // legacy Redis tokens → resolved lazily at verify.
  organizationId?: string | null
}

/**
 * Generate a time-limited video access token with session binding
 * Tokens are cached per session to prevent token proliferation
 *
 * @param videoId - ID of the video to grant access to
 * @param projectId - ID of the project containing the video
 * @param quality - Quality level (thumbnail, preview720, preview1080, original)
 * @param request - NextRequest for IP address extraction
 * @param sessionId - Session ID for binding token to specific session
 * @returns Base64url-encoded access token valid for client session timeout duration
 */
export async function generateVideoAccessToken(
  videoId: string,
  projectId: string,
  quality: string,
  request: NextRequest,
  sessionId: string
): Promise<string> {
  const redis = getRedis()

  const cacheKey = `video_token_cache:${sessionId}:${videoId}:${quality}`
  const cachedToken = await redis.get(cacheKey)

  if (cachedToken) {
    const tokenData = await redis.get(`video_access:${cachedToken}`)
    if (tokenData) {
      return cachedToken
    }
  }

  const token = crypto.randomBytes(16).toString('base64url')
  const ipAddress = getClientIpAddress(request)

  // 5.0 multi-tenant: resolve the owning org once per mint (mints are
  // session-cached above, so this is not on the hot serving path). Privileged
  // client: minting can happen before any org context exists.
  let organizationId: string | null = null
  try {
    const project = (await prismaPrivileged.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true } as any,
    })) as any
    organizationId = project?.organizationId ?? null
  } catch {
    /* best-effort pre-flip */
  }

  const tokenData: VideoAccessToken = {
    videoId,
    projectId,
    quality,
    sessionId,
    ipAddress,
    createdAt: Date.now(),
    isAdmin: sessionId.startsWith('admin:'),
    organizationId,
  }

  const ttlSeconds = await getClientSessionTimeoutSeconds()

  await redis.setex(
    `video_access:${token}`,
    ttlSeconds,
    JSON.stringify(tokenData)
  )

  await redis.setex(cacheKey, ttlSeconds, token)

  return token
}

/**
 * 7.5.0: forget every cached token mint for one video, across ALL sessions.
 *
 * Minted tokens are cached per (session, video, quality) and REUSED — good
 * for request volume, fatal after a speed rewrite: the page re-tokenizes
 * when the video lands READY, gets the SAME token string back, and the
 * browser serves the old-speed bytes from HTTP cache because the URL never
 * changed (previews are `max-age=3600`, HLS segments a year+immutable, and
 * the rewrite reuses the same storage paths). Live symptom: a 4x video that
 * "plays at normal speed and stops when the playhead hits the end" — new
 * duration from the DB, old bytes from the cache.
 *
 * Dropping the mint-cache keys forces the next tokenize to mint a FRESH
 * random token → every derived-content URL changes → no cache anywhere
 * (browser or CDN) has ever seen it. The underlying `video_access:<token>`
 * entries are left alone on purpose: a viewer mid-play keeps a working
 * token instead of hitting 401s; they get the new bytes on their next
 * reload.
 */
export async function invalidateVideoAccessTokenCache(videoId: string): Promise<number> {
  const redis = getRedis()
  let cursor = '0'
  let removed = 0
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `video_token_cache:*:${videoId}:*`,
      'COUNT',
      200,
    )
    cursor = next
    if (keys.length > 0) {
      removed += keys.length
      await redis.del(...keys)
    }
  } while (cursor !== '0')
  return removed
}

/**
 * Verify video access token and validate session binding
 * Checks token existence, session match, and IP address consistency
 *
 * @param token - The access token to verify
 * @param request - NextRequest for IP address validation
 * @param sessionId - Expected session ID for token binding verification
 * @returns Parsed token data if valid, null if invalid or expired
 */
export async function verifyVideoAccessToken(
  token: string,
  request: NextRequest,
  sessionId: string
): Promise<VideoAccessToken | null> {
  const redis = getRedis()
  const now = Date.now()

  const revVersion = (await redis.get(TOKEN_REV_VERSION_KEY)) || '0'
  const cacheKey = `${token}:${sessionId}:${revVersion}`
  const cached = tokenVerificationCache.get(cacheKey)

  if (cached) {
    if (cached.expiresAt > now && cached.version === revVersion) {
      // 5.0 multi-tenant: arm the org context on cache hits too — the
      // content route's lookups must always run inside the owning company.
      if (cached.value.organizationId) {
        enterOrgContext(cached.value.organizationId)
      }
      return cached.value
    }
    tokenVerificationCache.delete(cacheKey)
  }

  const key = `video_access:${token}`
  const data = await redis.get(key)

  if (!data) {
    return null
  }

  let tokenData: VideoAccessToken
  try {
    tokenData = JSON.parse(data)

    if (!tokenData.videoId || !tokenData.projectId || !tokenData.sessionId) {
      logMessage(`[SECURITY] Invalid token data structure (tokenPrefix=${token.substring(0, 10)})`)
      return null
    }
  } catch (error) {
    logError(`[SECURITY] Failed to parse video access token data (tokenPrefix=${token.substring(0, 10)})`, error)
    return null
  }

  const isAdminSession = tokenData.isAdmin === true

  if (!isAdminSession) {
    if (tokenData.sessionId !== sessionId) {
      await logSecurityEvent({
        type: 'TOKEN_SESSION_MISMATCH',
        severity: 'WARNING',
        projectId: tokenData.projectId,
        videoId: tokenData.videoId,
        sessionId,
        ipAddress: getClientIpAddress(request),
        details: { expectedSession: tokenData.sessionId }
      })

      return null
    }
  }

  // 5.0 multi-tenant: legacy Redis tokens predate the organizationId field —
  // resolve it once via the privileged client (result is cached below).
  if (!tokenData.organizationId) {
    try {
      const project = (await prismaPrivileged.project.findUnique({
        where: { id: tokenData.projectId },
        select: { organizationId: true } as any,
      })) as any
      tokenData.organizationId = project?.organizationId ?? null
    } catch {
      /* best-effort pre-flip */
    }
  }
  if (tokenData.organizationId) {
    enterOrgContext(tokenData.organizationId)
  }

  tokenVerificationCache.set(cacheKey, {
    value: tokenData,
    expiresAt: now + TOKEN_CACHE_TTL_MS,
    version: revVersion
  })

  if (tokenVerificationCache.size > TOKEN_CACHE_MAX_ENTRIES) {
    tokenVerificationCache.clear()
  }

  return tokenData
}

/**
 * Detect potential hotlinking attempts using referer analysis and session validation
 * Checks for suspicious patterns: missing referer, external domains, rapid token rotation
 *
 * @param request - NextRequest containing referer and origin headers
 * @param sessionId - Session ID for tracking access patterns
 * @param videoId - Video being accessed
 * @param projectId - Project containing the video
 * @returns Object indicating if hotlinking detected, with reason and severity level
 */
export async function detectHotlinking(
  request: NextRequest,
  sessionId: string,
  videoId: string,
  projectId: string
): Promise<{ isHotlinking: boolean; reason?: string; severity?: string }> {
  const redis = getRedis()
  
  const referer = request.headers.get('referer') || request.headers.get('origin')
  const host = request.headers.get('host')

  if (referer && host) {
    try {
      const refererUrl = new URL(referer)
      const refererHost = refererUrl.hostname

      if (host && !refererHost.includes(host) && !host.includes(refererHost)) {
        const blockedDomains = await getBlockedDomains()
        if (blockedDomains.some(domain => refererHost.includes(domain))) {
          return {
            isHotlinking: true,
            reason: `Blocked domain: ${refererHost}`,
            severity: 'CRITICAL'
          }
        }

        await logSecurityEvent({
          type: 'HOTLINK_DETECTED',
          severity: 'WARNING',
          projectId,
          videoId,
          sessionId,
          ipAddress: getClientIpAddress(request),
          referer,
          details: { refererHost }
        })

        return {
          isHotlinking: true,
          reason: `External referer: ${refererHost}`,
          severity: 'WARNING'
        }
      }
    } catch (error) {}
  }

  const freqKey = `video_freq:${sessionId}:${videoId}`
  const count = await redis.incr(freqKey)
  await redis.expire(freqKey, 300)

  if (count > 3000) {
    if (count % 500 === 0) {
      await logSecurityEvent({
        type: 'SUSPICIOUS_ACTIVITY',
        severity: 'WARNING',
        projectId,
        videoId,
        sessionId,
        ipAddress: getClientIpAddress(request),
        details: { requestCount: count, window: '5min' }
      })
    }

    return {
      isHotlinking: true,
      reason: `High frequency: ${count} requests in 5 min`,
      severity: 'WARNING'
    }
  }

  const ipAddress = getClientIpAddress(request)

  const blockedIPs = await getBlockedIPs()
  if (blockedIPs.includes(ipAddress)) {
    await logSecurityEvent({
      type: 'BLOCKED_IP_ATTEMPT',
      severity: 'CRITICAL',
      projectId,
      videoId,
      sessionId,
      ipAddress,
      details: { reason: 'IP in blocklist' }
    })

    return {
      isHotlinking: true,
      reason: `Blocked IP: ${ipAddress}`,
      severity: 'CRITICAL'
    }
  }

  return { isHotlinking: false }
}

export async function trackVideoAccess(params: {
  videoId: string
  projectId: string
  sessionId: string
  tokenId?: string
  request: NextRequest
  quality: string
  bandwidth?: number
  eventType: 'PAGE_VISIT' | 'DOWNLOAD_COMPLETE'
  assetId?: string // Single asset download
  assetIds?: string[] // Multiple assets downloaded as ZIP
  isAdmin?: boolean
}) {
  const { videoId, projectId, bandwidth: _bandwidth, eventType, sessionId, assetId, assetIds, isAdmin } = params

  const settings = await getSecuritySettings()
  if (!settings.trackAnalytics) {
    return
  }

  // Avoid inflating metrics with admin activity
  if (isAdmin) {
    return
  }

  await prisma.videoAnalytics.create({
    data: {
      videoId,
      projectId,
      eventType,
      assetId,
      assetIds: assetIds ? JSON.stringify(assetIds) : undefined,
    }
  })
}

export async function logSecurityEvent(params: {
  type: string
  severity: string
  projectId?: string
  videoId?: string
  sessionId?: string
  ipAddress?: string
  referer?: string
  details?: any
  wasBlocked?: boolean
}) {
  try {
    const settings = await getSecuritySettings()

    if (!settings.trackSecurityLogs) {
      return
    }

    // 6.2.1: PRIVILEGED write. Security events are logged from pre-auth paths
    // (failed logins, share-token probes) where no organization context is
    // armed, so post-RLS-flip the restricted role was denied every insert:
    // "new row violates row-level security policy for table SecurityEvent".
    // The audit trail was silently empty on production. The row carries the
    // org from the DB default when a context exists, and belongs to the
    // platform's own log when it doesn't.
    await (prismaPrivileged as any).securityEvent.create({
      data: {
        type: params.type,
        severity: params.severity,
        projectId: params.projectId,
        videoId: params.videoId,
        sessionId: params.sessionId,
        ipAddress: params.ipAddress,
        referer: params.referer,
        details: params.details,
        wasBlocked: params.wasBlocked || false,
      }
    })

    const redis = getRedis()
    // Keep recent events in Redis for quick access (last 1000 events)
    await redis.lpush('security:events:recent', JSON.stringify({
      ...params,
      timestamp: new Date().toISOString()
    }))
    await redis.ltrim('security:events:recent', 0, 999)
  } catch (error) {
    logError('[SECURITY_EVENT] Failed to log:', error)
  }
}

export async function getSecuritySettings() {
  const now = Date.now()

  // Check in-memory cache first (fastest)
  if (securitySettingsCache.expiresAt > now) {
    return securitySettingsCache.value
  }

  // Check Redis cache (shared across instances)
  const redis = getRedis()
  const REDIS_KEY = 'app:security_settings'
  const cached = await redis.get(REDIS_KEY)

  if (cached) {
    const parsed = JSON.parse(cached)
    securitySettingsCache.value = parsed
    securitySettingsCache.expiresAt = now + SECURITY_SETTINGS_CACHE_TTL_MS
    return parsed
  }

  // Fetch from database (slowest, only when both caches miss)
  const settings = await prisma.securitySettings.findUnique({
    where: orgSettingsWhere(),
    select: {
      hotlinkProtection: true,
      ipRateLimit: true,
      sessionRateLimit: true,
      shareSessionRateLimit: true,
      trackSecurityLogs: true,
      trackAnalytics: true,
      updatedAt: true
    }
  })

  const value: SecuritySettingsResult = {
    hotlinkProtection: settings?.hotlinkProtection || 'LOG_ONLY',
    ipRateLimit: settings?.ipRateLimit || 1000,
    sessionRateLimit: settings?.sessionRateLimit || 600,
    shareSessionRateLimit: settings?.shareSessionRateLimit || 300,
    trackSecurityLogs: settings?.trackSecurityLogs ?? true,
    trackAnalytics: settings?.trackAnalytics ?? true
  }

  // Cache in both Redis and memory
  securitySettingsCache.value = value
  securitySettingsCache.expiresAt = now + SECURITY_SETTINGS_CACHE_TTL_MS
  securitySettingsCache.version = settings?.updatedAt?.toISOString()

  await redis.setex(REDIS_KEY, 300, JSON.stringify(value)) // 5 min Redis cache

  return value
}

export async function invalidateSecuritySettingsCache(): Promise<void> {
  securitySettingsCache.expiresAt = 0

  const redis = getRedis()
  await redis.del('app:security_settings')
}

const BLOCKLIST_CACHE_TTL = 300 // 5 minutes
const BLOCKLIST_CACHE_KEY_IPS = 'security:blocklist:ips'
const BLOCKLIST_CACHE_KEY_DOMAINS = 'security:blocklist:domains'

/**
 * Get blocked IPs with Redis caching
 * Checks database and caches in Redis for 5 minutes
 */
async function getBlockedIPs(): Promise<string[]> {
  const redis = getRedis()

  // Check cache first
  const cached = await redis.get(BLOCKLIST_CACHE_KEY_IPS)
  if (cached) {
    try {
      return JSON.parse(cached)
    } catch (error) {
      logError('[BLOCKLIST] Failed to parse cached IPs:', error)
    }
  }

  // Fetch from database
  const blockedIPs = await prisma.blockedIP.findMany({
    select: { ipAddress: true }
  })

  const ipList = blockedIPs.map(entry => entry.ipAddress)

  // Cache in Redis
  await redis.setex(BLOCKLIST_CACHE_KEY_IPS, BLOCKLIST_CACHE_TTL, JSON.stringify(ipList))

  return ipList
}

/**
 * Get blocked domains with Redis caching
 * Checks database and caches in Redis for 5 minutes
 */
async function getBlockedDomains(): Promise<string[]> {
  const redis = getRedis()

  // Check cache first
  const cached = await redis.get(BLOCKLIST_CACHE_KEY_DOMAINS)
  if (cached) {
    try {
      return JSON.parse(cached)
    } catch (error) {
      logError('[BLOCKLIST] Failed to parse cached domains:', error)
    }
  }

  // Fetch from database
  const blockedDomains = await prisma.blockedDomain.findMany({
    select: { domain: true }
  })

  const domainList = blockedDomains.map(entry => entry.domain)

  // Cache in Redis
  await redis.setex(BLOCKLIST_CACHE_KEY_DOMAINS, BLOCKLIST_CACHE_TTL, JSON.stringify(domainList))

  return domainList
}

/**
 * Invalidate blocklist caches
 * Call this after adding/removing blocked IPs or domains
 */
export async function invalidateBlocklistCache(): Promise<void> {
  const redis = getRedis()
  await redis.del(BLOCKLIST_CACHE_KEY_IPS, BLOCKLIST_CACHE_KEY_DOMAINS)
}

export async function revokeProjectVideoTokens(projectId: string): Promise<void> {
  const redis = getRedis()
  const stream = redis.scanStream({ match: 'video_access:*', count: 100 })
  const keysToDelete: string[] = []

  for await (const keys of stream) {
    for (const key of keys) {
      const data = await redis.get(key)
      if (!data) continue

      try {
        const tokenData: VideoAccessToken = JSON.parse(data)
        if (tokenData.projectId === projectId) {
          keysToDelete.push(key)
        }
      } catch (error) {
        logError(`[SECURITY] Corrupted token data during revocation, will delete (key=${key})`, error)
        keysToDelete.push(key)
      }
    }
  }

  if (keysToDelete.length > 0) {
    const pipeline = redis.pipeline()
    keysToDelete.forEach((key) => pipeline.del(key))
    await pipeline.exec()
  }

  // Bump token version so in-memory verification cache is invalidated across requests
  await redis.incr(TOKEN_REV_VERSION_KEY)
}
